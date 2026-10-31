'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Source = require('../utils/meetingMinutesSource'),
  ResultNormalization = require('../utils/meetingMinutesResultNormalization');
const { normalizeUnassignedSupportingDetails: normalize, withoutRepresentedUnassignedDetails: without,
  collectUnassignedSupportingDetails: collect } = require('../utils/meetingMinutesSupportingDetails');
const row = extra => ({ id: 'generated-a', text: 'The supplier provided the revised calibration certificate.',
  evidenceIds: ['T0001', 'T0002'], reviewFlagIds: ['check'], originalTopic: 'Equipment',
  placementReason: 'no_unique_parent', ...extra });
const pair = extra => [row(), row({ id: 'generated-b', originalTopic: 'Inspection', placementReason: 'parent_not_publishable', ...extra })];

test('different generated IDs with exact text and citation sets consolidate losslessly', () => {
  const input = pair({ mergedFromIds: ['earlier-b'] }), before = structuredClone(input);
  const result = normalize(input);
  assert.equal(result.length, 1);
  assert.equal(result[0].text, input[0].text);
  assert.deepEqual(result[0].evidenceIds, input[0].evidenceIds);
  assert.deepEqual(result[0].reviewFlagIds, ['check']);
  assert.deepEqual(result[0].mergedFromIds, ['generated-b', 'earlier-b']);
  assert.deepEqual(result[0].filingOrigins, [
    { id: 'generated-a', originalTopic: 'Equipment', placementReason: 'no_unique_parent' },
    { id: 'generated-b', originalTopic: 'Inspection', placementReason: 'parent_not_publishable' }]);
  assert.deepEqual(input, before);
  assert.deepEqual(normalize(JSON.parse(JSON.stringify(result))), result);
});
for (const side of ['first', 'second', 'both']) test('empty supporting lists do not block exact filing consolidation: ' + side, () => {
  const input = pair({ mergedFromIds: ['earlier-b'] });
  if (side !== 'second') input[0].supportingDetails = [];
  if (side !== 'first') input[1].supportingDetails = [];
  const before = structuredClone(input);
  const result = normalize(input);
  assert.equal(result.length, 1);
  assert.equal(result[0].text, input[0].text);
  assert.deepEqual(result[0].evidenceIds, input[0].evidenceIds);
  assert.deepEqual(result[0].reviewFlagIds, ['check']);
  assert.deepEqual(result[0].mergedFromIds, ['generated-b', 'earlier-b']);
  assert.deepEqual(result[0].filingOrigins, [
    { id: 'generated-a', originalTopic: 'Equipment', placementReason: 'no_unique_parent' },
    { id: 'generated-b', originalTopic: 'Inspection', placementReason: 'parent_not_publishable' }
  ]);
  assert.notEqual(result[0].filingMergeProtected, true);
  assert.deepEqual(input, before);
  assert.deepEqual(normalize(JSON.parse(JSON.stringify(result))), result);
});
for (const [name, extra] of [
  ['existing protection', { filingMergeProtected: true }],
  ['unknown metadata', { extraContext: 'retain separately' }],
  ['reviewer authorship', { reviewerAuthored: true }],
  ['different warnings', { reviewFlagIds: ['different-check'] }],
  ['different evidence', { evidenceIds: ['T0001'] }]
]) test('an empty supporting list cannot bypass ' + name, () => {
  const input = pair({ supportingDetails: [], ...extra });
  assert.equal(normalize(input).length, 2);
  assert.equal(normalize(normalize(input)).length, 2);
});
for (const value of [null, {}, '', 'none', false, 0]) test('malformed supporting list remains protected: ' + JSON.stringify(value), () => {
  const input = pair({ supportingDetails: value });
  assert.equal(normalize(input).length, 2);
  assert.equal(normalize(normalize(input)).length, 2);
});

test('collection retains a real parent and consolidates only its exact generated leaf copies', () => {
  const children = pair().map(child => ({ ...child, supportingDetails: [] }));
  const parent = row({ id: 'parent', text: 'The inspection remains subject to supplier approval.', supportingDetails: children });
  const before = structuredClone(parent), result = collect(parent);
  assert.equal(result.length, 2);
  assert.equal(result[0].id, 'parent');
  assert.equal(result[0].text, parent.text);
  assert.equal(result[0].filingMergeProtected, true);
  assert.deepEqual(result[1].mergedFromIds, ['generated-b']);
  assert.equal(result[1].filingOrigins.length, 2);
  assert.deepEqual(parent, before);
  assert.deepEqual(normalize(JSON.parse(JSON.stringify(result))), result);
});

test('citation and warning order do not affect identical set matching', () => {
  const result = normalize([row({ reviewFlagIds: ['one', 'two'] }), row({ id: 'generated-b',
    evidenceIds: ['T0002', 'T0001'], reviewFlagIds: ['two', 'one'] })]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].reviewFlagIds, ['one', 'two']);
});
for (const [name, extra] of [
  ['different wording', { text: 'The supplier may provide the revised calibration certificate.' }],
  ['different case', { text: 'the supplier provided the revised calibration certificate.' }],
  ['different whitespace', { text: 'The supplier  provided the revised calibration certificate.' }],
  ['different citations', { evidenceIds: ['T0001'] }],
  ['different warnings', { reviewFlagIds: ['different-check'] }],
  ['reviewer authorship', { reviewerAuthored: true }],
  ['manual identity', { id: 'manual-b' }],
  ['reviewer identity', { id: 'reviewer-b' }],
  ['confirmed placement', { confirmedTopic: true }],
  ['human source', { source: 'stage_2_human_confirmation' }],
  ['unknown metadata', { extraContext: 'retain separately' }],
  ['nested records', { supportingDetails: [row({ id: 'nested' })] }],
  ['oversized identity', { id: 'x'.repeat(81) }],
  ['invalid citation array', { evidenceIds: ['T0001', 'T0002', null] }],
  ['invalid warning array', { reviewFlagIds: ['check', null] }],
  ['invalid history', { mergedFromIds: ['bad\u0000id'] }]
]) test(name + ' remains separate through repeated normalization', () => {
  const result = normalize(pair(extra));
  assert.equal(result.length, 2);
  assert.equal(normalize(JSON.parse(JSON.stringify(result))).length, 2);
});
test('uncited records remain separate', () => {
  assert.equal(normalize(pair().map(value => ({ ...value, evidenceIds: [] }))).length, 2);
});
test('history overflow retains both rows instead of truncating to merge', () => {
  const input = pair();
  input[0].mergedFromIds = Array.from({ length: 1000 }, (_, i) => 'old-' + i);
  const result = normalize(input);
  assert.equal(result.length, 2);
  assert.equal(result[0].mergedFromIds.length, 1000);
});
test('same-ID reload cannot truncate history already associated with consolidated origins', () => {
  const merged = normalize(pair())[0];
  merged.mergedFromIds = ['generated-b', ...Array.from({ length: 999 }, (_, i) => 'old-' + i)];
  const result = normalize([merged, { ...merged, mergedFromIds: ['another-predecessor'] }]);
  assert.equal(result.length, 2);
  assert.ok(result[1].mergedFromIds.includes('another-predecessor'));
});
test('origin overflow retains both rows', () => {
  const input = pair();
  input[0].filingOrigins = Array.from({ length: 1000 }, (_, i) => ({ id: 'old-' + i }));
  assert.equal(normalize(input).length, 2);
});
test('malformed origin metadata prevents consolidation across reload', () => {
  const result = normalize(pair({ filingOrigins: [{ id: 'old', unknown: true }] }));
  assert.equal(result.length, 2);
  assert.equal(normalize(result).length, 2);
});
test('three copies retain all origins and histories, with stable first position', () => {
  const result = normalize([row({ id: 'different', text: 'Another discussion.' }), ...pair(), row({ id: 'generated-c' })]);
  assert.deepEqual(result.map(value => value.id), ['different', 'generated-a']);
  assert.deepEqual(result[1].mergedFromIds, ['generated-b', 'generated-c']);
  assert.equal(result[1].filingOrigins.length, 3);
  assert.deepEqual(normalize(result), result);
});
test('filing origins survive reviewer-save normalization of supporting and promoted rows', () => {
  const detail = { ...normalize(pair())[0], reviewerAuthored: true };
  const units = Source.normaliseSourceUnits([{ id: 'T0001', text: detail.text }, { id: 'T0002', text: detail.text }]);
  for (const promoted of [false, true]) {
    const point = promoted ? detail : { id: 'parent', text: detail.text, evidenceIds: ['T0001'], supportingDetails: [detail] };
    const result = ResultNormalization.normaliseAgentResult({ discussion: [{ topic: 'Equipment', points: [point] }], actions: [] }, units, 'discussion',
      { enforceEvidence: false, dedupeActions: false, mergeTopics: false, preserveReviewerEdits: true });
    const retained = promoted ? result.discussion[0].points[0] : result.discussion[0].points[0].supportingDetails[0];
    assert.deepEqual(retained.filingOrigins, detail.filingOrigins);
    assert.deepEqual(retained.mergedFromIds, detail.mergedFromIds);
  }
});
test('an attached shadow cannot remove origin history absent from the attached record', () => {
  const detail = normalize(pair())[0];
  const parent = child => [{ points: [{ id: 'parent', text: 'Review', supportingDetails: [child] }] }];
  const missing = { ...detail }; delete missing.filingOrigins;
  assert.equal(without([detail], parent(missing)).length, 1);
  assert.equal(without([detail], parent(detail)).length, 0);
});
test('editor promotion and demotion helper carries origins without aliasing input', () => {
  const source = fs.readFileSync(require.resolve('../public/meeting-minutes-agent.js'), 'utf8');
  const start = source.indexOf('  function preserveDiscussionMergeHistory(');
  const end = source.indexOf('\n  function orderedUnassignedSupportingDetails(', start);
  const context = { cloneEditorValue: value => JSON.parse(JSON.stringify(value)) };
  vm.runInNewContext(source.slice(start, end), context);
  const detail = normalize(pair())[0], result = context.preserveDiscussionMergeHistory(detail, { id: detail.id });
  assert.deepEqual(JSON.parse(JSON.stringify(result.filingOrigins)), detail.filingOrigins);
  result.filingOrigins[0].originalTopic = 'Changed';
  assert.equal(detail.filingOrigins[0].originalTopic, 'Equipment');
});
