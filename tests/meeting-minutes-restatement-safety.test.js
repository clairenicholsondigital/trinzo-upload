'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  dedupeAdjacentRestatements, dedupeGlobalRestatements,
  demoteContainedPrimaryRows, partialOverlapCandidates, finaliseDiscussionForPublication
} = require('../utils/canonicalMinutes/discussionOrganiser');

const sentence = 'The laboratory inspection schedule remains confirmed for the review.';
const supporting = 'The laboratory remains available during the inspection.';
const detail = (id, extra = {}) => ({ id, text: supporting, evidenceIds: ['T0002'], ...extra });
const point = (id, extra = {}) => ({ id, text: sentence, evidenceIds: ['T0001'], reviewFlagIds: [], supportingDetails: [], ...extra });
const topic = (points, extra = {}) => ({
  id: 'topic', topic: 'Laboratory inspection', points, decisions: [], openQuestions: [], ...extra
});
const options = { restatementVectorsPrepared: true, encode: async () => null };
const clean = points => dedupeAdjacentRestatements([topic(points)], options);

for (const [name, cleanup] of [
  ['adjacent', dedupeAdjacentRestatements], ['global', dedupeGlobalRestatements]
]) {
  test(name + ' cleanup combines identical leaf wording with all source, warning and predecessor links', async () => {
    const original = [topic([
      point('first', { supportingDetails: [detail('support-first', {
        evidenceIds: ['T0002'], reviewFlagIds: ['warning-first'], mergedFromIds: ['older-first']
      })] }),
      point('second', { supportingDetails: [detail('support-second', {
        evidenceIds: ['T0003'], reviewFlagIds: ['warning-second'], mergedFromIds: ['older-second']
      })] })
    ])];
    const before = structuredClone(original);
    const result = await cleanup(original, options);
    assert.equal(result[0].points.length, 1);
    const rows = result[0].points[0].supportingDetails;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, supporting);
    assert.deepEqual(new Set(rows[0].evidenceIds), new Set(['T0002', 'T0003']));
    assert.deepEqual(new Set(rows[0].reviewFlagIds), new Set(['warning-first', 'warning-second']));
    assert.deepEqual(new Set([rows[0].id, ...rows[0].mergedFromIds]),
      new Set(['support-first', 'support-second', 'older-first', 'older-second']));
    assert.deepEqual(original, before);
    assert.deepEqual(await cleanup(result, options), result);
  });
}

for (const [name, extra] of [
  ['nested qualification', { supportingDetails: [{
    id: 'nested', text: 'Access depends on completion of the safety induction.', evidenceIds: ['T0004']
  }] }],
  ['additional metadata', { primaryEvidenceIds: ['T0002'] }],
  ['unknown metadata', { sourceDisposition: 'qualified' }]
]) {
  test('same supporting wording retains both records when one has ' + name, async () => {
    const special = detail('special', extra);
    const result = await clean([
      point('first', { supportingDetails: [special] }),
      point('second', { supportingDetails: [detail('plain')] })
    ]);
    assert.equal(result[0].points.length, 1);
    const rows = result[0].points[0].supportingDetails;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.find(row => row.id === 'special'), special);
  });
}

test('case and punctuation differences in supporting wording remain separate', async () => {
  const result = await clean([
    point('first', { supportingDetails: [detail('first-detail')] }),
    point('second', { supportingDetails: [detail('second-detail', { text: supporting.toUpperCase() })] })
  ]);
  assert.equal(result[0].points[0].supportingDetails.length, 2);
});

for (const [name, left, right] of [
  ['citation budget', { evidenceIds: Array.from({ length: 12 }, (_, i) => 'T' + i) }, { evidenceIds: ['T99'] }],
  ['history budget', { mergedFromIds: Array.from({ length: 1000 }, (_, i) => 'old-' + i) }, {}]
]) {
  test('supporting cleanup keeps both rows instead of truncating the ' + name, async () => {
    const result = await clean([
      point('first', { supportingDetails: [detail('first-detail', left)] }),
      point('second', { supportingDetails: [detail('second-detail', right)] })
    ]);
    const rows = result[0].points[0].supportingDetails;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.find(row => row.id === 'first-detail').evidenceIds, left.evidenceIds || ['T0002']);
    if (left.mergedFromIds) assert.deepEqual(rows.find(row => row.id === 'first-detail').mergedFromIds, left.mergedFromIds);
  });
}

test('contained-row demotion preserves matching supporting rows with distinct nested context', async () => {
  const nested = { id: 'nested', text: 'Access depends on completion of the safety induction.', evidenceIds: ['T0004'] };
  const input = [topic([
    point('short', { supportingDetails: [detail('candidate-detail', { supportingDetails: [nested] })] })
  ], { decisions: [point('decision', { supportingDetails: [detail('parent-detail')] })] })];
  const before = structuredClone(input);
  const result = await demoteContainedPrimaryRows(input, options);
  assert.equal(result[0].points.length, 0, 'the existing exact containment decision still applies');
  assert.deepEqual(result[0].decisions[0].supportingDetails.find(row => row.id === 'candidate-detail').supportingDetails, [nested]);
  assert.ok(result[0].decisions[0].supportingDetails.some(row => row.id === 'parent-detail'));
  assert.deepEqual(input, before);
});

const locks = [
  ['reviewer row', rows => { rows[0].reviewerAuthored = true; }],
  ['confirmed row', rows => { rows[0].confirmedTopic = true; }],
  ['human-confirmed row', rows => { rows[0].source = 'discussion_human_confirmation'; }],
  ['manual row', rows => { rows[0].id = 'manual-first'; }],
  ['reviewer supporting row', rows => { rows[0].supportingDetails = [detail('support', { reviewerAuthored: true })]; }],
  ['nested reviewer supporting row', rows => { rows[0].supportingDetails = [detail('support', {
    supportingDetails: [detail('nested', { reviewerAuthored: true })]
  })]; }],
  ['reviewer topic', (rows, card) => { card.reviewerAuthored = true; }],
  ['confirmed topic', (rows, card) => { card.confirmedTopic = true; }]
];
for (const [name, lock] of locks) {
  test('all restatement cleanup paths preserve a ' + name, async () => {
    const rows = [point('first'), point('second')];
    const card = topic(rows);
    lock(rows, card);
    const before = structuredClone([card]);
    for (const cleanup of [dedupeAdjacentRestatements, dedupeGlobalRestatements, demoteContainedPrimaryRows]) {
      const result = await cleanup([card], options);
      assert.deepEqual(result, before, cleanup.name + ' must preserve reviewer organisation and text');
    }
    assert.deepEqual(partialOverlapCandidates([card], options), [],
      'later optional rewrites must not bypass the lock');
    assert.deepEqual([card], before);
  });
}

test('a reviewer-controlled destination cannot absorb an unprotected point', async () => {
  const input = [topic([point('candidate')], {
    decisions: [point('decision', { supportingDetails: [detail('support', { reviewerAuthored: true })] })]
  })];
  assert.deepEqual(await demoteContainedPrimaryRows(input, options), input);
});

test('unprotected generated repetitions still merge and differing figures remain separate', async () => {
  const result = await clean([point('first'), point('second')]);
  assert.equal(result[0].points.length, 1);
  const figures = [point('one', { text: 'The laboratory inspection covers 17 records.' }),
    point('two', { text: 'The laboratory inspection covers 43 records.' })];
  assert.deepEqual((await clean(figures))[0].points.map(row => row.id), ['one', 'two']);
});

test('publication boundary preserves a reviewer topic against subsequent duplicate cleanup', async () => {
  const input = [topic([point('first'), point('second')], { confirmedTopic: true })];
  const result = await finaliseDiscussionForPublication(input, {
    ...options, sourceUnits: [{ id: 'T0001', sequence: 1, speaker: 'Morgan', text: sentence }]
  });
  assert.deepEqual(result[0].points.map(row => row.id), ['first', 'second']);
});
