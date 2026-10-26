# AI-002: milestone evidence association

The project-update report contains configured milestones as well as newly extracted updates. Its milestone array is not position-aligned with the raw transcript segments. Previously, persistence fell back to the segment at the same array index when a name/key did not match. That could attach another discussion's status, summary and quotations to a milestone, including a milestone explicitly carried forward without a transcript update.

## Bounded correction

`utils/projectMilestoneBinding.js` prepares associations before report/version creation:

- Carried-forward and unnamed/unclassified rows cannot create fresh milestone assessments.
- Current generated rows retain their own accepted evidence, including semantic renames. Persistence does not reinterpret semantic matches.
- Thin legacy rows require a unique source ID/key match; raw legacy named segments remain self-contained.
- Supplied milestone IDs must identify an active milestone within the selected project. Canonical database names are retained. Ambiguous labels and repeated supported targets fail before report/version creation.
- Unassigned material remains in the saved original report and source transcript. It is not silently assigned to a different milestone.

`saveProjectUpdateDraft()` uses those associations for both assessments and evidence. Canonical assessment statuses now survive normalisation alongside existing legacy aliases; zero confidence and absent turn references are preserved. Generation thresholds, approval rules, headline project health and meeting-minutes processing are unchanged.

## Historical repair safeguards

A private, complete before-image was captured for the existing reports, versions, sources, milestones, assessments and evidence. The audit identified four affected reports, including an older report with the same deterministic positional mismatch.

The reviewed repair is guarded by an exact plan hash and a comparison against the original database rows under a transaction lock. It:

- Removes 60 unsupported carried-forward assessment rows and their 18 incorrectly assigned quotations from the derived history.
- Corrects six source associations: four incorrect supported assessments in the older report, and two missing evidence associations for genuine report-owned updates. These use the original saved generation output, without a new AI call.
- Appends an audit version to each affected report, preserving every original version and later reviewer edits. Two later carried-forward Marketing rows are restored to the unassessed baseline because their progress came directly from a proven incorrect earlier association.
- Corrects historical foreign-project ID annotations only where an exact label and the original assessment identify the actual project-local target uniquely.
- Preserves report status (including archived status), approval fields, source transcripts, configured milestones and the AI-001 report recovery.

The exact repair was rehearsed against a disposable PostgreSQL copy and rolled back successfully. Private before/after records and the repair receipt remain on the server; transcript data is not included in this repository.

Original report versions remain accessible as historical evidence; their contents are not retrospectively presented as corrected originals. Newly appended audit versions identify the correction. This repair does not resolve the separate approval-baseline or headline-health tasks.

## Validation

- `tests/project-update-minutes-pipeline.test.js` exercises the actual persistence function, source ordering, carried context, accepted semantic renames, ambiguous sources, cross-project IDs, duplicate targets, legacy formats and status compatibility.
- `tests/project-milestone-binding-db.test.js` executes real SQL with project-local foreign keys, rejected cross-project writes, legacy input and confidence/turn-reference preservation.
- Report editing/recovery, Tasks access/privacy, project context, minutes hand-off, review and library browser regressions are included in the release checks.
- Existing Python semantic matching and milestone date/trend contract tests remain applicable.

PostgreSQL tests require explicit disposable database URLs ending in `/trinzo_tasks_test`. They never fall back to the production connection. No fresh Microsoft generation or first-time Trinzo-user pilot is claimed by these tests.
