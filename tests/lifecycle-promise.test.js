'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { quoteIsOnlyAPromise } = require('../utils/meetingMinutesAgentV2');

test('a promise is not evidence that work is finished', () => {
  assert.ok(quoteIsOnlyAPromise("Dana: I'll do it now while I'm thinking about it."));
  assert.ok(quoteIsOnlyAPromise('Let me send that across after this.'));
  assert.ok(!quoteIsOnlyAPromise("I've sent it already."));
  assert.ok(!quoteIsOnlyAPromise("Done, it's in his calendar."));
  assert.ok(!quoteIsOnlyAPromise('That was signed off last week.'));
});
