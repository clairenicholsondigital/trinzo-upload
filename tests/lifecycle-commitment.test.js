'use strict';

// Generic cases only: none of these sentences come from the evaluation corpus.
const test = require('node:test');
const assert = require('node:assert/strict');
const { itemHasExplicitOutstandingEvidence, applyFinalActionLifecycleResults } = require('../utils/meetingMinutesAgentV2');

test('a first-person commitment with a time for it keeps the action outstanding', () => {
  const item = { id: 'L1', index: 0, action: 'Send the signed venue contract to Priya.',
    passage: "Chair: Thanks all. I have the signed venue contract here, so I'll get that over to you today, Priya." };
  assert.equal(itemHasExplicitOutstandingEvidence(item), true);
  const result = applyFinalActionLifecycleResults([{ action: item.action }], [item],
    [{ id: 'L1', verdict: 'not_outstanding', evidenceQuote: 'I have the signed venue contract here' }]);
  assert.equal(result.actions.length, 1, 'kept on the published list');
  assert.equal(result.withheld.length, 0);
});

test('a commitment about different work, or with no time for it, does not override the verdict', () => {
  assert.equal(itemHasExplicitOutstandingEvidence({ action: 'Send the signed venue contract to Priya.',
    passage: "Chair: I'll book the caterer tomorrow." }), false);
  assert.equal(itemHasExplicitOutstandingEvidence({ action: 'Send the signed venue contract to Priya.',
    passage: 'Chair: I sent the signed venue contract to Priya on Monday.' }), false);
});
