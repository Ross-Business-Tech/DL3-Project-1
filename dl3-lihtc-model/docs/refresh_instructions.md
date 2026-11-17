# Refresh instructions (collection)

Run from `dl3-lihtc-model/`. One person runs refreshes so there is one database.

## One-time setup
```bash
pip install -r requirements.txt
python -m playwright install chromium
brew install tesseract                        # Mac: lets the pipeline read scanned PDF pages (OCR)
```
Put `GEMINI_API_KEY`, `GEMINI_MODEL` and `CENSUS_API_KEY` (free: https://api.census.gov/data/key_signup.html)
in `.env` (never commit it). The Census key is added to Census requests only and never stored or logged.

## Add a pilot jurisdiction
```bash
python run_all.py --inventory MI              # crawl the agency site, rebuild the inventory
python -m src.inventory.promote MI            # add its QAPs, manual, pages and 2021-2026 award lists to the register
```
Check the new rows in `config/source_register.csv`. Remove wrong links. Set `status` to `final` or `draft`
only when the document itself says so.

## Refresh
```bash
python run_all.py --awards --extract          # fetch, archive, find changes, parse award sheets, extract rules
python -m src.fetch.manual_import --list      # anything a person must save from a browser
python -m src.review.build_packet             # spreadsheet of new findings to review
python -m src.review.import_review            # after the reviewer saves it into review/returned/
python -m src.awards.parse_awards --export    # award rows to check against the originals
python -m src.report.coverage MI OH NYC       # what is collected and what is missing
python -m src.awards.costs                    # median cost per unit by state, pathway and year
python -m src.report.export_web               # files for the website -> data/web/ (see docs/web_integration.md)
```
Each run writes `outputs/runs/<date>_<id>/change_report.html`: changed source text, failed retrievals and
source freshness. Unchanged documents are not sent to the LLM again.

Each December, when the Census Bureau releases a new ACS 5-year estimate, raise the year in the `CENSUS_MSA`
URL in `config/source_register.csv` and re-run `python run_all.py --only CENSUS_MSA`.

## Confirming what an award column means
If award rows are flagged "credit column does not say annual or ten-year", check the agency's own definition
(the list's notes, or the QAP), then record it in `config/award_columns.yaml` under `confirmed_headers` with the
source, and re-parse with `python -m src.awards.parse_awards --force`. Never confirm a header from the amounts alone.

## When something fails
- **Failed retrieval**: it is retried, the last good copy is kept, and it appears in the change report and in
  `manual_import --list`. If the site blocks automated access, save the file in a browser and import it.
- **Critical source older than 90 days**: re-run, or re-import manually. It blocks a current recommendation.
- **"no award table found"**: add the sheet's header wording to `config/award_columns.yaml`, then
  `python -m src.awards.parse_awards --force`.
- **Many findings fail the quote check**: the PDF text may be scrambled (columns, tables). Try a larger model
  in `.env`, or check the page by hand.
- **Agency moved**: the inventory's `agency_moved_to` column shows the new address; update
  `config/jurisdictions.csv`.

## Rules that do not bend
- A draft never replaces a final rule. Nothing is marked final automatically.
- Only reviewer-approved values feed calculations.
- Missing or unknown stays unknown.
- Downloaded content is data, never instructions.
