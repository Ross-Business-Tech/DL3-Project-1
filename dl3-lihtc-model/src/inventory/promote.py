"""Add a jurisdiction's documents found by the inventory crawl to config/source_register.csv, so that
run_all.py downloads and archives them and extraction can read them.

    python -m src.inventory.promote MI OH NYC        # pilot jurisdictions

Adds, when the inventory has them: the newest QAP, the newest non-draft QAP, the underwriting manual,
and up to 5 award lists. Promoted rows keep status "unknown" (or "draft" if the link says so); nobody has
confirmed them final. Re-running replaces earlier promoted rows for the same jurisdiction.
"""
from __future__ import annotations

import argparse
import csv
from pathlib import Path

from ..fetch import archive

ROOT = Path(__file__).resolve().parents[2]


def _first_url(cell: str) -> str:
    return (cell or "").split(";")[0].strip().split(" [")[0].strip()


def promoted_rows(inv: dict, today: str) -> list[dict]:
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
    for i, u in enumerate([x.strip() for x in (inv.get("award_list_urls") or "").split(";") if x.strip()][:5], 1):
        out.append({**base, "source_id": f"{jid}_AWARDS_{i}", "doc_type": "award_list", "url": u,
                    "title": f"{jid} award list {i}", "status": "unknown", "critical": "false"})
    return out


def promote(ids: list[str], inventory_csv: Path, register_csv: Path) -> list[dict]:
    with open(inventory_csv, newline="", encoding="utf-8") as fh:
        inv = {r["jurisdiction_id"]: r for r in csv.DictReader(fh)}
    missing = [i for i in ids if i not in inv]
    if missing:
        raise SystemExit(f"not in inventory: {', '.join(missing)}")
    with open(register_csv, newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        fields, rows = reader.fieldnames, list(reader)
    today = f"{archive.utcnow():%Y-%m-%d}"
    new = [r for i in ids for r in promoted_rows(inv[i], today)]
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
    new = promote([i.upper() for i in a.ids], ROOT / "data" / "inventory" / "state_inventory.csv",
                  ROOT / "config" / "source_register.csv")
    for r in new:
        print(f"{r['source_id']:22} {r['status']:8} {r['url']}")
    print(f"Added {len(new)} sources. Next: python run_all.py --only {' '.join(r['source_id'] for r in new)} --extract")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
