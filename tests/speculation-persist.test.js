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
