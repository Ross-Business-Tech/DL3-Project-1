"""state_store against an in-memory fake of the here.now Drive API (no network)."""
import gzip
import io
import hashlib
import json
import sqlite3
from urllib.parse import unquote, urlparse, parse_qs

import pytest

from src import state_store as ss


class Resp:
    def __init__(self, status, body=b"", js=None):
        self.status_code, self._js = status, js
        self.content = body if js is None else json.dumps(js).encode()
        self.text = self.content.decode("latin-1")

    def json(self):
        if self._js is None:
            raise ValueError
        return self._js

    def iter_content(self, n):
        yield self.content


class FakeDrive:
    """Just enough of /api/v1/drives/... including etag preconditions."""

    def __init__(self):
        self.files, self.uploads, self.n, self.calls, self.tokens = {}, {}, 0, [], []

    def _meta(self, path):
        data = self.files[path]["data"]
        return {"path": path, "etag": self.files[path]["etag"], "size": len(data),
                "sha256": hashlib.sha256(data).hexdigest(), "contentType": "x", "versionId": None, "updatedAt": "t"}

    def request(self, method, url, headers=None, params=None, json=None, data=None, **kw):
        u = urlparse(url)
        self.calls.append((method, u.path))
        if u.netloc == "storage":
            self.uploads[u.path.strip("/")]["data"] = data.read() if hasattr(data, "read") else data
            return Resp(200)
        assert headers["Authorization"] == "Bearer tok"
        p = u.path
        if p == "/api/v1/drives/default":
            return Resp(200, js={"drive": {"id": "drv_1"}})
        base = "/api/v1/drives/drv_1/files"
        if p == base and method == "GET":
            pre = params["prefix"]
            return Resp(200, js={"files": [self._meta(k) for k in sorted(self.files) if k.startswith(pre)], "nextCursor": None})
        if p == base + "/uploads":
            cur = self.files.get(json["path"])
            if json.get("ifNoneMatch") == "*" and cur:
                return Resp(412, js={"error": "exists"})
            if json.get("ifMatch") and (not cur or cur["etag"] != json["ifMatch"]):
                return Resp(412, js={"error": "etag mismatch"})
            self.n += 1
            uid = f"u{self.n}"
            self.uploads[uid] = {"path": json["path"], "sha": json["sha256"]}
            return Resp(200, js={"uploadId": uid, "uploadUrl": f"https://storage/{uid}", "headers": {}, "expiresInSeconds": 60})
        if p == base + "/finalize":
            up = self.uploads.pop(json["uploadId"])
            assert hashlib.sha256(up["data"]).hexdigest() == up["sha"]
            self.n += 1
            self.files[up["path"]] = {"data": up["data"], "etag": f"e{self.n}"}
            return Resp(200, js={"success": True, "files": [self._meta(up["path"])]})
        if p.startswith(base + "/") and method == "GET":
            key = unquote(p[len(base) + 1:])
            return Resp(200, self.files[key]["data"]) if key in self.files else Resp(404, js={"error": "nf"})
        if p == "/api/v1/drives/drv_1/tokens":
            self.tokens.append(json)
            return Resp(200, js={"token": "scoped-secret"})
        raise AssertionError(f"unexpected {method} {url}")


def make_state(root, rows=("a",)):
    (root / "data").mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(root / "data" / "dl3.db")
    conn.execute("CREATE TABLE IF NOT EXISTS t (v TEXT)")
    conn.executemany("INSERT INTO t VALUES (?)", [(r,) for r in rows])
    conn.commit()
    conn.close()
    (root / "archive" / "MI" / "QAP").mkdir(parents=True, exist_ok=True)
    (root / "archive" / "MI" / "QAP" / "doc.pdf").write_bytes(b"%PDF original")
    (root / "data" / "ocr_cache").mkdir(parents=True, exist_ok=True)
    (root / "data" / "ocr_cache" / "abc.json").write_text('{"1": "text"}')


def rows(root):
    conn = sqlite3.connect(root / "data" / "dl3.db")
    out = [r[0] for r in conn.execute("SELECT v FROM t ORDER BY rowid")]
    conn.close()
    return out


@pytest.fixture
def fake():
    return FakeDrive()


def drive(fake):
    return ss.Drive("tok", base="https://here.now", session=fake)


def test_push_then_pull_round_trip(tmp_path, fake):
    mac, ci = tmp_path / "mac", tmp_path / "ci"
    make_state(mac)
    r = ss.push(drive(fake), ss.Paths(mac), log=lambda *_: None)
    assert r["archive_uploaded"] == 1 and r["db"].startswith("uploaded") and r["ocr"] == "uploaded"
    assert set(fake.files) == {ss.DB_KEY, ss.OCR_KEY, ss.ARCHIVE_KEY + "MI/QAP/doc.pdf"}

    ss.pull(drive(fake), ss.Paths(ci), log=lambda *_: None)
    assert rows(ci) == ["a"]
    assert (ci / "archive" / "MI" / "QAP" / "doc.pdf").read_bytes() == b"%PDF original"
    assert (ci / "data" / "ocr_cache" / "abc.json").read_text() == '{"1": "text"}'


def test_unchanged_push_uploads_nothing(tmp_path, fake):
    make_state(tmp_path)
    ss.push(drive(fake), ss.Paths(tmp_path), log=lambda *_: None)
    before = len(fake.calls)
    r = ss.push(drive(fake), ss.Paths(tmp_path), log=lambda *_: None)
    assert r == {"db": "unchanged", "archive_uploaded": 0, "ocr": "unchanged"}
    assert not any(p.endswith("/uploads") for _, p in fake.calls[before:])


def test_push_refuses_to_overwrite_someone_elses_newer_db(tmp_path, fake):
    mac, ci = tmp_path / "mac", tmp_path / "ci"
    make_state(mac)
    ss.push(drive(fake), ss.Paths(mac), log=lambda *_: None)
    ss.pull(drive(fake), ss.Paths(ci), log=lambda *_: None)

    make_state(mac, rows=("review",))          # a reviewer imports decisions and pushes
    ss.push(drive(fake), ss.Paths(mac), log=lambda *_: None)
    make_state(ci, rows=("ci-run",))           # the job, still on the older copy, tries to push
    with pytest.raises(ss.Conflict):
        ss.push(drive(fake), ss.Paths(ci), log=lambda *_: None)
    with gzip.open(io.BytesIO(fake.files[ss.DB_KEY]["data"])) as fh:
        (tmp_path / "check.db").write_bytes(fh.read())
    conn = sqlite3.connect(tmp_path / "check.db")
    assert [r[0] for r in conn.execute("SELECT v FROM t")] == ["a", "review"]  # reviewer's work kept

    ss.pull(drive(fake), ss.Paths(ci), log=lambda *_: None)   # the fix: pull, redo, push
    make_state(ci, rows=("ci-run",))
    ss.push(drive(fake), ss.Paths(ci), log=lambda *_: None)


def test_first_push_will_not_replace_an_existing_drive_db(tmp_path, fake):
    a, b = tmp_path / "a", tmp_path / "b"
    make_state(a)
    ss.push(drive(fake), ss.Paths(a), log=lambda *_: None)
    make_state(b, rows=("other",))
    with pytest.raises(ss.Conflict):
        ss.push(drive(fake), ss.Paths(b), log=lambda *_: None)
    ss.push(drive(fake), ss.Paths(b), force=True, log=lambda *_: None)


def test_pull_backs_up_existing_local_db(tmp_path, fake):
    mac, ci = tmp_path / "mac", tmp_path / "ci"
    make_state(mac)
    ss.push(drive(fake), ss.Paths(mac), log=lambda *_: None)
    make_state(ci, rows=("local only",))
    ss.pull(drive(fake), ss.Paths(ci), log=lambda *_: None)
    backups = list((ci / "data").glob("dl3.db.before-pull-*"))
    assert len(backups) == 1 and rows(ci) == ["a"]


def test_pull_rejects_a_corrupt_database(tmp_path, fake):
    fake.files[ss.DB_KEY] = {"data": gzip.compress(b"not sqlite at all" * 100), "etag": "e0"}
    make_state(tmp_path, rows=("keep me",))
    with pytest.raises(ss.StateError):
        ss.pull(drive(fake), ss.Paths(tmp_path), log=lambda *_: None)
    assert rows(tmp_path) == ["keep me"]


def test_pull_skips_unsafe_archive_names(tmp_path, fake):
    fake.files[ss.ARCHIVE_KEY + "../escape.txt"] = {"data": b"x", "etag": "e1"}
    seen = []
    ss.pull(drive(fake), ss.Paths(tmp_path / "w"), log=seen.append)
    assert not (tmp_path / "escape.txt").exists() and any("unsafe" in s for s in seen)


def test_token_lookup_order_and_no_token(tmp_path):
    assert ss.find_token({"HERENOW_DRIVE_TOKEN": "d", "HERENOW_API_KEY": "k"}, home=tmp_path) == "d"
    assert ss.find_token({"HERENOW_API_KEY": "k"}, home=tmp_path) == "k"
    (tmp_path / ".herenow").mkdir()
    (tmp_path / ".herenow" / "credentials").write_text("c\n")
    assert ss.find_token({}, home=tmp_path) == "c"
    with pytest.raises(ss.StateError):
        ss.find_token({}, home=tmp_path / "nobody")


def test_make_token_is_scoped_to_the_pipeline_folder(fake):
    assert drive(fake).make_token("label", None) == "scoped-secret"
    assert fake.tokens == [{"perms": "write", "manageTokens": False, "pathPrefix": "dl3-pipeline/", "label": "label"}]


def test_bad_token_message(tmp_path):
    class Deny:
        def request(self, *a, **k):
            return Resp(401, js={"error": "bad token"})
    with pytest.raises(ss.StateError, match="HERENOW_DRIVE_TOKEN"):
        ss.Drive("tok", session=Deny()).list(ss.PREFIX)


def test_auto_register_travels_with_the_state(tmp_path, fake):
    mac, ci = tmp_path / "mac", tmp_path / "ci"
    make_state(mac)
    (mac / "config").mkdir()
    (mac / "config" / "source_register_auto.csv").write_text("source_id,state\nCA_QAP,CA\n")
    ss.push(drive(fake), ss.Paths(mac), log=lambda *_: None)
    (ci / "config").mkdir(parents=True)
    ss.pull(drive(fake), ss.Paths(ci), log=lambda *_: None)
    assert (ci / "config" / "source_register_auto.csv").read_text() == "source_id,state\nCA_QAP,CA\n"


def test_publish_web_sends_manifest_last_and_skips_unchanged(tmp_path, fake):
    web = tmp_path / "data" / "web"
    web.mkdir(parents=True)
    for name in ("rules.csv", "sources.csv", "manifest.json", "awards_pending_review.csv"):
        (web / name).write_text(name)
    r = ss.publish_web(drive(fake), ss.Paths(tmp_path))
    assert r["published"].split(", ")[-1] == "manifest.json"
    assert ss.WEB_KEY + "awards_pending_review.csv" not in fake.files  # only the files the site reads
    assert ss.publish_web(drive(fake), ss.Paths(tmp_path))["published"] == "nothing changed"


def test_publish_web_needs_an_export(tmp_path, fake):
    with pytest.raises(ss.StateError, match="export_web"):
        ss.publish_web(drive(fake), ss.Paths(tmp_path))


def test_site_token_is_read_only_and_limited_to_results(fake):
    drive(fake).make_token("site", None, perms="read", prefix=ss.WEB_KEY)
    assert fake.tokens[-1]["perms"] == "read" and fake.tokens[-1]["pathPrefix"] == "dl3-pipeline/web/"
