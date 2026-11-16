"""One row per source document (unique source URL) from a review packet, so a reviewer can work
document by document.

    python -m src.review.unique_sources                  # newest review/packets/*.csv
    python -m src.review.unique_sources path/to/packet.csv

Writes <packet>_unique_sources.csv next to it: the packet's columns from the first finding for each URL,
plus findings_for_this_url, topics, and pages cited. Order follows the packet.
"""
from __future__ import annotations

import argparse
import csv
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EXTRA = ["findings_for_this_url", "topics", "pages_cited"]


def unique_by_url(rows: list[dict], url_col: str = "source_url") -> list[dict]:
    out: dict = {}
    for r in rows:
        u = (r.get(url_col) or "").strip()
        if u not in out:
            out[u] = {**r, "findings_for_this_url": 0, "topics": set(), "pages_cited": set()}
        o = out[u]
        o["findings_for_this_url"] += 1
        if r.get("topic"):
            o["topics"].add(r["topic"])
        if str(r.get("page") or "").strip():
            o["pages_cited"].add(int(float(r["page"])))
    for o in out.values():
        o["topics"] = ", ".join(sorted(o["topics"]))
        o["pages_cited"] = ", ".join(map(str, sorted(o["pages_cited"])))
    return list(out.values())


def write(packet: Path) -> Path:
    with open(packet, newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        cols, rows = list(reader.fieldnames), list(reader)
    if "source_url" not in cols:
        raise SystemExit(f"{packet} has no source_url column")
    out = packet.with_name(packet.stem + "_unique_sources.csv")
    with open(out, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=cols + [c for c in EXTRA if c not in cols])
        w.writeheader()
        w.writerows(unique_by_url(rows))
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("packet", nargs="?")
    a = ap.parse_args(argv)
    packets = sorted(p for p in (ROOT / "review" / "packets").glob("review_*.csv") if "_unique_sources" not in p.name)
    packet = Path(a.packet) if a.packet else (packets[-1] if packets else None)
    if packet is None:
        raise SystemExit("no review packet found: run python -m src.review.build_packet first")
    out = write(packet)
    print(f"{out} ({sum(1 for _ in open(out)) - 1} unique source URLs)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
