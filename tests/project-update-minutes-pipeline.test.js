'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');
const path = require('node:path');
const { minutesActionsForProjectReport } = require('../utils/minutesForProjectUpdate');

const dbPath = require.resolve('../utils/db');
const generatorPath = require.resolve('../utils/projectUpdateGenerator');
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalDbCache = require.cache[dbPath];
const originalGeneratorCache = require.cache[generatorPath];
let store;
const roundTrip = value => JSON.parse(JSON.stringify(value));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function resetStore() {
  store = { nextId: 100, jobs: [], versions: [], sources: new Map(), duplicateHashes: [], savedResponses: [], scripts: [] };
}

async function query(sql, params = []) {
  const text = sql.trim();
  if (/^(?:ALTER TABLE|BEGIN|COMMIT|ROLLBACK)/.test(text)) return { rows: [] };
  if (/^SELECT id FROM projects WHERE id/.test(text)) return { rows: [{ id: 7 }] };
  if (/^SELECT id FROM project_reporting_periods/.test(text)) return { rows: [{ id: 8 }] };
  if (/FROM project_report_sources s/.test(text)) {
    store.duplicateHashes.push(params[2]);
    const row = store.sources.get(params[2]);
    return { rows: row ? [row] : [] };
  }
  if (/^INSERT INTO meetings /.test(text)) return { rows: [{ id: store.nextId++ }] };
  if (/^INSERT INTO meeting_autosaves /.test(text)) return { rows: [] };
  if (/^INSERT INTO meeting_jobs /.test(text)) {
    const id = store.nextId++;
    store.jobs.push({ id, meetingId: params[0], inputPayload: JSON.parse(params[1]) });
    return { rows: [{ id }] };
  }
  if (/^INSERT INTO project_reports /.test(text)) return { rows: [{ id: store.nextId++ }] };
  if (/^INSERT INTO project_report_versions /.test(text)) {
    const id = store.nextId++;
    store.versions.push({ id, reportId: params[0], payload: JSON.parse(params[1]) });
    return { rows: [{ id }] };
  }
  if (/^INSERT INTO project_report_sources /.test(text)) {
    const version = store.versions.at(-1);
    store.sources.set(params[4], { reportId: params[0], reportVersionId: version.id, transcriptSha256: params[4] });
    return { rows: [] };
  }
  if (/^INSERT INTO project_report_health /.test(text)) return { rows: [] };
  throw new Error(`Unexpected SQL in offline project-update test: ${text.slice(0, 100)}`);
}

// Use the real queue/persistence code against an in-memory SQL boundary.
// A real pg client is never constructed, even if the shell has DB settings.
process.env.DATABASE_URL = 'postgres://offline-project-update-test.invalid/db';
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'pg' && parent?.filename === dbPath) return { Pool: class {
    query(sql, params) { return query(sql, params); }
    async connect() { return { query, release() {} }; }
  } };
  return originalLoad.apply(this, arguments);
};
delete require.cache[dbPath];
const db = require('../utils/db');
Module._load = originalLoad;

function generator({ fallback = false } = {}) {
  const load = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent?.filename === generatorPath) {
      if (request === './db') return { ...db,
        updateGenerationJobProgress: async () => {},
        markGenerationJobCompleted: async (jobId, meetingId, response) => store.savedResponses.push(roundTrip(response)),
        markGenerationJobFailure: async (job, message) => { throw new Error(message); }
      };
      if (request === './knowledge') return { runProjectKnowledgeRetrieval: () => { throw new Error('Unexpected knowledge call'); } };
      if (request === './meetingMinutesGenerator') return {
        validateTranscriptText: value => assert.ok(value.trim()), transcriptMetadata: () => ({}),
        runPythonTranscriptScript: async script => {
          store.scripts.push(script);
          if (script === 'project_update_minilm.py') {
            if (fallback) throw new Error('Simulated primary failure');
            return { segments: [], actions: [{ action: 'Top-level analyser guess.' }],
              projectReport: { actions: [{ action: 'Report analyser guess.' }], risks: [] } };
          }
          if (script === 'python_llm.py') return { segments: [], actions: [{ action: 'Legacy fallback guess.' }] };
          throw new Error(`Unexpected provider/script call: ${script}`);
        }
      };
    }
    return load.apply(this, arguments);
  };
  delete require.cache[generatorPath];
  try { return require('../utils/projectUpdateGenerator'); }
  finally { Module._load = load; }
}

async function runJob(actions, { authority = true, fallback = false, fingerprint = hash('reviewed snapshot') } = {}) {
  const transcriptText = 'Minutes: Equipment review held 2026-10-21.\nMinutes: The inspection report is ready.';
  const queued = await db.queueProjectUpdateGeneration({ transcriptText, projectId: 7, projectName: 'Equipment',
    periodLabel: 'Q4 2026', source: authority ? 'meeting-minutes-agent' : 'project-update-test',
    minutesDraftId: authority ? '42' : '', minutesDraftRevision: authority ? 3 : null,
    minutesActions: actions, sourceFingerprint: fingerprint,
    skipContext: true, skipKnowledge: true, skipStatusDiagnostics: true });
  const payload = store.jobs.at(-1).inputPayload;
  const result = await generator({ fallback }).processProjectUpdateJob({ jobId: queued.jobId, meetingId: queued.meetingId,
    transcriptText, inputPayload: payload });
  assert.equal(result.ok, true);
  return { result: result.response.result, payload };
}

test.after(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalDbCache) require.cache[dbPath] = originalDbCache; else delete require.cache[dbPath];
  if (originalGeneratorCache) require.cache[generatorPath] = originalGeneratorCache; else delete require.cache[generatorPath];
});

test('the real queue, worker and persistence retain every reviewed action and literal timing', async () => {
  resetStore();
  const input = Array.from({ length: 250 }, (_, index) => ({ action: `Review equipment item ${index + 1}.`, owner: 'Sam', deadline: 'Not stated' }));
  input[0] = { action: 'Mix at a 1:100 ratio; inspect at 10:30.', owner: 'Sam, Jordan', deadline: 'Target: ideally Friday; fallback Monday' };
  input[1] = { action: 'File the report.', owner: 'Jordan', deadline: 'Dependent on: approval at 09:45' };
  const expected = minutesActionsForProjectReport(input);
  const { result, payload } = await runJob(expected);
  assert.equal(payload.minutesActions.length, 250);
  assert.deepEqual(result.projectReport.actions, expected);
  assert.deepEqual(result.actions, expected);
  assert.deepEqual(store.versions[0].payload.projectReport.actions, expected);
  assert.deepEqual(store.versions[0].payload.actions, expected);
  assert.equal(result.projectReport.actionsSource, 'meeting_minutes_agent');
  assert.equal(store.duplicateHashes[0], payload.sourceFingerprint);
  assert.deepEqual(store.scripts, ['project_update_minilm.py']);
});

test('empty reviewed actions stay empty through primary and fallback, while legacy jobs keep analyser actions', async () => {
  for (const fallback of [false, true]) {
    resetStore();
    const reviewed = await runJob([], { fallback });
    assert.deepEqual(reviewed.result.projectReport.actions, []);
    assert.deepEqual(reviewed.result.actions, []);
    assert.deepEqual(store.versions[0].payload.projectReport.actions, []);
    resetStore();
    const legacy = await runJob([], { authority: false, fallback });
    assert.equal(legacy.result.actions[0].action, fallback ? 'Legacy fallback guess.' : 'Top-level analyser guess.');
    if (!fallback) assert.equal(legacy.result.projectReport.actions[0].action, 'Report analyser guess.');
    assert.equal(store.duplicateHashes[0], hash('Minutes: Equipment review held 2026-10-21.\nMinutes: The inspection report is ready.'),
      'legacy callers do not gain a supplied minutes fingerprint');
  }
});

test('legacy Python fallback retains the complete reviewed action register in both report shapes', async () => {
  resetStore();
  const actions = minutesActionsForProjectReport([{ action: 'Send the inspection report.', owner: 'Sam', deadline: 'Target: Saturday morning probably (24 Oct 2026)' }]);
  const { result } = await runJob(actions, { fallback: true });
  assert.deepEqual(result.projectReport.actions, actions);
  assert.deepEqual(result.actions, actions);
  assert.deepEqual(store.versions[0].payload.projectReport.actions, actions);
  assert.deepEqual(store.scripts, ['project_update_minilm.py', 'python_llm.py']);
  assert.deepEqual(store.versions[0].payload.projectReport.analyserFallback,
    { used: true, script: 'python_llm.py', reason: 'Simulated primary failure' });
});

test('a report from the main analyser is not marked as a backup-analyser report', async () => {
  resetStore();
  const { result } = await runJob([], { fallback: false });
  assert.equal(result.projectReport.analyserFallback, undefined);
});

test('persistence distinguishes action-only snapshots and still deduplicates unchanged or ordinary transcript sources', async () => {
  resetStore();
  const transcriptText = 'Minutes: The inspection report is ready.';
  const before = [{ action: 'Send the report.', meetingActionPointOwner: 'Sam', deadline: 'Target: Friday' }];
  const after = [{ action: 'Send the report.', meetingActionPointOwner: 'Jordan', deadline: 'Target: Monday' }];
  const save = (actions, sourceFingerprint) => db.saveProjectUpdateDraft({ projectId: 7, projectName: 'Equipment', periodLabel: 'Q4 2026',
    transcriptText, sourceFingerprint, result: { projectReport: { actions } } });
  const identities = [before, after].map(actions => hash(JSON.stringify({ minutesText: transcriptText, minutesActions: actions })));
  assert.equal((await save(before, identities[0])).saved, true);
  assert.equal((await save(after, identities[1])).saved, true);
  assert.equal((await save(after, identities[1])).duplicate, true);
  assert.deepEqual(store.duplicateHashes.slice(0, 3), [identities[0], identities[1], identities[1]]);
  assert.equal(store.versions.length, 2);
  assert.deepEqual(store.versions[1].payload.projectReport.actions, after);
  assert.equal((await save(before, 'not-a-valid-fingerprint')).saved, true);
  assert.equal((await save(after, undefined)).duplicate, true);
  assert.deepEqual(store.duplicateHashes.slice(3), [hash(transcriptText), hash(transcriptText)]);
});
