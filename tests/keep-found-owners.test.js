'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { stagedEvaluation } = require('../routes/api');
const { reconstructRefereeActions, borrowOwnersFromTwin } = stagedEvaluation;

const UNITS = [
  { id: 'T0001', sequence: 1, speaker: 'Jacqui Fox', timestamp: '00:10', text: 'Andrew, complete your review of the MDD documentation and the testing.' },
  { id: 'T0002', sequence: 2, speaker: 'Andrew Kane', timestamp: '00:15', text: 'Yes, I will complete the MDD documentation review and start the testing next week.' }
];
// What the referee is shown: compacted candidates, owners at the top level.
const recovery = { candidateId: 'rec-1', sourcePass: 'recovery', recordType: 'action', priority: 5, sequence: 1,
  text: 'Complete the review of the MDD documentation and the required testing.', owners: [], timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0001'] };
// What sits in the wider ensemble: the discovery record, with its owner.
const primary = { candidateId: 'pri-1', sourcePass: 'primary', recordType: 'action', priority: 14, sequence: 1,
  text: 'Complete the review of the MDD documentation and the testing.', evidenceIds: ['T0001', 'T0002'],
  record: { id: 'pri-1', action: 'Complete the review of the MDD documentation and the testing.', owners: ['Andrew Kane'], timing: { kind: 'target', wording: 'next week', exactDate: '' }, evidenceIds: ['T0001', 'T0002'] } };
const unrelated = { candidateId: 'pri-2', sourcePass: 'primary', recordType: 'action', priority: 14, sequence: 3,
  text: 'Book the hotel for the audit week.', evidenceIds: ['T0002'], record: { id: 'pri-2', action: 'Book the hotel for the audit week.', owners: ['Jacqui Fox'], timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0002'] } };

test('an ownerless published candidate takes the owner from its owned twin in the ensemble', () => {
  const { actions } = reconstructRefereeActions([{ candidateId: 'rec-1', disposition: 'publish', evidenceIds: ['T0001'] }], [recovery], UNITS, { ownerPool: [primary, unrelated] });
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0].owners, ['Andrew Kane']);
  assert.ok(actions[0].evidenceIds.includes('T0002'), 'and cites the line where Andrew takes it on');
});

test('an unrelated owned record is not a twin', () => {
  const borrowed = borrowOwnersFromTwin(recovery, [unrelated]);
  assert.equal(borrowed, null);
});

test('a candidate that already has an owner keeps it', () => {
  const owned = { ...recovery, owners: ['Jacqui Fox'] };
  const { actions } = reconstructRefereeActions([{ candidateId: 'rec-1', disposition: 'publish', evidenceIds: ['T0001'] }], [owned], UNITS, { ownerPool: [primary] });
  assert.deepEqual(actions[0].owners, ['Jacqui Fox']);
});

test('a referee that names an owner is believed before any twin is consulted', () => {
  const { actions } = reconstructRefereeActions([{ candidateId: 'rec-1', disposition: 'publish', owners: ['Andrew Kane'], evidenceIds: ['T0001', 'T0002'] }], [recovery], UNITS, {});
  assert.deepEqual(actions[0].owners, ['Andrew Kane']);
});

test('proposals are left alone: only published actions borrow', () => {
  const { actionProposals } = reconstructRefereeActions([{ candidateId: 'rec-1', disposition: 'proposal', evidenceIds: ['T0001'] }], [recovery], UNITS, { ownerPool: [primary] });
  assert.equal(actionProposals.length, 1);
  assert.deepEqual(actionProposals[0].owners, []);
});
