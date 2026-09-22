'use strict';

// Generic cases only: none of these sentences come from the evaluation corpus.
const test = require('node:test');
const assert = require('node:assert/strict');
const { explicitValuePresent, evidenceSupportScore } = require('../utils/meetingMinutesAgentV2');

test('a written figure is supported by its spoken form', () => {
  assert.ok(explicitValuePresent('2', 'thursday at two, then.'));
  assert.ok(explicitValuePresent('00', 'thursday at two, then.'));
  assert.ok(explicitValuePresent('22', 'eighteen of the twenty-two are in.'));
  assert.ok(explicitValuePresent('30', 'keep it to thirty seconds.'));
  assert.ok(explicitValuePresent('81%', 'coverage is eighty-one per cent.'));
  assert.ok(!explicitValuePresent('3', 'we need two more.'));
  assert.ok(!explicitValuePresent('45', 'about forty minutes.'));
});

test('an action with a normalised time keeps its evidence', () => {
  const evidence = "Dana: Thursday at two, then. Chair: Sam, will you put that in his calendar? Sam: I'll do it now.";
  assert.ok(evidenceSupportScore("Put the Thursday 2:00 PM review in the director's calendar.", evidence) > 0);
  assert.equal(evidenceSupportScore('Put the Thursday 3:00 PM review in the calendar.', evidence), 0);
});
