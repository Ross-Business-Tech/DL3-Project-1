# Run 20261115-201155-darwin-df5b02

Result: all commands succeeded

| # | command | exit code | seconds |
|---|---|---|---|
| 1 | `~/Code/DL3-Project-1/.venv/bin/python run_all.py --awards --extract` | 0 | 170.0 |
|   | last lines:   rejected   44 x quote not found verbatim on page N -> words are on the page in order with text between (table or columns) /   rejected   27 x quote not found verbatim on page N -> quote is on a different page / Review packet: python -m src.review.build_packet | | |
| 2 | `~/Code/DL3-Project-1/.venv/bin/python -m src.awards.costs` | 0 | 0.0 |
|   | last lines: OH 9% 2025: median $289,165/unit from 23 of 23 projects / Wrote ~/Code/DL3-Project-1/dl3-lihtc-model/outputs/awards/cost_per_unit.csv | | |
| 3 | `~/Code/DL3-Project-1/.venv/bin/python -m src.report.coverage MI OH IN` | 0 | 0.2 |
|   | last lines:   [ ] awards 2026                            PDF: 8 to review  <- PDF rows waiting for review /   [ ] award rows with total development cost 0  <- no cost data in award lists: use the QAP cost limits or application lists / Wrote ~/Code/DL3-Project-1/dl3-lihtc-model/outputs/coverage/coverage.csv | | |
| 4 | `~/Code/DL3-Project-1/.venv/bin/python -m src.report.export_web` | 0 | 0.1 |
|   | last lines: Wrote ~/Code/DL3-Project-1/dl3-lihtc-model/data/web: {'awards': 169, 'awards_pending_review': 434, 'rules': 164, 'sources': 71, 'cost_per_unit': 6, 'top_msas': 100, 'states_in_top_msas': 52} (0 rules approved) | | |

## Outputs saved

- outputs/data/web/awards.csv
- outputs/data/web/awards_pending_review.csv
- outputs/data/web/cost_per_unit.csv
- outputs/data/web/manifest.json
- outputs/data/web/rules.csv
- outputs/data/web/sources.csv
- outputs/data/web/states_in_top_msas.csv
- outputs/data/web/top_msas.csv
- outputs/outputs/awards/award_rows.csv
- outputs/outputs/awards/cost_per_unit.csv
- outputs/outputs/coverage/coverage.csv
- outputs/outputs/extract/rejected.csv
- outputs/outputs/runs/20261115_4535945e/change_report.json
- outputs/outputs/runs/20261115_4535945e/run_manifest.json

## Environment

```json
{
  "python": "3.15.0",
  "os": "Darwin 27.0.0 arm64",
  "git_commit": "9076808",
  "git_branch": "vijay",
  "uncommitted_files": [
    "M config/award_columns.yaml",
    " M config/source_register.csv",
    " M data/inventory/state_inventory.csv",
    " M data/inventory/state_inventory.xlsx",
    "?? data/reference/",
    "?? data/web/"
  ],
  "packages": {
    "requests": "2.34.2",
    "beautifulsoup4": "4.15.0",
    "pymupdf": "1.28.2",
    "openpyxl": "3.1.5",
    "xlrd": "2.0.2",
    "playwright": "1.64.1",
    "google-genai": "3.1.0",
    "anthropic": "2.8.0",
    "truststore": "0.10.5",
    "pytest": "9.2.0"
  },
  "tesseract": "yes",
  "env_vars_set (names only)": [
    "ANTHROPIC_API_KEY",
    "DL3_CONTACT"
  ]
}
```
