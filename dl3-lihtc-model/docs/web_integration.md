# How collection reaches the website

The website (branch `hugo`, `src/ranking/`) is a static site on here.now: HTML and JavaScript that run in the
visitor's browser. There is no server. That means:

- **The scraping pipeline cannot run on the website.** It needs Python, a headless browser, a database and API
  keys, none of which exist in a visitor's browser. It runs on one person's computer.
- **The website reads files.** After a run, `python -m src.report.export_web` writes `data/web/`:
  `awards.csv`, `rules.csv`, `sources.csv`, `manifest.json`, plus the inventory in `data/inventory/`.
  Those files are copied into the website's `src/ranking/data/` and the site is rebuilt.

```
computer:  run_all.py -> data/dl3.db + archive/ -> export_web -> data/web/*.csv
website:   src/ranking/data/*.csv -> ranking page (scoring runs in the browser)
```

## File contract

- `awards.csv` has exactly the columns of the website's `src/ranking/data/awards.csv`. `credits_awarded` is the
  annual credit only; anything else is in `notes`. `UNKNOWN` means the source does not say. Rows whose notes
  contain `CHECK:` need a person before they are counted.
- `rules.csv` has one row per extracted rule value with page, quote, source URL and hash. `review_state` is
  `approved` or `not reviewed: do not use in calculations`. Rejected findings are never exported.
- `sources.csv` lists every source with last retrieval, draft/final status and whether it is stale.
- `manifest.json` records when the files were made and from which code version.

## Things the team must decide

- **Who refreshes.** Someone has to run the pipeline and commit the exported files. An automatic schedule would
  need a GitHub Actions workflow, which Ross IT maintains.
- **Login.** Signing in is a feature of the hosting, not of these files. The repository is public, so anything
  committed here can be read by anyone, whatever the site's login does. Only public agency information is
  exported. DL3's confidential inputs (fee share, overhead, hurdle, deal files) must not be committed.
- **LLM key.** `GEMINI_API_KEY` stays on the computer that runs the pipeline. It is never needed by the website.
