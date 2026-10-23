'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const JSZip = require('jszip');
const B = require('../utils/canonicalMinutes/discussionBoundedRewrite');
const C = require('../utils/canonicalMinutes/discussionClaimConsolidation');
const V = require('../utils/meetingMinutesAgentV2');
const { generateMeetingMinutesAgentDocx } = require('../utils/meetingMinutesAgentDocx');
const { generateStagedMinutesPdf } = require('../utils/stagedMinutesPdf');
process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1 = '0';
const db = require('../utils/db'), oldGet = db.getMeetingMinutesAgentDraft, oldUpdate = db.updateMeetingMinutesAgentDraft;
const copy = value => JSON.parse(JSON.stringify(value));
let saved, original, writes;
db.getMeetingMinutesAgentDraft = async (id, userId) => id === saved.draftId && userId === 'bounded-reviewer' ? copy(saved) : null;
db.updateMeetingMinutesAgentDraft = async (id, userId, revision, changes) => {
  assert.equal(id, saved.draftId); assert.equal(userId, 'bounded-reviewer'); assert.equal(revision, saved.revision);
  saved = { ...V.migrateDraftPayload(copy(changes.payload)), draftId: id, revision: revision + 1, status: 'draft' };
  writes++; return copy(saved);
};
const router = require('../routes/api'), api = router.stagedEvaluation;
test.after(() => { db.getMeetingMinutesAgentDraft = oldGet; db.updateMeetingMinutesAgentDraft = oldUpdate; });
const output = 'Nora Patel criticised the current latch as cheap and poor quality and proposed a proper bracket and a decent latch, with a warning light as a possibility.';
async function reset() {
  const sourceUnits = V.normaliseSourceUnits([
    { id: 'T0001', speaker: 'Nora Patel', text: 'The current latch is rubbish, one of the cheap ones.' },
    { id: 'T0002', speaker: 'Nora Patel', text: 'We want a proper bracket, a decent latch and maybe a warning light.' }
  ]);
  const witnesses = sourceUnits.map(s => ({ sourceId: s.id, quote: s.text }));
  original = [{ id: 'topic', topic: 'Equipment', points: [
    { id: 'a', text: 'The current latch was poor quality, with suggestions for a proper bracket, a decent latch, and potentially a warning light.',
      evidenceIds: ['T0002'], primaryEvidenceIds: ['T0002'], reviewFlagIds: [], supportingDetails: [], mergedFromIds: ['earlier-a'] },
    { id: 'b', text: 'Nora Patel described the current latch as cheap and proposed a proper bracket, latch, and possibly a warning light.',
      evidenceIds: ['T0001', 'T0002'], reviewFlagIds: [], supportingDetails: [] }
  ], decisions: [], openQuestions: [] }];
  const result = await B.consolidate(original, sourceUnits, {
    encode: async texts => texts.map(() => [1, 0]),
    inventory: async (_, p) => ({ version: B.VERSION, packetHash: p.packetHash, results: p.candidates.map(c => ({
      id: c.id, decision: 'inventory', records: c.rows.map((row, i) => ({ recordId: row.record.id,
        claims: [{ id: 'claim-' + i, text: row.record.text, originalQuote: row.record.text, sourceWitnesses: witnesses }] }))
    })) }),
    propose: async (_, p, selected) => ({ version: B.VERSION, packetHash: p.packetHash,
      results: selected.map(c => ({ id: c.id, decision: 'rewrite', text: output })) }),
    verify: async (_, p, selected) => ({ version: B.VERSION, packetHash: p.packetHash, results: selected.map(c => ({
      id: c.id, selectionHash: c.selectionHash,
      claimChecks: c.inventory.flatMap(r => r.claims.map(claim => ({ claimId: claim.id, supported: true, retained: true, outputQuote: output, sourceWitnesses: witnesses }))),
      originalChecks: c.rows.flatMap(r => r.sentences.map((_, sentenceIndex) => ({ recordId: r.record.id, sentenceIndex, allClaimsListed: true, supported: true, retained: true, sourceWitnesses: witnesses }))),
      outputChecks: c.outputSentences.map((_, sentenceIndex) => ({ sentenceIndex, supported: true, noNewClaims: true, sourceWitnesses: witnesses }))
    })) })
  });
  assert.equal(result.audit.applied, true);
  saved = { draftId: 'bounded-draft', revision: 1, status: 'draft', payloadVersion: V.PAYLOAD_VERSION,
    fileName: 'equipment.txt', details: { meetingTitle: 'Equipment', meetingType: 'General', meetingDate: '2026-10-21', internalAttendees: ['Nora Patel'], clientAttendees: [] },
    sourceUnits, rawTranscript: sourceUnits.map(s => s.text).join(' '), preparedTranscript: V.preparedTranscriptFromUnits(sourceUnits),
    discussion: result.discussion, actions: [], reviewFlags: [], meetingObjectives: [], executiveSummary: '',
    currentStep: 2, selectedStep: 2, staleStages: [], changeHistory: [], redoHistory: [], unassignedSupportingDetails: [],
    qualityState: { preparation: { dateContext: { meetingDate: '2026-10-21', source: 'reviewer' } },
      discussion: { claimConsolidation: result.audit, topicArrangementVersion: 1 } } };
  writes = 0;
}
async function request(method, suffix = '', body = {}, userId = 'bounded-reviewer') {
  const route = router.stack.find(layer => layer.route?.path === '/meeting-minutes-agent/drafts/:draftId' + suffix && layer.route.methods[method])?.route;
  assert.ok(route);
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await route.stack.at(-1).handle({ params: { draftId: saved.draftId }, authUser: { userId }, body: { revision: saved.revision, ...body } }, res);
  return res;
}
test('verified source allocation and recovery survive real PATCH/GET without replaying the lexical citation picker', async () => {
  await reset(); const archive = copy(saved.qualityState.discussion.claimConsolidation);
  const before = await request('get'); assert.equal(before.body.draft.canRestoreCombinedDiscussion, true);
  assert.equal(before.body.draft.qualityState, undefined);
  assert.equal((await request('patch', '', { discussion: before.body.draft.discussion, actions: [] })).statusCode, 200);
  const after = await request('get');
  assert.equal(after.body.draft.discussion[0].points[0].text, output);
  assert.deepEqual(after.body.draft.discussion[0].points[0].evidenceIds, ['T0002', 'T0001']);
  assert.deepEqual(saved.qualityState.discussion.claimConsolidation, archive);
  assert.equal(after.body.draft.canRestoreCombinedDiscussion, true);
  for (const includeEvidence of [false, true]) {
    const draft = api.meetingAgentDraftPayload(saved);
    const zip = await JSZip.loadAsync(await generateMeetingMinutesAgentDocx(api.meetingAgentDraftForDocx(draft), includeEvidence));
    const xml = await zip.file('word/document.xml').async('string');
    assert.ok(xml.includes('Nora Patel criticised')); assert.ok(xml.includes('decent latch'));
    assert.ok(!xml.includes('with suggestions for a proper bracket'));
    const pdf = await generateStagedMinutesPdf(api.meetingAgentDraftForPdf(draft, includeEvidence));
    assert.ok(pdf.length > 1000); assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  }
});
test('existing owned restore endpoint restores both full original records and complete history', async () => {
  await reset(); assert.equal((await request('post', '/restore-combined-discussion')).statusCode, 200);
  assert.deepEqual(saved.discussion, original); assert.equal(saved.qualityState.discussion.claimConsolidation.restored, true);
  assert.equal(saved.changeHistory.at(-1).label, 'Restore combined paragraphs'); assert.equal(writes, 1);
});
test('normalisation keeps the private proof immutable and a real reviewer edit invalidates restoration', async () => {
  await reset(); const archive = copy(saved.qualityState.discussion.claimConsolidation);
  const normalised = api.normaliseMeetingAgentQualityState(saved.qualityState);
  assert.deepEqual(normalised.discussion.claimConsolidation, archive);
  assert.equal(C.hash(normalised.discussion.claimConsolidation.original), archive.originalHash);
  const first = (await request('get')).body.draft; first.discussion[0].points[0].text += ' Reviewer correction.';
  assert.equal((await request('patch', '', { discussion: first.discussion })).statusCode, 200);
  assert.equal(saved.discussion[0].points[0].reviewerAuthored, true);
  assert.deepEqual(saved.qualityState.discussion.claimConsolidation, archive);
  assert.equal((await request('get')).body.draft.canRestoreCombinedDiscussion, false);
});
test('owned revision checks, active generation and reviewer changes continue to veto restoration', async () => {
  await reset(); assert.equal((await request('post', '/restore-combined-discussion', { revision: 0 })).statusCode, 409);
  assert.equal((await request('post', '/restore-combined-discussion', {}, 'another-account')).statusCode, 404);
  saved.generation = { status: 'running', stage: 'actions' };
  assert.equal((await request('post', '/restore-combined-discussion')).statusCode, 409); delete saved.generation;
  saved.discussion[0].points[0].text += ' Reviewer correction.';
  assert.equal((await request('post', '/restore-combined-discussion')).statusCode, 409); assert.equal(writes, 0);
});
