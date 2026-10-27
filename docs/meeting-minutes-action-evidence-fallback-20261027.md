# Preserve supplied action evidence when lexical fallback is unverified

Scope: `/meeting-minutes-agent` action evidence resolution. The correction changes
neither semantic merging nor ownership, commitment, timing or reviewer decisions.

## Reproduced failure

In the saved Eakin primary-2 response, an applicability-assessment action cites
T0371/T0380, in the late standards discussion. Normalisation replaces them with
T0184, an earlier battery-change/documentation passage, then removes the proposed
owner because the substituted evidence no longer names that person. Subsequent
near-twin borrowing can attach a different owner and contribute to apparently
repeated assessment rows.

Private replay confirmed `suppliedScore`, `suppliedAnchorScore` and `bestScore`
were all zero: no candidate passed the action-support check. The separate
`supportingRanked` fallback ignored that predicate and ranked lexical context.
Generic words such as “required” and “any” made the unrelated passage win.
This is an application remapping defect, independent of Microsoft generation.

## Bounded correction

When resolving an action, preserve valid supplied references **as uncertain** if:

- no window passes the action-support ranking; and
- lexical fallback would introduce a reference outside that supplied set.

Return zero support and the existing weak-evidence diagnostic. Existing
normalisation surfaces a review warning. This retains provenance; it does not
prove an action, owner, date or commitment. A genuinely supported alternative
still repairs the wrong workstream. Invalid IDs, absent-value checks, citation
caps, discussion resolution, reviewer-save preservation and final checks retain
their existing behaviour. Cases without valid supplied citations are unchanged.

## Evidence and regression checks

Synthetic guideline-assessment examples reproduced the same cross-topic
substitution without client-specific runtime rules or test snippets. Four new
regressions failed before the guard; all six new tests passed afterward.
The focused evidence/ownership/timing suite passed 314 tests.

Read-only review of 102 saved raw primary/recovery/salvage actions found six
changed resolutions: two Eakin assessments and four DITA candidates. All retained
their supplied provenance with uncertainty and remained present in normalisation.
The DITA changes avoid importing unrelated order-processing material or replacing
an assignment exchange with a noun-heavy invoice description.

Normalising each of the five already-published saved action registers gave
byte-identical results against the previous resolver: 52 actions in total. The
fix prevents the earlier error during fresh candidate processing; it does not
rewrite already-saved faulty citations.

## Limits

The two standards and their delivery/assessment instructions remain separate
unless source evidence proves otherwise. Retaining the proposed owner's original
witness is not proof that this person accepted the assessment. Ownership and
commitment still require the existing checks and human review where ambiguous.
No full fresh-generation improvement or reduction in duplicate rows is claimed
from this deterministic reproduction. The DITA Cody nomination limitation remains
open and is not changed by this correction.
