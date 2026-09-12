'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { batchRefereeCandidates, normaliseRefereeDispositions } = require('../utils/refereeNormaliser');

test('normalises core and attaches supporting rows to the closest core', () => {
  const rows = normaliseRefereeDispositions([
    { candidateId: 'c1', disposition: 'core', text: 'Audit plan' },
    { candidateId: 's1', disposition: 'supporting', text: 'Audit plan timing' },
    { candidateId: 'c2', disposition: 'core', text: 'Training pack' }
  ]);
  assert.equal(rows[0].targetId, 'c1');
  assert.equal(rows[1].targetId, 'c1');
  assert.equal(rows[2].targetId, 'c2');
});

test('batches all candidates without a global fourteen-item cap', () => {
  const candidates = Array.from({ length: 23 }, (_, index) => ({ candidateId: `c${index + 1}` }));
  const batches = batchRefereeCandidates(candidates, 5);
  assert.deepEqual(batches.map((batch) => batch.length), [5, 5, 5, 5, 3]);
  assert.equal(batches.flat().length, 23);
});
