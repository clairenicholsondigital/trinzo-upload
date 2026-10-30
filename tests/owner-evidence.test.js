'use strict';

// Generic cases only: none of these sentences come from the evaluation corpus.
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');
const { createMeetingMinutesPeopleEvidence } = require('../utils/meetingMinutesPeopleEvidence');
const { applyRequesterOwnerRule, ownerAssignedInMeeting } = createMeetingMinutesPeopleEvidence({
  evidenceContextFor: V.evidenceContextFor,
  actionEvidenceDisposition: V.actionEvidenceDisposition
});
const { reconcileRecordFlags } = require('../utils/meetingMinutesReviewFlags');
const { normaliseSourceUnits } = V;

const unit = (id, speaker, text) => ({ id, speaker, text, classification: 'keep' });

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

test("a rival's commitment that hands the next step to the owner is not counter-evidence", () => {
  const units = normaliseSourceUnits([
    unit('T0001', 'Priya', "I'll put the supplier risks into the risk register and circulate it with you, Tom, to review first."),
    unit('T0002', 'Tom', 'Yeah.')
  ]);
  const action = { id: 'a1', action: "Review Priya's supplier risk register before it goes wider.", owners: ['Tom'], evidenceIds: ['T0001', 'T0002'], reviewFlagIds: [] };
  const result = applyRequesterOwnerRule([action], units);
  assert.ok(!result.flags.some((flag) => /Owner changed/.test(flag.message)), JSON.stringify(result.flags));
});
