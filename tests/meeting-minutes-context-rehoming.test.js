const test = require('node:test');
const assert = require('node:assert');
const { organiseDiscussionForReview } = require('../utils/canonicalMinutes/discussionOrganiser');

const units = Array.from({ length: 30 }, (unused, i) => ({
  id: `T${String(i + 1).padStart(4, '0')}`,
  speaker: 'Rebecca Gill',
  text: `Line ${i + 1} covering the compliance testing programme and its supporting documentation.`,
  classification: 'keep'
}));

// Topic A cites one early line and one stray late line, so its evidence window
// spans the whole meeting. Topic B is a tight window around the detail. A
// detail homeless in topic C must land in B, the topic that actually covers it,
// not in A merely because A is scanned first.
const discussion = () => ([
  {
    id: 'A', topic: 'Opening status and tracker movement',
    points: [{ id: 'a1', text: 'The tracker moved in the right direction this week.', evidenceIds: ['T0001', 'T0029'] }],
    decisions: [], openQuestions: []
  },
  {
    id: 'B', topic: 'Language support and firmware memory',
    points: [{ id: 'b1', text: 'The firmware memory supports the additional languages required.', evidenceIds: ['T0019', 'T0021'] }],
    decisions: [], openQuestions: []
  },
  {
    id: 'C', topic: 'Electrical compliance testing',
    points: [{
      id: 'c1', text: 'The electrical compliance testing can be completed in house.', evidenceIds: ['T0005'],
      supportingDetails: [{ id: 'd1', text: 'The symbol incompatibility affects three of the additional languages.', evidenceIds: ['T0020'] }]
    }],
    decisions: [], openQuestions: []
  }
]);

test('a homeless supporting line goes to the topic that covers it, not the widest one', async () => {
  const out = await organiseDiscussionForReview(discussion(), units);
  const where = out.discussion.find((topic) => (topic.points || [])
    .some((point) => (point.supportingDetails || []).some((detail) => detail.id === 'd1')));
  assert.ok(where, 'the supporting line must still exist somewhere');
  assert.equal(where.topic, 'Language support and firmware memory');
});

test('re-homing never loses a supporting line', async () => {
  const count = (disc) => disc.reduce((sum, topic) => sum
    + [...(topic.points || []), ...(topic.decisions || [])]
      .reduce((n, row) => n + (row.supportingDetails || []).length, 0), 0);
  const input = discussion();
  const out = await organiseDiscussionForReview(input, units);
  assert.equal(count(out.discussion), count(input));
});

test('a supporting line that just copies its own source line is dropped', async () => {
  const raw = units[9].text;
  const disc = [{
    id: 'A', topic: 'Electrical compliance testing',
    points: [{
      id: 'a1', text: 'The electrical compliance testing can be completed in house.', evidenceIds: ['T0005'],
      supportingDetails: [
        { id: 'v1', text: raw, evidenceIds: ['T0010'] },
        { id: 'k1', text: 'Three of the twelve languages need a symbol workaround before upload.', evidenceIds: ['T0010'] }
      ]
    }],
    decisions: [], openQuestions: []
  }];
  const out = await organiseDiscussionForReview(disc, units);
  const kept = out.discussion.flatMap((topic) => (topic.points || []).flatMap((p) => p.supportingDetails || []));
  assert.ok(!kept.some((d) => d.id === 'v1'), 'the verbatim copy is dropped');
  assert.ok(kept.some((d) => d.id === 'k1'), 'the line that says something new is kept');
});
