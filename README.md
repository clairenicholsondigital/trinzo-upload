# Trinzo Upload - Option B Workflow

For the current entry points, Original/Beta flows, workers and first cleanup
boundaries, see the [live product map](docs/LIVE_PRODUCT_MAP.md).

## Environment
Create a `.env` file using existing pattern:

- `PORT` (optional, default `3978`)
- `DIRECTLINE_SECRET` (required, Copilot Studio Direct Line secret)
- `POWER_AUTOMATE_AGENT_WEBHOOK_URL` (required for `/meeting-minutes-agent`; synchronous HTTP flow returning JSON with `discussion` and `actions` arrays)
- `POWER_AUTOMATE_AGENT_TIMEOUT_MS` (optional, default `120000`)
- `MEETING_MINUTES_AGENT_HYBRID_V4` (optional feature flag; set to `1` to enable the staged-candidate plus Power Automate referee workflow)
- `MEETING_MINUTES_AGENT_WORKFLOW_TIMEOUT_MS` (optional, default `600000`; maximum age of a background hybrid generation before it is treated as interrupted)
- `MEETING_MINUTES_AGENT_BASELINE_TOKEN_SHA256` (optional; SHA-256 of the bearer token allowed to reset Meeting Minutes in-memory caches before a controlled baseline run)
- `POWER_AUTOMATE_WEBHOOK_URL` (required for finalisation step; HTTP trigger URL from your Power Automate flow)
- `DATABASE_URL` (optional; Postgres connection string) or `PGHOST`/`PGPORT`/`PGDATABASE`/`PGUSER`/`PGPASSWORD`
- `PGPOOL_MAX` (optional, default `5`) and `PGCONNECT_TIMEOUT_MS` (optional, default `5000`) for the pooled Postgres client used by persistence and migrations.
- `GOOGLE_AI_STUDIO_API_KEY` (optional for `/meeting-minutes-final`; enables the Google AI Studio/Gemini writing pass)
- `GOOGLE_AI_STUDIO_MODEL` (optional, default `gemini-2.5-flash`)

## Install and run

Use Node.js 22 LTS and Python 3.10 or later. Installed Node dependencies are
ignored by Git; `package-lock.json` is the installation source of truth.
From a fresh checkout:

```bash
npm ci --include=dev
npm run build:meeting-agent
npm start
```

Open `http://localhost:3978`. `npm start` also builds the Microsoft meeting-agent
browser bundle through its existing `prestart` hook. Do not omit development
dependencies during installation: the build currently requires esbuild.

Python transcript/project processing uses `PYTHON_BIN` (default `python3`).
For the base text-processing helpers:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
export PYTHON_BIN="$PWD/.venv/bin/python"
```

Local MiniLM and project-knowledge workers additionally use
`requirements-experimental-minilm.txt` (sentence-transformers and psycopg2).
Those requirements are not a fully pinned Python environment; local model
weights, PostgreSQL/pgvector and provider configuration remain separate setup
requirements. Historical training scripts also need packages such as pandas.
Removing tracked Node dependencies does not claim those services are recreated.

Browser tests require the Playwright Chromium revision matching the lockfile;
install it with `npx playwright install chromium` if it is not already available.

## Meeting minutes progress API

The existing authenticated `GET /api/meeting-minutes-agent/drafts/:draftId/generation`
also returns an additive `progress` snapshot. The draft must belong to the caller.
Existing `generation`, draft and error fields keep their contracts. The Beta
frontend also reads this snapshot to show checked sections as they arrive.

`progress` is null before any generation or saved completion marker exists.
Otherwise it contains `status` (`running`, `failed` or `ready`), a stable `code`,
a safe `message`, `stage` (`summary`, `discussion`, `actions` or Beta's `all`),
`startedAt`, `updatedAt`, `elapsedMs` and `sections`. Section states are
`waiting`, `running`, `received`, `validated`, `failed` or `saved`.
Validated responses may include provisional record/proposal/flag counts. Healthy
Beta runs may also include a bounded `sections.<stage>.preview`: summary text and
objectives, discussion text, or actions with owners and timing. These are read-only
display projections; IDs, evidence, proposals and provider diagnostics are omitted.
Changed meeting inputs, failed/stale runs and terminal states suppress previews.
A checked response is not a published result: `ready` requires saved completion
markers and no active or failed newer attempt.

Codes report observed milestones: `preparing`, `queued`, `request_sent`,
`response_received`, `validating`, `validated`, `retrying`, `saving`, `ready`,
`failed` or `interrupted`. Existing Original passes can also project
`extracting`, `checking` or `arranging`. Original and Beta keep their processing
and retry policies. Microsoft still returns a complete JSON response per call;
these snapshots describe observable work, not upstream internal progress.

Poll this endpoint to read the latest snapshot; polling does not start work,
write a draft or create history. There is no event history or stream in this
version. Progress observations use the existing run record and cannot fail
generation. Beta previews contain only validated, bounded display text and never
enter editable draft fields, saves, print or downloads. The normal editor adopts
the authoritative draft after all three responses succeed and are saved.
A timestamp changes when an actual milestone is saved, rather than on each poll.

## Deployment

`deploy.sh` installs locked Node dependencies with `npm ci --include=dev`, builds, runs the
core and affected checks against the deployed revision, then restarts and checks routes. Failed preparation or
tests restore the prior checkout's dependencies/build before exiting. This is
still an in-place deployment: use a maintenance window because files used by the
running processes change during installation/build. Do not deploy with a bare
Git pull or assume a restored Git revision restores installed dependencies.

The first release removing tracked `node_modules` must use the updated install
and build procedure before restarting. Dependency removal only changes the
current Git tree; older revisions and their files remain in Git history.

## Testing without running everything for every edit

`npm test` is the everyday product check: authentication boundaries, minutes
save/reopen and stale-edit protection, Original/Beta selection, exports, project
handoff/report editing, Settings, and the Python project-context/health contracts.
It uses fixture services rather than production accounts or AI providers.

| Command | Purpose |
| --- | --- |
| `npm test` | Small explicit core in `tests/suites.json`; no database required. |
| `npm run test:changed -- --base origin/main` | Core plus tests affected by committed, staged, unstaged and new files. |
| `npm run test:changed -- --file public/project-stage-process.js --list` | Explain a proposed selection without running tests. |
| `npm run test:full` | All non-database JavaScript regressions and the existing Python regression suite. |
| `npm run test:integration` | All eight real PostgreSQL/browser fixture files; explicit disposable database required. |
| `npm run test:release -- --base <deployed-revision>` | Affected checks, with required database coverage enforced before any tests start. |

For database checks, set `TEST_DATABASE_URL` to an explicitly provisioned
PostgreSQL database named `trinzo_tasks_test`. The existing three fixture-specific
`*_TEST_DATABASE_URL` variables remain supported. The runner never falls back to
production `DATABASE_URL`; it replaces inherited database credentials with the
explicit test target. Missing configuration fails integration/release checks
rather than reporting skipped persistence tests as a successful release.
`test:full` also runs integration if the explicit test configuration is present.

Selection follows literal local imports, named source/fixture reads, Python source consumers
and browser files for frontend edits. Parser-identified JavaScript statement-level
comments do not create dependency links; executable strings, templates and regular
expressions retain their original contents. Expression comments not reported by
the parser, unavailable tooling and uncertain parses keep the original conservative
matching. Unknown runtime mappings and changes
to installation/test infrastructure select the full regressions. Missing Git bases
fail with a request to fetch main or supply the correct revision. A fresh release
without a usable deployment marker uses `test:release -- --all`, including real
database checks. `deploy.sh` uses the marker rather than the current checkout as
its baseline, so already-pulled but undeployed changes are included.

Beta specialist prompt wording selects the parallel-contract checks rather than
thousands of unrelated implementation cases. The plan explicitly marks factual
quality as unevaluated: compare representative transcripts before publishing a
changed provider instruction. Ordinary JavaScript checks cannot prove a prompt
preserves meeting meaning.

The large API/legacy modules still couple many tests. A change to one of their
shared dependencies can correctly select hundreds of files; `--list` exposes
that breadth. Further narrowing requires separating those production modules,
not guessing that their callers are unaffected. Every regression case remains
available; new core cases should protect a distinct user-visible failure.

Core checks do not load/download MiniLM weights. Full semantic regressions need
the existing Python packages and cached models; the runner defaults Hugging Face
and Transformers to offline mode. Output-quality evaluation remains separate:
`test:project-update-golden` runs the existing project evaluation, and
`test:meeting-minutes-drift` remains the historical diagnostic command. Passing
product checks is not a claim of factual accuracy for newly generated minutes.

## Research archive

Historical classifier-training scripts, datasets and their research-only tests
have been archived separately. `research-archive.json` lists each original path,
SHA-256 and the source Git revision. The verified VPS copy is
`/root/trinzo-research-archive-20261030`, with a matching `.tar.gz` and checksum.
Archived files can also be recovered from that revision using `git archive`
with the paths in the manifest. The archive preserves the original directory
layout and includes its own test/run instructions.

Runtime classifier binaries (including configurable older models), their
metrics, benchmark transcripts and UI-consumed evaluation results stay here.
Archived training tests run in the archive, outside the product release suite.

## Baseline cache reset

An external baseline harness can start from a cold application cache with:

```bash
curl --fail-with-body -X POST \
  -H "Authorization: Bearer $TRINZO_BASELINE_TOKEN" \
  https://trinzo.virtual-hub.online/api/meeting-minutes-agent/testing/reset-memory-cache
```

The endpoint clears Meeting Minutes candidate, prewarm, speculation, evidence-context,
canonical MiniLM-profile and worker embedding caches. It never deletes drafts or their
persisted pass caches, so a baseline run should create new drafts. If any Meeting Minutes
generation is still active it returns `409 BASELINE_RESET_BUSY`; callers should wait and
retry before uploading the batch. The route returns `401` for a missing or incorrect token
and `503` when reset has not been configured or the local MiniLM worker cannot be reset.

## Frontend workflow
1. Upload `.docx`/`.txt`.
2. Extract text via `POST /api/extract-docx`.
3. Send extracted text to agent via `POST /api/agent/process`.
4. Review/edit meeting minutes fields in UI.
5. Finalise by sending approved JSON to your Power Automate webhook via `POST /api/agent/finalise`.

## Meeting-minutes quality priorities
For `/meeting-minutes-final/`, optimise in this order:

1. **Versatility and reliability across meeting types/formats.** Prefer sparse or empty output when semantic evidence is weak; do not force objectives, actions, or discussion points from chatter, transcript noise, or unsupported meeting formats.
2. **Speed.** Keep first-pass MiniLM candidate selection fast and aim for end-to-end generation under 30 seconds where practical.
3. **Clean UK business English.** `/meeting-minutes-final` now keeps MiniLM as the evidence/topic extraction layer, optionally sends that evidence pack to Google AI Studio/Gemini for a constrained first-pass write-up, then runs an evidence comparison quality-control pass before returning the final JSON. If Google AI Studio is missing, rate-limited, or unavailable, the endpoint falls back to the existing MiniLM output rather than failing the upload.

Regression coverage should use varied transcript fixtures rather than only the webinar rehearsal example, and should favour semantic confidence/abstention over transcript-specific phrase patches.

The fixed `/meeting-minutes-final` golden evaluation pack lives in `scripts/meeting-minutes-final-golden/`.
Use `python3 scripts/run_meeting_minutes_final_golden_eval.py --dry-run` for fixture/scoring validation, run the same command without `--dry-run` when the local MiniLM runtime is installed, or add `--base-url https://trinzo.virtual-hub.online` to score the deployed API.
The pack contains 20 representative cases tagged by meeting type and behaviour, and the runner reports coverage counts in dry-run, local extractor, live API, and JSON modes. It includes universal checklist checks for clean titles/participants, no conversational or first-person leakage, real concise actions, separated deadlines, no emojis/timecodes, and British English spelling.

## Project update reporting robustness

`/project-update-test` is now the authenticated project-update reporting workspace. The workspace pages, upload endpoint, read endpoints, mutating endpoints, and knowledge-management endpoints require the existing `auth_session` cookie via `requireAuth`; the frontend uses same-origin credentials and shows a login prompt on `401`.

Use `projectId` wherever possible. The upload endpoint, report/milestone lists, context endpoints, and project-memory endpoints accept `projectId` as body/query input; this bypasses the older project-name heuristic. The project-first workspace is backed by `GET /api/project-update-test/projects` and persists the selected project in `localStorage`.

Stored project context is covered by a shared contract fixture at `tests/fixtures/project_context_contract.json`. Python tests assert the context still drives trend comparison and carried-forward milestone rows; Node tests assert the producer/route boundary still exposes deterministic project-resolution fields.

Project-update persistence now uses the pooled `pg` client rather than spawning `psql`. `runPsql` remains as a compatibility wrapper for existing functions and the SQL migration runner, but it no longer shells out to the `psql` binary.

Project knowledge uses `sql/migrations/20260703_add_project_knowledge_schema.sql`. Trinzo requires `pgvector` for project knowledge; MiniLM chunks use `vector(384)`, and unsupported databases should fail migration early instead of creating an unusable fallback schema. Manual standing knowledge is managed in the Setup stage of `/project-update-test`; approved reports are ingested idempotently into `project_knowledge_items`/`project_knowledge_chunks`. Writes enqueue chunks and spawn `scripts/project_knowledge_embed_worker.py` in the background; uploads/approvals do not wait for embeddings. Use `POST /api/project-update-test/knowledge/embeddings/process` or run `python3 scripts/project_knowledge_embed_worker.py --project-id <id>` to kick the queue manually. `PROJECT_KNOWLEDGE_EMBED_INTERVAL_MS` can enable the server-side safety-net interval.

Retrieval helper: `python3 scripts/project_knowledge_retrieval.py --project-id <id> --query "..."`. It reports `retrieval_mode` as `semantic`, `keyword_fallback`, or `none` so callers can distinguish real semantic matches from keyword/no-knowledge states. `keyword_fallback` is a retrieval fallback when embeddings are unavailable for a query or no semantic chunks match; it is not a non-pgvector database mode. Retrieved knowledge is supplemental context only and must not be presented as transcript evidence.

Current hardening priorities live in `docs/project-update-robustness-todo.md`: keep the redesigned-workspace tests honest, fix the now-strict project-update golden eval failures, keep the project-memory smoke path repeatable, and continue parameterising old `runPsql` compatibility paths in small slices.

## Frontend styling

Shared, brand-matched UI styling lives in `public/trinzo.css` (served at
`/static/trinzo.css`) with progressive-enhancement JS in `public/trinzo.js`
(brand logo in the nav + active-page highlight). Each view links these near the
end of its `<head>` so the shared sheet loads last and themes the copy-pasted
component classes (`.nav`, `.panel`, `.card`, `.button`, tables, `.status`,
`.stage-tab`, etc.) consistently. The palette is light with the Trinzo brand
teal (`#79b1c2` mark, `#2c7a90` for accessible interactive elements); logo assets
are `public/trinzo-logo.svg` (light-on-dark) and `public/trinzo-logo-dark.svg`
(dark wordmark for light backgrounds).

Prefer adding to `public/trinzo.css` over new inline `<style>` theme blocks so
pages stay visually consistent.

## Power Automate requirement
The finalisation endpoint posts approved meeting minutes JSON directly to `POWER_AUTOMATE_WEBHOOK_URL` (HTTP trigger flow).


## Structured output format
- `/api/agent/process` now returns nested meeting-minutes JSON (objectives, participants, minutes, next steps) plus `autosave` transcript metadata.
- UI now exposes a JSON editor for direct review before finalisation.

## SQL migration
- Run `sql/migrations/20260506_add_meeting_minutes_schema.sql` to add tables for meetings, objectives, participants, minute items, next steps, and autosave transcript snapshots.
- Run `node scripts/run_sql_migration.js sql/migrations/20260603_add_project_reporting_schema.sql` to add the project-reporting schema used by `/project-update-test` foundations. The runner uses the existing `.env`/Postgres configuration (`DATABASE_URL` or `PG*` variables).
