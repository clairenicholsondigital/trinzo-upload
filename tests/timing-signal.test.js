'use strict';

// A timing column holds a time. Draft 1055 published "I'll draft that." as a
// deadline: the timing critic quoted the commitment sentence as the "correct
// timing", it was verbatim in the passage, and the sentence-shape guard only
// knew the space-separated form ("I will"). The real answer, "Okay so that's
// the fifteenth", sat three rows later.
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');

test('a contracted commitment sentence is sentence-shaped, not a deadline', () => {
  for (const wording of ['I\'ll draft that.', 'We\'ll sort it', 'I\'m about most of Tuesday.', 'I\'ve sent it', 'There are some further updates that need to happen to that']) {
    assert.equal(V.timingPublicationIssue({ kind: 'deadline', wording }), 'sentence_shaped_timing', wording);
    assert.equal(V.timingWordingHasMeaning({ kind: 'deadline', wording }), false, wording);
  }
  assert.deepEqual(V.timingForPublication({ kind: 'deadline', wording: 'I\'ll draft that.', exactDate: '' }),
    { kind: 'not_stated', wording: '', exactDate: '' });
});

test('wording with no time in it fails closed, whatever kind the model chose', () => {
  assert.equal(V.timingPublicationIssue({ kind: 'deadline', wording: 'create those two language characterization situations' }), 'no_timing_signal');
  assert.equal(V.timingPublicationIssue({ kind: 'target', wording: 'the usability file' }), 'no_timing_signal');
});

test('real timings that the old lists did not know still pass', () => {
  for (const [kind, wording] of [
    ['deadline', 'in a fortnight'], ['target', 'straight away'], ['dependency', 'during the live webinar'],
    ['deadline', 'by close of play'], ['dependency', 'if gaps are found during traceability review'],
    ['target', 'Tuesday at two, same as this'], ['target', 'every couple of days from now till race day'],
    ['deadline', 'the fifteenth'], ['dependency', 'around the decision that you guys go with'],
    ['target', 'first thing'], ['deadline', 'before we come out']
  ]) {
    assert.equal(V.timingPublicationIssue({ kind, wording }), '', `${kind}: ${wording}`);
    assert.equal(V.timingWordingHasMeaning({ kind, wording }), true, `${kind}: ${wording}`);
  }
});

const units = [
  { id: 'T0043', speaker: 'David Didsbury', text: 'Splitting is fine, splitting is normal, but you need the justification written down for why the planning module cannot contribute to a hazardous situation.' },
  { id: 'T0044', speaker: 'David Didsbury', text: 'And I would want to see that before it goes anywhere near the notified body.' },
  { id: 'T0045', speaker: 'Dermot Nally', text: 'I\'ll draft that.' },
  { id: 'T0046', speaker: 'Jacqui Fox', text: 'And when do you think, Dermot?' },
  { id: 'T0047', speaker: 'Dermot Nally', text: 'It is not a long document but I want Marcus to look over it.' },
  { id: 'T0048', speaker: 'Jacqui Fox', text: 'Okay so that is the fifteenth.' },
  { id: 'T0049', speaker: 'Jacqui Fox', text: 'I will put it in as the fifteenth.' }
];

test('"when do you think?" is a when-question, and the asker may settle the answer', () => {
  const timing = V.backfillAskedTiming({ kind: 'not_stated', wording: '', exactDate: '' }, units, ['T0043', 'T0045'], { meetingDate: '2026-09-10' });
  assert.equal(timing.wording, 'the fifteenth');
  assert.equal(timing.exactDate, '2026-09-15');
});

test('the asker\'s own follow-up question is not an answer', () => {
  const asking = [
    { id: 'T0001', speaker: 'Jacqui Fox', text: 'I\'ll send the plan.' },
    { id: 'T0002', speaker: 'Mark Kelleher', text: 'When can you do that?' },
    { id: 'T0003', speaker: 'Mark Kelleher', text: 'Is Friday too soon?' },
    { id: 'T0004', speaker: 'Mark Kelleher', text: 'Or maybe Monday would suit better?' }
  ];
  const timing = V.backfillAskedTiming({ kind: 'not_stated', wording: '', exactDate: '' }, asking, ['T0001', 'T0002'], {});
  assert.equal(timing.kind, 'not_stated');
});

test('the timing critic cannot install a commitment sentence as the corrected timing', () => {
  const action = {
    id: 'a1', action: 'Draft the justification for splitting the navigation app.', owners: ['Dermot Nally'],
    timing: { kind: 'target', wording: 'this week', exactDate: '' }, evidenceIds: ['T0043', 'T0045'], reviewFlagIds: []
  };
  const items = V.timingCheckItems([action], units);
  assert.equal(items.length, 1);
  const { actions, flags } = V.applyTimingCheckResults([action], items, [{
    id: items[0].id, verdict: 'belongs_to_other_step',
    timingQuote: 'It is not a long document', stepQuote: 'I want Marcus to look over it', correctTiming: 'I\'ll draft that.', reason: ''
  }], { meetingDate: '2026-09-10' });
  assert.notEqual(actions[0].timing.wording, 'I\'ll draft that.');
  assert.ok(flags.every((flag) => !/to "I'll draft that\."/.test(flag.message)));
});

test('a copied sentence in the timing column no longer blocks the transcript backfill', () => {
  const [action] = V.normaliseActions({
    actions: [{
      id: 'a1', action: 'Draft the justification for splitting the navigation app into a planning module and an intraoperative display.',
      owners: ['Dermot Nally'], timing: { kind: 'deadline', wording: 'I\'ll draft that.', exactDate: '' }, evidenceIds: ['T0043', 'T0045']
    }]
  }, units, { meetingDate: '2026-09-10' });
  assert.deepEqual(action.timing, { kind: 'deadline', wording: 'the fifteenth', exactDate: '2026-09-15' });
  // Replaced from the transcript, not removed: no removal flag.
  assert.equal(action._timingPublicationIssue, '');
});
