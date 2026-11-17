import json

import pymupdf
import pytest

from src.extract import extract, pdf_text
from src.extract.llm_client import LLMResult
from src.fetch import archive, fetch

TEXT = "Section 12. Developer Fee. The developer fee shall not exceed 15% of total development cost."
needs_tesseract = pytest.mark.skipif(not pdf_text.tesseract_available(), reason="Tesseract not installed")


def scanned_pdf(text=TEXT, with_text_page=True) -> bytes:
    src = pymupdf.open()
    p = src.new_page()
    p.insert_textbox(pymupdf.Rect(60, 60, 540, 400), text, fontsize=14)
    pix = p.get_pixmap(dpi=200)
    out = pymupdf.open()
    if with_text_page:
        out.new_page().insert_text((72, 72), "Cover page with a real text layer, 2026 QAP.")
    q = out.new_page()
    q.insert_image(q.rect, pixmap=pix)
    return out.tobytes()


@pytest.fixture(autouse=True)
def cache(tmp_path, monkeypatch):
    monkeypatch.setenv("DL3_OCR_CACHE", str(tmp_path / "ocr"))
    return tmp_path / "ocr"


@needs_tesseract
def test_scanned_page_is_read_marked_and_cached(cache, monkeypatch):
    raw = scanned_pdf()
    pages = pdf_text.pages_from_bytes(raw, "application/pdf")
    assert (pages[0].ocr, pages[0].needs_ocr) == (False, False)       # real text layer untouched
    assert pages[1].ocr and not pages[1].needs_ocr and "shall not exceed 15%" in " ".join(pages[1].text.split())
    files = list(cache.glob("*.json"))
    assert len(files) == 1 and json.loads(files[0].read_text())["version"] == pdf_text.OCR_VERSION
    monkeypatch.setattr(pdf_text, "tesseract_available", lambda: False)  # second read must come from the cache
    again = pdf_text.pages_from_bytes(raw, "application/pdf")
    assert again[1].ocr and again[1].text == pages[1].text


def test_without_tesseract_page_stays_flagged(monkeypatch):
    monkeypatch.setattr(pdf_text, "tesseract_available", lambda: False)
    pages = pdf_text.pages_from_bytes(scanned_pdf(), "application/pdf")
    assert pages[1].needs_ocr and not pages[1].ocr and pages[1].text == ""


def test_ocr_can_be_switched_off(monkeypatch):
    monkeypatch.setenv("DL3_OCR", "off")
    assert pdf_text.tesseract_available() is False
    assert pdf_text.pages_from_bytes(scanned_pdf(), "application/pdf", ocr=False)[1].needs_ocr


@needs_tesseract
def test_blank_image_page_stays_flagged():
    doc = pymupdf.open()
    pg = doc.new_page()
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 50, 50), False)
    pix.clear_with(255)  # white; an uncleared pixmap is random noise
    pg.insert_image(pg.rect, pixmap=pix)
    assert pdf_text.pages_from_bytes(doc.tobytes(), "application/pdf")[0].needs_ocr


@needs_tesseract
def test_extraction_from_scan_is_verified_and_flagged_for_reviewer(tmp_path):
    conn = archive.connect(tmp_path / "t.db")
    src = {"source_id": "S1", "jurisdiction": "T", "state": "ZZ", "doc_type": "qap_doc", "title": "Scanned QAP",
           "url": "https://x/q.pdf", "status": "unknown", "critical": 1, "notes": ""}
    archive.upsert_source(conn, src)
    archive.store_snapshot(conn, tmp_path / "a", source=src, data=scanned_pdf(), requested_url=src["url"],
                           final_url=src["url"], content_type="application/pdf", http_status=200)

    class Fake:
        def extract(self, system, document, instruction, schema):
            assert "shall not exceed 15%" in " ".join(document.split())   # OCR text was sent
            return LLMResult(json.dumps({"findings": [{
                "field": "developer_fee_max_percent", "value": "15%", "units": "percent", "applies_to": "unknown",
                "page": 2, "section": "12", "quote": "The developer fee shall not exceed 15% of total development cost.",
                "confidence": "high", "notes": ""}], "not_found": []}), "m", "r", "STOP", {})

    cfg = {"llm": {**fetch.load_settings()["llm"], "model": "m", "topics_by_doc_type": {"qap_doc": ["fee_rule"]}}}
    s = extract.run(tmp_path / "t.db", tmp_path / "a", cfg, client=Fake(), progress=lambda m: None)
    assert s["pending_review"] == 1 and s["rejected_validation"] == 0
    conn = archive.connect(tmp_path / "t.db")
    row = conn.execute("SELECT * FROM extraction").fetchone()
    assert row["quote_verified"] == 1 and "read by OCR" in row["validation_note"]
    assert "OCR pages 2" in conn.execute("SELECT pages_sent FROM llm_call").fetchone()[0]
