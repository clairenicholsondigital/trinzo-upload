const test = require('node:test');
const assert = require('node:assert/strict');

const { normaliseAgentResult } = require('../utils/meetingMinutesResultNormalization');

const units = [
  { id: 'T0001', text: 'We reviewed the delivery timeline for the launch.' },
  { id: 'T0002', text: 'Budget approval for the vendor contract was discussed.' },
  { id: 'T0003', text: 'Hiring for the support role is on hold.' },
  { id: 'T0004', text: 'Office move dates are still to be confirmed.' }
];
const point = (id, text, evidence) => ({ id, text, evidenceIds: [evidence] });
const discussion = [
  { id: 't1', topic: 'Project timeline', points: [point('p1', 'The team reviewed the delivery timeline for the launch.', 'T0001')] },
  { id: 't2', topic: 'Project', points: [point('p2', 'Budget approval for the vendor contract was discussed.', 'T0002')] },
  { id: 'manual-topic-1', topic: 'New topic', points: [point('p3', 'Hiring for the support role is on hold.', 'T0003')] },
  { id: 'manual-topic-2', topic: 'New topic', points: [point('p4', 'Office move dates are still to be confirmed.', 'T0004')] }
];

test('a reviewer save keeps topics with overlapping headings separate', () => {
  const saved = normaliseAgentResult({ discussion }, units, '', {
    enforceEvidence: false, dedupeActions: false, mergeTopics: false
  });
  assert.deepEqual(saved.discussion.map((topic) => topic.topic), ['Project timeline', 'Project', 'New topic', 'New topic']);
});

test('agent output still merges topics whose headings overlap', () => {
  const generated = normaliseAgentResult({ discussion }, units, 'discussion');
  assert.deepEqual(generated.discussion.map((topic) => topic.topic), ['Project timeline', 'New topic']);
});
