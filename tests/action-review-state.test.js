'use strict';

// Generic cases only: none of these sentences come from the evaluation corpus.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normaliseKeptActionIds,
  normaliseRemovedAction,
  normaliseRemovedActions,
  actionReviewCounts
} = require('../utils/actionReviewState');

const actions = [
  { id: 'a1', action: 'Send the floor plan to the landlord.' },
  { id: 'a2', action: 'Order the replacement tap.' }
];

test('a kept id survives only while its action is still in the register', () => {
  assert.deepEqual(normaliseKeptActionIds(['a1', 'a2'], actions), ['a1', 'a2']);
  // a3 was removed, or regenerated away: counting it would understate the work left.
  assert.deepEqual(normaliseKeptActionIds(['a1', 'a3'], actions), ['a1']);
  assert.deepEqual(normaliseKeptActionIds(['a1', 'a1'], actions), ['a1'], 'no duplicates');
  assert.deepEqual(normaliseKeptActionIds(null, actions), []);
});

test('a removed row keeps what is needed to show it and put it back', () => {
  const row = normaliseRemovedAction({
    id: 'a9', action: '  Book   the   hall.  ', owners: ['Dana', ''],
    timing: { kind: 'deadline', wording: 'by Friday', exactDate: '2026-08-14' },
    evidenceIds: ['T0004', ''], removedAt: '2026-09-24T10:00:00.000Z'
  });
  assert.equal(row.action, 'Book the hall.');
  assert.deepEqual(row.owners, ['Dana']);
  assert.equal(row.timing.kind, 'deadline');
  assert.equal(row.timing.exactDate, '2026-08-14');
  assert.deepEqual(row.evidenceIds, ['T0004']);
});

test('a row with no wording is not a removal', () => {
  assert.equal(normaliseRemovedAction({ id: 'a9', action: '   ' }), null);
});

test('an unusable timing or date falls back rather than being trusted', () => {
  const row = normaliseRemovedAction({ action: 'Check the roof.', timing: { kind: 'whenever', exactDate: 'next week' } });
  assert.equal(row.timing.kind, 'not_stated');
  assert.equal(row.timing.exactDate, '');
  assert.match(row.removedAt, /^\d{4}-\d{2}-\d{2}T/, 'a missing timestamp is stamped now');
});

test('rejecting, restoring and rejecting again does not stack duplicates', () => {
  const rows = normaliseRemovedActions([
    { id: 'a1', action: 'Book the hall.' },
    { id: 'a1', action: 'Book the hall.' }
  ]);
  assert.equal(rows.length, 1);
});

test('the counts say how much work is left, not just what was done', () => {
  const counts = actionReviewCounts(actions, ['a1'], [{ id: 'a7', action: 'Confirm the caterer.' }], {
    changes: [{ type: 'add' }, { type: 'remove' }, { type: 'add' }]
  });
  assert.deepEqual(counts, { inRegister: 2, kept: 1, undecided: 1, removed: 1, proposed: 2 });
});

test('with nothing reviewed, every action is still undecided', () => {
  const counts = actionReviewCounts(actions, [], [], null);
  assert.equal(counts.undecided, 2);
  assert.equal(counts.proposed, 0);
});
