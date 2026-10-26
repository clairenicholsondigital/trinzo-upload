# AI-013: people and terminology Settings

26 October 2026. Integration of PR #61 onto current main, including PR #67/AI-010 and all released minutes and project-report safeguards.

## Proposed behaviour

The reviewer-precedence rule below is tested in the isolated branch but awaits the explicit AI-020 decision. This document does not record acceptance or authorise merging before that decision.

- Signed-in colleagues can view `/settings`; only administrators can add, edit or delete people/glossary entries and read change history. Audit identity comes from the authenticated session.
- The directory supplies names, alternative spellings and default Internal/Client classifications. A reviewer saving explicit attendee lists marks them reviewed in the existing draft JSON; later normalisation respects that choice. Newly generated/unreviewed lists retain directory classification. No extra database field or historical backfill is needed for this marker.
- Exact registered names and aliases are looked up before fuzzy-name length limits. Two or more people sharing a first name remain ambiguous, including the third and later entries. Existing short-given-name safeguards remain: a shared surname does not turn Sami/Suki/Maki into Saki.
- Glossary validation rejects collisions across the same separator variants and acronym plurals the runtime corrector accepts. Valid own-term spellings such as `Med Envoy` -> `MedEnvoy` remain supported. Terms, meanings and aliases remain data, not executable instructions.
- Settings schema creation and once-only seeding share a transaction and cross-process advisory lock. Deleting a seeded row is not undone by refresh, migration reruns or new processes. Existing rows are not overwritten by seed inserts.
- The web application refreshes through the existing API middleware and after edits. The separate generation worker refreshes before executing each new job. Python spawning refreshes as needed and inherits a process-local JSON snapshot written atomically with mode 0600. Database failures retain the last good copy or defaults and can recover.
- The shared navigation keeps the AI team project link and adds Settings. Earlier project-page styling, timing, filing, review accounting, approvals and report history are preserved.

## Evidence

301 scoped Node checks passed across Settings, names/attendees/terminology, minutes V2, project reports/editing/approval/history/health and Tasks. After adding three further acceptance cases, all nine actual Settings integration checks passed (304 distinct scoped checks overall). All 112 relevant Python checks, 20 unchanged project reference examples and the normal frontend build passed.

The Settings integration uses actual session authentication and PostgreSQL in the explicit disposable `trinzo_tasks_test` database, with a private schema. It exercises permissions, desktop/mobile edits, refresh persistence, audit authors, deletion, reviewer-side save/readback, independent-process and Python snapshot delivery, actual worker execution of an offline/no-save project job, simultaneous fresh setup, repeatable migration and last-good-settings recovery. Tests call no external AI services and do not modify production reports or minutes.

The existing first-name ambiguity test now provides synthetic directory rows through the real Settings store rather than patching the retired hardcoded constant; all original assertions for two through six shared first names remain. Merge conflict resolution retains the already released filing, timing and review-accounting imports and behaviour.

## Release and recovery

The additive storage is `settings_people`, `settings_terms`, `settings_changes` and `settings_meta`, with their existing PR indexes. The reference migration remains `sql/migrations/20261021_add_settings_schema.sql`. No production minutes, reports, approvals, milestones or existing task comments are rewritten. Built-in defaults seed only when their markers are absent; there is no automatic import from meeting actions or hidden AI guidance.

Before release, verify no generation is active and preserve production-record/configuration hashes. Build and restart the web application and generation worker on the reviewed revision. Check authenticated Settings and existing workflows, source=database, seeded counts, admin/client access, private snapshots and record preservation. If the release fails, restore the recorded prior source revision without deleting the additive Settings tables or audit history; never reseed over user edits. Live verification and receipts are recorded in AI-013's hidden guidance.

Technical acceptance does not establish independent Trinzo pilot completion. AI-007/AI-008 remain separate, and held semantic-cleanup PRs stay held.
