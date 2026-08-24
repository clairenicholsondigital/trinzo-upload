'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateInitialUnderstandingRevision } = require('../utils/stagedInitialUnderstandingPolish');
const { mergeNamedTopics } = require('../routes/api').stagedEvaluation;

// Topic headings, named by the model instead of chosen from a list of twenty-three.
//
// Headings decide more than one line: the purpose, the objectives, the executive summary
// and the discussion cards are all built from them, so a wrong heading is the same wrong
// line on four screens. A residents' association arguing about visitor parking was headed
// "Budget and commercial matters" because somebody said "cost" once, and an audit kick-off
// that spent a morning on hotels, SBOMs and surveillance findings had no heading for any
// of them, because the list did not contain one.
//
// Naming a subject from raw speech was measured the other way first, by distinctiveness
// over the meeting's own vocabulary - no word lists, nounhood inferred from the
// determiners the meeting itself uses. It tops out near sixty per cent precision: it gets
// "Enforcement problem" and "Overpressure valves" and it also gets "Challenging",
// "Higher", "Couple" and "Works". Sixty per cent is worse than nothing for a heading, so
// the model names them and the citation machinery decides whether to believe it.

const original = {
  meetingTitle: 'Eakin software and technical file weekly check-in',
  meetingPurpose: 'Coordinate progress for the software-change programme.',
  objectives: ['Review alarm-code and clinical confirmation.'],
  overallTopics: ['Alarm behaviour and controls'],
  executiveSummary: 'Coordinate progress. It covered alarm behaviour.'
};

const pack = [{
  itemIndex: 0,
  topic: 'meeting_summary_evidence',
  evidence: [
    { id: 'evt_1', speaker: 'Colm', previous: '', current: 'The alarm sound and colour changes are largely working now.', next: '' },
    { id: 'evt_2', speaker: 'Orla', previous: '', current: 'Mute button behaviour still needs the clinical review before sign-off.', next: '' },
    { id: 'evt_3', speaker: 'Colm', previous: '', current: 'IEC 60601 electrical testing should complete by the 23rd of July.', next: '' }
  ]
}];

const cited = (text, ids) => ({ text, evidenceIds: ids });
const revise = (topics) => validateInitialUnderstandingRevision(original, {
  meetingPurpose: cited('Coordinate the software-change programme.', ['evt_1']),
  objectives: [cited('Review the alarm sounds and colour changes.', ['evt_1'])],
  executiveSummary: cited('Alarm sounds and colour changes were largely working. Muting behaviour needed clinical review.', ['evt_1', 'evt_2']),
  overallTopics: topics
}, pack);

test('a named heading that cites its evidence is accepted', () => {
  const result = revise([cited('Alarm sound and clinical sign-off', ['evt_2'])]);
  assert.equal(result.fieldOutcomes.topics.accepted, 1, JSON.stringify(result.fieldOutcomes.topics));
  assert.deepEqual(result.overallTopics.map((item) => item.text), ['Alarm sound and clinical sign-off']);
});

test('a heading is held to the heading bar as well as the citation bar', () => {
  // All three cite real turns. None of them is a heading: the first is a sentence, the
  // second is who was in the room, the third asks a question. The predicates refusing them
  // are the same ones the derived labels have always had to pass - being written by a model
  // earns no exemption.
  const result = revise([
    cited('The alarm sound is largely working now', ['evt_1']),
    cited('Colm, Orla and Andrew', ['evt_1']),
    cited('Is the mute button behaviour signed off?', ['evt_2'])
  ]);
  assert.equal(result.fieldOutcomes.topics.accepted, 0, JSON.stringify(result.fieldOutcomes.topics));
  assert.equal(result.fieldOutcomes.topics.rejected, 3);
});

test('a heading citing evidence that does not resolve is refused', () => {
  const result = revise([cited('Alarm sound and clinical sign-off', ['evt_999'])]);
  assert.equal(result.fieldOutcomes.topics.accepted, 0);
  assert.deepEqual(result.fieldOutcomes.topics.reasons, ['invalid_citation']);
});

test('rejecting every heading costs the meeting nothing', () => {
  // The floor stands on its own: topics are additive, so a model that names nothing usable
  // leaves the derived headings exactly as they were.
  const result = revise([cited('It went well', ['evt_1'])]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.overallTopics, []);
});

test('renaming a heading keeps the evidence the discussion stage allocates against', () => {
  // The failure this guards: better headings over empty cards. Discussion allocates points
  // per topic using its evidence ids, so a rename that dropped them would look like an
  // improvement on the summary screen and empty the next one.
  const summary = {
    topicRefs: [
      { text: 'Alarm behaviour and controls', topicId: 'topic_1', evidenceIds: ['evt_1', 'evt_2'] },
      { text: 'Plans and timelines', topicId: 'topic_2', evidenceIds: ['evt_9'] }
    ]
  };
  const merged = mergeNamedTopics(summary, [
    { text: 'Alarm sound and clinical sign-off', evidenceIds: ['evt_1', 'evt_2'] },
    { text: 'Debug and test-script evidence', evidenceIds: ['evt_3'] }
  ], []);
  const renamed = merged.topicRefs.find((ref) => ref.topicId === 'topic_1');
  assert.equal(renamed.text, 'Alarm sound and clinical sign-off', 'the heading is the model\'s wording');
  assert.deepEqual(renamed.evidenceIds, ['evt_1', 'evt_2'], 'and it keeps the turns behind it');
  assert.ok(merged.overallTopics.includes('Plans and timelines'), 'a heading nobody renamed is left alone');
  assert.ok(merged.overallTopics.includes('Debug and test-script evidence'), 'a subject nobody had named is added');
});

test('a heading the reviewer confirmed is never renamed', () => {
  // Older than this feature and outranking it.
  const summary = { topicRefs: [{ text: 'What we owe the client next', topicId: 'topic_1', evidenceIds: ['evt_1'] }] };
  const merged = mergeNamedTopics(summary, [{ text: 'Alarm sound and clinical sign-off', evidenceIds: ['evt_1'] }], ['What we owe the client next']);
  assert.deepEqual(merged, {}, 'confirmed topics are returned untouched');
});

test('a trailing full stop does not survive into a heading', () => {
  const merged = mergeNamedTopics({ topicRefs: [] }, [{ text: 'Audit scope, timing and logistics.', evidenceIds: ['evt_1'] }], []);
  assert.deepEqual(merged.overallTopics, ['Audit scope, timing and logistics']);
});
