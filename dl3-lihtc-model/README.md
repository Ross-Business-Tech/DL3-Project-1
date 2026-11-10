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

## 50-state inventory

One-time setup for the browser fallback (needed for HUD's list and some agency sites):

```bash
pip install -r requirements.txt
python -m playwright install chromium
```

```bash
python run_all.py --inventory            # fetch register sources (incl. HUD list), crawl every agency, build inventory
python run_all.py --inventory MI CHI     # just some jurisdictions
python -m src.inventory.build            # rebuild the spreadsheet only (e.g. after editing overrides)
```

Output: `data/inventory/state_inventory.xlsx` (sheets: Inventory, Candidates, HUD list, Read me) and `.csv`.

- `config/jurisdictions.csv`: the 50 states plus DC, PR, USVI and the Chicago and NYC sub-allocators. Agency names
  and homepages are a seed list (unverified); each is checked against HUD's allocating-agency list (P1).
- `src/inventory/crawl.py`: a focused, polite crawl of each agency site (30 pages, depth 3, same site, 8 sites in
  parallel) that records candidate QAP pages and documents, award lists, underwriting manuals, application
  rounds and bond programs, with the link text, the page it was found on, that page's hash and the time.
  Keyword rules live in `config/inventory_keywords.yaml`.
- Auto-found values are candidates. A QAP is never marked final automatically; deadlines and the light-screen
  fee/credit caps stay "needs verification".
- To confirm a value, add a row to `config/inventory_overrides.csv` (jurisdiction_id, field, value, source_url,
  reviewer, reviewed_on) and rebuild. Reviewed values always win, and a row becomes "verified" only when every
  key field has been reviewed.

### How failures are handled (from the first real run, 2026-11-08)

- **robots.txt** follows RFC 9309: a site that refuses to serve robots.txt (4xx) has no rules; a server error
  means stay out. A real "Disallow" is always respected, including by the browser fallback; the error says which.
- **Bot-check pages** (HUD's HTTP 202, "checking your browser") and **incomplete TLS certificate chains**
  (ilga.gov, dca.ga.gov) are retried once in headless Chromium. TLS is also checked with the operating
  system's certificate store (`truststore`). Certificate checking is never turned off.
- **JavaScript-built homepages** (almost no links in the HTML) are re-read in the browser.
- **Agencies that moved**: if a homepage redirects to a new site, the crawl follows it and reports the new
  address in `agency_moved_to` so `config/jurisdictions.csv` can be updated.
- **States that don't say "QAP"** get aliases in `jurisdictions.csv` (`qap_aliases`): CA "TCAC Regulations",
  WA "Tax Credit Policies", AK "GOAL".
- **Choosing the QAP**: newsletters, videos and workshop recordings are never chosen; notices, redlines,
  appendices and comment files are listed after the plan as "[related document]"; plan years come from the
  range in the title. `qap_current_nondraft_url` shows the newest plan not marked draft, so a draft never hides
  the rule in force.
- Snapshots record `retrieval_method` (http / browser) for provenance.

## Rule extraction with an LLM (Gemini by default)

The provider is set in `config/settings.yaml` (`llm.provider: gemini`); the key and model come from `.env`
(`GEMINI_API_KEY`, `GEMINI_MODEL`; the pipeline reads `dl3-lihtc-model/.env` and the repository-root `.env`).
Claude is available with `llm.provider: anthropic` (or `LLM_PROVIDER=anthropic`) and `ANTHROPIC_API_KEY`.

```bash
python -m src.inventory.promote MI OH NYC          # add pilot QAPs, manuals, award lists to the register
python run_all.py --only MI_QAP_CURRENT MI_UW      # download and archive them
python -m src.extract.extract --dry-run            # see what would be sent and a rough cost; no API calls
python -m src.extract.extract                      # extract (or: python run_all.py --extract)
python -m src.review.build_packet                  # review/packets/review_<date>.xlsx
# reviewer fills decision / reviewer / corrected_value, saves to review/returned/
python -m src.review.import_review
```

- Prompts: `src/extract/prompts/` (fee rules, credit and unit caps, set-asides, deadlines, sponsor eligibility,
  award tables). Which run on which document type: `config/settings.yaml` -> `llm.topics_by_doc_type`.
- JSON-schema structured output for both providers. The document is placed first and identical for every topic,
  so repeated topics on the same document hit the provider's prompt cache (Gemini implicit caching; Claude
  `cache_control`). Claude also uses effort `high` and server-side refusal fallback.
- Gemini can stop with `RECITATION` when an answer repeats document text; quotes are required, so that call is
  logged as an error (never half-parsed) and can be retried with `--force` or sent to the other provider.
- Cost: Gemini prices are not filled in (`llm.price_per_mtok.gemini: null`), so runs report token counts;
  add prices from Google's pricing page to get dollar estimates.
- **Code checks every answer**: the cited page must be one that was sent and the quote must appear verbatim on
  it, or the finding is stored as `rejected_validation` and can never be approved. Numbers in the value that
  are not in the quote are flagged for the reviewer.
- Every request is logged in `llm_call` (prompt version, model requested/served, request id, pages sent,
  tokens, raw output). Results are reused when the document, prompt and model are unchanged, so reruns are free
  and reproducible.
- Only `approved` findings (named reviewer) are available to calculations: `src.review.import_review.approved_values()`.
  Draft documents keep `doc_status = draft` on every finding.
- Spreadsheets (award lists in .xlsx) are not sent to the LLM; they are parsed in code (next step).

## Manual import (sites that do not allow automated access)

Some agency sites ask crawlers to stay out (robots.txt) or block them. A person can still open the page in a
normal browser, save the file, and import it with the same record-keeping as a download:

```bash
python -m src.fetch.manual_import --list          # what is waiting for a person

# a new document (adds a manual source to config/source_register.csv)
python -m src.fetch.manual_import ~/Downloads/2026-QAP.pdf \
    --url https://housing.nv.gov/.../2026-QAP.pdf \
    --jurisdiction NV --doc-type qap_doc --title "Nevada 2026 QAP" --by "Your Name"

# a new version of an existing source
python -m src.fetch.manual_import ~/Downloads/2026-QAP-amended.pdf --source-id <ID> --by "Your Name"
```

- Same checks as a download: allowed file types, content must match the type, size cap, bot-check pages refused.
- Recorded on the snapshot: SHA-256, the URL it came from, date (`--retrieved-on`, default today),
  `retrieval_method = manual`, who saved it (`--by`) and the original file name. The name is kept in the local
  database only, never in the committed register.
- The URL must be on the agency's own website unless `--third-party-host` is given (then the register notes it).
- Status defaults to `unknown`; pass `--status final` or `draft` only when the document itself says so.
- Manual sources (`retrieval = manual` in the register) are skipped by `run_all.py`, so they do not fail on
  every run; they still appear in the freshness table and go stale after 90 days like any other source.
- The inventory spreadsheet is rebuilt: the jurisdiction's row shows the imported document marked
  "[manual import]" with status "manual import: needs review". Importing never marks a QAP final or the row verified.
- After import the file is compared with the previous version and scanned for candidate rule pages; then run
  `python -m src.extract.extract --only <ID>`.
