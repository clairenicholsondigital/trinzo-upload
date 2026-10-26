'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// The full pipeline uses its real transport/parser and persistence assembly,
// substituting only provider responses and an in-memory save boundary.
Object.assign(process.env, {
  POWER_AUTOMATE_AGENT_WEBHOOK_URL: 'https://thread-accounting.fixture.invalid',
  MEETING_MINUTES_AGENT_CALL_START_GAP_MS: '1000',
  MEETING_MINUTES_AGENT_MAX_ACTIVE_CALLS: '4',
  MEETING_MINUTES_AGENT_ACTION_REFEREE_BATCH_SIZE: '2',
  MEETING_MINUTES_AGENT_ACTION_REFEREE_CONCURRENCY: '1',
  MEETING_MINUTES_AGENT_PRIMARY_UNION_V1: '0',
  MEETING_MINUTES_AGENT_COMMITMENT_DEDUPE_V1: '0',
  MEETING_MINUTES_AGENT_FAST_ACTION_PATH_V1: '1',
  MEETING_MINUTES_AGENT_TIMING_CHECK_V1: '0',
  MEETING_MINUTES_AGENT_COMMITMENT_CHECK_V1: '0',
  MEETING_MINUTES_AGENT_ANSWERED_CHECK_V1: '0',
  MEETING_MINUTES_AGENT_DECISION_CHECK_V1: '0',
  MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1: '0',
  MEETING_MINUTES_AGENT_REPLAY_PASS_CACHE: '0'
});
const forbidden = [];
const deny = label => () => { forbidden.push(label); throw new Error(`Offline test forbids ${label}`); };
for (const name of ['http', 'https', 'net', 'tls', 'dgram']) {
  const module = require(name);
  for (const key of ['request', 'get', 'connect', 'createConnection', 'createServer', 'createSocket']) {
    if (typeof module[key] === 'function') module[key] = deny(`${name}.${key}`);
  }
}
global.fetch = deny('fetch');
let transport = deny('unexpected provider request');
const originalLoad = Module._load;
Module._load = function (name, parent, isMain) {
  if (name === 'node-fetch') return (...args) => transport(...args);
  if (name === 'pg') return { Pool: class { constructor() { deny('pg.Pool')(); } } };
  if (name === 'child_process') return new Proxy({}, { get: (_, key) => deny(`child_process.${String(key)}`) });
  return originalLoad.apply(this, arguments);
};
const root = path.resolve(__dirname, '..');
const apiFile = path.join(root, 'routes/api.js');
let router;
try {
  // Private before/after runs can compile a preserved baseline under the same
  // module filename. Normal repository tests always use the current source.
  if (process.env.TRINZO_THREAD_ACCOUNTING_API_SOURCE) {
    const compiled = new Module(apiFile, module);
    compiled.filename = apiFile;
    compiled.paths = Module._nodeModulePaths(path.dirname(apiFile));
    compiled._compile(fs.readFileSync(process.env.TRINZO_THREAD_ACCOUNTING_API_SOURCE, 'utf8'), apiFile);
    router = compiled.exports;
  } else router = require(apiFile);
} finally { Module._load = originalLoad; }
const A = router.stagedEvaluation;
const V = require('../utils/meetingMinutesAgentV2');
const copy = value => JSON.parse(JSON.stringify(value));
const units = [
  { id: 'T0001', sequence: 1, speaker: 'Sam', text: 'I will send the equipment list.' },
  { id: 'T0002', sequence: 2, speaker: 'Jordan', text: 'I will check the supplier register next week.' },
  { id: 'T0003', sequence: 3, speaker: 'Sam', text: 'The football team played well.' },
  { id: 'T0100', sequence: 100, speaker: 'Riley', text: 'I will inspect the ventilation unit.' }
];
const atomic = (candidateId = 'send', text = 'Send the equipment list.', evidenceIds = ['T0001']) => ({
  candidateId, recordType: 'action', sourcePass: 'primary', text, evidenceIds,
  record: { id: candidateId, action: text, owners: ['Sam'], evidenceIds,
    timing: { kind: 'not_stated', wording: '', exactDate: '' }, reviewFlagIds: [] }
});
const group = (recordType = 'action_thread') => ({
  candidateId: 'group', recordType, sourcePass: 'deterministic',
  text: units.slice(0, 3).map(unit => unit.text).join(' '), evidenceIds: ['T0001', 'T0002', 'T0003'],
  candidateIds: ['send', 'check', 'aside'], ownerHints: ['Jordan'],
  timing: { kind: 'target', wording: 'next week', exactDate: '' }
});
const disposition = (candidateId, kind, evidenceIds = ['T0001']) => ({
  candidateId, disposition: kind, reason: 'The cited source was independently assessed.', evidenceIds
});
function response(candidates, rows, extra = {}) {
  const contract = A.meetingMinutesAgentRefereeContract('actions', candidates, 'thread-test', { selected: true });
  return { contract, result: { requestId: contract.requestId, stage: contract.stage,
    expectedCandidateCount: candidates.length, returnedDispositionCount: rows.length,
    candidateDispositions: rows, discussion: [], actions: [], actionProposals: [], ...extra } };
}

test('published/proposed groups stay unresolved without futile repair while valid siblings survive', () => {
  for (const type of ['action_thread', 'action_chain']) for (const kind of ['publish', 'proposal']) {
    const candidates = [atomic(), group(type), { ...atomic('aside'), text: 'Meeting aside.' }];
    const rows = [disposition('send', 'publish'), disposition('group', kind), disposition('aside', 'reject')];
    const { result, contract } = response(candidates, rows);
    const error = A.meetingAgentDispositionError(result, candidates, contract);
    assert.equal(error?.code, 'unmaterialized_referee_action');
    assert.equal(error.structurallyUnwritableGroupsOnly, true);
    assert.deepEqual(error.invalidCandidateIds, ['group']);
    assert.deepEqual(error.validCandidateDispositions, [rows[0], rows[2]]);
    assert.deepEqual(A.meetingAgentRefereeRepairCandidates(candidates, error.validCandidateDispositions)
      .map(row => row.candidateId), ['group']);
    const rebuilt = A.reconstructRefereeActions([rows[1]], candidates, units);
    const rejected = A.reconstructRefereeActions([{ ...rows[1], disposition: 'reject' }], candidates, units);
    assert.deepEqual(rebuilt.actions, []);
    assert.deepEqual(rebuilt.actionProposals, []);
    assert.equal(rebuilt.unresolvedMaterializations[0].reason, 'group_requires_atomic_action_mapping');
    assert.deepEqual(rejected, { actions: [], actionProposals: [] });
    assert.notDeepEqual(rebuilt, rejected, 'an accepted group is unresolved, not a successful empty rejection');
    assert.equal(A.meetingAgentRefereeAccountedForAllCandidates(result, contract, 'structured_prompt'), false);
    assert.equal(A.shouldStopMeetingAgentRefereeBatches(error, error), false, 'healthy later batches must continue');
    assert.equal(A.meetingAgentFailureClass(error), 'response_contract');
    assert.equal(A.meetingAgentInfrastructureFailure(error), false);
  }
});

test('missing, duplicate, malformed and mixed atomic failures retain the repair path', () => {
  const candidates = [atomic(), group()];
  const rows = [disposition('send', 'publish'), disposition('group', 'publish')];
  for (const mutate of [
    r => { r.candidateDispositions.pop(); },
    r => { r.candidateDispositions.push(copy(r.candidateDispositions[0])); },
    r => { r.expectedCandidateCount = 99; },
    r => { r.candidateDispositions[1].reason = ''; },
    r => { r.candidateDispositions[1].evidenceIds = null; },
    r => { r.candidateDispositions[0].targetId = 'unknown'; },
    r => { delete r.requestId; }
  ]) {
    const { result, contract } = response(candidates, copy(rows));
    mutate(result);
    const error = A.meetingAgentDispositionError(result, candidates, contract);
    assert.ok(error);
    assert.equal(error.structurallyUnwritableGroupsOnly, false);
    assert.ok(A.meetingAgentRefereeRepairCandidates(candidates, error.validCandidateDispositions).length);
  }
});

test('a target alias does not invent a group mapping or donate its owner, timing or unrelated citations', () => {
  const candidates = [atomic(), group()];
  const rows = [disposition('send', 'publish'), { ...disposition('group', 'publish', ['T0002']), targetId: 'send', owners: ['Jordan'] }];
  const { result, contract } = response(candidates, rows);
  assert.equal(A.meetingAgentDispositionError(result, candidates, contract)?.code, 'unmaterialized_referee_action');
  const rebuilt = A.reconstructRefereeActions(rows, candidates, units);
  assert.equal(rebuilt.actions.length, 1);
  assert.equal(rebuilt.actions[0].action, 'Send the equipment list.');
  assert.deepEqual(rebuilt.actions[0].owners, ['Sam']);
  assert.equal(rebuilt.actions[0].timing.kind, 'not_stated');
  assert.deepEqual(rebuilt.actions[0].evidenceIds, ['T0001']);
  assert.equal(rebuilt.unresolvedMaterializations.length, 1);
});

test('unknown atomic target IDs trigger repair while existing alias behavior stays intact', () => {
  const candidates = [atomic(), atomic('known')];
  const typo = { ...disposition('send', 'publish'), targetId: 'knwon' };
  const { result, contract } = response(candidates, [typo, disposition('known', 'reject')]);
  assert.equal(A.meetingAgentDispositionError(result, candidates, contract)?.invalidReasons[0], 'send: action_target_not_found');
  assert.equal(A.reconstructRefereeActions([typo], candidates, units).actions.length, 0);
  const known = { ...typo, targetId: 'known' };
  const rebuilt = A.reconstructRefereeActions([known], candidates, units);
  assert.equal(rebuilt.actions[0].id, 'send', 'the existing record ID is retained where present');
  assert.equal(rebuilt.actions[0].action, candidates[0].text);
  assert.equal(rebuilt.unresolvedMaterializations, undefined);
  const subset = response([candidates[0]], [known]);
  assert.equal(A.meetingAgentDispositionError(subset.result, [candidates[0]], subset.contract, candidates), null,
    'a valid alias in another batch remains known to the full selected inventory');
});

test('ordinary atomic publication/proposal and reasoned non-action judgments keep their contracts', () => {
  for (const kind of ['publish', 'proposal', 'reject', 'completed', 'suggestion']) {
    const candidates = [atomic()];
    const rows = [disposition('send', kind)];
    const { result, contract } = response(candidates, rows);
    assert.equal(A.meetingAgentDispositionError(result, candidates, contract), null);
    const rebuilt = A.reconstructRefereeActions(rows, candidates, units);
    assert.deepEqual(Object.keys(rebuilt), ['actions', 'actionProposals']);
    assert.equal(rebuilt.actions.length, kind === 'publish' ? 1 : 0);
    assert.equal(rebuilt.actionProposals.length, kind === 'proposal' ? 1 : 0);
    assert.equal(A.meetingAgentRefereeAccountedForAllCandidates(result, contract, 'structured_prompt'), true);
  }
  assert.equal(A.shouldStopMeetingAgentRefereeBatches({ code: 'power_automate_timeout' }, { code: 'power_automate_timeout' }), true);
});

test('unwritable atomic candidates and fallback group responses cannot claim materialization', () => {
  const empty = { candidateId: 'empty', recordType: 'action', text: '', evidenceIds: [] };
  const { result, contract } = response([empty], [disposition('empty', 'proposal')]);
  assert.equal(A.meetingAgentDispositionError(result, [empty], contract)?.invalidReasons[0], 'empty: action_wording_missing');
  const fallback = response([group()], [disposition('group', 'publish')]);
  delete fallback.result.requestId;
  assert.equal(A.meetingAgentRefereeRoute(fallback.result, fallback.contract), 'connected_fallback');
  assert.equal(A.meetingAgentDispositionError(fallback.result, [group()], fallback.contract)?.code, 'unmaterialized_referee_action');
});

test('unresolved group accounting preserves covered children, distinct siblings and explicit rejections separately', () => {
  const check = atomic('check', 'Check the supplier register.', ['T0002']);
  const aside = atomic('aside', 'The football team played well.', ['T0003']);
  const candidates = [group(), atomic(), check, aside];
  const output = A.reconstructRefereeActions([disposition('send', 'publish'), disposition('group', 'publish')], candidates, units);
  const review = A.reconcileRefereeActionMaterialization(output.unresolvedMaterializations, candidates,
    A.hybridCandidateDispositions(candidates, output.actions), units, [disposition('aside', 'reject')]);
  assert.deepEqual(review.candidateDispositions.map(row => [row.candidateId, row.disposition]), [
    ['group', 'unresolved'], ['send', 'publish'], ['check', 'unresolved'], ['aside', 'reject']
  ]);
  assert.equal(review.accounting.complete, false);
  assert.equal(review.flags.length, 1);
  assert.equal(review.flags[0].kind, 'possible_missed_follow_up');
  assert.deepEqual(review.flags[0].evidenceIds, ['T0001', 'T0002', 'T0003']);
  assert.deepEqual(A.meetingAgentMaterialPassImpact(review.candidateDispositions).primary.materialCandidateIds, ['send']);
});

test('a reasoned rejected/completed/suggestion group is not published by overlap with an independently accepted child', () => {
  const candidates = [group(), atomic()];
  const acceptedChild = A.reconstructRefereeActions([disposition('send', 'publish')], candidates, units);
  for (const kind of ['reject', 'completed', 'suggestion']) {
    const rows = [disposition('group', kind), disposition('send', 'publish')];
    const { result, contract } = response(candidates, rows);
    assert.equal(A.meetingAgentDispositionError(result, candidates, contract), null);
    const reconstructed = A.reconstructRefereeActions(rows, candidates, units);
    assert.deepEqual(reconstructed, acceptedChild, 'the group changes no action, owner, timing or citation');
    const review = A.reconcileRefereeActionMaterialization([], candidates,
      A.hybridCandidateDispositions(candidates, reconstructed.actions), units, rows);
    assert.equal(review.candidateDispositions.find(row => row.candidateId === 'group').disposition, kind);
    assert.equal(review.candidateDispositions.find(row => row.candidateId === 'send').disposition, 'publish');
    assert.equal(review.accounting.complete, true);
    assert.deepEqual(review.flags, []);
  }
});

for (const fault of ['none', 'missing_atomic', 'malformed_group']) test(`the actual pipeline preserves actions and visible unresolved review (${fault})`, async () => {
  let injected = false;
  const calls = [];
  const primaryActions = [atomic().record, { ...atomic('check', 'Check the supplier register.', ['T0002']).record,
    owners: ['Jordan'] }];
  transport = async (url, options) => {
    assert.equal(url, process.env.POWER_AUTOMATE_AGENT_WEBHOOK_URL);
    const prompt = JSON.parse(options.body).input.prompt;
    let result;
    if (prompt.startsWith('[ACTION_REFEREE]')) {
      const payload = JSON.parse(prompt.split('refereePayload:\n')[1]);
      calls.push(copy(payload));
      result = { requestId: payload.requestId, stage: payload.stage,
        expectedCandidateCount: payload.expectedCandidateCount, returnedDispositionCount: payload.expectedCandidateCount,
        candidateDispositions: payload.candidateEnsemble.map(candidate => disposition(candidate.candidateId,
          ['action_thread', 'action_chain'].includes(candidate.recordType) || candidate.sourcePass === 'primary' ? 'publish' : 'reject',
          candidate.evidenceIds)), discussion: [], actions: [], actionProposals: [] };
      if (!payload.repairAttempt && !injected && fault !== 'none') {
        const index = payload.candidateEnsemble.findIndex(candidate => fault === 'missing_atomic'
          ? candidate.recordType === 'action' && candidate.sourcePass === 'primary'
          : ['action_thread', 'action_chain'].includes(candidate.recordType));
        if (index >= 0) {
          injected = true;
          if (fault === 'missing_atomic') result.candidateDispositions.splice(index, 1);
          else result.candidateDispositions[index].reason = '';
        }
      }
    } else if (prompt.startsWith('ACTION_DISCOVERY')) result = { discussion: [], actions: primaryActions };
    else result = { discussion: [], actions: [], actionProposals: [], candidateDispositions: [], results: [] };
    return { ok: true, status: 200, text: async () => JSON.stringify(result) };
  };
  const draft = { draftId: 'thread-offline', revision: 1, payloadVersion: V.PAYLOAD_VERSION, status: 'draft', currentStep: 2,
    details: { meetingTitle: 'Equipment planning', meetingType: 'General', meetingDate: '2026-10-21',
      internalAttendees: ['Sam', 'Jordan', 'Riley'], clientAttendees: [] },
    sourceUnits: units, preparedTranscript: V.preparedTranscriptFromUnits(units), discussion: [], actions: [],
    reviewFlags: [], qualityState: {}, passCache: [], candidateLedger: [], staleStages: [] };
  draft.candidateLedger = [{ ...atomic('cached'), sourcePass: 'staged',
    timingInferenceVersion: V.TIMING_INFERENCE_POLICY_VERSION,
    timingInferenceInputKey: A.privateStagedCandidateCacheKey(draft, 'actions') }];
  const result = await A.generateHybridMeetingAgentStage(copy(draft), 'actions');
  const initial = calls.filter(call => !call.repairAttempt);
  const repairs = calls.filter(call => call.repairAttempt);
  assert.ok(initial.length > 1, 'the real scheduler continues across multiple ordinary batches');
  if (fault === 'none') assert.equal(repairs.length, 0, 'complete positive group responses cannot be repaired by this protocol');
  else {
    assert.equal(injected, true);
    assert.ok(repairs.length > 0, 'genuinely incomplete or malformed responses still receive repair');
    for (const repair of repairs) {
      assert.ok(initial.some(call => `${call.requestId}:repair` === repair.requestId));
      assert.equal(repairs.filter(call => call.requestId === repair.requestId).length, 1);
    }
  }
  assert.equal(new Set(initial.flatMap(call => call.expectedCandidateIds)).size,
    initial.reduce((sum, call) => sum + call.expectedCandidateCount, 0), 'no successful sibling is resent');
  const quality = result.changes.qualityState.actions;
  assert.equal(quality.refereeMaterialization.complete, false);
  assert.ok(quality.refereeMaterialization.unresolvedCount > 0);
  assert.ok(quality.candidateDispositions.some(row => row.disposition === 'unresolved'));
  assert.ok(result.changes.actions.some(row => row.action === 'Send the equipment list.'));
  assert.equal(result.changes.actions.some(row => /football/i.test(row.action)), false);
  assert.ok(result.reviewFlags.some(flag => flag.id.startsWith('action-materialization-') && flag.status === 'open'));
  let saved = copy(draft);
  const persisted = await A.persistMeetingAgentBackgroundStage({ draftId: draft.draftId, userId: 'offline-reviewer',
    stage: 'actions', sourceDraft: draft, result,
    getDraft: async () => copy(saved), saveDraft: async (_, changes) => {
      saved = copy({ ...saved, ...changes, revision: saved.revision + 1 });
      return copy(saved);
    }
  });
  assert.deepEqual(persisted.conflictFields, []);
  assert.equal(saved.qualityState.actions.refereeMaterialization.complete, false);
  const publicDraft = A.publicMeetingAgentDraft(copy(saved));
  assert.ok(publicDraft.reviewFlags.some(flag => flag.id.startsWith('action-materialization-') && flag.status === 'open'));
  assert.equal(publicDraft.actions.some(row => /football/i.test(row.action)), false);
  assert.deepEqual(forbidden, [], 'no network, subprocess, provider or database side effects');
});

for(const recordType of [undefined,''])test('a positive candidate without an atomic type stays unresolved: '+recordType,()=>{
 const candidate={...atomic(),recordType},candidates=[candidate],rows=[disposition('send','publish')],{result,contract}=response(candidates,rows);
 assert.equal(A.meetingAgentDispositionError(result,candidates,contract)?.code,'unmaterialized_referee_action');
 const rebuilt=A.reconstructRefereeActions(rows,candidates,units);assert.equal(rebuilt.actions.length,0);
 assert.equal(rebuilt.unresolvedMaterializations[0].reason,'candidate_is_not_an_action');
 assert.equal(A.meetingAgentRefereeAccountedForAllCandidates(result,contract,'structured_prompt'),false);
});
for(const target of [group(),{candidateId:'group',recordType:'discussion_point',text:'A discussion only.'},{candidateId:'group',recordType:'action',text:'',record:{action:''}}])test('a known target ID must identify a writable atomic action: '+target.recordType,()=>{
 const candidates=[atomic(),target],rows=[{...disposition('send','publish'),targetId:'group'},disposition('group','reject')],{result,contract}=response(candidates,rows);
 const error=A.meetingAgentDispositionError(result,candidates,contract);assert.equal(error?.code,'unmaterialized_referee_action');
 assert.equal(error.structurallyUnwritableGroupsOnly,false);
 const rebuilt=A.reconstructRefereeActions(rows,candidates,units);assert.equal(rebuilt.actions.length,0);
 assert.equal(rebuilt.unresolvedMaterializations[0].reason,'action_target_not_writable');
 assert.equal(A.meetingAgentRefereeAccountedForAllCandidates(result,contract,'structured_prompt'),false);
});
test('an alias target with duplicate identities cannot be resolved by last-write-wins',()=>{
 const candidates=[atomic(),atomic('target'),{...atomic('target'),text:'Review a different report.'}],rows=[{...disposition('send','publish'),targetId:'target'}];
 const rebuilt=A.reconstructRefereeActions(rows,candidates,units);assert.equal(rebuilt.actions.length,0);
 assert.equal(rebuilt.unresolvedMaterializations[0].reason,'ambiguous_action_target');
});
test('a candidate with duplicate identities cannot be reconstructed from the last record',()=>{
 const candidates=[atomic(),{...atomic(),text:'Review a different report.'}],rows=[disposition('send','publish')];
 const rebuilt=A.reconstructRefereeActions(rows,candidates,units);assert.equal(rebuilt.actions.length,0);
 assert.equal(rebuilt.unresolvedMaterializations[0].reason,'ambiguous_action_candidate');
});
