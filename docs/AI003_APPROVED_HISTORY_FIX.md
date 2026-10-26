# AI-003: approved project history

This correction concerns `/project-update-test` and future project context. It does not change meeting-minutes generation, transcript-specific rules or AI-004's headline-health calculation.

## Approval rule

- **Save report** and autosave create an unapproved working copy. Selecting a status or sending `reportStatus: approved` does not approve content.
- **Approve report** deliberately approves the submitted reviewed content. It requires the latest version ID; stale approvals/saves are rejected without discarding the editor's text.
- Editing an approved report retains its last approved snapshot as project memory. Reapproval replaces that snapshot. Archiving removes that report from authoritative history and retrieval.
- Saved versions are immutable. This makes the version ID a reliable concurrency check, including between autosaves. Report writes are serialised under a row lock.
- The approval author comes from the authenticated API user, rather than a supplied browser name.

## Authoritative context

The context loader joins each non-archived report to its exact `approved_version_id`, checks that the version belongs to that report and was approved, and reads that version's reviewed JSON. Milestone, health and risk history is derived from this snapshot rather than original extraction tables. This also handles existing approvals whose reviewed versions have no corresponding assessment rows; no historical backfill or schema migration is necessary.

Project-local milestone IDs are preferred. Legacy rows can match an exact, unique configured name. Foreign or ambiguous targets are excluded; explicit approval rejects foreign/repeated milestone targets. No positional or semantic substitution is introduced. Older approved milestone baselines remain available even when the recent-report display is limited.

Reviewed forecast clearing and approved-version provenance survive the Python carry-forward step. Draft extraction no longer overwrites existing configured milestone dates. Manual project milestones, risks and independent context remain available without any approved report.

Report-derived knowledge must refer to the current approved version of the same project/report in both semantic and keyword retrieval. Independent manually supplied background information remains eligible. Reapproval archives superseded report knowledge, and a delayed ingestion cannot reactivate a version that is no longer approved. Report-linked snapshots are subject to the same authority boundary.

## Validation

`tests/project-approved-history-db.test.js` uses an explicitly supplied disposable `trinzo_tasks_test` database and a private test schema. It exercises:

- No approved history and exclusion of draft-linked snapshots.
- Preservation of manual context and configured dates during draft extraction.
- Status-only saves and autosaves never approving content.
- Reviewed corrections in milestone, health and risk context without assessment-row backfill.
- Actual next-report generation using the reviewed baseline, cleared forecast and approved-version reference.
- Immutable approval history, concurrent writes and stale approval/ingestion rejection.
- Reapproval and archive withdrawal.
- A real browser with the actual report API handler and PostgreSQL: edit, autosave, refresh, explicitly approve and refresh.
- Actual keyword and pgvector retrieval with deterministic test embeddings: current approved knowledge and manual background survive; superseded and wrong-project items do not.

`tests/project-approved-history.test.js` covers snapshot projection and ambiguous/legacy milestone identities. Existing report editing, milestone evidence binding, meeting-minutes handoff, Tasks privacy and Python project context/generation/status tests remain regression checks.

One old source-text assertion required in-place autosave reuse. That implementation is deliberately replaced by immutable versions, with real PostgreSQL tests proving history preservation and stale-save rejection. No behavioural coverage was removed.

These checks do not represent a new Microsoft generation run or an independent Trinzo-user pilot. Existing report versions and production transcript data are not rewritten or approved by the tests. AI-004 remains a separate task.
