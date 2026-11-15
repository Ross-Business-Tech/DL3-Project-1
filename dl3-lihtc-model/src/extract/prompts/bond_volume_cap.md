---
fields: [volume_cap_total, volume_cap_for_housing, volume_cap_allocated, volume_cap_requested, volume_cap_remaining, carryforward, oversubscription_statement, allocation_method, other_volume_cap]
---
Extract how much private activity bond volume cap exists and how much of it was used. Report the year each
figure is for in `notes`; a figure without its year is not usable.

- volume_cap_total: the state's total private activity bond volume cap (state ceiling) for a year.
- volume_cap_for_housing: the amount set aside or available for multifamily or residential rental housing.
- volume_cap_allocated: the amount actually allocated, awarded, or issued (say which) and to what category.
- volume_cap_requested: the total amount applicants requested.
- volume_cap_remaining: unallocated or unused cap remaining at a stated date.
- carryforward: carryforward amounts available or elected, and for what purpose.
- oversubscription_statement: any statement that requests exceeded the cap, that the cap was fully used, that
  a lottery, waiting list, or competitive scoring was used because of demand, or that cap went unused.
  Quote it exactly.
- allocation_method: how multifamily bond cap is awarded (first come, lottery, competitive round, set-aside).
- other_volume_cap: other statements about bond cap supply or demand.

Do not conclude whether the state is oversubscribed; report what the document states.
