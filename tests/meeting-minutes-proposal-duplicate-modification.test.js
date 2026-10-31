'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const MinutesProposalSelection = require('../utils/meetingMinutesProposalSelection');
const MinutesProposalReview = require('../utils/meetingMinutesProposalReview');
const MinutesProposals = require('../utils/meetingMinutesProposals');

const row = (id, action, extra = {}) => ({ id, occurrenceId: `occ-${id}`, action, owners: ['Morgan'],
  timing: { kind: 'target', wording: 'this week', exactDate: '' }, evidenceIds: ['T0001'], reviewFlagIds: [], ...extra });
const units = [{ id: 'T0001', speaker: 'Morgan', text: 'I will book the caterer for the launch this week.' }];
function fixture(other = {}) {
  const before = row('target', 'Book the caterer for the launch.');
  const after = { ...before, action: 'Book the launch caterer.' };
  const sibling = row('sibling', after.action, other);
  return { current: [before, sibling], proposal: { id: 'proposal', stage: 'actions', changes: [
    { id: 'edit', type: 'modify', selected: true, index: 0, before: structuredClone(before), after }
  ] } };
}

test('generated modifications that copy another current occurrence start unticked', () => {
  const { current, proposal } = fixture();
  const original = structuredClone({ current, proposal });
  const [change] = MinutesProposalSelection.preselectActionProposal(proposal, current, units).changes;
  assert.equal(change.selected, false);
  assert.equal(change.reviewContext.label, 'already in the list');
  assert.deepEqual({ current, proposal }, original);
});

test('automatic adoption of an older selected duplicate modification preserves both rows and exposes the check', () => {
  const { current, proposal } = fixture();
  const review = MinutesProposalReview.automaticMeetingAgentProposalReview(proposal, [], current);
  assert.deepEqual(review.acceptedIds, []);
  assert.deepEqual(MinutesProposals.applyProposal(current, proposal, review.acceptedIds), current);
  assert.ok(review.reviewFlags.some(flag => flag.status === 'open' && /not applied/.test(flag.message)));
});

test('the target does not count as its own sibling and different owners or timing remain separate', () => {
  for (const other of [{ owners: ['Jordan'] }, { timing: { kind: 'target', wording: 'next week', exactDate: '' } }]) {
    const { current, proposal } = fixture(other);
    assert.equal(MinutesProposalSelection.preselectActionProposal(proposal, current, units).changes[0].selected, true);
    assert.deepEqual(MinutesProposalReview.automaticMeetingAgentProposalReview(proposal, [], current).acceptedIds, ['edit']);
  }
  const { current, proposal } = fixture();
  assert.deepEqual(MinutesProposalReview.automaticMeetingAgentProposalReview(proposal, [], current.slice(0, 1)).acceptedIds, ['edit']);
});

test('explicit reviewer selection still applies the exact requested modification with occurrence state intact', () => {
  const { current, proposal } = fixture();
  const result = MinutesProposals.applyProposal(current, proposal, ['edit']);
  assert.equal(result.length, 2);
  assert.equal(result[0].action, proposal.changes[0].after.action);
  assert.equal(result[0].occurrenceId, current[0].occurrenceId);
  assert.deepEqual(result[1], current[1]);
});
