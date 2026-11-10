"""Add a jurisdiction's documents and pages found by the inventory crawl to config/source_register.csv, so that
run_all.py downloads and archives them and extraction can read them.

    python -m src.inventory.promote MI OH NYC        # pilot jurisdictions

Adds, when the inventory has them: the newest QAP, the newest non-draft QAP, the underwriting manual, the
LIHTC program, application round, bond and news pages, and every award list the crawl found for the award
years in config/settings.yaml (2021-2026), up to 40. Promoted rows keep status "unknown" (or "draft" if the link says so); nobody has
confirmed them final. Re-running replaces earlier promoted rows for the same jurisdiction.
"""
from __future__ import annotations

import argparse
import csv
from pathlib import Path

from ..fetch import archive, fetch
from .crawl import file_format

ROOT = Path(__file__).resolve().parents[2]


def _first_url(cell: str) -> str:
    return (cell or "").split(";")[0].strip().split(" [")[0].strip()


def promoted_rows(inv: dict, today: str, awards: list[dict] | None = None) -> list[dict]:
    if awards is None:
        awards = [{"url": u.strip(), "text": "", "years": ""} for u in (inv.get("award_list_urls") or "").split(";")
                  if u.strip()][:5]
    jid, state = inv["jurisdiction_id"], inv["state"]
    note = f"promoted from inventory {today}; auto-found link, needs verification"
    base = {"jurisdiction": inv["allocating_agency"], "state": state, "critical": "true", "notes": note}
    out = []
    newest = _first_url(inv.get("qap_document_urls", ""))
    current = inv.get("qap_current_nondraft_url", "")
    if current:
        out.append({**base, "source_id": f"{jid}_QAP_CURRENT", "doc_type": "qap_doc", "url": current,
                    "title": f"{jid} QAP (newest not marked draft)", "status": "unknown",
                    "plan_year": inv.get("qap_current_nondraft_years", "")})
    if newest and newest != current:
        draft = "[draft]" in (inv.get("qap_document_urls", "").split(";")[0])
        out.append({**base, "source_id": f"{jid}_QAP_NEWEST", "doc_type": "qap_doc", "url": newest,
                    "title": f"{jid} QAP (newest found)", "status": "draft" if draft else "unknown",
                    "plan_year": inv.get("plan_years", "")})
    uw = inv.get("underwriting_manual_url", "")
    if uw:
        out.append({**base, "source_id": f"{jid}_UW", "doc_type": "underwriting", "url": uw,
                    "title": f"{jid} underwriting manual", "status": "unknown"})
    for key, sid, doc_type, label, critical in (
            ("lihtc_program_url", "PROGRAM", "program_page", "LIHTC program page", "true"),
            ("application_round_url", "ROUND", "application", "application round page", "true"),
            ("bond_program_url", "BOND", "bond_page", "bond / 4% program page", "false"),
            ("news_page_url", "NEWS", "news_page", "news page", "false")):
        u = inv.get(key, "")
        if u and file_format(u) is None:  # pages only; a linked file is not a landing page
            out.append({**base, "source_id": f"{jid}_{sid}", "doc_type": doc_type, "url": u,
                        "title": f"{jid} {label}", "status": "unknown", "critical": critical})
    seen = {r["url"] for r in out}
    for i, a in enumerate([a for a in awards if a["url"] not in seen], 1):
        out.append({**base, "source_id": f"{jid}_AWARDS_{i}", "doc_type": "award_list", "url": a["url"],
                    "title": f"{jid} award list{(' ' + a['years']) if a['years'] else ''}: {a['text'][:80]}".strip(": "),
                    "status": "unknown", "critical": "false"})
    return out


def award_history(db_path: Path | None, inv: dict, first: int, last: int, limit: int = 40) -> list[dict]:
    """Every award list the latest crawl found for the years asked for (documents first, newest first).
    Falls back to the inventory's short list when there is no crawl database."""
    jid = inv["jurisdiction_id"]
    found = []
    if db_path and Path(db_path).exists():
        from . import build
        from .crawl import load_rules
        rules = load_rules()
        conn = archive.connect(db_path)
        _, cands = build.latest_candidates(conn)
        conn.close()
        for c in cands.get(jid, []):
            if c["category"] != "award_list" or c["kind"] != "document" or not build._usable(c, rules):
                continue
            ys = [int(y) for y in (c["years"] or "").split(",") if y]
            if ys and not any(first <= y <= last for y in ys):
                continue  # clearly another year; undated lists are kept (they may be multi-year)
            found.append({"url": c["url"], "text": c["link_text"] or "", "max_year": max(ys) if ys else 0,
                          "years": build._years_text(set(ys))})
        found.sort(key=lambda a: (-a["max_year"], a["url"]))
    if not found:
        found = [{"url": u.strip(), "text": "", "years": "", "max_year": 0}
                 for u in (inv.get("award_list_urls") or "").split(";") if u.strip()][:5]
    out, seen = [], set()
    for a in found:
        if a["url"] not in seen:
            seen.add(a["url"])
            out.append(a)
    return out[:limit]


def promote(ids: list[str], inventory_csv: Path, register_csv: Path, db_path: Path | None = None,
            years: tuple[int, int] = (2021, 2026)) -> list[dict]:
    with open(inventory_csv, newline="", encoding="utf-8") as fh:
        inv = {r["jurisdiction_id"]: r for r in csv.DictReader(fh)}
    missing = [i for i in ids if i not in inv]
    if missing:
        raise SystemExit(f"not in inventory: {', '.join(missing)}")
    with open(register_csv, newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        fields, rows = reader.fieldnames, list(reader)
    today = f"{archive.utcnow():%Y-%m-%d}"
    new = [r for i in ids for r in promoted_rows(inv[i], today, award_history(db_path, inv[i], *years))]
    prefixes = tuple(f"{i}_" for i in ids)
    rows = [r for r in rows if not (r["source_id"].startswith(prefixes) and "promoted from inventory" in (r.get("notes") or ""))]
    rows += [{f: n.get(f, "") for f in fields} for n in new]
    with open(register_csv, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    return new


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ids", nargs="+")
    a = ap.parse_args(argv)
    ay = fetch.load_settings().get("award_years", {"first": 2021, "last": 2026})
    new = promote([i.upper() for i in a.ids], ROOT / "data" / "inventory" / "state_inventory.csv",
                  ROOT / "config" / "source_register.csv", db_path=ROOT / "data" / "dl3.db",
                  years=(ay["first"], ay["last"]))
    for r in new:
        print(f"{r['source_id']:22} {r['status']:8} {r['url']}")
    print(f"Added {len(new)} sources. Next: python run_all.py --only {' '.join(r['source_id'] for r in new)} --extract")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
