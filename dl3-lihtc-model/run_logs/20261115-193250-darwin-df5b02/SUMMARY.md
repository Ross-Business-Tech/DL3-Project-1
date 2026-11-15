# Run 20261115-193250-darwin-df5b02

Result: all commands succeeded

| # | command | exit code | seconds |
|---|---|---|---|
| 1 | `~/Code/DL3-Project-1/.venv/bin/python run_all.py --awards --extract` | 0 | 327.0 |
|   | last lines:   flagged   22 x no credit amount on this row / Extraction: 26 calls (78 reused), 139 findings for review, 1 rejected by validation, 0 errors (gemini gemini-3.5-flash-lite; tokens {'input_tokens': 128105, 'output_tokens': 41773, 'cache_read_tokens': 0}) / Review packet: python -m src.review.build_pa | | |
| 2 | `~/Code/DL3-Project-1/.venv/bin/python -m src.awards.costs` | 0 | 0.0 |
|   | last lines: OH 9% 2024: median $115,985/unit from 10 of 34 projects / OH 9% 2025: median $274,309/unit from 33 of 33 projects / Wrote ~/Code/DL3-Project-1/dl3-lihtc-model/outputs/awards/cost_per_unit.csv | | |
| 3 | `~/Code/DL3-Project-1/.venv/bin/python -m src.report.coverage MI OH IN` | 0 | 0.1 |
|   | last lines:   [ ] awards 2026                            0 rows  <- no spreadsheet rows for this year (121 PDF rows not yet assigned a year) /   [ ] award rows with total development cost 0  <- no cost data in award lists: use the QAP cost limits or application lists / Wrote ~/Code/DL3-Project-1/dl3-lihtc-model | | |
| 4 | `~/Code/DL3-Project-1/.venv/bin/python -m src.report.export_web` | 0 | 0.1 |
|   | last lines: Wrote ~/Code/DL3-Project-1/dl3-lihtc-model/data/web: {'awards': 231, 'rules': 80, 'sources': 78, 'cost_per_unit': 8} (0 rules approved) | | |

## Outputs saved

- outputs/data/web/awards.csv
- outputs/data/web/cost_per_unit.csv
- outputs/data/web/manifest.json
- outputs/data/web/rules.csv
- outputs/data/web/sources.csv
- outputs/outputs/awards/award_rows.csv
- outputs/outputs/awards/cost_per_unit.csv
- outputs/outputs/coverage/coverage.csv
- outputs/outputs/runs/20261115_5e323bb5/change_report.json
- outputs/outputs/runs/20261115_5e323bb5/run_manifest.json

## Environment

```json
{
  "python": "3.15.0",
  "os": "Darwin 27.0.0 arm64",
  "git_commit": "db8ecc9",
  "git_branch": "vijay",
  "uncommitted_files": [
    "M config/source_register.csv",
    " M data/inventory/state_inventory.csv",
    " M data/inventory/state_inventory.xlsx",
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
