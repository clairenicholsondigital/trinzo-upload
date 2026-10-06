'use strict';

// Generic cases only: none of these sentences come from the evaluation corpus.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normaliseSourceUnits,
  stripUnstatedMonths,
  groundUnstatedDiscussionMonths,
  discussionFidelityCheckItems,
  discussionFidelityCheckPrompt,
  applyDiscussionFidelityResults,
  isUsefulReviewFlag
} = require('../utils/meetingMinutesAgentV2');
const { meetingMinutesAgentPrompt, meetingMinutesAgentRecoveryPrompt } = require('../routes/api').stagedEvaluation;

const filler = (prefix, count) => Array.from({ length: count }, (_, index) => ({
  id: `${prefix}${index}`, speaker: 'Chair', text: 'Okay.', classification: 'keep'
}));
const units = normaliseSourceUnits([
  { id: 'T0001', speaker: 'Priya', text: "I'm away between the 9th and the 12th.", classification: 'keep' },
  ...filler('A', 8),
  { id: 'T0002', speaker: 'Tom', text: 'The draft is due on the 3rd of next month.', classification: 'keep' },
  ...filler('B', 8),
  { id: 'T0003', speaker: 'Sam', text: 'Launch is 9 March and I am not a golf person, so no preference.', classification: 'keep' }
]);

test('a month nobody said is replaced with a placeholder', () => {
  assert.deepEqual(stripUnstatedMonths('Priya away 9th-12th June at the conference.', units, ['T0001']), {
    text: 'Priya away 9th-12th [month to confirm] at the conference.',
    removed: [{ day: '9th-12th', month: 'june' }]
  });
  assert.equal(stripUnstatedMonths('Away June 9-12.', units, ['T0001']).text, 'Away 9-12 [month to confirm].');
  assert.equal(stripUnstatedMonths('Out on the 9th of May.', units, ['T0001']).text, 'Out on the 9th [month to confirm].');
});

test('a month that was said, or implied by "next month", is kept', () => {
  assert.equal(stripUnstatedMonths('Draft due 3rd April.', units, ['T0002']).removed.length, 0);
  assert.equal(stripUnstatedMonths('Launch on 9 March.', units, ['T0003']).removed.length, 0);
  assert.equal(stripUnstatedMonths('The 9th may slip.', units, ['T0001']).removed.length, 0, '"may" as a verb is not May');
});

test('an exact date omitted from the citations is recovered only from matching transcript context', () => {
  const dateUnits = normaliseSourceUnits([
    { id: 'T0200', speaker: 'Chair', text: 'The current devices must be entered in the registry.', classification: 'keep' },
    { id: 'T0201', speaker: 'Chair', text: 'All existing devices need to be registered by the 28th of November.', classification: 'keep' },
    ...filler('C', 8),
    { id: 'T0210', speaker: 'Auditor', text: 'For an audit, a documented registry-entry plan is sufficient while preparation continues.', classification: 'keep' }
  ]);
  const discussion = [{
    topic: 'Device registration',
    points: [{
      id: 'p-date',
      text: 'Existing devices must be registered by 28th November; documented preparation is sufficient for an audit.',
      evidenceIds: ['T0210'],
      supportingDetails: []
    }],
    decisions: [],
    openQuestions: []
  }];
  const result = groundUnstatedDiscussionMonths(discussion, dateUnits);
  assert.equal(result.discussion[0].points[0].text, discussion[0].points[0].text);
  assert.deepEqual(result.discussion[0].points[0].evidenceIds, ['T0210', 'T0201']);
  assert.equal(result.flags.length, 0);

  const unrelated = normaliseSourceUnits([
    { id: 'T0300', speaker: 'Chair', text: 'The catering tasting is booked for 28th November.', classification: 'keep' },
    ...filler('D', 8),
    { id: 'T0310', speaker: 'Auditor', text: 'The devices need to be registered.', classification: 'keep' }
  ]);
  assert.equal(
    stripUnstatedMonths('Existing devices must be registered by 28th November.', unrelated, ['T0310']).text,
    'Existing devices must be registered by 28th [month to confirm].'
  );
});

test('a month safely implied by a cross-month range uses the shared formatter', () => {
  const rangeUnits = normaliseSourceUnits([
    { id: 'T0100', speaker: 'Chair', text: 'Report writing runs from the 27th through to the 7th of August.', classification: 'keep' }
  ]);
  for (const generated of [
    'Report writing runs from June 27th to August 7th.',
    'Report writing runs from 27th [month to confirm] to August 7th.',
    'Report writing runs between the 27th and 7th August.',
    'Report writing runs from 27th through to the 7th of August.'
  ]) {
    assert.deepEqual(stripUnstatedMonths(generated, rangeUnits, ['T0100']), {
      text: 'Report writing runs from 27th July–7th August.',
      removed: []
    });
  }
});

test('discussion rows with an unstated month are rewritten and flagged', () => {
  const discussion = [{
    topic: 'Scheduling',
    points: [
      { id: 'p1', text: 'Priya away 9th-12th June; plan around it.', evidenceIds: ['T0001'], supportingDetails: [] },
      { id: 'p2', text: 'Launch on 9 March.', evidenceIds: ['T0003'], supportingDetails: [] }
    ],
    decisions: [],
    openQuestions: []
  }];
  const result = groundUnstatedDiscussionMonths(discussion, units);
  assert.equal(result.discussion[0].points[0].text, 'Priya away 9th-12th [month to confirm]; plan around it.');
  assert.equal(result.discussion[0].points[1].text, 'Launch on 9 March.');
  assert.equal(result.flags.length, 1);
  assert.equal(result.flags[0].kind, 'timing');
  assert.deepEqual(result.discussion[0].points[0].reviewFlagIds, [result.flags[0].id]);
  assert.ok(isUsefulReviewFlag(result.flags[0]));
});

test('the fidelity critic is asked about added specifics and small talk', () => {
  const prompt = discussionFidelityCheckPrompt([]);
  assert.match(prompt, /added specifics/);
  assert.match(prompt, /A day spoken without its month does not tell you the month/);
  assert.match(prompt, /issue "small_talk"/);
  assert.match(prompt, /"issue":""/);
});

test('an added detail or small talk surfaces as a visible flag with no evidence quote', () => {
  const discussion = [{
    topic: 'Logistics',
    points: [{ id: 'p1', text: 'Launch planned for 9 March; Sam indifferent to golf.', evidenceIds: ['T0003'], supportingDetails: [] }],
    decisions: [],
    openQuestions: []
  }];
  const items = discussionFidelityCheckItems(discussion, units);
  assert.equal(items.length, 1);
  for (const [issue, pattern] of [['small_talk', /small talk/], ['added_detail', /Cannot verify "Sam indifferent to golf"/]]) {
    const result = applyDiscussionFidelityResults(discussion, items, [{
      id: items[0].id, verdict: 'uncertain', issue, problemQuote: 'Sam indifferent to golf', evidenceQuote: '', reason: 'A personal taste.'
    }]);
    assert.equal(result.rejected.length, 0);
    assert.equal(result.flags.length, 1);
    assert.match(result.flags[0].message, pattern);
    assert.ok(isUsefulReviewFlag(result.flags[0]), `${issue} flag must reach the reviewer`);
  }
  const invented = applyDiscussionFidelityResults(discussion, items, [{
    id: items[0].id, verdict: 'uncertain', issue: 'added_detail', problemQuote: 'Sam loves cricket', evidenceQuote: '', reason: ''
  }]);
  assert.equal(invented.flags.length, 0, 'the problem quote must still come from the row');
  const correction = applyDiscussionFidelityResults(discussion, items, [{
    id: items[0].id, verdict: 'corrected', problemQuote: 'Sam indifferent to golf', evidenceQuote: '', correctedText: 'Launch planned for 9 March.'
  }]);
  assert.equal(correction.rejected.length, 1, 'a correction still needs transcript words');
});

test('discussion discovery forbids unspoken months and small talk', () => {
  const prompt = meetingMinutesAgentPrompt({ stage: 'discussion', transcript: '[T0001] Priya: Hello.', details: {} });
  assert.match(prompt, /Never add a month, year or weekday to a date that the speakers did not say/);
  assert.match(prompt, /\[month to confirm\]/);
  assert.match(prompt, /Leave out small talk, jokes, personal tastes/);
  const actions = meetingMinutesAgentPrompt({ stage: 'actions', transcript: '[T0001] Priya: Hello.', details: {} });
  assert.doesNotMatch(actions, /Leave out small talk/);
  {
    const recovery = meetingMinutesAgentRecoveryPrompt({ stage: 'discussion', transcript: '[T0001] Priya: Hello.', details: {}, current: {}, candidates: [] });
    assert.match(recovery, /\[month to confirm\]/);
    assert.match(recovery, /Leave out small talk/);
  }
});
