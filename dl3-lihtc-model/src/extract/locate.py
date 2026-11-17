"""Find which pages of a document likely hold each rule type, with a verbatim quote."""
from __future__ import annotations

import re
from pathlib import Path

import yaml

from .pdf_text import Page

ROOT = Path(__file__).resolve().parents[2]


def load_topics(path: Path | None = None) -> dict[str, list[str]]:
    return yaml.safe_load((path or ROOT / "config" / "locate_keywords.yaml").read_text())["topics"]


def _snippet(text: str, m: re.Match, width: int = 160) -> str:
    start, end = max(0, m.start() - width // 2), min(len(text), m.end() + width // 2)
    return " ".join(text[start:end].split())


def locate(pages: list[Page], topics: dict[str, list[str]], top_n: int = 5) -> list[dict]:
    """Rank pages per topic by number of pattern hits. Highest first; ties broken by page order."""
    out = []
    for topic, patterns in topics.items():
        compiled = [re.compile(p, re.I) for p in patterns]
        hits = []
        for pg in pages:
            matches = [m for rx in compiled for m in rx.finditer(pg.text)]
            if matches:
                first = min(matches, key=lambda m: m.start())
                hits.append({"topic": topic, "page": pg.number, "score": len(matches),
                             "quote": _snippet(pg.text, first)})
        hits.sort(key=lambda h: (-h["score"], h["page"]))
        out.extend(hits[:top_n])
    return out


def locate_snapshot(conn, archive_root: Path, snap, topics: dict[str, list[str]]) -> dict:
    """Locate and persist candidate pages for one snapshot. Returns counts and OCR page list."""
    from .pdf_text import pages_from_bytes
    raw = (Path(archive_root) / snap["archive_path"]).read_bytes()
    pages = pages_from_bytes(raw, snap["content_type"])
    if pages is None:
        return {"snapshot_id": snap["snapshot_id"], "candidates": 0, "needs_ocr_pages": [], "skipped": "no text extractor"}
    conn.execute("DELETE FROM candidate_page WHERE snapshot_id=?", (snap["snapshot_id"],))
    found = locate(pages, topics)
    conn.executemany("INSERT INTO candidate_page (snapshot_id, topic, page, score, quote) VALUES (?,?,?,?,?)",
                     [(snap["snapshot_id"], h["topic"], h["page"], h["score"], h["quote"]) for h in found])
    conn.commit()
    return {"snapshot_id": snap["snapshot_id"], "candidates": len(found),
            "needs_ocr_pages": [p.number for p in pages if p.needs_ocr]}
