'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');
const { isClientReadyActionWording } = require('../routes/api').stagedEvaluation;

const units = [
  { id: 'T0001', speaker: 'Jacqui Fox', text: 'When you press the mute button, maybe now takes the same approach as the alarms.' },
  { id: 'T0002', speaker: 'Jacqui Fox', text: "So Janine, and I think Adil, you're involved in that as well next week, just to look at that from a clinician side." },
  { id: 'T0003', speaker: 'Jacqui Fox', text: "Okay, I'll update that table for the new set of minutes." }
];

test('keyword vetoes are collected for a second look, minutes housekeeping is not', () => {
  const vetoed = [];
  const out = V.normaliseAgentResult({ actions: [
    { action: 'Review the mute-button change with clinicians.', owners: ['Janine', 'Adil Kauim'], timing: { wording: 'next week' }, evidenceIds: ['T0001', 'T0002'] },
    { action: 'Update the table for the new set of minutes.', owners: ['Jacqui Fox'], evidenceIds: ['T0003'] }
  ] }, units, 'actions', { vetoed });
  assert.equal(out.actions.length, 0);
  assert.deepEqual(vetoed.map((row) => row.action), ['Review the mute-button change with clinicians.']);
});

test('only a verified commitment quote brings an action back; unsupported owners are cleared', () => {
  const actions = [
    { action: 'Review the mute-button change with clinicians.', owners: ['Janine', 'Adil Kauim'], evidenceIds: ['T0002'] },
    { action: 'Review the alarm sounds.', owners: ['Andrew'], evidenceIds: ['T0001'] }
  ];
  const items = V.commitmentCheckItems(actions, units);
  assert.match(V.commitmentCheckPrompt(items), /^ACTION_CRITIC_COMMITMENT/);
  const rescued = V.applyCommitmentCheckResults(actions, items, [
    { id: 'c1', verdict: 'commitment', commitmentQuote: "Janine, and I think Adil, you're involved in that as well next week", ownerSupported: true },
    { id: 'c2', verdict: 'commitment', commitmentQuote: 'Andrew will review the alarm sounds', ownerSupported: false }
  ]);
  assert.equal(rescued.length, 1);
  assert.deepEqual(rescued[0].owners, ['Janine', 'Adil Kauim']);
  const unsupportedOwner = V.applyCommitmentCheckResults(actions, items, [
    { id: 'c1', verdict: 'commitment', commitmentQuote: "you're involved in that as well next week", ownerSupported: false }
  ]);
  assert.deepEqual(unsupportedOwner[0].owners, []);
});

test('ordinary instruction verbs pass the wording filter; speech does not', () => {
  for (const wording of ['Trace the software changes.', 'Discuss the gaps with Louise.', 'Focus on TF03 this week.', 'Chase the lab results.']) {
    assert.equal(isClientReadyActionWording(wording), true, wording);
  }
  for (const wording of ["It's to trace through the actual software code.", "I'll try and reduce the standards down.", 'The team will review.']) {
    assert.equal(isClientReadyActionWording(wording), false, wording);
  }
});

test('an answered question leaves the published list only with both quotes verified', () => {
  const units = [
    { id: 'T0001', speaker: 'Jacqui Fox', text: 'I want to get the formative dates bottomed out.' },
    { id: 'T0002', speaker: 'Rebecca Gill', text: 'The formative would be ready shortly after, but still prior to the tech file being lifted.' },
    { id: 'T0003', speaker: 'Jacqui Fox', text: "Okay, so that's fine." },
    { id: 'T0004', speaker: 'Jacqui Fox', text: 'Can you confirm the LED behaviour with Andrew?' }
  ];
  const actions = [
    { action: 'Clarify the formative study dates.', owners: ['Rebecca Gill'], evidenceIds: ['T0001'] },
    { action: 'Confirm the LED behaviour with Andrew.', owners: ['Rebecca Gill'], evidenceIds: ['T0004'] },
    { action: 'Send the report.', owners: ['Rebecca Gill'], evidenceIds: ['T0004'] }
  ];
  const items = V.answeredCheckItems(actions, units);
  assert.deepEqual(items.map((item) => item.index), [0, 1]);
  const out = V.applyAnsweredCheckResults(actions, items, [
    { id: items[0].id, verdict: 'answered', answerQuote: 'ready shortly after, but still prior to the tech file being lifted', acceptanceQuote: "Okay, so that's fine" },
    { id: items[1].id, verdict: 'answered', answerQuote: 'the LED stays solid', acceptanceQuote: 'great' }
  ]);
  assert.deepEqual(out.actions.map((a) => a.action), ['Confirm the LED behaviour with Andrew.', 'Send the report.']);
  assert.equal(out.answered.length, 1);
  assert.equal(out.answered[0].action.action, 'Clarify the formative study dates.');
});

test('a rescued proposal needs its quote tied to the owner', () => {
  const passage = [
    "Jacqui Fox: And then from the software perspective, there's Andrew who has been doing work on the changes.",
    "Jacqui Fox: So he's just looking into that with a view as well to connecting with the clinical.",
    'Jacqui Fox: It is kind of focused really now on that cybersecurity update.',
    "Ciaran Ryan: But I'm gonna focus on TFO3 this week.",
    'David Didsbury: Okay.'
  ].join('\n');
  assert.ok(V.commitmentQuoteTiesOwner("he's just looking into that with a view as well", ['Andrew'], passage));
  assert.ok(V.commitmentQuoteTiesOwner("I'm gonna focus on TFO3 this week", ['Ciaran Ryan'], passage));
  assert.ok(!V.commitmentQuoteTiesOwner('focused really now on that cybersecurity update', ['Jacqui Fox'], passage));
  assert.ok(!V.commitmentQuoteTiesOwner("I'm gonna focus on TFO3 this week", ['Jacqui Fox'], passage));
});

test('a rescued commitment quote must be about the action it rescues', () => {
  const passage = [
    "Jacqui Fox: Okay, so if I step down through the core areas, I'll update that table for the new set of minutes.",
    'Jacqui Fox: Some cybersecurity work because of the USB ports on the back of the CPAP machine.',
    "Jacqui Fox: So Janine, and I think Adil, you're involved in that next week, to look from a clinician side at those changes to the mute button."
  ].join('\n');
  assert.ok(!V.commitmentQuoteAboutAction("I'll update that table for the new set of minutes", 'Update the risk management documentation for USB port cybersecurity on the CPAP machine.', passage));
  assert.ok(V.commitmentQuoteAboutAction("Janine, and I think Adil, you're involved in that next week", 'Review the proposed mute button change with clinicians.', passage));
});

test('an owner-less copy of an owned commitment merges into it', () => {
  const out = V.mergeDuplicateCommitments([
    { action: 'Conduct a follow-up call to review the CAR responses, then load the documents for Grace.', owners: [], timing: { kind: 'not_stated' }, evidenceIds: ['T1', 'T2', 'T3'] },
    { action: 'Conduct the review call, ensure the CAR responses are complete, and load the documents for Grace.', owners: ['Rebecca Gill'], timing: { kind: 'not_stated' }, evidenceIds: ['T1', 'T2', 'T3'] }
  ]);
  assert.equal(out.merged, 1);
  assert.deepEqual(out.actions[0].owners, ['Rebecca Gill']);
});

test('sharing a screen during the meeting is meeting admin, not an action', () => {
  assert.ok(V.isMeetingAdminAction('Share your screen and play the alarm software load with sound for review.'));
  assert.ok(!V.isMeetingAdminAction('Share the risk analysis with Niamh before her arrival.'));
  assert.match(V.commitmentCheckPrompt([]), /during this meeting itself/);
});

test('Discussion rows stating future work by a named person become action candidates', () => {
  const units = [
    { id: 'T0001', speaker: 'Jacqui Fox', text: 'And then Andrew has been doing work on the changes with Rebecca.' },
    { id: 'T0002', speaker: 'Jacqui Fox', text: 'Andrew will start the electrical compliance testing next month.' },
    { id: 'T0003', speaker: 'Adil Kauim', text: 'Now it is just thinking about how to execute the study.' }
  ];
  assert.ok(V.mentionedPeople(units).includes('Andrew'));
  const candidates = V.discussionActionCandidates([{ topic: 'T', points: [
    { id: 'r1', text: 'Andrew will complete the electrical compliance testing in-house.', evidenceIds: ['T0002'] },
    { id: 'r2', text: 'Tracker movement is positive, with the percentage moving from 13 to 10.', evidenceIds: ['T0001'] },
    { id: 'r3', text: 'Adil completed the task analysis; now planning study execution.', evidenceIds: ['T0003'] }
  ] }], units, ['Adil Kauim']);
  assert.deepEqual(candidates.map((candidate) => candidate.ownerHints[0]), ['Andrew', 'Adil Kauim']);
  assert.ok(candidates.every((candidate) => candidate.evidenceIds.length && candidate.sourcePass === 'discussion_row'));
});
