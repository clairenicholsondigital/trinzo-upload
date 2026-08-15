#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const options = { transcript: '', fileName: '', json: false, envPath: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--transcript') options.transcript = String(argv[++index] || '');
    else if (arg.startsWith('--transcript=')) options.transcript = arg.slice('--transcript='.length);
    else if (arg === '--file-name') options.fileName = String(argv[++index] || '');
    else if (arg.startsWith('--file-name=')) options.fileName = arg.slice('--file-name='.length);
    else if (arg === '--env') options.envPath = String(argv[++index] || '');
    else if (arg.startsWith('--env=')) options.envPath = arg.slice('--env='.length);
    else if (arg === '--json') options.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.transcript) throw new Error('--transcript is required.');
  return options;
}

function isolateEvaluationFromDatabase() {
  const dbPath = require.resolve('../utils/db');
  const unavailable = async () => {
    throw new Error('Database access is unavailable inside the staged production replay harness.');
  };
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: new Proxy({}, { get: () => unavailable })
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.envPath) require('dotenv').config({ path: path.resolve(options.envPath), quiet: true });
  else require('dotenv').config({ quiet: true });

  const transcriptPath = path.resolve(options.transcript);
  const transcriptText = fs.readFileSync(transcriptPath, 'utf8');
  const transcript = {
    text: transcriptText,
    source: 'staged-production-replay',
    fileName: options.fileName || path.basename(transcriptPath)
  };

  isolateEvaluationFromDatabase();
  const api = require('../routes/api').stagedEvaluation;
  if (typeof api?.canonicalStagedResponse !== 'function') throw new Error('canonicalStagedResponse is unavailable.');
  if (typeof api?.extractStagedDetailsFromTranscript !== 'function') throw new Error('extractStagedDetailsFromTranscript is unavailable.');

  const details = api.extractStagedDetailsFromTranscript(transcript.text, transcript.fileName).screens?.details || {};
  const confirmedDetails = details;
  const summary = await api.canonicalStagedResponse('summary', transcript, { confirmedDetails });
  const confirmedSummary = summary.screens?.summary || {};
  const discussion = await api.canonicalStagedResponse('discussion', transcript, { confirmedDetails, confirmedSummary });
  const confirmedDiscussion = discussion.screens?.discussion || [];
  const actions = await api.canonicalStagedResponse('actions', transcript, { confirmedDetails, confirmedSummary, confirmedDiscussion });

  const report = {
    pipeline: 'canonical_staged_v2_production_replay',
    transcript: transcript.fileName,
    stages: {
      details: {
        screen: confirmedDetails
      },
      summary: {
        screen: confirmedSummary,
        validationFlags: summary.validationFlags || [],
        telemetryPreview: summary.telemetryPreview || {}
      },
      discussion: {
        screen: confirmedDiscussion,
        validationFlags: discussion.validationFlags || [],
        telemetryPreview: discussion.telemetryPreview || {}
      },
      actions: {
        screen: actions.screens?.actions || [],
        validationFlags: actions.validationFlags || [],
        telemetryPreview: actions.telemetryPreview || {},
        canonicalDiagnostics: actions.canonicalDiagnostics || {}
      }
    }
  };

  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    process.stdout.write(`${report.transcript}: ${confirmedSummary.overallTopics?.length || 0} topics, ${confirmedDiscussion.length} discussion cards, ${report.stages.actions.screen.length} final actions\n`);
    for (const action of report.stages.actions.screen) {
      process.stdout.write(`- ${action.owner || 'Not stated'}: ${action.action}${action.deadline && action.deadline !== 'Not stated' ? ` [${action.deadline}]` : ''}\n`);
    }
    for (const flag of report.stages.actions.validationFlags) process.stdout.write(`  check: ${flag.message}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
