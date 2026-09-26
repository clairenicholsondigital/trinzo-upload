'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { stagedEvaluation } = require('../routes/api');

const { normaliseAgentCandidateDispositions } = stagedEvaluation;
const UNITS = [{ id: 'T0001', speaker: 'Alex Reed', timestamp: '00:10', text: 'I will send the report.' }];

function dispositions(items) {
  return normaliseAgentCandidateDispositions({ candidateDispositions: items }, UNITS);
}

test('the contract vocabulary passes through unchanged', () => {
  const result = dispositions([
    { candidateId: 'c1', disposition: 'publish' },
    { candidateId: 'c2', disposition: 'proposal' },
    { candidateId: 'c3', disposition: 'reject' }
  ]);
  assert.deepEqual(result.map((item) => item.disposition), ['publish', 'proposal', 'reject']);
  // Nothing to report when the model said what it was asked to say.
  assert.deepEqual(result.map((item) => item.rawDisposition), ['', '', '']);
});

test('unambiguous synonyms are mapped, and say what they came from', () => {
  const result = dispositions([
    { candidateId: 'c1', disposition: 'core' },
    { candidateId: 'c2', disposition: 'rejected' },
    { candidateId: 'c3', disposition: 'complete' }
  ]);
  assert.deepEqual(result.map((item) => item.disposition), ['publish', 'reject', 'completed']);
  assert.deepEqual(result.map((item) => item.rawDisposition), ['core', 'rejected', 'complete']);
});

test('an invented label is kept and recorded rather than discarded', () => {
  // The critic answered on 724 candidates across the stored corpus and was
  // heard on 10; this is that judgement surviving.
  const result = dispositions([
    { candidateId: 'c1', disposition: 'not_an_action', reason: 'Self-executing in the meeting.' }
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].disposition, 'unclassified');
  assert.equal(result[0].rawDisposition, 'not_an_action');
  assert.match(result[0].reason, /Self-executing/);
});

test('an unclassified disposition counts towards nothing the reviewer sees', () => {
  // The point of keeping it is to be able to read it, not to act on it. If an
  // invented label could publish or propose, an unreviewed model vocabulary
  // would be steering the minutes.
  const result = dispositions([
    { candidateId: 'c1', disposition: 'promoted_to_action', action: 'Send the report.' },
    { candidateId: 'c2', disposition: 'accepted_as_proposal', action: 'Maybe send it.' }
  ]);
  assert.deepEqual(result.map((item) => item.disposition), ['unclassified', 'unclassified']);
  assert.equal(result.some((item) => ['publish', 'proposal'].includes(item.disposition)), false);
  // The model's own action text is not carried into the record either.
  assert.equal(result.some((item) => 'action' in item), false);
});

test('a disposition without a candidate id is still dropped', () => {
  assert.deepEqual(dispositions([{ disposition: 'publish' }, { candidateId: '', disposition: 'reject' }]), []);
});

test('evidence ids are limited to units that exist', () => {
  const result = dispositions([{ candidateId: 'c1', disposition: 'publish', evidenceIds: ['T0001', 'T9999', 'T0001'] }]);
  assert.deepEqual(result[0].evidenceIds, ['T0001']);
});
