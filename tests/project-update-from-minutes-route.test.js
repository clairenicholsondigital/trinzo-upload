'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../utils/db');
let savedDraft;
let selectedProject;
const queued = [];
const reads = [];
const originals = {};
const stubs = {
  getMeetingMinutesAgentDraft: async (id, userId) => {
    reads.push({ id, userId });
    return userId === 'reviewer' && savedDraft ? structuredClone(savedDraft) : null;
  },
  getProjectManagementDetail: async () => selectedProject,
  queueProjectUpdateGeneration: async (payload) => {
    queued.push(structuredClone(payload));
    return { jobId: 'offline-job' };
  }
};
for (const [key, stub] of Object.entries(stubs)) { originals[key] = db[key]; db[key] = stub; }
const router = require('../routes/api');
for (const [key, original] of Object.entries(originals)) db[key] = original;
const route = router.stack.find(layer => layer.route?.path === '/project-update-test/from-minutes').route;
const handler = route.stack.at(-1).handle;

function reset() {
  selectedProject = { projectId: 17, projectName: 'Selected project' };
  queued.length = 0;
  reads.length = 0;
  savedDraft = {
    draftId: '123', revision: 4, status: 'complete', payloadVersion: 5,
    details: { meetingTitle: 'Supplier planning', meetingDate: '2026-10-21', meetingType: 'General' },
    preparedTranscript: 'Sam: The inspection is ready. I will send the inspection report probably Friday morning.',
    sourceUnits: [{ id: 'T0001', speaker: 'Sam', text: 'The inspection is ready. I will send the inspection report probably Friday morning.' }],
    discussion: [{ id: 'topic', topic: 'Inspection', reviewerAuthored: true, points: [
      { id: 'point', text: 'The inspection is ready.', evidenceIds: ['T0001'], reviewerAuthored: true }
    ], decisions: [], openQuestions: [] }],
    actions: [{ id: 'send', action: 'Send the inspection report.', owners: ['Sam'], reviewerAuthored: true,
      evidenceIds: ['T0001'], timing: { kind: 'target', wording: 'probably Friday morning', exactDate: '2026-10-23' } }],
    reviewFlags: [], staleStages: [], qualityState: { preparation: { dateContext: { source: 'reviewer', meetingDate: '2026-10-21' } } }
  };
}

async function request(body = {}, userId = 'reviewer') {
  const response = { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; } };
  await handler({ body: { draftId: '123', projectId: 17, revision: 4, ...body }, authUser: { userId, email: 'offline@example.test' } }, response);
  return response;
}

test('queues the owned saved publication with reviewed timing and canonical selected project', async () => {
  reset();
  const response = await request({ projectName: 'Stale or forged name' });
  assert.equal(response.statusCode, 202, JSON.stringify(response.body));
  assert.deepEqual(reads, [{ id: '123', userId: 'reviewer' }]);
  assert.equal(queued.length, 1);
  const input = queued[0];
  assert.equal(input.projectName, 'Selected project');
  assert.equal(input.minutesDraftRevision, 4);
  assert.equal(input.minutesDraftId, '123');
  assert.equal(input.minutesActions[0].deadline, 'Target: probably Friday morning (23 Oct 2026)');
  assert.doesNotMatch(input.transcriptText, /Action: I will/);
  assert.equal(input.transcriptSha256, input.sourceFingerprint);
  assert.match(input.sourceFingerprint, /^[a-f0-9]{64}$/);
});

test('rejects invalid identities, stale revisions, unavailable projects and other users before queueing', async () => {
  reset();
  for (const invalid of [{ draftId: 'x' }, { projectId: -1 }, { projectId: 1.5 }, { projectId: 'Infinity' },
    { revision: undefined }, { revision: 0 }, { revision: 1.5 }]) {
    assert.equal((await request(invalid)).statusCode, 400, JSON.stringify(invalid));
  }
  assert.equal((await request({ revision: 3 })).statusCode, 409);
  assert.equal((await request({}, 'other-user')).statusCode, 404);
  selectedProject = null;
  assert.equal((await request()).statusCode, 404);
  assert.equal(queued.length, 0);
});

test('blocks in-progress minutes and pending generated changes, but does not require an arbitrary completion flag', async () => {
  reset();
  for (const status of ['queued', 'running', 'retrying']) {
    savedDraft.generation = { status, stage: 'actions', bootId: router.stagedEvaluation.MEETING_AGENT_BOOT_ID, startedAt: new Date().toISOString() };
    assert.equal((await request()).statusCode, 409);
  }
  delete savedDraft.generation;
  savedDraft.pendingProposal = { stage: 'actions', changes: [{ id: 'pending', type: 'add', after: savedDraft.actions[0] }] };
  assert.equal((await request()).statusCode, 409);
  savedDraft.pendingProposal = null;
  savedDraft.status = 'draft';
  assert.equal((await request()).statusCode, 202);
  assert.equal(queued.length, 1);
});

test('the handoff uses the editor effective generation state for completed or interrupted historical runs', async () => {
  reset();
  const now = Date.now();
  savedDraft.generation = { status: 'running', stage: 'actions', bootId: router.stagedEvaluation.MEETING_AGENT_BOOT_ID,
    startedAt: new Date(now - 1000).toISOString() };
  savedDraft.qualityState.actions = { completedAt: new Date(now).toISOString() };
  assert.equal((await request()).statusCode, 202, 'persisted completion supersedes its leftover running marker');
  savedDraft.generation.startedAt = new Date(now + 1000).toISOString();
  assert.equal((await request()).statusCode, 409, 'a newer run is genuinely active');
  savedDraft.qualityState.actions.completedAt = 'invalid';
  assert.equal((await request()).statusCode, 409, 'an invalid completion date cannot hide an active run');
  savedDraft.generation.bootId = 'a-prior-server-boot';
  assert.equal((await request()).statusCode, 202, 'interrupted work is represented the same way as in the editor');
});

test('action-only wording, owner, timing and removals participate in source identity', async () => {
  reset();
  await request();
  const initial = queued.at(-1).sourceFingerprint;
  savedDraft.actions[0].owners = ['Riley'];
  await request();
  assert.notEqual(queued.at(-1).sourceFingerprint, initial);
  savedDraft.actions[0].timing.wording = 'probably Monday morning';
  savedDraft.actions[0].timing.exactDate = '2026-10-26';
  await request();
  assert.notEqual(queued.at(-1).sourceFingerprint, queued.at(-2).sourceFingerprint);
  savedDraft.actions[0].action = 'Send the updated inspection report.';
  await request();
  assert.notEqual(queued.at(-1).sourceFingerprint, queued.at(-2).sourceFingerprint);
  savedDraft.actions = [];
  await request();
  assert.deepEqual(queued.at(-1).minutesActions, []);
  assert.notEqual(queued.at(-1).sourceFingerprint, queued.at(-2).sourceFingerprint);
  const withoutActions = queued.at(-1).sourceFingerprint;
  savedDraft.revision = 5;
  await request({ revision: 5 });
  assert.equal(queued.at(-1).sourceFingerprint, withoutActions, 'revision-only saves must still deduplicate');
});

test('action-only minutes supply meaningful analyser context and empty minutes cannot queue', async () => {
  reset();
  savedDraft.discussion = [];
  assert.equal((await request()).statusCode, 202);
  assert.match(queued[0].transcriptText, /Action: I will send the inspection report/);
  savedDraft.actions = [];
  assert.equal((await request()).statusCode, 400);
  assert.equal(queued.length, 1);
});
