'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MINIMUM_ACTION_WORDS,
  actionWordCount,
  filterActionsForPresentation
} = require('../utils/stagedActionPresentation');

test('the global action presentation minimum is three words inclusive', () => {
  assert.equal(MINIMUM_ACTION_WORDS, 3);
  assert.equal(actionWordCount('Check'), 1);
  assert.equal(actionWordCount('Check report'), 2);
  assert.equal(actionWordCount('Check the report'), 3);
  assert.equal(actionWordCount('Follow-up with Keon'), 3);
});

test('only actions with at least three words reach the UI', () => {
  const actions = [
    { action: 'Check' },
    { action: 'Do thinking' },
    { action: 'Check the report' },
    { meetingActionPoint: 'Send final client report' }
  ];
  assert.deepEqual(filterActionsForPresentation(actions), actions.slice(2));
});
