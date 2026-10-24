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
const legacyOutput = 'Nora Patel criticised the current latch as cheap and poor quality and proposed a proper bracket and a decent latch, with a warning light as a possibility.';
let output = legacyOutput;
async function reset(partial = false) {
  output = partial ? 'The team planned supplier upload oversight and clear registration responsibilities, with a documented plan; a gap could remain if audited.' : legacyOutput;
  const inputs = partial ? Array.from({ length: 24 }, (_, i) => ({ id: `T${String(i + 1).padStart(4, '0')}`,
    speaker: 'Morgan Lee', text: i === 7 ? 'The team planned supplier upload oversight and clear registration responsibilities, with a documented plan.'
      : i === 8 ? 'A gap could remain if audited.' : 'Adjacent source context.' })) : [
    { id: 'T0001', speaker: 'Nora Patel', text: 'The current latch is rubbish, one of the cheap ones.' },
    { id: 'T0002', speaker: 'Nora Patel', text: 'We want a proper bracket, a decent latch and maybe a warning light.' }
  ];
  const sourceUnits = V.normaliseSourceUnits(inputs);
  const witnesses = sourceUnits.filter((s, index) => !partial || (partial === 'wide' ? index < 10 : ['T0008', 'T0009'].includes(s.id)))
    .map(s => ({ sourceId: s.id, quote: s.text }));
  const originalPoints = partial ? [
    { id: 'a', text: 'The team planned supplier upload oversight and clear registration responsibilities, with a documented plan.' },
    { id: 'b', text: 'The team planned supplier upload oversight and clear registration responsibilities; a gap could remain if audited.' }
  ].map(r => ({ ...r, evidenceIds: Array.from({ length: 8 }, (_, i) => `T${String(i + 8).padStart(4, '0')}`),
    primaryEvidenceIds: Array.from({ length: 8 }, (_, i) => `T${String(i + 8).padStart(4, '0')}`),
    reviewFlagIds: [], supportingDetails: [] })) : [
    { id: 'a', text: 'The current latch was poor quality, with suggestions for a proper bracket, a decent latch, and potentially a warning light.',
      evidenceIds: ['T0002'], primaryEvidenceIds: ['T0002'], reviewFlagIds: [], supportingDetails: [], mergedFromIds: ['earlier-a'] },
    { id: 'b', text: 'Nora Patel described the current latch as cheap and proposed a proper bracket, latch, and possibly a warning light.',
      evidenceIds: ['T0001', 'T0002'], reviewFlagIds: [], supportingDetails: [] }
  ];
  original = [{ id: 'topic', topic: partial ? 'Supplier registration' : 'Equipment', points: originalPoints, decisions: [], openQuestions: [] }];
  const result = await B.consolidate(original, sourceUnits, {
    partialOverlap: Boolean(partial),
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
  assert.equal(result.audit.applied, true, JSON.stringify({ reason: result.audit.reason, diagnostics: result.audit.diagnostics }));
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
test('private referee failure evidence survives owned save exactly and never appears in public draft JSON',async()=>{
  await reset();
  const F=require('../utils/meetingMinutesRefereeFailureAudit');
  const journal=F.appendRefereeFailureAudit(null,{prompt:F.refereeFailureSnapshot('PRIVATE original udimed source'),
    rawReply:F.refereeFailureSnapshot({targetId:'PRIVATE rejected udimed target'})});
  saved.qualityState.discussion.refereeFailureAudit=journal;
  const before=(await request('get')).body.draft;
  assert.ok(!JSON.stringify(before).includes('PRIVATE'));
  assert.equal((await request('patch','',{discussion:before.discussion,qualityState:{discussion:{refereeFailureAudit:{forged:true}}}})).statusCode,200);
  assert.deepEqual(saved.qualityState.discussion.refereeFailureAudit,journal);
  const after=(await request('get')).body.draft;
  assert.ok(!JSON.stringify(after).includes('PRIVATE'));
});
test('unresolved fidelity warnings survive actual owned GET/PATCH and preserve reviewer resolution', async () => {
  await reset();
  const row = { id: 'fidelity-row', text: 'The current latch needs replacement.', evidenceIds: ['T0001'], reviewFlagIds: [] };
  const discussion = [{ topic: 'Equipment', points: [row], decisions: [], openQuestions: [] }];
  const items = V.discussionFidelityCheckItems(discussion, saved.sourceUnits);
  const checked = V.applyDiscussionFidelityResults(discussion, items, [{
    id: items[0].id, verdict: 'uncertain', problemQuote: row.text, evidenceQuote: '',
    reason: 'The intended meaning cannot be established.'
  }]);
  saved.discussion = checked.discussion; saved.reviewFlags = checked.flags;
  delete saved.qualityState.discussion.claimConsolidation;
  const before = (await request('get')).body.draft;
  assert.equal(before.reviewFlags.length, 1);
  assert.match(before.reviewFlags[0].id, /^flag-fidelity-meaning-/);
  assert.deepEqual(before.discussion[0].points[0].reviewFlagIds, [before.reviewFlags[0].id]);
  assert.equal((await request('patch', '', { discussion: before.discussion, reviewFlags: before.reviewFlags })).statusCode, 200);
  const after = (await request('get')).body.draft;
  assert.deepEqual(after.reviewFlags, before.reviewFlags);
  after.reviewFlags[0].status = 'confirmed'; after.reviewFlags[0].correctionNote = 'Checked against the recording.';
  assert.equal((await request('patch', '', { reviewFlags: after.reviewFlags })).statusCode, 200);
  const resolved = (await request('get')).body.draft;
  assert.equal(resolved.reviewFlags[0].status, 'confirmed');
  assert.equal(resolved.reviewFlags[0].correctionNote, 'Checked against the recording.');
});
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

test('partial rewrite verified citations and complete old references survive owned save, export and restore', async () => {
  await reset(true);
  const archive = copy(saved.qualityState.discussion.claimConsolidation);
  assert.equal(archive.ledger[0].nominationKind, 'partial_overlap');
  assert.deepEqual(saved.discussion[0].points[0].evidenceIds, ['T0008', 'T0009']);
  assert.equal(archive.ledger[0].citationAllocation.originalEvidenceIds.length, 8);
  const before = await request('get');
  assert.equal(before.body.draft.canRestoreCombinedDiscussion, true);
  assert.equal((await request('patch', '', { discussion: before.body.draft.discussion })).statusCode, 200);
  assert.deepEqual(saved.qualityState.discussion.claimConsolidation, archive);
  assert.deepEqual(saved.discussion[0].points[0].evidenceIds, ['T0008', 'T0009']);
  assert.deepEqual(saved.discussion[0].points[0].primaryEvidenceIds, ['T0008', 'T0009']);
  const draft = api.meetingAgentDraftPayload(saved);
  for (const includeEvidence of [false, true]) {
    const zip = await JSZip.loadAsync(await generateMeetingMinutesAgentDocx(api.meetingAgentDraftForDocx(draft), includeEvidence));
    const xml = await zip.file('word/document.xml').async('string');
    assert.ok(xml.includes('a gap could remain if audited'));
    assert.ok(xml.includes('with a documented plan'));
    const pdf = await generateStagedMinutesPdf(api.meetingAgentDraftForPdf(draft, includeEvidence));
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-'); assert.ok(pdf.length > 1000);
  }
  assert.equal((await request('post', '/restore-combined-discussion')).statusCode, 200);
  assert.deepEqual(saved.discussion, original);
  assert.equal(saved.discussion[0].points[0].evidenceIds.length, 8);
});

test('reviewer edits to a partial rewrite still invalidate automatic restoration', async () => {
  await reset(true);
  const draft = (await request('get')).body.draft;
  draft.discussion[0].points[0].text += ' Reviewer qualification.';
  assert.equal((await request('patch', '', { discussion: draft.discussion })).statusCode, 200);
  assert.equal(saved.discussion[0].points[0].reviewerAuthored, true);
  assert.equal((await request('get')).body.draft.canRestoreCombinedDiscussion, false);
  assert.equal((await request('post', '/restore-combined-discussion')).statusCode, 409);
});

test('a literal save preserves a verified ten-source paragraph and all recoverable original citations', async () => {
  await reset('wide');
  const refs = copy(saved.discussion[0].points[0].evidenceIds);
  assert.equal(refs.length, 10);
  const archive = copy(saved.qualityState.discussion.claimConsolidation);
  const draft = (await request('get')).body.draft;
  assert.deepEqual(draft.discussion[0].points[0].evidenceIds, refs);
  assert.equal((await request('patch', '', { discussion: draft.discussion })).statusCode, 200);
  assert.deepEqual(saved.discussion[0].points[0].evidenceIds, refs);
  assert.deepEqual(saved.discussion[0].points[0].primaryEvidenceIds, refs);
  assert.deepEqual(saved.qualityState.discussion.claimConsolidation, archive);
  assert.equal((await request('get')).body.draft.canRestoreCombinedDiscussion, true);
  assert.equal((await request('post', '/restore-combined-discussion')).statusCode, 200);
  assert.deepEqual(saved.discussion, original);
});

async function resetExistingSurvivor() {
  await reset();
  saved.sourceUnits = V.normaliseSourceUnits(Array.from({ length: 12 }, (_, i) => ({ id: `T${String(i + 1).padStart(4, '0')}`,
    speaker: 'Morgan Lee', text: i === 9 ? 'The maintenance interval was reduced as mitigation.'
      : 'The seal fault caused alarms and the maintenance interval was reduced as mitigation, with a documentation check outstanding.' })));
  saved.rawTranscript = saved.sourceUnits.map(s => s.text).join(' ');
  saved.preparedTranscript = V.preparedTranscriptFromUnits(saved.sourceUnits);
  const evidenceIds = saved.sourceUnits.slice(0, 8).map(s => s.id);
  original = [{ topic: 'Maintenance', points: [
    { id: 'fuller', text: 'The seal fault caused alarms and the maintenance interval was reduced as mitigation, with a documentation check outstanding.',
      evidenceIds, primaryEvidenceIds: evidenceIds, reviewFlagIds: [], supportingDetails: [
        { id: 'detail', text: 'An earlier review also covered the seal fault.', evidenceIds: ['T0009'], reviewFlagIds: ['detail-warning'], originalTopic: 'Maintenance' }
      ] },
    { id: 'short', text: 'The maintenance interval was reduced.', evidenceIds: ['T0010'], primaryEvidenceIds: ['T0010'], reviewFlagIds: [], supportingDetails: [] }
  ], decisions: [], openQuestions: [] }];
  const result = await C.consolidate(original, saved.sourceUnits, {
    nominationMode: 'directional',
    assess: async (_, p) => ({ version: C.VERSION, packetHash: p.packetHash, results: p.candidates.map(c => ({ id: c.id, relation: 'covered', survivorId: 'fuller' })) }),
    verify: async (_, p, selected) => ({ version: C.VERSION, packetHash: p.packetHash, results: selected.map(c => ({ id: c.id, survivorId: c.survivorId,
      checks: c.rows.flatMap(r => r.clauses.map((_, clauseIndex) => ({ recordId: r.record.id, clauseIndex, supported: true, retained: true, sourceIds: ['T0010'] }))) })) })
  });
  assert.equal(result.audit.applied, true);
  saved.discussion = result.discussion; saved.qualityState.discussion.claimConsolidation = result.audit;
  saved.reviewFlags = [{ id: 'detail-warning', kind: 'timing', status: 'open', correctionNote: '', message: 'Review the supporting analysis.', evidenceIds: ['T0009'] }];
}
test('unchanged owned save/reopen preserves nine-source existing survivor, child warning and exact restoration', async () => {
  await resetExistingSurvivor();const expected = copy(saved.discussion), archive = copy(saved.qualityState.discussion.claimConsolidation);
  for (const includeDiscussion of [true, false]) {
    const before = (await request('get')).body.draft;
    assert.equal(before.canRestoreCombinedDiscussion, true);
    const res = await request('patch', '', { ...(includeDiscussion ? { discussion: before.discussion } : {}), qualityState: { discussion: { claimConsolidation: { forged: true } } } });
    assert.equal(res.statusCode, 200); assert.deepEqual(saved.discussion, expected);
    assert.deepEqual(saved.qualityState.discussion.claimConsolidation, archive);
    assert.ok(saved.discussion[0].points[0].evidenceIds.includes('T0010'));
    assert.deepEqual(saved.discussion[0].points[0].supportingDetails, expected[0].points[0].supportingDetails);
    assert.equal((await request('get')).body.draft.canRestoreCombinedDiscussion, true);
  }
  for (const includeEvidence of [false, true]) {
    const draft = api.meetingAgentDraftPayload(saved);
    const zip = await JSZip.loadAsync(await generateMeetingMinutesAgentDocx(api.meetingAgentDraftForDocx(draft), includeEvidence));
    const xml = await zip.file('word/document.xml').async('string');
    assert.ok(xml.includes(expected[0].points[0].text));
    assert.equal(xml.includes(expected[0].points[0].supportingDetails[0].text), includeEvidence, 'supporting context follows the existing evidence-appendix option');
    assert.ok(!xml.includes('The maintenance interval was reduced.</w:t>'));
    assert.ok(!xml.includes('discussion-directional-coverage'));
    const pdf = await generateStagedMinutesPdf(api.meetingAgentDraftForPdf(draft, includeEvidence));
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-'); assert.ok(pdf.length > 1000);
  }
  const restored = await request('post', '/restore-combined-discussion');
  assert.equal(restored.statusCode, 200); assert.deepEqual(saved.discussion, original);
});
test('unchanged server-created legacy existing-survivor proof is preserved too', async () => {
  await resetExistingSurvivor();delete saved.qualityState.discussion.claimConsolidation.method;
  const expected = copy(saved.discussion);
  const before = (await request('get')).body.draft;
  assert.equal((await request('patch', '', { discussion: before.discussion })).statusCode, 200);
  assert.deepEqual(saved.discussion, expected);assert.equal(C.canRestore(saved.discussion,saved.sourceUnits,saved.qualityState.discussion.claimConsolidation),true);
});
for (const [name, change, body] of [
  ['changed wording', () => {}, before => { const rows=copy(before.discussion);rows[0].points[0].text='Reviewer changed the maintenance interpretation.';return {discussion:rows}; }],
  ['changed date', () => {}, () => ({details:{...saved.details,meetingDate:'2026-10-22'}})],
  ['changed source', () => { saved.sourceUnits[0].text='Source content changed.'; }, before => ({discussion:before.discussion})],
  ['malformed archive', () => { saved.qualityState.discussion.claimConsolidation.originalHash='invalid'; }, before => ({discussion:before.discussion})],
]) test('save preservation cannot retain stale proof: '+name, async () => {
  await resetExistingSurvivor();change();const before=(await request('get')).body.draft;
  const res=await request('patch','',body(before));assert.equal(res.statusCode,200);
  assert.equal((await request('get')).body.draft.canRestoreCombinedDiscussion,false);
  if(name==='changed wording') assert.equal(saved.discussion[0].points[0].text,'Reviewer changed the maintenance interpretation.');
});
test('another user cannot save a trusted existing-survivor proof', async () => {
  await resetExistingSurvivor();const before=copy(saved);const r=await request('patch','',{},'other-user');assert.equal(r.statusCode,404);assert.equal(writes,0);assert.deepEqual(saved,before);
});
test('missing original in a server archive does not turn an ordinary save into a server failure', async () => {
  await resetExistingSurvivor();delete saved.qualityState.discussion.claimConsolidation.original;
  const before=await request('get');assert.equal(before.statusCode,200);assert.equal(before.body.draft.canRestoreCombinedDiscussion,false);
  assert.equal((await request('patch','',{discussion:before.body.draft.discussion})).statusCode,200);
  assert.equal((await request('get')).body.draft.canRestoreCombinedDiscussion,false);
});
