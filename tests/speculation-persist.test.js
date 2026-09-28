'use strict';

// Generic cases only: none of these sentences come from the evaluation corpus.
const test = require('node:test');
const assert = require('node:assert/strict');
const { meetingAgentStageHasContent } = require('../routes/api').stagedEvaluation;

test('a stage holds content only when it actually has some', () => {
  assert.equal(meetingAgentStageHasContent({ discussion: [] }, 'discussion'), false);
  assert.equal(meetingAgentStageHasContent({ discussion: [{ id: 't1' }] }, 'discussion'), true);
  assert.equal(meetingAgentStageHasContent({ actions: [] }, 'actions'), false);
  assert.equal(meetingAgentStageHasContent({ actions: [{ id: 'a1' }] }, 'actions'), true);
});

test('a summary counts as content only once there is something to read', () => {
  assert.equal(meetingAgentStageHasContent({ executiveSummary: '' }, 'summary'), false);
  assert.equal(meetingAgentStageHasContent({ executiveSummary: '   ' }, 'summary'), false);
  assert.equal(meetingAgentStageHasContent({
    executiveSummary: 'The team agreed the scope and set a date for the review.'
  }, 'summary'), true);
});

test('an unknown stage is treated as occupied, so nothing is written blind', () => {
  // The guard fails closed: a stage this code does not understand is never
  // filled in from a speculative result.
  assert.equal(meetingAgentStageHasContent({}, ''), true);
  assert.equal(meetingAgentStageHasContent({}, 'something-new'), true);
});

// Draft 1051 (a parking meeting where nobody takes anything on) finished its
// Actions run with no rows. Read as "never run", the stage was speculated
// again and the same empty result written over it, moving the revision under
// the reviewer's tab until Create summary was refused as "updated elsewhere".
test('a stage that ran and found nothing is settled, so it is not written over', () => {
  const ranEmpty = { actions: [], qualityState: { actions: { completedAt: '2026-09-28T11:58:55.834Z' } } };
  assert.equal(meetingAgentStageHasContent(ranEmpty, 'actions'), true);
  assert.equal(meetingAgentStageHasContent({ actions: [], qualityState: { actions: {} } }, 'actions'), false);
  assert.equal(meetingAgentStageHasContent({ discussion: [], qualityState: { discussion: { completedAt: '2026-09-28T11:57:31.211Z' } } }, 'discussion'), true);
  assert.equal(meetingAgentStageHasContent({ executiveSummary: '', qualityState: { summary: { completedAt: '2026-09-28T12:02:08.013Z' } } }, 'summary'), true);
});

test('after an empty Actions run the next stage to prepare is the summary', () => {
  const { meetingAgentNextSpeculativeStage } = require('../routes/api').stagedEvaluation;
  const draft = {
    discussion: [{ id: 't1', topic: 'Visitor parking', points: [{ id: 'p1', text: 'Every option has a hole in it.' }] }],
    actions: [], executiveSummary: '', staleStages: [],
    qualityState: { discussion: { completedAt: '2026-09-28T11:58:03.082Z' }, actions: { completedAt: '2026-09-28T11:58:55.834Z' } }
  };
  assert.equal(meetingAgentNextSpeculativeStage(draft), 'summary');
  // Marked outdated, the empty run is redone like any other.
  assert.equal(meetingAgentNextSpeculativeStage({ ...draft, staleStages: ['actions'] }), 'actions');
  // Never run: still the stage to prepare.
  assert.equal(meetingAgentNextSpeculativeStage({ ...draft, qualityState: { discussion: draft.qualityState.discussion } }), 'actions');
});
