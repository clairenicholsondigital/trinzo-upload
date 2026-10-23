# Bounded discussion fidelity fixes

Scope: `/meeting-minutes-agent` generated discussion corrections and their review flags. No Microsoft configuration, model calls, deletion/merging rules, source resolver thresholds or citation limits change.

## Behaviour

The ordinary fidelity checker already verifies problem/evidence quotes and overall source overlap. Those checks do not prove each new proposition. A real saved correction added a planned follow-up although its source only offered one. The new narrow veto examines changed clauses asserting an agreement, commitment, decision, plan, intention, promise or future follow-up.

For that class of clause, a complete source turn must match its wording after punctuation/case normalisation and explicit first-person-to-speaker attribution. Conditions, negation and the rest of the source turn cannot be clipped away. Questions and quotations cannot silently become assertions. Duplicate source IDs cannot prove a clause. The witness must already belong to the paragraph's own references: broader context cannot donate a new assertion without a complete citation reallocation. A correction already carrying the app's independently validated complete temporal binding retains that stronger proof, including its established source-bound paraphrases; merely supplying a temporalEvidence field is insufficient.

An unchanged original clause remains unchanged; this mechanism does not certify old claims. A changed clause outside this limited follow-up class still uses the established fidelity checks. In particular, legal obligations, approval/completion reporting and the noun "plan" are not treated as follow-up commitments. A legitimate paraphrase without the narrow literal proof is conservatively declined and flagged, not silently approved or deleted.

When the veto applies, retain the original row and references, report the rejected correction in review accounting and attach one durable meaning-review warning. General quote-validated `uncertain` fidelity verdicts also receive durable meaning-review warnings. Verified editorial correction notices retain their previous filtering. Reviewer wording remains protected and reviewer-resolved flag states continue through owned save/reload.

Invalid referee targets are separately classified as response-contract failures, including when surfaced with HTTP 502. Network and rate-limit failures retain their established categories.

## Verification

Generic regressions cover offer-to-plan/agreement/promise/future strengthening, correct named first-person attribution, wrong actors/work, negation, questions, reported/quoted speech, omitted conditions, semicolon scope, extra obligations, duplicate source IDs, nearby uncited witnesses, reviewer protection and durable warnings. The actual owned GET/PATCH routes run against an isolated database stub to verify warning identity and reviewer resolution.

An offline comparison reconstructs packets for 30 corrections that can be exactly matched to primary rows across the five archived transcripts. Twenty-nine retain their previous outcome; the one changed outcome is the unsupported DITA planned-follow-up correction. This is not a byte-identical historical request replay, fresh Microsoft call or full fresh generation. Other archived corrections could not be matched to primary rows and are not included in that claim.

## Task-list status and limits

- 3B: bounded follow-up/commitment correction gate implemented. This is not a universal semantic-strength or whole-paragraph truth guarantee.
- 3C: unresolved fidelity warnings survive filtering and owned save/reload; verified editorial notices remain quiet.
- 5A: invalid-target failure classification corrected. The original historical bad target values remain unavailable.
- 3A/3D/3E/3F: complete citation alignment, source allocation/relocation and claim-by-claim validation remain open.
- 4A–4E and 5B–5E: unchanged by this batch.

Current library drafts are not rewritten. Visible generation effects require a new run. Preserve the existing bounded duplication editor and independent source checks; the new veto is not a reason to weaken them.
