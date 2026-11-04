-- Source / retrieval records (Section 4 "Source and rule" subset needed for fetching).
-- Extracted rule values come later and must reference snapshot_id.

CREATE TABLE IF NOT EXISTS source (
    source_id    TEXT PRIMARY KEY,
    jurisdiction TEXT NOT NULL,
    state        TEXT NOT NULL,
    doc_type     TEXT NOT NULL,
    title        TEXT NOT NULL,
    url          TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'unknown',  -- draft | final | unknown
    critical     INTEGER NOT NULL DEFAULT 0,       -- fee/deadline/eligibility: freshness-limited
    notes        TEXT
);

-- One row per successful retrieval. Never updated or deleted: originals are preserved.
CREATE TABLE IF NOT EXISTS snapshot (
    snapshot_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id      TEXT NOT NULL REFERENCES source(source_id),
    url            TEXT NOT NULL,            -- URL requested (from the register)
    final_url      TEXT NOT NULL,
    retrieved_at   TEXT NOT NULL,            -- ISO-8601 UTC
    sha256         TEXT NOT NULL,
    content_type   TEXT,
    byte_size      INTEGER NOT NULL,
    http_status    INTEGER NOT NULL,
    archive_path   TEXT NOT NULL,            -- relative to archive root
    is_duplicate   INTEGER NOT NULL DEFAULT 0, -- same hash as previous snapshot
    parent_source_id TEXT,                   -- set when discovered via a landing page
    doc_status     TEXT NOT NULL DEFAULT 'unknown'  -- draft | final | unknown
);
CREATE INDEX IF NOT EXISTS ix_snapshot_source ON snapshot(source_id, retrieved_at);

-- Failed attempts, kept so reports can list failed retrievals and stale flags.
CREATE TABLE IF NOT EXISTS fetch_failure (
    failure_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id    TEXT NOT NULL REFERENCES source(source_id),
    url          TEXT NOT NULL,
    attempted_at TEXT NOT NULL,
    attempts     INTEGER NOT NULL,
    error        TEXT NOT NULL,
    manual_review_queued INTEGER NOT NULL DEFAULT 1
);

-- Documents found on landing pages. Candidates only; fetched when host is allowlisted.
CREATE TABLE IF NOT EXISTS discovered_link (
    link_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_source_id TEXT NOT NULL REFERENCES source(source_id),
    url          TEXT NOT NULL,
    link_text    TEXT,
    first_seen_at TEXT NOT NULL,
    UNIQUE(parent_source_id, url)
);
