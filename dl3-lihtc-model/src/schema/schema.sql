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
    notes        TEXT,
    plan_year    TEXT,   -- e.g. 2027-2028; filled by a reviewer, never guessed
    adoption_date TEXT,
    effective_dates TEXT,
    amendment_date TEXT,
    superseded_by TEXT   -- source_id of the replacing source
);

-- One row per successful retrieval. Never updated or deleted: originals are preserved.
CREATE TABLE IF NOT EXISTS run (
    run_id       TEXT PRIMARY KEY,
    started_at   TEXT NOT NULL,
    finished_at  TEXT,
    code_version TEXT
);

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
    doc_status     TEXT NOT NULL DEFAULT 'unknown',  -- draft | final | unknown
    run_id         TEXT
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
    manual_review_queued INTEGER NOT NULL DEFAULT 1,
    run_id       TEXT
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

-- Pages in archived documents likely to contain a rule. Candidates for extraction/review, not facts.
CREATE TABLE IF NOT EXISTS candidate_page (
    snapshot_id  INTEGER NOT NULL REFERENCES snapshot(snapshot_id),
    topic        TEXT NOT NULL,
    page         INTEGER NOT NULL,       -- 1-based; HTML documents use page 1
    score        INTEGER NOT NULL,
    quote        TEXT NOT NULL,          -- verbatim excerpt from the page
    PRIMARY KEY (snapshot_id, topic, page)
);

-- Inventory discovery (50-state). Every candidate keeps where and when it was found.
CREATE TABLE IF NOT EXISTS crawl_page (
    run_id          TEXT NOT NULL,
    jurisdiction_id TEXT NOT NULL,
    url             TEXT NOT NULL,
    final_url       TEXT NOT NULL,
    title           TEXT,
    sha256          TEXT NOT NULL,
    depth           INTEGER NOT NULL,
    retrieved_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_crawl_page ON crawl_page(jurisdiction_id, run_id);

CREATE TABLE IF NOT EXISTS inventory_candidate (
    run_id          TEXT NOT NULL,
    jurisdiction_id TEXT NOT NULL,
    category        TEXT NOT NULL,   -- qap | award_list | underwriting | application | lihtc_program | bond_program
    url             TEXT NOT NULL,
    link_text       TEXT,
    kind            TEXT NOT NULL,   -- page | document
    file_format     TEXT,            -- pdf | xlsx | html ...
    found_on_url    TEXT NOT NULL,
    found_on_sha256 TEXT,
    score           INTEGER NOT NULL,
    years           TEXT,            -- years named in link text / file name, comma-separated
    draft_marker    INTEGER NOT NULL DEFAULT 0,
    offsite         INTEGER NOT NULL DEFAULT 0,
    depth           INTEGER NOT NULL,
    retrieved_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_inv_cand ON inventory_candidate(jurisdiction_id, run_id);

CREATE TABLE IF NOT EXISTS crawl_status (
    run_id          TEXT NOT NULL,
    jurisdiction_id TEXT NOT NULL,
    pages_fetched   INTEGER NOT NULL,
    errors          INTEGER NOT NULL,
    first_error     TEXT,
    finished_at     TEXT NOT NULL,
    PRIMARY KEY (run_id, jurisdiction_id)
);
