'use strict';

// Generic cases only: none of these sentences come from the evaluation corpus.
const test = require('node:test');
const assert = require('node:assert/strict');
const { splitCompoundActionList } = require('../routes/api').stagedEvaluation;

const row = (action, timing = { kind: 'not_stated', wording: '', exactDate: '' }) => ({
  id: 'a1', action, owners: ['Sam'], timing, evidenceIds: ['T0001'], reviewFlagIds: []
});

test('a comma-listed series of instructions becomes one action each, timing on its own clause', () => {
  const rows = splitCompoundActionList([row(
    'Fix the chart colours on the pricing slide, add the signup link to the last slide, and send the deck round on Friday.',
    { kind: 'deadline', wording: 'on Friday', exactDate: '2026-03-13' })]);
  assert.deepEqual(rows.map((r) => r.action), [
    'Fix the chart colours on the pricing slide.',
    'Add the signup link to the last slide.',
    'Send the deck round on Friday.'
  ]);
  assert.equal(rows[0].id, 'a1');
  assert.equal(rows[0].timing.kind, 'not_stated');
  assert.equal(rows[2].timing.exactDate, '2026-03-13');
  assert.ok(rows.every((r) => r.owners[0] === 'Sam'));
});

test('one piece of work with two steps, or a clause pointing back, stays whole', () => {
  assert.equal(splitCompoundActionList([row('Build the closing slide and send it to Priya.')]).length, 1);
  assert.equal(splitCompoundActionList([row('Review the draft policy, and send it to Jo for sign-off.')]).length, 1);
  assert.equal(splitCompoundActionList([row('Monitor the chat, grouping questions and feeding them to the host.')]).length, 1);
});
