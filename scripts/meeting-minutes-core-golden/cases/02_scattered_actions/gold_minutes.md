# GOLD MINUTES — Rogue #2: Scattered actions

**Meeting:** Hartwell site catch-up
**Date:** 10 August 2026
**Location:** Microsoft Teams
**Meeting type:** Internal
**Attendees:** Marcus Bell, Aisha Rahman, Deniz Yilmaz, Fern Whitlock
**Internal / Client split:** All four are internal team members. No client attendees.

## Executive summary
Short internal status catch-up on the Hartwell website. Staging is currently
broken because it points at the old database; that fix was taken on. A caching
fix was reported as already live. The team decided on the simpler dropdown
navigation over the mega-menu. A revised client quote and a rewrite of the
onboarding emails were taken on, and an expiring SSL certificate was flagged as
a risk with renewal actioned.

## Key discussion points
- **Staging environment broken.** Login throws an error because the environment
  variables still point at the old database; treated as a quick fix.
- **Caching fix already live** (reported as completed — not an outstanding action).
- **Old feature branches** — loose "at some point" intention, no owner or date;
  explicitly deferred ("not today"). Not an action.
- **Navigation decision** — mega-menu tested badly on mobile; team chose the
  simple dropdown.
- **Bellamy's revised quote** — client chasing after two extra pages were added.
- **Analytics dashboard** — raised only as a possibility "if we've got time";
  parked to a future sprint. Not an action.
- **Onboarding emails** — client disliked the robotic tone; rewrite taken on.
- **SSL certificate risk** — expires end of month; lapse would put the site into
  a "not secure" state mid-campaign.

## Decisions
- Adopt the simple dropdown navigation (option B) over the mega-menu.

## Risks
- SSL certificate expires at the end of the month; if it lapses the site shows a
  not-secure warning. Mitigated by the renewal action below.

## Actions
| Owner | Action | Due (evidence) |
|---|---|---|
| Aisha Rahman | Fix the staging config (swap the connection string to the correct database) | After lunch / today |
| Marcus Bell | Send the revised quote to Bellamy's | End of play Thursday |
| Deniz Yilmaz | Rewrite the onboarding email and put it in the shared folder for review | No date stated |
| Fern Whitlock | Call the hosting provider to renew the SSL certificate | Tomorrow morning |

**Not actions (must not appear in the table):** the caching fix (already done),
tidying old feature branches (vague, deferred), the analytics dashboard (parked
possibility).
