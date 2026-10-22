'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const V = require('../utils/meetingMinutesAgentV2');
const db = require('../utils/db');
const copy = value => JSON.parse(JSON.stringify(value));
let saved, writes = 0;
const priorGet = db.getMeetingMinutesAgentDraft, priorUpdate = db.updateMeetingMinutesAgentDraft;
db.getMeetingMinutesAgentDraft = async () => copy(saved);
db.updateMeetingMinutesAgentDraft = async (id, userId, revision, updates) => {
  assert.equal(id, saved.draftId);
  assert.equal(userId, 'warning-reviewer');
  assert.equal(revision, saved.revision);
  saved = copy({ ...V.migrateDraftPayload(updates.payload), draftId: id,
    revision: revision + 1, status: updates.status || saved.status });
  writes += 1;
  return copy(saved);
};
const router = require('../routes/api');
db.getMeetingMinutesAgentDraft = priorGet;
db.updateMeetingMinutesAgentDraft = priorUpdate;
const api = router.stagedEvaluation;
const { generateMeetingMinutesAgentDocx } = require('../utils/meetingMinutesAgentDocx');
const { renderStagedMinutesPdfHtml } = require('../utils/stagedMinutesPdf');
const wording = 'Write down the delivery readiness risks.';
const quote = 'I will write down the delivery readiness risks.';
const units = [{ id: 'T0001', speaker: 'Morgan Lee', text: quote, classification: 'keep' }];
const warning = (id, kind, message) => ({ id, kind, message, evidenceIds: ['T0001'], status: 'open', correctionNote: '' });
const flags = [
  warning('rescue-owner-check', 'ownership', 'The source leaves the assigned owner ambiguous; confirm the responsible person.'),
  warning('rescue-timing-check', 'timing', 'Confirm whether the approval condition belongs to this work.'),
  warning('flag-quantity-binding-rescue-control', 'uncertain_fact', 'The source does not bind the stated quantity to this work.'),
  warning('rescue-source-check', 'missing_evidence', 'The supporting source for part of this action needs review.'),
  warning('rescue-reference-check', 'unclear_reference', 'Confirm which delivery document the source describes.')
];
const action = (ids = []) => ({
  id: 'documentation-action', action: wording, owners: ['Morgan Lee'],
  evidenceIds: ['T0001'], reviewFlagIds: [...ids],
  timing: { kind: 'not_stated', wording: '', exactDate: '' }
});
function rescue(record, options = {}) {
  return V.applyCommitmentCheckResults([record],
    [{ id: 'c1', index: 0, action: record.action, passage: 'Morgan Lee: ' + quote }],
    [{ id: 'c1', verdict: 'commitment', commitmentQuote: quote, ownerSupported: true }], options);
}
for (const flag of [...flags, { id: 'unrecognised-review-concern' }]) {
  test('documentation promise does not waive linked review concern: ' + flag.id, () => {
    const record = action([flag.id]), before = copy(record);
    assert.equal(api.explicitFutureDocumentationCommitment(record, units), true,
      'the underlying future promise is still valid');
    assert.equal(api.safeAgentProposalPromotion(record, [], units), false,
      'a valid promise is not permission to bypass an unrelated warning');
    assert.equal(api.isReviewableActionProposal(record, units), true,
      'work remains available for ordinary reviewer acceptance');
    assert.deepEqual(record, before);
  });
}
test('unflagged documentation commitments retain the existing positive promotion path', () => {
  const record = action(), before = copy(record);
  assert.equal(api.safeAgentProposalPromotion(record, [], units), true);
  assert.deepEqual(record, before);
  assert.equal(api.safeAgentProposalPromotion({ ...record, owners: ['Riley Stone'] }, [], units), false);
});
for (const options of [{}, { requireOwnerTie: true }]) {
  test('commitment rescue retains independent and unknown warnings: ' + JSON.stringify(options), () => {
    const record = action([...flags.map(f => f.id), 'unknown-review-concern']);
    record.timing = { kind: 'dependency', wording: 'after approval', exactDate: '' };
    record.timingDecision = { status: 'unresolved', rejectedExactDates: ['2026-10-23'] };
    const before = copy(record), rescued = rescue(record, options);
    assert.equal(rescued.length, 1);
    assert.deepEqual(rescued[0], record, 'rescue proves commitment, not all flagged fields');
    assert.notEqual(rescued[0].reviewFlagIds, record.reviewFlagIds,
      'the returned flag list must not alias mutable input state');
    rescued[0].reviewFlagIds.push('later-concern');
    assert.deepEqual(record, before);
  });
}
test('rescue retains ordinary positive, negative and owner-clearance behaviour', () => {
  assert.deepEqual(rescue(action(), { requireOwnerTie: true }), [action()]);
  const record = action(['rescue-owner-check']);
  const items = [{ id: 'c1', index: 0, action: wording, passage: 'Morgan Lee: ' + quote }];
  assert.deepEqual(V.applyCommitmentCheckResults([record], items,
    [{ id: 'c1', verdict: 'commitment', commitmentQuote: 'Words never spoken.', ownerSupported: true }]), []);
  assert.deepEqual(V.applyCommitmentCheckResults([record], items,
    [{ id: 'c1', verdict: 'not_commitment', commitmentQuote: quote, ownerSupported: true }]), []);
  assert.deepEqual(V.applyCommitmentCheckResults([record], items, []), []);
  const [ownerUnknown] = V.applyCommitmentCheckResults([record], items,
    [{ id: 'c1', verdict: 'commitment', commitmentQuote: quote, ownerSupported: false }]);
  assert.deepEqual(ownerUnknown.owners, []);
  assert.deepEqual(ownerUnknown.reviewFlagIds, record.reviewFlagIds);
});
function draft(records) {
  return { draftId: 'warning-integrity', revision: 1, status: 'draft',
    details: { meetingTitle: 'Delivery readiness review', meetingDate: '2026-10-22', meetingType: 'General',
      internalAttendees: ['Morgan Lee'], clientAttendees: [] },
    sourceUnits: copy(units), preparedTranscript: V.preparedTranscriptFromUnits(units),
    actions: copy(records), discussion: [], executiveSummary: '', meetingObjectives: [],
    reviewFlags: copy(flags), qualityState: {}, candidateLedger: [], passProvenance: [], passCache: [],
    changeHistory: [], redoHistory: [], staleStages: [], currentStep: 3, selectedStep: 3 };
}
async function request(method, suffix = '', body = {}) {
  const routePath = '/meeting-minutes-agent/drafts/:draftId' + suffix;
  const route = router.stack.find(layer => layer.route?.path === routePath && layer.route.methods[method])?.route;
  assert.ok(route, 'missing route: ' + routePath);
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; } };
  await route.stack.at(-1).handle({ params: { draftId: saved.draftId },
    authUser: { userId: 'warning-reviewer' }, body: { revision: saved.revision, ...body } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body.draft;
}
function assertWarnings(visible) {
  const row = visible.actions.find(a => a.id === 'documentation-action');
  assert.ok(row, 'valid rescued work must remain present');
  for (const flag of flags) {
    assert.ok(row.reviewFlagIds.includes(flag.id), flag.id + ' remains attached');
    assert.equal(visible.reviewFlags.find(f => f.id === flag.id)?.status, 'open', flag.id + ' remains open');
  }
}
test('rescued warnings survive real payloads, PATCH/GET, undo/redo and Word/PDF evidence exports', async () => {
  const [rescued] = rescue(action(flags.map(f => f.id)), { requireOwnerTie: true });
  assert.deepEqual(rescued.reviewFlagIds, flags.map(f => f.id));
  // Register real definitions exactly as earlier generation passes do.
  V.reconcileRecordFlags({ actions: [rescued] }, flags);
  saved = draft([rescued]); writes = 0;
  assertWarnings(api.publicMeetingAgentDraft({ ...saved, ...api.meetingAgentDraftPayload(saved) }));
  assertWarnings(await request('get'));
  const edited = copy(saved.actions);
  edited[0].action = 'Write down the delivery readiness risks for the reviewer.';
  assertWarnings(await request('patch', '', { actions: edited,
    reviewDecisionLabel: 'Clarify the rescued delivery action for review' }));
  assertWarnings(await request('get'));
  const undone = await request('post', '/undo');
  assertWarnings(undone);
  assert.equal(undone.actions[0].action, wording);
  const redone = await request('post', '/redo');
  assertWarnings(redone);
  assert.equal(redone.actions[0].action, edited[0].action);
  const beforeExport = copy(saved);
  const word = api.meetingAgentDraftForDocx(saved);
  const zip = await JSZip.loadAsync(await generateMeetingMinutesAgentDocx(word, true));
  const xml = await zip.file('word/document.xml').async('string');
  const pdfInput = api.meetingAgentDraftForPdf(saved, true);
  const pdfHtml = renderStagedMinutesPdfHtml(pdfInput);
  for (const flag of flags) {
    assert.ok(xml.includes(flag.message), 'actual Word evidence includes ' + flag.id);
    assert.ok(pdfHtml.includes(flag.message), 'PDF evidence render input includes ' + flag.id);
  }
  assert.deepEqual(saved, beforeExport);
  assert.equal(writes, 3);
});
test('a flagged documentation proposal remains manually acceptable without silently resolving its warnings', async () => {
  const record = action(flags.map(f => f.id));
  assert.equal(api.safeAgentProposalPromotion(record, [], units), false);
  saved = draft([]);
  saved.pendingProposal = V.buildProposal('actions', [], [record]);
  assert.ok(saved.pendingProposal.changes.length);
  const accepted = await request('post', '/proposal', {
    decision: 'accept', changeIds: saved.pendingProposal.changes.map(c => c.id)
  });
  assertWarnings(accepted);
  assertWarnings(await request('get'));
});
