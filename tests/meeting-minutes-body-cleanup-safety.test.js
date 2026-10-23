'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { dedupeDiscussionBody } = require('../utils/discussionShape');
const row = (id, text = 'The supplier provided the calibration certificate.', extra = {}) =>
  ({ id, text, evidenceIds: ['S1'], reviewFlagIds: [], supportingDetails: [], ...extra });
const topic = (id, rows, extra = {}) => ({ id, topic: 'Equipment certification', points: rows, decisions: [], openQuestions: [], ...extra });
const records = result => result.discussion.flatMap(t => [...t.points, ...t.decisions, ...t.openQuestions]);
const ids = result => records(result).map(r => r.id);
const checkPreserved = input => {
  const before = structuredClone(input), result = dedupeDiscussionBody(input);
  assert.deepEqual(result.discussion, before);
  assert.deepEqual(input, before);
  assert.equal(result.dropped.length, 0);
};
const locks = [
  ['reviewer flag', { reviewerAuthored: true }],
  ['confirmed flag', { confirmedTopic: true }],
  ['human source', { source: 'discussion_human_confirmation' }],
  ['manual identity', { id: 'manual-context' }],
  ['reviewer identity', { id: 'reviewer-context' }]
];
for (const [name, marker] of locks) {
  for (const kind of ['points', 'decisions', 'openQuestions']) {
    test(name + ' on a nested ' + kind + ' descendant preserves the complete card', () => {
      const held = topic('held', [row('echo'), row('announcement', 'Next steps: confirm the equipment inspection.')], {
        [kind]: [row('parent', 'The equipment inspection remains scheduled.', {
          supportingDetails: [row('bridge', undefined, {
            supportingDetails: [row('owned', undefined, marker)]
          })]
        })]
      });
      checkPreserved([topic('before', [row('generated')]), held]);
    });
  }
  test(name + ' preserves a topic, including a reviewer-retained structural row', () => {
    checkPreserved([topic('held', [row('announcement', 'Next steps: confirm the equipment inspection.')], marker)]);
  });
}
for (const [name, extra] of [
  ['warning', { reviewFlagIds: ['warning-to-retain'] }],
  ['supporting context', { supportingDetails: [row('context', 'The supplier requested independent confirmation.')] }],
  ['unfamiliar provenance', { originalTopic: 'Supplier documents' }],
  ['primary citation metadata', { primaryEvidenceIds: ['S1'] }],
  ['invalid evidence', { evidenceIds: ['S1', 7] }]
]) {
  for (const reverse of [false, true]) test(name + ' survives duplicate cleanup in order ' + reverse, () => {
    const input = [row('simple'), row('rich', undefined, extra)];
    if (reverse) input.reverse();
    checkPreserved([topic('equipment', input)]);
  });
  test(name + ' survives action-announcement removal', () => {
    checkPreserved([topic('equipment', [row('rich', 'Next steps: confirm the equipment inspection.', extra)])]);
  });
}
test('predecessor history on an announcement is not discarded', () => {
  checkPreserved([topic('equipment', [row('retained', 'Next steps: confirm the inspection.', { mergedFromIds: ['earlier'] })])]);
});
for (const [name, left, right] of [
  ['negation', 'The supplier approved the calibration certificate.', 'The supplier has not approved the calibration certificate.'],
  ['quantity', 'The supplier provided three calibration certificates.', 'The supplier provided four calibration certificates.'],
  ['one and two', 'The supplier provided one calibration certificate.', 'The supplier provided two calibration certificates.'],
  ['zero and one', 'The supplier provided zero calibration certificates.', 'The supplier provided one calibration certificate.'],
  ['uncertainty', 'The inspection will proceed after certificate approval.', 'The inspection might proceed after certificate approval.'],
  ['estimate', 'There are eleven people on the inspection list.', 'There are, I think, eleven people on the inspection list.'],
  ['approximation', '1200 litres yields about 22 clean 50-litre kegs after losses.', 'The batch size of twelve hundred litres at fifty-litre kegs yields twenty-two clean kegs after losses.'],
  ['condition', 'The inspection will proceed if the certificate is approved.', 'The inspection will proceed.'],
  ['different conditions', 'The inspection will proceed if the certificate is approved.', 'The inspection will proceed if the permit is approved.'],
  ['opposite bounds', 'The calibration costs under fifty pounds.', 'The calibration costs over fifty pounds.']
]) {
  for (const reverse of [false, true]) test(name + ' is not a duplicate in order ' + reverse, () => {
    const input = [row('first', left), row('second', right)];
    if (reverse) input.reverse();
    checkPreserved([topic('equipment', input)]);
  });
}
test('equivalent compact currency values still deduplicate without changing action-number handling', () => {
  const result = dedupeDiscussionBody([topic('budget', [
    row('full', 'The inspection budget is approximately £8,000.'),
    row('compact', 'The inspection budget is approximately £8k.')
  ])]);
  assert.equal(records(result).length, 1);
  assert.deepEqual(records(result)[0].mergedFromIds, ['compact']);
});

test('all distinct evidence and predecessor identities survive three eligible repeats', () => {
  const input = [topic('equipment', [
    row('first', undefined, { evidenceIds: ['S1'], mergedFromIds: ['older-first'] }),
    row('second', undefined, { evidenceIds: ['S2'], mergedFromIds: ['older-second'] }),
    row('third', undefined, { evidenceIds: ['S3'] })
  ])], before = structuredClone(input);
  const result = dedupeDiscussionBody(input), kept = records(result)[0];
  assert.equal(records(result).length, 1);
  assert.deepEqual(kept.evidenceIds, ['S1', 'S2', 'S3']);
  assert.deepEqual(new Set([kept.id, ...kept.mergedFromIds]),
    new Set(['first', 'second', 'third', 'older-first', 'older-second']));
  assert.deepEqual(input, before);
  assert.deepEqual(dedupeDiscussionBody(result.discussion).discussion, result.discussion);
});
for (const [name, extra] of [
  ['evidence overflow', { evidenceIds: Array.from({ length: 12 }, (_, i) => 'E' + i) }],
  ['history overflow', { mergedFromIds: Array.from({ length: 1000 }, (_, i) => 'old-' + i) }]
]) test(name + ' retains both rows rather than truncating metadata', () => {
  checkPreserved([topic('equipment', [row('first'), row('second', undefined, extra)])]);
});
test('compound trimming retains a differently qualified overlapping clause', () => {
  checkPreserved([topic('equipment', [
    row('compound', 'The supplier might approve the calibration certificate; the inspection needs a permit.'),
    row('certain', 'The supplier will approve the calibration certificate.')
  ])]);
});
test('compound trimming does not reassign different source citations', () => {
  checkPreserved([topic('equipment', [
    row('compound', 'The supplier supplied the calibration certificate; the inspection needs a permit.'),
    row('atomic', 'The supplier supplied the calibration certificate.', { evidenceIds: ['S2'] })
  ])]);
});
test('a qualified allocation count and its accepted warning survive beside a fuller decision', () => {
  const input = [topic('allocation', [
    row('corrected', 'There are, I think, thirteen people on the inspection list.', { reviewFlagIds: ['wording-corrected'] })
  ], { decisions: [row('decision', 'With three places available and thirteen people on the inspection list, the coordinator will contact the top three candidates.')] })];
  checkPreserved(input);
});
test('a changed condition in a named recap survives', () => {
  const input = [topic('equipment', [
    row('first', 'Alex Hall will submit the certificate if the supplier approves it.'),
    row('second', 'Priya Rao will request the equipment permit.'),
    row('recap', 'Alex Hall will submit the certificate; Priya Rao will request the equipment permit.')
  ])], before = structuredClone(input);
  assert.deepEqual(dedupeDiscussionBody(input, ['Alex Hall', 'Priya Rao']).discussion, before);
});
test('eligible named recaps retain their identity history on the represented rows', () => {
  const input = [topic('equipment', [
    row('first', 'Alex Hall will submit the certificate.'),
    row('second', 'Priya Rao will request the equipment permit.'),
    row('recap', 'Alex Hall will submit the certificate; Priya Rao will request the equipment permit.',
      { mergedFromIds: ['earlier-recap'] })
  ])];
  const result = dedupeDiscussionBody(input, ['Alex Hall', 'Priya Rao']);
  assert.deepEqual(ids(result), ['first', 'second']);
  for (const r of records(result)) assert.deepEqual(r.mergedFromIds, ['recap', 'earlier-recap']);
});

for (const [name, left, right] of [
  ['contracted negation', 'The supplier has approved the certificate.', "The supplier hasn't approved the certificate."],
  ['curly contracted negation', 'The supplier has approved the certificate.', 'The supplier hasn’t approved the certificate.'],
  ['tentative status', 'The inspection is scheduled.', 'The inspection is tentatively scheduled.'],
  ['unconfirmed status', 'The inspection is scheduled.', 'The inspection is unconfirmed.'],
  ['provided condition', 'The inspection will proceed provided the certificate is approved.', 'The inspection will proceed.'],
  ['dependent condition', 'The inspection will proceed dependent on certificate approval.', 'The inspection will proceed.']
]) test(name + ' is preserved in both arrival orders', () => {
  for (const pair of [[left, right], [right, left]]) {
    checkPreserved([topic('equipment', pair.map((text, i) => row('claim-' + i, text)))]);
  }
});

