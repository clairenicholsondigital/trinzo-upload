'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  meetingAgentDerivedStaleStages,
  meetingAgentStaleStagesAfterGeneration,
  meetingAgentStageInputFingerprint
} = require('../routes/api').stagedEvaluation;

function draft() {
  return {
    details: {}, steer: '', staleStages: [],
    discussion: [{ topic: 'Report', points: [{
      id: 'p1', text: 'The report is ready.',
      supportingDetails: [{ id: 'd1', text: 'Three checks remain.' }]
    }], decisions: [], openQuestions: [] }],
    actions: [{ id: 'a1', action: 'Send the report.', owners: ['Alex'],
      timing: { kind: 'deadline', wording: 'Friday', exactDate: '2026-10-23' } }],
    executiveSummary: 'Alex will send the report on Friday.'
  };
}

test('action wording, owner, timing and deletion invalidate only the existing summary', () => {
  const before = draft();
  const action = before.actions[0];
  for (const actions of [
    [{ ...action, action: 'Check the report.' }],
    [{ ...action, owners: ['Sam'] }],
    [{ ...action, timing: { ...action.timing, wording: 'Monday' } }],
    [{ ...action, timing: { ...action.timing, exactDate: '2026-10-30' } }],
    []
  ]) assert.deepEqual(meetingAgentDerivedStaleStages(before, { ...before, actions }), ['summary']);
});

test('supporting-detail edits invalidate downstream output and speculative results', () => {
  const before = draft();
  const after = structuredClone(before);
  after.discussion[0].points[0].supportingDetails[0].text = 'Six checks remain.';
  assert.deepEqual(meetingAgentDerivedStaleStages(before, after), ['actions', 'summary']);
  for (const stage of ['actions', 'summary']) {
    assert.notEqual(meetingAgentStageInputFingerprint(before, stage), meetingAgentStageInputFingerprint(after, stage));
  }
});

test('normalising ids and evidence does not make unchanged downstream output stale', () => {
  const before = draft();
  const after = structuredClone(before);
  after.actions[0].id = 'new-action-id';
  after.actions[0].evidenceIds = ['T0001'];
  after.discussion[0].points[0].supportingDetails[0].id = 'new-detail-id';
  after.discussion[0].points[0].supportingDetails[0].reviewFlagIds = ['flag'];
  assert.deepEqual(meetingAgentDerivedStaleStages(before, after), []);
});

test('completed empty stages become stale after an upstream edit; ungenerated stages do not', () => {
  const before = { ...draft(), actions: [], executiveSummary: '', qualityState: {
    actions: { completedAt: '2026-10-17T12:00:00Z' },
    summary: { completedAt: '2026-10-17T12:01:00Z' }
  } };
  assert.deepEqual(meetingAgentDerivedStaleStages(before, { ...before, steer: 'Focus on checks.' }), ['actions', 'summary']);
  assert.deepEqual(meetingAgentDerivedStaleStages({ ...before, qualityState: {} }, { ...before, steer: 'Focus on checks.' }), []);
});

test('summary generated against older actions remains stale when those actions change during the run', () => {
  const before = draft();
  const after = { ...before, actions: [] };
  assert.deepEqual(meetingAgentStaleStagesAfterGeneration(after, before, 'summary'), ['summary']);
});

test('meeting-date and prepared-transcript changes invalidate output and in-flight generations', () => {
  const before = { ...draft(), details: { meetingDate: '2026-10-17' }, preparedTranscript: 'Original evidence.' };
  for (const after of [
    { ...before, details: { meetingDate: '2026-10-24' } },
    { ...before, preparedTranscript: 'Corrected evidence.' }
  ]) {
    assert.deepEqual(meetingAgentDerivedStaleStages(before, after), ['actions', 'summary']);
    for (const stage of ['actions', 'summary']) {
      assert.deepEqual(meetingAgentStaleStagesAfterGeneration(after, before, stage), [stage]);
    }
  }
});

test('regenerated actions invalidate an existing summary and clear their own stale marker', () => {
  const before = { ...draft(), staleStages: ['actions'] };
  assert.deepEqual(meetingAgentStaleStagesAfterGeneration(before, before, 'actions', { actions: [] }), ['summary']);
  assert.deepEqual(meetingAgentStaleStagesAfterGeneration(before, before, 'actions', { actions: before.actions }), []);
});
