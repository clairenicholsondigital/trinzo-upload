'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const V = require('../utils/meetingMinutesAgentV2');
const { generateMeetingMinutesAgentDocx } = require('../utils/meetingMinutesAgentDocx');
const { withoutRepresentedUnassignedDetails } = require('../utils/meetingMinutesSupportingDetails');

// Real route handlers and serializers; only provider/database I/O is replaced.
process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1 = '0';
const fetchPath = require.resolve('node-fetch');
require(fetchPath);
const originalFetch = require.cache[fetchPath].exports;
let providerCalls = 0;
require.cache[fetchPath].exports = async () => {
  providerCalls += 1;
  throw new Error('Provider calls are forbidden in supporting-detail persistence tests');
};
const db = require('../utils/db');
const originalGet = db.getMeetingMinutesAgentDraft;
const originalUpdate = db.updateMeetingMinutesAgentDraft;
const copy = value => JSON.parse(JSON.stringify(value));
let saved; let writes;
db.getMeetingMinutesAgentDraft = async () => copy(saved);
db.updateMeetingMinutesAgentDraft = async (id, userId, revision, updates) => {
  assert.equal(id, saved.draftId);
  assert.equal(userId, 'filing-reviewer');
  assert.equal(revision, saved.revision);
  saved = copy({ ...V.migrateDraftPayload(updates.payload), draftId: saved.draftId, revision: revision + 1,
    status: updates.status || saved.status });
  writes += 1;
  return copy(saved);
};
const router = require('../routes/api');
const api = router.stagedEvaluation;
db.getMeetingMinutesAgentDraft = originalGet;
db.updateMeetingMinutesAgentDraft = originalUpdate;
require.cache[fetchPath].exports = originalFetch;

const longText = 'Calibration background for independent reviewer inspection. '
  + 'The source context remains available with its evidence and qualifications. '.repeat(27)
  + 'The final calibration qualification is retained: ZETA-TAIL.';
const detail = (id, text, evidenceIds, extra = {}) => ({ id, text, evidenceIds, reviewFlagIds: [], ...extra });
const pool = () => [
  detail('unfiled-long', longText, ['T0002'], { reviewFlagIds: ['detail-review'],
    originalTopic: 'Earlier calibration context', placementReason: 'No unique supporting parent was established.' }),
  detail('unfiled-short', 'The calibration archive contains the retained comparison record.', ['T0003'], {
    originalTopic: 'Archive', placementReason: 'The suggested target was ambiguous.' })
];
function reset() {
  const sourceUnits = [
    { id: 'T0001', speaker: 'Morgan Taylor', text: 'The calibration review is complete. I will send the calibration record.' },
    { id: 'T0002', speaker: 'Morgan Taylor', text: longText },
    { id: 'T0003', speaker: 'Morgan Taylor', text: 'The calibration archive contains the retained comparison record.' }
  ];
  saved = { draftId: 'support-filing', revision: 1, status: 'draft', payloadVersion: V.PAYLOAD_VERSION,
    details: { meetingTitle: 'Calibration review', meetingType: 'General', meetingDate: '2026-10-21',
      internalAttendees: ['Morgan Taylor'], clientAttendees: [] },
    sourceUnits, preparedTranscript: V.preparedTranscriptFromUnits(sourceUnits),
    discussion: [{ id: 'calibration', topic: 'Calibration review',
      points: [{ id: 'main', text: 'The calibration review is complete.', evidenceIds: ['T0001'], reviewFlagIds: [], supportingDetails: [] }],
      decisions: [], openQuestions: [] }],
    unassignedSupportingDetails: pool(),
    actions: [{ id: 'send', action: 'Send the calibration record.', owners: ['Morgan Taylor'],
      timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0001'], reviewFlagIds: [] }],
    executiveSummary: 'The calibration record was reviewed.', meetingObjectives: [],
    reviewFlags: [{ id: 'detail-review', kind: 'unclear_reference', status: 'open',
      message: 'The calibration context has an unclear reference; confirm which calibration batch it describes.', evidenceIds: ['T0002'], correctionNote: '' }],
    changeHistory: [], redoHistory: [], staleStages: [], currentStep: 5, selectedStep: 5,
    qualityState: { preparation: { dateContext: { source: 'reviewer', meetingDate: '2026-10-21' } } } };
  writes = 0;
}
async function request(method, suffix = '', body = {}) {
  const routePath = `/meeting-minutes-agent/drafts/:draftId${suffix}`;
  const route = router.stack.find(layer => layer.route?.path === routePath && layer.route.methods[method])?.route;
  assert.ok(route, `Missing ${method} ${routePath}`);
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  await route.stack.at(-1).handle({ params: { draftId: saved.draftId }, authUser: { userId: 'filing-reviewer' },
    body: { revision: saved.revision, ...body } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(providerCalls, 0);
  return res.body.draft;
}
function mainContent(draft) {
  return { discussion: draft.discussion.map(topic => ({ id: topic.id, topic: topic.topic,
    ...Object.fromEntries(['points', 'decisions', 'openQuestions'].map(field => [field,
      (topic[field] || []).map(row => ({ id: row.id, text: row.text }))])) })),
    actions: draft.actions.map(row => ({ id: row.id, action: row.action, owners: row.owners, timing: row.timing })) };
}
function assertPool(actual, expected) {
  assert.ok(Array.isArray(actual), 'the pool must survive as an array');
  const view = rows => rows.map(row => ({ ...row, reviewFlagIds: row.reviewFlagIds || [] }));
  assert.deepEqual(view(actual), view(expected));
}
function supportInventory(draft) {
  const attached = (draft.discussion || []).flatMap(topic => ['points', 'decisions', 'openQuestions']
    .flatMap(field => (topic[field] || []).flatMap(row => row.supportingDetails || [])));
  return [...attached, ...(draft.unassignedSupportingDetails || [])];
}
function retainedIdentity(row) {
  return { id: row.id, text: row.text, evidenceIds: row.evidenceIds, reviewFlagIds: row.reviewFlagIds || [] };
}
async function documentXml(draft, evidence) {
  const zip = await JSZip.loadAsync(await generateMeetingMinutesAgentDocx(draft, evidence));
  return zip.file('word/document.xml').async('string');
}

test('literal folded context retains provenance through real PATCH/GET and ordinary/evidence exports', async () => {
  reset();
  const claim='The calibration review at the regional laboratory is complete';
  const full=claim+', and the equipment log was signed.';
  saved.sourceUnits[0].text=full+' I will send the calibration record.';
  saved.discussion[0].points[0]={id:'main',text:full,evidenceIds:['T0001'],reviewFlagIds:[],
    supportingDetails:[{id:'repeated-context',text:claim+'.',evidenceIds:['T0001'],mergedFromIds:['earlier-context']}]};
  const cleanup=require('../utils/meetingMinutesSupportingDetails').foldLiteralParentSupportingRepeats(saved.discussion);
  assert.equal(cleanup.foldedCount,1);
  saved.discussion=cleanup.discussion;
  const first=await request('get');
  const after=await request('patch','',{discussion:first.discussion,actions:first.actions});
  const reloaded=await request('get');
  for(const d of [after,reloaded]){
    assert.equal(d.discussion[0].points[0].text,full);
    assert.deepEqual(d.discussion[0].points[0].supportingDetails,[]);
    assert.deepEqual(d.discussion[0].points[0].mergedFromIds,['repeated-context','earlier-context']);
    assertPool(d.unassignedSupportingDetails,pool());
    for(const evidence of [false,true]){
      const xml=await documentXml(d,evidence);
      assert.ok(xml.includes('equipment log was signed'));
      const pdf=api.meetingAgentDraftForPdf(d,evidence);
      assert.ok(pdf.discussion.some(topic=>topic.points.some(point=>point.includes('equipment log was signed'))));
    }
  }
  assert.equal(providerCalls,0);
});

test('raw saved filing rows use the same duplicate cleanup and order in screen, Word and PDF evidence', async () => {
  reset();
  const { orderedEntries } = require('../public/meeting-minutes-filing-order');
  const early = detail('early-context', 'The calibration certificate remains available.', ['T0002'],
    { originalTopic: 'Equipment', placementReason: 'no_unique_parent' });
  saved.unassignedSupportingDetails = [
    detail('late-context', 'The comparison archive remains available.', ['T0003']),
    detail('manual-fixed', 'The reviewer retained this independent explanation.', ['T0003'], { reviewerAuthored: true }),
    early,
    { ...early, id: 'duplicate-context', originalTopic: 'Inspection', placementReason: 'parent_not_publishable' }
  ];
  const before = copy(saved);
  const visible = api.publicMeetingAgentDraft(saved);
  const expected = orderedEntries(visible.unassignedSupportingDetails, saved.sourceUnits).map(entry => entry.detail.text);
  assert.equal(expected.length, 3);
  assert.equal(expected[1], saved.unassignedSupportingDetails[1].text);
  const pdf = api.meetingAgentDraftForPdf(saved, true);
  assert.deepEqual(pdf.supportingDetails.filter(row => row.topic === 'Needs filing').map(row => row.text), expected);
  const xml = await documentXml(api.meetingAgentDraftForDocx(saved), true);
  const section = xml.slice(xml.indexOf('Needs filing')).split('<w:pStyle w:val="Heading3"')[0];
  const actual = [...section.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)]
    .map(match => match[1]).filter(text => expected.some(value => text.startsWith(value)))
    .map(text => text.replace(/ \(Sources: [^)]*\)$/, ''));
  assert.deepEqual(actual, expected);
  assert.deepEqual(saved, before);
  assert.equal(writes, 0);
  assert.equal(providerCalls, 0);
});

test('export-only filing cleanup leaves ordinary Word and PDF minutes unchanged', async () => {
  reset();
  saved.unassignedSupportingDetails = [pool()[1], { ...pool()[1], id: 'same-text-other-id' }];
  const noPool = { ...saved, unassignedSupportingDetails: [] };
  assert.equal(await documentXml(api.meetingAgentDraftForDocx(saved), false),
    await documentXml(api.meetingAgentDraftForDocx(noPool), false));
  assert.deepEqual(api.meetingAgentDraftForPdf(saved, false), api.meetingAgentDraftForPdf(noPool, false));
  assert.equal(writes, 0);
  assert.equal(providerCalls, 0);
});

test('payload and public projection retain full unfiled detail, provenance and warning links', () => {
  reset();
  assert.ok(longText.length > 1600, 'fixture crosses both the flag and ordinary row clipping boundaries');
  const before = copy(saved);
  const payload = api.meetingAgentDraftPayload(saved);
  assertPool(payload.unassignedSupportingDetails, pool());
  const visible = api.publicMeetingAgentDraft({ ...saved, ...payload });
  assertPool(visible.unassignedSupportingDetails, pool());
  assert.equal(visible.reviewFlags.find(row => row.id === 'detail-review')?.status, 'open');
  assert.equal(visible.unassignedSupportingDetails[0].text, longText);
  assert.match(visible.unassignedSupportingDetails[0].text, /ZETA-TAIL\.$/);
  assert.deepEqual(saved, before, 'read/publication cannot mutate the stored draft');
});

test('old-client PATCH that omits the pool preserves full records through save and reload', async () => {
  reset();
  const first = await request('get');
  const originalMain = mainContent(first);
  for (let count = 0; count < 2; count += 1) {
    const after = await request('patch', '', { discussion: first.discussion, actions: first.actions });
    assertPool(saved.unassignedSupportingDetails, pool());
    assertPool(after.unassignedSupportingDetails, pool());
    assert.deepEqual(mainContent(after), originalMain);
    assertPool((await request('get')).unassignedSupportingDetails, pool());
  }
  assert.equal(writes, 2);
});

test('filing transfers a complete unfiled record exactly once and undo/redo restores both sides', async () => {
  reset();
  const initial = await request('get');
  const discussion = copy(initial.discussion);
  discussion[0].points[0].supportingDetails = [copy(initial.unassignedSupportingDetails[0])];
  const remaining = [copy(initial.unassignedSupportingDetails[1])];
  const after = await request('patch', '', { discussion, unassignedSupportingDetails: remaining,
    reviewDecisionLabel: 'File calibration context under its matching discussion point' });
  assert.equal(after.discussion[0].points[0].supportingDetails[0].text, longText);
  assertPool(after.unassignedSupportingDetails, remaining);
  assert.equal(supportInventory(after).filter(row => row.id === 'unfiled-long').length, 1);
  assert.deepEqual(supportInventory(after).map(retainedIdentity).sort((a,b) => a.id.localeCompare(b.id)),
    pool().map(retainedIdentity).sort((a,b) => a.id.localeCompare(b.id)));
  assert.deepEqual(mainContent(after), mainContent(initial), 'filing cannot promote the detail or reorder main text/actions');
  assert.equal(saved.changeHistory.at(-1).beforeState.unassignedSupportingDetails[0].text, longText);
  const undone = await request('post', '/undo');
  assertPool(undone.unassignedSupportingDetails, pool());
  assert.equal(undone.discussion[0].points[0].supportingDetails.length, 0);
  const redone = await request('post', '/redo');
  assert.equal(redone.discussion[0].points[0].supportingDetails[0].text, longText);
  assertPool(redone.unassignedSupportingDetails, remaining);
  assert.equal(supportInventory(redone).filter(row => row.id === 'unfiled-long').length, 1);
  const reloaded = await request('get');
  assert.equal(reloaded.discussion[0].points[0].supportingDetails[0].text, longText);
  assertPool(reloaded.unassignedSupportingDetails, remaining);
});

test('an explicitly empty pool survives filing of its last record and a later old-client autosave', async () => {
  reset();
  saved.unassignedSupportingDetails = [pool()[1]];
  const initial = await request('get');
  const discussion = copy(initial.discussion);
  discussion[0].points[0].supportingDetails = copy(initial.unassignedSupportingDetails);
  const filed = await request('patch', '', { discussion, unassignedSupportingDetails: [], reviewDecisionLabel: 'File archive context' });
  assertPool(filed.unassignedSupportingDetails, []);
  const next = await request('patch', '', { executiveSummary: filed.executiveSummary });
  assertPool(next.unassignedSupportingDetails, []);
  assert.equal(supportInventory(next).filter(row => row.id === 'unfiled-short').length, 1);
});

for (const stage of ['actions', 'summary']) {
  test(`${stage} background persistence keeps the current pool through JSON serialization`, async () => {
    reset();
    const sourceDraft = copy(saved);
    saved.unassignedSupportingDetails[1].placementReason = 'A reviewer retained the latest filing decision.';
    const expectedPool = copy(saved.unassignedSupportingDetails);
    const changes = stage === 'actions' ? { actions: copy(saved.actions) }
      : { executiveSummary: 'The calibration findings have been reviewed.', meetingObjectives: [] };
    const result = await api.persistMeetingAgentBackgroundStage({ draftId: saved.draftId, userId: 'filing-reviewer',
      stage, sourceDraft, result: { changes, reviewFlags: [] },
      getDraft: async () => copy(saved),
      saveDraft: async (fresh, incoming) => {
        saved = copy({ ...api.meetingAgentDraftPayload({ ...fresh, ...incoming }),
          draftId: fresh.draftId, status: fresh.status, revision: fresh.revision + 1 });
        return copy(saved);
      }, wait: async () => assert.fail('No retry should be needed') });
    assert.deepEqual(result.conflictFields, []);
    assertPool(saved.unassignedSupportingDetails, expectedPool);
    assert.equal(saved.unassignedSupportingDetails[0].text, longText);
    assertPool(api.publicMeetingAgentDraft(saved).unassignedSupportingDetails, expectedPool);
    assert.equal(providerCalls, 0);
  });
}

test('ordinary exports keep identical main content/order; evidence exports include full pool and source', async () => {
  reset();
  const withoutPool = { ...copy(saved), unassignedSupportingDetails: [] };
  const ordinary = api.meetingAgentDraftForPdf(saved, false);
  assert.deepEqual(ordinary, api.meetingAgentDraftForPdf(withoutPool, false));
  assert.equal(JSON.stringify(ordinary).includes('ZETA-TAIL'), false);
  const evidence = api.meetingAgentDraftForPdf(saved, true);
  assert.ok((evidence.supportingDetails || []).some(row => row.text === longText), 'PDF evidence must retain the full review-only detail');
  assert.ok((evidence.evidenceAppendix || []).some(row => row.id === 'T0002' && row.text === longText), 'pool-only citations must reach the source appendix');
  const docxDraft = api.meetingAgentDraftForDocx(saved);
  const ordinaryXml = await documentXml(docxDraft, false);
  assert.equal(ordinaryXml, await documentXml(api.meetingAgentDraftForDocx(withoutPool), false));
  assert.equal(ordinaryXml.includes('ZETA-TAIL'), false);
  const evidenceXml = await documentXml(docxDraft, true);
  assert.ok(evidenceXml.includes('ZETA-TAIL.'), 'DOCX evidence must not clip the full detail');
  assert.ok(evidenceXml.includes('T0002'), 'DOCX source appendix must include pool-only evidence');
  assert.ok(evidenceXml.indexOf('The calibration review is complete.') < evidenceXml.indexOf('Send the calibration record.'),
    'main discussion/actions order must remain unchanged');
});

test('payload preserves distinct records sharing an ID instead of overwriting by ID', async () => {
  reset();
  saved.unassignedSupportingDetails = pool().map(row => ({ ...row, id: 'shared-detail-id' }));
  const expected = copy(saved.unassignedSupportingDetails);
  const after = await request('patch', '', { executiveSummary: saved.executiveSummary });
  assertPool(after.unassignedSupportingDetails, expected);
  assert.equal(after.unassignedSupportingDetails.length, 2);
  assert.notEqual(after.unassignedSupportingDetails[0].text, after.unassignedSupportingDetails[1].text);
  assert.notDeepEqual(after.unassignedSupportingDetails[0].evidenceIds, after.unassignedSupportingDetails[1].evidenceIds);
});

test('an unchanged detail sent both attached and in the pool is retained exactly once', async () => {
  reset();
  saved.unassignedSupportingDetails = [pool()[1]];
  const initial = await request('get');
  const discussion = copy(initial.discussion);
  discussion[0].points[0].supportingDetails = copy(initial.unassignedSupportingDetails);
  const after = await request('patch', '', { discussion, unassignedSupportingDetails: initial.unassignedSupportingDetails,
    reviewDecisionLabel: 'File existing review detail' });
  assert.equal(supportInventory(after).filter(row => row.id === 'unfiled-short').length, 1);
  assert.equal(after.discussion[0].points[0].supportingDetails[0].text, pool()[1].text);
  assertPool(after.unassignedSupportingDetails, []);
});

test('a newly unmatched supporting candidate reaches the review pool in full without main promotion', () => {
  reset();
  const text = longText.replaceAll('Calibration', 'Shipping').replaceAll('calibration', 'shipping');
  const sourceUnits = [...saved.sourceUnits, { id: 'T0004', speaker: 'Morgan Taylor', text }];
  const collected = [];
  const output = api.compactDiscussionPropositions(copy(saved.discussion), [], sourceUnits, {
    promoteMaterialSupporting: false,
    supportingCandidates: [{ candidate: { candidateId: 'new-shipping-context', text,
      evidenceIds: ['T0004'], reviewFlagIds: ['detail-review'], topic: 'Shipping context' } }],
    onUnassignedSupportingDetail(record, context) { collected.push({ ...record, ...context }); return true; }
  });
  assert.equal(collected.length, 1);
  assert.equal(collected[0].text, text);
  assert.deepEqual(collected[0].evidenceIds, ['T0004']);
  assert.deepEqual(collected[0].reviewFlagIds, ['detail-review']);
  assert.equal(collected[0].id, 'new-shipping-context');
  const visible = output.flatMap(topic => ['points', 'decisions', 'openQuestions'].flatMap(field => topic[field] || []));
  assert.deepEqual(visible.map(row => row.text), saved.discussion[0].points.map(row => row.text));
  assert.equal(supportInventory({ discussion: output }).some(row => row.text === text), false);
  const serialized = api.meetingAgentDraftPayload({ ...saved, sourceUnits,
    discussion: output, unassignedSupportingDetails: collected });
  assert.equal(serialized.unassignedSupportingDetails[0].text, text);
  assert.match(serialized.unassignedSupportingDetails[0].text, /ZETA-TAIL\.$/);
});

test('legacy undo snapshots without the new pool field preserve current unfiled context', async () => {
  reset();
  const legacy = api.meetingAgentReviewSnapshot(saved);
  delete legacy.unassignedSupportingDetails;
  legacy.executiveSummary = 'The earlier calibration summary was reviewed.';
  saved.changeHistory = [{ id: 'legacy-review', type: 'review_decision', label: 'Older summary edit',
    createdAt: '2026-10-20T09:00:00.000Z', beforeState: legacy }];
  const undone = await request('post', '/undo');
  assert.equal(undone.executiveSummary, legacy.executiveSummary);
  assertPool(undone.unassignedSupportingDetails, pool());
  const redone = await request('post', '/redo');
  assertPool(redone.unassignedSupportingDetails, pool());
  assert.equal(redone.executiveSummary, 'The calibration record was reviewed.');
});

test('a safely targeted supporting candidate beyond the parent cap is retained in the review pool', () => {
  reset();
  const discussion = copy(saved.discussion);
  const existing = Array.from({ length: 50 }, (_, index) => {
    const suffix = String.fromCharCode(97 + Math.floor(index / 26)) + String.fromCharCode(97 + index % 26);
    return detail(`sample-${suffix}`, `Calibration sample marker${suffix} has measured concentration ${index + 1} percent.`,
      [`T${String(index + 100).padStart(4, '0')}`]);
  });
  discussion[0].points[0].supportingDetails = existing;
  const incoming = { candidateId: 'overflow-sample', text: 'Calibration sample markerzz has measured concentration 91 percent.',
    evidenceIds: ['T0999'], reviewFlagIds: ['detail-review'], topic: 'Calibration review' };
  const sourceUnits = [...saved.sourceUnits,
    ...existing.map(row => ({ id: row.evidenceIds[0], speaker: 'Morgan Taylor', text: row.text })),
    { id: 'T0999', speaker: 'Morgan Taylor', text: incoming.text }];
  const collected = [];
  const output = api.compactDiscussionPropositions(discussion, [], sourceUnits, {
    promoteMaterialSupporting: false,
    supportingCandidates: [{ candidate: incoming, mergeTarget: 'main' }],
    onUnassignedSupportingDetail(record, context) { collected.push({ ...record, ...context }); return true; }
  });
  const attached = supportInventory({ discussion: output });
  assert.equal(attached.length, 50);
  assert.equal(collected.length, 1, 'the next legitimate detail must not vanish at the array cap');
  assert.equal(collected[0].id, incoming.candidateId);
  assert.equal(collected[0].text, incoming.text);
  assert.deepEqual(collected[0].evidenceIds, incoming.evidenceIds);
  assert.deepEqual(collected[0].reviewFlagIds, incoming.reviewFlagIds);
  assert.deepEqual(attached.map(row => row.id).sort(), existing.map(row => row.id).sort());
  assert.equal(new Set([...attached, ...collected].map(row => row.id)).size, 51);
  assert.equal(output.flatMap(topic => ['points', 'decisions', 'openQuestions'].flatMap(field => topic[field] || [])).length, 1,
    'overflow must not become an additional main proposition');
});

test('manual filing beyond fifty supporting records survives save and reload', async () => {
  reset();
  const existing = Array.from({ length: 50 }, (_, index) => {
    const suffix = String.fromCharCode(97 + Math.floor(index / 26)) + String.fromCharCode(97 + index % 26);
    return detail(`retained-${suffix}`, `Calibration sample marker${suffix} measured ${index + 1} percent concentration.`,
      [`T${String(index + 100).padStart(4, '0')}`], { reviewerAuthored: true });
  });
  saved.discussion[0].points[0].supportingDetails = existing;
  const last = detail('manual-fifty-one', 'Calibration sample markerzz measured 91 percent concentration.', ['T0999'], {
    originalTopic: 'Retained calibration measurements', placementReason: 'A reviewer must choose the parent.' });
  saved.unassignedSupportingDetails = [last];
  saved.sourceUnits.push(...existing.map(row => ({ id: row.evidenceIds[0], speaker: 'Morgan Taylor', text: row.text })),
    { id: 'T0999', speaker: 'Morgan Taylor', text: last.text });
  saved.preparedTranscript = V.preparedTranscriptFromUnits(saved.sourceUnits);
  const initial = await request('get');
  assert.equal(initial.discussion[0].points[0].supportingDetails.length, 50);
  const discussion = copy(initial.discussion);
  discussion[0].points[0].supportingDetails.push(copy(last));
  const filed = await request('patch', '', { discussion, unassignedSupportingDetails: [],
    reviewDecisionLabel: 'File an additional calibration measurement' });
  assert.equal(filed.discussion[0].points[0].supportingDetails.length, 51);
  assert.equal(filed.discussion[0].points[0].supportingDetails.find(row => row.id === last.id)?.text, last.text);
  assertPool(filed.unassignedSupportingDetails, []);
  const reloaded = await request('get');
  assert.equal(reloaded.discussion[0].points[0].supportingDetails.length, 51);
  const again = await request('patch', '', { discussion: reloaded.discussion });
  assert.equal(again.discussion[0].points[0].supportingDetails.length, 51);
  assert.equal(supportInventory(again).filter(row => row.id === last.id).length, 1);
});

test('filing preserves all ten valid citations instead of truncating to the generated-row budget', async () => {
  reset();
  const evidenceIds = Array.from({ length: 10 }, (_, index) => `T${String(index + 200).padStart(4, '0')}`);
  const record = detail('ten-citations', 'The calibration qualification is supported by retained source observations.', evidenceIds);
  saved.sourceUnits.push(...evidenceIds.map(id => ({ id, speaker: 'Morgan Taylor', text: record.text })));
  saved.preparedTranscript = V.preparedTranscriptFromUnits(saved.sourceUnits);
  saved.unassignedSupportingDetails = [record];
  const initial = await request('get');
  const discussion = copy(initial.discussion);
  discussion[0].points[0].supportingDetails = copy(initial.unassignedSupportingDetails);
  const filed = await request('patch', '', { discussion, unassignedSupportingDetails: [], reviewDecisionLabel: 'File all source-qualified context' });
  assert.deepEqual(filed.discussion[0].points[0].supportingDetails[0].evidenceIds, evidenceIds);
  assert.deepEqual(saved.discussion[0].points[0].supportingDetails[0].evidenceIds, evidenceIds);
  assert.deepEqual((await request('get')).discussion[0].points[0].supportingDetails[0].evidenceIds, evidenceIds);
});

for (const missing of ['flag', 'reviewer-lock']) {
  test(`a represented-text shadow cannot discard pool provenance missing its ${missing}`, () => {
    reset();
    const record = { ...pool()[1], reviewerAuthored: true, reviewFlagIds: ['detail-review'] };
    saved.unassignedSupportingDetails = [record];
    const attached = copy(record);
    if (missing === 'flag') attached.reviewFlagIds = [];
    else delete attached.reviewerAuthored;
    saved.discussion[0].points[0].supportingDetails = [attached];
    assertPool(withoutRepresentedUnassignedDetails(saved.unassignedSupportingDetails, saved.discussion), [record]);
    const payload = api.meetingAgentDraftPayload(saved);
    assertPool(payload.unassignedSupportingDetails, [record]);
    assert.equal(payload.unassignedSupportingDetails[0].reviewerAuthored, true);
    assert.deepEqual(payload.unassignedSupportingDetails[0].reviewFlagIds, ['detail-review']);
    assert.equal(payload.reviewFlags.find(row => row.id === 'detail-review')?.status, 'open');
  });
}

test('a represented shadow with complete citation/flag/lock coverage can leave the pool', () => {
  reset();
  const record = { ...pool()[1], reviewerAuthored: true, reviewFlagIds: ['detail-review'] };
  saved.unassignedSupportingDetails = [copy(record)];
  saved.discussion[0].points[0].supportingDetails = [copy(record)];
  const remaining = withoutRepresentedUnassignedDetails(saved.unassignedSupportingDetails, saved.discussion);
  assertPool(remaining, []);
  const payload = api.meetingAgentDraftPayload({ ...saved, unassignedSupportingDetails: remaining });
  assertPool(payload.unassignedSupportingDetails, []);
  assert.deepEqual(payload.discussion[0].points[0].supportingDetails[0].reviewFlagIds, ['detail-review']);
  assert.equal(payload.discussion[0].points[0].supportingDetails[0].reviewerAuthored, true);
});

test('discussion persistence treats absent and empty pools alike but detects genuine reviewer changes', () => {
  reset();
  const source = copy(saved);
  delete source.unassignedSupportingDetails;
  const fresh = { ...copy(source), unassignedSupportingDetails: [] };
  const generated = { discussion: copy(source.discussion), unassignedSupportingDetails: [pool()[1]] };
  const compatible = api.meetingAgentStagePersistenceChanges(source, fresh, 'discussion', generated);
  assert.deepEqual(compatible.conflictFields, []);
  assertPool(compatible.changes.unassignedSupportingDetails, [pool()[1]]);
  const edited = { ...copy(fresh), unassignedSupportingDetails: [pool()[0]] };
  const conflict = api.meetingAgentStagePersistenceChanges(source, edited, 'discussion', generated);
  assert.deepEqual(conflict.conflictFields, ['unassignedSupportingDetails']);
  assert.deepEqual(conflict.changes, {});
  assertPool(edited.unassignedSupportingDetails, [pool()[0]]);
});

test('unfiled merge history survives public reads, autosave, filing, undo/redo and reload', async () => {
  reset();
  const record = { ...pool()[0], mergedFromIds: ['earlier-calibration', 'earlier-qualification'] };
  saved.unassignedSupportingDetails = [copy(record)];
  const initial = await request('get');
  assert.deepEqual(initial.unassignedSupportingDetails[0].mergedFromIds, record.mergedFromIds);
  assert.equal(initial.unassignedSupportingDetails[0].reviewerAuthored, undefined, 'history does not mark a reviewer edit');
  assert.deepEqual(api.meetingAgentDraftPayload(saved).unassignedSupportingDetails[0].mergedFromIds, record.mergedFromIds);
  const autosaved = await request('patch', '', { executiveSummary: initial.executiveSummary });
  assertPool(autosaved.unassignedSupportingDetails, [record]);
  assertPool((await request('get')).unassignedSupportingDetails, [record]);

  const discussion = copy(autosaved.discussion);
  // The browser's file-supporting operation copies the full retained record
  // and explicitly attributes the chosen filing to the reviewer.
  const filedRecord = { ...copy(autosaved.unassignedSupportingDetails[0]), reviewerAuthored: true };
  delete filedRecord.placementReason;
  discussion[0].points[0].supportingDetails = [filedRecord];
  const filed = await request('patch', '', { discussion, unassignedSupportingDetails: [],
    reviewDecisionLabel: 'File calibration context with its merge history' });
  const assertFiled = draft => {
    const child = draft.discussion[0].points[0].supportingDetails[0];
    assert.deepEqual(child.mergedFromIds, record.mergedFromIds);
    assert.deepEqual(child.evidenceIds, record.evidenceIds);
    assert.deepEqual(child.reviewFlagIds, record.reviewFlagIds);
    assert.equal(child.text, record.text);
    assert.equal(child.reviewerAuthored, true);
    assertPool(draft.unassignedSupportingDetails, []);
  };
  assertFiled(filed);
  assertFiled(await request('get'));
  const undone = await request('post', '/undo');
  assertPool(undone.unassignedSupportingDetails, [record]);
  assert.equal(undone.discussion[0].points[0].supportingDetails.length, 0);
  assertFiled(await request('post', '/redo'));
  assertFiled(await request('get'));
});

test('PATCH retains unfiled history until a represented attached copy covers every predecessor', async () => {
  reset();
  const record = { ...pool()[1], mergedFromIds: ['earlier-archive', 'earlier-comparison'] };
  saved.unassignedSupportingDetails = [copy(record)];
  const initial = await request('get');
  const discussion = copy(initial.discussion);
  discussion[0].points[0].supportingDetails = [{ ...copy(record), mergedFromIds: ['earlier-archive'] }];
  const partial = await request('patch', '', { discussion, unassignedSupportingDetails: [record] });
  assertPool(partial.unassignedSupportingDetails, [record]);
  assertPool((await request('get')).unassignedSupportingDetails, [record]);
  const completeDiscussion = copy(partial.discussion);
  completeDiscussion[0].points[0].supportingDetails[0].mergedFromIds = [...record.mergedFromIds, 'another-predecessor'];
  const complete = await request('patch', '', { discussion: completeDiscussion, unassignedSupportingDetails: [record] });
  assertPool(complete.unassignedSupportingDetails, []);
  assert.deepEqual(complete.discussion[0].points[0].supportingDetails[0].mergedFromIds,
    [...record.mergedFromIds, 'another-predecessor']);
  assertPool((await request('get')).unassignedSupportingDetails, []);
});

function discussionRows(draft) {
  return (draft.discussion || []).flatMap(topic => ['points', 'decisions', 'openQuestions']
    .flatMap(field => topic[field] || []));
}

test('promoting a complete reviewer detail preserves its tail and provenance through PATCH, GET, undo and redo', async () => {
  reset();
  const retained = detail('promoted-context', longText, ['T0002'], {
    reviewerAuthored: true, mergedFromIds: ['earlier-context', 'earlier-qualification'],
    reviewFlagIds: ['detail-review']
  });
  saved.unassignedSupportingDetails = [];
  saved.discussion[0].mergedTopicIds = ['earlier-calibration-topic'];
  saved.discussion[0].points[0].supportingDetails = [copy(retained)];
  const initial = await request('get');
  const discussion = copy(initial.discussion);
  discussion[0].points[0].supportingDetails = [];
  discussion[0].points.push({ ...copy(retained), supportingDetails: [] });
  const promoted = await request('patch', '', { discussion, reviewDecisionLabel: 'Add retained calibration context to the minutes' });
  const assertPromoted = draft => {
    const row = discussionRows(draft).find(row => row.id === retained.id);
    assert.ok(row, 'the promoted record must remain a main proposition');
    assert.equal(row.text.length, longText.length, 'main normalization must retain the complete reviewer wording');
    assert.equal(row.text, longText);
    assert.match(row.text, /ZETA-TAIL\.$/);
    assert.equal(row.reviewerAuthored, true);
    assert.deepEqual(row.evidenceIds, retained.evidenceIds);
    assert.deepEqual(row.reviewFlagIds, retained.reviewFlagIds);
    assert.deepEqual(row.mergedFromIds, retained.mergedFromIds);
    assert.deepEqual(draft.discussion[0].mergedTopicIds, ['earlier-calibration-topic']);
    assert.equal([...discussionRows(draft), ...supportInventory(draft)].filter(row => row.id === retained.id).length, 1);
    assert.equal(draft.reviewFlags.find(flag => flag.id === 'detail-review')?.status, 'open');
  };
  assertPromoted(promoted);
  assertPromoted(saved);
  const pdfPoints = api.meetingAgentDraftForPdf(saved, false).discussion.flatMap(topic => topic.points);
  assert.equal(pdfPoints.filter(point => point === longText).length, 1, 'ordinary PDF projection includes the complete promoted point exactly once');
  assert.ok(pdfPoints.some(point => point.endsWith('ZETA-TAIL.')), 'ordinary PDF projection retains the final qualification');
  const ordinaryXml = await documentXml(api.meetingAgentDraftForDocx(saved), false);
  assert.ok(ordinaryXml.includes(longText), 'ordinary DOCX binary includes the complete promoted point');
  assert.ok(ordinaryXml.includes('ZETA-TAIL.'), 'ordinary DOCX binary retains the final qualification');
  assertPromoted(await request('get'));
  assert.equal(saved.changeHistory.at(-1).beforeState.discussion[0].points[0].supportingDetails[0].text, longText);
  const undone = await request('post', '/undo');
  assert.equal(discussionRows(undone).some(row => row.id === retained.id), false);
  const restored = supportInventory(undone).find(row => row.id === retained.id);
  assert.deepEqual(retainedIdentity(restored), retainedIdentity(retained));
  assert.deepEqual(restored.mergedFromIds, retained.mergedFromIds);
  assert.equal(restored.reviewerAuthored, true);
  assertPromoted(await request('post', '/redo'));
  assertPromoted(await request('get'));
});

test('reviewer PATCH retains fifty-one rows in every discussion category through reload, undo and redo', async () => {
  reset();
  saved.unassignedSupportingDetails = [];
  const initial = await request('get');
  const discussion = copy(initial.discussion);
  for (const field of ['points', 'decisions', 'openQuestions']) {
    discussion[0][field] = Array.from({ length: 51 }, (_, index) => {
      const evidenceId = `T${String(saved.sourceUnits.length + 1).padStart(4, '0')}`;
      const wording = `Calibration ${field} record ${index + 1} retains the reviewer inspection qualification.`;
      saved.sourceUnits.push({ id: evidenceId, speaker: 'Morgan Taylor', text: wording });
      return detail(`${field}-retained-${index + 1}`, wording, [evidenceId], {
        mergedFromIds: [`${field}-predecessor-${index + 1}`],
        reviewFlagIds: index === 50 ? ['detail-review'] : []
      });
    });
  }
  saved.preparedTranscript = V.preparedTranscriptFromUnits(saved.sourceUnits);
  const expected = discussionRows({ discussion }).map(retainedIdentity);
  const assertRetained = draft => {
    for (const field of ['points', 'decisions', 'openQuestions']) {
      assert.equal(draft.discussion[0][field].length, 51, `all reviewer ${field} must survive`);
      assert.ok(draft.discussion[0][field].every(row => row.reviewerAuthored === true));
      assert.deepEqual(draft.discussion[0][field].map(row => row.mergedFromIds),
        discussion[0][field].map(row => row.mergedFromIds));
    }
    assert.deepEqual(discussionRows(draft).map(retainedIdentity), expected);
    assert.equal(new Set(discussionRows(draft).map(row => row.id)).size, 153, 'retain every occurrence exactly once');
    assert.equal(draft.reviewFlags.find(flag => flag.id === 'detail-review')?.status, 'open');
  };
  assertRetained(await request('patch', '', { discussion, reviewDecisionLabel: 'Retain all reviewed calibration records' }));
  assertRetained(saved);
  assertRetained(await request('get'));
  const undone = await request('post', '/undo');
  assert.deepEqual(mainContent(undone), mainContent(initial));
  assertRetained(await request('post', '/redo'));
  const reloaded = await request('get');
  assertRetained(reloaded);
  assertRetained(await request('patch', '', { discussion: reloaded.discussion }));
});

test('reviewer PATCH retains an eighty-first topic through reload, undo and redo', async () => {
  reset();
  saved.unassignedSupportingDetails = [];
  saved.discussion = Array.from({ length: 80 }, (_, index) => ({
    id: `retained-topic-${index + 1}`, topic: `Calibration record ${index + 1}`,
    points: [detail(`retained-point-${index + 1}`, saved.sourceUnits[0].text, ['T0001'])],
    decisions: [], openQuestions: []
  }));
  const initial = await request('get');
  assert.equal(initial.discussion.length, 80);
  const discussion = copy(initial.discussion);
  discussion.push({ id: 'retained-topic-81', topic: 'Reviewer calibration qualification',
    mergedTopicIds: ['previous-qualification-topic'],
    points: [detail('retained-point-81', saved.sourceUnits[2].text, ['T0003'], {
      reviewFlagIds: ['detail-review'], mergedFromIds: ['previous-qualification-point']
    })], decisions: [], openQuestions: [] });
  const assertRetained = draft => {
    assert.equal(draft.discussion.length, 81);
    assert.deepEqual(draft.discussion.map(topic => topic.id), discussion.map(topic => topic.id));
    assert.equal(discussionRows(draft).filter(row => row.id === 'retained-point-81').length, 1);
    assert.equal(draft.discussion.at(-1).reviewerAuthored, true);
    assert.deepEqual(draft.discussion.at(-1).mergedTopicIds, ['previous-qualification-topic']);
    assert.deepEqual(draft.discussion.at(-1).points[0].mergedFromIds, ['previous-qualification-point']);
    assert.deepEqual(draft.discussion.at(-1).points[0].evidenceIds, ['T0003']);
    assert.deepEqual(draft.discussion.at(-1).points[0].reviewFlagIds, ['detail-review']);
  };
  assertRetained(await request('patch', '', { discussion, reviewDecisionLabel: 'Retain another reviewer topic' }));
  assertRetained(saved);
  assertRetained(await request('get'));
  assert.equal((await request('post', '/undo')).discussion.length, 80);
  assertRetained(await request('post', '/redo'));
  assertRetained(await request('get'));
});

test('full reviewer wording requires the save boundary and authorship; generated budgets and sanitization remain', () => {
  reset();
  const candidate = { discussion: [{ id: 'bounded-topic', topic: 'Calibration review', points: [
    detail('bounded-long', longText, ['T0002', 'T9999'], {
      reviewerAuthored: true, confirmedTopic: true, mergedFromIds: ['old-calibration'],
      primaryEvidenceIds: ['T0002', 'T9999'], arbitraryClientProperty: 'discard me'
    })
  ], decisions: [], openQuestions: [] }], actions: [] };
  const options = { enforceEvidence: false, dedupeActions: false, mergeTopics: false };
  const authored = V.normaliseAgentResult(copy(candidate), saved.sourceUnits, '', { ...options, preserveReviewerEdits: true });
  assert.equal(authored.discussion[0].points[0].text, longText);
  assert.equal(authored.discussion[0].points[0].id, 'bounded-long');
  assert.deepEqual(authored.discussion[0].points[0].evidenceIds, ['T0002']);
  assert.deepEqual(authored.discussion[0].points[0].primaryEvidenceIds, ['T0002']);
  assert.equal(authored.discussion[0].points[0].arbitraryClientProperty, undefined);
  const generated = V.normaliseAgentResult(copy(candidate), saved.sourceUnits, '', options).discussion[0].points[0];
  assert.equal(generated.text.length, 1600);
  assert.equal(generated.reviewerAuthored, undefined);
  assert.equal(generated.confirmedTopic, undefined);
  assert.equal(generated.mergedFromIds, undefined);
  delete candidate.discussion[0].points[0].reviewerAuthored;
  const unchanged = V.normaliseAgentResult(copy(candidate), saved.sourceUnits, '', { ...options, preserveReviewerEdits: true });
  assert.equal(unchanged.discussion[0].points[0].text.length, 1600, 'an unchanged generated row does not gain the text exemption');
  candidate.discussion[0].points = Array.from({ length: 51 }, (_, index) =>
    detail(`bounded-${index + 1}`, `Calibration sample ${index + 1} has a retained measurement.`, ['T0001'], { reviewerAuthored: true }));
  assert.equal(V.normaliseAgentResult(copy(candidate), saved.sourceUnits, '', options).discussion[0].points.length, 50);
  candidate.discussion = Array.from({ length: 81 }, (_, index) => ({
    ...copy(candidate.discussion[0]), id: `bounded-topic-${index + 1}`, topic: `Calibration sample ${index + 1}`,
    points: [copy(candidate.discussion[0].points[0])]
  }));
  assert.equal(V.normaliseAgentResult(copy(candidate), saved.sourceUnits, '', options).discussion.length, 80);
});
