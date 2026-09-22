'use strict';

// Generic cases only: none of these sentences come from the evaluation corpus.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyRequesterOwnerRule,
  assignsWorkTo,
  ownerAssignedInMeeting,
  addressedRequestAccepted,
  reconcileRecordFlags,
  normaliseSourceUnits
} = require('../utils/meetingMinutesAgentV2');

const unit = (id, speaker, text) => ({ id, speaker, text, classification: 'keep' });

test('read-back, possessive and ongoing forms count as assigning work', () => {
  assert.ok(assignsWorkTo('Robin', 'Priya drafts the agenda, Robin sends it, and we meet again next week.'));
  assert.ok(assignsWorkTo('Robin', "Updating the supplier list is Robin's priority action this week."));
  assert.ok(assignsWorkTo('Robin', 'Robin has been working through the supplier contracts.'));
  assert.ok(!assignsWorkTo('Robin', 'Robin mentioned the contracts were late last year.'));
});

test('an addressed request answered without refusal is an accepted request', () => {
  const lines = [
    { speaker: 'Chair', text: 'Sam, on those two points, is that something you can write up for the board?' },
    { speaker: 'Sam', text: "It'll be Thursday though, I'm travelling until then." }
  ];
  assert.ok(addressedRequestAccepted('Sam', lines));
  assert.ok(!addressedRequestAccepted('Sam', [lines[0], { speaker: 'Sam', text: "No, I can't take that on this month." }]));
});

test('a recap elsewhere in the meeting keeps an owner the cited lines do not name', () => {
  const units = normaliseSourceUnits([
    unit('T0001', 'Chair', 'The vendor contracts need reconciling against the invoices before the audit.'),
    unit('T0002', 'Chair', 'That means matching each vendor contract to its invoice and noting the gaps.'),
    unit('T0003', 'Alex', 'Okay.'),
    unit('T0004', 'Chair', 'Unrelated item: the office move is on track.'),
    unit('T0005', 'Chair', 'Robin has been working through reconciling the vendor contracts and invoices, so that is his priority action this week.')
  ]);
  const action = { id: 'a1', action: 'Reconcile the vendor contracts against the invoices.', owners: ['Robin'], evidenceIds: ['T0001', 'T0002'], reviewFlagIds: [] };
  assert.ok(ownerAssignedInMeeting('Robin', action.action, units));
  const result = applyRequesterOwnerRule([action], units);
  assert.deepEqual(result.actions[0].owners, ['Robin']);
  assert.equal(result.flags.length, 0);
});

test('with no evidence either way the owner is kept and flagged, not deleted', () => {
  const units = normaliseSourceUnits([
    unit('T0001', 'Chair', 'The venue floor plan still needs sending to the landlord.'),
    unit('T0002', 'Alex', 'Right, that has been sitting for a while.')
  ]);
  const action = { id: 'a1', action: 'Send the venue floor plan to the landlord.', owners: ['Sam'], evidenceIds: ['T0001'], reviewFlagIds: [] };
  const result = applyRequesterOwnerRule([action], units);
  assert.deepEqual(result.actions[0].owners, ['Sam']);
  assert.match(result.flags[0].message, /^Owner to confirm/);
});

test('a named owner who only asked someone else to do it is removed', () => {
  const units = normaliseSourceUnits([
    unit('T0001', 'Chair', 'Alex, could you mention the parking change to the landlord when you see him?'),
    unit('T0002', 'Alex', "Yes, I'll mention the parking change to the landlord on Monday.")
  ]);
  const action = { id: 'a1', action: 'Mention the parking change to the landlord.', owners: ['Chair'], evidenceIds: ['T0001', 'T0002'], reviewFlagIds: [] };
  const result = applyRequesterOwnerRule([action], units);
  assert.deepEqual(result.actions[0].owners, []);
  assert.match(result.flags[0].message, /Alex taking this on|only asked others/);
});

test('a removal warning is cleared when a later merge puts that owner back', () => {
  const flag = {
    id: 'flag-owner-1', kind: 'ownership', status: 'open', evidenceIds: [], correctionNote: '',
    message: 'Owner changed for review: the transcript shows Alex taking this on, not Sam. Confirm the owner.'
  };
  const state = reconcileRecordFlags({ actions: [{ id: 'a1', action: 'Send the floor plan.', owners: ['Sam'], reviewFlagIds: ['flag-owner-1'] }] }, [flag]);
  assert.deepEqual(state.content.actions[0].reviewFlagIds, []);
  assert.equal(state.flags.length, 0);
});

test("a chair reading an action back to someone is not a rival owner", () => {
  const units = normaliseSourceUnits([
    unit('T0001', 'Sam', 'I have been looking at supplier options for the backup generator.'),
    unit('T0002', 'Chair', "And Sam, then you're just going to update the generator supplier shortlist once the quotes are in."),
    unit('T0003', 'Chair', "I'll send round the minutes this afternoon.")
  ]);
  const action = { id: 'a1', action: 'Update the generator supplier shortlist once the quotes are in.', owners: ['Sam'], evidenceIds: ['T0002'], reviewFlagIds: [] };
  const result = applyRequesterOwnerRule([action], units);
  assert.deepEqual(result.actions[0].owners, ['Sam']);
  assert.ok(!result.flags.some((flag) => /Owner changed/.test(flag.message)));
});

test('a declarative assignment to someone who is only talked about keeps them as owner', () => {
  assert.ok(assignsWorkTo('Priya', "So Priya, and I think Tom, you're involved in that review as well next week."));
});
