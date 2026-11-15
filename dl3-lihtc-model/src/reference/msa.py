"""Top metropolitan areas by population, from the Census Bureau's ACS 5-year estimates.

DL3 guidance (2026-11-15): the urban screen is "states that are part of one of the top 100 MSAs as measured
by the most recently available ACS 5-year estimates". This module turns the archived Census API response
(source CENSUS_MSA in the register) into two reference files:

- data/reference/top_msas.csv           rank, MSA, population, states it covers
- data/reference/states_in_top_msas.csv every state, whether any top-100 MSA includes it, and which ones

It only ranks and lists. Whether a state passes the urban screen is decided by the scoring code.
Table B01003_001E is total population. Micropolitan areas are excluded; Puerto Rico metros are ranked
(they are MSAs) and flagged so the scorer can decide.

    python -m src.reference.msa          # rebuild from the latest archived copy
"""
from __future__ import annotations

import csv
import json
import re
from pathlib import Path

from ..fetch import archive
from ..inventory.states import STATE_NAMES

ROOT = Path(__file__).resolve().parents[2]
SOURCE_ID = "CENSUS_MSA"
NAME = re.compile(r"^(?P<place>.+),\s*(?P<states>[A-Z]{2}(?:-[A-Z]{2})*)\s+(?P<kind>Metro|Micro) Area$")
YEAR_IN_URL = re.compile(r"/data/(\d{4})/acs/acs5")


def parse(raw: bytes) -> list[dict]:
    """Rows of the Census API response -> metro areas. Raises ValueError if the layout is not as expected."""
    data = json.loads(raw.decode("utf-8-sig"))
    if not isinstance(data, list) or not data or not isinstance(data[0], list):
        raise ValueError("Census response is not a table")
    header = data[0]
    try:
        ni, pi = header.index("NAME"), header.index("B01003_001E")
    except ValueError as e:
        raise ValueError(f"Census response is missing NAME or B01003_001E (got {header})") from e
    gi = len(header) - 1  # the geography code is the last column
    out = []
    for row in data[1:]:
        m = NAME.match(row[ni] or "")
        if not m or m["kind"] != "Metro":
            continue
        try:
            pop = int(row[pi])
        except (TypeError, ValueError):
            continue  # suppressed or missing estimate: not ranked
        if pop <= 0:
            continue
        out.append({"cbsa_code": row[gi], "msa_name": row[ni], "population": pop, "states": m["states"].split("-")})
    if len(out) < 100:
        raise ValueError(f"only {len(out)} metro areas found; expected several hundred")
    out.sort(key=lambda r: (-r["population"], r["msa_name"]))
    for i, r in enumerate(out, 1):
        r["rank"] = i
    return out


def build(db_path: Path | None = None, archive_root: Path | None = None, out_dir: Path | None = None,
          top_n: int = 100) -> dict | None:
    """Write the two reference files from the latest archived Census response. None if it is not archived yet."""
    conn = archive.connect(db_path or ROOT / "data" / "dl3.db")
    snap = archive.latest_snapshot(conn, SOURCE_ID)
    conn.close()
    if snap is None:
        return None
    msas = parse(((archive_root or ROOT / "archive") / snap["archive_path"]).read_bytes())
    top = msas[:top_n]
    y = YEAR_IN_URL.search(snap["final_url"])
    vintage = f"ACS 5-year ending {y.group(1)}" if y else "ACS 5-year (year not in URL)"
    prov = {"source_url": snap["final_url"], "retrieved": snap["retrieved_at"][:10], "sha256": snap["sha256"],
            "vintage": vintage}
    out_dir = out_dir or ROOT / "data" / "reference"
    out_dir.mkdir(parents=True, exist_ok=True)
    with open(out_dir / "top_msas.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["rank", "cbsa_code", "msa_name", "population", "states", "includes_puerto_rico", *prov])
        for r in top:
            w.writerow([r["rank"], r["cbsa_code"], r["msa_name"], r["population"], "-".join(r["states"]),
                        "yes" if "PR" in r["states"] else "no", *prov.values()])
    by_state = {}
    for r in top:
        for s in r["states"]:
            by_state.setdefault(s, []).append(r)
    cutoff = top[-1]
    with open(out_dir / "states_in_top_msas.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["state", "state_name", "in_top_msa", "top_msa_count", "largest_msa", "largest_msa_rank",
                    "largest_msa_population", "all_top_msas", "top_n", "cutoff_population", *prov])
        for code in sorted(STATE_NAMES):
            if code in ("GU", "AS", "MP", "VI"):
                continue  # no metropolitan statistical areas are defined there
            ms = by_state.get(code, [])
            big = ms[0] if ms else None
            w.writerow([code, STATE_NAMES[code], "yes" if ms else "no", len(ms), big["msa_name"] if big else "",
                        big["rank"] if big else "", big["population"] if big else "",
                        "; ".join(f"{m['rank']}. {m['msa_name']}" for m in ms), top_n, cutoff["population"],
                        *prov.values()])
    return {"msas_ranked": len(msas), "top_n": len(top), "states_in": len([s for s in by_state if s in STATE_NAMES]),
            "cutoff": f"{cutoff['rank']}. {cutoff['msa_name']} ({cutoff['population']:,})", **prov}


if __name__ == "__main__":
    r = build()
    print(r or f"{SOURCE_ID} is not in the archive yet. Run: python run_all.py --only {SOURCE_ID}")
