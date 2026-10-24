# Discussion materiality and parent selection

This change is scoped to `/meeting-minutes-agent` discussion generation. Existing saved drafts are not migrated. Actions retain their existing prompt fields and judgement policy; unrelated legacy normalisation retains its compatibility behaviour.

Structured supporting results may remain untargeted. At the merged discussion handoff, `preserveUntargetedSupporting` prevents the normaliser from inventing a nearest-word parent, including zero-overlap assignments. Existing positive subject placement and lossless Needs filing remain responsible for unresolved context.

Referee discussion packets omit upstream `dispositionHint` and `priority` in both ordinary and subset-repair requests. The private ledger, candidate selection priorities, budgets, text and evidence are unchanged. Controlled identical-input experiments found that removing those fields changed three consequential updates from supporting to core in three repeated trials; published policy changes alone did not. Reference-only retained cores also omit those earlier classification hints. `discussionPolicyVersion` binds prompt/cache fingerprints to the versioned Microsoft policy manifest.

Reconstructed primaries use core-source citations. Supporting details retain their own citations. Explicit primary evidence is stamped from the selected approved core rather than inferred from previously donated support sources. The complete original ledger remains available; the existing evidence resolver can reject weak child references, which must not be silently restored onto an unrelated primary merely to keep aggregate counts equal.

A final, bounded task-only publication guard protects against the real-data regression exposed by independent classification. It files executable future assignments by known meeting participants, including reported task-only recaps when every clause satisfies the boundary. It preserves the complete record through the existing collector and preserves the model's raw core verdict. Publication accounting reports such a core as Needs filing, never successfully published. Mixed factual clauses, conditions, uncertain grammar, decisions, open questions and reviewer-owned topics/subtrees are protected. This is not an action extractor, semantic deduplicator or a blanket future-tense filter.

## Microsoft configuration

`config/meeting-minutes-discussion-materiality-policy.json` records exact, generic discussion-only replacements against the previously active referee policy. Apply the replacements only after verifying the expected source text and retain the old active configuration for rollback. Do not replace the input-variable decorator or the output schema. No model migration is included.

The policy separates independent materiality from parent suitability, permits empty supporting targets, documents reference-only repair cores, requires reassessment of discovery hints, recognises consequential actual states without requiring a decision, and retains the discussion/action boundary. Action policy and timing wording are preserved.

The anchored, standard and gap discovery prompts remain unchanged. Additional discovery edits, a placement-only resolver, broad semantic guards and a larger model are conditional follow-up work, not automatically enabled. Existing positive placement cannot prove every semantic relation, so uncertain material remains available for review.

## Validation and limits

Tests cover the actual batch merge → normalisation → reconstruction → compaction/retention handoff; ordinary/repair packet independence; preserved action fields; primary-versus-child citations; generic negative controls; reviewer locks; lossless task retention and honest publication accounting. Offline archive replay checks ten meeting snapshots without provider calls or library writes.

Provider validation must retain immutable per-call capture IDs and distinguish raw replies from transformed verdicts. Fixed-input comparisons precede fresh generation. Count useful visible claims, wrong attachments, repeated prose and manual filing effort; row totals alone are not accuracy measures. Preserve failures and unresolved publication states rather than declaring semantic correctness from complete candidate accounting.
