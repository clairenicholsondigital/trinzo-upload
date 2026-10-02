'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { discourseSegments, segmentAnchors, segmentLabels, regroupDiscussionBySegments, SHIFT_MARKER } = require('../utils/canonicalMinutes/discourseSegments');
const { stagedEvaluation } = require('../routes/api');

const unit = (n, speaker, text) => ({ id: `T${String(n).padStart(4, '0')}`, speaker, text });
// Three subjects, opened by the chair's own agenda language (from draft 1023).
const units = [
  unit(1, 'David', 'I have got a question for you about the probability numbers.'),
  unit(2, 'Rebecca', 'The justification is in the risk table appendix.'),
  unit(3, 'David', 'So the auditor can see where each number came from.'),
  unit(4, 'Jacqui', 'And is that documented anywhere else?'),
  unit(5, 'Rebecca', 'Only in the risk management plan itself.'),
  unit(6, 'Jacqui', 'Okay, so that covers the probability numbers.'),
  unit(7, 'Jacqui', 'And then we move on to the languages.'),
  unit(8, 'Andrew', 'I have added five of those languages into the code.'),
  unit(9, 'Andrew', 'There are another four with characters missing from the drivers.'),
  unit(10, 'Jacqui', 'Has that been resolved?'),
  unit(11, 'Andrew', 'I am trying to get access to the font creator tool.'),
  unit(12, 'David', 'There is a folder in there you can use.'),
  unit(13, 'Jacqui', 'Okay, back to last week and the follow-up actions.'),
  unit(14, 'Jacqui', 'The status of the mute button on the flash sequence.'),
  unit(15, 'Andrew', 'The mute LED now ramps slowly off and on.'),
  unit(16, 'David', 'Does that mean the change request is signed off?'),
  unit(17, 'Jacqui', 'Yes, once the parameter changes are approved.'),
  unit(18, 'Andrew', 'I will update the change request this week.')
];

test('the chair\'s agenda language marks a subject change; ordinary "back to" does not', () => {
  assert.ok(SHIFT_MARKER.test('And then we move on to the languages.'));
  assert.ok(SHIFT_MARKER.test('Okay, back to last week and the follow-up actions.'));
  assert.ok(SHIFT_MARKER.test('So the next one was around the review of the IEC standard.'));
  assert.ok(SHIFT_MARKER.test('Okay, and then where is my other questions? Second question is around the fan logic.'));
  assert.ok(SHIFT_MARKER.test('First thing, the broken tap by the gate.'));
  assert.ok(SHIFT_MARKER.test("While we're on you, the waiting list."));
  assert.ok(SHIFT_MARKER.test('Now, the annual show.'));
  assert.ok(SHIFT_MARKER.test('Can I raise the shed?'));
  assert.ok(SHIFT_MARKER.test('Go on then, do the fence.'));
  assert.ok(SHIFT_MARKER.test('Right, the big one.'));
  assert.ok(!SHIFT_MARKER.test('I went back to Colm yesterday.'));
  assert.ok(!SHIFT_MARKER.test("Two a week is roughly the run rate, so we're back to normal."));
  assert.ok(!SHIFT_MARKER.test('Nearly all of this comes back to that.'));
});

test('short coherent meetings are not forced into five artificial passages', async () => {
  const coherent = Array.from({ length: 24 }, (_, index) => unit(index + 1, 'Alex',
    index < 12 ? `Validation evidence item ${index + 1}.` : `Supplier contract item ${index + 1}.`));
  const encode = async (texts) => texts.map((value) => /Validation/i.test(value) ? [1, 0] : [0, 1]);
  const segments = await discourseSegments(coherent, { encode, unitsPerSegment: 16, blockSize: 3 });
  assert.equal(segments.length, 2);
});

test('segments cut at the hard markers, with even spacing when no embeddings are available', async () => {
  const segments = await discourseSegments(units, { encode: async () => null, minSegments: 3, unitsPerSegment: 6 });
  const starts = segments.map((s) => s.start);
  assert.ok(starts.includes(6), 'cut before "And then we move on to the languages"');
  assert.ok(starts.includes(12), 'cut before "Okay, back to last week"');
  assert.ok(segments.every((s) => s.end - s.start >= 5));
  assert.deepEqual(segments.flatMap((s) => s.ids), units.map((u) => u.id), 'every unit belongs to exactly one segment');
});

test('cohesion valleys add soft cuts between hard ones', async () => {
  // Two clearly different vector "subjects" either side of unit 9 in a run
  // with no markers at all.
  const plain = units.map((u) => ({ ...u, text: u.text.replace(/^(?:And then we move on|Okay, back) /, 'And ') }));
  const encode = async (texts) => texts.map((t) => (/language|character|font|driver|code/i.test(t) ? [1, 0, 0] : [0, 1, 0]));
  const segments = await discourseSegments(plain, { encode, minSegments: 2, maxSegments: 2, unitsPerSegment: 9, blockSize: 3 });
  assert.equal(segments.length, 2);
  assert.ok(segments[1].start >= 6 && segments[1].start <= 9, `cut near the subject change, got ${segments[1].start}`);
});

test('segments become anchors the discovery prompt can name, and labels come back by anchor id', () => {
  const segments = [{ start: 0, end: 7, ids: units.slice(0, 7).map((u) => u.id) }, { start: 7, end: 18, ids: units.slice(7).map((u) => u.id) }];
  const anchors = segmentAnchors(units, segments);
  assert.equal(anchors.length, 2);
  assert.equal(anchors[0].anchorId, 'DS-T0001-T0007');
  assert.match(anchors[1].window, /\[T0008\] Andrew: I have added five/);
  const labels = segmentLabels({ anchorResults: [{ anchorId: 'DS-T0008-T0018', topic: 'Language support' }] }, anchors);
  assert.deepEqual(labels, ['', 'Language support']);
});

test('records are filed under the segment holding their evidence; unlabelled segments keep the record\'s own topic', () => {
  const segments = [{ start: 0, end: 7, ids: units.slice(0, 7).map((u) => u.id) }, { start: 7, end: 12, ids: units.slice(7, 12).map((u) => u.id) }, { start: 12, end: 18, ids: units.slice(12).map((u) => u.id) }];
  const discussion = [
    { id: 'topic-1', topic: 'Location of justification for probability scores', points: [{ id: 'r1', text: 'Justification sits in the risk table appendix.', evidenceIds: ['T0002', 'T0003'] }], decisions: [], openQuestions: [] },
    { id: 'topic-2', topic: 'Documentation of probability numbers', points: [], decisions: [], openQuestions: [{ id: 'r2', text: 'Whether the numbers are documented elsewhere.', evidenceIds: ['T0004', 'T0005'] }] },
    { id: 'topic-3', topic: 'Language character restrictions and font driver updates', points: [{ id: 'r3', text: 'Five languages added; four still lack driver characters.', evidenceIds: ['T0008', 'T0009'] }], decisions: [], openQuestions: [] },
    { id: 'topic-4', topic: 'Proposed alarm mute LED behaviour change', points: [], decisions: [{ id: 'r4', text: 'The mute LED ramps slowly.', evidenceIds: ['T0015'] }], openQuestions: [] }
  ];
  const out = regroupDiscussionBySegments(discussion, units, segments, ['Probability justification', 'Language support', '']);
  assert.deepEqual(out.discussion.map((t) => t.topic), ['Probability justification', 'Language support', 'Proposed alarm mute LED behaviour change']);
  assert.equal(out.discussion[0].points.length, 1);
  assert.equal(out.discussion[0].openQuestions.length, 1, 'two captions about one subject become one topic');
  assert.equal(out.discussion[0].openQuestions[0].id, 'r2', 'records keep their ids and kinds');
  assert.equal(out.moved, 3);
});

test('the naming rule in code is the rule that was measured, and the naming request is a discovery request', () => {
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'topic-naming-rule-v1.txt'), 'utf8').trim();
  assert.equal(stagedEvaluation.MEETING_AGENT_TOPIC_NAMING_RULE, fixture);
  const anchors = segmentAnchors(units, [{ start: 0, end: 18, ids: units.map((u) => u.id) }]);
  const prompt = stagedEvaluation.meetingMinutesAgentTopicNamingPrompt({ transcript: 'x', details: { meetingTitle: 'Test' }, anchors });
  assert.equal(prompt.split('\n')[0], '[DISCUSSION_ANCHORED_DISCOVERY]');
  const payload = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1));
  assert.deepEqual(payload.writingRules, [fixture]);
  assert.equal(payload.anchors[0].anchorId, 'DS-T0001-T0018');
});
