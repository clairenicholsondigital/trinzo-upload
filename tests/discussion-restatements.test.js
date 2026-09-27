'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeRestatedRows } = require('../utils/canonicalMinutes/discussionOrganiser');

// Fake embeddings: rows about the same fact point the same way.
const encode = async (texts) => texts.map((t) => (/iso 27427|nebuli/i.test(t) ? [1, 0.05, 0] : /led|mute/i.test(t) ? [0, 1, 0.05] : [0, 0, 1]));
const topic = (rows) => ({ id: 'topic-1', topic: 'Nebulizer standard applicability', points: rows.points || [], decisions: rows.decisions || [], openQuestions: rows.openQuestions || [] });

test('two rows of one kind that state the same fact from a shared line become one row with all the evidence', async () => {
  const topics = [topic({ points: [
    { id: 'r1', text: 'Discussion on whether ISO 27427:2023 applies to FD140i nebulization function, with differing opinions and a request for explanation.', evidenceIds: ['T0085', 'T0090'], reviewFlagIds: ['f1'] },
    { id: 'r2', text: 'ISO 27427 2023 review is ongoing to clarify how FD140i may work in terms of nebulizing.', evidenceIds: ['T0090', 'T0101'], reviewFlagIds: [] },
    { id: 'r3', text: 'Andrew proposes changing the mute alarm LED to flash at different rates indicating alarm priority.', evidenceIds: ['T0155'], reviewFlagIds: [] }
  ] })];
  const merges = [];
  const out = await mergeRestatedRows(topics, null, { mergeRestatements: true, encode, onRestatements: (m) => merges.push(...m) });
  assert.equal(out[0].points.length, 2);
  assert.equal(out[0].points[0].id, 'r1', 'the fuller wording is kept');
  assert.deepEqual(out[0].points[0].evidenceIds.sort(), ['T0085', 'T0090', 'T0101']);
  assert.deepEqual(out[0].points[0].reviewFlagIds, ['f1']);
  assert.equal(merges.length, 1);
  assert.ok(merges[0].sharedLine);
});

test('a question and the point that answers it are not a restatement, nor are rows in different topics', async () => {
  const q = { id: 'q1', text: 'Whether ISO 27427:2023 applies to the FD140i nebulization function.', evidenceIds: ['T0085'] };
  const p = { id: 'p1', text: 'ISO 27427 applies only if the FD140i itself nebulizes; it supplies flow to a connected nebulizer.', evidenceIds: ['T0085'] };
  const same = await mergeRestatedRows([topic({ openQuestions: [q], points: [p] })], null, { mergeRestatements: true, encode });
  assert.equal(same[0].openQuestions.length + same[0].points.length, 2);
  const apart = await mergeRestatedRows([topic({ points: [p] }), { ...topic({ points: [{ ...q, id: 'q2' }] }), id: 'topic-2', topic: 'Standards' }], null, { mergeRestatements: true, encode });
  assert.equal(apart[0].points.length + apart[1].points.length, 2);
});

test('without a shared line, only rows sharing most of their words merge; and the option must be on', async () => {
  const rows = [
    { id: 'a', text: 'Five languages were added to the code without issues; four others have characters not in current drivers.', evidenceIds: ['T0180'] },
    { id: 'b', text: 'The nebulizer flow specification is six litres per minute.', evidenceIds: ['T0130'] }
  ];
  const off = await mergeRestatedRows([topic({ points: rows })], null, { encode });
  assert.equal(off[0].points.length, 2);
  const on = await mergeRestatedRows([topic({ points: rows })], null, { mergeRestatements: true, encode: async (t) => t.map(() => [1, 0, 0]) });
  assert.equal(on[0].points.length, 2, 'identical vectors alone do not merge unrelated wordings');
});
