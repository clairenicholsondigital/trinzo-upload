'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');

// Real sentences from an evaluation meeting.
const units = [
  { id: 'T0126', speaker: 'Rebecca Gill', text: 'Do you have a follow-up call with Colm today, or was it yesterday?' },
  { id: 'T0127', speaker: 'Ciaran Ryan', text: 'Yesterday, yeah, so we\'re in good, so good place.' },
  { id: 'T0128', speaker: 'Rebecca Gill', text: 'We have a call today to walk kind of through that and make sure we\'ve got everything where we need to be, especially the response to the cars.' },
  { id: 'T0129', speaker: 'Rebecca Gill', text: 'And then hopefully get everything just loaded on the call me docs for Grace to kind of review and approve.' },
  { id: 'T0130', speaker: 'Rebecca Gill', text: 'and then we\'ll download it and pop them in the tech file again and point the auditor in the direction of them.' },
  { id: 'T0200', speaker: 'Jacqui Fox', text: 'I\'ll send that out now.' },
  { id: 'T0201', speaker: 'Mark Kelleher', text: 'But let\'s, sorry, when will that start, Jacqui? Is it next week?' },
  { id: 'T0202', speaker: 'Jacqui Fox', text: 'I could do it from next Wednesday then if that\'s preferable.' }
];

const upload = { id: 'x1', action: 'Load the documents for Grace to review and approve, then place them in the tech file.', owners: ['Rebecca Gill'],
  timing: { kind: 'deadline', wording: 'today', exactDate: '' }, evidenceIds: ['T0128', 'T0129'], reviewFlagIds: [] };
const walkAndLoad = { id: 'x2', action: 'Walk through the response to the CARs on today\'s call, then load the documents for Grace to review.', owners: ['Rebecca Gill'],
  timing: { kind: 'deadline', wording: 'today', exactDate: '' }, evidenceIds: ['T0128', 'T0129'], reviewFlagIds: [] };
const sendSchedule = { id: 'x3', action: 'Send out the working session schedule.', owners: ['Jacqui Fox'],
  timing: { kind: 'deadline', wording: 'next Wednesday', exactDate: '' }, evidenceIds: ['T0200', 'T0202'], reviewFlagIds: [] };
const notStated = { id: 'x4', action: 'Follow up with Orla on the approach.', owners: ['Jacqui Fox'],
  timing: { kind: 'deadline', wording: 'not stated', exactDate: '' }, evidenceIds: ['T0200'], reviewFlagIds: [] };

test('the prompt routes through the critic pass-through and carries each timed action with its passage', () => {
  const items = V.timingCheckItems([upload, notStated], units);
  assert.equal(items.length, 1, '"not stated" is handled without the model');
  assert.match(items[0].passage, /\[T0128\] Rebecca Gill: We have a call today/);
  const prompt = V.timingCheckPrompt(items, '2026-06-17');
  assert.ok(prompt.startsWith('ACTION_CRITIC_TIMING'));
  assert.match(prompt, /verbatim/);
});

test('a verified "other step" verdict removes the timing and flags it with the quote', () => {
  const actions = [upload];
  const items = V.timingCheckItems(actions, units);
  const { actions: out, flags } = V.applyTimingCheckResults(actions, items, [{
    id: items[0].id, verdict: 'belongs_to_other_step', timingQuote: 'We have a call today', stepQuote: 'We have a call today to walk kind of through that', correctTiming: ''
  }]);
  assert.equal(out[0].timing.kind, 'not_stated');
  assert.equal(flags.length, 1);
  assert.match(flags[0].message, /Timing "today" removed: in the transcript it was said about "We have a call today to walk kind of through that"/);
  assert.ok(out[0].reviewFlagIds.includes(flags[0].id));
});

test('a verified replacement from the passage is used when the model gives this action\'s own timing', () => {
  const actions = [sendSchedule];
  const items = V.timingCheckItems(actions, units);
  const { actions: out, flags } = V.applyTimingCheckResults(actions, items, [{
    id: items[0].id, verdict: 'belongs_to_other_step', timingQuote: 'from next Wednesday', stepQuote: 'I could do it from next Wednesday', correctTiming: 'now'
  }]);
  assert.equal(out[0].timing.wording, 'now');
  assert.match(flags[0].message, /Timing changed from "next Wednesday" to "now"/);
});

test('an invented or paraphrased quote changes nothing', () => {
  const actions = [upload];
  const items = V.timingCheckItems(actions, units);
  const { actions: out, flags } = V.applyTimingCheckResults(actions, items, [{
    id: items[0].id, verdict: 'belongs_to_other_step', timingQuote: 'the call is today', stepQuote: 'a call with Colm about the CARs', correctTiming: ''
  }]);
  assert.deepEqual(out[0].timing, upload.timing);
  assert.equal(flags.length, 0);
});

test('an "other step" that is one of the steps the action names changes nothing', () => {
  const actions = [walkAndLoad];
  const items = V.timingCheckItems(actions, units);
  const { actions: out, flags } = V.applyTimingCheckResults(actions, items, [{
    id: items[0].id, verdict: 'belongs_to_other_step', timingQuote: 'We have a call today',
    stepQuote: 'We have a call today to walk kind of through that and make sure we\'ve got everything where we need to be, especially the response to the cars', correctTiming: ''
  }]);
  assert.deepEqual(out[0].timing, walkAndLoad.timing);
  assert.equal(flags.length, 0);
});

test('"correct", unknown and missing verdicts leave timings alone; a failed call changes nothing', () => {
  const actions = [upload, walkAndLoad];
  const items = V.timingCheckItems(actions, units);
  const results = [{ id: items[0].id, verdict: 'correct' }, { id: items[1].id, verdict: 'maybe' }];
  assert.deepEqual(V.applyTimingCheckResults(actions, items, results).actions, actions);
  assert.deepEqual(V.applyTimingCheckResults(actions, items, []).actions, actions);
});

test('the literal "not stated" is cleared to no timing without asking the model', () => {
  const { actions: out, flags } = V.applyTimingCheckResults([notStated], V.timingCheckItems([notStated], units), []);
  assert.equal(out[0].timing.kind, 'not_stated');
  assert.equal(flags.length, 0, 'removing a placeholder is not a reviewer decision');
});
