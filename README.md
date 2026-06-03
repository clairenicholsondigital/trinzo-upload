# Trinzo Upload - Option B Workflow

## Environment
Create a `.env` file using existing pattern:

- `PORT` (optional, default `3978`)
- `DIRECTLINE_SECRET` (required, Copilot Studio Direct Line secret)
- `POWER_AUTOMATE_WEBHOOK_URL` (required for finalisation step; HTTP trigger URL from your Power Automate flow)
- `DATABASE_URL` (optional; Postgres connection string) or `PGHOST`/`PGPORT`/`PGDATABASE`/`PGUSER`/`PGPASSWORD`

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
3. **Clean UK business English.** Use Qwen/local LLM rewriting for grammar and tone, while preserving only evidenced content.

Regression coverage should use varied transcript fixtures rather than only the webinar rehearsal example, and should favour semantic confidence/abstention over transcript-specific phrase patches.

## Power Automate requirement
The finalisation endpoint posts approved meeting minutes JSON directly to `POWER_AUTOMATE_WEBHOOK_URL` (HTTP trigger flow).


## Structured output format
- `/api/agent/process` now returns nested meeting-minutes JSON (objectives, participants, minutes, next steps) plus `autosave` transcript metadata.
- UI now exposes a JSON editor for direct review before finalisation.

## SQL migration
- Run `sql/migrations/20260506_add_meeting_minutes_schema.sql` to add tables for meetings, objectives, participants, minute items, next steps, and autosave transcript snapshots.
- Run `node scripts/run_sql_migration.js sql/migrations/20260603_add_project_reporting_schema.sql` to add the project-reporting schema used by `/project-update-test` foundations. The runner uses the existing `.env`/Postgres configuration (`DATABASE_URL` or `PG*` variables).
