# Meeting Minutes Agent and Library audit — 17 October 2026

The audit is restricted to `/meeting-minutes-agent`, `/jobs`, their job-detail/result aliases, and the code those pages call. It was performed in `/srv/trinzo-minutes-audit-20261017`, branch `audit/minutes-library-20261017`, from the live revision `6d43bcb3`. Three subagents audited the editor, Library, and generation pipeline, followed by cross-review. Other pages were not changed. Shared-file edits are limited to the relevant handlers, data-access function, and Library selectors.

The changes are local and have not been deployed. Production drafts, database records, configuration, and model-service settings were not modified.

## Removal evidence

| Removed code/tests | Evidence of obsolescence | Coverage retained |
| --- | --- | --- |
| Manual proposal UI helpers, no-op renderer, selectors and styles | Commit `2be154087e3ce41fa732c95709fe5b42e5866527` removed the markup and introduced automatic application. Five private IIFE helpers had no callers; the renderer only repeated the review-count update already performed by `renderFlags`. | Automatic application, error recovery, historical saved proposals, warnings, undo/redo and server proposal endpoints. |
| Four skipped manual-proposal browser tests | Commit `1baf3c4da327279969d73f0efcf30d737e53fcc2` explicitly skipped these after the controls were removed. Their selectors no longer had producers. | Replaced with active browser regressions for current behavior; no failing live behavior was reclassified as obsolete. |
| Hidden Focus/audit buttons and unreachable synchronous-generation client branch | Buttons were permanently hidden and never revealed or programmatically clicked. `runAgent` has two callers, both requiring nonempty AI-edit instructions. Normal generation uses the background endpoint. | Stored step migration, ordinary background generation, explicit AI edits, and callable server audit functionality. |
| Legacy queue/archive list UI and orphan Library helpers/styles | `loadList` is the sole caller of `renderJobs`; every supplied row is an agent draft, so all other job-type branches and bulk selection/archive paths were unreachable. `renderListSection` and `renderProgress` had no callers. CSS searches found no other producers. | Current listing/search/status/sort/pagination/delete controls; existing job-detail/result aliases and local staged-draft recovery. Backend archive routes remain. |
| `normaliseAgentDiscussion`, `normaliseAgentActions`, their test-only exports, and one old flat-format test | Base-revision searches found only definitions, evaluation exports, and that test. Both generation paths and PATCH use V2 `normaliseAgentResult`. | Existing tests of active decisions, questions, multiple owners, timing and evidence contracts. |
| V2 `speakerMentionsSupported` and `evidenceIdsFor` | Unexported module-local functions with no references except their definitions. Active evidence resolution uses `resolveEvidence`. | The separately used `canonicalMinutes/evidenceCitations.js` helper remains. |
| Eleven source-presence assertions | Two demanded retired editor controls/helpers; nine demanded unreachable Library list/archive markup. | Remaining contract assertions and new behavioral browser tests. |

Feature flags, older saved-payload formats, nonhybrid generation, and staged preprocessing were retained. Being disabled, old, or named “legacy” is not evidence that a path is unused. In particular, the nonhybrid generator still handles explicit AI edits, and the current agent still calls the staged denoiser and candidate pipeline.

## Confirmed bugs fixed

- **Draft freshness:** supporting-detail edits and changes to action text, owners, dates, meeting metadata, or the prepared transcript could leave downstream output marked current. Completed empty stages were also missed. Dependency fingerprints and invalidation now cover these inputs, concurrent generation, normal saves, proposals, verified audit additions, and legacy undo. Regeneration invalidates affected downstream output without invalidating itself unnecessarily.
- **Undo:** accepting a proposal captured it in the undo snapshot; restoring that snapshot caused the browser to apply it again. New snapshots omit consumed changes, and historical snapshots filter accepted IDs. Unaccepted changes and redo remain supported.
- **Save/exit handling:** failed and in-progress saves did not trigger the browser's unsaved-change warning. The exit handler now follows the same safety state as the visible save status.
- **AI edit errors and overlap:** a failed automatic proposal application was reported as success and cleared the instruction. An explicit edit could also start while automatic application was still in flight. Errors and retry instructions now remain visible; overlapping edits wait until automatic application finishes. Edit controls accurately describe automatic application rather than promising a preview.
- **Library races:** late responses could overwrite current filters, counts, pagination, or errors. Request ownership now governs both rendering and refresh messages, including the search debounce interval.
- **Library detail/error handling:** a failed draft-list request prevented independent job details from loading; result-only pages hid request errors inside their hidden list panel. Detail loading and visible error reporting now work independently.
- **Pagination:** fractional limits/offsets reached PostgreSQL. The bounded values are now integers.
- **Generation-stage validation:** inherited object keys such as `constructor` and `__proto__` passed the stage lookup. Both generation handlers and persisted generation normalization now accept only own whitelist keys.

These defects were reproduced before fixes. Tests exercise actual handlers with isolated persistence/model boundaries and real Chromium for browser behavior. No tests were newly skipped or quarantined.

## Validation

Detailed provenance and logs are retained locally at `/root/trinzo-minutes-audit-results-20261017`. The broad manifest is `scoped-node-tests.json`; reports include `agent-ui-audit.txt`, `library-audit.txt`, and `pipeline-evidence.txt`. Before-fix logs intentionally contain the reproduced failures; the final logs are separate.

| Check | Result |
| --- | --- |
| Broad scoped Node regression run, 112 files | 1,242 passed; two existing captured-response tests initially skipped because their fixtures were outside the isolated checkout. No failures. |
| Captured-response rerun using `MEETING_MINUTES_AGENT_CAPTURE_ROOT=/srv/m365-agent-test` | All seven referee-concurrency tests passed, including both initially skipped cases. Existing captures were read only. |
| Final affected pipeline suite, nine files | 316 passed, no failures or skips. Includes the new freshness, stage-validation, proposal/audit and undo regressions; overlaps the broad run. |
| Shared utilities used by these pages, ten files | 86 passed, including PDF export, transcript health, evidence, editorial and action-tier coverage. |
| Python preprocessing/classifier and two scoped frontend contracts | 94 passed. |
| Agent Chromium suite | 55 passed, no failures or skips, including the overlapping-edit regression. |
| Library browser and database-boundary suite | 12 passed. |
| Existing Library served-HTML/mobile rendering checks | Two passed. |
| Actual `prepareMiniLmTranscript` smoke check | Passed using the repository transcript fixture and existing local denoiser/embedding service; prepared transcript was 614 characters. No generation-service call or draft write. |
| JavaScript syntax and `git diff --check` | Passed. |

Across the nonoverlapping test groups, 1,516 distinct scoped tests passed. The 316-test final pipeline rerun overlaps the broad run and adds 23 new regressions; it is not added again to that total. The two initially unavailable capture cases are counted only after their successful rerun. No unresolved test failures or skips remain in this scoped audit.

The initial dependency failure was repaired with an isolated `npm ci`; package manifests and lockfile were unchanged. Existing deterministic MiniLM cache files were copied into the audit checkout to avoid recomputing unchanged evidence profiles. The existing global Python quarantine configuration was not changed. The site-wide `npm test` was not used because it also exercises unrelated pages.

Reproduce the focused pipeline checks with the command in `pipeline-evidence.txt`. Run the browser suites with:

```sh
node --test tests/meeting-minutes-agent-ui-state.test.js
node --test tests/meeting-minutes-library-browser.test.js tests/meeting-minutes-library-db.test.js
```

The Python checks use the repository's discovery-compatible import path:

```sh
PYTHONPATH=tests python3 -m unittest -v \
  test_canonical_minilm_profile test_staged_short_replies \
  test_staged_trooper_chunk_pipeline test_meeting_minutes_usefulness_classifier \
  test_frontend_contracts.FrontendContractTest.test_meeting_minutes_agent_uses_evidence_backed_resumable_workflow \
  test_frontend_contracts.FrontendContractTest.test_meeting_minutes_final_queue_and_jobs_page_are_wired
```

## Remaining verification limits

Both live scoped page URLs returned their expected authentication redirects. A signed-in production journey, production PostgreSQL integration, and fresh end-to-end Power Automate/Copilot generation were not exercised. Browser/API tests use controlled responses; captured referee checks establish deterministic handling of existing responses, not current external-service availability or generation quality. Deployment and a signed-in production smoke test remain outstanding; the existing live checkout is still at `6d43bcb3`.
