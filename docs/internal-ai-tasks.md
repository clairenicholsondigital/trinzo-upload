# Internal AI project Tasks

## Scope and permissions

This feature is restricted to the existing persistent project **19**, currently AI Team Development. It does not identify a project by its display name. The database has a `project_id = 19` constraint, and every Tasks API request checks that ID and the existing authenticated `admin` role. Existing `client` accounts cannot use Tasks. There is no new role or change to other project permissions.

The Tasks navigation link is shown only after a server capability check and only while project 19 is selected. Direct `stage=tasks` links for other projects fall back to Overview. No global navigation is added. These development tasks are completely separate from meeting actions, risk suggestions, report approval and AI generation.

Normal operations are under `/api/project-update-test/projects/19/tasks`: access, list, create, detail, revision-checked PATCH and append-only comments. Lists default to outstanding tasks; status/priority/category filters and Show completed are available. Summary counts cover all tasks, independently of filters. Reopening a completed task changes it to To do and clears its completion timestamp. Comments remain attached.

The existing authenticated identity supplies creation/update/comment authorship; browser-supplied identities are rejected. Partial updates change only permitted fields. Revision conflicts return 409 and leave the editor available for copying/reloading. Sources allow only full HTTPS links without embedded credentials. Text/comments are escaped when rendered. Task edits are explicitly saved; unsaved fields/comments receive a warning before leaving through task/workspace controls or closing the page.

## Storage and hidden guidance

`sql/migrations/20261026_add_internal_ai_tasks.sql` adds two narrowly scoped tables and a sequence:

- `internal_ai_tasks`: stable ID, title, description, four statuses, priority/category, optional owner/due date, source links, revision, timestamps and authenticated author snapshots.
- `internal_ai_task_comments`: task-bound text, authenticated author and timestamp.
- Manual IDs begin at AI-016, reserving the snapshot's AI-001–AI-015 range. IDs are never reused or changed.

The task row includes `ai_implementation_guidance JSONB`, default `{}`. It can hold structured planning data, but is **excluded by explicit SQL projections from every ordinary API response**. Forms cannot write it, and it is not placed in browser state. No guidance plans are automatically generated and there is no guidance read/write HTTP route. Future development tooling needs a separately authorised mechanism; existing authorised database administration can inspect the field. Guidance is never executed as authority. Completing/reopening a task and normal edits do not change it.

No Tasks delete endpoint is provided. Existing deliberate project deletion cascades to its owned task data, consistent with the existing workspace's project-bound storage; completing a task does not delete anything.

## Deployment: not performed by this implementation

The implementation PR is stacked on documentation PR #158, so only the feature changes appear in its diff. Merge the documentation dependency before retargeting/merging the feature into main. Do not deploy or apply a migration merely because the PR exists.

After separate deployment approval, apply the additive migration with the existing operator tool:

```sh
node scripts/run_sql_migration.js sql/migrations/20261026_add_internal_ai_tasks.sql
```

Apply it before serving the feature. The migration is transactional and safe to rerun. It creates **no tasks, comments, plans or other project records** and does not alter reports, milestones, risks or meeting minutes. Then deploy through the existing release process. Confirm intended pilot participants have the existing internal/admin role; do not silently change account permissions.

## Initial import: proposal only

`docs/internal-ai-task-import-proposal.json` is the exact frozen proposal, prepared from `docs/CURRENT_PROJECT_STATUS.md` in PR #158. It contains **14 records**:

- Priorities: P0 4, P1 0, P2 8, P3 2.
- Categories: Technical 7, Usability 1, Validation 2, Decision 1, External dependency 2, Research 1.
- Statuses: To do 10, In progress 2, Blocked 2, Done 0.
- No duplicate IDs or existing task records were found during inspection. Recheck collisions after deployment, because colleagues may create tasks before import.
- AI-015 is excluded: its decision to obtain implementation approval was satisfied by this feature request. This does not mark a database task complete.
- AI-005, AI-006 and AI-009 map Awaiting input to To do, because the approved UI has only four statuses. The original status and input requirement remain in the description. Priorities/categories and source references are retained. Owners and due dates are not invented.
- Guidance is empty. No automatic synchronisation is installed. Preparation is pinned to this exact initial snapshot; changed Markdown requires a newly reviewed mapping rather than silently reusing the original import decisions.

Prepare/inspect a proposal without accessing any database:

```sh
node scripts/internal_ai_task_import.js prepare docs/CURRENT_PROJECT_STATUS.md
```

**Do not apply it until the user explicitly approves the exact proposal.** The operator command additionally requires its exact approval hash and an existing active internal/admin user's persistent ID:

```sh
node scripts/internal_ai_task_import.js apply docs/internal-ai-task-import-proposal.json \
  --approved-plan-sha256 APPROVED_HASH --actor-user-id EXISTING_ADMIN_USER_ID
```

This example is not approval to run the command. The import is one atomic insert statement, scoped to project 19. Conflicting stable IDs are reported as skipped and are never overwritten. Reruns preserve manually edited fields, statuses, owners, comments and guidance. A skipped ID must be reviewed, not assumed to be the same task. A later Markdown edit neither runs an import nor updates existing task records.

## Verification

Pure contract tests:

```sh
NODE_PATH=/srv/m365-agent-test/node_modules node --test tests/internal-ai-tasks.test.js
```

Integration tests require an **explicit disposable database named `trinzo_tasks_test`** with no production tables. They create their own minimal parent fixtures and apply the migration there; they deliberately never fall back to `DATABASE_URL`:

```sh
INTERNAL_AI_TASK_TEST_DATABASE_URL='postgresql://USER@localhost/trinzo_tasks_test' \
  NODE_PATH=/srv/m365-agent-test/node_modules \
  node --test --test-concurrency=1 tests/internal-ai-tasks.test.js tests/internal-ai-tasks-integration.test.js
```

The suite exercises real PostgreSQL persistence/constraints, HTTP routes and desktop/mobile browsers, including creation, edits, completion/reopening, comments/authorship, refresh, filters, role/project restrictions, hidden-guidance non-disclosure and preservation, stale/concurrent revisions, exact-plan approval and repeat imports preserving manual work. The HTTP fixture supplies upstream identity; `server.js` mounts the real routes behind existing `requireAuth`, whose wiring is also checked. This is isolated end-to-end feature validation, **not a live deployed smoke test**.

Implementation validation on 26 October 2026: **70 focused checks passed, no failures or skips** — 13 Tasks contract/PostgreSQL/browser checks plus 57 existing project workspace, minutes handoff, generation/persistence, agenda, minutes review and Library regressions. PostgreSQL/browser checks used a disposable local cluster only. No production migration, task import, merge or deployment was performed.

## Task context and closure

Task details provide separate Description, Current implications, Plan to fix and Fix details fields. These are public, human-written task information, separate from private AI implementation guidance. Existing descriptions are preserved; new fields initially remain empty rather than inventing plans or completed fixes. Source links are no longer shown or edited in the Tasks interface; saved references are retained unchanged by ordinary form saves.

Save and mark Done saves the current fields and completes the task in one revision-checked update. Completion records a timestamp and retains comments, references and fix details. Show completed makes these tasks available again; Save and reopen returns a completed task to To do without erasing its details. The list checkbox and Status selector remain available. Close details only dismisses the editor.

For this update, apply `sql/migrations/20261026_add_internal_ai_task_details.sql` after the initial Tasks migration and before deploying the updated application. It adds three non-null text columns with empty defaults and is safe to rerun. No existing task content or statuses are replaced.

Task context update validation: 70 focused checks passed with no failures or skips, including an existing-row migration rerun, source-reference preservation on form saves, private-guidance protection, and desktop/mobile save-and-complete/reopen with fix details and comments retained after refresh. The database/browser checks used the isolated `trinzo_tasks_test` database.
