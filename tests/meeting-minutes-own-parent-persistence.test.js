'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), JSZip = require('jszip');
const F = require('./helpers/discussion-own-parent-fixture');
const { O, copy } = F;
const C = require('../utils/canonicalMinutes/discussionClaimConsolidation');
const V = require('../utils/meetingMinutesAgentV2');
const { generateMeetingMinutesAgentDocx } = require('../utils/meetingMinutesAgentDocx');
const { generateStagedMinutesPdf } = require('../utils/stagedMinutesPdf');
process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1 = '0';
const db = require('../utils/db'), oldGet = db.getMeetingMinutesAgentDraft, oldUpdate = db.updateMeetingMinutesAgentDraft;
let saved, writes;
db.getMeetingMinutesAgentDraft = async (id, userId) => id === saved.draftId && userId === 'parent-reviewer' ? copy(saved) : null;
db.updateMeetingMinutesAgentDraft = async (id, userId, revision, changes) => {
  assert.equal(userId, 'parent-reviewer'); assert.equal(revision, saved.revision);
  saved = { ...V.migrateDraftPayload(copy(changes.payload)), draftId: id, revision: revision + 1, status: 'draft' };
  writes++; return copy(saved);
};
const router = require('../routes/api'), api = router.stagedEvaluation;
test.after(() => { db.getMeetingMinutesAgentDraft = oldGet; db.updateMeetingMinutesAgentDraft = oldUpdate; });
const warning = { id: 'parent-warning', kind: 'timing', status: 'open', correctionNote: '',
  message: 'Confirm whether the timing in this paragraph is agreed.', evidenceIds: ['T0001'] };
async function reset() {
  const sourceUnits = V.normaliseSourceUnits(copy(F.sourceUnits));
  const result = await O.consolidate(F.discussion, sourceUnits, F.options());
  assert.equal(result.audit.applied, true);
  saved = { draftId: 'own-parent-draft', revision: 1, status: 'draft', payloadVersion: V.PAYLOAD_VERSION,
    fileName: 'equipment.txt', details: { meetingTitle: 'Equipment', meetingType: 'General', meetingDate: '2026-10-21',
      internalAttendees: ['Nora Patel'], clientAttendees: [] },
    sourceUnits, rawTranscript: F.parentText,
    preparedTranscript: V.preparedTranscriptFromUnits(sourceUnits),
    discussion: result.discussion, actions: [], reviewFlags: [copy(warning)], meetingObjectives: [], executiveSummary: '',
    currentStep: 2, selectedStep: 2, staleStages: [], changeHistory: [], redoHistory: [], unassignedSupportingDetails: [],
    qualityState: { preparation: { dateContext: { meetingDate: '2026-10-21', source: 'reviewer' } },
      discussion: { claimConsolidation: result.audit, topicArrangementVersion: 1 } } };
  writes = 0;
}
async function request(method, suffix = '', body = {}, userId = 'parent-reviewer') {
  const route = router.stack.find(layer => layer.route?.path === '/meeting-minutes-agent/drafts/:draftId' + suffix && layer.route.methods[method])?.route;
  assert.ok(route);
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await route.stack.at(-1).handle({ params: { draftId: saved.draftId }, authUser: { userId },
    body: { revision: saved.revision, ...body } }, res);
  return res;
}
test('actual PATCH/GET keeps own-parent removal, private proof, warning target, evidence and history', async () => {
  await reset(); const archive = copy(saved.qualityState.discussion.claimConsolidation);
  const before = await request('get');
  assert.equal(before.body.draft.canRestoreCombinedDiscussion, true);
  assert.equal(before.body.draft.qualityState, undefined);
  assert.equal((await request('patch', '', { discussion: before.body.draft.discussion, actions: [] })).statusCode, 200);
  const after = await request('get'), p = after.body.draft.discussion[0].points[0];
  assert.equal(p.text, F.parentText); assert.deepEqual(p.supportingDetails, []);
  assert.deepEqual(p.evidenceIds, ['T0001']); assert.deepEqual(p.reviewFlagIds, ['parent-warning']);
  assert.deepEqual(after.body.draft.reviewFlags.find(f => f.id === warning.id), warning);
  assert.ok(p.mergedFromIds.includes('child')); assert.ok(p.mergedFromIds.includes('earlier-child'));
  assert.deepEqual(saved.qualityState.discussion.claimConsolidation, archive);
  assert.equal(after.body.draft.canRestoreCombinedDiscussion, true);
  assert.deepEqual(C.restore(saved.discussion, saved.sourceUnits, archive), F.discussion);
});
test('actual owned restore, undo and redo preserve original child and warning location', async () => {
  await reset();
  assert.equal((await request('post', '/restore-combined-discussion')).statusCode, 200);
  assert.deepEqual(saved.discussion, F.discussion);
  assert.deepEqual(saved.discussion[0].points[0].reviewFlagIds, ['parent-warning']);
  assert.equal(saved.qualityState.discussion.claimConsolidation.restored, true);
  assert.equal(saved.changeHistory.at(-1).label, 'Restore combined paragraphs');
  assert.equal((await request('post', '/undo')).statusCode, 200);
  assert.deepEqual(saved.discussion[0].points[0].supportingDetails, []);
  assert.equal((await request('post', '/redo')).statusCode, 200);
  assert.equal(saved.discussion[0].points[0].supportingDetails[0].text, F.childText);
});
test('real Word/PDF exports use unchanged parent once; private originals are not exported', async () => {
  await reset();
  for (const includeEvidence of [false, true]) {
    const draft = api.meetingAgentDraftPayload(saved);
    const zip = await JSZip.loadAsync(await generateMeetingMinutesAgentDocx(api.meetingAgentDraftForDocx(draft), includeEvidence));
    const xml = await zip.file('word/document.xml').async('string');
    assert.ok(xml.includes(F.parentText)); assert.ok(!xml.includes(F.childText));
    assert.ok(!xml.includes('own-parent-coverage')); assert.ok(!xml.includes('originalChild'));
    const pdf = await generateStagedMinutesPdf(api.meetingAgentDraftForPdf(draft, includeEvidence));
    assert.ok(pdf.length > 1000); assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  }
});
test('reviewer edits, stale revision, wrong owner and running jobs veto restoration without discarding proof', async () => {
  await reset(); const archive = copy(saved.qualityState.discussion.claimConsolidation);
  assert.equal((await request('post', '/restore-combined-discussion', { revision: 0 })).statusCode, 409);
  assert.equal((await request('post', '/restore-combined-discussion', {}, 'another-account')).statusCode, 404);
  saved.generation = { status: 'running', stage: 'actions' };
  assert.equal((await request('post', '/restore-combined-discussion')).statusCode, 409); delete saved.generation;
  const publicDraft = (await request('get')).body.draft;
  publicDraft.discussion[0].points[0].text += ' Reviewer addition.';
  assert.equal((await request('patch', '', { discussion: publicDraft.discussion })).statusCode, 200);
  assert.equal(saved.discussion[0].points[0].reviewerAuthored, true);
  assert.equal((await request('post', '/restore-combined-discussion')).statusCode, 409);
  assert.deepEqual(saved.qualityState.discussion.claimConsolidation, archive);
});
