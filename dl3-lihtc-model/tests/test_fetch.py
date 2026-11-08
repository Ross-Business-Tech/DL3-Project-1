import http.server
import threading
from datetime import timedelta
from pathlib import Path

import pymupdf
import pytest

from src.fetch import archive, diff, fetch

SETTINGS = {"fetch": {"timeout_seconds": 5, "max_retries": 2, "backoff_seconds": [0, 0],
                      "min_seconds_between_requests_per_host": 0, "max_bytes": 100000,
                      "respect_robots_txt": True,
                      "allowed_content_types": ["text/html", "application/pdf"]}}


def make_pdf(text: str) -> bytes:
    doc = pymupdf.open()
    doc.new_page().insert_text((72, 72), text)
    return doc.tobytes()


class Site:
    """Tiny mutable local site standing in for an agency server."""
    def __init__(self):
        self.routes = {}   # path -> (status, content_type, body)
        self.hits = {}
        site = self

        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                site.hits[self.path] = site.hits.get(self.path, 0) + 1
                status, ct, body = site.routes.get(self.path, (404, "text/plain", b"nope"))
                if callable(status):
                    status = status(site.hits[self.path])
                self.send_response(status)
                if status in (301, 302):
                    self.send_header("Location", body.decode())
                    body = b""
                self.send_header("Content-Type", ct)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            def log_message(self, *a): pass

        self.srv = http.server.HTTPServer(("127.0.0.1", 0), H)
        self.base = f"http://127.0.0.1:{self.srv.server_port}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()


@pytest.fixture
def site():
    s = Site()
    yield s
    s.srv.shutdown()


def reg(site, path="/qap", **kw):
    r = {"source_id": "T1", "jurisdiction": "Test", "state": "ZZ", "doc_type": "qap", "title": "t",
         "url": site.base + path, "status": "final", "critical": 1, "notes": ""}
    r.update(kw)
    return [r]


def go(site, tmp_path, register, **kw):
    f = fetch.Fetcher(SETTINGS, fetch.allowed_hosts(register), sleep=lambda s: None)
    return fetch.run(register, SETTINGS, tmp_path / "t.db", tmp_path / "archive", fetcher=f, **kw)


def test_fetch_archives_with_hash_and_metadata(site, tmp_path):
    site.routes["/qap"] = (200, "text/html", b"<html><body>Fee 15%</body></html>")
    s = go(site, tmp_path, reg(site))
    assert (s.fetched, s.failed) == (1, 0)
    conn = archive.connect(tmp_path / "t.db")
    snap = archive.latest_snapshot(conn, "T1")
    assert snap["archive_path"].startswith("ZZ/qap/") and snap["archive_path"].endswith(".html")
    assert (tmp_path / "archive" / snap["archive_path"]).exists()
    assert snap["sha256"] == archive.sha256_bytes(b"<html><body>Fee 15%</body></html>")
    assert snap["doc_status"] == "final" and snap["http_status"] == 200


def test_unchanged_refetch_is_duplicate_and_changed_is_detected(site, tmp_path):
    site.routes["/qap"] = (200, "text/html", b"<p>Fee 15%</p>")
    go(site, tmp_path, reg(site))
    s2 = go(site, tmp_path, reg(site))
    assert s2.unchanged == 1 and s2.changed == 0
    site.routes["/qap"] = (200, "text/html", b"<p>Fee 12%</p>")
    s3 = go(site, tmp_path, reg(site))
    assert s3.changed == 1
    conn = archive.connect(tmp_path / "t.db")
    assert conn.execute("SELECT COUNT(*) FROM snapshot").fetchone()[0] == 3  # history preserved
    d = diff.compare_latest(conn, tmp_path / "archive", "T1")
    assert d["status"] == "changed"
    assert any("12%" in l for l in d["text_diff"]["unified"] if l.startswith("+"))
    assert any("15%" in l for l in d["text_diff"]["unified"] if l.startswith("-"))


def test_pdf_diff_has_page_numbers(site, tmp_path):
    site.routes["/qap"] = (200, "application/pdf", make_pdf("Cap 4M"))
    go(site, tmp_path, reg(site))
    site.routes["/qap"] = (200, "application/pdf", make_pdf("Cap 5M"))
    go(site, tmp_path, reg(site))
    d = diff.compare_latest(archive.connect(tmp_path / "t.db"), tmp_path / "archive", "T1")
    joined = "\n".join(d["text_diff"]["unified"])
    assert "[page 1]" in joined and "Cap 5M" in joined


def test_html_layout_noise_is_not_a_change(site, tmp_path):
    site.routes["/qap"] = (200, "text/html", b"<script>a=1</script><p>Same text</p>")
    go(site, tmp_path, reg(site))
    site.routes["/qap"] = (200, "text/html", b"<script>a=2</script><p>Same   text</p>")
    go(site, tmp_path, reg(site))
    d = diff.compare_latest(archive.connect(tmp_path / "t.db"), tmp_path / "archive", "T1")
    assert d["status"] == "bytes_changed_text_same"


def test_retries_transient_errors_then_succeeds(site, tmp_path):
    site.routes["/qap"] = (lambda n: 503 if n < 3 else 200, "text/html", b"ok")
    assert go(site, tmp_path, reg(site)).fetched == 1


def test_gives_up_records_failure_and_keeps_last_good(site, tmp_path):
    site.routes["/qap"] = (200, "text/html", b"good")
    go(site, tmp_path, reg(site))
    site.routes["/qap"] = (503, "text/html", b"down")
    s = go(site, tmp_path, reg(site))
    assert s.failed == 1
    conn = archive.connect(tmp_path / "t.db")
    f = conn.execute("SELECT * FROM fetch_failure").fetchone()
    assert f["manual_review_queued"] == 1 and f["attempts"] == 3
    assert archive.latest_snapshot(conn, "T1")["sha256"] == archive.sha256_bytes(b"good")


def test_404_is_not_retried(site, tmp_path):
    s = go(site, tmp_path, reg(site, path="/missing"))
    assert s.failed == 1 and site.hits["/missing"] == 1


def test_robots_disallow_blocks(site, tmp_path):
    site.routes["/robots.txt"] = (200, "text/plain", b"User-agent: *\nDisallow: /qap\n")
    site.routes["/qap"] = (200, "text/html", b"x")
    s = go(site, tmp_path, reg(site))
    assert s.failed == 1 and "qap" not in [k for k in site.hits if k == "/qap"]


def test_disallowed_content_type_rejected(site, tmp_path):
    site.routes["/qap"] = (200, "application/x-msdownload", b"MZ")
    assert go(site, tmp_path, reg(site)).failed == 1


def test_size_cap(site, tmp_path):
    site.routes["/qap"] = (200, "text/html", b"a" * 200000)
    assert go(site, tmp_path, reg(site)).failed == 1


def test_redirect_off_allowlist_blocked(site, tmp_path):
    other = Site()  # same host name, different port is same hostname; use a different hostname instead
    site.routes["/qap"] = (302, "text/html", b"http://localhost:%d/x" % other.srv.server_port)
    other.routes["/x"] = (200, "text/html", b"evil")
    try:
        assert go(site, tmp_path, reg(site)).failed == 1
    finally:
        other.srv.shutdown()


def test_non_http_scheme_and_unlisted_host_blocked():
    f = fetch.Fetcher(SETTINGS, {"example.org"})
    for u in ("file:///etc/passwd", "https://evil.example.com/a.pdf"):
        with pytest.raises(fetch.FetchError):
            f.check_allowed(u)


def test_discover_and_follow_documents(site, tmp_path):
    site.routes["/qap"] = (200, "text/html",
        b'<a href="/plan.pdf">2027 QAP</a><a href="https://evil.example.com/x.pdf">bad</a><a href="/about">about</a>')
    site.routes["/plan.pdf"] = (200, "application/pdf", make_pdf("QAP"))
    s = go(site, tmp_path, reg(site), follow_documents=True)
    assert s.discovered == 1 and s.fetched == 2 and s.failed == 0
    conn = archive.connect(tmp_path / "t.db")
    child = conn.execute("SELECT * FROM snapshot WHERE parent_source_id='T1'").fetchone()
    assert child["content_type"] == "application/pdf"


def test_freshness_blocks_critical_when_stale(site, tmp_path):
    site.routes["/qap"] = (200, "text/html", b"x")
    go(site, tmp_path, reg(site))
    conn = archive.connect(tmp_path / "t.db")
    now = archive.utcnow() + timedelta(days=91)
    fr = archive.freshness(conn, "T1", True, 90, now)
    assert fr["stale"] and fr["blocks_recommendation"]
    assert not archive.freshness(conn, "T1", True, 90, archive.utcnow() + timedelta(days=90))["stale"]
    assert not archive.freshness(conn, "T1", False, 90, now)["blocks_recommendation"]
    assert archive.freshness(conn, "NEVER", True, 90)["blocks_recommendation"]


def test_register_loads_and_has_required_columns():
    rows = fetch.load_register()
    assert len(rows) >= 9 and all(r["url"].startswith("https://") for r in rows)
    assert {"P3", "P6"} <= {r["source_id"] for r in rows}


def test_fake_pdf_is_quarantined_not_archived(site, tmp_path):
    site.routes["/qap"] = (200, "application/pdf", b"<html>not a pdf</html>")
    s = go(site, tmp_path, reg(site))
    assert s.failed == 1 and "quarantined" in s.details[0]["error"]
    assert not any((tmp_path / "archive").rglob("*.pdf"))


def test_discovered_documents_do_not_inherit_final_status(site, tmp_path):
    site.routes["/qap"] = (200, "text/html", b'<a href="/plan.pdf">Plan</a>')
    site.routes["/plan.pdf"] = (200, "application/pdf", make_pdf("QAP"))
    go(site, tmp_path, reg(site, status="final"), follow_documents=True)
    conn = archive.connect(tmp_path / "t.db")
    assert conn.execute("SELECT doc_status FROM snapshot WHERE parent_source_id='T1'").fetchone()[0] == "unknown"
    assert conn.execute("SELECT doc_status FROM snapshot WHERE source_id='T1'").fetchone()[0] == "final"


def test_spec_source_record_fields_present(site, tmp_path):
    site.routes["/qap"] = (200, "text/html", b"x")
    go(site, tmp_path, reg(site, plan_year="2027-2028"))
    conn = archive.connect(tmp_path / "t.db")
    src = conn.execute("SELECT * FROM source").fetchone()
    assert src["plan_year"] == "2027-2028" and src["adoption_date"] is None
    snap = archive.latest_snapshot(conn, "T1")
    for col in ("url", "retrieved_at", "sha256", "doc_status", "archive_path"):  # Section 4 minimum fields
        assert snap[col]


def test_old_database_is_upgraded_in_place(site, tmp_path):
    import sqlite3
    old = sqlite3.connect(tmp_path / "t.db")  # schema from the first release: no run_id, no plan_year
    old.executescript("""
      CREATE TABLE source (source_id TEXT PRIMARY KEY, jurisdiction TEXT NOT NULL, state TEXT NOT NULL,
        doc_type TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unknown',
        critical INTEGER NOT NULL DEFAULT 0, notes TEXT);
      CREATE TABLE snapshot (snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL, url TEXT NOT NULL,
        final_url TEXT NOT NULL, retrieved_at TEXT NOT NULL, sha256 TEXT NOT NULL, content_type TEXT,
        byte_size INTEGER NOT NULL, http_status INTEGER NOT NULL, archive_path TEXT NOT NULL,
        is_duplicate INTEGER NOT NULL DEFAULT 0, parent_source_id TEXT, doc_status TEXT NOT NULL DEFAULT 'unknown');
      CREATE TABLE fetch_failure (failure_id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL, url TEXT NOT NULL,
        attempted_at TEXT NOT NULL, attempts INTEGER NOT NULL, error TEXT NOT NULL,
        manual_review_queued INTEGER NOT NULL DEFAULT 1);
      INSERT INTO source VALUES ('OLD','x','ZZ','qap','old','http://x','final',0,'');
    """)
    old.commit(); old.close()
    site.routes["/qap"] = (200, "text/html", b"hello")
    assert go(site, tmp_path, reg(site)).fetched == 1
    conn = archive.connect(tmp_path / "t.db")
    assert conn.execute("SELECT COUNT(*) FROM source").fetchone()[0] == 2  # old rows kept
    assert archive.latest_snapshot(conn, "T1")["run_id"] is None
