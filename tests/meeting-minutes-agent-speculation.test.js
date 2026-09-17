'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1 = '1';
const api = require('../routes/api').stagedEvaluation;

const baseDraft = () => ({
  draftId: 'd1', transcriptSha256: 'abc', preparedTranscript: 'Jacqui: The tracker moved from thirteen to ten.',
  details: { meetingTitle: 'T733', meetingDate: '2026-06-17', internalAttendees: ['Jacqui Fox'], clientAttendees: ['Rebecca Gill'] },
  steer: '', salientDetails: [], discussion: [], actions: [], executiveSummary: '', staleStages: [], generation: null,
  updatedAt: new Date().toISOString()
});

test('the next speculative stage follows what the reviewer will ask for next', () => {
  const draft = baseDraft();
  assert.equal(api.meetingAgentNextSpeculativeStage(draft), 'discussion');
  draft.discussion = [{ topic: 'Tracker', points: [{ id: 'p1', text: 'Tracker moved.' }], decisions: [], openQuestions: [] }];
  assert.equal(api.meetingAgentNextSpeculativeStage(draft), 'actions');
  draft.actions = [{ id: 'a1', action: 'Update the tracker.', owners: ['Jacqui Fox'], timing: { kind: 'not_stated' } }];
  assert.equal(api.meetingAgentNextSpeculativeStage(draft), 'summary');
  draft.executiveSummary = 'The meeting reviewed the tracker.';
  assert.equal(api.meetingAgentNextSpeculativeStage(draft), '');
  draft.staleStages = ['actions'];
  assert.equal(api.meetingAgentNextSpeculativeStage(draft), 'actions', 'an outdated stage is the next one to run');
  draft.generation = { stage: 'actions', status: 'running', bootId: api.MEETING_AGENT_BOOT_ID, startedAt: new Date().toISOString() };
  assert.equal(api.meetingAgentNextSpeculativeStage(draft), '', 'nothing runs ahead while a real run is in flight');
});

test('the input fingerprint changes only when something the stage reads changes', () => {
  const draft = baseDraft();
  draft.discussion = [{ topic: 'Tracker', points: [{ id: 'p1', text: 'Tracker moved.', evidenceIds: ['T0001'] }], decisions: [], openQuestions: [] }];
  draft.actions = [{ id: 'a1', action: 'Update the tracker.', owners: ['Jacqui Fox'], timing: { kind: 'not_stated' } }];
  const fp = (d, stage) => api.meetingAgentStageInputFingerprint(d, stage);
  assert.equal(fp(draft, 'discussion'), fp({ ...draft }, 'discussion'));
  const reflagged = { ...draft, discussion: [{ ...draft.discussion[0], points: [{ ...draft.discussion[0].points[0], evidenceIds: ['T0002'], reviewFlagIds: ['f1'] }] }] };
  assert.equal(fp(draft, 'actions'), fp(reflagged, 'actions'), 'ids, flags and evidence are not inputs');
  const steered = { ...draft, steer: 'Focus on risk' };
  assert.notEqual(fp(draft, 'discussion'), fp(steered, 'discussion'));
  const edited = { ...draft, discussion: [{ ...draft.discussion[0], points: [{ id: 'p1', text: 'Tracker moved a lot.' }] }] };
  assert.equal(fp(draft, 'discussion'), fp(edited, 'discussion'), 'the discussion does not feed its own stage');
  assert.notEqual(fp(draft, 'actions'), fp(edited, 'actions'));
  assert.notEqual(fp(draft, 'summary'), fp(edited, 'summary'));
  const retimed = { ...draft, actions: [{ ...draft.actions[0], timing: { kind: 'deadline', text: 'Friday' } }] };
  assert.equal(fp(draft, 'actions'), fp(retimed, 'actions'), 'actions do not feed their own stage');
  assert.notEqual(fp(draft, 'summary'), fp(retimed, 'summary'));
});

test('a stage result applied virtually reads like the persisted draft would', () => {
  const draft = { ...baseDraft(), staleStages: ['actions', 'summary'], reviewFlags: [] };
  const result = { changes: { actions: [{ id: 'a1', action: 'Do it.' }], passCache: [], qualityState: { actions: {} } }, reviewFlags: [], replaceCoverageFlags: false };
  const virtual = api.applyStageResultVirtually(draft, 'actions', result);
  assert.deepEqual(virtual.actions, result.changes.actions);
  assert.deepEqual(virtual.staleStages, ['summary']);
  assert.equal(virtual.currentStep, 3);
  assert.equal(virtual.generation, null);
});

test('a real run adopts a ready speculation only while the inputs still match', async () => {
  const draft = baseDraft();
  const fingerprint = api.meetingAgentStageInputFingerprint(draft, 'discussion');
  const result = { changes: { discussion: [{ topic: 'Tracker', points: [], decisions: [], openQuestions: [] }] }, reviewFlags: [] };
  api.privateStageSpeculations.set('d1:discussion', {
    draftId: 'd1', stage: 'discussion', fingerprint, status: 'ready', result,
    startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), expiresAt: Date.now() + 60000, passCache: []
  });
  assert.equal(api.meetingAgentSpeculationState(draft)?.status, 'ready');
  const mismatched = { ...draft, steer: 'Different focus' };
  assert.equal(await api.adoptStageSpeculation(mismatched, 'discussion', 'd1', 'u1'), null, 'changed inputs are never adopted');
  assert.ok(api.privateStageSpeculations.has('d1:discussion'), 'a mismatch leaves the entry for its pass cache');
  const adopted = await api.adoptStageSpeculation(draft, 'discussion', 'd1', 'u1');
  assert.equal(adopted.result, result);
  assert.ok(!api.privateStageSpeculations.has('d1:discussion'), 'an adopted entry is consumed');
  api.privateStageSpeculations.set('d1:discussion', { draftId: 'd1', stage: 'discussion', fingerprint, status: 'failed', expiresAt: Date.now() + 60000 });
  assert.equal(await api.adoptStageSpeculation(draft, 'discussion', 'd1', 'u1'), null, 'a failed speculation falls through to a real run');
  api.privateStageSpeculations.clear();
});

test('with the flag off nothing runs ahead and nothing is reported', () => {
  process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1 = '0';
  try {
    assert.equal(api.startStageSpeculation(baseDraft(), 'u1'), null);
    assert.equal(api.meetingAgentSpeculationState(baseDraft()), null);
  } finally {
    process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1 = '1';
  }
});
