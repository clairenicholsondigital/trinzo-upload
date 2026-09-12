'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  batchRefereeCandidates,
  normaliseRefereeDispositions,
  normaliseReferenceArrays
} = require('../utils/refereeNormaliser');

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

test('normalises typed reference objects and preserves legacy string arrays', () => {
  const result = normaliseReferenceArrays({
    discussion: [{
      evidenceRefs: [{ id: 'T0001' }, { id: 'T0001' }, { id: 'T9999' }],
      reviewFlagRefs: [{ id: 'flag-1' }, { id: 'flag-1' }]
    }],
    actions: [{ owners: ['Alex'], ownerRefs: [{ name: 'Alex' }, { name: 'Priya' }] }]
  }, { validEvidenceIds: ['T0001'], validOwners: ['Alex', 'Priya'] });
  assert.deepEqual(result.discussion[0].evidenceIds, ['T0001']);
  assert.deepEqual(result.discussion[0].reviewFlagIds, ['flag-1']);
  assert.deepEqual(result.actions[0].owners, ['Alex', 'Priya']);
  assert.equal(result.discussion[0].evidenceRefs, undefined);
});

test('adds a visible warning when every supplied evidence reference is invalid', () => {
  const result = normaliseReferenceArrays({ discussion: [{ evidenceRefs: [{ id: 'T9999' }] }] }, { validEvidenceIds: ['T0001'] });
  assert.deepEqual(result.discussion[0].evidenceIds, []);
  assert.equal(result.reviewFlags[0].type, 'invalid_evidence_references');
});
