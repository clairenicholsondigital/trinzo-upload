#!/usr/bin/env node
// Replays the Actions stage of drafts kept by the performance harness
// (--keep-drafts), reusing each draft's cached model responses, and writes
// harness-shaped output for scoring. Environment variables set on this process
// (for example MEETING_MINUTES_AGENT_PROPOSAL_RECHECK_V1=1) select the arm.
// usage: node replay_meeting_minutes_agent_actions.js <codeRoot> <kept-harness.json> <out.json> [--env-file path]
const path = require('path');
const args = process.argv.slice(2);
const [codeRoot, keepFile, outFile] = args;
const envFile = args.includes('--env-file') ? args[args.indexOf('--env-file') + 1] : path.join(codeRoot, '.env');
const stage = args.includes('--stage') ? args[args.indexOf('--stage') + 1] : 'actions';
require(path.join(codeRoot, 'node_modules/dotenv')).config({ path: envFile, quiet: true });
const fs = require('fs');
const api = require(`${codeRoot}/routes/api`).stagedEvaluation;
const db = require(`${codeRoot}/utils/db`);
(async () => {
  const kept = JSON.parse(fs.readFileSync(keepFile, 'utf8'));
  const journeys = [];
  for (const j of kept.journeys) {
    const row = (await db.query('SELECT payload FROM meeting_minutes_agent_drafts WHERE id = $1', [Number(j.draftId)])).rows[0];
    if (!row) { console.error('missing draft', j.draftId); continue; }
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    const draft = { ...payload, draftId: `replay-${j.draftId}`, revision: 1, ...(stage === 'actions' ? { actions: [], pendingProposal: null } : { discussion: [] }) };
    const started = Date.now();
    let result;
    try { result = await api.generateHybridMeetingAgentStage(draft, stage, { onProgress: () => {}, onCheckpoint: () => {}, onPreview: () => {} }); }
    catch (error) { console.error('replay failed', j.draftId, error.message); continue; }
    journeys.push({
      case: j.case, run: j.run, draftId: j.draftId, waitingMs: Date.now() - started,
      reviewerOutput: stage === 'actions'
        ? { ...j.reviewerOutput, actions: result.changes.actions, proposals: result.changes.pendingProposal?.changes || [] }
        : { ...j.reviewerOutput, discussion: result.changes.discussion },
      rescued: result.changes.qualityState?.actions?.rescuedActionTexts || []
    });
    console.log(j.case.slice(0, 3), j.run, stage, (result.changes.actions || result.changes.discussion || []).length, 'ms', Date.now() - started,
      ...(result.changes.qualityState?.actions?.rescuedActionTexts || []).map((text) => `\n      rescued: ${text}`));
  }
  fs.writeFileSync(outFile, JSON.stringify({ ...kept, journeys }));
  process.exit(0);
})().catch((error) => { console.error(error.stack); process.exit(1); });
