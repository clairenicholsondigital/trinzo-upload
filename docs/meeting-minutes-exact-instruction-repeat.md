# Exact instructions with unresolved timing labels

This bounded action-only contract nominates two identical instructions with the
same explicit owner, source references and timing wording, where unresolved
`target` and `deadline` labels differ. It selects the existing target record;
it never upgrades timing, generates new wording or treats matching text as proof.

New generations opt in with
`MEETING_MINUTES_AGENT_EXACT_INSTRUCTION_REPEAT_V1=1`, alongside
`MEETING_MINUTES_AGENT_CONTAINED_REQUIREMENTS_V1=1`. The policy snapshot pins the
option; existing generations without it retain their previous behaviour. The
option is off by default and is not enabled by this change.

At most one exact-instruction pair uses spare capacity after existing classes.
The existing overall pair and time caps remain unchanged. Source and independent
challenge must both prove the same obligation and occurrence, supported ownership,
and retention of every facet in the unchanged survivor. A component-only verdict,
uncertainty, missing evidence, stale proof, capacity limit or provider failure
preserves both rows. This does not address general paraphrases or umbrella actions.

All warning IDs and active rejected dates/wordings remain with the survivor.
Existing hash-bound receipts retain both complete originals and timing decisions
in their lineage. The existing restore-separate-actions workflow uses that private
history; normal public responses continue to omit it. No database migration or
rewrite of saved drafts is required.

The accompanying preservation correction recognises an unchanged full approved
record before attempting to enrich another variant. It does not rely on raw model
IDs, and retains the existing semantic survival guard and genuine enrichment path.

Regression coverage: `meeting-minutes-exact-instruction-repeat.test.js`,
`meeting-minutes-variant-reconciliation.test.js`, and the existing qualified-repeat,
contained-requirement, timing, identity and semantic-stage safety suites. Synthetic
provider fixtures prove contract behaviour, not real transcript equivalence.
Saved-generation source validation and independent fresh-run comparisons are
required before claiming visible duplicate reduction or enabling the option live.
