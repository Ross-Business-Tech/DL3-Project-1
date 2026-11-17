---
fields: [developer_fee_max_percent, developer_fee_basis, developer_fee_dollar_cap, deferred_fee_max, fee_adjustments, other_fee_rule]
---
Extract the developer fee rules.

- developer_fee_max_percent: the maximum developer fee as a percentage.
- developer_fee_basis: exactly what the percentage is applied to (for example "total development cost
  excluding land, reserves and developer fee", or "eligible basis"). Quote the definition precisely;
  the denominator is the most important detail in this extraction.
- developer_fee_dollar_cap: any maximum dollar amount for the fee.
- deferred_fee_max: limits on how much of the fee may be deferred, and over what period.
- fee_adjustments: increases or reductions (by project size, acquisition/rehab, scattered site, 4% vs 9%,
  identity of interest, consultant fees counted inside the fee).
- other_fee_rule: any other rule that changes how much fee a developer can earn or when it is paid.
