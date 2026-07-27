# Trinzo Upload - Option B Workflow

## Environment
Create a `.env` file using existing pattern:

- `PORT` (optional, default `3978`)
- `DIRECTLINE_SECRET` (required, Copilot Studio Direct Line secret)
- `POWER_AUTOMATE_WEBHOOK_URL` (required for finalisation step; HTTP trigger URL from your Power Automate flow)
- `DATABASE_URL` (optional; Postgres connection string) or `PGHOST`/`PGPORT`/`PGDATABASE`/`PGUSER`/`PGPASSWORD`
- `PGPOOL_MAX` (optional, default `5`) and `PGCONNECT_TIMEOUT_MS` (optional, default `5000`) for the pooled Postgres client used by persistence and migrations.
- `GOOGLE_AI_STUDIO_API_KEY` (optional for `/meeting-minutes-final`; enables the Google AI Studio/Gemini writing pass)
- `GOOGLE_AI_STUDIO_MODEL` (optional, default `gemini-2.5-flash`)

## Run locally
```bash
npm install
npm start
```

Open `http://localhost:3978`.

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

## Power Automate requirement
The finalisation endpoint posts approved meeting minutes JSON directly to `POWER_AUTOMATE_WEBHOOK_URL` (HTTP trigger flow).


## Structured output format
- `/api/agent/process` now returns nested meeting-minutes JSON (objectives, participants, minutes, next steps) plus `autosave` transcript metadata.
- UI now exposes a JSON editor for direct review before finalisation.

## SQL migration
- Run `sql/migrations/20260506_add_meeting_minutes_schema.sql` to add tables for meetings, objectives, participants, minute items, next steps, and autosave transcript snapshots.
- Run `node scripts/run_sql_migration.js sql/migrations/20260603_add_project_reporting_schema.sql` to add the project-reporting schema used by `/project-update-test` foundations. The runner uses the existing `.env`/Postgres configuration (`DATABASE_URL` or `PG*` variables).
