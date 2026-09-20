'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');

test('confirmed person aliases are normalised through every nested minutes field', () => {
  const result = V.normaliseKnownTermsDeep({
    sourceUnits: [{ speaker: 'Rebecca Cuckoo', text: 'Rebecca Cuckoo will review it.' }],
    details: { allAttendees: ['Rebecca Cuckoo'] },
    discussion: [{ points: [{ text: 'Rebecca Cuckoo owns the review.' }] }],
    actions: [{ owners: ['Rebecca Cuckoo'], action: 'Send the file to Rebecca Cuckoo.' }],
    reviewFlags: [{ message: 'Check Rebecca Cuckoo.' }]
  });
  assert.doesNotMatch(JSON.stringify(result), /Rebecca\s+Cuckoo/i);
  assert.equal(result.sourceUnits[0].speaker, 'Rebecca Gill');
  assert.equal(result.details.allAttendees[0], 'Rebecca Gill');
  assert.equal(result.actions[0].owners[0], 'Rebecca Gill');
});

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

test('final action evidence recovers an explicit cited owner commitment and its timing', () => {
  const units = [
    { id: 'T0058', speaker: 'Dan Threlfall', text: 'Josie, can you confirm the order in writing?' },
    { id: 'T0059', speaker: 'Josie Kaur', text: "Yeah, I'll email them today to confirm the fifteen casks with our terms." }
  ];
  const [action] = V.backfillActionCommitmentEvidence([{
    action: 'Email the festival to confirm the fifteen-cask order.', owners: ['Josie Kaur'],
    timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0058']
  }], units, { meetingDate: '2026-08-10' });
  assert.deepEqual(action.evidenceIds, ['T0058', 'T0059']);
  assert.deepEqual(action.timing, { kind: 'deadline', wording: 'today', exactDate: '2026-08-10' });
});

test('final action evidence can recover a later anaphoric review commitment without inventing timing', () => {
  const units = Array.from({ length: 30 }, (_, offset) => {
    const number = offset + 1;
    return {
      id: `T${String(number).padStart(4, '0')}`,
      speaker: number === 30 ? 'Rebecca Gill' : 'David Didsbury',
      text: number === 14
        ? 'That is not the same as justifying the frequency values.'
        : number === 30 ? "Right, I'll have a look at that." : 'The risk probability rationale remains under discussion.'
    };
  });
  const [action] = V.backfillActionCommitmentEvidence([{
    action: 'Review and document justification for the risk probability values.', owners: ['Rebecca Gill'],
    timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0014']
  }], units);
  assert.deepEqual(action.evidenceIds, ['T0014', 'T0030']);
  assert.equal(action.timing.kind, 'not_stated');
  const ownerChecked = V.applyRequesterOwnerRule([action], units);
  assert.deepEqual(ownerChecked.actions[0].owners, ['Rebecca Gill']);
  assert.deepEqual(ownerChecked.flags, []);
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

test('a completed walkthrough is held back when its exact evidence quote exceeds 25 words', () => {
  const completion = 'Customers place an order through our business platform, the order enters a pending approval queue, and the warehouse team then picks, packs, labels and ships the goods to the customer.';
  const units = [
    { id: 'T0001', speaker: 'Jacqui', text: 'Could you take us through an order from product and information-flow perspectives?' },
    { id: 'T0002', speaker: 'Orla', text: completion }
  ];
  const actions = [{ action: 'Take the team through an order process overview.', owners: ['Orla'], evidenceIds: ['T0001'] }];
  const items = V.completedInMeetingCheckItems(actions, units);
  const result = V.applyCompletedInMeetingCheckResults(actions, items, [{
    id: items[0].id, verdict: 'completed', completionQuote: completion
  }]);
  assert.ok(completion.split(' ').length > 25);
  assert.equal(result.actions.length, 0);
  assert.equal(result.completed.length, 1);
  assert.deepEqual(result.rejected, []);
});

test('the final lifecycle gate withholds only quote-verified non-outstanding work', () => {
  const units = [
    { id: 'T0001', speaker: 'Alex', text: 'Could you explain the order process now?' },
    { id: 'T0002', speaker: 'Sam', text: 'I already walked through the complete order process during this meeting.' },
    { id: 'T0003', speaker: 'Alex', text: 'Please send the revised manual tomorrow.' },
    { id: 'T0004', speaker: 'Sam', text: 'Yes, I will send the revised manual tomorrow.' }
  ];
  const actions = [
    { action: 'Explain the order process.', owners: ['Sam'], evidenceIds: ['T0001', 'T0002'] },
    { action: 'Send the revised manual.', owners: ['Sam'], evidenceIds: ['T0003', 'T0004'] }
  ];
  const items = V.finalActionLifecycleCheckItems(actions, units);
  const result = V.applyFinalActionLifecycleResults(actions, items, [
    { id: items[0].id, verdict: 'not_outstanding', evidenceQuote: 'I already walked through the complete order process during this meeting.' },
    { id: items[1].id, verdict: 'outstanding', evidenceQuote: '' }
  ]);
  assert.deepEqual(result.actions.map((action) => action.action), ['Send the revised manual.']);
  assert.equal(result.withheld.length, 1);
  assert.deepEqual(result.rejected, []);
});

test('the final lifecycle gate keeps an action when non-outstanding evidence is invented', () => {
  const units = [{ id: 'T0001', speaker: 'Sam', text: 'Yes, I will send the revised manual tomorrow.' }];
  const actions = [{ action: 'Send the revised manual.', owners: ['Sam'], evidenceIds: ['T0001'] }];
  const items = V.finalActionLifecycleCheckItems(actions, units);
  const result = V.applyFinalActionLifecycleResults(actions, items, [{
    id: items[0].id, verdict: 'not_outstanding', evidenceQuote: 'The revised manual was already sent yesterday.'
  }]);
  assert.equal(result.actions.length, 1);
  assert.equal(result.withheld.length, 0);
  assert.equal(result.rejected[0].reason, 'quote_not_found');
});

test('ordinary deliverables are never sent through the live-delivery gate', () => {
  const actions = [
    { action: 'Send the revised QMS manual to Orla.', owners: ['Jacqui'], evidenceIds: ['T0001'] },
    { action: 'Share the completed risk analysis with Niamh.', owners: ['Jacqui'], evidenceIds: ['T0001'] }
  ];
  assert.deepEqual(V.completedInMeetingCheckItems(actions, questionUnits), []);
});

test('action completeness can add a quote-verified outcome from the same owner', () => {
  const units = [
    { id: 'T0001', speaker: 'Dan', text: 'Mick, can we get the chiller serviced before the fifteenth?' },
    { id: 'T0002', speaker: 'Mick', text: "I'll ring the refrigeration engineer today." },
    { id: 'T0003', speaker: 'Mick', text: "I'll get the chiller serviced before we pitch the IPA on the fifteenth." }
  ];
  const actions = [{
    action: 'Contact the refrigeration engineer about the chiller service.', owners: ['Mick'],
    timing: { kind: 'deadline', wording: 'today', exactDate: '' }, evidenceIds: ['T0001', 'T0002', 'T0003']
  }];
  const items = V.actionCompletenessCheckItems(actions, units);
  assert.equal(items.length, 1);
  const result = V.applyActionCompletenessResults(actions, items, [{
    id: items[0].id, verdict: 'corrected',
    problemQuote: 'Contact the refrigeration engineer about the chiller service.',
    evidenceQuote: "I'll get the chiller serviced before we pitch the IPA on the fifteenth.",
    correctedAction: 'Contact the refrigeration engineer and arrange for the chiller to be serviced before the IPA is pitched.'
  }]);
  assert.equal(result.corrected, 1);
  assert.match(result.actions[0].action, /arrange for the chiller to be serviced/i);
  assert.deepEqual(result.actions[0].timing, actions[0].timing);
});

test('action completeness rejects a correction unsupported by its passage', () => {
  const actions = [{ action: 'Contact the engineer.', owners: ['Mick'], evidenceIds: ['T0001'] }];
  const items = [{ id: 'ac1', index: 0, action: actions[0].action, owners: ['Mick'], passage: '[T0001] Mick: I will contact the engineer.' }];
  const result = V.applyActionCompletenessResults(actions, items, [{
    id: 'ac1', verdict: 'corrected', problemQuote: 'Contact the engineer.',
    evidenceQuote: 'I will replace the compressor.', correctedAction: 'Contact the engineer and replace the compressor.'
  }]);
  assert.equal(result.corrected, 0);
  assert.equal(result.actions[0].action, 'Contact the engineer.');
});

test('discussion fidelity explicitly checks enumerated mappings and time direction', () => {
  const prompt = V.discussionFidelityCheckPrompt([]);
  assert.match(prompt, /preserve every source pairing/i);
  assert.match(prompt, /current-period condition caused a previous-period result/i);
  assert.match(prompt, /the speaker/i);
});
