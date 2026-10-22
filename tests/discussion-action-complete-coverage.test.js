'use strict';

// Generic safety cases: overlap in one assignment is not proof that a whole
// discussion record and its supporting tree are represented in Actions.
const test = require('node:test');
const assert = require('node:assert/strict');
const { removeDiscussionActionDuplicates } = require('../utils/discussionShape');

const people = ['Alex Morgan', 'Jamie Patel'];
const point = (extra = {}) => ({
  id: 'register-point', text: 'Alex Morgan will send the equipment register to the safety officer.',
  evidenceIds: ['T0100'], supportingDetails: [], ...extra
});
const action = (extra = {}) => ({
  id: 'register-action', action: 'Send the equipment register to the safety officer.',
  owners: ['Alex Morgan'], evidenceIds: ['T0100'], ...extra
});
const topic = record => ({ id: 'register-topic', topic: 'Equipment register',
  points: [record], decisions: [], openQuestions: [] });
const run = (record, actions = [action()]) => removeDiscussionActionDuplicates([topic(record)], actions, people);
const assertRetained = (record, actions) => {
  const result = run(record, actions);
  assert.deepEqual(result.discussion, [topic(record)]);
  assert.equal(result.discussion[0].points[0], record, 'retain the original record without rewriting');
  assert.deepEqual(result.dropped, []);
};

test('a shared assignment cannot erase additional clauses, constraints, rationale or amount qualifiers', () => {
  const cases = [
    [point({ text: 'Alex Morgan will send the equipment register to the safety officer; the supplier retains liability for omissions.' }), action()],
    [point({ text: 'Alex Morgan will send the equipment register to the safety officer and document unresolved exceptions.' }), action()],
    [point({ text: 'Alex Morgan will send the equipment register to the safety officer because the inspection depends on complete serial numbers.' }), action()],
    [point({ text: 'Alex Morgan will send the equipment register to the safety officer only with written authorisation.' }), action()],
    [point({ text: 'Alex Morgan will order at least 30 replacement labels.' }), action({ action: 'Order 30 replacement labels.' })],
    [point({ text: 'Alex Morgan will approve a fee of up to £60 for replacement labels.' }), action({ action: 'Approve a fee of £60 for replacement labels.' })],
    [point({ text: 'Alex Morgan will move the equipment register from warehouse North to warehouse South.' }), action({ action: 'Move the equipment register from warehouse South to warehouse North.' })],
    [point({ text: 'Alex Morgan will set the instrument output to 10 mW.' }), action({ action: 'Set the instrument output to 10 MW.' })],
    [point({ text: 'Alex Morgan will send the equipment register to the safety officer ideally on Friday.' }), action({ action: 'Send the equipment register to the safety officer on Friday.' })],
    [point(), action({ action: 'Send the equipment register to the safety officer and delete the original.' })]
  ];
  for (const [record, accepted] of cases) assertRetained(record, [accepted]);
});

test('whole-parent removal requires matching ownership, exact source identity and structured timing', () => {
  const timing = { kind: 'deadline', wording: 'by Friday', exactDate: '2026-11-06' };
  const timed = point({ text: 'Alex Morgan will send the equipment register to the safety officer by Friday.', timing });
  const cases = [
    [point(), action({ owners: [] })],
    [point(), action({ owners: ['Jamie Patel'] })],
    [point(), action({ owners: ['Alex Morgan', 'Jamie Patel'] })],
    [point({ owners: ['Jamie Patel'] }), action()],
    [point(), action({ evidenceIds: ['T0101'] })],
    [point(), action({ evidenceIds: [] })],
    [point({ evidenceIds: [] }), action()],
    [timed, action({ action: 'Send the equipment register to the safety officer by Friday.', timing: { ...timing, kind: 'target' } })],
    [timed, action({ action: 'Send the equipment register to the safety officer by Friday.', timing: { ...timing, exactDate: '2026-11-13' } })],
    [point(), action({ timing: { kind: 'deadline', wording: 'by Friday', exactDate: '' } })]
  ];
  for (const [record, accepted] of cases) assertRetained(record, [accepted]);
});

test('every meaningful untimed child and descendant needs its own complete representation', () => {
  const fact = { id: 'serial-format', text: 'The register uses the supplier serial format.', evidenceIds: ['T0102'] };
  const task = { id: 'archive', text: 'Alex Morgan will archive the signed equipment register.', evidenceIds: ['T0102'] };
  const archived = action({ id: 'archive-action', action: 'Archive the signed equipment register.', evidenceIds: ['T0102'] });
  const inspect = { id: 'inspect', text: 'Jamie Patel will inspect the register exclusions.', evidenceIds: ['T0103'] };
  const inspected = action({ id: 'inspect-action', action: 'Inspect the register exclusions.', owners: ['Jamie Patel'], evidenceIds: ['T0103'] });
  assertRetained(point({ supportingDetails: [fact] }));
  assertRetained(point({ supportingDetails: [task, fact] }), [action(), archived]);
  assertRetained(point({ supportingDetails: [{ ...task, supportingDetails: [inspect] }] }), [action(), archived]);
  assertRetained(point({ supportingDetails: [{
    id: 'empty-container', text: '', supportingDetails: [fact]
  }] }));
  assertRetained(point({ supportingDetails: [{
    id: 'raw-container', text: 'So, you know, send it.', supportingDetails: [fact]
  }] }));
  assert.equal(run(point({ supportingDetails: [{ ...task, supportingDetails: [inspect] }] }),
    [action(), archived, inspected]).discussion.length, 0, 'all descendants have bounded literal coverage');
});

test('untimed child coverage rejects missing owners, nearby citations and different instructions', () => {
  const child = { id: 'archive', text: 'Alex Morgan will archive the signed equipment register.', evidenceIds: ['T0102'] };
  const archived = action({ id: 'archive-action', action: 'Archive the signed equipment register.', evidenceIds: ['T0102'] });
  for (const [detail, accepted] of [
    [{ ...child, text: 'Archive the signed equipment register.' }, archived],
    [child, { ...archived, owners: ['Jamie Patel'] }],
    [child, { ...archived, evidenceIds: ['T0103'] }],
    [child, { ...archived, action: 'Review the signed equipment register.' }],
    [{ ...child, text: 'Alex Morgan will archive the signed equipment register only with approval.' }, archived]
  ]) assertRetained(point({ supportingDetails: [detail] }), [action(), accepted]);
});

test('structured timing without child prose still prevents an unproven deletion', () => {
  assertRetained(point({ supportingDetails: [{
    id: 'timing-only', text: '', evidenceIds: ['T0102'],
    timing: { kind: 'deadline', wording: 'by Friday', exactDate: '' }
  }] }));
});

test('exact owner-prefixed parent and untimed child duplicates still leave discussion', () => {
  for (const prefix of ['Alex Morgan will', 'Alex Morgan shall', 'Alex Morgan is to', 'Alex will']) {
    const record = point({ text: `${prefix} send the equipment register to the safety officer.` });
    assert.deepEqual(run(record).dropped.map(item => item.pointId), [record.id]);
  }
  const detail = { id: 'archive', text: 'Archive the signed equipment register.', owners: ['Alex Morgan'], evidenceIds: ['T0102'] };
  const result = run(point({ supportingDetails: [detail] }), [
    action(), action({ id: 'archive-action', action: detail.text, evidenceIds: ['T0102'] })
  ]);
  assert.equal(result.discussion.length, 0);
});

test('an earlier partial action cannot hide a later complete exact parent duplicate', () => {
  const record = point({ text: 'Alex Morgan will send the equipment register to the safety officer this week.' });
  const partial = action({ id: 'next-week', action: 'Send the equipment register to the safety officer next week.' });
  const exact = action({ id: 'this-week', action: 'Send the equipment register to the safety officer this week.' });
  const result = run(record, [partial, exact]);
  assert.equal(result.discussion.length, 0);
  assert.deepEqual(result.dropped.map(item => item.actionId), ['this-week']);
  assertRetained(record, [partial, action({ id: 'incomplete' })]);
});

test('exact parent wording can retain identical timing separately in the accepted action', () => {
  const timing = { kind: 'deadline', wording: 'by Friday', exactDate: '2026-11-06' };
  const record = point({ text: 'Alex Morgan will send the equipment register to the safety officer by Friday.', timing });
  const result = run(record, [action({ timing })]);
  assert.equal(result.discussion.length, 0);
});

test('both preservation and exact deletion leave frozen inputs and supporting metadata unchanged', () => {
  const freeze = value => {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  };
  const record = point({ supportingDetails: [{
    id: 'price', text: 'The register replacement costs £14.50.', evidenceIds: ['T0102'],
    reviewFlagIds: ['cost-review'], provenance: { source: 'model', position: 7 }
  }] });
  const input = freeze([topic(record)]), accepted = freeze([action()]);
  const before = structuredClone({ input, accepted });
  const result = removeDiscussionActionDuplicates(input, accepted, people);
  assert.equal(result.discussion[0].points[0], record);
  assert.deepEqual({ input, accepted }, before);
  const duplicate = freeze([topic(point())]);
  assert.equal(removeDiscussionActionDuplicates(duplicate, accepted, people).discussion.length, 0);
  assert.equal(duplicate[0].points.length, 1);
});
