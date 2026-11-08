"""Parse the archived HUD allocating-agency list (source P1) into data/reference/hud_allocators.csv.

The live layout could not be inspected from the build environment, so the parser accepts either a table
(state cell + agency link) or headings/paragraphs naming a state followed by agency links. Every row is
marked "needs verification"; the inventory compares these rows with config/jurisdictions.csv.
"""
from __future__ import annotations

import csv
from pathlib import Path
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup, NavigableString, Tag

from ..inventory.states import match_state

FIELDS = ["state", "agency_name", "agency_url", "agency_host", "verification_status"]


def parse_allocators(html: bytes, base_url: str = "") -> list[dict]:
    soup = BeautifulSoup(html, "lxml")
    for t in soup(["script", "style", "nav", "header", "footer"]):
        t.decompose()
    page_host = (urlparse(base_url).hostname or "").lower()
    rows, seen, state = [], set(), None
    for node in (soup.body or soup).descendants:
        if isinstance(node, NavigableString):
            if node.find_parent("a") is None:
                s = match_state(str(node))
                if s:
                    state = s
            continue
        if not (isinstance(node, Tag) and node.name == "a" and node.get("href")):
            continue
        url = urljoin(base_url, node["href"]).split("#")[0]
        p = urlparse(url)
        host = (p.hostname or "").lower()
        if p.scheme not in ("http", "https") or not host or host == page_host or state is None:
            continue
        name = " ".join(node.get_text().split())
        tr = node.find_parent("tr")
        if tr is not None:  # in a table the agency name may sit in another cell
            cells = [" ".join(c.get_text().split()) for c in tr.find_all(["td", "th"])]
            name = next((c for c in cells if c and match_state(c) is None and len(c) > 3), name)
        key = (state, url)
        if key in seen:
            continue
        seen.add(key)
        rows.append({"state": state, "agency_name": name or host, "agency_url": url,
                     "agency_host": host.removeprefix("www."), "verification_status": "needs verification"})
    return rows


def write_csv(rows: list[dict], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)


def read_csv(path: Path) -> list[dict]:
    if not Path(path).exists():
        return []
    with open(path, newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))
