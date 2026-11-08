"""Build the 50-state inventory (plus DC, territories and city sub-allocators) from:

1. config/jurisdictions.csv      seed list of agencies (unverified until checked)
2. data/reference/hud_allocators.csv   HUD P1 list, parsed by run_all.py (cross-check)
3. the latest crawl of each jurisdiction (src/inventory/crawl.py)
4. config/inventory_overrides.csv      reviewer-confirmed values; these always win

Writes data/inventory/state_inventory.xlsx and .csv. Auto-found values are candidates: a row is only
"verified" when a reviewer has confirmed every field in REVIEW_FIELDS. Never marks a QAP "final" on its own.

    python -m src.inventory.build
"""
from __future__ import annotations

import csv
from collections import defaultdict
from pathlib import Path
from urllib.parse import urlparse

from ..fetch import archive, hud_allocators
from .crawl import load_jurisdictions

ROOT = Path(__file__).resolve().parents[2]
NEEDS = "needs verification"

COLUMNS = [
    ("jurisdiction_id", "Stable ID (state code, or city code for sub-allocators)"),
    ("state", "Two-letter state/territory code"),
    ("jurisdiction_type", "state | district | territory | city"),
    ("in_50_state_scope", "yes for the 50 states"),
    ("allocating_agency", "Agency that allocates credits"),
    ("agency_url", "Agency homepage"),
    ("agency_source", "Where the agency name/URL came from"),
    ("hud_check", "Comparison with HUD's allocating-agency list (P1)"),
    ("hud_listed_urls", "URLs HUD lists for this state"),
    ("other_hud_agencies", "Other agencies HUD lists for this state (possible sub-allocators)"),
    ("local_suballocators", "City/local sub-allocators flagged in this inventory"),
    ("bond_issuer_4pct", "4% bond issuer(s)"),
    ("lihtc_program_url", "Agency LIHTC program page"),
    ("qap_page_url", "QAP landing page"),
    ("qap_document_urls", "Most recent QAP documents found (newest first)"),
    ("plan_years", "Plan year(s) named on the newest QAP document"),
    ("qap_draft_or_final", "Draft/final status of the newest QAP document"),
    ("underwriting_manual_url", "Underwriting manual / guide"),
    ("award_list_urls", "Award / reservation lists found"),
    ("award_formats", "File formats of award lists"),
    ("award_years_available", "Years named on award lists found"),
    ("application_round_url", "Current application / funding round page"),
    ("bond_program_url", "Multifamily bond / 4% program page"),
    ("next_round_deadline", "Next round deadline"),
    ("stated_fee_cap", "Light screen: stated developer fee cap"),
    ("per_project_credit_cap", "Light screen: per-project credit cap"),
    ("pages_crawled", "Pages read in the latest crawl"),
    ("crawl_errors", "Failed page fetches in the latest crawl"),
    ("first_crawl_error", "First error message"),
    ("last_crawled_at", "When the latest crawl finished (UTC)"),
    ("evidence", "Page each auto-found value was found on"),
    ("reviewed_fields", "Fields confirmed by a reviewer (field: reviewer, date)"),
    ("verification_status", "Overall status of the row"),
    ("notes", "Notes"),
]
FIELDS = [c for c, _ in COLUMNS]
REVIEW_FIELDS = ("allocating_agency", "agency_url", "bond_issuer_4pct", "qap_page_url", "qap_draft_or_final",
                 "plan_years", "award_list_urls", "underwriting_manual_url", "next_round_deadline")
OVERRIDE_FIELDS = ["jurisdiction_id", "field", "value", "source_url", "reviewer", "reviewed_on", "note"]


def _host(url: str) -> str:
    return (urlparse(url).hostname or "").lower().removeprefix("www.")


def _years_text(years: set[int]) -> str:
    """2019, 2021, 2022, 2023 -> '2019, 2021–2023'."""
    ys, out = sorted(years), []
    i = 0
    while i < len(ys):
        j = i
        while j + 1 < len(ys) and ys[j + 1] == ys[j] + 1:
            j += 1
        out.append(str(ys[i]) if i == j else f"{ys[i]}–{ys[j]}")
        i = j + 1
    return ", ".join(out)


def _years(c) -> list[int]:
    return [int(y) for y in (c["years"] or "").split(",") if y]


def latest_candidates(conn) -> tuple[dict, dict]:
    """Latest crawl status and its candidates, per jurisdiction."""
    status = {}
    for r in conn.execute("SELECT * FROM crawl_status ORDER BY finished_at"):
        status[r["jurisdiction_id"]] = dict(r)
    cands = defaultdict(list)
    for jid, st in status.items():
        cands[jid] = [dict(r) for r in conn.execute(
            "SELECT * FROM inventory_candidate WHERE jurisdiction_id=? AND run_id=?", (jid, st["run_id"]))]
    return status, cands


def _rank(c):
    ys = _years(c)
    return (-(max(ys) if ys else 0), -c["score"], c["depth"], c["offsite"], c["url"])


def _best(cands, category, kind=None, onsite_first=True):
    pool = [c for c in cands if c["category"] == category and (kind is None or c["kind"] == kind)]
    if not pool:
        return None
    key = (lambda c: (c["offsite"], -c["score"], c["depth"], c["url"])) if onsite_first else _rank
    return sorted(pool, key=key)[0]


def load_overrides(path: Path | None = None) -> list[dict]:
    path = path or ROOT / "config" / "inventory_overrides.csv"
    if not Path(path).exists():
        return []
    with open(path, newline="", encoding="utf-8") as fh:
        rows = [r for r in csv.DictReader(fh) if (r.get("jurisdiction_id") or "").strip()]
    for r in rows:
        if r["field"] not in FIELDS:
            raise ValueError(f"inventory_overrides.csv: unknown field '{r['field']}' for {r['jurisdiction_id']}")
        if not (r.get("reviewer") or "").strip():
            raise ValueError(f"inventory_overrides.csv: {r['jurisdiction_id']}/{r['field']} has no reviewer")
    return rows


def build_rows(jurisdictions, hud_rows, status, cands, overrides) -> list[dict]:
    hud_by_state = defaultdict(list)
    for h in hud_rows:
        hud_by_state[h["state"]].append(h)
    subs = defaultdict(list)
    for j in jurisdictions:
        if j.get("suballocator_of"):
            subs[j["suballocator_of"]].append(f"{j['jurisdiction_id']} ({j['allocating_agency']})")
    seed_hosts = defaultdict(set)
    for j in jurisdictions:
        seed_hosts[j["state"]].add(_host(j["agency_url"]))
    ov = defaultdict(dict)
    for o in overrides:
        ov[o["jurisdiction_id"]][o["field"]] = o

    rows = []
    for j in jurisdictions:
        jid, cs = j["jurisdiction_id"], cands.get(j["jurisdiction_id"], [])
        st = status.get(jid)
        r = dict.fromkeys(FIELDS, "")
        r.update({k: j.get(k, "") for k in ("jurisdiction_id", "state", "jurisdiction_type", "in_50_state_scope",
                                            "allocating_agency", "agency_url", "notes")})
        r["agency_source"] = "team seed list (unverified)"

        hud = hud_by_state.get(j["state"], [])
        if j["jurisdiction_type"] == "city":
            r["hud_check"] = "city: check HUD list manually"
        elif not hud_rows:
            r["hud_check"] = "HUD list not retrieved yet"
        elif not hud:
            r["hud_check"] = "state not found on HUD list"
        elif _host(j["agency_url"]) in {h["agency_host"] for h in hud}:
            r["hud_check"] = "matches HUD list"
            r["agency_source"] = "team seed list; host matches HUD P1"
        else:
            r["hud_check"] = "differs from HUD list: check"
        r["hud_listed_urls"] = "; ".join(h["agency_url"] for h in hud)
        if j["jurisdiction_type"] != "city":
            others = [h for h in hud if h["agency_host"] not in seed_hosts[j["state"]]]
            r["other_hud_agencies"] = "; ".join(f"{h['agency_name']} ({h['agency_url']})" for h in others)
            r["local_suballocators"] = "; ".join(subs.get(j["state"], []))
        else:
            r["local_suballocators"] = f"is a sub-allocator within {j['suballocator_of']}"
        r["bond_issuer_4pct"] = j.get("bond_issuer_note") or f"{j['allocating_agency']} (assumed): {NEEDS}"

        evidence = []

        def put(field_name, cand, value=None):
            if cand:
                r[field_name] = value if value is not None else cand["url"]
                evidence.append(f"{field_name} <- {cand['found_on_url']}")

        put("lihtc_program_url", _best(cs, "lihtc_program", "page"))
        put("qap_page_url", _best(cs, "qap", "page"))
        qdocs = sorted([c for c in cs if c["category"] == "qap" and c["kind"] == "document"], key=_rank)[:3]
        if qdocs:
            r["qap_document_urls"] = "; ".join(
                f"{c['url']}" + (f" [{_years_text(set(_years(c)))}]" if _years(c) else "")
                + (" [draft]" if c["draft_marker"] else "") for c in qdocs)
            evidence.append(f"qap_document_urls <- {qdocs[0]['found_on_url']}")
            top = qdocs[0]
            r["plan_years"] = _years_text(set(_years(top))) or NEEDS
            r["qap_draft_or_final"] = ("draft (link text says draft/proposed)" if top["draft_marker"]
                                       else f"unknown: {NEEDS} (never assumed final)")
            if not r["qap_page_url"]:
                r["qap_page_url"] = top["found_on_url"]
        put("underwriting_manual_url", _best(cs, "underwriting", "document") or _best(cs, "underwriting"))
        awards = sorted([c for c in cs if c["category"] == "award_list"], key=_rank)
        if awards:
            r["award_list_urls"] = "; ".join(c["url"] for c in awards[:5])
            r["award_formats"] = ", ".join(sorted({c["file_format"] for c in awards if c["file_format"]}))
            r["award_years_available"] = _years_text({y for c in awards for y in _years(c)})
            evidence.append(f"award_list_urls <- {awards[0]['found_on_url']}")
        put("application_round_url", _best(cs, "application"))
        put("bond_program_url", _best(cs, "bond_program"))
        r["next_round_deadline"] = NEEDS
        r["stated_fee_cap"] = NEEDS
        r["per_project_credit_cap"] = NEEDS
        if st:
            r.update(pages_crawled=st["pages_fetched"], crawl_errors=st["errors"],
                     first_crawl_error=st["first_error"] or "", last_crawled_at=st["finished_at"])
        r["evidence"] = "\n".join(evidence)

        reviewed = ov.get(jid, {})
        for f, o in reviewed.items():
            r[f] = o["value"]
        if "allocating_agency" in reviewed or "agency_url" in reviewed:
            r["agency_source"] = "reviewer confirmed"
        r["reviewed_fields"] = "; ".join(f"{f}: {o['reviewer']}, {o.get('reviewed_on', '')}"
                                         for f, o in sorted(reviewed.items()))

        if all(f in reviewed for f in REVIEW_FIELDS):
            r["verification_status"] = "verified"
        elif reviewed:
            r["verification_status"] = "partly verified"
        elif not st:
            r["verification_status"] = "not yet crawled"
        elif not st["pages_fetched"]:
            r["verification_status"] = "crawl failed: check agency URL"
        elif not (qdocs or r["qap_page_url"]):
            r["verification_status"] = "QAP not found automatically: manual search"
        else:
            r["verification_status"] = "candidates found: needs review"
        rows.append(r)
    return rows


def write_outputs(rows, cands, hud_rows, out_dir: Path) -> Path:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill

    out_dir.mkdir(parents=True, exist_ok=True)
    with open(out_dir / "state_inventory.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)

    wb = Workbook()
    ws = wb.active
    ws.title = "Inventory"
    ws.append(FIELDS)
    for r in rows:
        ws.append([r[f] for f in FIELDS])
    fills = {"verified": "C6EFCE", "partly verified": "FFEB9C", "candidates found: needs review": "DDEBF7"}
    status_col = FIELDS.index("verification_status") + 1
    for row in ws.iter_rows(min_row=2):
        color = fills.get(row[status_col - 1].value)
        if color is None and row[status_col - 1].value:
            color = "F8CBAD"
        row[status_col - 1].fill = PatternFill("solid", fgColor=color)
        for cell in row:
            cell.alignment = Alignment(wrap_text=True, vertical="top")
    for cell in ws[1]:
        cell.font = Font(bold=True)
    ws.freeze_panes = "C2"
    ws.auto_filter.ref = ws.dimensions
    for col in ws.columns:
        ws.column_dimensions[col[0].column_letter].width = 18 if col[0].value in (
            "jurisdiction_id", "state", "jurisdiction_type", "in_50_state_scope", "pages_crawled",
            "crawl_errors") else 40

    wc = wb.create_sheet("Candidates")
    ccols = ["jurisdiction_id", "category", "kind", "file_format", "url", "link_text", "years", "draft_marker",
             "offsite", "score", "depth", "found_on_url", "found_on_sha256", "retrieved_at", "run_id"]
    wc.append(ccols)
    for jid in sorted(cands):
        for c in sorted(cands[jid], key=lambda c: (c["category"], -c["score"])):
            wc.append([c.get(k) for k in ccols])
    wc.freeze_panes = "A2"
    wc.auto_filter.ref = wc.dimensions

    wh = wb.create_sheet("HUD list")
    wh.append(hud_allocators.FIELDS)
    for h in hud_rows:
        wh.append([h.get(k) for k in hud_allocators.FIELDS])

    wr = wb.create_sheet("Read me")
    wr.append(["column", "meaning"])
    for c, d in COLUMNS:
        wr.append([c, d])
    wr.append([])
    wr.append(["How to verify", "Check a value on the agency site, then add a row to config/inventory_overrides.csv "
               "(jurisdiction_id, field, value, source_url, reviewer, reviewed_on) and rerun "
               "python -m src.inventory.build. Reviewed values always win over auto-found ones."])
    wr.append(["Rule", "Auto-found values are candidates. QAPs are never marked final automatically. "
               "Missing values are left as 'needs verification', never guessed."])
    wr.column_dimensions["A"].width = 26
    wr.column_dimensions["B"].width = 110
    path = out_dir / "state_inventory.xlsx"
    wb.save(path)
    return path


def build(db_path: Path | None = None, out_dir: Path | None = None, jurisdictions_path: Path | None = None,
          hud_path: Path | None = None, overrides_path: Path | None = None) -> Path:
    conn = archive.connect(db_path or ROOT / "data" / "dl3.db")
    status, cands = latest_candidates(conn)
    conn.close()
    js = load_jurisdictions(jurisdictions_path)
    hud = hud_allocators.read_csv(hud_path or ROOT / "data" / "reference" / "hud_allocators.csv")
    rows = build_rows(js, hud, status, cands, load_overrides(overrides_path))
    return write_outputs(rows, cands, hud, out_dir or ROOT / "data" / "inventory")


if __name__ == "__main__":
    print(build())
