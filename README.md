# Trinzo Upload - Option B Workflow

## Environment
Create a `.env` file using existing pattern:

- `PORT` (optional, default `3978`)
- `DIRECTLINE_SECRET` (required, Copilot Studio Direct Line secret)

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
5. Finalise by sending approved JSON back via `POST /api/agent/finalise`.

## Copilot Studio requirement
The finalisation prompt expects your Copilot Studio topic/tool to trigger a Power Automate flow and return confirmation and/or a file link. If this is missing, the UI displays a warning.
