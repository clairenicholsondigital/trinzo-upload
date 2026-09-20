'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');

test('timing wording must contain an actual date, target or dependency', () => {
  assert.equal(V.timingWordingHasMeaning({ kind: 'deadline', wording: 'there are some further updates that need to happen to that' }), false);
  assert.equal(V.timingWordingHasMeaning({ kind: 'target', wording: 'trying to get as much as possible done this week' }), true);
  assert.equal(V.timingWordingHasMeaning({ kind: 'target', wording: 'from the fifteenth' }), true);
  assert.equal(V.timingWordingHasMeaning({ kind: 'dependency', wording: 'following completion of electrical compliance testing' }), true);
  assert.equal(V.timingWordingHasMeaning({ kind: 'dependency', wording: 'where gaps are identified during the review' }), true);
  assert.equal(V.timingWordingHasMeaning({ kind: 'dependency', wording: 'if documents need to be uploaded' }), true);
  assert.equal(V.timingWordingHasMeaning({ kind: 'dependency', wording: 'before information is shared' }), true);
  assert.equal(V.timingWordingHasMeaning({ kind: 'dependency', wording: 'based on logistics and risk analysis' }), true);
  assert.equal(V.timingWordingHasMeaning({ kind: 'not_stated', wording: '' }), true);
});

test('meaningless timing is removed and clearly flagged on generated actions', () => {
  const prior = process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1;
  process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1 = '1';
  try {
    const result = V.normaliseAgentResult({ actions: [{
      action: 'Update the risk management plan.', owners: [],
      timing: { kind: 'deadline', wording: 'there are some further updates that need to happen to that', exactDate: '' },
      evidenceIds: ['T0001']
    }] }, [{ id: 'T0001', speaker: 'Alex', text: 'There are some further updates that need to happen to that risk management plan.' }], 'actions');
    assert.deepEqual(result.actions[0].timing, { kind: 'not_stated', wording: '', exactDate: '' });
    assert.match(result.reviewFlags[0].message, /does not state a date, target or dependency/i);
  } finally {
    if (prior === undefined) delete process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1;
    else process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1 = prior;
  }
});

const questionUnits = [
  { id: 'T0001', speaker: 'Keon', text: 'How are we capturing client delivery feedback today?' },
  { id: 'T0002', speaker: 'Kathryn', text: 'We have monthly client check-ins and any leads are sent to Liam by email.' },
  { id: 'T0003', speaker: 'Kathryn', text: 'They are not always tracked in Salesforce.' }
];

test('open-question checks include the answer after narrowly cited question evidence', () => {
  const discussion = [{ topic: 'Lead capture', points: [], decisions: [], openQuestions: [{
    id: 'q1', text: 'How client delivery feedback is currently captured remains open.', evidenceIds: ['T0001']
  }] }];
  const items = V.openQuestionCheckItems(discussion, questionUnits);
  assert.equal(items.length, 1);
  assert.match(items[0].passage, /monthly client check-ins/i);
});

test('a verified answer replaces the open question with a grounded point', () => {
  const discussion = [{ topic: 'Lead capture', points: [], decisions: [], openQuestions: [{
    id: 'q1', text: 'How client delivery feedback is currently captured remains open.', evidenceIds: ['T0001']
  }] }];
  const items = V.openQuestionCheckItems(discussion, questionUnits);
  const result = V.applyOpenQuestionCheckResults(discussion, items, [{
    id: items[0].id,
    verdict: 'answered',
    answerQuote: 'monthly client check-ins and any leads are sent to Liam by email',
    resolvedText: 'Monthly client check-ins produce leads that are sent to Liam by email.'
  }]);
  assert.equal(result.resolved, 1);
  assert.equal(result.discussion[0].openQuestions.length, 0);
  assert.equal(result.discussion[0].points[0].text, 'Monthly client check-ins produce leads that are sent to Liam by email.');
  assert.deepEqual(result.discussion[0].points[0].evidenceIds, ['T0001', 'T0002']);
});

test('an invented answer or unverifiable quote leaves the question open', () => {
  const discussion = [{ topic: 'Lead capture', points: [], decisions: [], openQuestions: [{
    id: 'q1', text: 'How client delivery feedback is currently captured remains open.', evidenceIds: ['T0001']
  }] }];
  const items = V.openQuestionCheckItems(discussion, questionUnits);
  const result = V.applyOpenQuestionCheckResults(discussion, items, [{
    id: items[0].id, verdict: 'answered', answerQuote: 'Salesforce captures every lead automatically',
    resolvedText: 'Salesforce captures every lead automatically.'
  }]);
  assert.equal(result.resolved, 0);
  assert.equal(result.discussion[0].openQuestions.length, 1);
});

test('a walkthrough delivered during the meeting is held back as completed', () => {
  const units = [
    { id: 'T0001', speaker: 'Jacqui', text: 'Could you take us through an order from product and information-flow perspectives?' },
    { id: 'T0002', speaker: 'Orla', text: 'Customers order through our B2B platform and the order enters a pending approval queue.' },
    { id: 'T0003', speaker: 'Orla', text: 'The warehouse team then picks, packs and ships the goods.' }
  ];
  const actions = [{ action: 'Take the team through an order process overview.', owners: ['Orla'], evidenceIds: ['T0001', 'T0002'] }];
  const items = V.completedInMeetingCheckItems(actions, units);
  assert.equal(items.length, 1);
  const result = V.applyCompletedInMeetingCheckResults(actions, items, [{
    id: items[0].id, verdict: 'completed',
    completionQuote: 'Customers order through our B2B platform and the order enters a pending approval queue.'
  }]);
  assert.equal(result.actions.length, 0);
  assert.equal(result.completed.length, 1);
});

test('ordinary deliverables are never sent through the live-delivery gate', () => {
  const actions = [
    { action: 'Send the revised QMS manual to Orla.', owners: ['Jacqui'], evidenceIds: ['T0001'] },
    { action: 'Share the completed risk analysis with Niamh.', owners: ['Jacqui'], evidenceIds: ['T0001'] }
  ];
  assert.deepEqual(V.completedInMeetingCheckItems(actions, questionUnits), []);
});
