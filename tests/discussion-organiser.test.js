'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  organiseDiscussionForReview, stripClosure, retypeRows, demoteUnreadyRows,
  consolidateTopics, rehomeSupportingDetails, sortByEvidence, unitIndex,
  removeAnsweredQuestionClauses, removeContradictoryResponsibilities,
  isPersonalAside, isPeripheralAside, isRoutineMeetingAdministration,
  removePersonalAsides, normaliseDecisionTopicHeadings,
  dedupeAdjacentRestatements, finaliseDiscussionForPublication
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
  // A real use of "closure" is content, and a strip must never leave "…and".
  assert.equal(stripClosure('Outstanding mute button issue reviewed with clinical input to confirm acceptability and closure.'),
    'Outstanding mute button issue reviewed with clinical input to confirm acceptability and closure.');
  assert.equal(stripClosure('Next steps agreed; thanks and farewells.'), 'Next steps agreed');
});

test('personal wellbeing and time-away asides are not meeting content', () => {
  for (const wording of [
    'Morgan suggests that Alex needs a break.',
    'Morgan suggested that Alex take a break.',
    'Alex could use some rest.',
    'Priya thinks Morgan deserves some time off.',
    'Sam should book a holiday.',
    'Alex should get some downtime.',
    'Sam looks exhausted after a long week.',
    'It was suggested that he should get some sleep.'
  ]) assert.equal(isPersonalAside(wording), true, wording);
});

test('formal cover and safety arrangements are not mistaken for personal asides', () => {
  for (const wording of [
    'Alex will take a 15-minute break at 15:00 while Priya covers the session.',
    'Staff breaks must be staggered under the working-time policy to maintain coverage.',
    'The team agreed to take a break from testing until the results arrive.',
    'Operator fatigue was recorded as a safety risk requiring shift controls.',
    'Alex is overworked, putting the delivery schedule at risk.',
    'Alex should leave the meeting at 15:00 to join the client call.',
    'The team needs a break-even analysis before approving the plan.',
    'The warehouse break-in remains a security risk.'
  ]) assert.equal(isPersonalAside(wording), false, wording);
});

test('brief social reporting is filtered without suppressing material updates', () => {
  assert.equal(isPeripheralAside('Morgan mentioned bringing produce to the community show.'), true);
  assert.equal(isPeripheralAside('Sam joked about the weather before the meeting.'), true);
  assert.equal(isPeripheralAside('Morgan mentioned that the validation report remains blocked by supplier approval.'), false);
  assert.equal(isPeripheralAside('Sam mentioned the audit requirement and will send the evidence tomorrow.'), false);
});

test('routine meeting technology checks are filtered without suppressing substantive controls', () => {
  for (const wording of [
    'The presenter checks if the shared screen is visible and readable to participants.',
    'Morgan asks whether everyone can hear the audio.',
    'Priya verifies that the slides can be seen.'
  ]) assert.equal(isRoutineMeetingAdministration(wording), true, wording);
  for (const wording of [
    'The team agreed a backup screen-sharing route if the primary link fails.',
    'The microphone fault delayed the client interview.',
    'Audio recording is required by the evidence procedure.'
  ]) assert.equal(isRoutineMeetingAdministration(wording), false, wording);
});

test('routine meeting technology checks are removed from primary and supporting rows', () => {
  const cleaned = removePersonalAsides([{
    id: 'topic-1', topic: 'Demonstration',
    points: [{
      id: 'p1', text: 'The prototype workflow was demonstrated.', evidenceIds: ['T0001'],
      supportingDetails: [
        { id: 's1', text: 'Morgan checks if the screen shared is visible.', evidenceIds: ['T0002'] },
        { id: 's2', text: 'The screen-sharing failure delayed the demonstration.', evidenceIds: ['T0003'] }
      ]
    }, { id: 'p2', text: 'Morgan checks if the screen shared is visible and readable.', evidenceIds: ['T0002'] }],
    decisions: [], openQuestions: []
  }]);
  assert.deepEqual(cleaned[0].points.map((row) => row.id), ['p1']);
  assert.deepEqual(cleaned[0].points[0].supportingDetails.map((row) => row.id), ['s2']);
});

test('stale decision wrappers are removed only from topics with no decisions', () => {
  const cleaned = normaliseDecisionTopicHeadings([{
    id: 't1', topic: 'Decision on opportunity follow-up actions',
    points: [{ id: 'p1', text: 'The exact approach remains uncertain.' }], decisions: [], openQuestions: []
  }, {
    id: 't2', topic: 'Decision about release timing', points: [],
    decisions: [{ id: 'd1', text: 'The release was approved for Monday.' }], openQuestions: []
  }, {
    id: 't3', topic: 'Decision to possibly use a password',
    points: [{ id: 'p2', text: 'Password use remains a possibility.' }], decisions: [], openQuestions: []
  }]);
  assert.deepEqual(cleaned.map((topic) => topic.topic), [
    'Opportunity follow-up actions', 'Decision about release timing', 'Possibly use a password'
  ]);
});

test('adjacent same-kind restatements with shared evidence merge conservatively', async () => {
  const discussion = [{
    id: 't1', topic: 'Lead handling', decisions: [], openQuestions: [],
    points: [{
      id: 'p1', text: 'Information is brought to the leads to support reprioritisation and subsequent planning.',
      evidenceIds: ['T0001', 'T0004'], reviewFlagIds: ['f1'], supportingDetails: []
    }, {
      id: 'p2', text: 'The information is brought to the leads for reprioritisation, planning and execution.',
      evidenceIds: ['T0004', 'T0005'], reviewFlagIds: [], supportingDetails: [{ id: 's1', text: 'Results feed back into the process.' }]
    }]
  }];
  const cleaned = await dedupeAdjacentRestatements(discussion, {
    encode: (values) => values.map(() => [1, 0])
  });
  assert.equal(cleaned[0].points.length, 1);
  assert.equal(cleaned[0].points[0].id, 'p2', 'the more informative row is retained');
  assert.deepEqual(cleaned[0].points[0].evidenceIds, ['T0004', 'T0005', 'T0001']);
  assert.deepEqual(cleaned[0].points[0].reviewFlagIds, ['f1']);
  assert.deepEqual(cleaned[0].points[0].supportingDetails.map((row) => row.id), ['s1']);
});

test('restatement cleanup preserves rows with distinct figures, polarity or no shared evidence', async () => {
  const discussion = [{
    id: 't1', topic: 'Review', decisions: [], openQuestions: [],
    points: [
      { id: 'p1', text: 'The review covers 17 records.', evidenceIds: ['T0001'] },
      { id: 'p2', text: 'The review covers 43 records.', evidenceIds: ['T0001'] },
      { id: 'p3', text: 'The team will approve the plan.', evidenceIds: ['T0002'] },
      { id: 'p4', text: 'The team will not approve the plan.', evidenceIds: ['T0002'] },
      { id: 'p5', text: 'The report is ready for review.', evidenceIds: ['T0003'] },
      { id: 'p6', text: 'The report is ready for review.', evidenceIds: ['T0004'] },
      { id: 'p7', text: 'The supplier submitted the audit certificate.', evidenceIds: ['T0005'] },
      { id: 'p8', text: 'The client requested a revised delivery schedule.', evidenceIds: ['T0005'] }
    ]
  }];
  const cleaned = await dedupeAdjacentRestatements(discussion, {
    encode: (values) => values.map(() => [1, 0])
  });
  assert.deepEqual(cleaned[0].points.map((row) => row.id), ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']);
});

test('the publication boundary applies content, heading and restatement safeguards together', async () => {
  const cleaned = await finaliseDiscussionForPublication([{
    id: 't1', topic: 'Decision on delivery approach', decisions: [], openQuestions: [],
    points: [
      { id: 'admin', text: 'Morgan checks whether the shared screen is readable.', evidenceIds: ['T0001'] },
      { id: 'p1', text: 'The proposed delivery approach remains under review.', evidenceIds: ['T0002'] },
      { id: 'p2', text: 'The delivery approach is still being reviewed.', evidenceIds: ['T0002'] }
    ]
  }], { encode: (values) => values.map(() => [1, 0]) });
  assert.equal(cleaned[0].topic, 'Delivery approach');
  assert.equal(cleaned[0].points.length, 1);
  assert.equal(cleaned[0].points[0].id, 'p1');
});

test('peripheral reporting is removed from primary rows and supporting context', () => {
  const cleaned = removePersonalAsides([{
    id: 'topic-1', topic: 'Project update',
    points: [{
      id: 'p1', text: 'The validation report remains blocked by supplier approval.', evidenceIds: ['T0001'],
      supportingDetails: [
        { id: 's1', text: 'Morgan mentioned bringing produce to the community show.', evidenceIds: ['T0002'] },
        { id: 's2', text: 'Morgan mentioned that the supplier review is outstanding.', evidenceIds: ['T0003'] }
      ]
    }, { id: 'p2', text: 'Sam joked about the weather.', evidenceIds: ['T0004'] }],
    decisions: [], openQuestions: []
  }]);
  assert.deepEqual(cleaned[0].points.map((row) => row.id), ['p1']);
  assert.deepEqual(cleaned[0].points[0].supportingDetails.map((row) => row.id), ['s2']);
});

test('personal asides are removed from primary rows and supporting context', () => {
  const cleaned = removePersonalAsides([{
    id: 'topic-1', topic: 'Audit preparation',
    points: [
      {
        id: 'p1', text: 'The evidence pack is ready for review.', evidenceIds: ['T0001'],
        supportingDetails: [
          { id: 's1', text: 'Morgan says Alex needs a proper break.', evidenceIds: ['T0002'] },
          { id: 's2', text: 'The audit begins on Monday.', evidenceIds: ['T0003'] }
        ]
      },
      { id: 'p2', text: 'Alex seems very tired.', evidenceIds: ['T0004'], reviewFlagIds: ['flag-1'] }
    ],
    decisions: [], openQuestions: []
  }, {
    id: 'topic-2', topic: 'Social chat',
    points: [{ id: 'p3', text: 'Priya deserves a holiday.', evidenceIds: ['T0005'] }],
    decisions: [], openQuestions: []
  }]);
  assert.equal(cleaned.length, 1);
  assert.deepEqual(cleaned[0].points.map((row) => row.id), ['p1']);
  assert.deepEqual(cleaned[0].points[0].supportingDetails.map((row) => row.id), ['s2']);
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

test('topics are consolidated by evidence adjacency and label similarity without forcing unrelated topics into a cap', async () => {
  const topics = [
    { id: 'a', topic: 'Software language support and code changes', points: [{ id: 'p1', text: 'Memory capacity exists for the twelve additional languages.', evidenceIds: ['T0006'] }], decisions: [], openQuestions: [] },
    { id: 'b', topic: 'Detail added on software changes', points: [{ id: 'p2', text: 'The two code changes should be completed by the end of next week.', evidenceIds: ['T0007'] }], decisions: [], openQuestions: [] },
    { id: 'c', topic: 'Tracker Movement', points: [{ id: 'p3', text: 'Tracker movement is positive, from thirteen to ten.', evidenceIds: ['T0001'] }], decisions: [], openQuestions: [] },
    { id: 'd', topic: 'Discussion', points: [{ id: 'p4', text: 'Christina is still away so the procedures wait.', evidenceIds: ['T0008'] }], decisions: [], openQuestions: [] },
    { id: 'e', topic: 'Updates needed on risk management comments', points: [{ id: 'p5', text: "Rebecca addressed David's two comments on the risk plan.", evidenceIds: ['T0002', 'T0004'] }], decisions: [], openQuestions: [] }
  ];
  const merged = await consolidateTopics(topics, index, { encode: cloneVectors, minTopics: 2, maxTopics: 3 });
  const labels = merged.map((topic) => topic.topic);
  // Software topics merge and a generic neighbour folds in, but unrelated
  // subjects are not merged merely to meet a presentation cap.
  assert.ok(merged.length >= 3, labels.join(' | '));
  const software = merged.find((topic) => topic.points.some((r) => r.id === 'p1'));
  assert.ok(software.points.some((r) => r.id === 'p2'), 'adjacent software topics merge');
  assert.ok(!labels.includes('Discussion'), 'generic label does not survive');
  assert.equal(merged[0].points.some((r) => r.id === 'p3') || merged[0].points.some((r) => r.id === 'p5'), true, 'earliest evidence first');
});

test('an explicit hard topic cap remains available to legacy callers', async () => {
  const topics = [1, 3, 5, 7].map((sequence, i) => ({
    topic: `Distinct subject ${i + 1}`,
    points: [{ id: `p${i}`, text: `Independent outcome number ${i + 1}.`, evidenceIds: [`T000${sequence}`] }],
    decisions: [], openQuestions: []
  }));
  const merged = await consolidateTopics(topics, index, { encode: cloneVectors, minTopics: 2, maxTopics: 2, forceTopicCap: true });
  assert.equal(merged.length, 2);
});

test('short verbatim speech and unresolved role labels are not published as primary rows', () => {
  const localUnits = [
    { id: 'T0100', speaker: 'Alex', text: "It's approved, yeah, it was approved for Wednesday." },
    { id: 'T0101', speaker: 'Morgan', text: 'David will contact the speaker about the command letters.' }
  ];
  const cleaned = demoteUnreadyRows([{
    topic: 'Approval',
    points: [
      { id: 'good', text: 'The change request was approved and can be signed off.', evidenceIds: ['T0100'] },
      { id: 'raw', text: "It's approved, yeah, it was approved for Wednesday.", evidenceIds: ['T0100'] },
      { id: 'role', text: 'David will contact the speaker about the command letters.', evidenceIds: ['T0101'] }
    ], decisions: [], openQuestions: []
  }], unitIndex(localUnits));
  assert.deepEqual(cleaned[0].points.map((row) => row.id), ['good']);
});

test('answered question clauses embedded in decisions are removed and cite the answer', () => {
  const localUnits = [
    { id: 'T0200', speaker: 'Deepa', text: 'We are agreed on medals rather than shirts.' },
    { id: 'T0201', speaker: 'Deepa', text: 'Who ordered them last year?' },
    { id: 'T0202', speaker: 'Jo', text: 'Was that you, Deepa?' },
    { id: 'T0203', speaker: 'Deepa', text: 'It was me, yeah.' }
  ];
  const topic = removeAnsweredQuestionClauses({ topic: 'Medals', points: [], decisions: [{
    id: 'd1', text: 'Agreed to provide medals again, not shirts; question on who ordered last year.',
    evidenceIds: ['T0200', 'T0201']
  }], openQuestions: [] }, unitIndex(localUnits));
  assert.equal(topic.decisions[0].text, 'Agreed to provide medals again, not shirts');
  assert.deepEqual(topic.decisions[0].evidenceIds, ['T0200', 'T0201', 'T0203']);
});

test('a conflicting responsibility loses only to a directly supported first-person commitment', () => {
  const localUnits = [
    { id: 'T0300', speaker: 'Tom Whitfield', text: 'That was awkward.' },
    { id: 'T0301', speaker: 'Priya Sethi', text: 'I will close with a proper thank you and next step.' }
  ];
  const topic = removeContradictoryResponsibilities({ topic: 'Closing', points: [
    { id: 'wrong', text: 'Tom Whitfield will take the closing segment and final thank you.', evidenceIds: ['T0300', 'T0301'] },
    { id: 'right', text: 'Priya Sethi will close with a proper thank you and next step.', evidenceIds: ['T0301'] }
  ], decisions: [], openQuestions: [] }, unitIndex(localUnits));
  assert.deepEqual(topic.points.map((row) => row.id), ['right']);
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
