'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const O = require('../utils/canonicalMinutes/discussionOrganiser');
const text = 'The supplier provided the calibration certificate.';
const detail = (id, extra = {}) => ({ id, text, evidenceIds: ['S1'], reviewFlagIds: [], ...extra });
const parent = (id, details = [], extra = {}) => ({ id,
  text: 'The equipment review remains scheduled for Friday.', evidenceIds: ['S2'],
  reviewFlagIds: [], supportingDetails: details, ...extra });
const topic = (rows, kind = 'points', extra = {}) => ({
  id: 'equipment', topic: 'Equipment review', points: [], decisions: [], openQuestions: [], [kind]: rows, ...extra
});
const units = [
  { id: 'S1', sequence: 1, text },
  { id: 'S2', sequence: 2, text: 'The equipment review remains scheduled for Friday.' },
  { id: 'S3', sequence: 3, text: 'The calibration certificate remains valid.' }
];

for (const kind of ['points', 'decisions', 'openQuestions']) {
  test('final presentation consolidates exact generated supporting leaves under ' + kind, () => {
    const input = [topic([parent('parent', [
      detail('first', { reviewFlagIds: ['first-warning'], mergedFromIds: ['older-first'] }),
      detail('second', { evidenceIds: ['S3'], reviewFlagIds: ['second-warning'], mergedFromIds: ['older-second'] })
    ])], kind)];
    const before = structuredClone(input);
    const result = O.normaliseDiscussionPresentation(input), row = result[0][kind][0];
    assert.equal(row.supportingDetails.length, 1);
    const child = row.supportingDetails[0];
    assert.equal(child.text, text);
    assert.equal(child.id, 'first');
    assert.deepEqual(child.evidenceIds, ['S1', 'S3']);
    assert.deepEqual(child.reviewFlagIds, ['first-warning', 'second-warning']);
    assert.deepEqual(new Set([child.id, ...child.mergedFromIds]), new Set(['first', 'second', 'older-first', 'older-second']));
    assert.equal(row.id, 'parent');
    assert.equal(row.text, input[0][kind][0].text);
    assert.deepEqual(row.evidenceIds, ['S2']);
    assert.deepEqual(input, before);
    assert.deepEqual(O.normaliseDiscussionPresentation(result), result);
  });
}

test('full publication cleans supporting duplicates without needing a duplicate parent', async () => {
  const input = [topic([parent('parent', [detail('first'), detail('second')])])];
  const result = await O.finaliseDiscussionForPublication(input, { sourceUnits: units, encode: async () => null });
  assert.equal(result.length, 1);
  assert.equal(result[0].points.length, 1);
  assert.equal(result[0].points[0].supportingDetails.length, 1);
});
test('presentation formatting cannot leave a second identical displayed copy', () => {
  const input = [topic([parent('parent', [detail('first', { text: 'the supplier provided the calibration certificate' }), detail('second')])])];
  const result = O.normaliseDiscussionPresentation(input);
  assert.equal(result[0].points[0].supportingDetails.length, 1);
  assert.deepEqual(O.normaliseDiscussionPresentation(result), result);
});
for (const [name, extra] of [
  ['qualification', { text: 'The supplier may provide the calibration certificate.' }],
  ['different value', { text: 'The supplier provided three calibration certificates.' }],
  ['nested context', { supportingDetails: [detail('nested', { text: 'The certificate is subject to independent review.' })] }],
  ['unknown metadata', { originalTopic: 'Supplier' }],
  ['citation budget', { evidenceIds: Array.from({ length: 12 }, (_, i) => 'E' + i) }],
  ['history budget', { mergedFromIds: Array.from({ length: 1000 }, (_, i) => 'old-' + i) }]
]) test('final cleanup keeps separate rows with ' + name, () => {
  const result = O.normaliseDiscussionPresentation([topic([parent('parent', [detail('first'), detail('second', extra)])])]);
  assert.equal(result[0].points[0].supportingDetails.length, 2);
  assert.deepEqual(result[0].points[0].supportingDetails[1], detail('second', extra));
});
test('same wording under separate parents is not merged across rows or topics', () => {
  const result = O.normaliseDiscussionPresentation([topic([parent('one', [detail('a')]), parent('two', [detail('b')])]),
    topic([parent('three', [detail('c')])], 'points', { id: 'another' })]);
  assert.deepEqual(result.map(t => t.points.map(p => p.supportingDetails.length)), [[1, 1], [1]]);
});
for (const [name, lock] of [
  ['reviewer flag', { reviewerAuthored: true }],
  ['confirmed flag', { confirmedTopic: true }],
  ['human-confirmed source', { source: 'discussion_human_confirmation' }],
  ['manual identity', { id: 'manual-detail' }],
  ['reviewer identity', { id: 'reviewer-detail' }]
]) {
  test('a ' + name + ' on a supporting descendant locks chronological placement', () => {
    const locked = topic([parent('late-parent', [detail('late', { ...lock, evidenceIds: ['S3'] }), detail('early')]),
      parent('early-parent', [], { evidenceIds: ['S1'] })]);
    const original = structuredClone(locked);
    const input = [topic([parent('generated-late', [], { evidenceIds: ['S3'] })], 'points', { id: 'last' }),
      locked, topic([parent('generated-early', [], { evidenceIds: ['S1'] })], 'points', { id: 'first' })];
    const result = O.sortByEvidence(input, O.unitIndex(units));
    assert.deepEqual(result.map(t => t.id), ['first', 'equipment', 'last']);
    assert.equal(result[1], locked);
    assert.deepEqual(result[1], original);
  });
  test('a ' + name + ' prevents new cleanup inside its containing row', () => {
    const input = [topic([parent('parent', [detail('first'), detail('second'), detail('locked', lock)])])];
    assert.equal(O.normaliseDiscussionPresentation(input)[0].points[0].supportingDetails.length, 3);
  });
}
test('nested reviewer grandchildren also lock row and supporting order', () => {
  const input = [topic([parent('parent', [detail('late', { evidenceIds: ['S3'], supportingDetails: [detail('nested', { reviewerAuthored: true })] }), detail('early')])])];
  const before = structuredClone(input);
  assert.deepEqual(O.sortByEvidence(input, O.unitIndex(units)), before);
});
for (const kind of ['decisions', 'openQuestions']) test(kind + ' descendants get the same ordering protection', () => {
  const input = [topic([parent('parent', [detail('late', { evidenceIds: ['S3'], reviewerAuthored: true }), detail('early')])], kind)];
  const before = structuredClone(input);
  assert.deepEqual(O.sortByEvidence(input, O.unitIndex(units)), before);
});
for (const [name, extra] of [
  ['reviewer parent', { reviewerAuthored: true }],
  ['manual parent', { id: 'manual-parent' }]
]) test(name + ' keeps exact supporting repetitions separate', () => {
  const input = [topic([parent('parent', [detail('first'), detail('second')], extra)])];
  assert.equal(O.normaliseDiscussionPresentation(input)[0].points[0].supportingDetails.length, 2);
});
test('unlocked generated rows and children still sort chronologically', () => {
  const result = O.sortByEvidence([topic([
    parent('late-parent', [detail('late', { evidenceIds: ['S3'] }), detail('early')]),
    parent('early-parent', [], { evidenceIds: ['S1'] })
  ])], O.unitIndex(units));
  assert.deepEqual(result[0].points.map(p => p.id), ['early-parent', 'late-parent']);
  assert.deepEqual(result[0].points[1].supportingDetails.map(d => d.id), ['early', 'late']);
});
