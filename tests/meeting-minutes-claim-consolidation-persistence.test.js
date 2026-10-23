'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const JSZip = require('jszip');
const C = require('../utils/canonicalMinutes/discussionClaimConsolidation');
const V = require('../utils/meetingMinutesAgentV2');
const { generateMeetingMinutesAgentDocx } = require('../utils/meetingMinutesAgentDocx');
process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1 = '0';
const db = require('../utils/db');
const oldGet = db.getMeetingMinutesAgentDraft, oldUpdate = db.updateMeetingMinutesAgentDraft;
let saved, originals, writes;
const copy = value => JSON.parse(JSON.stringify(value));
db.getMeetingMinutesAgentDraft = async (id, userId) => userId === 'consolidation-reviewer' && id === saved.draftId ? copy(saved) : null;
db.updateMeetingMinutesAgentDraft = async (id, userId, revision, changes) => {
  assert.equal(id, saved.draftId); assert.equal(userId, 'consolidation-reviewer'); assert.equal(revision, saved.revision);
  saved = { ...V.migrateDraftPayload(copy(changes.payload)), draftId: id, revision: revision + 1, status: changes.status || 'draft' };
  writes += 1; return copy(saved);
};
const router = require('../routes/api'), api = router.stagedEvaluation;
test.after(() => { db.getMeetingMinutesAgentDraft = oldGet; db.updateMeetingMinutesAgentDraft = oldUpdate; });
async function reset() {
  const sourceUnits = V.normaliseSourceUnits([{ id: 'T0001', speaker: 'Maya',
    text: 'The equipment needs a hasp, padlock and possibly a solar alarm.' }]);
  originals = [{ id: 'topic', topic: 'Equipment security', points: [
    { id: 'a', text: 'A hasp, padlock and potentially a solar alarm were proposed.', evidenceIds: ['T0001'], reviewFlagIds: [], supportingDetails: [], primaryEvidenceIds: ['T0001'] },
    { id: 'b', text: 'Maya proposed a hasp, padlock and possibly a solar alarm.', evidenceIds: ['T0001'], reviewFlagIds: [], supportingDetails: [] }
  ], decisions: [], openQuestions: [] }];
  const consolidated = await C.consolidate(originals, sourceUnits, {
    encode: async texts => texts.map(() => [1, 0]),
    assess: async (_, packet) => ({ version: C.VERSION, packetHash: packet.packetHash,
      results: packet.candidates.map(c => ({ id: c.id, relation: 'covered', survivorId: 'b' })) }),
    verify: async (_, packet, selected) => ({ version: C.VERSION, packetHash: packet.packetHash,
      results: selected.map(c => ({ id: c.id, survivorId: c.survivorId,
        checks: c.rows.flatMap(r => r.clauses.map((_, clauseIndex) => ({
          recordId: r.record.id, clauseIndex, supported: true, retained: true, sourceIds: ['T0001']
        }))) })) })
  });
  assert.equal(consolidated.audit.applied, true);
  saved = { draftId: 'consolidation-draft', revision: 1, status: 'draft', payloadVersion: V.PAYLOAD_VERSION,
    fileName: 'equipment.txt', details: { meetingTitle: 'Equipment security', meetingType: 'General',
      meetingDate: '2026-10-21', internalAttendees: ['Maya'], clientAttendees: [] },
    sourceUnits, rawTranscript: sourceUnits[0].text, preparedTranscript: V.preparedTranscriptFromUnits(sourceUnits),
    discussion: consolidated.discussion, actions: [], reviewFlags: [], meetingObjectives: [],
    executiveSummary: 'The equipment security options were discussed.', unassignedSupportingDetails: [],
    currentStep: 2, selectedStep: 2, staleStages: [], changeHistory: [], redoHistory: [],
    qualityState: { preparation: { dateContext: { meetingDate: '2026-10-21', source: 'reviewer' } },
      discussion: { claimConsolidation: consolidated.audit } } };
  saved = { ...api.meetingAgentDraftPayload(saved), draftId: saved.draftId, revision: 1, status: 'draft' };
  writes = 0;
}
async function request(method, suffix = '', body = {}, userId = 'consolidation-reviewer') {
  const path = '/meeting-minutes-agent/drafts/:draftId' + suffix;
  const route = router.stack.find(layer => layer.route?.path === path && layer.route.methods[method])?.route;
  assert.ok(route, path);
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await route.stack.at(-1).handle({ params: { draftId: saved.draftId }, authUser: { userId },
    body: { revision: saved.revision, ...body } }, res);
  return res;
}
test('private originals and source proof survive serialization, PATCH/GET and ordinary exports', async () => {
  await reset();
  const archive = copy(saved.qualityState.discussion.claimConsolidation);
  assert.equal(C.canRestore(saved.discussion, saved.sourceUnits, archive), true);
  const first = await request('get');
  assert.equal(first.statusCode, 200); assert.equal(first.body.draft.canRestoreCombinedDiscussion, true);
  assert.equal(first.body.draft.qualityState, undefined);
  const patch = await request('patch', '', { discussion: first.body.draft.discussion, actions: [] });
  assert.equal(patch.statusCode, 200, JSON.stringify(patch.body));
  assert.deepEqual(saved.qualityState.discussion.claimConsolidation, archive);
  const reloaded = await request('get');
  assert.equal(reloaded.body.draft.discussion[0].points.length, 1);
  assert.equal(reloaded.body.draft.canRestoreCombinedDiscussion, true);
  assert.deepEqual(reloaded.body.draft.discussion[0].points[0].primaryEvidenceIds, ['T0001']);
  for (const includeEvidence of [false, true]) {
    const zip = await JSZip.loadAsync(await generateMeetingMinutesAgentDocx(reloaded.body.draft, includeEvidence));
    const xml = await zip.file('word/document.xml').async('string');
    assert.ok(xml.includes('Maya proposed a hasp'));
    assert.ok(!xml.includes('potentially a solar alarm were proposed'));
    const pdf = api.meetingAgentDraftForPdf(reloaded.body.draft, includeEvidence);
    assert.ok(pdf.discussion.some(topic => topic.points.some(text => text.includes('Maya proposed'))));
  }
});
test('restoration recovers original paragraphs, citations and warning state through the owned revision-checked route', async () => {
  await reset();
  const result = await request('post', '/restore-combined-discussion');
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.draft.discussion[0].points.map(r => [r.id, r.text, r.evidenceIds]),
    originals[0].points.map(r => [r.id, r.text, r.evidenceIds]));
  assert.equal(result.body.draft.canRestoreCombinedDiscussion, false);
  assert.equal(saved.qualityState.discussion.claimConsolidation.restored, true);
  assert.equal(saved.changeHistory.at(-1).label, 'Restore combined paragraphs');
  assert.equal(writes, 1);
});
test('restoration refuses stale revisions, another account, active generation and reviewer edits', async () => {
  await reset();
  assert.equal((await request('post', '/restore-combined-discussion', { revision: 0 })).statusCode, 409);
  assert.equal((await request('post', '/restore-combined-discussion', {}, 'other-reviewer')).statusCode, 404);
  saved.generation = { status: 'running', stage: 'actions' };
  assert.equal((await request('post', '/restore-combined-discussion')).statusCode, 409);
  delete saved.generation;
  saved.discussion[0].points[0].text += ' Reviewer clarification.';
  assert.equal((await request('post', '/restore-combined-discussion')).statusCode, 409);
  assert.equal(writes, 0);
});
test('normalisation cannot rewrite source witnesses or original records in the archive', async () => {
  await reset();
  const audit = saved.qualityState.discussion.claimConsolidation;
  const normalised = api.normaliseMeetingAgentQualityState({ discussion: { claimConsolidation: audit } });
  assert.strictEqual(normalised.discussion.claimConsolidation, audit);
  assert.equal(C.hash(normalised.discussion.claimConsolidation.original), audit.originalHash);
});
