---
kind: table
---
Extract every project row from the award, reservation, or allocation tables in the document.

For each row give the values as printed; use an empty string for a column the table does not have.
- `quote`: the row's text copied exactly from the page (enough to identify the row, including the credit amount).
- `annual_credit_amount`: the annual credit amount as printed. If the table shows only a ten-year total or
  equity amount, leave this empty and put that figure and its label in notes.
- `credit_type`: "9%", "4%", "other", or "unknown" if the table does not say.
- `status`: what the table says happened (reserved, awarded, carryover, waitlisted, withdrawn ...) as printed.
Do not add rows that are not in the document, and do not total anything.
