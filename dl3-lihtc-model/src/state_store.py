"""Keep the pipeline's working state in a here.now Drive so every run builds on the last one.

What is kept (all under the Drive folder dl3-pipeline/):
    dl3.db.gz           the SQLite database: every snapshot record, extraction and reviewer decision
    archive/<path>      every archived original document, uploaded once (originals never change)
    ocr_cache.tar.gz    OCR text already read from scanned pages, so it is not read twice

Commands (run from dl3-lihtc-model/):
    python -m src.state_store pull         download the latest state (an existing local DB is backed up first)
    python -m src.state_store push         upload this machine's state
    python -m src.state_store status       compare local and Drive without changing anything
    python -m src.state_store publish-web  upload the website files so the site shows the newest results at once
    python -m src.state_store make-token   create a Drive token limited to dl3-pipeline/, for the GitHub job
    python -m src.state_store make-token --site   a read-only token for the website's proxy (results only)

Safety:
    * push refuses to overwrite a database someone else uploaded after your last pull (here.now checks
      the version you pulled), so a review imported on one machine is never silently lost. Pull, redo
      your step, push again. --force exists for a person who has decided to discard the Drive copy.
    * The token comes from HERENOW_DRIVE_TOKEN, else HERENOW_API_KEY, else ~/.herenow/credentials.
      It is never printed or written to the log. make-token saves the new token to a file (mode 600).
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import tarfile
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

import requests

ROOT = Path(__file__).resolve().parents[1]
PREFIX = "dl3-pipeline/"
DB_KEY = PREFIX + "dl3.db.gz"
OCR_KEY = PREFIX + "ocr_cache.tar.gz"
ARCHIVE_KEY = PREFIX + "archive/"
AUTO_REGISTER_KEY = PREFIX + "source_register_auto.csv"  # states added with run_all.py --states
WEB_KEY = PREFIX + "web/"  # the newest website files; the site reads them through a read-only proxy route
MAX_FILE = 500 * 1024 * 1024  # here.now's per-file Drive limit
CLIENT = "dl3-lihtc-model/state-store"


class StateError(RuntimeError):
    """A problem a person must act on. The message says what to do."""


class Conflict(StateError):
    pass


def find_token(env=os.environ, home: Path | None = None) -> str:
    for name in ("HERENOW_DRIVE_TOKEN", "HERENOW_API_KEY"):
        if (env.get(name) or "").strip():
            return env[name].strip()
    cred = (home or Path.home()) / ".herenow" / "credentials"
    if cred.is_file():
        key = cred.read_text().strip()
        if key:
            return key
    raise StateError("No here.now token. Set HERENOW_DRIVE_TOKEN (the GitHub secret) or sign in to here.now "
                     "(node scripts/herenow-login.mjs) so ~/.herenow/credentials exists.")


class Drive:
    """The few here.now Drive calls this needs. Docs: https://here.now/docs (Drive)."""

    def __init__(self, token: str, base: str | None = None, drive_id: str | None = None, session=None):
        self.base = (base or os.environ.get("HERENOW_API_BASE") or "https://here.now").rstrip("/")
        self.s = session or requests.Session()
        self._auth = {"Authorization": f"Bearer {token}", "X-HereNow-Client": CLIENT}
        self._id = drive_id or os.environ.get("HERENOW_DRIVE_ID") or None

    def _call(self, method, path, *, ok=(200,), attempts=4, **kw):
        for i in range(attempts):
            r = self.s.request(method, self.base + path, headers={**self._auth, **kw.pop("headers", {})}, timeout=120, **kw)
            if r.status_code in (429, 500, 502, 503, 504) and i < attempts - 1:
                time.sleep(2 ** i)
                continue
            if r.status_code in ok:
                return r
            msg = _error_text(r)
            if r.status_code in (401, 403):
                raise StateError(f"here.now refused the token ({r.status_code}: {msg}). Check the HERENOW_DRIVE_TOKEN "
                                 "secret, or make a new one with: python -m src.state_store make-token")
            if r.status_code in (409, 412):
                raise Conflict(msg)
            raise StateError(f"here.now Drive {method} {path} failed ({r.status_code}): {msg}")
        raise AssertionError("unreachable")

    @property
    def id(self) -> str:
        if not self._id:
            self._id = self._call("GET", "/api/v1/drives/default").json()["drive"]["id"]
        return self._id

    def _files(self, path=""):
        return f"/api/v1/drives/{quote(self.id, safe='')}/files" + (f"/{quote(path, safe='/')}" if path else "")

    def list(self, prefix: str) -> dict[str, dict]:
        out, cursor = {}, None
        while True:
            params = {"prefix": prefix, "limit": 200, **({"cursor": cursor} if cursor else {})}
            j = self._call("GET", self._files(), params=params).json()
            out.update({f["path"]: f for f in j.get("files", [])})
            cursor = j.get("nextCursor")
            if not cursor:
                return out

    def stat(self, path: str) -> dict | None:
        return self.list(path).get(path)

    def get(self, path: str, dest: Path) -> None:
        r = self._call("GET", self._files(path), stream=True)
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(dest.name + ".part")
        with open(tmp, "wb") as fh:
            for chunk in r.iter_content(1 << 20):
                fh.write(chunk)
        tmp.replace(dest)

    def put(self, path: str, src: Path, content_type: str, *, if_match: str | None = None,
            if_none_match: bool = False) -> dict:
        size = src.stat().st_size
        if size > MAX_FILE:
            raise StateError(f"{src.name} is {size/1e6:.0f} MB; here.now Drive takes files up to 500 MB.")
        body = {"path": path, "size": size, "contentType": content_type, "sha256": sha256_file(src)}
        if if_match:
            body["ifMatch"] = if_match
        elif if_none_match:
            body["ifNoneMatch"] = "*"
        up = self._call("POST", self._files() + "/uploads", json=body).json()
        url = up.get("uploadUrl") or up.get("url")  # the live API says uploadUrl; the OpenAPI file says url
        with open(src, "rb") as fh:
            r = self.s.request(up.get("method", "PUT"), url, headers=up.get("headers") or {}, data=fh, timeout=600)
        if r.status_code not in (200, 201, 204):
            raise StateError(f"Uploading {src.name} to storage failed ({r.status_code}).")
        res = self._call("POST", self._files() + "/finalize", json={"uploadId": up["uploadId"], "path": path}).json()
        files = res.get("files") or []
        return next((f for f in files if f.get("path") == path), files[0] if files else {})

    def make_token(self, label: str, ttl: str | None, perms: str = "write", prefix: str = PREFIX) -> str:
        body = {"perms": perms, "manageTokens": False, "pathPrefix": prefix, "label": label, **({"ttl": ttl} if ttl else {})}
        return self._call("POST", f"/api/v1/drives/{quote(self.id, safe='')}/tokens", json=body).json()["token"]


def _error_text(r) -> str:
    try:
        j = r.json()
        return str(j.get("error") or j.get("message") or j)[:300]
    except ValueError:
        return (r.text or "")[:300]


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _same_sha(remote: dict | None, sha: str) -> bool:
    return bool(remote) and (remote.get("sha256") or "").removeprefix("sha256:") == sha


class Paths:
    def __init__(self, root: Path = ROOT):
        self.root = root
        self.db = root / "data" / "dl3.db"
        self.archive = root / "archive"
        self.ocr = root / "data" / "ocr_cache"
        self.versions = root / "data" / ".state_versions.json"
        self.auto_register = root / "config" / "source_register_auto.csv"
        self.web = root / "data" / "web"
        self.inventory_csv = root / "data" / "inventory" / "state_inventory.csv"

    def load_versions(self) -> dict:
        try:
            return json.loads(self.versions.read_text())
        except (OSError, ValueError):
            return {}

    def save_versions(self, v: dict) -> None:
        self.versions.parent.mkdir(parents=True, exist_ok=True)
        self.versions.write_text(json.dumps(v, indent=2, sort_keys=True))


def db_snapshot_gz(db: Path, dest: Path) -> None:
    """A consistent copy of the live database (SQLite's backup API), gzipped with a fixed timestamp."""
    with tempfile.TemporaryDirectory() as td:
        copy = Path(td) / "copy.db"
        src, dst = sqlite3.connect(db), sqlite3.connect(copy)
        try:
            src.backup(dst)
        finally:
            dst.close()
            src.close()
        with open(copy, "rb") as fh, open(dest, "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as gz:
            shutil.copyfileobj(fh, gz)


def ocr_tar(ocr_dir: Path, dest: Path) -> bool:
    files = sorted(p for p in ocr_dir.rglob("*") if p.is_file()) if ocr_dir.is_dir() else []
    if not files:
        return False
    with open(dest, "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as gz, tarfile.open(fileobj=gz, mode="w") as tar:
        for p in files:
            info = tar.gettarinfo(p, arcname=p.relative_to(ocr_dir).as_posix())
            info.mtime, info.uid, info.gid, info.uname, info.gname = 0, 0, 0, "", ""
            with open(p, "rb") as fh:
                tar.addfile(info, fh)
    return True


def _check_db(path: Path) -> None:
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        ok = conn.execute("PRAGMA integrity_check").fetchone()[0]
        conn.close()
    except sqlite3.DatabaseError as e:
        raise StateError(f"The database downloaded from here.now is not a readable SQLite file ({e}).") from e
    if ok != "ok":
        raise StateError(f"The database downloaded from here.now failed its integrity check: {ok}")


def _safe_rel(rel: str) -> Path | None:
    p = Path(rel)
    return None if p.is_absolute() or ".." in p.parts or not rel else p


def pull(drive: Drive, paths: Paths, log=print) -> dict:
    summary = {"db": "missing on Drive", "archive_downloaded": 0, "ocr": "missing on Drive"}
    versions = paths.load_versions()
    remote = drive.list(PREFIX)

    db_remote = remote.get(DB_KEY)
    if db_remote:
        with tempfile.TemporaryDirectory() as td:
            gz = Path(td) / "dl3.db.gz"
            drive.get(DB_KEY, gz)
            new = Path(td) / "dl3.db"
            with gzip.open(gz, "rb") as fh, open(new, "wb") as out:
                shutil.copyfileobj(fh, out)
            _check_db(new)
            paths.db.parent.mkdir(parents=True, exist_ok=True)
            if paths.db.exists():
                stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
                backup = paths.db.with_name(f"dl3.db.before-pull-{stamp}")
                shutil.copy2(paths.db, backup)
                log(f"  kept your previous local database as {backup.relative_to(paths.root)}")
            for side in ("-wal", "-shm"):  # stale journal files would be replayed onto the new DB
                Path(str(paths.db) + side).unlink(missing_ok=True)
            shutil.move(str(new), paths.db)
        versions["db_etag"] = db_remote["etag"]
        summary["db"] = f"downloaded ({db_remote['size']/1e6:.1f} MB gz, updated {db_remote.get('updatedAt', '?')})"
    else:
        versions.pop("db_etag", None)

    for key, f in remote.items():
        if not key.startswith(ARCHIVE_KEY):
            continue
        rel = _safe_rel(key[len(ARCHIVE_KEY):])
        if rel is None:
            log(f"  skipped an archive entry with an unsafe name: {key!r}")
            continue
        dest = paths.archive / rel
        if dest.is_file() and dest.stat().st_size == f.get("size") and _same_sha(f, sha256_file(dest)):
            continue
        drive.get(key, dest)
        summary["archive_downloaded"] += 1

    if AUTO_REGISTER_KEY in remote:  # the Drive copy is the newest: every run that adds a state saves it there
        drive.get(AUTO_REGISTER_KEY, paths.auto_register)
        summary["auto_register"] = "downloaded"

    ocr_remote = remote.get(OCR_KEY)
    if ocr_remote:
        with tempfile.TemporaryDirectory() as td:
            tgz = Path(td) / "ocr.tar.gz"
            drive.get(OCR_KEY, tgz)
            paths.ocr.mkdir(parents=True, exist_ok=True)
            with tarfile.open(tgz, "r:gz") as tar:
                tar.extractall(paths.ocr, filter="data")  # "data" refuses absolute paths, .. and links out
        summary["ocr"] = "downloaded"

    paths.save_versions(versions)
    return summary


def push(drive: Drive, paths: Paths, force: bool = False, log=print) -> dict:
    if not paths.db.exists():
        raise StateError(f"There is no local database at {paths.db.relative_to(paths.root)} to upload.")
    summary = {"db": "unchanged", "archive_uploaded": 0, "ocr": "unchanged"}
    versions = paths.load_versions()
    remote = drive.list(PREFIX)

    # Originals first: the database must never point at a document that is not on the Drive yet.
    if paths.archive.is_dir():
        for p in sorted(x for x in paths.archive.rglob("*") if x.is_file() and not x.name.endswith(".part")):
            key = ARCHIVE_KEY + p.relative_to(paths.archive).as_posix()
            f = remote.get(key)
            if f and f.get("size") == p.stat().st_size and _same_sha(f, sha256_file(p)):
                continue
            drive.put(key, p, "application/octet-stream", if_match=f["etag"] if f else None, if_none_match=not f)
            summary["archive_uploaded"] += 1

    with tempfile.TemporaryDirectory() as td:
        gz = Path(td) / "dl3.db.gz"
        db_snapshot_gz(paths.db, gz)
        sha = sha256_file(gz)
        db_remote = remote.get(DB_KEY)
        if not _same_sha(db_remote, sha):
            known = versions.get("db_etag")
            if db_remote and not force and db_remote["etag"] != known:
                raise Conflict(
                    "The database on here.now changed after this machine last pulled it (someone else pushed a run or "
                    "a review). Nothing was overwritten. Run `python -m src.state_store pull`, redo your step, then push. "
                    "Use --force only if you have decided to throw away the copy on here.now.")
            try:
                f = drive.put(DB_KEY, gz, "application/gzip",
                              if_match=None if force or not db_remote else db_remote["etag"],
                              if_none_match=not db_remote and not force)
            except Conflict as e:
                raise Conflict(f"here.now refused the upload because the database there changed during this run ({e}). "
                               "Nothing was overwritten. Pull, redo your step, then push.") from e
            versions["db_etag"] = f.get("etag") or (drive.stat(DB_KEY) or {}).get("etag")
            summary["db"] = f"uploaded ({gz.stat().st_size/1e6:.1f} MB gz)"
        elif db_remote:
            versions["db_etag"] = db_remote["etag"]

        tgz = Path(td) / "ocr.tar.gz"
        if ocr_tar(paths.ocr, tgz):
            o = remote.get(OCR_KEY)
            if not _same_sha(o, sha256_file(tgz)):
                drive.put(OCR_KEY, tgz, "application/gzip")  # a cache: newest copy wins
                summary["ocr"] = "uploaded"

    if paths.auto_register.is_file():
        a = remote.get(AUTO_REGISTER_KEY)
        if not _same_sha(a, sha256_file(paths.auto_register)):
            drive.put(AUTO_REGISTER_KEY, paths.auto_register, "text/csv")
            summary["auto_register"] = "uploaded"

    paths.save_versions(versions)
    return summary


def web_files(paths: Paths) -> dict[str, Path]:
    from src.report.export_web import SITE_FILES
    files = {name: paths.web / name for name in SITE_FILES if (paths.web / name).is_file()}
    if paths.inventory_csv.is_file():
        files["inventory.csv"] = paths.inventory_csv
    return files


def publish_web(drive: Drive, paths: Paths) -> dict:
    """Upload the website files (python -m src.report.export_web) so the site can show them without a rebuild.
    manifest.json goes last: the site treats a new manifest as "new results are ready"."""
    files = web_files(paths)
    if "manifest.json" not in files:
        raise StateError("No website files yet: run python -m src.report.export_web first.")
    remote = drive.list(WEB_KEY)
    sent = []
    for name in sorted(files, key=lambda n: n == "manifest.json"):
        key, src = WEB_KEY + name, files[name]
        if _same_sha(remote.get(key), sha256_file(src)):
            continue
        ctype = "application/json" if name.endswith(".json") else "text/csv"
        drive.put(key, src, ctype)  # published copies: newest wins
        sent.append(name)
    return {"published": ", ".join(sent) or "nothing changed", "folder": WEB_KEY}


def status(drive: Drive, paths: Paths) -> dict:
    remote = drive.list(PREFIX)
    db_remote = remote.get(DB_KEY)
    versions = paths.load_versions()
    archive_remote = {k for k in remote if k.startswith(ARCHIVE_KEY)}
    local = {ARCHIVE_KEY + p.relative_to(paths.archive).as_posix()
             for p in paths.archive.rglob("*") if p.is_file()} if paths.archive.is_dir() else set()
    return {
        "drive_db": f"{db_remote['size']/1e6:.1f} MB gz, updated {db_remote.get('updatedAt')}" if db_remote else "none yet",
        "local_db": "present" if paths.db.exists() else "none",
        "pulled_version_is_latest": bool(db_remote) and versions.get("db_etag") == db_remote["etag"],
        "archive_files_on_drive": len(archive_remote),
        "archive_files_only_here": len(local - archive_remote),
        "archive_files_only_on_drive": len(archive_remote - local),
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("pull", help="download the latest state from here.now")
    p = sub.add_parser("push", help="upload this machine's state to here.now")
    p.add_argument("--force", action="store_true", help="overwrite the Drive database even if it changed since your pull")
    sub.add_parser("status", help="compare local state with here.now")
    sub.add_parser("publish-web", help="upload the website files so the site shows the newest results")
    t = sub.add_parser("make-token", help="create a Drive token limited to dl3-pipeline/ (for the GitHub secret)")
    t.add_argument("--site", action="store_true",
                   help="a READ-ONLY token limited to dl3-pipeline/web/, for the website's proxy variable DL3_DRIVE_READ_TOKEN")
    t.add_argument("--out", type=Path, default=None)
    t.add_argument("--ttl", default=None, help='e.g. "180d"; default: no expiry')
    a = ap.parse_args(argv)

    try:
        drive = Drive(find_token())
        paths = Paths()
        if a.cmd == "pull":
            r = pull(drive, paths)
        elif a.cmd == "push":
            r = push(drive, paths, force=a.force)
        elif a.cmd == "status":
            r = status(drive, paths)
        elif a.cmd == "publish-web":
            r = publish_web(drive, paths)
        else:
            if a.site:
                token = drive.make_token("dl3 website: read pipeline results", a.ttl, perms="read", prefix=WEB_KEY)
                out = a.out or Path.home() / ".herenow" / "dl3_site_read_token"
                where = ("Give the file's contents to your instructor to store as the here.now variable "
                         "DL3_DRIVE_READ_TOKEN (allowed upstream: here.now), then delete the file.")
            else:
                token = drive.make_token("dl3 pipeline GitHub job", a.ttl)
                out = a.out or Path.home() / ".herenow" / "dl3_drive_token"
                where = ("Copy the file's contents into the GitHub secret HERENOW_DRIVE_TOKEN "
                         "(Settings > Secrets and variables > Actions), then delete the file.")
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(token + "\n")
            out.chmod(0o600)
            r = {"saved_to": str(out), "limited_to": WEB_KEY if a.site else PREFIX,
                 "drive_id (not secret)": drive.id, "next": where}
    except StateError as e:
        print(f"✖ {e}", file=sys.stderr)
        return 2
    for k, v in r.items():
        print(f"  {k}: {v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
