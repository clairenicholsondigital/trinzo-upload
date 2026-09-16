#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const REPO_DIR = path.resolve(__dirname, '..');
const DEFAULT_ENV = '/srv/m365-agent-test/.env';
const CASES = {
  t733: 'scripts/staged-scorecard-fixtures/04_eakin_t733_tech_file_weekly/transcript.txt',
  t761: 'scripts/staged-scorecard-fixtures/06_t761_eakin_sw_weekly/transcript.txt',
  m204: 'scripts/staged-scorecard-fixtures/05_m204_webinar_rehearsal/transcript.txt',
  parking: 'scripts/staged-scorecard-fixtures/13_parking_no_decision/transcript.txt',
  brewery: 'scripts/staged-scorecard-fixtures/11_brewery_numbers/transcript.txt'
};

function parseArgs(argv) {
  const options = {
    baseUrl: 'http://127.0.0.1:3978',
    cases: ['t733'],
    runs: 1,
    output: '',
    pollMs: 2000,
    timeoutMs: 20 * 60 * 1000,
    envFile: DEFAULT_ENV
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => String(argv[++index] || '');
    if (arg === '--base-url') options.baseUrl = value().replace(/\/$/, '');
    else if (arg === '--cases') options.cases = value().split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
    else if (arg === '--runs') options.runs = Number(value());
    else if (arg === '--output') options.output = value();
    else if (arg === '--poll-ms') options.pollMs = Number(value());
    else if (arg === '--timeout-ms') options.timeoutMs = Number(value());
    else if (arg === '--env-file') options.envFile = value();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.cases.length || options.cases.some((name) => !CASES[name])) {
    throw new Error(`--cases must contain: ${Object.keys(CASES).join(', ')}`);
  }
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 20) {
    throw new Error('--runs must be an integer from 1 to 20.');
  }
  if (!Number.isFinite(options.pollMs) || options.pollMs < 250) throw new Error('--poll-ms must be at least 250.');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 10000) throw new Error('--timeout-ms must be at least 10000.');
  return options;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function apiRequest(url, cookie, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), cookie }
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text.slice(0, 500) }; }
  if (!response.ok) {
    const error = new Error(body.error || `HTTP ${response.status}`);
    error.statusCode = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function createBenchmarkSession(db) {
  const selected = await db.query(
    `SELECT id FROM auth_users
     WHERE is_active = TRUE
     ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, id
     LIMIT 1`
  );
  const userId = Number(selected.rows[0]?.id || 0);
  if (!userId) throw new Error('No active application user is available for the controlled benchmark.');
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await db.createAuthSession({
    tokenHash,
    userId,
    expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
    userAgent: 'trinzo-performance-baseline',
    ipAddress: '127.0.0.1'
  });
  return { userId, tokenHash, cookie: `auth_session=${encodeURIComponent(token)}` };
}

async function prepareDraft(options, cookie, caseName) {
  const transcriptPath = path.join(REPO_DIR, CASES[caseName]);
  const transcript = await fs.readFile(transcriptPath);
  const form = new FormData();
  form.append('file', new Blob([transcript], { type: 'text/plain' }), `${caseName}-performance-baseline.txt`);
  return apiRequest(`${options.baseUrl}/api/meeting-minutes-agent/prepare`, cookie, {
    method: 'POST', body: form
  });
}

async function runStage(options, cookie, draft, stage) {
  const startedAt = Date.now();
  await apiRequest(`${options.baseUrl}/api/meeting-minutes-agent/drafts/${encodeURIComponent(draft.draftId)}/generate-background`, cookie, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stage, revision: draft.revision })
  });
  while (Date.now() - startedAt < options.timeoutMs) {
    await wait(options.pollMs);
    const response = await apiRequest(
      `${options.baseUrl}/api/meeting-minutes-agent/drafts/${encodeURIComponent(draft.draftId)}/generation`,
      cookie
    );
    if (response.generation?.status === 'running') continue;
    if (!response.draft) throw new Error(`${stage} finished without returning its draft.`);
    if (response.generation?.status === 'failed') {
      throw new Error(`${stage} failed: ${response.generation.error || 'unknown generation failure'}`);
    }
    return {
      draft: response.draft,
      observedElapsedMs: Date.now() - startedAt,
      performance: response.performance || {}
    };
  }
  throw new Error(`${stage} exceeded ${options.timeoutMs}ms.`);
}

function reviewerOutput(draft = {}) {
  return {
    details: draft.details || {},
    meetingObjectives: draft.meetingObjectives || [],
    discussion: draft.discussion || [],
    actions: draft.actions || [],
    proposals: draft.pendingProposal?.changes || [],
    executiveSummary: draft.executiveSummary || '',
    reviewFlags: draft.reviewFlags || []
  };
}

function privatePerformance(draft = {}) {
  const quality = draft.qualityState || {};
  return Object.fromEntries(['preparation', 'discussion', 'actions', 'summary'].map((stage) => [stage, {
    stageElapsedMs: quality[stage]?.stageElapsedMs,
    processingElapsedMs: quality[stage]?.processingElapsedMs,
    completedAt: quality[stage]?.completedAt,
    telemetry: quality[stage]?.telemetry,
    callPerformance: quality[stage]?.callPerformance,
    passImpact: quality[stage]?.passImpact
  }]));
}

async function runJourney(options, db, session, caseName, runNumber) {
  const journeyStartedAt = Date.now();
  let draft;
  try {
    const prepared = await prepareDraft(options, session.cookie, caseName);
    draft = prepared.draft;
    const stages = {};
    for (const stage of ['discussion', 'actions', 'summary']) {
      const result = await runStage(options, session.cookie, draft, stage);
      draft = result.draft;
      stages[stage] = {
        observedElapsedMs: result.observedElapsedMs,
        polling: result.performance
      };
    }
    const privateDraft = await db.getMeetingMinutesAgentDraft(draft.draftId, session.userId, { includeTranscript: false });
    return {
      case: caseName,
      run: runNumber,
      draftId: draft.draftId,
      startedAt: new Date(journeyStartedAt).toISOString(),
      completedAt: new Date().toISOString(),
      totalElapsedMs: Date.now() - journeyStartedAt,
      preparation: prepared.performance || {},
      stages,
      performance: privatePerformance(privateDraft),
      reviewerOutput: reviewerOutput(draft)
    };
  } finally {
    if (draft?.draftId) {
      await apiRequest(`${options.baseUrl}/api/meeting-minutes-agent/drafts/${encodeURIComponent(draft.draftId)}`, session.cookie, {
        method: 'DELETE'
      }).catch(() => {});
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  require('dotenv').config({ path: options.envFile, quiet: true });
  const db = require('../utils/db');
  const session = await createBenchmarkSession(db);
  const report = {
    schemaVersion: 1,
    variant: 'production-control',
    generatedAt: new Date().toISOString(),
    baseUrl: options.baseUrl,
    cases: options.cases,
    requestedRunsPerCase: options.runs,
    journeys: []
  };
  try {
    for (let run = 1; run <= options.runs; run += 1) {
      for (const caseName of options.cases) {
        process.stderr.write(`baseline: ${caseName} run ${run}/${options.runs}\n`);
        const journey = await runJourney(options, db, session, caseName, run);
        report.journeys.push(journey);
        if (options.output) {
          await fs.mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
          await fs.writeFile(path.resolve(options.output), `${JSON.stringify(report, null, 2)}\n`);
        }
      }
    }
  } finally {
    await db.deleteAuthSession(session.tokenHash).catch(() => {});
  }
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) await fs.writeFile(path.resolve(options.output), rendered);
  else process.stdout.write(rendered);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { CASES, parseArgs, reviewerOutput, privatePerformance };
