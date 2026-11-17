"""Cost per unit observed in award and application lists, by state, pathway and year.

DL3 guidance (2026-11-15): take each state's total development cost per unit, apply it to a 100-unit deal,
and test whether the allowed developer fee is at least 10% of that total. This module supplies the first
input from real projects: for every award row that states both total development cost and units (or has its
own cost-per-unit column), it reports the count, median, and range. Applying the fee rule is the scoring
code's job.

Rows are used only if the numbers are positive and the row has no "not a number" or "negative" flag.
Per-unit cost is cost / total units of that row; nothing is estimated for rows without cost data.

    python -m src.awards.costs        # prints the table, writes outputs/awards/cost_per_unit.csv
"""
from __future__ import annotations

import csv
from pathlib import Path
from statistics import median

from ..fetch import archive

ROOT = Path(__file__).resolve().parents[2]
COLS = ["state", "pathway", "year", "projects_with_cost", "projects_total", "median_cost_per_unit",
        "min_cost_per_unit", "max_cost_per_unit", "median_units", "cost_for_100_units_at_median", "basis", "sources"]


def per_unit(row) -> tuple[float, str] | None:
    bad = row["flags"] or ""
    if "negative" in bad or "total_development_cost is not a number" in bad or "cost_per_unit is not a number" in bad:
        return None
    if row["cost_per_unit"] and row["cost_per_unit"] > 0:
        return float(row["cost_per_unit"]), "per-unit column"
    if row["total_development_cost"] and row["total_units"] and row["total_development_cost"] > 0 and row["total_units"] > 0:
        return row["total_development_cost"] / row["total_units"], "total cost / units"
    return None


def summarize(conn) -> list[dict]:
    groups: dict = {}
    for r in conn.execute(
            "SELECT * FROM award_row WHERE snapshot_id IN (SELECT snapshot_id FROM current_snapshot) "
            "AND COALESCE(flags, '') NOT LIKE '%no tax credit column%'"):
        key = (r["state"] or "UNKNOWN", r["credit_type"] if r["credit_type"] != "unknown" else "UNKNOWN",
               r["award_year"] if r["award_year"] is not None else "UNKNOWN")
        g = groups.setdefault(key, {"n": 0, "costs": [], "units": [], "basis": set(), "sources": set()})
        g["n"] += 1
        pu = per_unit(r)
        if pu:
            g["costs"].append(pu[0])
            g["basis"].add(pu[1])
            g["sources"].add(r["source_id"])
            if r["total_units"]:
                g["units"].append(r["total_units"])
    out = []
    for (state, pathway, year), g in sorted(groups.items(), key=lambda kv: tuple(map(str, kv[0]))):
        c = g["costs"]
        med = round(median(c)) if c else None
        out.append({"state": state, "pathway": pathway, "year": year, "projects_with_cost": len(c),
                    "projects_total": g["n"], "median_cost_per_unit": med if c else "UNKNOWN",
                    "min_cost_per_unit": round(min(c)) if c else "UNKNOWN",
                    "max_cost_per_unit": round(max(c)) if c else "UNKNOWN",
                    "median_units": round(median(g["units"])) if g["units"] else "UNKNOWN",
                    "cost_for_100_units_at_median": med * 100 if c else "UNKNOWN",
                    "basis": "; ".join(sorted(g["basis"])), "sources": "; ".join(sorted(g["sources"]))})
    return out


def write(db_path: Path, out_path: Path) -> list[dict]:
    conn = archive.connect(db_path)
    rows = summarize(conn)
    conn.close()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=COLS)
        w.writeheader()
        w.writerows(rows)
    return rows


if __name__ == "__main__":
    out = ROOT / "outputs" / "awards" / "cost_per_unit.csv"
    for r in write(ROOT / "data" / "dl3.db", out):
        if r["projects_with_cost"]:
            print(f"{r['state']} {r['pathway']} {r['year']}: median ${r['median_cost_per_unit']:,}/unit from "
                  f"{r['projects_with_cost']} of {r['projects_total']} projects")
    print("Wrote", out)
