# AI-018: execution result — work-phase and timing proof gate

Date: 26 October 2026  
Branch: `fix/ai018-protected-work-proof`  
Base: `7107e5dc1ec828d855a8c5cbc05e8ea6a88d8936`  
Plan: [AI-018 research plan](https://github.com/clairenicholsondigital/trinzo-upload/blob/ea1a2ab14747d5dfc09de39fdf1e3734388d8d12/docs/AI018_PROTECTED_TIMING_IMPLEMENTATION_PLAN.md)

## Outcome

**The plan's first safety gate did not pass. AI-018 is not fully fixed.**

The captured file-update/share instructions overlap, but one row cannot be removed unchanged without losing scope or review purpose. The source describes an initial file preparation/handoff and subsequent additions; it does not establish one target that safely governs every operation. An automatic one-row union was therefore not implemented or enabled.

This is a conditional stop required by the approved plan, not a failed deployment or a provider outage. No production generation, library edit, warning dismissal, schema change or deployment was performed.

## Evidence obtained

### Current-code reproduction

The original captured pair, replayed locally against the base above, remains two rows:
- zero semantic comparison nominations;
- no existing workflow-union or compilation-union packet;
- two rows through hybrid dedupe and final preservation;
- coverage refused in both directions;
- six warning references and a rejected exact date remain protected.

These exclusions are deliberate safeguards. Widening timed/flagged/compound eligibility alone would not resolve the missing work-phase proof.

### Origin of the overlapping wording

The captured candidate ledger attributes both surviving records to recovery (R10/R11). Provider receipts show:
- discovery response 17 contains the completion/share-for-review instruction;
- anchored-discovery response 18 contains both instructions.

Thus overlapping descriptions enter before final semantic deduplication. Current safeguards then retain them because the originals differ in scope, operations and protected timing. This is not a demonstrated Microsoft equivalence veto in the old generation.

The extra technical scope and the review purpose cannot be discarded just because the file and assignee match. The broader instruction may also conflate work phases. Calling it a straightforward duplicate would conceal this issue.

### Authorised isolated Microsoft checks

Four requests were made to the application's existing Microsoft Power Automate endpoint, after explicit approval for AI-018's actions and relevant source passages. The private harness blocked database access and did not save library drafts.

| Check | Result | Interpretation |
| --- | --- | --- |
| Initial work-identity assessment | Same underlying work; all broad booleans positive | Not sufficient to authorise a merge. |
| Independent work-identity assessment, without the earlier verdict | Same underlying work; all broad booleans positive | Matching labels do not prove a common timing scope or retained sequencing. |
| Source-only operation/phase/timing assessment | Preparation and initial handoff precede later additions; additions-before-first-share contradicted; one target covering every operation false | Required phase/timing gate fails. |
| Generic positive and adverse controls in one request | Whole update-and-share target accepted; initial handoff followed by later additions rejected as one common target | The source-only check can distinguish the two cases; it does not reject all compound workflows. |

The stricter source-only result is a valid safety veto. It was not retried into approval. No generated rewrite or previous broad verdict was supplied to that source-only assessment.

This disagreement is important: two positive same-work opinions are not a majority vote that overrules a failed timing/sequence check.

### Limits of this conclusion

The evidence supports preserving distinct phases and uncertainty. It does **not** prove that the two existing generated sentences are ideally worded, or that every current timing assignment is correct. The warning-bearing broader row may still over-combine preparation, handoff and later additions.

Therefore this is not recorded as a completed no-change resolution. The visible overlap remains, and AI-018 must remain open. Nor does one model's source-only timing interpretation become a verified deadline: the conservative conclusion is that common scope is not established.

Private receipts are retained under `/root/trinzo-ai018-implementation-20261026/`. Raw client transcript content, names, action IDs and provider payloads are not committed to this branch.

## Changes made on this branch

Added `tests/meeting-minutes-protected-work-phase.test.js` with eight generic regression checks:
- ordered file handoff/additions remain distinct in either input order;
- neither unchanged instruction substitutes for the other's extra scope/purpose;
- general untimed and compilation nomination remain closed to the protected pair;
- different assignees, occurrences, versions and reviewer edits cannot be erased through shared wording or citations;
- retained rows preserve timing decisions, rejected-date history, warnings and evidence.

**115 focused tests passed**, including these eight and the existing compilation, workflow-union, AI-011 qualification and semantic-source-verification suites. These local suites use controlled provider fixtures; the four live Microsoft requests above are separate evidence.

No production application code was changed. No assertion of successful new PostgreSQL/export/restoration behaviour is made: those downstream implementation steps were conditional on a successful merge proof and were not reached.

## What remains necessary

1. **Do not enable a generic timed/flagged union based on the two initial positive labels.**
2. Resolve the work-phase representation before implementing a rewrite. The smallest useful clarification is whether the later additions belong to the same handoff/review occurrence, and whether the hoped-for target applies to them too.
3. Without that evidence, retain the phases separately. A future generic correction could make the two instructions describe their own phases more clearly, but must independently prove each operation's scope and timing and preserve all warning/rejection history. That is not interchangeable-duplicate deletion and has not been implemented here.
4. If a common occurrence and safe timing representation can later be proved, resume the original plan's bounded class, receipt, identity, persistence, export and exact-recovery steps. Otherwise investigate a bounded phase-aware wording correction under AI-018; do not create an automatic splitter or widen the old classes by assumption.
5. Keep AI-018 open until the reviewer-visible outcome is resolved and validated. Do not mark it Done solely for this research or the added tests.

No action is needed on AI-016's separate open PR as part of this work.
