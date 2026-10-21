'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');
const Timing = require('../utils/meetingMinutesTiming');

const options = { meetingDate: '2026-02-03' };
const units = rows => V.normaliseSourceUnits(rows.map(([speaker, text]) => ({ speaker, text })));
const row = (changes = {}) => ({
  id: 'count', action: 'Start the warehouse stock count.', owners: ['Morgan'],
  timing: { kind: 'target', wording: 'Hopefully late next month at least.', exactDate: '' },
  evidenceIds: ['T0015'], ...changes
});
const normalise = (action, source, extra = {}) => V.normaliseAgentResult({ actions: [action] }, source, 'actions', { ...options, ...extra });

function stockCountSource(final = 'Morgan, finish the storage audit and the stock count, hopefully late next month to start the count at least.') {
  return units([
    ['Chair', 'The warehouse stock count must cover the full warehouse stock count discrepancy list.'],
    ['Morgan', 'I will start the warehouse stock count after the storage audit.'],
    ...Array.from({ length: 12 }, () => ['Chair', 'Next item is attendance.']),
    ['Chair', final]
  ]);
}

test('shortened source timing keeps its actual assignment anchor before noun-heavy remapping', () => {
  const source = stockCountSource();
  const input = row();
  const before = structuredClone({ input, source });
  const result = normalise(input, source);
  assert.equal(result.actions.length, 1);
  assert.ok(result.actions[0].evidenceIds.includes('T0015'), 'the source carrying this period must survive');
  assert.deepEqual(result.actions[0].owners, ['Morgan']);
  assert.deepEqual(result.actions[0].timing, input.timing);
  assert.equal(result.actions[0].timingDecision.status, 'unresolved', 'retaining evidence is not semantic verification');
  assert.ok(result.reviewFlags.some(flag => flag.kind === 'timing'));
  assert.deepEqual({ input, source }, before);
});

test('field-anchor retention respects the existing citation cap', () => {
  const source = stockCountSource();
  const input = row({ evidenceIds: source.map(unit => unit.id) });
  const result = normalise(input, source);
  assert.ok(result.actions[0].evidenceIds.includes('T0015'));
  assert.ok(result.actions[0].evidenceIds.length <= 8);
  assert.equal(result.actions[0].timing.wording, input.timing.wording);
});

test('shortened timing anchors reject changed roles, work, qualifications, bounds and history', () => {
  const tails = [
    'Casey, hopefully late next month to start the count at least.',
    'Casey will finish the storage audit and stock count, hopefully late next month to start the count at least.',
    'Morgan, finish the storage audit and count, hopefully late next month to start the cycle count at least.',
    'Morgan, finish the storage audit and count, hopefully late next month to review the count at least.',
    'Morgan, finish the storage audit and count, hopefully early next month to start the count at least.',
    'Morgan, finish the storage audit and count, hopefully before late next month to start the count at least.',
    'Morgan, finish the storage audit and count, probably late next month to start the count at least.',
    'Morgan, do not plan hopefully late next month to start the count at least.',
    'Morgan had planned hopefully late next month to start the count at least.',
    'Morgan, finish the storage audit and count, hopefully late next month on Monday morning to start the count at least.'
  ];
  for (const tail of tails) {
    const result = normalise(row(), stockCountSource(tail));
    assert.equal(result.actions.length, 1, tail);
    assert.ok(!result.actions[0].evidenceIds.includes('T0015'), tail);
    assert.equal(result.actions[0].timing.wording, '', tail);
    assert.notEqual(result.actions[0].timingDecision.status, 'verified', tail);
  }
});

test('a generated period absent from its source remains withheld and flagged', () => {
  const source = units([['Morgan', 'I will start the warehouse stock count.']]);
  const input = row({ evidenceIds: ['T0001'] });
  const core = Timing.assessActionTiming(input, source, options);
  assert.equal(core.assessment.status, 'unresolved');
  assert.ok(core.issues.some(issue => issue.preserveValue));
  const result = normalise(input, source);
  assert.equal(result.actions[0].timing.kind, 'not_stated');
  assert.equal(result.actions[0].timing.wording, '');
  assert.equal(result.actions[0].timingDecision.status, 'unresolved');
  assert.ok(result.reviewFlags.some(flag => /does not establish/.test(flag.message)));
  assert.ok(result.reviewFlags.some(flag => /Confirm or correct unsupported action timing/.test(flag.message)));
});

test('a nearby date for another operation cannot become this action timing', () => {
  const source = units([
    ['Morgan', 'I will draft the inspection report Friday.'],
    ['Morgan', 'I will review the inspection report after approval.']
  ]);
  const result = normalise(row({ action: 'Review the inspection report.', evidenceIds: ['T0001'], timing: { kind: 'target', wording: 'Friday', exactDate: '2026-02-06' } }), source);
  assert.equal(result.actions[0].timing.wording, '');
  assert.equal(result.actions[0].timing.exactDate, '');
  assert.equal(result.actions[0].timingDecision.status, 'rejected');
});

test('another owner or object cannot donate a source-stated date', () => {
  for (const sourceText of ['Casey will review the inspection report Friday.', 'I will review the catering estimate Friday.']) {
    const source = units([['Morgan', sourceText]]);
    const result = normalise(row({ action: 'Review the inspection report.', evidenceIds: ['T0001'], timing: { kind: 'target', wording: 'Friday', exactDate: '2026-02-06' } }), source, { enforceEvidence: false });
    assert.equal(result.actions[0].timing.wording, '', sourceText);
    assert.equal(result.actions[0].timing.exactDate, '', sourceText);
    assert.equal(result.actions[0].timingDecision.status, 'rejected', sourceText);
  }
});

test('same-turn work clauses cannot donate each other’s periods through anchor retention', () => {
  const source = units([['Morgan', 'I will review the inspection report next week, and I will draft the catering estimate Friday.']]);
  const result = normalise(row({ action: 'Draft the catering estimate.', evidenceIds: ['T0001'], timing: { kind: 'target', wording: 'next week', exactDate: '' } }), source);
  assert.equal(result.actions[0].timing.wording, '');
  assert.equal(result.actions[0].timingDecision.status, 'rejected');
});

test('an explicit clock conflict is still rejected at full normalisation', () => {
  const source = units([['Morgan', 'I will review the inspection report Friday at 11:30 GMT.']]);
  const result = normalise(row({ action: 'Review the inspection report.', evidenceIds: ['T0001'], timing: { kind: 'target', wording: 'Friday at 10:30 BST', exactDate: '2026-02-06' } }), source);
  assert.equal(result.actions[0].timing.wording, '');
  assert.equal(result.actions[0].timing.exactDate, '');
  assert.equal(result.actions[0].timingDecision.status, 'rejected');
});

test('invalid days, invented months and broad-period precision remain blocked', () => {
  const source = units([['Morgan', 'I will review the inspection report on the 17th.']]);
  for (const timing of [
    { kind: 'deadline', wording: '17 July', exactDate: '2026-07-17' },
    { kind: 'deadline', wording: '31 February 2026', exactDate: '2026-02-31' }
  ]) {
    const result = normalise(row({ action: 'Review the inspection report.', evidenceIds: ['T0001'], timing }), source);
    assert.equal(result.actions[0].timing.exactDate, '');
    assert.equal(result.actions[0].timingDecision.status, 'rejected');
    assert.ok(result.reviewFlags.some(flag => flag.kind === 'timing'));
  }
  const broadSource = units([['Morgan', 'I will review the inspection report next week.']]);
  const broad = normalise(row({ action: 'Review the inspection report.', evidenceIds: ['T0001'], timing: { kind: 'target', wording: 'next week', exactDate: '2026-02-13' } }), broadSource);
  assert.equal(broad.actions[0].timing.wording, 'next week');
  assert.equal(broad.actions[0].timing.exactDate, '');
});

test('actual reviewer values remain literal and visibly unverified', () => {
  const source = units([['Morgan', 'I will start the warehouse stock count.']]);
  const input = row({ evidenceIds: ['T0001'], reviewerAuthored: true,
    timing: { kind: 'target', wording: 'Reviewer’s proposed planning window', exactDate: '2026-02-31' } });
  const result = normalise(input, source, { enforceEvidence: false, preserveReviewerEdits: true });
  assert.deepEqual(result.actions[0].timing, input.timing);
  assert.ok(result.reviewFlags.some(flag => flag.kind === 'timing'));
});

test('a valid exact source date still normalises and remains supported', () => {
  const source = units([['Morgan', 'I will review the inspection report on 6 February 2026.']]);
  const result = normalise(row({ action: 'Review the inspection report.', evidenceIds: ['T0001'], timing: { kind: 'deadline', wording: '6 February 2026', exactDate: '2026-02-06' } }), source);
  assert.equal(result.actions[0].timing.exactDate, '2026-02-06');
  assert.equal(result.actions[0].timingDecision.binding.status, 'supported');
});
