---
fields: [award_announcement, construction_start_or_closing, project_completion, program_change, other_news]
---
Extract news items about affordable housing tax credit activity from this page. One finding per item.

- award_announcement: tax credit awards or reservations announced.
- construction_start_or_closing: a groundbreaking, construction start, or financing closing for a project.
- project_completion: a grand opening or placed-in-service announcement.
- program_change: a change to the QAP, fees, deadlines, funding, or rules.
- other_news: other items about LIHTC developments or developers.

For each: `value` is the headline exactly as printed. `quote` is the headline or sentence as printed on the page.
In `notes` give, only if stated: the publication date, the event date, the project name, and the developer.
Use `units` "" and `applies_to` "unknown" unless the item states 9% or 4%. Skip items unrelated to tax credit
housing (homebuyer programs, staff announcements, general agency news).
