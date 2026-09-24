'use strict';

// Generic cases only: none of these rows come from the evaluation corpus.
const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../routes/api');
const {
  preselectActionProposal,
  preselectDiscussionProposal,
  preselectRequestedProposal
} = api.stagedEvaluation;

const units = [
  { id: 'T0001', sequence: 1, speaker: 'Chair', text: 'Sam, can you send the revised floor plan to the landlord?', classification: 'keep' },
  { id: 'T0002', sequence: 2, speaker: 'Sam', text: "Yes, I'll send the revised floor plan to the landlord by Friday.", classification: 'keep' },
  { id: 'T0003', sequence: 3, speaker: 'Robin', text: "I'll book the caterer for the launch this week.", classification: 'keep' },
  { id: 'T0004', sequence: 4, speaker: 'Alex', text: 'Someone could maybe look at parking at some point.', classification: 'keep' }
];

const floorPlan = {
  id: 'a1', action: 'Send the revised floor plan to the landlord.', owners: ['Sam'],
  timing: { kind: 'deadline', wording: 'by Friday', exactDate: '2026-10-02' }, evidenceIds: ['T0001', 'T0002'], reviewFlagIds: []
};
const caterer = {
  id: 'a2', action: 'Book the caterer for the launch.', owners: ['Robin'],
  timing: { kind: 'target', wording: 'this week', exactDate: '' }, evidenceIds: ['T0003'], reviewFlagIds: []
};

const byType = (proposal, type) => proposal.changes.filter((change) => change.type === type);

test('a removal that only comes from two generated lists differing starts unticked, with a reason', () => {
  const proposal = { stage: 'actions', changes: [{ id: 'c1', type: 'remove', before: caterer, after: null }] };
  const [change] = preselectActionProposal(proposal, [floorPlan, caterer], units).changes;
  assert.equal(change.selected, false);
  assert.match(change.reviewContext.reason, /stays unless you tick/i);
});

test('a removal of a genuine duplicate starts ticked and names the survivor', () => {
  const duplicate = { ...floorPlan, id: 'a3', action: 'Send the landlord the revised floor plan.' };
  const proposal = { stage: 'actions', changes: [{ id: 'c1', type: 'remove', before: duplicate, after: null }] };
  const [change] = preselectActionProposal(proposal, [floorPlan, duplicate, caterer], units).changes;
  assert.equal(change.selected, true);
  assert.match(change.reviewContext.reason, /Duplicates "Send the revised floor plan/);
});

test('an edit that drops an owner or a date starts unticked; a rewording starts ticked', () => {
  const proposal = {
    stage: 'actions',
    changes: [
      { id: 'owner', type: 'modify', before: floorPlan, after: { ...floorPlan, owners: [] } },
      { id: 'date', type: 'modify', before: floorPlan, after: { ...floorPlan, timing: { kind: 'not_stated', wording: '', exactDate: '' } } },
      { id: 'reword', type: 'modify', before: caterer, after: { ...caterer, action: 'Book the launch caterer.' } }
    ]
  };
  const result = preselectActionProposal(proposal, [floorPlan, caterer], units).changes;
  assert.deepEqual(result.map((change) => [change.id, change.selected]), [['owner', false], ['date', false], ['reword', true]]);
  assert.match(result[0].reviewContext.reason, /removes an owner/);
  assert.match(result[1].reviewContext.reason, /removes the timing/);
});

// Changed deliberately on 24 Sep: additions used to start ticked when they
// were owned and clearly committed. They no longer start ticked at all. The
// rows that reached that branch were the plausible-looking ones a reviewer
// waves through, and applying an action by default is how DITA's duplicate
// Cody follow-up reached the register. Adding work is now always a decision.
test('an addition is always offered unticked, with the reason it was offered', () => {
  const proposal = {
    stage: 'actions',
    changes: [
      { id: 'owned', type: 'add', before: null, after: caterer },
      { id: 'unowned', type: 'add', before: null, after: { id: 'a4', action: 'Review parking options.', owners: [], evidenceIds: ['T0004'], timing: { kind: 'not_stated' } } },
      { id: 'floated', type: 'add', before: null, after: { id: 'a5', action: 'Review parking options.', owners: ['Alex'], evidenceIds: ['T0004'], timing: { kind: 'not_stated' } } }
    ]
  };
  const result = preselectActionProposal(proposal, [floorPlan], units).changes;
  assert.deepEqual(result.map((change) => [change.id, change.selected]), [['owned', false], ['unowned', false], ['floated', false]]);
  // Unticked is not the same as unexplained: each row says why it is offered,
  // so the reviewer can tell a strong suggestion from a doubtful one at a glance.
  assert.match(result[0].reviewContext.reason, /clear, owned commitment/);
  assert.equal(result[0].reviewContext.label, 'ready to add');
  assert.match(result[1].reviewContext.reason, /Nobody is shown taking this on/);
  assert.ok(result[2].reviewContext.reason, 'a doubtful addition still carries its reason');
  assert.notEqual(result[0].reviewContext.label, result[1].reviewContext.label);
});

test('an explicit untick from an earlier check is never re-ticked', () => {
  const proposal = { stage: 'actions', changes: [{ id: 'aside', type: 'add', before: null, after: caterer, selected: false }] };
  assert.equal(preselectActionProposal(proposal, [], units).changes[0].selected, false);
});

test('discussion removals start unticked; a reviewer-requested edit starts ticked', () => {
  const discussion = preselectDiscussionProposal({ stage: 'discussion', changes: [
    { id: 'r', type: 'remove', before: { text: 'Budget reviewed.' }, after: null },
    { id: 'a', type: 'add', before: null, after: { text: 'Launch moved to spring.' } }
  ] });
  assert.deepEqual(discussion.changes.map((change) => change.selected), [false, true]);
  const requested = preselectRequestedProposal({ stage: 'actions', changes: [{ id: 'x', type: 'remove', before: caterer, after: null }] });
  assert.equal(requested.changes[0].selected, true);
});
