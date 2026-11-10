# Data dictionary: what collection produces

Everything is in `data/dl3.db` (SQLite). Files are in `archive/`. This page is the contract between
collection (fetch, extract, awards) and whoever builds gates, fees and scoring.

## What scoring may read

| Need | Read this | Rule |
|---|---|---|
| QAP rule values (fee, caps, set-asides, deadlines, eligibility, scoring criteria, credit availability) | `src.review.import_review.approved_values(conn, source_id=None)` | Returns only reviewer-approved findings, with the reviewer's correction applied as `approved_value`. Never read `extraction` rows with any other status. |
| Award history from spreadsheets | table `award_row` (latest snapshot per source) | Use `annual_credit` only. `credit_unlabeled`, `ten_year_credit`, `equity`, `credit_requested` are different things. Rows with `flags` need a person first. `credit_type = 'unknown'` or `award_year IS NULL` must stay unknown. |
| Award rows from PDF lists | `approved_values()` where `field = 'award_row'`; columns are in `row_json` | Same review rule as other extractions. |
| Is a source too old to rely on | `src.fetch.archive.freshness(conn, source_id, critical, limit_days)` | `blocks_recommendation = True` means a critical source is stale or missing. |
| Where a value came from | `snapshot` (join on `snapshot_id`) | URL, retrieval time, SHA-256, draft/final status, retrieval method. |
| What is still missing for a jurisdiction | `python -m src.report.coverage <IDs>` | Missing evidence is "unknown", never a pass. |

Values are stored as printed (`"15%"`, `"$2,000,000"`, `"February 1, 2027"`). Converting them to numbers
is the calculation code's job, in code, with the conversion tested.

A source belongs to a jurisdiction by ID prefix: `MI_QAP_CURRENT` belongs to `MI`.

## Tables

**source**: one row per registered source (from `config/source_register.csv`).
`source_id`, `jurisdiction`, `state`, `doc_type`, `title`, `url`, `status` (draft / final / unknown),
`critical`, `plan_year`, `adoption_date`, `effective_dates`, `amendment_date`, `superseded_by`.

**snapshot**: one row per retrieval; never updated or deleted.
`snapshot_id`, `source_id`, `url`, `final_url`, `retrieved_at` (UTC), `sha256`, `content_type`, `byte_size`,
`archive_path`, `is_duplicate` (same content as the previous retrieval), `doc_status`, `run_id`,
`retrieval_method` (http / browser / manual), `retrieved_by` and `import_note` (manual imports).

**fetch_failure**: failed retrievals. `source_id`, `url`, `attempted_at`, `attempts`, `error`,
`manual_review_queued`.

**candidate_page**: pages likely to hold each rule type (keyword match, not a fact).
`snapshot_id`, `topic`, `page`, `score`, `quote`.

**llm_call**: every extraction request. `topic`, `prompt_version`, `model_requested`, `model_served`,
`request_id`, `pages_sent`, `stop_reason`, token counts, `raw_output`, `error`.

**extraction**: one row per extracted value.
`source_id`, `topic`, `field`, `value`, `units`, `applies_to` (9% / 4% / both / unknown), `page`, `section`,
`quote`, `confidence` (the model's own label), `notes`, `row_json` (award rows), `doc_status`,
`quote_verified` (quote found word for word on the cited page), `value_in_quote` (numbers in the value appear
in the quote), `status`, `reviewer`, `reviewed_at`, `reviewer_value`, `review_note`.
Status values: `pending_review`, `rejected_validation` (quote not found; can never be approved),
`approved`, `rejected_by_reviewer`.

Topics and fields:
- `fee_rule`: developer_fee_max_percent, developer_fee_basis, developer_fee_dollar_cap, deferred_fee_max, fee_adjustments, other_fee_rule
- `unit_credit_caps`: max_annual_credit_per_project, max_credit_per_unit, max_units_per_project, min_units_per_project, credit_cap_per_sponsor, other_cap
- `set_asides`: set_aside, geographic_pool, nonprofit_set_aside, other_set_aside
- `deadlines`: application_deadline, preliminary_application_deadline, round_name, award_announcement_date, other_deadline
- `sponsor_eligibility`: experience_requirement, capacity_requirement, new_developer_path, joint_venture_rule, disqualification_rule, other_eligibility
- `scoring_criteria`: scoring_criterion, threshold_requirement, tiebreaker, local_support_requirement, minimum_score, other_selection_rule
- `credit_availability`: annual_credit_ceiling, credits_available_this_round, bond_volume_cap, bond_issuer, four_percent_process, four_percent_limit, other_availability
- `news_items`: award_announcement, construction_start_or_closing, project_completion, program_change, other_news
- `award_table`: field `award_row`

**extraction_not_found**: fields the model reported as not stated in the document. Evidence of absence only.

**award_sheet**: one row per spreadsheet sheet: `header_row`, `column_map` (which column became which
field), `unmapped`, `rows_parsed`, `rows_flagged`, `note`.

**award_row**: one row per project line.
`source_id`, `state`, `sheet_name`, `row_number` (the citation), `section`, `application_number`,
`project_name`, `sponsor`, `address`, `city`, `county`, `zip`, `total_units`, `restricted_units`,
`annual_credit`, `ten_year_credit`, `equity`, `credit_requested`, `credit_unlabeled`, `credit_type`,
`credit_type_basis`, `award_year`, `award_year_basis`, `award_date`, `set_aside`, `project_type`, `status`,
`score`, `raw_json` (all original cells), `flags`, `doc_status`.

**Inventory tables**: `crawl_page`, `inventory_candidate`, `crawl_status` feed
`data/inventory/state_inventory.xlsx`. They are candidates for the 50-state inventory, not inputs to scoring.

## Not collected

- Application counts, unless an award file lists unfunded applicants (then they are rows with their `status`).
  A missing application count means the award rate is unknown.
- Sponsor matching across years, geocoding and urban classification, competition statistics: not built.
- DL3 inputs (fee share, overhead, hurdle, execution capability, Venture Development scores): from DL3.
- Scanned PDF pages are read by OCR when Tesseract is installed (findings from them carry a validation note);
  without Tesseract they stay flagged and unread.
