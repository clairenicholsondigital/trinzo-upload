'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyRequesterOwnerRule, ownerAssignedInMeeting } = require('../utils/meetingMinutesPeopleEvidence');
const { normaliseAgentResult } = require('../utils/meetingMinutesResultNormalization');
const { applyProposal, buildProposal } = require('../utils/meetingMinutesProposals');
const MinutesActionDuplicatePolicy = require('../utils/meetingMinutesActionDuplicatePolicy');
const MinutesDraftView = require('../utils/meetingMinutesDraftView');
const MinutesPublication = require('../utils/meetingMinutesPublication');
const MinutesCandidateLedger = require('../utils/meetingMinutesCandidateLedger');
const MinutesProposalReview = require('../utils/meetingMinutesProposalReview');
const action = (id, wording, owners = ['Alex Green'], evidenceIds = ['T0001']) => ({
  id, action: wording, owners, evidenceIds, reviewFlagIds: [],
  timing: { kind: 'not_stated', wording: '', exactDate: '' }
});

test('a stale proposal cannot delete different wording with a reused ID', () => {
  const previous = action('A1', 'Update the equipment checklist.');
  const current = action('A1', 'Send the completed safety assessment to Priya Shah.');
  const p = buildProposal('actions', [previous], []);
  assert.deepEqual(applyProposal([current], p, p.changes.map(c => c.id)), [current]);
});

test('proposal targeting distinguishes same-ID actions after reordering and metadata changes', () => {
  const one = action('A1', 'Confirm the agreed delivery address.');
  const two = action('A1', 'Review the supplier report.');
  const p = buildProposal('actions', [one, two], [one]);
  const kept = { ...one, evidenceIds: ['T0001', 'T0002'] };
  assert.deepEqual(applyProposal([two, kept], p, p.changes.map(c => c.id)), [kept]);
});

test('a new action sharing an existing ordinal ID is still added once', () => {
  const one = action('A1', 'Approve the safety report.');
  const two = action('A1', 'Send the project plan to Priya Shah.');
  const p = buildProposal('actions', [one], [one, two]);
  const ids = p.changes.map(c => c.id);
  const admitted = applyProposal([one], p, ids);
  const content = ({ id: _id, occurrenceId: _occurrenceId, ...row }) => row;
  assert.deepEqual(admitted.map(content), [one, two].map(content));
  assert.deepEqual(admitted[0], one, 'the existing target keeps its identity and every field');
  assert.notEqual(admitted[1].id, one.id, 'a new occurrence cannot reuse the existing ordinal ID');
  assert.match(admitted[1].occurrenceId, /^action-occurrence-/);
  assert.deepEqual(applyProposal(admitted, p, ids), admitted, 'repeat acceptance preserves allocated identities');
  assert.deepEqual(applyProposal([one, two], p, ids), [one, two], 'historical rows are not rekeyed by ordinary review');
});

test('combining actions never rewrites the discovery records or their nested fields', () => {
  const records = [action('a', 'Send the draft checklist to Priya Shah.'),
    action('b', 'Send the completed draft checklist to Priya Shah.', ['Alex Green'], ['T0001', 'T0002'])];
  const before = structuredClone(records);
  const combined = MinutesActionDuplicatePolicy.dedupeHybridActionRecords(records);
  assert.deepEqual(records, before);
  combined[0].owners.push('Someone Else');
  assert.deepEqual(records, before);
});

test('delivery bundling preserves the complete recipient group without putting recipients among the documents', () => {
  const records = [action('one', 'Send the purchase order to Morgan Lee and Priya Shah.'),
    action('two', 'Send the delivery confirmation to Morgan Lee and Priya Shah.', ['Alex Green'], ['T0002'])];
  const result = MinutesActionDuplicatePolicy.dedupeHybridActionRecords(records);
  assert.equal(result.length, 1);
  assert.equal(result[0].action, 'Provide Morgan Lee and Priya Shah with the purchase order and the delivery confirmation.');
});

test('different complete recipient groups must not be bundled together', () => {
  const result = MinutesActionDuplicatePolicy.dedupeHybridActionRecords([
    action('one', 'Send the purchase order to Morgan Lee and Priya Shah.'),
    action('two', 'Send the delivery confirmation to Morgan Lee and Jordan Reed.', ['Alex Green'], ['T0002'])
  ]);
  assert.equal(result.length, 2);
});

test('an incidental copying correction cannot hide a substantive letter-writing commitment', () => {
  const wording = 'Write to the landlord about the broken gate, copy in the property manager.';
  const sourceUnits = [{ id: 'T0001', speaker: 'Alex Green', text: "I'll write properly this time and copy the manager into the email about the gate." }];
  const d = { details: {}, sourceUnits, discussion: [], actions: [action('one', wording)], reviewFlags: [] };
  assert.equal(MinutesDraftView.publicMeetingAgentDraft(d).actions[0]?.action, wording);
  assert.equal(MinutesPublication.meetingAgentDraftForPdf(d).actions[0]?.action, wording);
  assert.equal(MinutesPublication.meetingAgentDraftForDocx(d).actions[0]?.action, wording);
});

test('a nearby assignment of different work cannot remove a model-supplied owner', () => {
  const units = [
    { id: 'T0001', speaker: 'Chair', text: 'Morgan, your main focus is to resolve those.' },
    { id: 'T0002', speaker: 'Alex Green', text: 'Yes, understood.' },
    { id: 'T0003', speaker: 'Chair', text: 'Create the two translated help pages and finish the accessibility review next week.' },
    { id: 'T0004', speaker: 'Chair', text: 'Alex is managing the delivery tracker.' }
  ];
  const result = applyRequesterOwnerRule([action('one', 'Create the two translated help pages.', ['Morgan'], ['T0003'])], units);
  assert.deepEqual(result.actions[0].owners, ['Morgan']);
});

test('confirming an input stays separate from reviewing a standard against that input', () => {
  const records = [action('one', 'Confirm the product power specification.', ['Morgan Lee']),
    action('two', 'Review the safety standard against the confirmed product power specification.', ['Priya Shah'])];
  assert.equal(MinutesActionDuplicatePolicy.dedupeHybridActionRecords(records).length, 2);
});

test('a discovery ledger keeps its original wording, owners and citations through later edits', () => {
  const source = action('one', 'Confirm the supplier address.');
  const ledger = MinutesCandidateLedger.hybridCandidateLedgerFromResult({ actions: [source] }, 'primary');
  source.action = 'Review the supplier assessment.';
  source.owners.push('Someone Else');
  source.evidenceIds.push('T0002');
  assert.equal(ledger[0].record.action, 'Confirm the supplier address.');
  assert.deepEqual(ledger[0].record.owners, ['Alex Green']);
  assert.deepEqual(ledger[0].evidenceIds, ['T0001']);
});

test('recipient-first parsing distinguishes capitalised document names from recipients', () => {
  const rows = MinutesActionDuplicatePolicy.dedupeHybridActionRecords([
    action('one', 'Provide Morgan Lee and Priya Shah with Finance Report.'),
    action('two', 'Email Morgan Lee and Priya Shah with Staff Roster.', ['Alex Green'], ['T0002'])
  ]);
  assert.equal(rows.length, 1);
  assert.match(rows[0].action, /^Provide Morgan Lee and Priya Shah with /);
  assert.match(rows[0].action, /[Ff]inance Report/);
  assert.match(rows[0].action, /[Ss]taff Roster/);
});

test('an assignment split by another speaker acknowledgement retains its named owner', () => {
  const units = [
    { id: 'T0001', speaker: 'Chair', text: 'Morgan, your main focus is to resolve those' },
    { id: 'T0002', speaker: 'Alex Green', text: 'Yeah. Yes. Okay.' },
    { id: 'T0003', speaker: 'Chair', text: 'create the two translated help pages.' },
    { id: 'T0004', speaker: 'Morgan Lee', text: 'We have the necessary access.' }
  ];
  const records = [action('one', 'Create the two translated help pages.', ['Morgan Lee'], ['T0003'])];
  assert.deepEqual(normaliseAgentResult({ actions: records }, units, 'actions').actions[0].owners, ['Morgan Lee']);
  const interrupted = units.map((unit, index) => index === 1
    ? { ...unit, text: 'I will write the staff report and arrange interviews.' } : { ...unit });
  assert.equal(ownerAssignedInMeeting('Morgan Lee', records[0].action, interrupted), false,
    'different intervening work cannot be used as acknowledgement');
});


test('automatic adoption preserves uncertain removals and exposes possible additions as open source checks', () => {
  const retained = action('a', 'Reimburse the agreed equipment expense.');
  const add = action('b', 'Consider wider access improvements.', []);
  const proposal = { stage: 'actions', changes: [
    { id: 'remove', type: 'remove', before: retained, selected: false },
    { id: 'possible', type: 'add', after: add, selected: false, reviewContext: { reason: 'Nobody took this on.' } },
    { id: 'safe', type: 'add', index: 1, after: action('c', 'Send the revised report.'), selected: true }
  ] };
  const review = MinutesProposalReview.automaticMeetingAgentProposalReview(proposal, []);
  assert.deepEqual(review.acceptedIds, ['safe']);
  assert.deepEqual(applyProposal([retained], proposal, review.acceptedIds).map(row => row.id), ['a', 'c']);
  assert.equal(review.reviewFlags.length, 2);
  assert.ok(review.reviewFlags.every(flag => flag.status === 'open' && flag.evidenceIds.includes('T0001')));
  assert.match(review.reviewFlags.find(flag => flag.id.endsWith('possible')).message, /Nobody took this on/);
});


test('delivery bundles do not concatenate differently qualified versions of the same document', () => {
  const rows = [action('one', 'Share the access report with Priya Shah.'),
    action('two', 'Share the access report with Priya Shah after the review.', ['Alex Green'], ['T0002']),
    action('three', 'Send the inspection checklist to Priya Shah.', ['Alex Green'], ['T0003'])];
  const result = MinutesActionDuplicatePolicy.bundleSameRecipientDeliveries(rows);
  assert.deepEqual(result, rows, 'overlapping documents require deduplication rather than concatenation');
  const distinct = MinutesActionDuplicatePolicy.bundleSameRecipientDeliveries([rows[0], rows[2]]);
  assert.equal(distinct.length, 1);
  assert.deepEqual(MinutesActionDuplicatePolicy.bundleSameRecipientDeliveries(distinct), distinct, 'repeated assembly is idempotent');
});


test('a delivery dependency stays attached to its own action without an appended paraphrase', () => {
  const conditional = { ...action('one', 'Share the inspection report with Priya Shah after the checks are complete.'),
    timing: { kind: 'dependency', wording: 'after the inspection checks have finished', exactDate: '' } };
  const other = action('two', 'Send the access register to Priya Shah.');
  assert.deepEqual(MinutesActionDuplicatePolicy.bundleSameRecipientDeliveries([conditional, other]), [conditional, other]);
});


test('automatic duplicate removal requires complete retained work rather than shared wording', () => {
  const full = action('one', 'Create the access register and send the inspection report.');
  const partial = action('two', 'Send the inspection report.');
  const proposal = { stage: 'actions', changes: [{ id: 'remove', type: 'remove', before: full, selected: true }] };
  assert.deepEqual(MinutesProposalReview.automaticMeetingAgentProposalReview(proposal, [], [full, partial]).acceptedIds, []);
  const duplicate = { ...full, id: 'three' };
  assert.deepEqual(MinutesProposalReview.automaticMeetingAgentProposalReview(proposal, [], [full, duplicate]).acceptedIds, ['remove']);
  const both = { stage: 'actions', changes: [...proposal.changes,
    { id: 'also-remove', type: 'remove', before: duplicate, selected: true }] };
  assert.deepEqual(MinutesProposalReview.automaticMeetingAgentProposalReview(both, [], [full, duplicate]).acceptedIds, [],
    'two duplicate removals cannot cite each other as the surviving work');
});
