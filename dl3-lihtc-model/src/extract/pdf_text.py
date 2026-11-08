"""Page-level text from archived documents. OCR is flagged, not silently attempted."""
from __future__ import annotations

from dataclasses import dataclass

from ..fetch.diff import html_to_text

MIN_CHARS_TEXT_PAGE = 25


@dataclass
class Page:
    number: int          # 1-based
    text: str
    needs_ocr: bool = False


def pages_from_bytes(raw: bytes, content_type: str | None) -> list[Page] | None:
    """None for formats without text extraction (spreadsheets, Word); those use dedicated parsers."""
    ct = (content_type or "").split(";")[0].strip().lower()
    if ct == "application/pdf":
        import pymupdf
        out = []
        with pymupdf.open(stream=raw, filetype="pdf") as doc:
            for i, pg in enumerate(doc, 1):
                t = pg.get_text().strip()
                out.append(Page(i, t, needs_ocr=len(t) < MIN_CHARS_TEXT_PAGE and bool(pg.get_images())))
        return out
    if ct == "text/html":
        return [Page(1, html_to_text(raw))]
    if ct in ("text/csv", "text/plain"):
        return [Page(1, raw.decode("utf-8", "replace"))]
    return None
