'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildProposal, applyProposal } = require('../utils/meetingMinutesProposals');

test('proposal changes can be partially accepted without altering unselected records', () => {
  const before = [{ id: 'a', action: 'First' }, { id: 'b', action: 'Second' }];
  const after = [{ id: 'a', action: 'First revised' }, { id: 'b', action: 'Second' }, { id: 'c', action: 'Third' }];
  const proposal = buildProposal('actions', before, after);
  const addition = proposal.changes.find((change) => change.type === 'add');
  const accepted = applyProposal(before, proposal, [addition.id]);
  // New admissions carry occurrence metadata; every visible/provenance field
  // and every untouched existing row must still match the selected subset.
  const content = ({ id: _id, occurrenceId: _occurrenceId, ...row }) => row;
  assert.deepEqual(accepted.map(content), [...before, after[2]].map(content));
  assert.deepEqual(accepted.slice(0, before.length), before);
  assert.equal(accepted[2].id, after[2].id);
  assert.match(accepted[2].occurrenceId, /^action-occurrence-/);
  assert.equal(new Set(accepted.map(row => row.id)).size, accepted.length);
  assert.deepEqual(applyProposal(accepted, proposal, [addition.id]), accepted);
});

test('an inserted row is one change, and any subset of changes applies correctly', () => {
  const first = { id: 'a', action: 'Re-issue the alarm verification report.' };
  const second = { id: 'b', action: 'Chase the vendor for the translation files.' };
  const inserted = { id: 'x', action: 'Book the notified body audit slot.' };
  const edited = { id: 'b', action: 'Chase the vendor for the Polish translation files.' };

  const assertAccepted = (actual, expected) => {
    const content = ({ id: _id, occurrenceId: _occurrenceId, ...row }) => row;
    assert.deepEqual(actual.map(content), expected.map(content));
    assert.deepEqual(actual.map(row => row.id), expected.map(row => row.id));
    assert.equal(new Set(actual.map(row => row.id)).size, actual.length);
    expected.forEach((row, index) => {
      if (row === inserted) assert.match(actual[index].occurrenceId, /^action-occurrence-/);
      else assert.deepEqual(actual[index], row);
    });
    return actual;
  };
  // a pure insertion must not read as "edit every row after it"
  const insertion = buildProposal('actions', [first, second], [first, inserted, second]);
  assert.equal(insertion.changes.length, 1);
  assert.equal(insertion.changes[0].type, 'add');
  const insertedOnce = assertAccepted(applyProposal([first, second], insertion, [insertion.changes[0].id]), [first, inserted, second]);
  assert.deepEqual(applyProposal(insertedOnce, insertion, [insertion.changes[0].id]), insertedOnce);
  assert.deepEqual(applyProposal([first, second], insertion, []), [first, second]);

  // an insertion alongside an edit: each is independently acceptable
  const mixed = buildProposal('actions', [first, second], [first, inserted, edited]);
  const add = mixed.changes.find((change) => change.type === 'add');
  const modify = mixed.changes.find((change) => change.type === 'modify');
  assert.ok(add && modify);
  assertAccepted(applyProposal([first, second], mixed, [add.id]), [first, inserted, second]);
  assert.deepEqual(applyProposal([first, second], mixed, [modify.id]), [first, edited]);
  assertAccepted(applyProposal([first, second], mixed, [add.id, modify.id]), [first, inserted, edited]);

  // a removal, accepted and rejected
  const removal = buildProposal('actions', [first, inserted, second], [first, second]);
  assert.equal(removal.changes.length, 1);
  assert.equal(removal.changes[0].type, 'remove');
  assert.deepEqual(applyProposal([first, inserted, second], removal, [removal.changes[0].id]), [first, second]);
  assert.deepEqual(applyProposal([first, inserted, second], removal, []), [first, inserted, second]);

  // a proposal persisted before beforeIndex existed still applies
  const legacy = { stage: 'actions', changes: [{ id: 'L1', type: 'add', before: null, after: inserted, index: 2 }] };
  assertAccepted(applyProposal([first, second], legacy, ['L1']), [first, second, inserted]);
});

test('a stale proposal target can never remove or modify the row now occupying its old index', () => {
  const clock = { id: 'clock', action: 'Check the real-time clock mitigation.' };
  const cybersecurity = { id: 'cyber', action: 'Document the cybersecurity risks.' };
  const stale = { id: 'old-risk', action: 'Remove an obsolete risk action.' };
  const proposal = { stage: 'actions', changes: [
    { id: 'remove-stale', type: 'remove', before: stale, after: null, beforeIndex: 0, index: 0 },
    { id: 'modify-stale', type: 'modify', before: stale, after: { ...stale, action: 'Changed.' }, beforeIndex: 1, index: 1 }
  ] };
  assert.deepEqual(
    applyProposal([clock, cybersecurity], proposal, ['remove-stale', 'modify-stale']),
    [clock, cybersecurity]
  );
});

test('a stale removal cannot consume the surviving row when generated action IDs were duplicated', () => {
  const surviving = { id: 'A10', action: 'Send the code of conduct today.' };
  const duplicate = { id: 'A10', action: 'Send the code of conduct today.' };
  const revised = { ...surviving, action: 'Send the code of conduct to Niamh today.' };
  const proposal = { changes: [
    { id: 'modify-survivor', type: 'modify', before: surviving, after: revised, beforeIndex: 0, index: 0 },
    { id: 'remove-old-duplicate', type: 'remove', before: duplicate, after: null, beforeIndex: 3, index: 3 }
  ] };

  assert.deepEqual(
    applyProposal([surviving], proposal, ['modify-survivor', 'remove-old-duplicate']),
    [revised]
  );
});
