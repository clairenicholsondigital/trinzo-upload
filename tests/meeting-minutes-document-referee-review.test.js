'use strict';
process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1 = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');
const A = require('../routes/api').stagedEvaluation;
const clone = value => structuredClone(value);
function fixture() {
  const units = V.normaliseSourceUnits([
    { id: 'T0001', speaker: 'Maya Patel', text: 'The standard is 74216, covering portable pump requirements.' },
    { id: 'T0002', speaker: 'Maya Patel', text: 'We can maybe get an assessment of that standard to see if it is applicable to the portable pump.' }
  ]);
  const [record] = A.normaliseAgentDeclaredProposals({ actionProposals: [{ id: 'assessment',
    action: 'Assess whether standard 74216 is applicable to the portable pump.', owners: [],
    timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0002'], reviewFlagIds: []
  }] }, units);
  assert.ok(V.requiresDocumentReferenceReview(record));
  const candidate = { candidateId: 'document-assessment', recordType: 'action', sourcePass: 'primary',
    text: record.action, evidenceIds: record.evidenceIds, record };
  const twin = { ...clone(candidate), candidateId: 'owner-bearing-twin', sourcePass: 'recovery',
    record: { ...clone(record), owners: ['Maya Patel'], reviewFlagIds: [] } };
  return { units, record, candidate, twin };
}

test('a publish verdict cannot clear document review or borrow an owner from a twin', () => {
  const { units, record, candidate, twin } = fixture();
  assert.deepEqual(A.borrowOwnersFromTwin(candidate, [twin]).owners, ['Maya Patel']);
  const before = clone([candidate, twin, units]);
  const result = A.reconstructRefereeActions([{ candidateId: candidate.candidateId, disposition: 'publish' }],
    [candidate], units, { ownerPool: [twin] });
  assert.deepEqual(result.actions, []);
  assert.equal(result.actionProposals.length, 1);
  assert.deepEqual(result.actionProposals[0].owners, []);
  assert.deepEqual(result.actionProposals[0].reviewFlagIds, record.reviewFlagIds);
  assert.deepEqual(result.actionProposals[0].evidenceIds, record.evidenceIds);
  assert.deepEqual([candidate, twin, units], before);
});

for (const disposition of ['publish', 'proposal']) test(`referee ${disposition} cannot supply an unaccepted owner to a protected assessment`, () => {
  const { units, record, candidate } = fixture();
  const result = A.reconstructRefereeActions([{ candidateId: candidate.candidateId, disposition,
    owners: ['Omar Dean'] }], [candidate], units);
  assert.deepEqual(result.actions, []);
  assert.equal(result.actionProposals.length, 1);
  assert.deepEqual(result.actionProposals[0].owners, []);
  assert.deepEqual(result.actionProposals[0].reviewFlagIds, record.reviewFlagIds);
});

test('an existing proposed owner and all original review flags survive without being confirmed', () => {
  const { units, candidate } = fixture();
  candidate.record.owners = ['Maya Patel'];
  candidate.record.reviewFlagIds.push('flag-another-source-concern');
  const result = A.reconstructRefereeActions([{ candidateId: candidate.candidateId, disposition: 'publish' }], [candidate], units);
  assert.equal(result.actions.length, 0);
  assert.deepEqual(result.actionProposals[0].owners, ['Maya Patel']);
  assert.deepEqual(result.actionProposals[0].reviewFlagIds, candidate.record.reviewFlagIds);
});

test('reconstructed review survives proposal normalisation, persistence and automatic handling; a human can still accept', () => {
  const { units, record, candidate, twin } = fixture();
  const result = A.reconstructRefereeActions([{ candidateId: candidate.candidateId, disposition: 'publish' }],
    [candidate], units, { ownerPool: [twin] });
  const proposals = A.normaliseRefereeDeclaredProposals({}, result, units);
  assert.equal(proposals.length, 1);
  assert.ok(V.requiresDocumentReferenceReview(proposals[0]));
  assert.equal(A.safeAgentProposalPromotion(proposals[0], [candidate, twin], units), false);
  const flags = A.retainedDocumentReferenceReviewFlags(proposals);
  assert.equal(flags.length, 1);
  assert.ok(flags[0].documentReferenceContext);
  const proposal = V.buildProposal('actions', [], proposals);
  proposal.changes.forEach(change => { change.selected = true; });
  const saved = A.meetingAgentDraftPayload(JSON.parse(JSON.stringify({ sourceUnits: units, actions: [],
    discussion: [], reviewFlags: flags, pendingProposal: proposal, details: { meetingDate: '2026-10-27' } })));
  const pub = A.publicMeetingAgentDraft(saved);
  assert.deepEqual(pub.actions, []);
  assert.ok(pub.reviewFlags.some(flag => flag.id === record.reviewFlagIds[0] && flag.documentReferenceContext));
  const automatic = A.automaticMeetingAgentProposalReview(saved.pendingProposal, saved.reviewFlags, [], units);
  assert.deepEqual(automatic.acceptedIds, []);
  assert.deepEqual(V.applyProposal([], saved.pendingProposal, automatic.acceptedIds), []);
  const accepted = V.applyProposal([], saved.pendingProposal, [saved.pendingProposal.changes[0].id]);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].action, record.action);
});

test('ordinary supported actions retain the existing owner borrowing behaviour', () => {
  const { units, candidate, twin } = fixture();
  candidate.record.reviewFlagIds = [];
  const result = A.reconstructRefereeActions([{ candidateId: candidate.candidateId, disposition: 'publish' }],
    [candidate], units, { ownerPool: [twin] });
  assert.equal(result.actions.length, 1);
  assert.deepEqual(result.actions[0].owners, ['Maya Patel']);
  assert.deepEqual(result.actionProposals, []);
});

test('referee contract compaction cannot erase the server-side document review requirement', () => {
  const { units, record, candidate, twin } = fixture();
  const contract = A.meetingMinutesAgentRefereeContract('actions', [candidate], 'review-boundary');
  const compact = contract.candidates.find(c => c.candidateId === candidate.candidateId);
  assert.ok(compact);
  assert.equal(compact.record, undefined);
  const result = A.reconstructRefereeActions([{ candidateId: compact.candidateId,
    disposition: 'publish', owners: ['Omar Dean'] }], contract.candidates, units, { ownerPool: [candidate, twin] });
  assert.deepEqual(result.actions, []);
  assert.equal(result.actionProposals.length, 1);
  assert.deepEqual(result.actionProposals[0].reviewFlagIds, record.reviewFlagIds);
  assert.deepEqual(result.actionProposals[0].owners, []);
});
