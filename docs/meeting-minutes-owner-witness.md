# Complete source-owner witnesses

This bounded release changes the meeting-minutes semantic source checker, witness retrieval and final reconciliation through their existing shared `ownerWitness` helper. No identity aliases, inference, merge classes or runtime flags are added.

## Fixed defects

- The checker used only the first substring occurrence. For example, an earlier longer surname could make it miss a later complete owner name in the same passage. It now checks every occurrence with the existing exact normalized name requirement.
- Checking one UTF-16 code unit at a boundary could treat part of a supplementary Unicode letter as punctuation. Combining marks also need to remain part of a name token. Boundary checks now inspect Unicode letters, numbers and marks on both sides. Longer or attached names remain insufficient evidence.

Identity presence is still only a necessary witness. It does not establish assignment, acceptance or equivalence. Independent source support, full retention, dates, recipients, qualifications, reviewer keeps and recovery receipts continue to apply. Explicit unresolved verdicts remain vetoes.

## Qualification and limits

Regression cases exercise later valid mentions, false Unicode boundaries, independent-verdict refusal, the final reconciliation path and source-bound receipt validation. The wider meeting-minutes suite and frontend build are required before release.

A read-only comparison across all source units and final action owners in the saved fresh Abbott, DITA, Allotment, Eakin and Parking outputs found **4,142 comparisons and zero changed witnesses**. These fixes are proven checker corrections, not a claim of reduced duplication in those five outputs. No library draft, source passage, cache or Microsoft configuration is modified.

## Further root-cause findings

The same saved outputs retain 7 / 8 / 8 / 6 / 1 unresolved grouped-action materializations respectively. All 30 failures report `group_requires_atomic_action_mapping`. The protocol supplies context groups, not certified writable atomic actions; a positive group verdict cannot approve every child or transfer ownership/timing into it. Retrying the unchanged protocol cannot supply the missing mapping. The sparse-output fallback is additionally active in Abbott and must stay until separate obligations are accounted for.

Known attendee normalization and semantic ownership verification use different identity authorities. Existing attendee fallback can infer identity from a first name; that is not sufficient authority for deleting a duplicate action. A safe next batch must capture exact registered speaker-to-owner mappings, reject collisions, preserve raw source labels and bind the mapping to the checked packet/receipt. No new person-specific substitutions should be introduced.

Before changing grouped-action handling, specify an explicit atomic mapping contract, validate every child and source reference, distinguish separate work from covered work, preserve unresolved siblings and test against the 30 saved failures. No group-wide approval shortcut is enabled here.
