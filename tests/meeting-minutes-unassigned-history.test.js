'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeUnassignedSupportingDetails,
  collectUnassignedSupportingDetails,
  mergeUnassignedSupportingDetails,
  withoutRepresentedUnassignedDetails
} = require('../utils/meetingMinutesSupportingDetails');

const retained = extra => ({
  id: 'retained-context', text: 'The calibration reference remains available.',
  evidenceIds: ['T0002'], reviewFlagIds: ['reference-check'], ...extra
});
const discussionWith = row => [{ points: [{ id: 'main', text: 'Calibration was reviewed.',
  supportingDetails: [row] }], decisions: [], openQuestions: [] }];

test('unfiled history retains bounded historical string IDs without coercion or self references', () => {
  const exactLimit = 'h'.repeat(220);
  const record = retained({ mergedFromIds: [' previous-detail ', 'previous-detail', 'retained-context', '',
    null, 3, true, {}, ['nested-id'], 'x'.repeat(221), 'bad\u0000id', 'bad\u007fid', exactLimit],
    mergedTopicIds: ['not-a-topic'], primaryEvidenceIds: ['previous-detail'],
    confirmedTopic: true, source: 'stage_2_human_confirmation' });
  const before = structuredClone(record);
  const [result] = normalizeUnassignedSupportingDetails([record]);
  assert.deepEqual(result.mergedFromIds, ['previous-detail', exactLimit]);
  assert.deepEqual(result.evidenceIds, ['T0002']);
  assert.deepEqual(result.reviewFlagIds, ['reference-check']);
  assert.equal(result.reviewerAuthored, undefined);
  for (const field of ['mergedTopicIds', 'primaryEvidenceIds', 'confirmedTopic', 'source']) assert.equal(result[field], undefined);
  assert.deepEqual(record, before, 'normalization must not mutate retained review state');
  for (const invalid of ['old-id', { 0: 'old-id', length: 1 }, null]) {
    assert.equal(normalizeUnassignedSupportingDetails([retained({ mergedFromIds: invalid })])[0].mergedFromIds, undefined);
  }
});

test('unfiled history uses the same thousand-input bound as attached reviewer history', () => {
  const mergedFromIds = Array.from({ length: 1200 }, (_, index) => 'predecessor-' + index);
  const [row] = normalizeUnassignedSupportingDetails([retained({ mergedFromIds })]);
  assert.equal(row.mergedFromIds.length, 1000);
  assert.equal(row.mergedFromIds.at(-1), 'predecessor-999');
  const invalidPrefix = Array(1000).fill(null).concat('past-input-budget');
  assert.equal(normalizeUnassignedSupportingDetails([retained({ mergedFromIds: invalidPrefix })])[0].mergedFromIds, undefined);
});

test('exact unfiled duplicates union valid histories without merging distinct text or citations', () => {
  const first = retained({ mergedFromIds: ['first-predecessor'], reviewerAuthored: true });
  const second = retained({ mergedFromIds: ['second-predecessor', 'first-predecessor', 'retained-context'],
    reviewFlagIds: ['second-check'] });
  const distinctText = retained({ text: 'A separately qualified reference remains available.', mergedFromIds: ['other-text'] });
  const distinctEvidence = retained({ evidenceIds: ['T0003'], mergedFromIds: ['other-source'] });
  const result = mergeUnassignedSupportingDetails([first], [second, distinctText, distinctEvidence]);
  assert.equal(result.length, 3);
  assert.deepEqual(result[0].mergedFromIds, ['first-predecessor', 'second-predecessor']);
  assert.deepEqual(result[0].reviewFlagIds, ['reference-check', 'second-check']);
  assert.equal(result[0].reviewerAuthored, true);
  assert.deepEqual(result[1].mergedFromIds, ['other-text']);
  assert.deepEqual(result[2].mergedFromIds, ['other-source']);
  const many = Array.from({ length: 1000 }, (_, index) => 'older-' + index);
  const [bounded] = mergeUnassignedSupportingDetails([retained({ mergedFromIds: many })],
    [retained({ mergedFromIds: ['beyond-history-budget'] })]);
  assert.equal(bounded.mergedFromIds.length, 1000);
  assert.equal(bounded.mergedFromIds.at(-1), 'older-999');
});

test('collecting detached review context preserves parent and nested child histories', () => {
  const child = retained({ id: 'child-context', mergedFromIds: ['old-child'] });
  const parent = retained({ mergedFromIds: ['old-parent'], supportingDetails: [child] });
  const rows = collectUnassignedSupportingDetails(parent, { originalTopic: 'Calibration',
    placementReason: 'No unique supporting parent was established.' });
  assert.deepEqual(rows.map(row => row.mergedFromIds), [['old-parent'], ['old-child']]);
  assert.ok(rows.every(row => row.originalTopic === 'Calibration'));
  assert.ok(rows.every(row => row.placementReason === 'No unique supporting parent was established.'));
});

test('a represented shadow can leave the pool only when it covers historical metadata too', () => {
  const record = retained({ mergedFromIds: ['earlier-reference', 'earlier-qualification'], reviewerAuthored: true });
  const missing = { ...record };
  delete missing.mergedFromIds;
  assert.deepEqual(withoutRepresentedUnassignedDetails([record], discussionWith(missing)), [record]);
  const partial = { ...record, mergedFromIds: ['earlier-reference'] };
  assert.deepEqual(withoutRepresentedUnassignedDetails([record], discussionWith(partial)), [record]);
  const complete = { ...record, mergedFromIds: [...record.mergedFromIds, 'additional-predecessor'] };
  assert.deepEqual(withoutRepresentedUnassignedDetails([record], discussionWith(complete)), []);
  const invalidOnly = retained({ mergedFromIds: ['retained-context', null, 'bad\u0000id'] });
  assert.deepEqual(withoutRepresentedUnassignedDetails([invalidOnly], discussionWith(retained())), []);
});
