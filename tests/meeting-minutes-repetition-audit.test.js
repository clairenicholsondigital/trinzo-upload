'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { audit } = require('../scripts/meeting_minutes_discussion_repetition_audit');
function input() { return { discussion: [{ id: 'topic', points: [
  { id: 'a', text: 'The register is ready. The register is ready.', evidenceIds: ['T1'] },
  { id: 'b', text: 'The register is ready. The label is approved.', evidenceIds: ['T1'] }
] }], sourceUnits: [{ id: 'T1', text: 'The register is ready. The label is approved.' }] }; }
test('offline audit distinguishes within-record and cross-record exact repeats without altering snapshots', () => {
  const draft = input(), before = structuredClone(draft), result = audit(draft);
  assert.equal(result.exactWithinRecord.length, 1); assert.equal(result.exactAcrossRecords.length, 2);
  assert.equal(result.eligiblePoints, 2); assert.deepEqual(draft, before);
  assert.equal(result.exactWithinRecord[0].sentenceHash.length, 64);
  assert.ok(!JSON.stringify(result).includes('register is ready'));
});
test('harmless repeated whitespace is normalized without altering snapshot text', () => {
  const draft = input(); draft.discussion[0].points[0].text = 'The register is ready. The register   is ready.';
  const before = structuredClone(draft), result = audit(draft);
  assert.equal(result.exactWithinRecord.length, 1);
  assert.equal(result.exactAcrossRecords.length, 2); assert.deepEqual(draft, before);
});
test('eligibility is reported separately from literal repetition', () => {
  const draft = input(); draft.discussion[0].points[0].reviewFlagIds = ['flag'];
  const result = audit(draft);
  assert.equal(result.exactWithinRecord.length, 1); assert.equal(result.eligiblePoints, 1);
  assert.ok(result.exclusions[0].reasons.includes('warning_target'));
});
test('reviewer descendants protect the card in the audit too', () => {
  const draft = input(); draft.discussion[0].points[0].supportingDetails = [
    { id: 'manual-note', text: 'Reviewer text.', reviewerAuthored: true }
  ];
  assert.equal(audit(draft).eligiblePoints, 0);
});
test('unknown, missing, duplicate and inconsistent citations are visible exclusions', () => {
  for (const mutate of [
    d => { d.sourceUnits = []; }, d => { d.sourceUnits.push(d.sourceUnits[0]); },
    d => { d.discussion[0].points[0].primaryEvidenceIds = ['missing']; },
    d => { d.discussion[0].points[0].customState = 'retain'; }
  ]) { const draft = input(); mutate(draft); assert.ok(audit(draft).exclusions.length); }
});
test('topic boundaries do not create a cross-heading exact-repeat recommendation', () => {
  const draft = input(); draft.discussion.push({ id: 'second', points: [draft.discussion[0].points.pop()] });
  assert.equal(audit(draft).exactAcrossRecords.length, 0);
});
test('malformed snapshots fail visibly', () => {
  for (const value of [null, {}, { discussion: [] }]) assert.throws(() => audit(value), /snapshot/);
});
