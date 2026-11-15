"""Award rows read from PDF award lists by the LLM (extraction topic award_table), in the same shape as
spreadsheet rows, so coverage and the website export can count them.

The year and pathway come from what the row printed (award_round_or_date, credit_type), else the document
title, else the file name, with the basis recorded. Amounts are parsed from the printed text in code.
Only reviewer-approved rows may feed calculations: `review_state` says which these are.
"""
from __future__ import annotations

import json
from urllib.parse import unquote, urlparse

from .parse_awards import credit_type_in, number, year_in


def rows(conn, statuses=("approved", "pending_review")):
    q = (f"SELECT e.*, src.state, src.title, s.final_url, s.retrieved_at, s.sha256 FROM extraction e "
         f"JOIN snapshot s USING(snapshot_id) JOIN source src ON src.source_id=e.source_id "
         f"WHERE e.field='award_row' AND e.status IN ({','.join('?' * len(statuses))}) "
         f"AND e.snapshot_id IN (SELECT snapshot_id FROM current_snapshot) "
         f"ORDER BY src.state, e.source_id, e.page, e.extraction_id")
    for e in conn.execute(q, statuses):
        d = json.loads(e["row_json"] or "{}")
        fname = unquote(urlparse(e["final_url"] or "").path.rsplit("/", 1)[-1])
        printed = d.get("credit_type") if d.get("credit_type") in ("9%", "4%") else None
        pathway, pbasis = (printed, "row") if printed else next(
            ((credit_type_in(v), b) for b, v in (("title", e["title"] or ""), ("file name", fname)) if credit_type_in(v)),
            (None, "none"))
        year, ybasis = next(((year_in(v), b) for b, v in (("row", d.get("award_round_or_date", "")),
                                                           ("title", e["title"] or ""), ("file name", fname))
                             if year_in(v)), (None, "none"))
        approved = e["status"] == "approved"
        credit = number(e["reviewer_value"] if approved and e["reviewer_value"] else d.get("annual_credit_amount"))
        units = number(d.get("total_units"))
        yield {"source_id": e["source_id"], "state": e["state"], "pathway": pathway, "pathway_basis": pbasis,
               "year": year, "year_basis": ybasis, "project": d.get("project_name", ""), "sponsor": d.get("sponsor", ""),
               "city": d.get("city", ""), "total_units": int(units) if units and units.is_integer() else None,
               "annual_credit": credit, "total_development_cost": number(d.get("total_development_cost")),
               "status_printed": d.get("status", ""), "set_aside": d.get("set_aside", ""), "page": e["page"],
               "quote": e["quote"], "checks": e["validation_note"] or "", "notes": d.get("notes", ""),
               "review_state": "approved" if approved else "not reviewed", "title": e["title"],
               "source_url": e["final_url"], "retrieved": e["retrieved_at"][:10], "sha256": e["sha256"]}
