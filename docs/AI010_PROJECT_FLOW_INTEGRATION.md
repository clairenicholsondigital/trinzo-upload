# AI-010: project-flow integration

26 October 2026. Integration of the existing PR #67 onto current main, preserving AI-001–AI-004 and the project-page styling from PR #168.

## Resulting behaviour

- Report saves and explicit approvals use the signed-in person's full name, falling back to email. Initial generated versions are attributed to Trinzo AI. Approval still requires the explicit action and current version; historical versions remain immutable.
- Minutes opened with explicit project context, or submitted to that project, receive a separate project tag. The Process screen lists the user's minutes for that project and offers “Show all my minutes” for older untagged drafts. Tags do not change minutes content, revision or timestamps, and cannot alter another user's draft. The schema addition is nullable and repeatable; it does not guess historical links.
- Identical reviewed minutes cannot enqueue competing updates for the same project. A transaction-scoped PostgreSQL advisory lock surrounds the fingerprint lookup and enqueue; the losing request receives a link to the existing report or job. Non-archived reports are checked across periods. Changed minutes, different projects, failed/cancelled jobs and archived reports retain their intended retry paths.
- The legacy backup analyser is adapted to the editable report contract before saving. Its own segments/evidence and reviewed actions are retained. Missing health evidence stays Not yet assessed; the report and completed Library job explicitly disclose backup use. Storage failures follow the existing job retry/failure path rather than being labelled ready. This does not grant approval or claim the backup provides the primary analyser's context-matching capabilities.
- The project workspace no longer loads the unused transcript-test page script. Tasks and other existing navigation remain present.

## Verification

Focused tests cover actual PostgreSQL concurrency (six simultaneous submissions, one job and no orphan meetings), source identity and retry controls, cross-period duplicates, tagging and owner isolation, repeatable schema changes, initial attribution, forced primary failure using the actual offline Python backup, actual worker persistence/job warning, and the report editor's backup warning/save/reload with qualified action timing retained. Browser tests cover Process filtering, legacy visibility and duplicate links from both interfaces.

Existing project editing, milestone binding, explicit approval/history, health and Tasks regressions are also required, together with the existing Python project/frontend/health/context/status tests, the 20 unchanged golden examples and the normal frontend build. Release verification passed 127 scoped Node checks, followed by 24 affected generator/database checks after adding the storage-failure control (128 distinct checks in total), 86 Python checks and all 20 golden examples. Test credentials/storage are isolated: database tests require the explicit `trinzo_tasks_test` URL. The backup failure is forced only in tests; production service settings are unchanged.

Detailed runtime/test receipts and before/after production preservation records accompany the task's private implementation guidance. Technical checks do not constitute an independent Trinzo colleague's pilot or a fresh live Microsoft generation. Those remain AI-007/AI-008.

## Deployment and recovery

The only storage change is the existing additive runtime schema step: nullable `meeting_minutes_agent_drafts.project_id` plus its owner/project index. No historical minutes, reports, approvals or milestone records are rewritten. Before release, verify no generation is active and preserve existing production records and configuration. Deploy the reviewed main revision, build, restart the web application and generation worker, verify authenticated routes/filtering and preserve records. If release checks fail, return to the recorded prior source revision; leave the harmless nullable column/index intact rather than deleting data.
