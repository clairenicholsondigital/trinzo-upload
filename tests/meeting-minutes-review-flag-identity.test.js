'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');
const evidenceContext = require('../utils/meetingMinutesEvidenceContext');
const actionEvidence = require('../utils/meetingMinutesActionEvidence');
const evidenceResolution = require('../utils/meetingMinutesEvidenceResolution');
const peopleEvidence = require('../utils/meetingMinutesPeopleEvidence');
const actionDiagnostics = require('../utils/meetingMinutesActionDiagnostics');
const reviewFlags = require('../utils/meetingMinutesReviewFlags');
const { actionTimingIssueFlag } = require('../utils/meetingMinutesTimingFlags');

// Exercise the actual save/load/undo handlers and JSON payload serializer with
// an in-memory store. These regressions must never reach a DB or provider.
process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1 = '0';
const fetchModule = require.resolve('node-fetch');
require(fetchModule);
const originalFetch = require.cache[fetchModule].exports;
let providerCalls = 0;
require.cache[fetchModule].exports = async () => {
  providerCalls += 1;
  throw new Error('Provider calls are forbidden in flag-identity regressions');
};
const db = require('../utils/db');
const originalGet = db.getMeetingMinutesAgentDraft;
const originalUpdate = db.updateMeetingMinutesAgentDraft;
const copy = value => JSON.parse(JSON.stringify(value));
let saved, writes;
db.getMeetingMinutesAgentDraft = async () => copy(saved);
db.updateMeetingMinutesAgentDraft = async (id, userId, revision, updates) => {
  assert.equal(id, saved.draftId);
  assert.equal(userId, 'flag-identity-reviewer');
  assert.equal(revision, saved.revision);
  saved = copy({ ...saved, ...V.migrateDraftPayload(updates.payload),
    revision: revision + 1, status: updates.status || saved.status });
  writes += 1;
  return copy(saved);
};
const router = require('../routes/api');
db.getMeetingMinutesAgentDraft = originalGet;
db.updateMeetingMinutesAgentDraft = originalUpdate;
require.cache[fetchModule].exports = originalFetch;

const sourceUnits = [{ id: 'T0001', speaker: 'Morgan Taylor',
  text: 'Morgan Taylor will review the inspection report and send the laboratory summary.' }];
const message = 'Check the disputed source timing before publishing.';
const flag = (id, values = {}) => ({ id, kind: 'timing', message,
  evidenceIds: ['T0001'], status: 'open', correctionNote: '', ...values });
const action = (id, wording, flagId) => ({ id, action: wording,
  owners: ['Morgan Taylor'], evidenceIds: ['T0001'], reviewFlagIds: [flagId],
  timing: { kind: 'not_stated', wording: '', exactDate: '' } });

function reset(flags) {
  saved = { draftId: 'flag-identity-draft', revision: 1, status: 'draft', payloadVersion: V.PAYLOAD_VERSION,
    details: { meetingTitle: 'Equipment review', meetingType: 'General', meetingDate: '2026-10-21' },
    sourceUnits: copy(sourceUnits), preparedTranscript: V.preparedTranscriptFromUnits(sourceUnits),
    discussion: [], actions: [action('inspection', 'Review the inspection report.', 'flag-one'),
      action('laboratory', 'Send the laboratory summary.', 'flag-two')],
    executiveSummary: '', meetingObjectives: [], reviewFlags: copy(flags),
    changeHistory: [], redoHistory: [], staleStages: [], currentStep: 5, selectedStep: 5,
    qualityState: { preparation: { dateContext: { source: 'reviewer', meetingDate: '2026-10-21' } } } };
  writes = 0;
}

async function request(method, suffix = '', body = {}) {
  const path = `/meeting-minutes-agent/drafts/:draftId${suffix}`;
  const route = router.stack.find(layer => layer.route?.path === path && layer.route.methods[method])?.route;
  assert.ok(route, `missing ${method} ${path}`);
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  await route.stack.at(-1).handle({ params: { draftId: saved.draftId }, authUser: { userId: 'flag-identity-reviewer' },
    body: { revision: saved.revision, ...body } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(providerCalls, 0);
  assertResolvedFlagReferences(res.body.draft);
  return res.body.draft;
}

function assertResolvedFlagReferences(draft) {
  const ids = new Set((draft.reviewFlags || []).map(row => row.id));
  assert.equal(ids.size, draft.reviewFlags.length, 'flag IDs must remain unique');
  const walk = value => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== 'object') return;
    for (const id of value.reviewFlagIds || []) assert.ok(ids.has(id), `unresolved review flag reference: ${id}`);
    for (const key of ['actions', 'discussion', 'points', 'decisions', 'openQuestions', 'supportingDetails']) {
      if (Array.isArray(value[key])) walk(value[key]);
    }
  };
  walk(draft);
}

function assertActionLinks(draft) {
  assert.deepEqual(draft.actions.find(row => row.id === 'inspection')?.reviewFlagIds, ['flag-one'],
    'the first row must retain its own review decision');
  assert.deepEqual(draft.actions.find(row => row.id === 'laboratory')?.reviewFlagIds, ['flag-two'],
    'the second row must retain its own review decision');
}

for (const status of ['confirmed', 'corrected', 'dismissed']) {
  for (const reversed of [false, true]) {
    test(`actual PATCH/reload preserves separate ${status} and open decisions (${reversed ? 'reverse' : 'forward'} order)`, async () => {
      const flags = [flag('flag-one', { status, correctionNote: 'Reviewed the inspection issue.' }), flag('flag-two')];
      reset(reversed ? [...flags].reverse() : flags);
      let loaded = await request('get');
      assertActionLinks(loaded);
      for (let save = 0; save < 3; save += 1) {
        const after = await request('patch', '', { actions: loaded.actions, reviewFlags: loaded.reviewFlags });
        assert.equal(saved.reviewFlags.find(row => row.id === 'flag-two')?.status, 'open',
          'an unresolved warning cannot be dismissed because another row was already reviewed');
        assertActionLinks(saved);
        assertActionLinks(after);
        const reloaded = await request('get');
        assertActionLinks(reloaded);
        assert.equal(reloaded.reviewFlags.find(row => row.id === 'flag-one')?.status, status);
        assert.equal(reloaded.reviewFlags.find(row => row.id === 'flag-one')?.correctionNote, 'Reviewed the inspection issue.');
        loaded = reloaded;
      }
      assert.equal(writes, 3);
    });
  }
}

for (const reversed of [false, true]) {
  test(`actual PATCH preserves distinct correction notes and nested references (${reversed ? 'reverse' : 'forward'} order)`, async () => {
    const flags = [flag('flag-one', { status: 'corrected', correctionNote: 'Inspection checked.' }),
      flag('flag-two', { status: 'corrected', correctionNote: 'Laboratory checked.' })];
    reset(reversed ? [...flags].reverse() : flags);
    saved.sourceUnits.push({ id: 'T0002', speaker: 'Morgan Taylor',
      text: 'The inspection report is incomplete. The laboratory summary is a controlled document.' });
    saved.preparedTranscript = V.preparedTranscriptFromUnits(saved.sourceUnits);
    saved.discussion = [{ id: 'equipment', topic: 'Equipment', points: [{ id: 'point',
      text: 'The inspection report is incomplete.', evidenceIds: ['T0002'], reviewFlagIds: ['flag-one'],
      supportingDetails: [{ id: 'detail', text: 'The laboratory summary is a controlled document.', evidenceIds: ['T0002'], reviewFlagIds: ['flag-two'] }] }],
      decisions: [], openQuestions: [] }];
    const loaded = await request('get');
    await request('patch', '', { actions: loaded.actions, discussion: loaded.discussion, reviewFlags: loaded.reviewFlags });
    assertActionLinks(saved);
    assert.deepEqual(saved.discussion[0].points[0].reviewFlagIds, ['flag-one']);
    assert.deepEqual(saved.discussion[0].points[0].supportingDetails[0].reviewFlagIds, ['flag-two']);
    const after = await request('get');
    assert.equal(after.reviewFlags.find(row => row.id === 'flag-one')?.correctionNote, 'Inspection checked.');
    assert.equal(after.reviewFlags.find(row => row.id === 'flag-two')?.correctionNote, 'Laboratory checked.');
  });
}

test('actual PATCH preserves separate timing origins even when display text and review state match', async () => {
  reset([]);
  const flags = saved.actions.map((row, index) => flag(index ? 'flag-two' : 'flag-one',
    actionTimingIssueFlag({ code: 'timing_source_unresolved' }, row, message)));
  flags[0].id = 'flag-one';
  flags[1].id = 'flag-two';
  saved.reviewFlags = flags;
  const loaded = await request('get');
  await request('patch', '', { actions: loaded.actions, reviewFlags: loaded.reviewFlags });
  assertActionLinks(saved);
  assert.equal(saved.reviewFlags.find(row => row.id === 'flag-two')?.status, 'open');
  const after = await request('get');
  assertActionLinks(after);
  assert.notDeepEqual(after.reviewFlags[0].systemTimingIssue.origin, after.reviewFlags[1].systemTimingIssue.origin);
});

test('actual undo and redo restore each warning together with the row it reviews', async () => {
  reset([flag('flag-one'), flag('flag-two')]);
  const initial = await request('get');
  const flags = initial.reviewFlags.map(row => row.id === 'flag-one'
    ? { ...row, status: 'confirmed', correctionNote: 'Confirmed inspection timing.' } : row);
  await request('patch', '', { actions: initial.actions, reviewFlags: flags, reviewDecisionLabel: 'Confirm inspection timing' });
  assertActionLinks(saved);
  assert.equal(saved.reviewFlags.find(row => row.id === 'flag-one')?.status, 'confirmed');
  await request('post', '/undo');
  assertActionLinks(saved);
  assert.equal(saved.reviewFlags.find(row => row.id === 'flag-one')?.status, 'open');
  assert.equal(saved.reviewFlags.find(row => row.id === 'flag-two')?.status, 'open');
  await request('post', '/redo');
  assertActionLinks(saved);
  const loaded = await request('get');
  assertActionLinks(loaded);
  assert.equal(loaded.reviewFlags.find(row => row.id === 'flag-one')?.status, 'confirmed');
  assert.equal(loaded.reviewFlags.find(row => row.id === 'flag-one')?.correctionNote, 'Confirmed inspection timing.');
  assert.equal(loaded.reviewFlags.find(row => row.id === 'flag-two')?.status, 'open');
});

const normalise = values => {
  const result = V.normaliseAgentResult(values, sourceUnits, '', {
    enforceEvidence: false, dedupeActions: false, mergeTopics: false, preserveReviewerEdits: true,
    meetingDate: '2026-10-21'
  });
  assertResolvedFlagReferences(result);
  return result;
};

for (const values of [
  [{ correctionNote: 'Inspection pending.' }, { correctionNote: 'Laboratory pending.' }],
  [{ correctionNote: 'Checked.' }, { correctionNote: 'checked.' }],
  [{ reviewerAuthored: true }, {}],
  [{ temporalField: 'executiveSummary' }, { temporalField: 'meetingObjectives' }],
  [{ status: 'confirmed', correctionNote: 'Checked.' }, { status: 'confirmed', correctionNote: 'Checked.' }]
]) {
  for (const reversed of [false, true]) {
    test(`normalization preserves distinct incoming decisions or origins ${JSON.stringify(values)} (${reversed ? 'reverse' : 'forward'})`, () => {
      const flags = [flag('flag-one', values[0]), flag('flag-two', values[1])];
      const out = normalise({ actions: [action('inspection', 'Review the inspection report.', 'flag-one'),
        action('laboratory', 'Send the laboratory summary.', 'flag-two')], reviewFlags: reversed ? [...flags].reverse() : flags });
      assertActionLinks(out);
      assert.equal(out.reviewFlags.length, 2);
      for (const input of flags) assert.deepEqual(out.reviewFlags.find(row => row.id === input.id), V.normaliseFlag(input));
    });
  }
}

test('identical untouched automatic duplicates still share one warning, including supporting detail references', () => {
  const out = normalise({ reviewFlags: [flag('flag-one'), flag('flag-two')],
    actions: [action('inspection', 'Review the inspection report.', 'flag-one'),
      action('laboratory', 'Send the laboratory summary.', 'flag-two')],
    discussion: [{ topic: 'Equipment', points: [{ text: sourceUnits[0].text, evidenceIds: ['T0001'],
      reviewFlagIds: ['flag-one'], supportingDetails: [{ text: 'Review the inspection report.',
        evidenceIds: ['T0001'], reviewFlagIds: ['flag-two'] }] }] }] });
  assert.equal(out.reviewFlags.length, 1);
  assert.deepEqual(out.actions.map(row => row.reviewFlagIds), [['flag-one'], ['flag-one']]);
  assert.deepEqual(out.discussion[0].points[0].supportingDetails[0].reviewFlagIds, ['flag-one']);
});

const unsupportedMessage = 'No transcript passage clearly supports "Collect the lunar rock samples.". Check it, or delete it if it was not said.';
function unsupportedAction(id, flagId) {
  return { id, action: 'Collect the lunar rock samples.', owners: [], evidenceIds: [],
    reviewFlagIds: flagId ? [flagId] : [], timing: { kind: 'not_stated', wording: '', exactDate: '' } };
}

for (const status of ['confirmed', 'corrected', 'dismissed']) {
  test(`regenerated validation does not reopen the same ${status} warning or overwrite its registry state`, () => {
    let input = { actions: [unsupportedAction('moon', 'reviewed-missing-evidence')], reviewFlags: [{
      id: 'reviewed-missing-evidence', kind: 'missing_evidence', message: unsupportedMessage,
      evidenceIds: [], status, correctionNote: 'Source checked by the reviewer.' }] };
    for (let save = 0; save < 3; save += 1) {
      const out = normalise(copy(input));
      assert.equal(out.reviewFlags.length, 1);
      assert.equal(out.reviewFlags[0].id, 'reviewed-missing-evidence');
      assert.equal(out.reviewFlags[0].status, status);
      assert.equal(out.reviewFlags[0].correctionNote, 'Source checked by the reviewer.');
      assert.deepEqual(out.actions[0].reviewFlagIds, ['reviewed-missing-evidence']);
      const recovered = V.reconcileRecordFlags({ actions: out.actions }, []);
      assert.equal(recovered.flags[0].status, status);
      input = out;
    }
  });
}

test('a new row with the same validation problem does not inherit another row\'s review decision', () => {
  const out = normalise({ actions: [unsupportedAction('reviewed-moon', 'reviewed-missing-evidence'), unsupportedAction('new-moon')],
    reviewFlags: [{ id: 'reviewed-missing-evidence', kind: 'missing_evidence', message: unsupportedMessage,
      evidenceIds: [], status: 'confirmed', correctionNote: 'Only the earlier row was checked.' }] });
  assert.equal(out.reviewFlags.length, 2);
  assert.deepEqual(out.actions[0].reviewFlagIds, ['reviewed-missing-evidence']);
  const open = out.reviewFlags.find(row => row.status === 'open');
  assert.ok(open);
  assert.deepEqual(out.actions[1].reviewFlagIds, [open.id]);
  assert.notEqual(open.id, 'reviewed-missing-evidence');
});

test('repeated unresolved validation still collapses to one automatic warning', () => {
  let input = { actions: [unsupportedAction('moon-one'), unsupportedAction('moon-two')], reviewFlags: [] };
  for (let save = 0; save < 3; save += 1) {
    const out = normalise(copy(input));
    assert.equal(out.reviewFlags.length, 1);
    assert.equal(out.reviewFlags[0].status, 'open');
    assert.deepEqual(out.actions.map(row => row.reviewFlagIds), [[out.reviewFlags[0].id], [out.reviewFlags[0].id]]);
    input = out;
  }
});

test('an exactly repeated deterministic system flag keeps its reviewed state in the result and registry', async () => {
  assert.equal(V.resolveEvidence, evidenceResolution.resolveEvidence, 'V2 uses the actual evidence resolver');
  for (const name of ['actionEvidenceDisposition', 'actionNegatedByEvidence', 'isLiveCallConduct', 'isMeetingAdminAction', 'isMeetingAdminShare']) {
    assert.equal(V[name], actionEvidence[name], `${name} has one action-evidence owner`);
  }
  for (const name of ['assignsWorkTo', 'ownerAssignedInMeeting', 'addressedRequestAccepted', 'applyRequesterOwnerRule',
    'groundRowAttributions', 'flagConflictingDiscussionRoles']) {
    assert.equal(V[name], peopleEvidence[name], `${name} has one people-evidence owner`);
  }
  for (const name of ['normaliseFlag', 'reconcileRecordFlags', 'reconcileUsefulRecordFlags', 'isSalientCoverageFlag', 'isUsefulReviewFlag']) {
    assert.equal(V[name], reviewFlags[name], `${name} must have one shared owner`);
  }
  const units = [{ id: 'T0001', speaker: 'Morgan Taylor', text: 'I will review the inspection report.', classification: 'keep' },
    { id: 'T0002', speaker: 'Morgan Taylor', text: 'I will call the courier tomorrow.', classification: 'keep' }];
  const options = { meetingDate: '2026-10-21', dedupeActions: false };
  const generated = V.normaliseAgentResult({ actions: [{ ...action('inspection', 'Review the inspection report.', ''),
    evidenceIds: ['T0001', 'T0002'], reviewFlagIds: [] }] }, units, 'actions', options);
  const warning = generated.reviewFlags.find(row => row.systemTimingIssue?.code === 'timing_inference_unresolved');
  assert.ok(warning);
  for (const status of ['confirmed', 'corrected', 'dismissed']) {
    const reviewed = { ...generated, reviewFlags: [{ ...warning, status, correctionNote: 'Reviewed the source binding.' }] };
    const out = V.normaliseAgentResult(copy(reviewed), units, 'actions', options);
    assert.equal(out.reviewFlags.length, 1);
    assert.equal(out.reviewFlags[0].id, warning.id, 'the regenerated warning uses this exact deterministic ID');
    assert.equal(out.reviewFlags[0].status, status);
    const recovered = reviewFlags.reconcileRecordFlags({ actions: out.actions }, []);
    assert.equal(recovered.flags[0].status, status, 'the registry must recover the reviewed value after regeneration');
    assert.equal(recovered.flags[0].correctionNote, 'Reviewed the source binding.');
    const directlyReviewed = reviewFlags.normaliseFlag({ ...warning, status, correctionNote: 'Reviewed the source binding.' });
    assert.equal(V.reconcileRecordFlags({ actions: out.actions }, []).flags[0], directlyReviewed,
      'compatibility callers recover the flag remembered by a direct owner caller');
    for (const name of ['clearMeetingMinutesAgentV2MemoryCaches', 'evidenceContextFor',
      'preparedTranscriptFromUnits', 'evidenceWindowUnits', 'evidenceWindowText',
      'comparisonText', 'materialTokens', 'explicitValuePresent', 'evidenceSupportScore']) {
      assert.equal(V[name], evidenceContext[name], `${name} is the same owner function through V2`);
    }
    const context = evidenceContext.evidenceContextFor(units);
    assert.equal(V.evidenceContextFor(units), context, 'evidence context is memoized before the reset');
    assert.notEqual(evidenceContext.evidenceContextFor(copy(units)), context, 'separate arrays have separate contexts');
    const previousRows = context.rows;
    const resolveBoth = () => {
      const direct = evidenceResolution.resolveEvidence('Review the inspection report.', units, ['T0001'], { action: true });
      assert.deepEqual(V.resolveEvidence('Review the inspection report.', units, ['T0001'], { action: true }), direct);
      return direct;
    };
    const beforeReset = await actionDiagnostics.capture(resolveBoth);
    assert.ok(context.resolutionCache.size > 0, 'the resolver stores results in the shared evidence context');
    const beforeEvents = beforeReset.audit.events.filter(event => event.kind === 'evidence_selected');
    assert.equal(beforeEvents.length, 2, 'direct and V2 calls use the same private diagnostics context');
    assert.equal(beforeEvents[1].reason, 'resolution_cache_hit', 'V2 reuses the result cached by the direct owner');
    assert.deepEqual(V.clearMeetingMinutesAgentV2MemoryCaches(), { evidenceContexts: 'reset' });
    const resetContext = evidenceContext.evidenceContextFor(units);
    assert.notEqual(resetContext, context, 'the reset discards the evidence context through both entrypoints');
    assert.equal(V.evidenceContextFor(units), resetContext, 'V2 and the owner share the replacement cache');
    assert.equal(resetContext.resolutionCache.size, 0, 'resetting the context also discards resolver results');
    const afterReset = await actionDiagnostics.capture(resolveBoth);
    const afterEvents = afterReset.audit.events.filter(event => event.kind === 'evidence_selected');
    assert.equal(afterEvents.length, 2);
    assert.notEqual(afterEvents[0].reason, 'resolution_cache_hit', 'the direct owner recomputes after the compatibility reset');
    assert.equal(afterEvents[1].reason, 'resolution_cache_hit');
    assert.deepEqual(afterReset.value, beforeReset.value, 'recomputing keeps the same evidence decision');
    assert.equal(context.rows, previousRows, 'in-flight callers retain the original context');
    assert.deepEqual(evidenceContext.clearMeetingMinutesAgentV2MemoryCaches(), { evidenceContexts: 'reset' });
    assert.notEqual(V.evidenceContextFor(units), resetContext, 'a direct owner reset also clears V2 contexts');
    assert.equal(reviewFlags.reconcileRecordFlags({ actions: out.actions }, []).flags[0], directlyReviewed,
      'resetting evidence contexts preserves the shared review flag registry');

    reset([]);
    saved.sourceUnits = copy(units);
    saved.preparedTranscript = V.preparedTranscriptFromUnits(units);
    saved.actions = copy(reviewed.actions);
    saved.reviewFlags = copy(reviewed.reviewFlags);
    for (let save = 0; save < 3; save += 1) {
      const loaded = await request('get');
      await request('patch', '', { actions: loaded.actions, reviewFlags: loaded.reviewFlags });
      assert.equal(saved.reviewFlags.length, 1, 'autosave cannot add an open copy of a handled warning');
      assert.equal(saved.reviewFlags[0].id, warning.id);
      assert.equal(saved.reviewFlags[0].status, status);
      assert.equal(saved.reviewFlags[0].correctionNote, 'Reviewed the source binding.');
      assert.deepEqual(saved.actions[0].reviewFlagIds, [warning.id]);
    }
  }
});


test('actual save/reload and undo/redo preserve original check wording and a human decision', async () => {
  reset([flag('flag-one', { actionWordingAtCheck: 'Inspect the original pressure report.', status:'corrected', correctionNote:'Confirmed the revised scope.' }), flag('flag-two')]);
  const original = copy(saved.reviewFlags[0]);
  const loaded = await request('get');
  const actions = copy(loaded.actions);
  actions[0].action = 'Review the revised inspection report.';
  const after = await request('patch', '', { actions, reviewFlags: loaded.reviewFlags, reviewDecisionLabel: 'Clarify action wording' });
  assert.deepEqual(after.reviewFlags.find(flag => flag.id === original.id), original);
  const undone = await request('post', '/undo');
  assert.deepEqual(undone.reviewFlags.find(flag => flag.id === original.id), original);
  const redone = await request('post', '/redo');
  assert.deepEqual(redone.reviewFlags.find(flag => flag.id === original.id), original);
});

test('actual automatic proposal route preserves document uncertainty through save/reload and review undo/redo', async () => {
  reset([]);
  saved.sourceUnits=V.normaliseSourceUnits([
    {id:'T0001',speaker:'Maya Patel',text:'The standard is 74216, covering portable pump requirements.'},
    {id:'T0002',speaker:'Maya Patel',text:'We can maybe get an assessment of that standard to see if it is applicable to the portable pump.'}
  ]);
  saved.preparedTranscript=V.preparedTranscriptFromUnits(saved.sourceUnits);
  saved.actions=[];
  const rows=router.stagedEvaluation.normaliseAgentDeclaredProposals({actionProposals:[{
    id:'assessment',action:'Assess whether ISO 74216 is applicable to the portable pump.',owners:['Maya Patel'],
    evidenceIds:['T0002'],reviewFlagIds:[],timing:{kind:'not_stated',wording:'',exactDate:''}
  }]},saved.sourceUnits);
  saved.reviewFlags=V.reconcileRecordFlags({actions:rows},[]).flags.filter(flag=>flag.documentReferenceContext);
  const original=copy(saved.reviewFlags[0]);
  saved.pendingProposal=V.buildProposal('actions',[],rows);
  saved.pendingProposal.changes.forEach(change=>change.selected=true);
  const after=await request('post','/proposal',{decision:'accept',automatic:true,acceptAll:true});
  assert.equal(after.actions.length,0);assert.equal(after.pendingProposal,null);
  assert.equal(after.reviewFlags.length,1);
  const loaded=await request('get');
  assert.deepEqual(loaded.reviewFlags[0].documentReferenceContext,original.documentReferenceContext);
  assert.equal(loaded.reviewFlags[0].id,original.id);
  assert.equal(loaded.reviewFlags[0].status,'open');
  const flags=copy(loaded.reviewFlags);flags[0].status='corrected';flags[0].correctionNote='Confirmed the identity; correction still requires a human edit.';
  await request('patch','',{reviewFlags:flags,reviewDecisionLabel:'Review document identity'});
  const undone=await request('post','/undo');assert.equal(undone.reviewFlags[0].status,'open');
  assert.deepEqual(undone.reviewFlags[0].documentReferenceContext,original.documentReferenceContext);
  const redone=await request('post','/redo');assert.equal(redone.reviewFlags[0].correctionNote,flags[0].correctionNote);
  assert.equal(redone.actions.length,0);
});

test('a source-only assessment question survives real persistence without inventing an action', async () => {
  reset([]);
  saved.sourceUnits=V.normaliseSourceUnits([{id:'T0001',speaker:'Maya Patel',text:'We can maybe get an assessment of that standard for the portable pump.'}]);
  saved.preparedTranscript=V.preparedTranscriptFromUnits(saved.sourceUnits);saved.actions=[];
  const out=V.normaliseAgentResult({reviewFlags:[{type:'unsupported_ownership',detail:'An assessment is requested but no owner is confirmed.',evidenceIds:['T0001']}]},saved.sourceUnits,'actions');
  saved.reviewFlags=out.reviewFlags;
  const original=copy(saved.reviewFlags[0]);assert.ok(original.sourceReviewContext);
  const loaded=await request('get');assert.deepEqual(loaded.reviewFlags[0],original);
  await request('patch','',{reviewFlags:loaded.reviewFlags});
  const reloaded=await request('get');assert.deepEqual(reloaded.reviewFlags[0],original);
  assert.equal(reloaded.actions.length,0);
});

test('background same-message warnings retain separate evidence through review, reload and undo/redo',async()=>{
 reset([flag('flag-one',{kind:'ownership',message:'Confirm the owner of this action.',evidenceIds:['T0001']}),
  flag('flag-two',{kind:'ownership',message:'Confirm the owner of this action.',evidenceIds:['T0002']})]);
 saved.sourceUnits=V.normaliseSourceUnits([{id:'T0001',speaker:'Morgan Taylor',text:'I will review the inspection report.'},
  {id:'T0002',speaker:'Morgan Taylor',text:'I will send the laboratory summary.'}]);
 saved.preparedTranscript=V.preparedTranscriptFromUnits(saved.sourceUnits);saved.actions[1].evidenceIds=['T0002'];
 await router.stagedEvaluation.persistMeetingAgentBackgroundStage({draftId:saved.draftId,userId:'flag-identity-reviewer',stage:'actions',sourceDraft:copy(saved),
  result:{changes:{actions:copy(saved.actions)},reviewFlags:copy(saved.reviewFlags)},wait:async()=>{},getDraft:async()=>copy(saved),
  saveDraft:async(fresh,changes)=>{saved=copy({...fresh,...changes,revision:fresh.revision+1});return copy(saved);}});
 let loaded=await request('get');assert.equal(loaded.reviewFlags.length,2);assertResolvedFlagReferences(loaded);
 assert.deepEqual(loaded.reviewFlags.find(f=>f.id==='flag-two').evidenceIds,['T0002']);
 const flags=copy(loaded.reviewFlags);flags.find(f=>f.id==='flag-one').status='confirmed';
 await request('patch','',{reviewFlags:flags,reviewDecisionLabel:'Check inspection ownership'});
 loaded=await request('get');assert.equal(loaded.reviewFlags.find(f=>f.id==='flag-one').status,'confirmed');
 assert.equal(loaded.reviewFlags.find(f=>f.id==='flag-two').status,'open');
 const undo=await request('post','/undo');assert.equal(undo.reviewFlags.find(f=>f.id==='flag-one').status,'open');
 assert.deepEqual(undo.reviewFlags.find(f=>f.id==='flag-two').evidenceIds,['T0002']);
 const redo=await request('post','/redo');assert.equal(redo.reviewFlags.find(f=>f.id==='flag-one').status,'confirmed');
 assert.equal(redo.reviewFlags.find(f=>f.id==='flag-two').status,'open');assert.equal(providerCalls,0);
});
