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

## Full collection pipeline

```bash
python run_all.py                      # fetch -> archive -> locate pages -> change report -> manifest
python run_all.py --only P6 P7 --follow-documents
```

Each run writes `outputs/runs/{yyyymmdd}_{runid}/` with `change_report.html` (changed source text, failed
retrievals, freshness, candidate pages with quotes), `change_report.json`, and `run_manifest.json`
(code version, settings, every snapshot hash).

- `src/extract/pdf_text.py`: page-level text (PDF/HTML/CSV); image-only pages are flagged for OCR.
- `src/extract/locate.py`: finds the pages most likely to hold fee, credit-cap, set-aside, deadline,
  eligibility and award-table rules using `config/locate_keywords.yaml`. Output is a *candidate* with a
  verbatim quote, never a rule; reviewers and extraction decide.
- `src/fetch/hud_allocators.py`: parses the archived HUD agency list into `data/reference/hud_allocators.csv`.
  Parser is untested against the live page; all rows are marked "needs verification".
- Refresh demo: `tests/test_refresh.py` runs the pipeline, edits a source (15% -> 12% fee), takes another
  source offline, reruns, and checks the report shows the diff, the failure, and the retained last-good copy.
