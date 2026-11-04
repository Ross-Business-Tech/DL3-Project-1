# DL3 LIHTC Opportunity Model

University of Michigan AI Sprint project for DL3 Realty. This folder holds the Python pipeline; the
web-app files in the repo root are unrelated template files.

## Step 1: scraping (fetch, archive, diff)

```bash
pip install -r requirements.txt
python -m src.fetch.fetch                       # fetch every source in config/source_register.csv
python -m src.fetch.fetch --only P6 P7          # just some sources
python -m src.fetch.fetch --follow-documents    # also fetch PDF/XLSX/DOCX links found on those pages
python -m pytest -q tests
```

- **Register:** `config/source_register.csv` lists each source (URL, doc type, draft/final status, critical flag).
  Only hosts in the register may be fetched; redirects off those hosts are refused.
- **Archive:** originals are stored write-once at `archive/{state}/{doc_type}/{yyyymmdd}_{hash8}.ext`;
  every retrieval is a row in `data/dl3.db` (`snapshot`) with URL, retrieval time, SHA-256, status.
- **Change detection:** `src/fetch/diff.py` compares the latest two different snapshots (visible text for HTML,
  page-tagged text for PDF) and reports changed source text only.
- **Failures:** bounded retries (2s/4s/8s), then a `fetch_failure` row queued for manual review; the last good
  snapshot stays. `archive.freshness()` flags sources older than `freshness_days` (90) and blocks critical ones.
- **Politeness:** robots.txt respected, 2s per-host gap, 50 MB cap, content-type allowlist, identifying
  User-Agent (set `DL3_CONTACT` in `.env`). Downloaded files are stored as data and never executed.
