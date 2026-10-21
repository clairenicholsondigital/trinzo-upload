'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');
const T = require('../utils/meetingMinutesTiming');
const A = require('../routes/api').stagedEvaluation;
const options = { meetingDate: '2026-10-21' };

test('take and fit survive actual source normalization and referee reconstruction only for grounded work', () => {
  for (const [action, statement, wording] of [
    ['Take the inspection photograph.', 'I will take the inspection photograph tomorrow.', 'tomorrow'],
    ['Fit the replacement actuator.', 'I will fit the replacement actuator Friday.', 'Friday']
  ]) {
    const record = { id: 'work', action, owners: ['Morgan'], evidenceIds: ['T0001'],
      timing: { kind: 'target', wording, exactDate: '' } };
    const candidate = { candidateId: 'candidate', recordType: 'action', record, text: action,
      evidenceIds: record.evidenceIds, sourcePass: 'primary' };
    const verdict = [{ candidateId: candidate.candidateId, disposition: 'publish', evidenceIds: record.evidenceIds }];
    const source = [{ id: 'T0001', speaker: 'Morgan', text: statement }];
    const result = A.reconstructRefereeActions(verdict, [candidate], source, options);
    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0].action, action);
    assert.deepEqual(result.actions[0].owners, ['Morgan']);
    assert.equal(result.actions[0].timing.wording, wording);
    assert.equal(A.isClientReadyActionWording(result.actions[0].action), true);
    assert.equal(A.highConfidenceRefereedAction(result.actions[0], [candidate], source), true);
    const unaccepted = [{ ...source[0], text: statement.replace('I will', 'Maybe someone could') }];
    assert.deepEqual(A.reconstructRefereeActions(verdict, [candidate], unaccepted, options).actions, [],
      'a presentation verb cannot turn an unaccepted suggestion into an action');
    assert.deepEqual(A.reconstructRefereeActions(verdict, [candidate], [], options).actions, [],
      'the evidence boundary still rejects absent source');
  }
});

function example(sourceOverride) {
  const source = sourceOverride || [
    { id: 'T0001', speaker: 'Morgan', text: 'I will replace the projector lamp.' },
    { id: 'T0002', speaker: 'Chair', text: 'When will you do that?' },
    { id: 'T0003', speaker: 'Morgan', text: "I'll do it Friday morning probably." }
  ];
  const action = { id: 'lamp', action: 'Replace the projector lamp.', owners: ['Morgan'],
    evidenceIds: ['T0001', 'T0003'], reviewFlagIds: [],
    timing: { kind: 'target', wording: 'Friday morning probably', exactDate: '2026-10-23' } };
  const items = V.timingCheckItems([action], source, options);
  const verdict = { id: items[0].id, verdict: 'correct', timingQuote: 'Friday morning probably',
    stepQuote: "I'll do it Friday morning probably." };
  return { source, action, items, verdict };
}

test('a full deictic timing answer is accepted only with independent same-action source binding', () => {
  const e = example();
  assert.equal(T.assessTimingSourceBinding(e.action, e.source, options).status, 'supported');
  const result = V.applyTimingCheckResults([e.action], e.items, [e.verdict], options);
  assert.equal(result.accounting.complete, true);
  assert.equal(result.accounting.counts.supported, 1);
  assert.deepEqual(result.actions[0].timing, e.action.timing);
  assert.equal(result.actions[0].timingDecision.status, 'qualified');
  assert.deepEqual(result.flags, []);
});

test('deictic quote approval cannot hide new work, another owner or an absent antecedent', () => {
  const original = example();
  const variants = [
    original.source.map(unit => unit.id === 'T0003' ? { ...unit, text: "I'll do it Friday morning probably, and Jordan will review the budget." } : unit),
    original.source.map(unit => unit.id === 'T0003' ? { ...unit, speaker: 'Jordan' } : unit),
    original.source.filter(unit => unit.id !== 'T0001'),
    original.source.map(unit => unit.id === 'T0003' ? { ...unit, text: 'I will send the training pack Friday morning probably.' } : unit)
  ];
  for (const source of variants) {
    const e = example(source);
    const stepQuote = source.at(-1).text.includes('training pack') ? source.at(-1).text
      : "I'll do it Friday morning probably";
    const result = V.applyTimingCheckResults([e.action], e.items, [{ ...e.verdict, stepQuote }], options);
    assert.equal(result.actions[0].action, e.action.action);
    assert.deepEqual(result.actions[0].owners, e.action.owners);
    assert.equal(result.accounting.complete, false, JSON.stringify(source));
    assert.ok(result.flags.length);
  }
});

test('independent source support never silently upgrades an explicit uncertain or contradictory critic verdict', () => {
  const e = example();
  for (const verdict of [
    { id: e.verdict.id, verdict: 'uncertain', reason: 'The timing needs review.' },
    { ...e.verdict, verdict: 'misread', correctTiming: '' }
  ]) {
    const result = V.applyTimingCheckResults([e.action], e.items, [verdict], options);
    assert.equal(result.accounting.complete, false);
    assert.equal(result.actions[0].timingDecision.status, 'unresolved');
    assert.deepEqual(result.actions[0].timing, e.action.timing);
    assert.ok(result.flags.length);
  }
});

test('completion softening retains a directly quoted own-work timing hedge through finalization', () => {
  const units = [{ id: 'T0001', speaker: 'Chair', text: 'The next item is review of the installation protocol.' },
    { id: 'T0002', speaker: 'Morgan', text: "I'm working on that, trying to finish up this week." }];
  const action = { id: 'protocol', action: 'Complete the review of the installation protocol.', owners: ['Morgan'],
    evidenceIds: ['T0001', 'T0002'], reviewFlagIds: [], timing: { kind: 'target', wording: 'Finish up this week.', exactDate: '' } };
  const result = V.softenBestEffortCompletion([action], units);
  assert.equal(result.actions[0].action, 'Progress the review of the installation protocol.');
  assert.equal(result.actions[0].timing.wording, 'trying to finish up this week');
  assert.equal(result.actions[0].timing.exactDate, '');
  const final = V.finaliseActionTimings(result.actions, units, options);
  assert.equal(final.actions[0].timing.wording, 'trying to finish up this week');
  assert.equal(final.actions[0].timingDecision.status, 'unresolved');
  for (const source of [
    [units[0], { ...units[1], speaker: 'Jordan' }],
    [units[0], { ...units[1], text: "I'm working on the budget, trying to finish up this week." }],
    [{ ...units[0], text: 'The next item is review of the maintenance budget.' }, units[1]],
    [units[0], { ...units[1], text: "I'm working on that, trying to finish up this week, then Jordan will send the inspection report." }]
  ]) assert.deepEqual(V.softenBestEffortCompletion([action], source).actions[0].timing, action.timing,
    'a matching generic completion phrase cannot borrow another owner or workstream qualification');
  const manual = { ...action, reviewerAuthored: true };
  assert.deepEqual(V.softenBestEffortCompletion([manual], units).actions[0], manual);
});
