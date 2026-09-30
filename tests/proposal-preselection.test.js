'use strict';

// Generic cases only: none of these rows come from the evaluation corpus.
const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../routes/api');
const {
  preselectActionProposal,
  preselectDiscussionProposal,
  preselectRequestedProposal,
  filterIncompleteProposalChanges,
  stripMinorCommunicationCourtesy,
  removeMinorCommunicationCourtesyDiscussion,
  removeHeadingFragmentsFromDiscussion,
  publicMeetingAgentDraft
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

test('proposal boundary removes heading fragments but keeps concise complete records', () => {
  const actions = preselectActionProposal({ stage: 'actions', changes: [
    { id: 'heading', type: 'add', after: { action: 'Review of cybersecurity controls', owners: ['Sam'], evidenceIds: ['T0001'] } },
    { id: 'noun', type: 'add', after: { action: 'Cybersecurity controls and risks', owners: ['Sam'], evidenceIds: ['T0001'] } },
    { id: 'contact', type: 'add', after: { action: 'Speak to the relevant person.', owners: ['Sam'], evidenceIds: ['T0001'] } },
    { id: 'short-valid', type: 'add', after: { action: 'Confirm the submission date.', owners: ['Sam'], evidenceIds: ['T0001'] } }
  ] }, [], units);
  assert.deepEqual(actions.changes.map((change) => change.id), ['short-valid']);

  const discussion = filterIncompleteProposalChanges({ stage: 'discussion', changes: [
    { id: 'empty-topic', type: 'add', after: { topic: 'Cybersecurity controls and risks', points: [{ text: 'USB port security' }], decisions: [], openQuestions: [] } },
    { id: 'structural-topic', type: 'add', after: { topic: 'Meeting Introduction and Initial Updates', points: [{ text: 'The audit remains on track.' }], decisions: [], openQuestions: [] } },
    { id: 'complete-topic', type: 'add', after: { topic: 'Cybersecurity controls and risks', points: [
      { text: 'USB port security' },
      { text: 'The residual cybersecurity risk remains high.' }
    ], decisions: [], openQuestions: [] } },
    { id: 'remove', type: 'remove', before: { topic: 'Earlier topic', points: [] }, after: null }
  ] });
  assert.deepEqual(discussion.changes.map((change) => change.id), ['complete-topic', 'remove']);
  assert.deepEqual(discussion.changes[0].after.points.map((row) => row.text), ['The residual cybersecurity risk remains high.']);
});

test('minor CC apologies do not become minutes while substantive document work remains', () => {
  const courtesyUnits = [
    { id: 'T0100', sequence: 100, speaker: 'Sam', text: 'We can send Priya the pack for offline review.', classification: 'keep' },
    { id: 'T0101', sequence: 101, speaker: 'Sam', text: "I'll copy her this time.", classification: 'keep' },
    { id: 'T0102', sequence: 102, speaker: 'Chair', text: "Don't worry about it; it was only the email.", classification: 'keep' }
  ];
  const combined = {
    action: 'Send Priya the pack for offline review and copy her on the correspondence.',
    owners: ['Sam'], evidenceIds: ['T0100', 'T0101']
  };
  assert.equal(stripMinorCommunicationCourtesy(combined, courtesyUnits).action,
    'Send Priya the pack for offline review.');
  assert.equal(stripMinorCommunicationCourtesy({
    action: 'Copy Priya on the email.', owners: ['Sam'], evidenceIds: ['T0101']
  }, courtesyUnits), null);

  const proposal = filterIncompleteProposalChanges({ stage: 'actions', changes: [
    { id: 'combined', type: 'add', after: combined },
    { id: 'courtesy', type: 'add', after: { action: 'Copy Priya on the email.', owners: ['Sam'], evidenceIds: ['T0101'] } }
  ] }, courtesyUnits);
  assert.deepEqual(proposal.changes.map((change) => change.after.action), ['Send Priya the pack for offline review.']);

  const discussion = removeMinorCommunicationCourtesyDiscussion([{ topic: 'Correspondence', decisions: [], openQuestions: [], points: [
    { text: 'Sam apologised for not copying Priya on the email.', evidenceIds: ['T0101'] },
    { text: 'Priya will review the document pack offline.', evidenceIds: ['T0100'] }
  ] }], courtesyUnits);
  assert.deepEqual(discussion[0].points.map((row) => row.text), ['Priya will review the document pack offline.']);

  const published = publicMeetingAgentDraft({
    sourceUnits: courtesyUnits,
    discussion: [],
    actions: [combined, { action: 'Copy Legal on all regulatory correspondence.', owners: ['Sam'], evidenceIds: ['T0100'] }]
  });
  assert.deepEqual(published.actions.map((row) => row.action), [
    'Send Priya the pack for offline review.',
    'Copy Legal on all regulatory correspondence.'
  ]);
});

test('administrative acknowledgements and off-record requests do not become minutes', () => {
  const discussion = removeMinorCommunicationCourtesyDiscussion([{ topic: 'Portal access', decisions: [], openQuestions: [], points: [
    { id: 'p1', text: 'New portal credentials were issued; Gemma acknowledges receipt.', evidenceIds: ['T0200'] },
    { id: 'p2', text: 'Javier requests a comment off the record.', evidenceIds: ['T0201'] },
    { id: 'p3', text: 'Acknowledgement of a distribution mistake with apologies and confirmation that Orla will review the QMS manual.', evidenceIds: ['T0202'] },
    { id: 'p4', text: 'The warehouse acknowledged receipt of 30 cartons.', evidenceIds: ['T0203'] }
  ] }], []);
  assert.deepEqual(discussion[0].points.map((row) => row.text), [
    'New portal credentials were issued.',
    'Orla will review the QMS manual.',
    'The warehouse acknowledged receipt of 30 cartons.'
  ]);
});

test('short title-shaped rows are removed without suppressing complete status statements', () => {
  const discussion = removeHeadingFragmentsFromDiscussion([{ topic: 'Sound testing', decisions: [], openQuestions: [], points: [
    { id: 'title', text: 'Sound Testing Complete', evidenceIds: ['T0300'] },
    { id: 'status', text: 'Sound testing is complete.', evidenceIds: ['T0301'], supportingDetails: [
      { id: 'label', text: 'Audio Checks Complete', evidenceIds: ['T0302'] },
      { id: 'detail', text: 'The final microphone check passed.', evidenceIds: ['T0303'] }
    ] }
  ] }]);
  assert.deepEqual(discussion[0].points.map((row) => row.id), ['status']);
  assert.deepEqual(discussion[0].points[0].supportingDetails.map((row) => row.id), ['detail']);
});
