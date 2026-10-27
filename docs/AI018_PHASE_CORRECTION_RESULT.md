# AI-018: bounded phase correction

Date: 26 October 2026
Branch: `fix/ai018-phase-aware-actions`
Implementation base: `21dfefeec75d5f36785d82edca910e4db37b5ac4`
Main baseline: `7107e5dc1ec828d855a8c5cbc05e8ea6a88d8936`

## Result and release status

The demonstrated overlapping handoff is corrected in isolated tests, including two authorised live Microsoft checks. There are **two distinct instructions**: tidy/share for review, then add the technical considerations. Sharing appears once. The initial instruction retains the fullest original hopeful target; later timing stays unknown. Existing warnings, rejected dates, owners and evidence remain recoverable.

This supersedes the unresolved wording outcome of [the earlier proof gate](AI018_PROOF_GATE_RESULT.md), without overturning its veto against a one-row union. Neither instruction can safely replace the other unchanged. This implementation does not widen general timed-action deduplication.

**Implemented and tested; not yet merged, deployed or enabled. AI-018 remains In progress until release checks pass.** Existing library drafts have not been edited. No schema change or Microsoft configuration change is required.

## Corrected root-cause account

The earlier ledger-only description was incomplete. Captured provider receipts show that the two independent ACTION_DISCOVERY legs (calls 16 and 17) already generate the broader update/share instruction and the narrower completion/share-for-review instruction. Their primary union contains both. Anchored recovery (call 18) receives both as current candidates and repeats them; it is not their first origin.

Individual referee approvals establish neither equivalence nor correct phase boundaries. The omission-oriented completeness selection checks the narrower instruction, not the broader phase conflation. General deduplication correctly refuses to erase protected scope/timing. Final survival restoration did not reintroduce the pair: its recorded restored count was zero.

The visible symptom is repeated handoff wording plus later technical additions combined into the earlier instruction. Source inspection supports sequential phases, but does not establish a shared target for both.

## Localised correction

- Recovery guidance explicitly preserves phase order and asks for genuinely uncovered work. Bounded rejected-date/wording provenance is labelled as an application assessment, never source evidence.
- A new action-only module nominates a narrow grammatical class: an update/share-artifact-including-scope instruction paired with completion/share-updated-material-for-review, with the same single owner, shared citations, compatible rejected/uncertain target history and an explicit source sequence.
- The application constructs the two candidate sentences from the existing artifact/scope. Microsoft does not freely rewrite them. The source must also support tidying and the qualified original target.
- Two separate Microsoft calls assess original claims and independently challenge the proposed phase assignment. Whole-unit source witnesses, complete claim/output checks and exact content-bound receipts are mandatory. A veto, malformed reply, timeout or missing evidence preserves the originals.
- Only one unambiguous pair is corrected per stage, within two calls and a 90-second deadline. A competing third instruction prevents pair selection.
- The initial handoff precedes the later additions. Timing is assigned server-side: the hopeful original wording stays with the handoff; no exact date is approved; later timing is not stated. Each row keeps its original rejection/checker history and warning IDs.
- Private receipts survive identity admission, unchanged saves and final preservation. Reviewer changes invalidate automatic restoration. The existing recovery control uses “Restore original action wording”.
- Restoring this correction leaves independently proved earlier contact consolidation recoverable.

No client transcript, provider payload, private endpoint or credentials are committed. Generic production grammar contains no client names, source snippets, document names or weekday-specific exception.

## Evidence and tests

### Real Microsoft checks

The previously approved two actions and bounded source passages were sent only to the existing Power Automate endpoint. Free-rewrite positive replies that failed local claim/phase checks were rejected and never applied. The narrowed deterministic draft passed both the claim assessment and independent source check.

Observed result: two rows; one handoff; later technical scope retained; hopeful initial target; no later target/date; all six original warning references retained; both rejected exact-date histories retained; exact original restoration successful. No library writes.

The failed one-row common-timing proof was not retried into acceptance. This is a different two-row correction with stricter source ordering.

### Integration and regression checks

- 690 relevant Node checks passed: new phase tests plus timing, date boundaries, semantic reconciliation/policy, contact handling, compilation/workflow unions, survival and agent-v2 coverage.
- Full existing browser UI-state suite: 66 passed, including the new phase restoration label/interaction.
- Browser-facing responses exclude private proof. Reviewer edits, changed sources/date, active generation, another account and stale revisions prevent unsafe restoration.
- Actual PostgreSQL round trip in a unique disposable schema passed through the production generation finish hook, identity admission, owned PATCH/GET and restoration routes.
- Ordinary and evidence Word **and actual PDF** exports passed. The Actions section uses corrected wording; evidence appendices deliberately retain historical evidence/warnings.
- The database check replayed the successful live provider receipts against the exact same packet. It made zero new external requests and zero production library writes; the disposable schema was removed.
- Meeting-agent build and whitespace checks passed.

Private evidence is retained in `/root/trinzo-ai018-implementation-20261026/`. Tests using controlled provider responses are separate from live Microsoft proof; neither is a fresh five-transcript full-generation run.

## Release and closure

1. Review/merge this implementation. It includes the earlier proof-only PR #176's generic safety tests and report; do not separately duplicate the implementation.
2. Deploy the reviewed commit and set `MEETING_MINUTES_AGENT_PHASE_CLARIFICATION_V1=1` alongside an enabled action-only semantic policy. The flag defaults off. Off/shadow and pre-existing jobs with no captured flag remain unchanged.
3. Verify a new isolated run on the deployed build shows the source-proven two-phase result and that ordinary save/reopen/export/restoration still work. Do not overwrite existing library drafts automatically.
4. Record deployment SHA and result in AI-018, then mark Done for the demonstrated bounded overlap class.

A similar-looking instruction outside the supported grammar, or without complete phase proof, remains unchanged. No claim is made that all semantic duplicates or all source ambiguities are eliminated. Independent reviewer-time measurements and a fresh five-transcript generation comparison remain unverified and are not fabricated as evidence for this task.
