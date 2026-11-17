---
fields: [scoring_criterion, threshold_requirement, tiebreaker, local_support_requirement, minimum_score, other_selection_rule]
---
Extract how applications are selected for 9% credits (and for 4% credits if the document scores them).

- scoring_criterion: each scored category with its maximum points (one finding each). Put the category name
  and points in `value` (for example "Location near transit: up to 10 points").
- threshold_requirement: pass/fail requirements an application must meet before it is scored.
- tiebreaker: how ties between equal scores are broken, in the order stated.
- local_support_requirement: any required or scored local government approval, notification, contribution,
  or letter of support. Quote exactly what is required; do not characterise it as a veto.
- minimum_score: any minimum total score needed to be eligible for an award.
- other_selection_rule: any other rule deciding which applications are funded (state it in notes).
