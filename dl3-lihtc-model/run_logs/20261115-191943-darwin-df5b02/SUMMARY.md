# Run 20261115-191943-darwin-df5b02

Result: SOME COMMANDS FAILED

| # | command | exit code | seconds |
|---|---|---|---|
| 1 | `python run_all.py --awards` | 1 | 156.4 |
|   | last lines: Report: ~/Code/DL3-Project-1/dl3-lihtc-model/outputs/runs/20261115_b66d8d0b/change_report.html / Top MSAs: ERROR Expecting value: line 1 column 1 (char 0) / Awards: 231 rows from 7 files (191 flagged, 0 errors). Check: python -m src.awards.parse_awards --export | | |
| 2 | `python -m src.extract.extract --dry-run` | 0 | 1.6 |
|   | last lines:   }, /   "estimated_cost_usd": null / } | | |

## Outputs saved

- outputs/outputs/runs/20261115_b66d8d0b/change_report.json
- outputs/outputs/runs/20261115_b66d8d0b/run_manifest.json

## Environment

```json
{
  "python": "3.15.0",
  "os": "Darwin 27.0.0 arm64",
  "git_commit": "6b45999",
  "git_branch": "vijay",
  "uncommitted_files": [
    "M config/source_register.csv",
    " M data/inventory/state_inventory.csv",
    " M data/inventory/state_inventory.xlsx"
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
  "tesseract": "no",
  "env_vars_set (names only)": [
    "ANTHROPIC_API_KEY",
    "DL3_CONTACT"
  ]
}
```
