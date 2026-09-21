'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');
const { prepareEvidence } = require('../utils/canonicalMinutes/evidence');
const deterministicStages = require('../utils/canonicalMinutes/stages');

test('hedged and deferred outcomes are demoted even when a checker calls them decisions', () => {
  const discussion = [{
    topic: 'Outstanding choices',
    points: [],
    decisions: [
      { id: 'd1', text: 'Decision to possibly use password access', evidenceIds: ['T0001'] },
      { id: 'd2', text: 'Decision to park the issue and reconvene next month', evidenceIds: ['T0002'] },
      { id: 'd3', text: 'Reject option A', evidenceIds: ['T0003'] }
    ],
    openQuestions: []
  }];
  const items = [
    { id: 'c1', topicIndex: 0, rowIndex: 0, row: discussion[0].decisions[0].text, passage: 'Alex: We might possibly use password access, but I am against it.' },
    { id: 'c2', topicIndex: 0, rowIndex: 1, row: discussion[0].decisions[1].text, passage: 'Morgan: There is no clear answer. Let us park it and come back next month.' },
    { id: 'c3', topicIndex: 0, rowIndex: 2, row: discussion[0].decisions[2].text, passage: 'Chair: The committee rejected option A.' }
  ];
  const results = [
    { id: 'c1', verdict: 'decision', decisionQuote: 'We might possibly use password access' },
    { id: 'c2', verdict: 'decision', decisionQuote: 'Let us park it and come back next month' },
    { id: 'c3', verdict: 'decision', decisionQuote: 'The committee rejected option A' }
  ];
  const checked = V.applyDecisionCheckResults(discussion, items, results);
  assert.equal(checked.demoted, 2);
  assert.deepEqual(checked.discussion[0].decisions.map((row) => row.id), ['d3']);
  assert.deepEqual(checked.discussion[0].points.map((row) => row.text), [
    'Possibly use password access',
    'Park the issue and reconvene next month'
  ]);
});

test('refusals and honest unknowns are prioritised as discussion, not confident actions', () => {
  const units = V.normaliseSourceUnits([
    { id: 'T0100', speaker: 'Alex', text: "I'm not going to alter the findings to suit a requested outcome.", classification: 'keep' },
    { id: 'T0101', speaker: 'Priya', text: "I don't know at the moment, and that is the honest answer. I'll know after Wednesday's meeting.", classification: 'keep' },
    { id: 'T0102', speaker: 'Morgan', text: "I don't know yet, but I'll check with the supplier tomorrow.", classification: 'keep' }
  ]);
  const discussion = V.discussionCandidateInventory(units);
  assert.ok(discussion.find((row) => row.focusEvidenceId === 'T0100').kindHints.includes('negative_position'));
  assert.ok(discussion.find((row) => row.focusEvidenceId === 'T0101').kindHints.includes('unresolved_position'));
  assert.ok(discussion.find((row) => row.focusEvidenceId === 'T0100').priority >= 4);
  const actions = V.actionCandidateInventory(units);
  assert.ok(!actions.some((row) => row.focusEvidenceId === 'T0101'));
  assert.ok(actions.some((row) => row.focusEvidenceId === 'T0102'));
});

test('deterministic decision extraction does not turn a hedged position into agreement', () => {
  const evidence = prepareEvidence([
    'Alex Stone: We maybe agreed that password access could be used, but nobody settled it.',
    'Priya Shah: The committee rejected the first option.',
    'Alex Stone: We decided to use the second option.'
  ].join('\n'));
  const result = deterministicStages.contentStage(evidence, { objectives: [] });
  assert.ok(!result.decisions.some((row) => /password access/i.test(row.text)));
  assert.ok(result.decisions.some((row) => /second option/i.test(row.text)));
});

test('decision prompts explicitly distinguish deferral, refusal and uncertainty from agreement', () => {
  const prompt = V.decisionCheckPrompt([{ id: 'd1', row: 'Park it', passage: 'Speaker: Park it.' }]);
  assert.match(prompt, /parked or deferred/i);
  assert.match(prompt, /refusal may be material/i);
  assert.match(prompt, /hedged possibility/i);
});
