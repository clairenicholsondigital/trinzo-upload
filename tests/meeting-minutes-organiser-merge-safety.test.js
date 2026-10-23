'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const O = require('../utils/canonicalMinutes/discussionOrganiser');
const row = (id, text, extra = {}) => ({ id, text, evidenceIds: ['T1'], reviewFlagIds: [], supportingDetails: [], ...extra });
const topics = (a, b) => [{ id: 'topic', topic: 'Equipment', points: [a, b], decisions: [], openQuestions: [] }];
const options = { encode: async texts => texts.map(() => [1, 0]), sourceUnits: [{ id: 'T1', text: 'Source context.' }] };
for (const [name, a, b] of [
  ['dependency direction', 'The certificate is sent before approval.', 'The certificate is sent after approval.'],
  ['actor direction', 'Alex sent the calibration certificate to Priya.', 'Priya sent the calibration certificate to Alex.']
]) test('containment demotion preserves ' + name, async () => {
  const input = topics(row('a', a), row('b', b));
  assert.deepEqual(await O.demoteContainedPrimaryRows(input, options), input);
});
test('containment demotion keeps complete candidate metadata in retained supporting context', async () => {
  const text = 'The calibration review remains confirmed.';
  const candidate = row('candidate', text, { primaryEvidenceIds: ['T1'], provenanceNote: 'Retain this source decision.' });
  const input = topics(row('parent', text), candidate);
  const result = await O.demoteContainedPrimaryRows(input, options);
  const retained = result[0].points.flatMap(row => row.supportingDetails || []).find(row => row.id === 'candidate');
  assert.equal(result[0].points.length, 1);
  assert.deepEqual(retained, candidate);
});
test('containment demotion refuses citation or history overflow', async () => {
  const text = 'The calibration review remains confirmed.';
  for (const extra of [
    { evidenceIds: Array.from({ length: 12 }, (_, i) => 'U' + i) },
    { mergedFromIds: Array.from({ length: 1000 }, (_, i) => 'old-' + i) }
  ]) {
    const input = topics(row('a', text, extra), row('b', text, { evidenceIds: ['T1', 'U0'] }));
    // Equal-information choices may run in either direction; every original
    // must remain, either as a main row or complete supporting record.
    const result = await O.demoteContainedPrimaryRows(input, options);
    assert.equal(result[0].points.length, 2);
  }
});

test('an existing predecessor is retained even when another output still uses that identity', () => {
  const safety = require('../utils/canonicalMinutes/discussionMergeSafety');
  const text = 'The calibration review remains confirmed.';
  const a = row('a', text, { mergedFromIds: ['b', 'historical'] }), b = row('b', text), c = row('c', text);
  const result = safety.reconcileMetadata([a, b, c], a, { survivingIds: ['a', 'b'] });
  assert.deepEqual(result.mergedFromIds, ['b', 'historical', 'c']);
});
const negative = [
  ['actor direction', 'Alex sent the revised calibration certificate to Priya.', 'Priya sent the revised calibration certificate to Alex.'],
  ['dependency direction', 'Alex will send the revised certificate before supplier approval.', 'Alex will send the revised certificate after supplier approval.'],
  ['budget bounds', 'The committee approved a replacement equipment budget under £50.', 'The committee approved a replacement equipment budget over £50.'],
  ['certainty', 'Alex may send the revised calibration certificate to Priya.', 'Alex will send the revised calibration certificate to Priya.'],
  ['approximation', 'There are about three replacement calibration certificates available.', 'There are three replacement calibration certificates available.'],
  ['phase', 'Alex plans to review the revised calibration certificate.', 'Alex has completed the review of the revised calibration certificate.'],
  ['contraction', "Alex didn't send the revised calibration certificate to Priya.", 'Alex sent the revised calibration certificate to Priya.'],
  ['reported question', 'Alex is questioning how visitors access the replacement equipment.', 'Alex confirmed how visitors access the replacement equipment.']
];
for (const [method, fn] of [['adjacent', O.dedupeAdjacentRestatements], ['global', O.dedupeGlobalRestatements]]) {
  for (const [name, a, b] of negative) test(method + ' keeps different ' + name, async () => {
    const input = topics(row('a', a), row('b', b)), before = structuredClone(input);
    assert.deepEqual(await fn(input, options), input); assert.deepEqual(input, before);
  });
  test(method + ' retains all supported metadata for an exact repeat', async () => {
    const text = 'The supplier provided the revised calibration certificate.';
    const result = await fn(topics(row('a', text, { primaryEvidenceIds: ['T1'], mergedFromIds: ['old-a'] }),
      row('b', text, { primaryEvidenceIds: ['T2'], evidenceIds: ['T1', 'T2'], mergedFromIds: ['old-b'] })), options);
    const survivor = result[0].points[0];
    assert.equal(result[0].points.length, 1);
    assert.deepEqual(new Set(survivor.primaryEvidenceIds), new Set(['T1', 'T2']));
    assert.deepEqual(new Set(survivor.evidenceIds), new Set(['T1', 'T2']));
    assert.deepEqual(new Set(survivor.mergedFromIds), new Set(['old-a', 'old-b', survivor.id === 'a' ? 'b' : 'a']));
  });
  for (const [name, extra] of [
    ['unknown metadata', { externalContext: { retain: true } }],
    ['different provenance', { simulationSource: 'staged' }],
    ['reviewer choice', { reviewerAuthored: true }],
    ['malformed history', { mergedFromIds: ['bad\u0000id'] }]
  ]) test(method + ' keeps ' + name, async () => {
    const text = 'The supplier provided the revised calibration certificate.';
    const input = topics(row('a', text, { simulationSource: 'primary' }), row('b', text, extra));
    assert.deepEqual(await fn(input, options), input);
  });
  test(method + ' never truncates citations to merge', async () => {
    const text = 'The supplier provided the revised calibration certificate.';
    const input = topics(row('a', text, { evidenceIds: Array.from({ length: 12 }, (_, i) => 'T' + i) }),
      row('b', text, { evidenceIds: ['T0', ...Array.from({ length: 11 }, (_, i) => 'U' + i)] }));
    assert.deepEqual(await fn(input, options), input);
  });
  test(method + ' never truncates predecessor history to merge', async () => {
    const text = 'The supplier provided the revised calibration certificate.';
    const input = topics(row('a', text, { mergedFromIds: Array.from({ length: 1000 }, (_, i) => 'old-' + i) }), row('b', text));
    assert.deepEqual(await fn(input, options), input);
  });
  test(method + ' preserves warning scope on a paraphrase', async () => {
    const input = topics(row('a', 'The supplier provided the revised calibration certificate.', { reviewFlagIds: ['check-a'] }),
      row('b', 'The supplier supplied the revised calibration certificate.'));
    assert.deepEqual(await fn(input, options), input);
  });
}
