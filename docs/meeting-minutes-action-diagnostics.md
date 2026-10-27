# Private action repetition diagnostics

## Purpose and boundary

Explain how generated actions reached the reviewer, including why apparently repetitive pairs were never compared. This is observational instrumentation: it does not broaden matching, remove warnings, authorise a merge, change a provider prompt, add AI calls or rewrite existing drafts. It is limited to the meeting-minutes action generation path.

The private audit uses `qualityState.actions.actionDiagnostics`, inside the existing draft JSON. No table, migration, permission or ordinary interface change is required. Normal responses remove `qualityState`; the trace is not put into action records, prompts, Word or PDF documents. The developer inspection command reads an explicitly supplied local JSON file; it has no web endpoint or production database reader.

## What is recorded

- Created action and candidate origins, qualified by extraction pass and candidate identity. A local label such as `A7` is not a global identity.
- Citation retention/remapping decisions, the supplied and selected source IDs, and the existing resolver's scores/decision branch. Transcript passages are referenced, not copied into the diagnostic audit.
- Normalisation, unsupported-owner removal, proposed owner borrowing, its donor candidate/pass, and referee materialisation.
- Actual local combination outcomes, delivery-bundle constituents, and restoration by preservation checks.
- Assembly checkpoints for changes in fields, warnings and timing. Checkpoint links use an ID only when it is unique in both successive registers in the same generation. Missing or repeated IDs are explicitly unresolved; the links are observations, not proof of equivalent work.
- Actual nomination exclusions, per-class counters, candidate-budget exclusions, independent review acceptance/veto/contract failure, and final semantic outcomes.
- Final generation and publication identity admission. These observations do not participate in receipt hashes or authorise deletion.

Snapshots contain action wording and ordinary action fields, including reviewer provenance. They contain no provider endpoints, credentials, environment settings or raw model prompts. Unknown action metadata is not copied into the snapshot. Exact snapshot references describe the recorded fields, not an assertion that omitted metadata is equal.

The recorder uses asynchronous context local to each action-generation attempt, including concurrent extraction passes. Diagnostics can be disabled in developer evaluation options with `actionDiagnostics: false`. A recording failure cannot change a generation decision; it increments the audit error count. Recording is bounded to 4,096 snapshots, 8,192 events, 512 detailed likely-overlap pairs and 2 MiB per attempt. Counts, `truncated`, `limitHits` and `errors` state the limits explicitly. Limits affect diagnostics only; they never truncate actions, comparisons or evidence. Aggregate nomination counters include checks outside the detailed likely-overlap sample. Full-stage failures with no returned result have no completed persisted audit; do not infer that a missing audit means no processing occurred.

## Inspecting a saved pair

Run on a secured development environment with the existing dependencies:

```sh
node scripts/inspect_meeting_action_pair.js /private/saved-draft.json 7 8 > /private/pair-trace.json
```

Positions are 1-based within the supplied saved register. The command reports the two actions, their references, saved aggregate reconciliation accounting, fresh local nomination reasons, mechanical retention blockers, local deduplication result and available captured lineage. It performs no AI requests or database writes. It does not treat a successful eligibility check as permission to merge.

Older drafts explicitly report `historical_not_captured`; candidate-ledger evidence can establish an origin but cannot reconstruct missing historical transformations. Replaying a helper is labelled a reproduction. Captured traces whose source hash differs from the current source are labelled `source_changed`. Exact snapshot mismatches after a reviewer edit report `snapshot_not_matched`; `matchedFinalSnapshots` makes partial matches explicit. They must not be inferred to match earlier wording. Register-wide observations are not treated as individual parentage assertions.

## Fixed historical baseline

`tests/fixtures/action-diagnostics/baseline-manifest.json` fixes REP-01 through REP-06 to the completed five-transcript run on `d03666e`, using the same application code subsequently deployed as `82e7c31`. It stores output hashes, action identities, positions and source references; raw drafts and source text remain private. These investigation labels and positions are not used in production matching.

| Group | Recorded explanation |
| --- | --- |
| REP-01 — Abbott training pack | Delivery bundling overlaps a send/sign handover; the final records have different owner sets and compound content. |
| REP-02 — Abbott risk sharing | A bundled delivery overlaps a standalone qualified sharing commitment; warnings, conditions and timing representations differ. |
| REP-03 — Abbott access | Primary and recovery formulate conditional alternatives versus definite access/upload work; the actual nomination rejects the compound wording. |
| REP-04 — DITA enquiry | Both recovery formulations fall outside the supported enquiry/contact shapes and bounded wording requirements. |
| REP-05 — Eakin assessment | Citation remapping, owner removal/borrowing and retained warnings complicate independently extracted assessment wording. |
| REP-06 — Eakin sending standards | Generic document descriptions, differing citations and an ownership warning prevent a proven comparison. |

All six isolated inspections reproduce zero semantic nominations and two retained rows. All three affected original full-register audits also recorded zero nominations. This distinguishes non-assessment from a Microsoft semantic veto. It does not establish that deleting one member of every pair would be safe. The two previously identified partial-overlap groups remain outside this six-group baseline.

## Verification

Private comparison and browser artefacts are under `/root/trinzo-postdeploy-five-20261027` on the authorised development host; they are not committed or exposed in the app.

- Original versus instrumented preparation of all five saved registers produced identical reconciliation packets and local action output.
- Offline action-generation replays against the deployed reference and instrumented code retained the same 15 / 13 / 8 / 16 / 0 action records, flags and merge receipts. Proposal content also matched; its per-attempt ID and creation timestamp were excluded explicitly.
- Replays used recorded responses and reproduced recorded referee validation failures. The private harness restored pass names from logs because persisted cache labels are truncated, and supplied only secondary candidates actually consumed by the original run. These are offline regression checks, not independent fresh AI generations or a production sign-in test. External provider calls and production database operations were blocked.
- All five recorded diagnostic audits were untruncated with zero recording errors. Final replay audit sizes ranged from 17,872 to 570,913 bytes; the 2 MiB limit remains enforced.
- A disposable PostgreSQL database, actual application route handlers and a browser verified corrections, completion, reload, ownership isolation, stale-revision rejection, Word/PDF downloads and audit redaction for all five outputs. Private audits survived unchanged. Authentication used fixture users. The disposable database was stopped and removed.
- Focused tests cover the six generic failure shapes, concurrent pass identity, bundling, owner checks/borrowing, restoration, nomination budgets, successful merges, semantic vetoes, malformed/provider failures, persistence/redaction, publication identity, source changes and diagnostic limits. The wider action regression suite passed 338 checks before the final checkpoint additions; the final direct diagnostics suite passed 24 checks; the complete release gate is run on the final code. Its first run exposed a source-extraction assumption in the existing referee-failure wiring test after the call wrapper changed. The test now executes the wrapped production path, retains every durable-capture/redaction assertion and additionally checks the diagnostic pass scope; it is not skipped.

Final clean release gate on implementation commit `690c021`: **445 Python tests passed; 4,913 JavaScript tests passed, 10 skipped, zero failures** (4,923 JavaScript tests total). The existing quarantine and skipped tests were not expanded.

## Completion criteria

The diagnostic feature is complete when the six baseline groups have evidenced inspection reports, new successful action generations retain private diagnostic history, comparison exclusions are distinguished from provider/proof outcomes, publication identities remain traceable, persistence/redaction checks pass and the existing output behaviour is unchanged.

Historical facts not captured by old runs remain explicitly unavailable. A trace reaching its recording limit remains partial. This work does not close AI-011 or claim to fix any of the visible repetition groups; it supplies the evidence for subsequent bounded corrections.
