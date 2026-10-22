'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../routes/api').stagedEvaluation;
const reconciliation = require('../utils/canonicalMinutes/actionSemanticReconciliation');
const { captureSemanticPolicy } = require('../utils/meetingMinutesSemanticPolicy');
const { generateMeetingMinutesAgentDocx } = require('../utils/meetingMinutesAgentDocx');
const JSZip = require('jszip');

const clone = value => structuredClone(value);
const sourceUnits = () => api.meetingAgentDraftPayload({ sourceUnits: [{
  id: 'T0001', speaker: 'Morgan Lee',
  text: 'I will send Jordan the assessment results, including the findings.'
}] }).sourceUnits;
const action = (id, text) => ({
  id, action: text, owners: ['Morgan Lee'],
  timing: { kind: 'not_stated', wording: '', exactDate: '' },
  evidenceIds: ['T0001'], reviewFlagIds: []
});

function semanticFixture() {
  const units = sourceUnits();
  const original = action('A4', 'Send the assessment results to Jordan.');
  const selected = action('A4', 'Provide Jordan with the assessment findings.');
  const packet = reconciliation.prepareActionReconciliation({ actions: [original, selected], sourceUnits: units });
  const survivor = packet.rows[1];
  const span = { unitId: 'T0001', start: 0, end: units[0].text.length, quote: units[0].text };
  const tokens = value => String(value).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const envelope = {
    version: packet.version, packetHash: packet.packetHash, sourceHash: packet.sourceHash,
    inputHash: packet.inputHash,
    decisions: packet.candidates.map(candidate => ({
      candidateId: candidate.candidateId, relation: 'equivalent', survivorRef: survivor.ref,
      coverage: packet.rows.map(row => ({
        originalRef: row.ref, survivorRef: survivor.ref, sourceSpans: [span],
        semanticProof: {
          originalAction: row.action.action, survivorAction: survivor.action.action,
          originalFacets: clone(row.facets), survivorFacets: clone(survivor.facets),
          clauses: row.clauses.map(originalClause => {
            const from = tokens(originalClause);
            const to = tokens(survivor.action.action);
            return { originalClause, survivorClause: survivor.action.action, facets: {
              operation: { original: from[0], survivor: to[0], sourceSpans: [span] },
              object: { original: from.slice(1).join(' '), survivor: to.slice(1).join(' '), sourceSpans: [span] }
            } };
          })
        }
      }))
    }))
  };
  const reconciled = reconciliation.applyActionReconciliation(packet, envelope);
  assert.equal(reconciled.actions.length, 1, 'fixture exercises an authorized semantic paraphrase');
  const admitted = api.admitMeetingAgentGeneratedActionChanges({ sourceUnits: units }, {
    actions: reconciled.actions,
    qualityState: { actions: { semanticReconciliation: {
      applied: true, original: [original, selected], receipts: reconciled.receipts, ledger: reconciled.ledger
    } } }
  }, 'semantic-boundary-fixture');
  const receipts = admitted.qualityState.actions.semanticReconciliation.receipts;
  const proposal = { stage: 'actions', changes: [{ id: 'add-original', type: 'add', after: clone(original) }] };
  return { units, original, selected, admitted, receipts, proposal };
}

test('semantic boundaries: exact source-bound receipts prevent a removed paraphrase returning as a generated add', () => {
  const fixture = semanticFixture();
  const { proposal, admitted, receipts, units } = fixture;
  assert.equal(api.removePublishedActionProposalDuplicates(proposal, admitted.actions).changes.length, 1,
    'control remains a semantic case that the old lexical filter cannot remove');
  const before = clone(fixture);
  const result = api.removePublishedActionProposalDuplicates(proposal, admitted.actions, { receipts, sourceUnits: units });
  assert.equal(result.changes.length, 0);
  assert.deepEqual(fixture, before, 'filtering never mutates originals, receipts or the reviewer register');
});

test('semantic boundaries: stale source or changed survivor cannot reuse a prior semantic receipt', () => {
  const { proposal, admitted, receipts, units } = semanticFixture();
  const changedSource = clone(units);
  changedSource[0].text += ' This source was subsequently corrected.';
  assert.equal(api.removePublishedActionProposalDuplicates(proposal, admitted.actions,
    { receipts, sourceUnits: changedSource }).changes.length, 1);
  for (const mutate of [
    row => { row.action = 'Provide Jordan with the assessment summary.'; },
    row => { row.owners = ['Taylor Green']; },
    row => { row.timing = { kind: 'target', wording: 'tomorrow', exactDate: '' }; },
    row => { row.evidenceIds = ['T2']; },
    row => { row.reviewFlagIds = ['new-warning']; }
  ]) {
    const rows = clone(admitted.actions); mutate(rows[0]);
    assert.equal(api.removePublishedActionProposalDuplicates(proposal, rows,
      { receipts, sourceUnits: units }).changes.length, 1);
  }
});

test('semantic boundaries: changed proposed scope, owner, timing or evidence remains reviewable', () => {
  const { proposal, admitted, receipts, units } = semanticFixture();
  for (const mutate of [
    row => { row.action = 'Send the assessment results to Casey.'; },
    row => { row.owners = ['Taylor Green']; },
    row => { row.timing = { kind: 'target', wording: 'tomorrow', exactDate: '' }; },
    row => { row.evidenceIds = ['T2']; },
    row => { row.reviewFlagIds = ['new-warning']; },
    row => { row.source = 'reviewer'; }
  ]) {
    const changed = clone(proposal); mutate(changed.changes[0].after);
    assert.equal(api.removePublishedActionProposalDuplicates(changed, admitted.actions,
      { receipts, sourceUnits: units }).changes.length, 1);
  }
});

test('semantic boundaries: a reused ordinal ID does not exempt an unrelated addition or replace the survivor', () => {
  const { proposal, admitted, receipts, units } = semanticFixture();
  const related = clone(proposal.changes[0]);
  related.id = 'separate-same-id';
  related.after.action = 'Send the assessment results to Casey.';
  related.after.id = proposal.changes[0].after.id;
  const result = api.removePublishedActionProposalDuplicates({
    ...proposal, changes: [proposal.changes[0], related]
  }, admitted.actions, { receipts, sourceUnits: units });
  assert.deepEqual(result.changes.map(change => change.id), ['separate-same-id']);

  const unrelated = { ...clone(admitted.actions[0]), action: 'Provide Casey with the assessment findings.' };
  assert.equal(api.removePublishedActionProposalDuplicates(proposal, [unrelated],
    { receipts, sourceUnits: units }).changes.length, 1,
  'matching raw and occurrence identities cannot authorize changed content');
});

test('semantic boundaries: receipts survive save, publication, public presentation and actual Word generation', async () => {
  const { admitted, receipts, units } = semanticFixture();
  const draft = { ...admitted, sourceUnits: units, reviewFlags: [], details: { meetingTitle: 'Assessment review' } };
  const payload = api.meetingAgentDraftPayload({ ...draft, ...api.normaliseMeetingAgentDraftChanges(admitted) });
  const receipt = payload.qualityState.actions.semanticReconciliation.receipts[0];
  for (const rows of [
    payload.actions,
    api.meetingAgentPublicationContent(payload).actions,
    api.publicMeetingAgentDraft(payload).actions,
    api.meetingAgentDraftForDocx(payload).actions
  ]) {
    assert.equal(rows.length, 1);
    assert.ok(reconciliation.validateReconciliationReceipt(receipt, receipt.original, rows[0], payload.sourceUnits));
  }
  assert.deepEqual(receipt, receipts[0], 'save leaves the exact immutable receipt intact');
  assert.equal(api.publicMeetingAgentDraft(payload).qualityState, undefined);
  assert.equal(api.meetingAgentDraftForPdf(payload, true).actions.length, 1);
  const zip = await JSZip.loadAsync(await generateMeetingMinutesAgentDocx(api.meetingAgentDraftForDocx(payload), true));
  const xml = await zip.file('word/document.xml').async('string');
  assert.ok(xml.includes('Provide Jordan with the assessment findings.'));
  assert.ok(!xml.includes('Send the assessment results to Jordan.'),
    'the removed paraphrase cannot return in the visible Word register');
});

test('semantic boundaries: checked reviewer content defers the projection and records it as unpublished', async () => {
  const units = sourceUnits();
  const rows = [
    action('A1', 'Send the assessment results to Jordan.'),
    action('A2', 'Send the assessment results to Jordan.')
  ];
  const incoming = { changes: { actions: rows, qualityState: { actions: {} }, passProvenance: [] }, reviewFlags: [] };
  const result = await api.finishMeetingAgentGeneratedStage(incoming, {
    sourceUnits: units,
    _semanticPolicy: captureSemanticPolicy({ MEETING_MINUTES_AGENT_SEMANTIC_RECONCILIATION_V1: 'on' })
  }, 'actions', { semanticAsk: async () => { throw Error('This deterministic control must not call providers'); } });
  assert.equal(result.changes.actions.length, 1);
  const current = api.admitMeetingAgentGeneratedActionChanges({ sourceUnits: units }, {
    actions: [rows[0]], qualityState: { actions: {} }
  }, 'checked-current');
  const checked = current.actions[0].occurrenceId;
  const fresh = { ...current, sourceUnits: units, keptActionOccurrenceIds: [checked] };
  const before = clone(fresh);
  const regeneration = api.meetingAgentRegenerationChanges(fresh, 'actions', result.changes, result);
  assert.equal(regeneration.keptReviewerActions, true);
  assert.equal(Object.hasOwn(regeneration.changes, 'actions'), false);
  const semantic = regeneration.changes.qualityState.actions.semanticReconciliation;
  assert.equal(semantic.applied, false);
  assert.equal(semantic.publishedApplied, false);
  assert.equal(semantic.deferredToProposal, true);
  assert.ok(semantic.receipts.length, 'projection evidence remains available for review');
  assert.deepEqual(fresh, before, 'checked content, identity and reviewer state remain unchanged');
});
