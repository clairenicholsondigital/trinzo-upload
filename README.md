# Trinzo Upload - Option B Workflow

## Environment
Create a `.env` file using existing pattern:

- `PORT` (optional, default `3978`)
- `DIRECTLINE_SECRET` (required, Copilot Studio Direct Line secret)
- `POWER_AUTOMATE_WEBHOOK_URL` (required for finalisation step; HTTP trigger URL from your Power Automate flow)

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
