"""Archive: hash, store originals, and record every retrieval in SQLite.

Originals are write-once. Files are named {yyyymmdd}_{hash8}.{ext} under
archive/{state}/{doc_type}/ so identical content on the same day is stored once.
"""
from __future__ import annotations

import hashlib
import mimetypes
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_PATH = Path(__file__).resolve().parents[1] / "schema" / "schema.sql"

_EXT_OVERRIDES = {
    "application/pdf": ".pdf",
    "text/html": ".html",
    "text/csv": ".csv",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def connect(db_path: str | Path) -> sqlite3.Connection:
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA_PATH.read_text())
    return conn


def _ext(content_type: str | None) -> str:
    ct = (content_type or "").split(";")[0].strip().lower()
    return _EXT_OVERRIDES.get(ct) or mimetypes.guess_extension(ct) or ".bin"


def _safe(part: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in part) or "unknown"


@dataclass
class SnapshotResult:
    snapshot_id: int
    archive_path: str
    sha256: str
    changed: bool        # False when identical to the previous snapshot of this source
    first_snapshot: bool


def upsert_source(conn: sqlite3.Connection, row: dict) -> None:
    conn.execute(
        """INSERT INTO source (source_id, jurisdiction, state, doc_type, title, url, status, critical, notes)
           VALUES (:source_id, :jurisdiction, :state, :doc_type, :title, :url, :status, :critical, :notes)
           ON CONFLICT(source_id) DO UPDATE SET jurisdiction=excluded.jurisdiction, state=excluded.state,
             doc_type=excluded.doc_type, title=excluded.title, url=excluded.url,
             status=excluded.status, critical=excluded.critical, notes=excluded.notes""",
        row,
    )
    conn.commit()


def latest_snapshot(conn: sqlite3.Connection, source_id: str, before_id: int | None = None):
    sql = "SELECT * FROM snapshot WHERE source_id=?"
    args: list = [source_id]
    if before_id is not None:
        sql += " AND snapshot_id<?"
        args.append(before_id)
    return conn.execute(sql + " ORDER BY snapshot_id DESC LIMIT 1", args).fetchone()


def store_snapshot(
    conn: sqlite3.Connection,
    archive_root: str | Path,
    *,
    source: dict,
    data: bytes,
    requested_url: str,
    final_url: str,
    content_type: str | None,
    http_status: int,
    retrieved_at: datetime | None = None,
    parent_source_id: str | None = None,
    run_id: str | None = None,
) -> SnapshotResult:
    retrieved_at = retrieved_at or utcnow()
    digest = sha256_bytes(data)
    rel = Path(_safe(source["state"])) / _safe(source["doc_type"]) / (
        f"{retrieved_at:%Y%m%d}_{digest[:8]}{_ext(content_type)}"
    )
    dest = Path(archive_root) / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not dest.exists():  # write-once
        dest.write_bytes(data)

    prev = latest_snapshot(conn, source["source_id"])
    changed = prev is None or prev["sha256"] != digest
    cur = conn.execute(
        """INSERT INTO snapshot (source_id, url, final_url, retrieved_at, sha256, content_type,
             byte_size, http_status, archive_path, is_duplicate, parent_source_id, doc_status, run_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (source["source_id"], requested_url, final_url, retrieved_at.isoformat(), digest, content_type,
         len(data), http_status, rel.as_posix(), 0 if changed else 1, parent_source_id,
         source.get("status", "unknown"), run_id),
    )
    conn.commit()
    return SnapshotResult(cur.lastrowid, rel.as_posix(), digest, changed, prev is None)


def record_failure(conn, source_id: str, url: str, attempts: int, error: str,
                   attempted_at: datetime | None = None, run_id: str | None = None) -> None:
    conn.execute(
        "INSERT INTO fetch_failure (source_id, url, attempted_at, attempts, error, run_id) VALUES (?,?,?,?,?,?)",
        (source_id, url, (attempted_at or utcnow()).isoformat(), attempts, error, run_id),
    )
    conn.commit()


def freshness(conn, source_id: str, critical: bool, limit_days: int, now: datetime | None = None) -> dict:
    """Stale flag per Section 9: last verified record is kept; critical sources past the limit block use."""
    now = now or utcnow()
    snap = latest_snapshot(conn, source_id)
    if snap is None:
        return {"source_id": source_id, "age_days": None, "stale": True, "blocks_recommendation": critical,
                "reason": "never retrieved"}
    age = (now - datetime.fromisoformat(snap["retrieved_at"])).days
    stale = age > limit_days
    return {"source_id": source_id, "age_days": age, "stale": stale,
            "blocks_recommendation": bool(critical and stale),
            "reason": f"last retrieved {age} days ago" if stale else "fresh"}


def start_run(conn, run_id: str, code_version: str | None = None) -> None:
    conn.execute("INSERT INTO run (run_id, started_at, code_version) VALUES (?,?,?)",
                 (run_id, utcnow().isoformat(), code_version))
    conn.commit()


def finish_run(conn, run_id: str) -> None:
    conn.execute("UPDATE run SET finished_at=? WHERE run_id=?", (utcnow().isoformat(), run_id))
    conn.commit()
