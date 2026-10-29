'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../utils/db');
let savedDraft;
let selectedProject;
const queued = [];
const reads = [];
const links = [];
let existingUpdate = null;
const originals = {};
const stubs = {
  getMeetingMinutesAgentDraft: async (id, userId) => {
    reads.push({ id, userId });
    return userId === 'reviewer' && savedDraft ? structuredClone(savedDraft) : null;
  },
  getProjectManagementDetail: async () => selectedProject,
  linkMeetingMinutesAgentDraftToProject: async (draftId, userId, projectId) => {
    links.push({ draftId, userId, projectId });
    return { draftId: String(draftId), projectId };
  },
  saveProjectReportDetail: async (reportId, payload) => ({ reportId, savedBy: payload.savedBy }),
  queueProjectUpdateGeneration: async (payload) => {
    if (existingUpdate) return { duplicate: true, ...existingUpdate };
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
  links.length = 0;
  existingUpdate = null;
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

test('flat Beta minutes hand off the saved discussion and accepted register without promoting suggested work', async () => {
  reset();
  savedDraft.generationProvider = 'parallel-specialists-v1';
  savedDraft.executiveSummary = 'Local transport remains provisional.';
  const transport = 'Niamh anticipated hiring a car and also expected to rely on colleagues for local transport.';
  const schedule = 'The reporting plan remains subject to site access.';
  savedDraft.discussion = [{ id: 'flat', topic: 'Discussion', hideHeading: true,
    points: [{ id: 'DI1', text: transport, evidenceIds: ['T0001'] },
      { id: 'DI2', text: schedule, evidenceIds: ['T0001'] }], decisions: [], openQuestions: [] }];
  savedDraft.actions = [{ id: 'A1', action: 'Send the site-access confirmation.', owners: ['Sam', 'Jordan'],
    evidenceIds: ['T0001'], timing: { kind: 'dependency', wording: 'once approval is received', exactDate: '' } }];
  savedDraft.parallelActionProposals = [{ id: 'AP1', status: 'open', action: 'Book the hire car.',
    owners: [], timing: { kind: 'not_stated', wording: '', exactDate: '' },
    evidenceIds: ['T0001'], reason: 'No accepted booking commitment.' }];
  savedDraft.qualityState.parallel = { completedAt: new Date().toISOString() };
  const snapshot = structuredClone(savedDraft);
  const response = await request();
  assert.equal(response.statusCode, 202, JSON.stringify(response.body));
  assert.equal(queued.length, 1);
  const input = queued[0];
  assert.ok(input.transcriptText.includes(`Minutes: ${transport}`));
  assert.ok(input.transcriptText.includes(`Minutes: ${schedule}`));
  assert.doesNotMatch(input.transcriptText, /Minutes: Discussion:|Book the hire car/);
  assert.deepEqual(input.minutesActions, [{ action: 'Send the site-access confirmation.', related_milestone: 'unlinked',
    meetingActionPointOwner: 'Sam, Jordan', actionConfidence: 1,
    deadline: 'Dependent on: once approval is received', source: 'meeting_minutes_agent' }]);
  assert.equal(input.minutesDraftId, '123');
  assert.equal(input.minutesDraftRevision, 4);
  assert.equal(input.projectId, 17);
  assert.deepEqual(links, [{ draftId: '123', userId: 'reviewer', projectId: 17 }]);
  assert.deepEqual(savedDraft, snapshot, 'report creation does not rewrite the reviewed Beta minutes');
});

test('Beta handoff waits for the current three-specialist generation before queueing', async () => {
  reset();
  savedDraft.generationProvider = 'parallel-specialists-v1';
  savedDraft.generation = { status: 'running', stage: 'discussion', startedAt: new Date().toISOString() };
  const response = await request();
  assert.equal(response.statusCode, 409);
  assert.equal(queued.length, 0);
  assert.equal(links.length, 0);
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

test('tags the minutes with the project and refuses a second update from identical minutes', async () => {
  reset();
  assert.equal((await request()).statusCode, 202);
  assert.deepEqual(links, [{ draftId: '123', userId: 'reviewer', projectId: 17 }]);

  existingUpdate = { kind: 'report', reportId: 88 };
  const duplicate = await request();
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(duplicate.body.existingUrl, '/project-update-test/reports/88');

  existingUpdate = { kind: 'job', jobId: 41 };
  const inFlight = await request();
  assert.equal(inFlight.statusCode, 409);
  assert.equal(inFlight.body.existingUrl, '/jobs/41');
  assert.equal(queued.length, 1);
});

const linkRoute = router.stack.find(layer => layer.route?.path === '/meeting-minutes-agent/drafts/:draftId/project-link').route;
const linkHandler = linkRoute.stack.at(-1).handle;

test('the project-link route validates input and only links the signed-in user\'s minutes', async () => {
  reset();
  async function link(params, body, userId = 'reviewer') {
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; return this; } };
    await linkHandler({ params, body, authUser: { userId } }, response);
    return response;
  }
  assert.equal((await link({ draftId: 'x' }, { projectId: 17 })).statusCode, 400);
  assert.equal((await link({ draftId: '123' }, { projectId: 0 })).statusCode, 400);
  const ok = await link({ draftId: '123' }, { projectId: 17 });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.deepEqual(links.at(-1), { draftId: '123', userId: 'reviewer', projectId: 17 });
  selectedProject = null;
  assert.equal((await link({ draftId: '123' }, { projectId: 17 })).statusCode, 404);
});

const reportPatchRoute = router.stack.find(layer => layer.route?.path === '/project-update-test/reports/:reportId' && layer.route.methods.patch).route;
const reportPatchHandler = reportPatchRoute.stack.at(-1).handle;

test('saving or approving a report records the signed-in user, not a name from the request', async () => {
  async function patch(authUser) {
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; return this; } };
    await reportPatchHandler({ params: { reportId: '5' }, body: { reportStatus: 'approved', savedBy: 'Forged name' }, authUser }, response);
    return response.body.report.savedBy;
  }
  assert.equal(await patch({ userId: 1, email: 'claire@example.test', fullName: 'Claire N' }), 'Claire N');
  assert.equal(await patch({ userId: 1, email: 'claire@example.test', fullName: '' }), 'claire@example.test');
});
