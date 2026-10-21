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
const directlyTimedSource = [{ id: 'T0001', speaker: 'Sam', text: 'I will send the inspection report today.' }];
const directlyTimed = { id: 'direct', action: 'Send the inspection report.', owners: ['Sam'],
  timing: { kind: 'deadline', wording: 'today', exactDate: '' }, evidenceIds: ['T0001'], reviewFlagIds: [] };
const businessContent = ({ reviewFlagIds: _flags, timingDecision: _decision, ...row }) => row;

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

test('removing an unsupported timing also removes it from the action wording', () => {
  const actions = [{
    id: 'x5', action: 'Change the barcodes by early July and review the label design.', owners: ['Jenny'],
    timing: { kind: 'deadline', wording: 'early July', exactDate: '' }, evidenceIds: ['T0300', 'T0301'], reviewFlagIds: []
  }];
  const source = [
    { id: 'T0300', speaker: 'Alex', text: 'We hope to have the process figured out by early July.' },
    { id: 'T0301', speaker: 'Alex', text: 'After that the barcode changes can be implemented.' }
  ];
  const items = V.timingCheckItems(actions, source);
  const result = V.applyTimingCheckResults(actions, items, [{
    id: items[0].id, verdict: 'belongs_to_other_step', timingQuote: 'by early July',
    stepQuote: 'have the process figured out by early July', correctTiming: ''
  }]);
  assert.equal(result.actions[0].timing.kind, 'not_stated');
  assert.equal(result.actions[0].action, 'Change the barcodes and review the label design.');
  assert.equal(result.flags.length, 1);
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

test('an invented or paraphrased quote cannot alter source-valid timing and is flagged as unverified', () => {
  const actions = [directlyTimed];
  const items = V.timingCheckItems(actions, directlyTimedSource);
  const result = V.applyTimingCheckResults(actions, items, [{
    id: items[0].id, verdict: 'belongs_to_other_step', timingQuote: 'the call is today', stepQuote: 'a call with Colm about the CARs', correctTiming: ''
  }]);
  assert.deepEqual(businessContent(result.actions[0]), businessContent(directlyTimed));
  assert.ok(result.flags.length);
  assert.equal(result.accounting.complete, false);
});

test('a verbatim replacement can repair timing when the critic copied the old wording imprecisely', () => {
  const source = [
    { id: 'T0400', speaker: 'Alex', text: 'The audit-week proposal is for next week.' },
    { id: 'T0401', speaker: 'Alex', text: 'The standards list needs to be ready by the tenth.' }
  ];
  const actions = [{
    id: 'a1', action: 'Prepare the audit-week proposal.', owners: ['Alex'],
    timing: { kind: 'deadline', wording: 'by the tenth', exactDate: '' }, evidenceIds: ['T0400', 'T0401'], reviewFlagIds: []
  }];
  const items = V.timingCheckItems(actions, source);
  const result = V.applyTimingCheckResults(actions, items, [{
    id: items[0].id, verdict: 'misread', timingQuote: 'by 10th', correctTiming: 'next week'
  }]);
  assert.equal(result.actions[0].timing.wording, 'next week');
  assert.equal(result.flags.length, 1);
});

test('an "other step" that is actually this same source-timed work cannot remove its timing', () => {
  const source = [{ id: 'T0001', speaker: 'Sam', text: 'I will review and approve the inspection report today.' }];
  const action = { ...directlyTimed, action: 'Review and approve the inspection report.' };
  const actions = [action];
  const items = V.timingCheckItems(actions, source);
  const { actions: out, flags } = V.applyTimingCheckResults(actions, items, [{
    id: items[0].id, verdict: 'belongs_to_other_step', timingQuote: 'today',
    stepQuote: 'review and approve the inspection report', correctTiming: ''
  }]);
  assert.deepEqual(businessContent(out[0]), businessContent(action));
  assert.ok(flags.length);
});

test('valid approval preserves timing while unknown or missing replies preserve work with explicit incomplete accounting', () => {
  const actions = [directlyTimed];
  const items = V.timingCheckItems(actions, directlyTimedSource);
  const valid = V.applyTimingCheckResults(actions, items, [{ id: items[0].id, verdict: 'correct', timingQuote: 'today', stepQuote: 'send the inspection report' }]);
  assert.deepEqual(businessContent(valid.actions[0]), businessContent(directlyTimed));
  assert.equal(valid.accounting.complete, true);
  for (const results of [[{ id: items[0].id, verdict: 'maybe' }], []]) {
    const result = V.applyTimingCheckResults(actions, items, results);
    assert.deepEqual(businessContent(result.actions[0]), businessContent(directlyTimed));
    assert.ok(result.flags.length);
    assert.equal(result.accounting.complete, false);
  }
});

test('the literal "not stated" is cleared to no timing without asking the model', () => {
  const { actions: out, flags } = V.applyTimingCheckResults([notStated], V.timingCheckItems([notStated], units), []);
  assert.equal(out[0].timing.kind, 'not_stated');
  assert.equal(flags.length, 0, 'removing a placeholder is not a reviewer decision');
});

test('a save never re-adds a timing that was cleared', () => {
  const V = require('../utils/meetingMinutesAgentV2');
  const units = [{ id: 'T0001', speaker: 'Rebecca Gill', text: "We have a call today and then we'll download it and pop them in the tech file." }];
  const action = { id: 'a1', action: 'Download the approved documents into the tech file.', owners: ['Rebecca Gill'], timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0001'] };
  const saved = V.normaliseAgentResult({ actions: [action] }, units, '', { enforceEvidence: false });
  assert.equal(saved.actions[0].timing.kind, 'not_stated');
  const fresh = V.normaliseAgentResult({ actions: [action] }, units, 'actions', {});
  assert.equal(fresh.actions[0].timing.kind, 'not_stated', 'today dates the call, not every later document operation');
  const directlyDated = [{ id: 'T0001', speaker: 'Rebecca Gill', text: 'I will download the approved documents into the tech file today.' }];
  const supported = V.normaliseAgentResult({ actions: [action] }, directlyDated, 'actions', {});
  assert.equal(supported.actions[0].timing.wording, 'today', 'fresh generation still backfills a directly dated owned operation');
});

test('a misread verdict is ignored when the timing is said word for word', () => {
  const actions = [directlyTimed];
  const items = V.timingCheckItems(actions, directlyTimedSource);
  const out = V.applyTimingCheckResults(actions, items, [{ id: items[0].id, verdict: 'misread', timingQuote: 'today' }], {});
  assert.equal(out.actions[0].timing.wording, 'today');
  assert.ok(out.flags.length);
  assert.equal(out.rejected[0].reason, 'timing_is_verbatim_in_passage');
});

test('a deadline said about the first step of a chained action leaves the deadline column', () => {
  const V = require('../utils/meetingMinutesAgentV2');
  const out = V.applyChainedTimingRule([
    { action: 'Conduct a call today to walk through the CAR responses, load the documents for Grace to approve, then download them into the tech file.', timing: { kind: 'deadline', wording: 'today', exactDate: '2026-06-17' }, evidenceIds: ['T0001'] },
    { action: 'Resolve the symbol issue and then upload the translations.', timing: { kind: 'target', wording: 'by the end of next week' }, evidenceIds: [] },
    { action: 'Send the report to Colm today.', timing: { kind: 'deadline', wording: 'today' }, evidenceIds: [] }
  ]);
  assert.equal(out.actions[0].timing.kind, 'not_stated');
  assert.match(out.actions[0].action, /call today/);
  assert.equal(out.actions[1].timing.wording, 'by the end of next week');
  assert.equal(out.actions[2].timing.wording, 'today');
  assert.equal(out.flags.length, 1);
});

test('a timing spoken only in the first cited line of a chain leaves the deadline column with a quoted flag', () => {
  const V = require('../utils/meetingMinutesAgentV2');
  const units = [
    { id: 'T0001', speaker: 'Rebecca Gill', text: 'We have a call today to walk through the CAR responses.' },
    { id: 'T0002', speaker: 'Rebecca Gill', text: 'And then get everything loaded for Grace to review and approve.' },
    { id: 'T0003', speaker: 'Rebecca Gill', text: 'Then we will download it and point the auditor to them.' }
  ];
  const out = V.applyChainedTimingRule([
    { action: 'Conduct a call to walk through the CAR responses, load the documents for Grace to approve, then download them.', timing: { kind: 'deadline', wording: 'today' }, evidenceIds: ['T0001', 'T0002', 'T0003'] }
  ], units);
  assert.equal(out.actions[0].timing.kind, 'not_stated');
  assert.equal(out.flags.length, 1);
  assert.match(out.flags[0].message, /We have a call today/);
});

test('overlapping commitments preserve unique operations and first-step timing', () => {
  const V = require('../utils/meetingMinutesAgentV2');
  const out = V.mergeDuplicateCommitments([
    { action: 'Complete the three code changes covering alarms and languages.', owners: ['Andrew'], timing: { kind: 'target', wording: 'end of next week' }, evidenceIds: ['T0043'] },
    { action: 'Resolve the language symbol issue so the translations can be uploaded.', owners: ['Andrew'], timing: { kind: 'not_stated', wording: '' }, evidenceIds: ['T0043'] },
    { action: 'Load the CAR responses for Grace to approve, then download them into the tech file.', owners: ['Rebecca Gill'], timing: { kind: 'not_stated', wording: '' }, evidenceIds: ['T0117', 'T0119', 'T0120', 'T0121'] },
    { action: 'Conduct a call about the CAR responses, then load the documents for Grace and download them into the tech file.', owners: ['Rebecca Gill'], timing: { kind: 'target', wording: 'today (first step only)' }, evidenceIds: ['T0119', 'T0120', 'T0121'] }
  ]);
  assert.equal(out.merged, 0);
  assert.equal(out.actions.length, 4);
  assert.match(out.actions[1].action, /translations can be uploaded/);
  assert.match(out.actions[2].action, /Grace to approve/);
  assert.equal(out.actions[2].timing.kind, 'not_stated');
  assert.ok(out.actions[2].evidenceIds.includes('T0117'));
  assert.match(out.actions[3].action, /^Conduct a call/);
  assert.equal(out.actions[3].timing.wording, 'today (first step only)');
  assert.deepEqual(out.actions[3].evidenceIds, ['T0119', 'T0120', 'T0121']);
});

test('a purely conditional timing is a dependency, whatever kind was supplied', () => {
  const V = require('../utils/meetingMinutesAgentV2');
  const kind = (timing) => V.normaliseAgentResult({ actions: [{ action: 'Send the report.', owners: ['A'], timing, evidenceIds: [] }] }, [], '', { enforceEvidence: false }).actions[0].timing.kind;
  assert.equal(kind({ kind: 'deadline', wording: "as soon as Christina's back" }), 'dependency');
  assert.equal(kind({ kind: 'target', wording: 'once testing completes' }), 'dependency');
  assert.equal(kind({ kind: 'deadline', wording: 'after the audit on Friday' }), 'dependency',
    'Friday dates the prerequisite audit, not the dependent action');
  assert.equal(kind({ kind: 'deadline', wording: 'before Friday' }), 'deadline',
    'a genuine due-date bound remains a deadline');
  assert.equal(kind({ kind: 'deadline', wording: 'as soon as possible' }), 'deadline');
});

test('a hedged timing is a target, not a deadline', () => {
  const V = require('../utils/meetingMinutesAgentV2');
  const kind = (wording) => V.normaliseAgentResult({ actions: [{ action: 'Send the report.', owners: ['A'], timing: { kind: 'deadline', wording }, evidenceIds: [] }] }, [], '', { enforceEvidence: false }).actions[0].timing.kind;
  assert.equal(kind('by the end of the week, hopefully'), 'target');
  assert.equal(kind('ideally before July 17th'), 'target');
  assert.equal(kind('by Friday'), 'deadline');
});

test('a source-bound qualification is retained even when it only adds a hedge', () => {
  const V = require('../utils/meetingMinutesAgentV2');
  const units = [
    { id: 'T0001', speaker: 'Andrew', text: 'I will resolve the language symbol incompatibility issue by the end of the week, hopefully.' },
    { id: 'T0002', speaker: 'Jacqui Fox', text: 'The change request is processing through the review team, the end of this week.' }
  ];
  const actions = [{ id: 'a1', action: 'Resolve the language symbol incompatibility issue.', owners: ['Andrew'], timing: { kind: 'target', wording: 'by the end of the week' }, evidenceIds: ['T0001', 'T0002'] }];
  const items = V.timingCheckItems(actions, units);
  const out = V.applyTimingCheckResults(actions, items, [{ id: items[0].id, verdict: 'belongs_to_other_step', timingQuote: 'the end of this week', stepQuote: 'processing through the review team', correctTiming: 'by the end of the week, hopefully' }], {});
  assert.equal(out.actions[0].timing.wording, 'by the end of the week, hopefully');
  assert.equal(out.actions[0].timing.kind, 'target');
  assert.equal(out.actions[0].timingDecision.status, 'qualified');
  assert.equal(out.flags.length, 0);
});

test('a later verified clarification preserves preferred and fallback timing as one target', () => {
  const source = [
    { id: 'T0001', speaker: 'Alex', text: 'The report needs to be finished by Thursday.' },
    { id: 'T0002', speaker: 'Priya', text: 'That would let us review it before the meeting.' },
    { id: 'T0003', speaker: 'Alex', text: 'Ideally before Thursday, but Friday is the hard stop if needed.' }
  ];
  const actions = [{
    id: 'a1', action: 'Finish the report by Thursday.', owners: ['Alex'],
    timing: { kind: 'deadline', wording: 'by Thursday', exactDate: '' },
    evidenceIds: ['T0001'], reviewFlagIds: []
  }];
  const items = V.timingCheckItems(actions, source);
  assert.match(items[0].passage, /Friday is the hard stop if needed/,
    'the timing check must see later qualification evidence');
  const result = V.applyTimingCheckResults(actions, items, [{
    id: items[0].id, verdict: 'qualified', timingQuote: 'by Thursday',
    qualificationQuote: 'Ideally before Thursday, but Friday is the hard stop if needed',
    preferredTiming: 'before Thursday', fallbackTiming: 'Friday', correctTiming: '', reason: ''
  }]);
  assert.equal(result.actions[0].action, 'Finish the report.');
  assert.deepEqual(result.actions[0].timing, {
    kind: 'target', wording: 'Preferred: before Thursday; fallback: Friday', exactDate: ''
  });
  assert.deepEqual(result.actions[0].evidenceIds, ['T0001', 'T0003']);
  assert.equal(result.flags.length, 0, 'fully verified clarification is applied without another reviewer flag');
  assert.deepEqual(result.rejected, []);
});

test('a second nearby date cannot qualify a deadline without explicit verbatim clarification', () => {
  const source = [
    { id: 'T0001', speaker: 'Alex', text: 'The report needs to be finished by Thursday.' },
    { id: 'T0002', speaker: 'Priya', text: 'The planning meeting is on Friday.' }
  ];
  const actions = [{
    id: 'a1', action: 'Finish the report by Thursday.', owners: ['Alex'],
    timing: { kind: 'deadline', wording: 'by Thursday', exactDate: '' },
    evidenceIds: ['T0001'], reviewFlagIds: []
  }];
  const items = V.timingCheckItems(actions, source);
  const result = V.applyTimingCheckResults(actions, items, [{
    id: items[0].id, verdict: 'qualified', timingQuote: 'by Thursday',
    qualificationQuote: 'Friday is the fallback', preferredTiming: 'Thursday',
    fallbackTiming: 'Friday'
  }]);
  assert.deepEqual(result.actions.map(businessContent), actions.map(businessContent));
  assert.ok(result.flags.length);
  assert.equal(result.accounting.complete, false);
  assert.equal(result.rejected[0].reason, 'qualification_not_verbatim_or_complete');
});

test('a timing asked and answered before the later steps still leaves the deadline column', () => {
  const V = require('../utils/meetingMinutesAgentV2');
  const units = [
    { id: 'T0001', speaker: 'Rebecca Gill', text: 'Do you have a follow-up call with Colm today, or was it yesterday?' },
    { id: 'T0002', speaker: 'Rebecca Gill', text: 'We have a call today to walk through the CAR responses.' },
    { id: 'T0003', speaker: 'Rebecca Gill', text: 'And then get everything loaded for Grace to review and approve.' },
    { id: 'T0004', speaker: 'Rebecca Gill', text: 'Then we will download it and point the auditor to them.' }
  ];
  const out = V.applyChainedTimingRule([
    { action: 'Conduct a follow-up call with Colm, then load the documents for Grace to approve.', timing: { kind: 'deadline', wording: 'today' }, evidenceIds: ['T0001', 'T0002', 'T0003', 'T0004'] }
  ], units);
  assert.equal(out.actions[0].timing.kind, 'not_stated');
  assert.match(out.flags[0].message, /earlier step/);
});
