'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');

const untimed = () => ({ kind: 'not_stated', wording: '', exactDate: '' });
const row = (id, action, extra = {}) => ({
  id, action, owners: ['Alex Green'], timing: untimed(),
  evidenceIds: ['T0001', 'T0002'], reviewFlagIds: [], ...extra
});
const unitsFor = (actions) => V.normaliseSourceUnits(actions.map((action, index) => ({
  id: `T${String(index + 1).padStart(4, '0')}`, sequence: index + 1,
  speaker: action.owners?.[0] || 'Alex Green', classification: 'keep',
  text: `I will ${action.action.charAt(0).toLowerCase()}${action.action.slice(1)}`
})));

test('evidence-enabled normalisation preserves review and sending on the same document', () => {
  const actions = [
    row('review', 'Review the quarterly inventory report for the central warehouse.'),
    row('send', 'Send the quarterly inventory report for the central warehouse.')
  ];
  const result = V.normaliseActions({ actions }, unitsFor(actions));
  assert.equal(result.length, 2);
  assert.match(result.find(action => action.id === 'review').action, /^Review /);
  assert.match(result.find(action => action.id === 'send').action, /^Send /);
  for (const action of result) {
    assert.deepEqual(action.owners, ['Alex Green']);
    assert.deepEqual(action.evidenceIds, ['T0001', 'T0002']);
  }
});

for (const [name, left, right] of [
  ['quantities', 'Order three replacement filters for the north storage room.', 'Order four replacement filters for the north storage room.'],
  ['conditions', 'Send the inventory report to Morgan if approval is granted.', 'Send the inventory report to Morgan if approval is refused.'],
  ['recipients', 'Send the quarterly inventory report for the central warehouse to Morgan.', 'Send the quarterly inventory report for the central warehouse to Casey.'],
  ['identifiers', 'Review inventory report INV-100 for the central warehouse.', 'Review inventory report INV-101 for the central warehouse.']
]) {
  test(`evidence-enabled normalisation retains different ${name}`, () => {
    const actions = [row('first', left), row('second', right)];
    const result = V.normaliseActions({ actions }, unitsFor(actions));
    assert.deepEqual(result.map(action => action.id), ['first', 'second']);
    assert.notEqual(result[0].action, result[1].action);
  });
}

test('normalisation retains separate owners and independent dated occurrences', () => {
  const action = 'Send the inventory report to Morgan Lee.';
  const actions = [
    row('alex-first', action, { timing: { kind: 'deadline', wording: '3 November 2026', exactDate: '2026-11-03' } }),
    row('alex-next', action, { timing: { kind: 'deadline', wording: '10 November 2026', exactDate: '2026-11-10' } }),
    row('casey-first', action, { owners: ['Casey Patel'], timing: { kind: 'deadline', wording: '3 November 2026', exactDate: '2026-11-03' } })
  ];
  const result = V.normaliseActions({ actions }, unitsFor(actions));
  assert.deepEqual(result.map(value => [value.id, value.owners, value.timing.exactDate]), [
    ['alex-first', ['Alex Green'], '2026-11-03'],
    ['alex-next', ['Alex Green'], '2026-11-10'],
    ['casey-first', ['Casey Patel'], '2026-11-03']
  ]);
});

for (const reversed of [false, true]) {
  test(`normalisation retains the complete compound and all evidence/flags (${reversed ? 'compound first' : 'clause first'})`, () => {
    const actions = [
      row('clause', 'Review the inventory report.', { reviewFlagIds: ['flag-review'] }),
      row('compound', 'Review the inventory report and send the receipt.', { reviewFlagIds: ['flag-send'] })
    ];
    if (reversed) actions.reverse();
    const before = structuredClone(actions);
    const result = V.normaliseActions({ actions }, unitsFor(actions));
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'compound');
    assert.equal(result[0].action, 'Review the inventory report and send the receipt.');
    assert.deepEqual(new Set(result[0].reviewFlagIds), new Set(['flag-review', 'flag-send']));
    assert.deepEqual(new Set(result[0].evidenceIds), new Set(['T0001', 'T0002']));
    assert.deepEqual(actions, before, 'candidate input is not mutated');
  });
}

test('normalisation keeps the dated exact duplicate as winner and does not truncate merged evidence', () => {
  const action = 'Review the inventory report.';
  const units = V.normaliseSourceUnits(Array.from({ length: 12 }, (_, index) => ({
    id: `T${String(index + 1).padStart(4, '0')}`, sequence: index + 1,
    speaker: 'Alex Green', text: 'I will review the inventory report.', classification: 'keep'
  })));
  const actions = [
    row('untimed', action, { evidenceIds: units.slice(0, 6).map(unit => unit.id), reviewFlagIds: ['first-flag'] }),
    row('dated', action, { evidenceIds: units.slice(6).map(unit => unit.id), reviewFlagIds: ['second-flag'],
      timing: { kind: 'deadline', wording: '3 November 2026', exactDate: '2026-11-03' } })
  ];
  const result = V.normaliseActions({ actions }, units);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'dated');
  assert.equal(result[0].timing.exactDate, '2026-11-03');
  assert.deepEqual(new Set(result[0].evidenceIds), new Set(units.map(unit => unit.id)));
  assert.deepEqual(new Set(result[0].reviewFlagIds), new Set(['first-flag', 'second-flag']));
});

test('reviewer-save normalisation preserves intentionally repeated rows', () => {
  const actions = [row('manual-one', 'Review the inventory report.', { reviewerAuthored: true }),
    row('manual-two', 'Review the inventory report.', { reviewerAuthored: true })];
  const result = V.normaliseActions({ actions }, unitsFor(actions), { preserveReviewerEdits: true, enforceEvidence: false });
  assert.deepEqual(result.map(action => [action.id, action.reviewerAuthored]), [['manual-one', true], ['manual-two', true]]);
});

test('shared citations and nouns do not prove two commitments equivalent', () => {
  for (const [left, right] of [
    ['Review the inventory report.', 'Send the inventory report.'],
    ['Order three replacement filters.', 'Order four replacement filters.'],
    ['Send the report if approval is granted.', 'Send the report if approval is refused.'],
    ['Send the inventory report.', 'Do not send the inventory report.'],
    ['Send the report to Morgan.', 'Send the report to Casey.'],
    ['Review report INV-100.', 'Review report INV-101.'],
    ['Review the inventory report.', 'Review the inventory report and send the receipt by Friday.']
  ]) {
    const actions = [row('left', left), row('right', right)];
    const result = V.mergeDuplicateCommitments(actions);
    assert.equal(result.merged, 0, `${left} / ${right}`);
    assert.deepEqual(result.actions, actions);
  }
});

test('commitment merging preserves owners, timing kinds and separate dates', () => {
  const action = 'Schedule the inventory review meeting.';
  const actions = [
    row('owned', action, { timing: { kind: 'target', wording: 'next week', exactDate: '' } }),
    row('ownerless', action, { owners: [], timing: { kind: 'target', wording: 'next week', exactDate: '' } }),
    row('deadline', action, { timing: { kind: 'deadline', wording: 'next week', exactDate: '' } }),
    row('different-day', action, { timing: { kind: 'deadline', wording: 'next week', exactDate: '2026-10-28' } })
  ];
  assert.deepEqual(V.mergeDuplicateCommitments(actions), { actions, merged: 0 });
});

test('commitment merging chooses the complete covering row and retains every citation and flag', () => {
  const firstIds = Array.from({ length: 7 }, (_, index) => `T${index + 1}`);
  const secondIds = Array.from({ length: 7 }, (_, index) => `T${index + 7}`);
  const part = row('part', 'Review the inventory report.', { evidenceIds: firstIds, reviewFlagIds: ['part-flag'] });
  const whole = row('whole', 'Review the inventory report and send the receipt.', { evidenceIds: secondIds, reviewFlagIds: ['whole-flag'] });
  for (const actions of [[part, whole], [whole, part]]) {
    const before = structuredClone(actions);
    const result = V.mergeDuplicateCommitments(actions);
    assert.equal(result.merged, 1);
    assert.equal(result.actions[0].id, 'whole');
    assert.equal(result.actions[0].action, whole.action);
    assert.deepEqual(new Set(result.actions[0].evidenceIds), new Set([...firstIds, ...secondIds]));
    assert.deepEqual(new Set(result.actions[0].reviewFlagIds), new Set(['part-flag', 'whole-flag']));
    assert.deepEqual(actions, before);
  }
});

test('commitment merging never collapses reviewer-authored repetitions', () => {
  for (const provenance of [{ reviewerAuthored: true }, { source: 'stage_3_human_confirmation' }]) {
    const actions = [row('manual-one', 'Review the inventory report.', provenance), row('manual-two', 'Review the inventory report.', provenance)];
    assert.deepEqual(V.mergeDuplicateCommitments(actions), { actions, merged: 0 });
  }
});

test('mutually covered editing variants keep the fuller wording and shared timing', () => {
  const timing = { kind: 'deadline', wording: '3 November 2026', exactDate: '2026-11-03' };
  const short = row('short', 'Update the inventory report.', { timing, reviewFlagIds: ['short-flag'] });
  const fuller = row('fuller', 'Review and update the inventory report.', { timing, reviewFlagIds: ['fuller-flag'] });
  for (const actions of [[short, fuller], [fuller, short]]) {
    const result = V.mergeDuplicateCommitments(actions);
    assert.equal(result.merged, 1);
    assert.equal(result.actions[0].action, fuller.action);
    assert.deepEqual(result.actions[0].timing, timing);
    assert.deepEqual(new Set(result.actions[0].reviewFlagIds), new Set(['short-flag', 'fuller-flag']));
    const normalised = V.normaliseActions({ actions }, unitsFor(actions));
    assert.equal(normalised.length, 1);
    assert.equal(normalised[0].action, fuller.action);
    assert.deepEqual(normalised[0].timing, timing);
  }
});

const fact = 'Morgan confirmed supplier approval remains the launch blocker.';
const detail = (id, value = fact, extra = {}) => ({ id, text: value, evidenceIds: ['T0010', 'T0011'], reviewFlagIds: [`flag-${id}`], ...extra });
const topic = (id, details, extra = {}) => ({
  id, topic: 'Delivery planning', points: [{ id: `parent-${id}`, text: 'Packaging artwork is ready.', evidenceIds: ['T0001'], supportingDetails: details }],
  decisions: [], openQuestions: [], ...extra
});

test('one invocation promotes an identical same-evidence generated fact only once across topics', () => {
  const first = detail('first');
  const later = detail('later', fact, { evidenceIds: ['T0011', 'T0010'], reviewFlagIds: ['late-flag'] });
  const discussion = [topic('one', [first]), topic('two', [later])];
  const before = structuredClone(discussion);
  const result = V.promoteNamedFactDetails(discussion, [], ['Morgan Lee']);
  assert.equal(result.promoted, 1);
  const visible = result.discussion.flatMap(value => value.points);
  assert.equal(visible.filter(value => value.text === fact).length, 1);
  assert.deepEqual(result.discussion[1].points[0].supportingDetails, [later], 'later evidence, flags and detail stay recoverable');
  assert.deepEqual(discussion, before);
});

test('promotion does not confuse approval with testing or different evidence identities', () => {
  const approval = detail('approval');
  const testing = detail('testing', 'Morgan confirmed supplier testing remains the launch blocker.');
  const differentEvidence = detail('other-evidence', fact, { evidenceIds: ['T0020'] });
  const result = V.promoteNamedFactDetails([topic('one', [approval, testing, differentEvidence])], [], ['Morgan Lee']);
  assert.equal(result.promoted, 3);
  assert.deepEqual(result.discussion[0].points.slice(1).map(value => value.id), ['approval', 'testing', 'other-evidence']);
});

test('promotion identity uses the full source text, not its shortened visible value', () => {
  const prefix = 'Morgan confirmed ' + 'the delivery documentation remains under assessment '.repeat(17);
  const result = V.promoteNamedFactDetails([topic('one', [detail('first', `${prefix}for approval.`), detail('second', `${prefix}for testing.`)])], [], ['Morgan Lee']);
  assert.equal(result.promoted, 2, 'different full facts are not declared identical because the existing display limit clips their suffixes');
});

test('promotion leaves reviewer-authored topics, parents and details untouched', () => {
  const manualTopic = topic('manual-topic', [detail('topic-detail')], { reviewerAuthored: true });
  const manualParent = topic('manual-parent', [detail('parent-detail')]);
  manualParent.points[0].source = 'stage_2_human_confirmation';
  const manualDetail = topic('manual-detail', [detail('detail', fact, { reviewerAuthored: true })]);
  const discussion = [manualTopic, manualParent, manualDetail];
  const result = V.promoteNamedFactDetails(discussion, [], ['Morgan Lee']);
  assert.equal(result.promoted, 0);
  assert.deepEqual(result.discussion, discussion);
});
