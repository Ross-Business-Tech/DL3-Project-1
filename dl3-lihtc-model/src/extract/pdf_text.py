"""Page-level text from archived documents, with OCR for scanned pages when Tesseract is installed.

OCR text is marked (`Page.ocr = True`) so reviewers know a quote was read from an image. Results are cached
by document hash in data/ocr_cache/, so each scanned page is read once. Without Tesseract, scanned pages
stay flagged `needs_ocr` and nothing is guessed.
"""
from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path

from ..fetch.diff import html_to_text

ROOT = Path(__file__).resolve().parents[2]
MIN_CHARS_TEXT_PAGE = 25
OCR_VERSION = "tesseract-eng-300dpi-1"


@dataclass
class Page:
    number: int          # 1-based
    text: str
    needs_ocr: bool = False   # image-only page whose text could not be read
    ocr: bool = False         # text came from OCR, not from the file's own text layer


def ocr_cache_dir() -> Path:
    return Path(os.environ.get("DL3_OCR_CACHE") or ROOT / "data" / "ocr_cache")


_TESS: bool | None = None


def tesseract_available() -> bool:
    global _TESS
    if os.environ.get("DL3_OCR", "").lower() in ("0", "off", "false", "no"):
        return False
    if _TESS is None:
        try:
            import pymupdf
            _TESS = bool(pymupdf.get_tessdata())
        except Exception:
            _TESS = False
    return _TESS


def _ocr_pages(raw: bytes, numbers: list[int]) -> dict[int, str]:
    """OCR the given 1-based pages. Cached by document hash; only missing pages are read."""
    path = ocr_cache_dir() / f"{hashlib.sha256(raw).hexdigest()}.json"
    cache = {}
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if data.get("version") == OCR_VERSION:
                cache = {int(k): v for k, v in data["pages"].items()}
        except (ValueError, KeyError):
            cache = {}
    todo = [n for n in numbers if n not in cache]
    if todo and tesseract_available():
        import pymupdf
        with pymupdf.open(stream=raw, filetype="pdf") as doc:
            for n in todo:
                try:
                    page = doc[n - 1]  # keep one page object alive: the text page refers back to it
                    tp = page.get_textpage_ocr(language="eng", dpi=300, full=True)
                    cache[n] = page.get_text(textpage=tp).strip()
                except Exception:
                    cache[n] = ""  # unreadable page: stays flagged
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"version": OCR_VERSION, "pages": cache}), encoding="utf-8")
    return {n: cache[n] for n in numbers if n in cache}


def pages_from_bytes(raw: bytes, content_type: str | None, ocr: bool = True) -> list[Page] | None:
    """None for formats without text extraction (spreadsheets, Word); those use dedicated parsers."""
    ct = (content_type or "").split(";")[0].strip().lower()
    if ct == "application/pdf":
        import pymupdf
        out = []
        with pymupdf.open(stream=raw, filetype="pdf") as doc:
            for i, pg in enumerate(doc, 1):
                t = pg.get_text().strip()
                out.append(Page(i, t, needs_ocr=len(t) < MIN_CHARS_TEXT_PAGE and bool(pg.get_images())))
        scanned = [p.number for p in out if p.needs_ocr]
        if ocr and scanned:
            read = _ocr_pages(raw, scanned)
            for p in out:
                t = read.get(p.number, "")
                if p.needs_ocr and len(t) >= MIN_CHARS_TEXT_PAGE:
                    p.text, p.ocr, p.needs_ocr = t, True, False
        return out
    if ct == "text/html":
        return [Page(1, html_to_text(raw))]
    if ct in ("text/csv", "text/plain"):
        return [Page(1, raw.decode("utf-8", "replace"))]
    return None
