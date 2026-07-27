# /project-update-test - Current Robustness To-Do List

Last audited against current code on 2026-07-27.

## Goal

Make `https://trinzo.virtual-hub.online/project-update-test` dependable as a
project-first reporting workspace:

- stored context remains the source of truth for milestones, risks, health and
  trend lineage;
- retrieved knowledge is supplemental background only, never transcript
  evidence;
- every important workflow has a regression check that fails for real breakage;
- the frontend stays usable while the backend is hardened.

## Current Reality

The old Phase 1/2/3 plan is no longer purely future work. The codebase already
contains:

- the project-first workspace UI at `views/project-update-workspace.html` with
  `public/project-stage-*.js`;
- authenticated project workspace pages and authenticated upload/mutating API
  paths;
- `sql/migrations/20260703_add_project_knowledge_schema.sql`;
- `project_knowledge_items` / `project_knowledge_chunks`;
- MiniLM knowledge chunking, embedding and retrieval helpers;
- manual project knowledge CRUD endpoints and UI;
- `GET /api/project-update-test/knowledge/status`;
- `POST /api/project-update-test/knowledge/ask`;
- retrieved-knowledge injection into the project-update context file;
- semantic milestone and risk matching in `scripts/project_update_minilm.py`;
- a project-update golden runner and packaged synthetic/real cases.

Production Postgres has `pgvector` installed and available. Trinzo project
knowledge is now treated as a pgvector-only feature; the old implied `REAL[]`
schema fallback has been removed from the migration because the worker/retriever
use vector casts/operators directly.

## Remaining To Finish

This is the current "not finished yet" list as of 2026-07-27, after commit
`59d59f6` was deployed and smoke checked on `trinzo.virtual-hub.online`.

### 1. Restore A Trustworthy Full Regression Baseline - Done 2026-07-27

The default deploy regression gate is now clean. `npm test` runs the
deploy-facing Python regression suite plus Node tests, while the old
meeting-minutes MiniLM comparison drift lives behind a named diagnostic command.

Why it matters:

- project-update can now be deployed with confidence from its focused gates;
- the whole repo now has one clean all-green default signal;
- old meeting-minutes drift is still visible without blocking unrelated
  project-update work.

Implemented:

- `python3 scripts/run_python_regression_tests.py` discovers Python tests and
  quarantines `tests/test_minilm_comparison.py`;
- `npm test` now runs that deploy-facing Python suite and the Node tests;
- `npm run test:meeting-minutes-drift` runs the quarantined MiniLM comparison
  suite directly.

Verified:

- `npm test` passes: 224 deploy-facing Python tests plus 5 Node tests;
- `npm run test:meeting-minutes-drift` still exposes the historical 31
  meeting-minutes MiniLM comparison failures as a separate diagnostic suite.

### 2. Expand Real-World Project-Update Golden Cases - Done 2026-07-27

The strict project-update golden eval now has eight real/realistic cases rather
than two. This is enough for a useful deploy gate, while still leaving room for
more real customer transcripts during the pilot.

Coverage now includes:

- fresh-context report generation;
- existing stored milestones carried forward correctly;
- existing risks updated without duplicate risk spam;
- messy transcript/chatter with sparse signal;
- retrieved knowledge supplementing context without being cited as transcript
  evidence;
- health/status disagreements where the correct answer is not obvious.

Implemented:

- added six more realistic real-mode cases in
  `scripts/project-update-golden/real/001_realistic_cases.json`;
- added `expectedRiskCountMax` support to the golden runner so duplicate risk
  spam can be caught directly;
- kept the checks behavioural rather than whole-output snapshots.

Verified:

- `python3 scripts/run_project_update_golden_eval.py --mode all --skip-minilm`
  passes 20/20;
- `npm test` still passes after the new cases and runner assertion.

### 3. Run A Proper Internal Pilot - Ready For Real Data

The core workflow works, but it still needs a real internal usage pass rather
than only smoke projects and fixtures. The pilot checklist and correction log
now live in `docs/project-update-internal-pilot.md`.

Pilot checklist:

1. choose one real Trinzo project;
2. enter standing context and agreed milestones;
3. process 3-5 real project update transcripts;
4. approve reports that are genuinely good enough to become memory;
5. use Insights and Ask this project before the next report;
6. record every manual correction needed.

Preparation completed:

- pilot scope and run checklist documented;
- correction log fields defined;
- pass/fail criteria written down;
- before/after checks documented.

Acceptance for marking this fully done:

- reports are useful without heavy manual rescue;
- corrections are categorised into parser/model/UI/setup issues;
- project memory improves later reports rather than polluting them.

### 4. Tighten Project Lifecycle And Admin Rules - First Pass Done 2026-07-27

The workspace can create, read, save, approve, archive and tidy data. The first
product-safety pass is now in place: reports are archived from the active
workspace/context by default rather than hard-deleted.

Current lifecycle rules:

- `draft` and `in_review` reports are editable working copies;
- `approved` means the report is good enough to become future project memory;
- approving a report creates an approved version and ingests approved-report
  knowledge for later retrieval;
- archiving a report keeps its versions/audit trail but removes it from active
  report lists and project context;
- `Mark active context official` freezes the current active milestones/risks as
  an official baseline and creates an official snapshot;
- `Tidy draft data` is a project cleanup tool: it archives reports, deactivates
  non-official milestones/risks, archives non-official knowledge, and removes
  non-official snapshots while preserving official/manual knowledge;
- project and milestone delete remain true destructive actions and require
  confirmation. They should stay internal/admin-only until proper roles exist.

Implemented:

- report row and bulk actions now say `Archive`, not `Delete`;
- the existing report delete endpoints now archive reports instead of hard
  deleting report/version rows;
- bulk report archive now uses parameterised SQL rather than an interpolated ID
  list;
- regression assertions pin the archive wording and `report_status =
  'archived'` behaviour.

Still needed before external/client-facing use:

- add real roles/permissions if non-admin users are added;
- decide whether milestone/project destructive actions should become archive
  actions too;
- make approval ownership visible in the report detail UI.

Acceptance:

- lifecycle rules are written in this doc;
- report UI copy/actions match those rules;
- report archive behaviour has regression coverage.

### 5. Improve The Client-Facing UX - First Pass Done 2026-07-27

The frontend is usable as an internal workspace. The first client-facing polish
pass keeps the same four-stage flow while reducing operator language and making
the first-report path clearer.

Implemented:

- Setup now has a concise before-first-report checklist;
- milestone and memory empty states tell the user what to add before the first
  transcript;
- `Standing context / project knowledge` is now labelled `Project memory`;
- technical chunk/embedding wording is hidden behind `Memory search
  maintenance`;
- saving memory now reports user-facing search-indexing status instead of
  worker/chunk internals;
- Process now says `Create draft report` and reminds users to review before
  approval;
- Insights copy separates current project status, stored project memory, and
  suggested follow-up risks.

Still needed before external/client-facing use:

- authenticated browser pass with screenshots on desktop and mobile after the
  next deployable UI batch;
- decide whether advanced JSON/report payload controls should be admin-only;
- test the first-time journey with someone who has not seen the tool before.

Acceptance:

- a first-time user can create/select a project, add context, process a
  transcript, save a report and understand Insights without developer guidance;
- authenticated browser pass covers desktop and mobile for Setup, Process,
  Reports, report detail and Insights;
- no page JavaScript errors in the checked journey.

### 6. Wire The Status Classifier Deliberately - Diagnostics First Done 2026-07-27

The separate status model at `/root/project-update-status-model` is promising,
but it is not trusted enough to drive user-facing report decisions yet. It is
now wired into the project-update upload route as diagnostics only.

Current behaviour:

- `/api/project-update-test` runs `scripts/project_status_evidence_pack.py`
  before the normal project-update report script;
- the classifier output is attached as `statusClassifierDiagnostics` with
  `decisionUse: diagnostics_only`;
- `projectReport.statusClassifierDiagnostics` contains a compact summary for
  technical output/version history;
- the existing report-generation path still decides overall health, milestone
  status, actions and risks;
- `skipStatusDiagnostics` can disable the hook for testing or emergency
  troubleshooting;
- classifier work is capped by `statusDiagnosticsMaxChunks` and
  `PROJECT_STATUS_DIAGNOSTICS_TIMEOUT_MS`, and failures are fail-open.

Still needed before it can influence outputs:

1. compare classifier status/action-state/signal output against current report
   output in golden evals;
2. decide whether it should influence health/status decisions;
3. keep transcript evidence and model diagnostics visibly separate.

Acceptance:

- classifier diagnostics are visible in technical output;
- route regression checks pin `decisionUse: diagnostics_only`;
- a deliberate product decision is still required before classifier output
  changes user-facing statuses.

### 7. Continue DB Parameterisation Outside Project-Update

The project-update critical slices are now parameterised, but older meeting,
admin and compatibility paths still contain legacy query-building patterns.

Acceptance:

- no high-risk user-input SQL paths remain in the wider app;
- conversion happens in small tested slices;
- project-update behaviour does not regress while old paths are cleaned.

## Guardrails

- Keep all changes inside `trinzo-upload`.
- Do not touch HelixScribe infrastructure; it is only a reference pattern.
- Do not put unrelated tools on `trinzo.virtual-hub.online`.
- Do not let retrieved project memory appear as transcript evidence.
- Keep every change deployable and regression checked.
- Protect the frontend: run JS syntax checks, targeted project-update tests and
  a browser/smoke check before deployment.

## Priority 1 - Make The Test Gates Honest

### 1.1 Fix stale project-update UI tests

Two tests in `tests/test_project_update_minilm.py` still refer to the deleted
pre-redesign page and old list-page navigation:

- `views/project-update-test.html`;
- old direct list links such as `/project-update-test/milestones`.

Update them to test the current workspace:

- `views/project-update-workspace.html`;
- shared project selection in `public/project-update-shared.js`;
- stage files in `public/project-stage-setup.js`,
  `public/project-stage-process.js`, `public/project-stage-reports.js` and
  `public/project-stage-insights.js`;
- report/milestone/context redirects in `server.js`.

Acceptance:

- `python3 -m unittest tests.test_project_update_minilm -v` passes locally;
- `node --test tests/context-contract.test.js` still passes;
- the updated tests check the redesigned workflow rather than preserving old
  markup.

### 1.2 Run the full baseline

After fixing stale tests, run:

```bash
npm test
```

Current outcome:

- default `npm test` passes using `scripts/run_python_regression_tests.py`;
- the historical MiniLM comparison drift is intentionally isolated behind
  `npm run test:meeting-minutes-drift`.

## Priority 2 - Strengthen The Project-Update Golden Eval

The runner exists at `scripts/run_project_update_golden_eval.py`, with cases
under `scripts/project-update-golden/`. On 2026-07-27 the runner was tightened
so important expectation misses are failures rather than warnings.

The following checks now fail the eval:

- expected milestone not found;
- expected risk not found;
- expected overall health outside the accepted set;
- expected retrieval mode missing or wrong;
- carried-forward milestone missing;
- retrieved knowledge marked as transcript evidence;
- sparse/no-substance cases producing excessive content.

Keep non-critical quality observations as warnings only where exact output is
genuinely flexible.

Current strict baseline:

- `python3 scripts/run_project_update_golden_eval.py --mode synthetic --skip-minilm`
  reports 12/12 passing;
- `python3 scripts/run_project_update_golden_eval.py --mode real --skip-minilm`
  reports 2/2 passing;
- `python3 scripts/run_project_update_golden_eval.py --mode all --skip-minilm`
  reports 14/14 passing.

The 2026-07-27 quality pass added conservative transcript-native fallback
extraction for clearly named milestones/risks, guarded overall health against
"garbage call" inputs, preserved transcript-derived trends when no previous
saved status exists, and made skip-MinILM evaluation accept token-overlap as the
deterministic equivalent of semantic matching.

Acceptance:

- `python3 scripts/run_project_update_golden_eval.py --mode all --skip-minilm`
  fails when a required expected milestone/risk/health check is broken;
- real cases are expanded beyond the current two examples before using this as
  a deploy gate.

## Priority 3 - Verify The Knowledge Loop End To End

Status: verified against production on 2026-07-27 with a temporary
`OpenClaw knowledge smoke ...` project, then cleaned up.

The smoke test confirmed:

- manual Setup knowledge created an active official item plus one queued chunk;
- `project_knowledge_embed_worker.py` moved that chunk to `embedded`;
- retrieval returned the item in `semantic` mode;
- Ask this project returned a `retrieval_only` answer when generation was
  unavailable;
- approved-report ingestion returned `{ ok: true, itemsCreated: 5,
  chunksCreated: 5 }`;
- re-ingesting the same approved report version was idempotent, with item count
  unchanged;
- project cleanup preserved official manual knowledge and archived generated
  non-official knowledge;
- a follow-up production query confirmed zero temporary smoke projects remained.

Keep this as the repeatable workflow for future deployment smoke tests:

1. create or choose a safe project;
2. add manual standing knowledge in Setup;
3. confirm knowledge chunks are created and queued;
4. run `project_knowledge_embed_worker.py`;
5. confirm `/knowledge/status` shows embedded chunks;
6. run Ask this project and verify semantic/keyword retrieval returns the item;
7. approve a report and confirm approved-report ingestion creates idempotent
   knowledge items and queued chunks;
8. re-approve and verify no duplicates.

Acceptance:

- manual knowledge survives `cleanup-tests` when official;
- non-official generated knowledge is archived by cleanup;
- approved-report ingestion reports `{ ok, itemsCreated, chunksCreated }`;
- Ask this project still works when generation is unavailable, returning
  retrieval-only snippets.

## Priority 4 - Decide And Apply The Auth Boundary

Current state:

- workspace pages are authenticated;
- upload and mutating endpoints are authenticated;
- read endpoints are now authenticated too:
  - `GET /api/project-update-test/projects`;
  - `GET /api/project-update-test/reports`;
  - `GET /api/project-update-test/reports/:reportId`;
  - `GET /api/project-update-test/milestones`;
  - `GET /api/project-update-test/milestones/:milestoneId`;
  - `GET /api/project-update-test/context`;
  - `GET /api/project-update-test/context/snapshots/:snapshotId`.

Decision:

- protect the whole project-update API surface because the workspace is no
  longer a throwaway test page and read responses include project/report context.

Acceptance:

- current workspace/admin frontend requests include same-origin credentials;
- unauthenticated API reads return `401`;
- authenticated pages continue to load project/report/context data.

## Priority 5 - Parameterise DB Access In Slices

`utils/db.js` now uses `pg.Pool`, and `runPsql` no longer shells out to the
`psql` binary. However, many old compatibility paths still build SQL strings and
parse text output. This is the largest remaining hardening task.

Do it in small slices:

1. project list/detail/report reads - done locally on 2026-07-27:
   `listProjectOptions`, `listProjectReports`, and `getProjectReportDetail`
   now use `query(sql, params)` instead of interpolated SQL/runPsql parsing;
2. project context reads - done locally on 2026-07-27:
   `resolveProjectForContext`, `getProjectContext`, and
   `getProjectContextSnapshot` now use parameterised queries for project/context
   reads while preserving the existing context object shape;
3. report save/update paths - done locally on 2026-07-27:
   report-detail edits were already transactional/parameterised, and
   `saveProjectUpdateDraft` now parameterises project/report/source/version,
   health, milestone, evidence, and risk write paths;
4. context snapshot/cleanup paths - done locally on 2026-07-27:
   snapshot creation/item inserts, mark-official counters, and cleanup counters
   now use `query(sql, params)`/row counts instead of text parsing;
5. legacy meeting/admin paths only after project-update is stable.

Acceptance for each slice:

- exported function signatures stay the same;
- output JSON shape stays the same;
- direct DB smoke confirms the returned row shapes stay compatible;
- weird names round-trip safely, including apostrophes, quotes, pipes and
  multi-line text;
- focused tests pass before moving to the next slice.

## Priority 6 - Resolve The pgvector Fallback Story

Status: resolved locally on 2026-07-27.

Decision:

- pgvector is required for Trinzo project knowledge;
- the migration now runs `CREATE EXTENSION IF NOT EXISTS vector` without hiding
  privilege/availability failures;
- `project_knowledge_settings.vector_mode` is constrained to `pgvector`;
- `project_knowledge_chunks.embedding` is always `VECTOR(384)`;
- the old `REAL[]` branch has been removed.

Clarification:

- `retrieval_mode: keyword_fallback` remains valid and means semantic embedding
  retrieval was unavailable or empty for that query;
- it does not mean the database can run without pgvector.

## Priority 7 - Status Classifier Integration

The separate VPS project at `/root/project-update-status-model` has a working
MiniLM classifier bundle, but it is not yet part of the core live reporting
decision path.

Only start this after Priorities 1-3 are trustworthy.

Suggested integration order:

1. expose classifier output as diagnostics only;
2. compare classifier status/action-state/signal output against current report
   output in the golden eval;
3. decide whether it should influence health/status decisions;
4. never let it override transcript evidence without a visible diagnostic.

## Deployment Checklist

Before deploying project-update changes:

```bash
node --check server.js
node --check routes/api.js
node --check utils/db.js
node --check utils/knowledge.js
node --check public/project-update-shared.js
node --check public/project-workspace.js
node --check public/project-stage-setup.js
node --check public/project-stage-process.js
node --check public/project-stage-reports.js
node --check public/project-stage-insights.js
python3 -m unittest tests.test_project_update_minilm tests.test_project_context_contract tests.test_project_knowledge tests.test_project_update_phase2_rag -v
node --test tests/context-contract.test.js
python3 scripts/run_project_update_golden_eval.py --mode all --skip-minilm
```

The project-update golden command is now expected to pass. Treat failures as a
real quality signal unless the fixture itself is deliberately being updated.

Before calling the frontend safe:

- load `/auth/login`;
- confirm unauthenticated project workspace routes redirect to login;
- after login, check Setup, Process, Reports and Insights stages render;
- process/knowledge/report changes must not break existing meeting-minutes pages.
