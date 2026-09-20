'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  decisionCheckItems, decisionCheckPrompt, decisionQuoteFound, applyDecisionCheckResults
} = require('../utils/meetingMinutesAgentV2');

const units = [
  { id: 'T0001', speaker: 'Jacqui Fox', text: 'PPE was left out of the scope at the start.' },
  { id: 'T0002', speaker: 'Jacqui Fox', text: "I've made the decision we are absolutely covering it." },
  { id: 'T0003', speaker: 'Orla Skally', text: 'The colour changes are made and working.' },
  { id: 'T0004', speaker: 'Jacqui Fox', text: 'So if I put in a 1230 for every day.' },
  { id: 'T0005', speaker: 'Jacqui Fox', text: 'Well, not every day, but every third Wednesday, Thursday, and Friday, sorry.' }
];
const discussion = () => ([
  { title: 'Scope', points: [{ text: 'Scope was optical only.', evidenceIds: ['T0001'] }], decisions: [
    { text: 'PPE will be covered in the procedures.', evidenceIds: ['T0002'] },
    { text: 'Colour changes are complete.', evidenceIds: ['T0003'] }
  ] },
  { title: 'Sessions', points: [], decisions: [{ text: 'Working sessions every third Wednesday to Friday.', evidenceIds: ['T0004', 'T0005'] }] }
]);

test('decision items carry each decision row with its passage', () => {
  const items = decisionCheckItems(discussion(), units);
  assert.equal(items.length, 3);
  assert.match(items[0].passage, /Jacqui Fox: I've made the decision/);
  assert.match(decisionCheckPrompt(items), /^ACTION_CRITIC_DECISION/);
});

test('a quote may cross adjacent lines but must be the spoken words', () => {
  const passage = decisionCheckItems(discussion(), units)[2].passage;
  assert.ok(decisionQuoteFound('for every day. Well, not every day, but every third Wednesday', passage));
  assert.ok(decisionQuoteFound('Jacqui Fox: every third Wednesday, Thursday and Friday', passage));
  assert.ok(!decisionQuoteFound('we agreed on Wednesday sessions', passage));
  assert.ok(!decisionQuoteFound('every day', passage));
});

test('only verified decisions keep the label; the rest become points unchanged', () => {
  const items = decisionCheckItems(discussion(), units);
  const results = [
    { id: 'd1', verdict: 'decision', decisionQuote: "I've made the decision we are absolutely covering it" },
    { id: 'd2', verdict: 'not_decision' },
    { id: 'd3', verdict: 'decision', decisionQuote: 'we decided on sessions' }
  ];
  const out = applyDecisionCheckResults(discussion(), items, results);
  assert.equal(out.demoted, 2);
  assert.deepEqual(out.discussion[0].decisions.map((row) => row.text), ['PPE will be covered in the procedures.']);
  assert.deepEqual(out.discussion[0].points.map((row) => row.text), ['Scope was optical only.', 'Colour changes are complete.']);
  assert.equal(out.discussion[1].decisions.length, 0);
  assert.equal(out.discussion[1].points[0].text, 'Working sessions every third Wednesday to Friday.');
});

test('a failed or unrecognised verdict leaves the label alone', () => {
  const items = decisionCheckItems(discussion(), units);
  const out = applyDecisionCheckResults(discussion(), items, [{ id: 'd2', verdict: 'maybe' }]);
  assert.equal(out.demoted, 0);
  assert.deepEqual(out.discussion, discussion());
});

test('"I\'ve made the decision" in the transcript counts as a recorded agreement', () => {
  const previous = process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1;
  process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1 = '1';
  try {
    const { isExplicitDecision } = require('../utils/canonicalMinutes/discussionOrganiser');
    const index = { byId: new Map([['T1', { id: 'T1', text: "I've made the decision we are absolutely covering it." }]]) };
    assert.ok(isExplicitDecision({ text: 'Decision made to absolutely cover PPE in procedures.', evidenceIds: ['T1'] }, index));
  } finally {
    if (previous === undefined) delete process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1; else process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1 = previous;
  }
});

test('a row stating a decision is not mistaken for a status update', () => {
  const previous = process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1;
  process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1 = '1';
  try {
    const { isExplicitDecision } = require('../utils/canonicalMinutes/discussionOrganiser');
    const index = { byId: new Map([['T1', { id: 'T1', text: "I've made the decision we are absolutely covering it." }]]) };
    assert.ok(isExplicitDecision({ text: 'Decision made to include PPE in procedures; follow-up with Orla planned to confirm approach.', evidenceIds: ['T1'] }, index));
  } finally {
    if (previous === undefined) delete process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1; else process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1 = previous;
  }
});
