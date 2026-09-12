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

test('converts flat discussion candidates and evidence links into the website contract', () => {
  const result = normaliseReferenceArrays({
    discussionCandidates: [
      { candidateId: 'c1', topic: 'Audit scope', recordType: 'point', text: 'The audit scope is confirmed.', confidence: 'high' },
      { candidateId: 'c2', topic: 'Audit scope', recordType: 'point', text: 'The standard requires evidence.', confidence: 'high' }
    ],
    evidenceLinks: [
      { candidateId: 'c1', evidenceId: 'T0001' },
      { candidateId: 'c1', evidenceId: 'T0001' },
      { candidateId: 'c1', evidenceId: 'T9999' },
      { candidateId: 'orphan', evidenceId: 'T0001' }
    ],
    reviewFlags: []
  }, { validEvidenceIds: ['T0001'] });
  assert.equal(result.discussion.length, 1);
  assert.deepEqual(result.discussion[0].points.map((point) => point.id), ['c1', 'c2']);
  assert.deepEqual(result.discussion[0].points[0].evidenceIds, ['T0001']);
  assert.deepEqual(result.discussion[0].points[1].evidenceIds, []);
  assert.equal(result.evidenceLinks, undefined);
  assert.equal(result.discussionCandidates, undefined);
});

test('reattaches server-supplied evidence when the typed Prompt can only return candidates', () => {
  const result = normaliseReferenceArrays({
    discussionCandidates: [
      { candidateId: 'c1', topic: 'Audit scope', recordType: 'point', text: 'The audit scope is confirmed.', confidence: 'high' },
      { candidateId: 'unknown', topic: 'Other', recordType: 'point', text: 'An unexpected candidate.' }
    ]
  }, {
    validEvidenceIds: ['T0001'],
    trustedEvidenceLinks: [
      { candidateId: 'c1', evidenceId: 'T0001' },
      { candidateId: 'unknown', evidenceId: 'T9999' }
    ]
  });
  assert.deepEqual(result.discussion[0].points[0].evidenceIds, ['T0001']);
  assert.deepEqual(result.discussion[1].points[0].evidenceIds, []);
});

test('consolidates repeated scalar-evidence rows and preserves discussion record types', () => {
  const result = normaliseReferenceArrays({
    discussionCandidates: [
      { candidateId: 'c1', topic: 'Release', recordType: 'decision', text: 'The review moved to 23 June.', confidence: 1, evidenceId: 'T0001' },
      { candidateId: 'c1', topic: 'Release', recordType: 'decision', text: 'The review moved to 23 June.', confidence: 1, evidenceId: 'T0002' },
      { candidateId: 'c2', topic: 'Release', recordType: 'open_question', text: 'Whether validation can resume remains unresolved.', confidence: 0.8, evidenceId: 'T0003' }
    ]
  }, { validEvidenceIds: ['T0001', 'T0002', 'T0003'] });
  assert.equal(result.discussion[0].points.length, 0);
  assert.deepEqual(result.discussion[0].decisions[0].evidenceIds, ['T0001', 'T0002']);
  assert.equal(result.discussion[0].openQuestions[0].id, 'c2');
});

test('removes an invalid scalar evidence ID and raises the existing warning', () => {
  const result = normaliseReferenceArrays({
    discussionCandidates: [
      { candidateId: 'c1', topic: 'Release', recordType: 'point', text: 'A release point.', evidenceId: 'T9999' }
    ]
  }, { validEvidenceIds: ['T0001'] });
  assert.deepEqual(result.discussion[0].points[0].evidenceIds, []);
  assert.equal(result.reviewFlags[0].type, 'invalid_evidence_references');
});
