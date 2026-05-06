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

## Power Automate requirement
The finalisation endpoint posts approved meeting minutes JSON directly to `POWER_AUTOMATE_WEBHOOK_URL` (HTTP trigger flow).


## Structured output format
- `/api/agent/process` now returns nested meeting-minutes JSON (objectives, participants, minutes, next steps) plus `autosave` transcript metadata.
- UI now exposes a JSON editor for direct review before finalisation.

## SQL migration
- Run `sql/migrations/20260506_add_meeting_minutes_schema.sql` to add tables for meetings, objectives, participants, minute items, next steps, and autosave transcript snapshots.

- New `GET /api/db/health` endpoint verifies frontend-to-database connectivity.
- `POST /api/extract-docx` now attempts to create a meeting job + autosave snapshot immediately after upload/extraction.
