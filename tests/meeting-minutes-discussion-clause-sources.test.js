'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');
const { resolveEvidence } = require('../utils/meetingMinutesEvidenceResolution');
const { reconcileDiscussionClauseSources: repair } = require('../utils/meetingMinutesDiscussionSources');
function fixture() {
  const text = 'The prototype uses a rechargeable battery. The supplier has not approved the enclosure. Ellis requested the prototype test schedule and checklist.';
  const sourceUnits = Array.from({ length: 25 }, (_, i) => ({ id: 'T' + String(i + 1).padStart(4, '0'),
    speaker: i === 20 ? 'Ellis' : 'Noor', sequence: i + 1,
    text: i === 0 ? 'The prototype uses a rechargeable battery.' : i === 1 ? 'The supplier has not approved the enclosure.'
      : i === 2 ? 'We are waiting for that enclosure approval.' : i === 20
        ? 'Ellis requested the prototype test schedule and checklist to understand the activities and dates.' : 'The meeting room is available.' }));
  const record = { id: 'a', text, evidenceIds: ['T0001', 'T0002', 'T0003'], primaryEvidenceIds: ['T0001', 'T0002', 'T0003'] };
  return { record, sourceUnits };
}
test('the existing whole-row resolver reproduces citation drift; bounded repair retains all revalidated primary anchors', () => {
  const { record, sourceUnits } = fixture();
  const normal = V.normaliseAgentResult({ discussion: [{ topic: 'Equipment', points: [record] }] }, sourceUnits, 'discussion');
  assert.deepEqual(normal.discussion[0].points[0].evidenceIds, ['T0021']);
  const before = structuredClone(normal.discussion);
  const result = repair(normal.discussion, sourceUnits, { resolve: resolveEvidence });
  const row = result.discussion[0].points[0];
  assert.deepEqual(row.primaryEvidenceIds, record.primaryEvidenceIds);
  for (const id of [...record.evidenceIds, 'T0021']) assert.ok(row.evidenceIds.includes(id));
  assert.equal(row.text, record.text); assert.equal(result.audit[0].applied, true);
  assert.deepEqual(normal.discussion, before);
  assert.deepEqual(repair(result.discussion, sourceUnits, { resolve: resolveEvidence }).discussion, result.discussion);
});
for (const [name, mutate] of [
  ['reviewer card', d => { d[0].confirmedTopic = true; }],
  ['reviewer record', d => { d[0].points[0].reviewerAuthored = true; }],
  ['reviewer descendant', d => { d[0].points[0].supportingDetails = [{ id: 'manual-child', text: 'Reviewer context.', reviewerAuthored: true }]; }]
]) test(name + ' is unchanged', () => {
  const d = [{ points: [{ id: 'a', text: 'The battery is ready. The label is approved.', evidenceIds: ['T2'], primaryEvidenceIds: ['T1'] }] }];
  mutate(d); let calls = 0;
  assert.deepEqual(repair(d, [], { resolve: () => { calls++; } }).discussion, d); assert.equal(calls, 0);
});
test('unknown or ambiguous sources, unproved anchors, incomplete resolution and overflow keep complete originals', () => {
  const sources = Array.from({ length: 14 }, (_, i) => ({ id: 'T' + i, text: 'A source statement.' }));
  const input = [{ points: [{ id: 'a', text: 'The battery is ready. The label is approved.',
    evidenceIds: ['T1'], primaryEvidenceIds: ['T0'], reviewFlagIds: ['warning'], mergedFromIds: ['old'] }] }];
  for (const [units, resolve, reason] of [
    [[], () => null, 'incomplete_sources'],
    [[...sources, sources[0]], () => null, 'incomplete_sources'],
    [sources, () => ({ evidenceIds: ['T1'], supportScore: 1 }), 'primary_anchor_not_revalidated'],
    [sources, () => ({ evidenceIds: ['T0'], supportScore: 0.1 }), 'incomplete_clause_resolution'],
    [sources, () => { throw Error('offline'); }, 'resolution_failed'],
    [sources, () => ({ evidenceIds: sources.map(u => u.id).slice(0, 12), supportScore: 1 }), null]
  ]) {
    const d = structuredClone(input);
    if (reason === null) {
      d[0].points[0].evidenceIds = ['T13'];
      d[0].points[0].primaryEvidenceIds = sources.slice(0, 12).map(u => u.id);
    }
    const result = repair(d, units, { resolve });
    assert.deepEqual(result.discussion, d); assert.equal(result.audit[0].reason, reason || 'citation_budget');
  }
});
test('save/reopen retains repaired sources and private source history through the actual owned routes', async () => {
  const { record, sourceUnits } = fixture(), db = require('../utils/db');
  // Exercise the real first-eight normalisation boundary: the corrected
  // later citation must not push an original primary anchor out on save.
  record.evidenceIds = sourceUnits.slice(0, 8).map(unit => unit.id);
  record.primaryEvidenceIds = [...record.evidenceIds];
  const oldGet = db.getMeetingMinutesAgentDraft, oldUpdate = db.updateMeetingMinutesAgentDraft;
  process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1 = '0';
  let router, api;
  const inconsistent = V.normaliseAgentResult({ discussion: [{ id: 'topic', topic: 'Equipment', points: [record] }] },
    sourceUnits, 'discussion').discussion;
  const repaired = repair(inconsistent, sourceUnits, { resolve: resolveEvidence });
  let saved = { draftId: 'source-draft', revision: 1, status: 'draft', payloadVersion: V.PAYLOAD_VERSION,
    sourceUnits, preparedTranscript: V.preparedTranscriptFromUnits(sourceUnits), rawTranscript: 'Source fixture',
    details: { meetingTitle: 'Equipment', meetingType: 'General', meetingDate: '2026-10-21', internalAttendees: ['Ellis', 'Noor'], clientAttendees: [] },
    discussion: repaired.discussion, actions: [], reviewFlags: [], currentStep: 2, selectedStep: 2,
    qualityState: { discussion: { discussionSourceCoverage: repaired.audit } }, changeHistory: [], redoHistory: [] };
  const archive = structuredClone(repaired.audit);
  db.getMeetingMinutesAgentDraft = async (id, user) => id === 'source-draft' && user === 'source-reviewer' ? structuredClone(saved) : null;
  db.updateMeetingMinutesAgentDraft = async (id, user, revision, changes) => {
    assert.equal(revision, saved.revision); assert.equal(user, 'source-reviewer');
    saved = { ...changes.payload, draftId: id, revision: revision + 1, status: changes.status || 'draft' };
    return structuredClone(saved);
  };
  router = require('../routes/api'); api = router.stagedEvaluation;
  const request = async (method, body = {}) => {
    const route = router.stack.find(layer => layer.route?.path === '/meeting-minutes-agent/drafts/:draftId' && layer.route.methods[method]).route;
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await route.stack.at(-1).handle({ params: { draftId: 'source-draft' }, authUser: { userId: 'source-reviewer' },
      body: { revision: saved.revision, ...body } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body)); return res.body.draft;
  };
  try {
    assert.ok(api.publicMeetingAgentDraft(saved).discussion.length);
    const first = await request('get');
    const patched = await request('patch', { discussion: first.discussion, actions: [] });
    const reloaded = await request('get');
    for (const visible of [patched, reloaded]) {
      const row = visible.discussion[0].points[0];
      assert.equal(row.text, record.text);
      assert.deepEqual(row.primaryEvidenceIds, record.primaryEvidenceIds);
      for (const id of [...record.evidenceIds, 'T0021']) assert.ok(row.evidenceIds.includes(id));
      assert.equal(visible.qualityState, undefined);
    }
    assert.deepEqual(saved.qualityState.discussion.discussionSourceCoverage, archive);
    assert.strictEqual(api.normaliseMeetingAgentQualityState({ discussion: { discussionSourceCoverage: archive } })
      .discussion.discussionSourceCoverage, archive);
  } finally { db.getMeetingMinutesAgentDraft = oldGet; db.updateMeetingMinutesAgentDraft = oldUpdate; }
});
test('an uncited record is never rescued by this consistency repair', () => {
  const original = [{ points: [{ id: 'uncited', text: 'The battery is ready. The label is approved.',
    evidenceIds: [], primaryEvidenceIds: ['T1'], reviewFlagIds: ['unsupported'] }] }];
  let calls = 0;
  const result = repair(original, [{ id: 'T1', text: 'A source statement.' }], {
    resolve: () => { calls++; return { evidenceIds: ['T1'], supportScore: 1 }; }
  });
  assert.equal(calls, 0); assert.deepEqual(result.discussion, original); assert.deepEqual(result.audit, []);
});
test('single claims, decisions and consistent rows retain existing citation behavior', () => {
  const d = [{ points: [{ id: 'a', text: 'A single claim.', evidenceIds: ['T2'], primaryEvidenceIds: ['T1'] }],
    decisions: [{ id: 'b', text: 'The decision is approved. A second claim.', evidenceIds: ['T2'], primaryEvidenceIds: ['T1'] }] }];
  const result = repair(d, [{ id: 'T1', text: 'source' }, { id: 'T2', text: 'source' }], { resolve: () => { throw Error('must not resolve'); } });
  assert.deepEqual(result.discussion, d); assert.equal(result.audit[0].reason, 'not_multisentence');
});
