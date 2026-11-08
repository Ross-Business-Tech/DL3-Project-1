"""Parse the archived HUD allocating-agency list (source P1) into data/reference/hud_allocators.csv.

The page layout has not been verified against the live site from this environment, so the parser is
tolerant (any table with a header row) and every output row is marked needs_verification.
"""
from __future__ import annotations

import csv
from pathlib import Path

from bs4 import BeautifulSoup

FIELDS = ["state", "agency_name", "agency_url", "raw_row", "verification_status"]


def parse_allocators(html: bytes, base_url: str = "") -> list[dict]:
    from urllib.parse import urljoin
    soup = BeautifulSoup(html, "lxml")
    rows, state = [], ""
    for tr in soup.find_all("tr"):
        cells = tr.find_all(["td", "th"])
        if not cells or all(c.name == "th" for c in cells):
            continue
        texts = [" ".join(c.get_text().split()) for c in cells]
        link = tr.find("a", href=True)
        if len(texts[0]) in (2,) or texts[0].isupper() and len(texts[0]) < 25:
            state = texts[0]
        name = texts[1] if len(texts) > 1 and texts[1] else (link.get_text(strip=True) if link else "")
        if not name:
            continue
        rows.append({"state": state, "agency_name": name,
                     "agency_url": urljoin(base_url, link["href"]) if link else "",
                     "raw_row": " | ".join(texts), "verification_status": "needs verification"})
    return rows


def write_csv(rows: list[dict], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)
