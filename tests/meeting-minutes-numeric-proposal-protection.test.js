'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const MinutesProposalSelection = require('../utils/meetingMinutesProposalSelection');
const MinutesProposalReview = require('../utils/meetingMinutesProposalReview');
const MinutesProposals = require('../utils/meetingMinutesProposals');
const row = action => ({ id: 'action-1', occurrenceId: 'occ-action-1', action, owners: ['Morgan Lee'],
  timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0001'], reviewFlagIds: [] });
function fixture(beforeText, afterText) {
  const before = row(beforeText); const after = { ...before, action: afterText };
  return { current: [before], units: [{ id: 'T0001', speaker: 'Morgan Lee', text: beforeText }],
    proposal: { id: 'proposal', stage: 'actions', changes: [{ id: 'edit', type: 'modify', selected: true,
      index: 0, before: structuredClone(before), after }] } };
}

for (const [before, after] of [
  ['Order 12 replacement cartridges.', 'Order replacement cartridges.'],
  ['Order two replacement cartridges.', 'Order replacement cartridges.'],
  ['Send 5.2 mL of reagent.', 'Send 5 mL of reagent.'],
  ['Send 5 mL of reagent.', 'Send 5 ML of reagent.'],
  ['Order at least 12 cartridges.', 'Order 12 cartridges.'],
  ['Order 2 to 5 cartridges.', 'Order 2 and 5 cartridges.'],
  ['Review the SOP-12 procedure.', 'Review the SOP-13 procedure.'],
  ['Order replacement cartridges for £12.', 'Order replacement cartridges for $12.'],
]) test(`fresh and previously-selected numerical loss is deferred: ${before}`, () => {
  const { current, units, proposal } = fixture(before, after);
  const original = structuredClone({ current, units, proposal });
  const selected = MinutesProposalSelection.preselectActionProposal(proposal, current, units);
  assert.equal(selected.changes[0].selected, false);
  assert.match(selected.changes[0].reviewContext.reason, /removes or changes/);
  // Serialized selections from drafts saved before the fix get the same gate.
  const saved = JSON.parse(JSON.stringify(proposal));
  const review = MinutesProposalReview.automaticMeetingAgentProposalReview(saved, [], current, units);
  assert.deepEqual(review.acceptedIds, []);
  assert.ok(review.reviewFlags.some(flag => flag.status === 'open' && /not applied/i.test(flag.message)));
  assert.deepEqual(MinutesProposals.applyProposal(current, saved, review.acceptedIds), current);
  assert.deepEqual({ current, units, proposal }, original);
  // A human can deliberately accept the exact suggested revision.
  const manual = MinutesProposals.applyProposal(current, proposal, ['edit']);
  assert.equal(manual[0].action, after);
  assert.equal(manual[0].occurrenceId, current[0].occurrenceId);
});

for (const [before, after] of [
  ['Order twelve replacement cartridges.', 'Buy 12 replacement cartridges.'],
  ['Order two replacement cartridges.', 'Buy 2 replacement cartridges.'],
  ['Send .5 mL of reagent.', 'Provide 0.50 millilitres of reagent.'],
  ['Order replacement cartridges for twelve pounds.', 'Order replacement cartridges for £12.'],
  ['Order at least 12 cartridges.', 'Buy ≥12 cartridges.'],
  ['Order between 2 and 5 cartridges.', 'Buy 2–5 cartridges.'],
]) test(`harmless equivalent numbers remain automatically eligible: ${before}`, () => {
  const { current, units, proposal } = fixture(before, after);
  const selected = MinutesProposalSelection.preselectActionProposal(proposal, current, units);
  assert.equal(selected.changes[0].selected, true);
  const review = MinutesProposalReview.automaticMeetingAgentProposalReview(proposal, [], current, units);
  assert.deepEqual(review.acceptedIds, ['edit']);
  assert.equal(MinutesProposals.applyProposal(current, proposal, review.acceptedIds)[0].action, after);
});
