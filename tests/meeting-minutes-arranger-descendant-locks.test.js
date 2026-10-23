'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const O = require('../utils/canonicalMinutes/discussionOrganiser');
const { stagedEvaluation: A } = require('../routes/api');
const units = [
  { id: 'S1', sequence: 1, text: 'The supplier confirmed receipt of the certificate.' },
  { id: 'S2', sequence: 2, text: 'The team retained the calibration context.' },
  { id: 'S3', sequence: 3, text: 'The equipment inspection is scheduled.' }
];
const row = (id, evidence = 'S2', extra = {}) => ({
  id, text: 'The equipment inspection remains scheduled.', evidenceIds: [evidence],
  reviewFlagIds: [], supportingDetails: [], ...extra
});
const card = (id, rows, kind = 'points') => ({
  id, topic: 'Equipment certification', points: [], decisions: [], openQuestions: [], [kind]: rows
});
const locks = [
  ['reviewer flag', { reviewerAuthored: true }],
  ['confirmed flag', { confirmedTopic: true }],
  ['human-confirmed source', { source: 'discussion_human_confirmation' }],
  ['manual identity', { id: 'manual-context' }],
  ['reviewer identity', { id: 'reviewer-context' }]
];
for (const kind of ['points', 'decisions', 'openQuestions']) {
  for (const depth of [1, 2]) {
    for (const [name, marker] of locks) {
      test(kind + ': ' + name + ' at supporting depth ' + depth + ' withholds the entire card', () => {
        const owned = row('owned', 'S3', {
          text: 'Reviewer retained wording and context.',
          reviewFlagIds: ['warning-to-preserve'], mergedFromIds: ['previous-context'],
          ...marker
        });
        const children = depth === 1 ? [owned] : [row('generated-bridge', 'S3', { supportingDetails: [owned] })];
        const locked = card('retained-card', [
          row('retained-parent', 'S3', { supportingDetails: children }),
          row('earlier-sibling', 'S1')
        ], kind);
        locked.customReviewMetadata = { retained: true };
        const input = [
          card('generated-late', [row('late', 'S3')]), locked,
          card('generated-early', [row('early', 'S1')])
        ];
        const before = structuredClone(input);
        const packet = O.discussionTopicArrangementInput(input, units);
        assert.deepEqual([...packet.lockedTopicIndexes], [1]);
        assert.deepEqual(packet.records.map(r => r.recordId), ['late', 'early']);
        const arrangement = { groups: [
          { topic: 'Supplier receipt', recordIds: ['early'] },
          { topic: 'Inspection scheduling', recordIds: ['late'] }
        ] };
        const applied = O.applyDiscussionTopicArrangement(input, arrangement, units, { input: packet });
        assert.equal(applied.applied, true);
        assert.deepEqual(applied.discussion.map(t => t.id), ['generated-early', 'retained-card', 'generated-late']);
        assert.deepEqual(applied.discussion[1], before[1]);
        assert.equal(applied.diagnostics.lockedTopics, 1);
        assert.equal(applied.diagnostics.eligibleRecords, 2);
        assert.deepEqual(input, before);
      });
    }
  }
}
test('production prompt excludes all rows of a card with reviewer supporting context', () => {
  const input = [
    card('retained', [row('private-parent', 'S2', {
      text: 'Reviewer-controlled containing paragraph.',
      supportingDetails: [row('private-child', 'S2', { reviewerAuthored: true })]
    }), row('private-sibling')]),
    card('generated', [row('eligible')])
  ];
  const prompt = A.meetingMinutesAgentTopicArrangementPrompt({ discussion: input, sourceUnits: units });
  const records = JSON.parse(prompt.split('RECORDS_JSON=')[1]);
  assert.deepEqual(records.map(r => r.recordId), ['eligible']);
  assert.doesNotMatch(prompt, /private-parent|private-child|private-sibling|Reviewer-controlled containing paragraph/);
  assert.match(prompt, /There are exactly 1 supplied recordIds/);
});
test('an attempted model assignment of a withheld parent is rejected without moving anything', () => {
  const input = [card('retained', [row('withheld', 'S2', {
    supportingDetails: [row('owned', 'S2', { reviewerAuthored: true })]
  })]), card('generated', [row('eligible')])];
  const before = structuredClone(input);
  const result = O.applyDiscussionTopicArrangement(input, { groups: [
    { topic: 'Combined certificates', recordIds: ['withheld', 'eligible'] }
  ] }, units);
  assert.equal(result.applied, false);
  assert.equal(result.error.code, 'invalid_topic_arrangement');
  assert.deepEqual(result.discussion, before);
  assert.deepEqual(input, before);
});
test('all protected cards stay unchanged when the eligible input is empty', () => {
  const input = [card('retained', [row('parent', 'S2', {
    supportingDetails: [row('owned', 'S2', { reviewerAuthored: true })]
  })])];
  const before = structuredClone(input);
  const packet = O.discussionTopicArrangementInput(input, units);
  assert.equal(packet.records.length, 0);
  const result = O.applyDiscussionTopicArrangement(input, { groups: [] }, units, { input: packet });
  assert.equal(result.applied, false);
  assert.equal(result.error, null);
  assert.deepEqual(result.discussion, before);
});
test('generated descendants and ordinary no-edit acceptance remain eligible for regrouping', () => {
  const input = [card('one', [row('first', 'S3', {
    supportingDetails: [row('generated-child', 'S2', {
      locked: true, status: 'human_approved', source: 'stage_2_no_edit_acceptance',
      reviewerAuthored: false, confirmedTopic: false,
      supportingDetails: [row('generated-grandchild', 'S1')]
    })]
  })]), card('two', [row('second', 'S1')])];
  const before = structuredClone(input), packet = O.discussionTopicArrangementInput(input, units);
  assert.equal(packet.lockedTopicIndexes.size, 0);
  assert.deepEqual(packet.records.map(r => r.recordId), ['first', 'second']);
  const result = O.applyDiscussionTopicArrangement(input, { groups: [
    { topic: 'Equipment documentation', recordIds: ['first', 'second'] }
  ] }, units, { input: packet });
  assert.equal(result.applied, true);
  assert.equal(result.discussion.length, 1);
  assert.deepEqual(result.discussion[0].points.map(r => r.id), ['second', 'first']);
  assert.deepEqual(result.discussion[0].points[1].supportingDetails[0].supportingDetails[0],
    before[0].points[0].supportingDetails[0].supportingDetails[0]);
  assert.deepEqual(input, before);
});
