# How collection reaches the website

The website (branch `hugo`, `src/ranking/`) is a static site on here.now: HTML and JavaScript that run in the
visitor's browser. There is no server. That means:

- **The scraping pipeline cannot run on the website.** It needs Python, a headless browser, a database and API
  keys, none of which exist in a visitor's browser. It runs on a person's computer or in GitHub Actions
  (`.github/workflows/pipeline.yml`, see `refresh_instructions.md`), which keeps its database in the here.now
  Drive and opens a pull request with the refreshed files.
- **The website reads files.** After a run, `python -m src.report.export_web --site` writes `data/web/` and copies
  it into the website (`src/ranking/data/pipeline/` and `src/ranking/data/inventory.csv`). Then `npm test`,
  `npm run build`, commit, and open a pull request into `development`. The site shows it on each state's card
  under "From the data pipeline" (`src/ranking/loadPipeline.js`).

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

- **Who refreshes.** Anyone with access to the repository's Actions tab can run "DL3 data pipeline"; a person
  still reviews and merges the pull request it opens. A schedule could be added to the workflow later.
- **Login.** Signing in is a feature of the hosting, not of these files. The repository is public, so anything
  committed here can be read by anyone, whatever the site's login does. Only public agency information is
  exported. DL3's confidential inputs (fee share, overhead, hurdle, deal files) must not be committed.
- **LLM key.** `GEMINI_API_KEY` stays on the computer that runs the pipeline, or in a GitHub secret. It is never
  needed by the website, and the workflow's website build step has no secrets at all.

## Running the pipeline from the website

The "Run pipeline" page starts the GitHub workflow and shows its progress; new results load on every page when it
finishes. How it fits together:

```
browser --(sealed API keys, states)--> here.now proxy (adds DL3_GITHUB_TOKEN) --> GitHub workflow_dispatch
GitHub job: unseal keys -> state_store pull -> run_all.py --states ... -> export_web -> state_store push + publish-web
browser <-- here.now proxy (adds DL3_DRIVE_READ_TOKEN) <-- here.now Drive dl3-pipeline/web/*  (newest results)
```

One-time setup (in this order):

1. **Key pair for API keys.** In `dl3-lihtc-model/`: `python -m src.run_keys new-keypair`. Commit the public key it
   writes to `public/pipeline-key.json`. Paste the private key file into the GitHub secret `PIPELINE_KEY_PRIVATE`,
   then delete the file.
2. **Drive.** Seed it and make the job's token (see `refresh_instructions.md`, "Running it in GitHub"), then
   `python -m src.state_store make-token --site` for a READ-ONLY token limited to the published results.
3. **here.now variables** (the instructor adds them on the account that owns the site: the workspace for the public
   site, and the account hosting the dev site), each with allowed upstream as shown:
   - `DL3_GITHUB_TOKEN`: a fine-grained GitHub token for this repository only, permission "Actions: read and write".
     Allowed upstream `api.github.com`.
   - `DL3_DRIVE_READ_TOKEN`: the token from `make-token --site`. Allowed upstream `here.now`.
4. If the Drive belongs to a different here.now account, change the drive id in `public/.herenow/proxy.json`
   (`make-token` prints it; it is not a secret).

Security notes: the GitHub token never reaches the browser. Anyone who can open the site can start a run, so the
site should be restricted to DL3 staff in here.now's access settings (Specific emails or domains). DL3's
confidential inputs never leave the browser, so the proxy never sees them.
