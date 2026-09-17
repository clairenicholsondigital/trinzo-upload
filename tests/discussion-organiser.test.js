'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  organiseDiscussionForReview, stripClosure, retypeRows, demoteUnreadyRows,
  consolidateTopics, rehomeSupportingDetails, sortByEvidence, unitIndex
} = require('../utils/canonicalMinutes/discussionOrganiser');

// Turn-level units in transcript order; ids carry the order.
const units = [
  { id: 'T0001', speaker: 'Jacqui Fox', text: 'So the tracker has moved from thirteen to ten in the twenty to thirty-nine percent band.' },
  { id: 'T0002', speaker: 'Jacqui Fox', text: 'Rebecca, you have reviewed David feedback on that.' },
  { id: 'T0003', speaker: 'Jacqui Fox', text: 'Is there updates you need from us on one or two of those comments from Monday?' },
  { id: 'T0004', speaker: 'Rebecca Gill', text: 'Yes. So there was, I think David had put in two comments and I have addressed them.' },
  { id: 'T0005', speaker: 'Jacqui Fox', text: 'The alarm changes seem to have gone through successfully.Across the three parameters, which are sound, flash, and color, and...So there is one outstanding point, I suppose, really in terms of the mute button.' },
  { id: 'T0006', speaker: 'Jacqui Fox', text: 'Andrew has been able to prove that the memory capacity exists for those twelve additional languages.' },
  { id: 'T0007', speaker: 'Jacqui Fox', text: 'The two code changes should be completed by the end of next week.' },
  { id: 'T0008', speaker: 'Rebecca Gill', text: 'We are still waiting for Christina to come back to finalise the operational procedures.' },
  { id: 'T0009', speaker: 'Jacqui Fox', text: 'Perfect. Thank you ever so much folks. Bye bye.' }
];
const index = unitIndex(units);

const cloneVectors = (signatures) => signatures.map((signature) => {
  // Deterministic stand-in for MiniLM: software topics point one way, risk topics another.
  const s = signature.toLowerCase();
  return [/\b(?:software|language|alarm|code)\b/.test(s) ? 1 : 0, /\b(?:risk|feedback|comments)\b/.test(s) ? 1 : 0, /\b(?:tracker|procedure|christina)\b/.test(s) ? 1 : 0];
});

test('closure clauses are stripped from row wording', () => {
  assert.equal(stripClosure('Main focus remains on risk and electrical compliance; meeting thanks and closure.'), 'Main focus remains on risk and electrical compliance');
  assert.equal(stripClosure('Sign-off hoped for early next week.'), 'Sign-off hoped for early next week.');
  assert.equal(stripClosure('Main focus remains on risk and electrical compliance; meeting concluded with thanks.'), 'Main focus remains on risk and electrical compliance');
  assert.equal(stripClosure('Main focus remains on risk and electrical compliance working with David and Andrew; meeting thanks and closing remarks.'), 'Main focus remains on risk and electrical compliance working with David and Andrew');
  assert.equal(stripClosure('Priorities confirmed; the meeting was concluded.'), 'Priorities confirmed');
  assert.equal(stripClosure('The meeting concluded that the chiller must be serviced first.'), 'The meeting concluded that the chiller must be serviced first.');
});

test('status statements labelled Decision become points; answered open questions become points', () => {
  const topic = retypeRows({
    topic: 'Software', points: [],
    decisions: [
      { id: 'd1', text: 'Memory capacity confirmed for 12 additional languages; code changes expected completed by end of next week.', evidenceIds: ['T0006', 'T0007'] },
      { id: 'd2', text: 'Decision to order six additional sacks of malt to cover the shortfall.', evidenceIds: ['T0006'] }
    ],
    openQuestions: [
      { id: 'q1', text: "Rebecca reviewed David's feedback; queries if updates are needed on Monday's comments.", evidenceIds: ['T0002', 'T0003', 'T0004'] },
      { id: 'q2', text: 'Whether the mute-button flash sequence is acceptable remains unresolved.', evidenceIds: ['T0005'] },
      { id: 'q3', text: 'Christina is still away.', evidenceIds: ['T0008'] }
    ]
  }, index);
  assert.deepEqual(topic.decisions.map((r) => r.id), ['d2']);
  assert.deepEqual(topic.openQuestions.map((r) => r.id), ['q2']);
  assert.deepEqual(topic.points.map((r) => r.id).sort(), ['d1', 'q1', 'q3']);
});

test('verbatim transcript sentences and conversational rows are demoted to context, flagged rows are not', () => {
  const topics = demoteUnreadyRows([{
    topic: 'Alarms',
    points: [
      { id: 'p1', text: 'The alarm change is complete across sound, flash and colour; the mute-button flash sequence is outstanding.', evidenceIds: ['T0005'], reviewFlagIds: [] },
      { id: 'raw', text: 'The alarm changes seem to have gone through successfully.Across the three parameters, which are sound, flash, and color, and...So there is one outstanding point, I suppose, really in terms of the mute button.', evidenceIds: ['T0005'], reviewFlagIds: [] },
      { id: 'flagged', text: 'So we think the mute button is fine.', evidenceIds: ['T0005'], reviewFlagIds: ['flag-1'] }
    ], decisions: [], openQuestions: []
  }], index);
  assert.deepEqual(topics[0].points.map((r) => r.id), ['p1', 'flagged']);
  assert.deepEqual(topics[0].points[0].supportingDetails.map((d) => d.id), ['raw']);
});

test('a topic made only of a raw sentence is folded into the nearest topic as context', () => {
  const topics = demoteUnreadyRows([
    { topic: 'Languages', points: [{ id: 'p1', text: 'Memory capacity exists for the twelve additional languages.', evidenceIds: ['T0006'] }], decisions: [], openQuestions: [] },
    { topic: 'Discussion', points: [], decisions: [], openQuestions: [{ id: 'raw', text: 'The alarm changes seem to have gone through successfully.Across the three parameters, which are sound, flash, and color, and...So there is one outstanding point, I suppose, really in terms of the mute button.', evidenceIds: ['T0005'] }] }
  ], index);
  assert.equal(topics.length, 1);
  assert.equal(topics[0].points[0].supportingDetails[0].id, 'raw');
});

test('topics are consolidated by evidence adjacency and label similarity, generic topics fold in, and a cap applies', async () => {
  const topics = [
    { id: 'a', topic: 'Software language support and code changes', points: [{ id: 'p1', text: 'Memory capacity exists for the twelve additional languages.', evidenceIds: ['T0006'] }], decisions: [], openQuestions: [] },
    { id: 'b', topic: 'Detail added on software changes', points: [{ id: 'p2', text: 'The two code changes should be completed by the end of next week.', evidenceIds: ['T0007'] }], decisions: [], openQuestions: [] },
    { id: 'c', topic: 'Tracker Movement', points: [{ id: 'p3', text: 'Tracker movement is positive, from thirteen to ten.', evidenceIds: ['T0001'] }], decisions: [], openQuestions: [] },
    { id: 'd', topic: 'Discussion', points: [{ id: 'p4', text: 'Christina is still away so the procedures wait.', evidenceIds: ['T0008'] }], decisions: [], openQuestions: [] },
    { id: 'e', topic: 'Updates needed on risk management comments', points: [{ id: 'p5', text: "Rebecca addressed David's two comments on the risk plan.", evidenceIds: ['T0002', 'T0004'] }], decisions: [], openQuestions: [] }
  ];
  const merged = await consolidateTopics(topics, index, { encode: cloneVectors, minTopics: 2, maxTopics: 3 });
  const labels = merged.map((topic) => topic.topic);
  // Software topics merged (similar + adjacent); generic "Discussion" folded into its neighbour; cap of 3 respected; transcript order.
  assert.ok(merged.length <= 3, labels.join(' | '));
  const software = merged.find((topic) => topic.points.some((r) => r.id === 'p1'));
  assert.ok(software.points.some((r) => r.id === 'p2'), 'adjacent software topics merge');
  assert.ok(!labels.includes('Discussion'), 'generic label does not survive');
  assert.equal(merged[0].points.some((r) => r.id === 'p3') || merged[0].points.some((r) => r.id === 'p5'), true, 'earliest evidence first');
});

test('topics whose labels share a distinctive word and read alike merge; different subjects do not', async () => {
  const labelVectors = (values) => values.map((value) => {
    const s = value.toLowerCase();
    return [/festival/.test(s) ? 1 : 0.1, /malt/.test(s) ? 1 : 0, /hop\b|hops/.test(s) ? 1 : 0, /order/.test(s) ? 0.6 : 0];
  });
  const merged = await consolidateTopics([
    { id: 'a', topic: 'Festival Commitment (Beer Festival)', points: [{ id: 'p1', text: 'The festival on the twenty-second needs product.', evidenceIds: ['T0001'] }], decisions: [], openQuestions: [] },
    { id: 'b', topic: 'Malt stock levels', points: [{ id: 'p2', text: 'Eighteen sacks is not enough for both brews.', evidenceIds: ['T0004'] }], decisions: [], openQuestions: [] },
    { id: 'c', topic: 'Hop order urgency', points: [{ id: 'p3', text: 'Seven point two kilos must be ordered this week.', evidenceIds: ['T0007'] }], decisions: [], openQuestions: [] },
    { id: 'd', topic: 'Festival order finalisation', points: [{ id: 'p4', text: 'Fifteen firkins agreed for the festival.', evidenceIds: ['T0009'] }], decisions: [], openQuestions: [] }
  ], index, { encode: labelVectors, minTopics: 3, maxTopics: 8 });
  const labels = merged.map((topic) => topic.topic);
  const festival = merged.find((topic) => topic.points.some((r) => r.id === 'p1'));
  assert.ok(festival.points.some((r) => r.id === 'p4'), 'the two festival topics merge despite being far apart: ' + labels.join(' | '));
  assert.equal(merged.length, 3, 'malt and hops stay separate: ' + labels.join(' | '));
});

test('supporting context is re-homed to the topic whose evidence window contains it', () => {
  const topics = [
    { topic: 'Risk comments', points: [{ id: 'p1', text: "Rebecca addressed David's comments.", evidenceIds: ['T0002', 'T0004'], supportingDetails: [
      { id: 'c1', text: 'Operational procedures await Christina.', evidenceIds: ['T0008'] },
      { id: 'c2', text: 'David put in two comments.', evidenceIds: ['T0004'] }
    ] }], decisions: [], openQuestions: [] },
    { topic: 'Process maps', points: [{ id: 'p2', text: 'Procedures are waiting for Christina.', evidenceIds: ['T0008'], supportingDetails: [] }], decisions: [], openQuestions: [] }
  ];
  rehomeSupportingDetails(topics, index);
  assert.deepEqual(topics[0].points[0].supportingDetails.map((d) => d.id), ['c2']);
  assert.deepEqual(topics[1].points[0].supportingDetails.map((d) => d.id), ['c1']);
});

test('topics and rows are ordered by their earliest evidence', () => {
  const ordered = sortByEvidence([
    { topic: 'Closure', points: [{ id: 'z', text: 'Focus remains on risk.', evidenceIds: ['T0009'] }], decisions: [], openQuestions: [] },
    { topic: 'Tracker', points: [{ id: 'b', text: 'Second in topic.', evidenceIds: ['T0003'] }, { id: 'a', text: 'First in topic.', evidenceIds: ['T0001'] }], decisions: [], openQuestions: [] }
  ], index);
  assert.deepEqual(ordered.map((topic) => topic.topic), ['Tracker', 'Closure']);
  assert.deepEqual(ordered[0].points.map((r) => r.id), ['a', 'b']);
});

test('the full pass preserves record ids and evidence and reports its counts', async () => {
  const result = await organiseDiscussionForReview([
    { id: 't1', topic: 'Main focus areas and meeting closure', points: [{ id: 'p1', text: 'Main focus remains on risk; meeting thanks and closure.', evidenceIds: ['T0009'], reviewFlagIds: [] }], decisions: [], openQuestions: [] },
    { id: 't2', topic: 'Tracker Movement', points: [{ id: 'p2', text: 'Tracker movement is positive, from thirteen to ten.', evidenceIds: ['T0001'], reviewFlagIds: ['f1'] }], decisions: [], openQuestions: [] }
  ], units, { encode: cloneVectors, minTopics: 1 });
  const ids = result.discussion.flatMap((topic) => [...topic.points, ...topic.decisions, ...topic.openQuestions]).map((r) => r.id).sort();
  assert.deepEqual(ids, ['p1', 'p2']);
  const p1 = result.discussion.flatMap((topic) => topic.points).find((r) => r.id === 'p1');
  assert.equal(p1.text, 'Main focus remains on risk');
  assert.deepEqual(p1.evidenceIds, ['T0009']);
  const p2 = result.discussion.flatMap((topic) => topic.points).find((r) => r.id === 'p2');
  assert.deepEqual(p2.reviewFlagIds, ['f1']);
  assert.equal(result.before.rows, 2);
  assert.equal(result.after.rows, 2);
  assert.equal(result.discussion[0].points[0].id, 'p2', 'tracker (first thing said) comes first');
});
