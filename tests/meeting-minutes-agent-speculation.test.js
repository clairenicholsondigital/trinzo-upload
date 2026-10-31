'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1 = '1';
const api = require('../routes/api').stagedEvaluation;

const baseDraft = () => ({
  draftId: 'd1', transcriptSha256: 'abc', preparedTranscript: 'Jacqui: The tracker moved from thirteen to ten.',
  details: { meetingTitle: 'T733', meetingDate: '2026-06-17', internalAttendees: ['Jacqui Fox'], clientAttendees: ['Rebecca Gill'] },
  steer: '', salientDetails: [], discussion: [], actions: [], executiveSummary: '', staleStages: [], generation: null,
  updatedAt: new Date().toISOString()
});

test('the next speculative stage follows what the reviewer will ask for next', () => {
  const draft = baseDraft();
  assert.equal(api.meetingAgentNextSpeculativeStage(draft), 'discussion');
  draft.discussion = [{ topic: 'Tracker', points: [{ id: 'p1', text: 'Tracker moved.' }], decisions: [], openQuestions: [] }];
  assert.equal(api.meetingAgentNextSpeculativeStage(draft), 'actions');
  draft.actions = [{ id: 'a1', action: 'Update the tracker.', owners: ['Jacqui Fox'], timing: { kind: 'not_stated' } }];
  assert.equal(api.meetingAgentNextSpeculativeStage(draft), 'summary');
  draft.executiveSummary = 'The meeting reviewed the tracker.';
  assert.equal(api.meetingAgentNextSpeculativeStage(draft), '');
  draft.staleStages = ['actions'];
  assert.equal(api.meetingAgentNextSpeculativeStage(draft), 'actions', 'an outdated stage is the next one to run');
  draft.generation = { stage: 'actions', status: 'running', bootId: api.MEETING_AGENT_BOOT_ID, startedAt: new Date().toISOString() };
  assert.equal(api.meetingAgentNextSpeculativeStage(draft), '', 'nothing runs ahead while a real run is in flight');
});

test('the input fingerprint changes only when something the stage reads changes', () => {
  const draft = baseDraft();
  draft.discussion = [{ topic: 'Tracker', points: [{ id: 'p1', text: 'Tracker moved.', evidenceIds: ['T0001'] }], decisions: [], openQuestions: [] }];
  draft.actions = [{ id: 'a1', action: 'Update the tracker.', owners: ['Jacqui Fox'], timing: { kind: 'not_stated' } }];
  const fp = (d, stage) => api.meetingAgentStageInputFingerprint(d, stage);
  assert.equal(fp(draft, 'discussion'), fp({ ...draft }, 'discussion'));
  const reflagged = { ...draft, discussion: [{ ...draft.discussion[0], points: [{ ...draft.discussion[0].points[0], evidenceIds: ['T0002'], reviewFlagIds: ['f1'] }] }] };
  assert.equal(fp(draft, 'actions'), fp(reflagged, 'actions'), 'ids, flags and evidence are not inputs');
  const steered = { ...draft, steer: 'Focus on risk' };
  assert.notEqual(fp(draft, 'discussion'), fp(steered, 'discussion'));
  const edited = { ...draft, discussion: [{ ...draft.discussion[0], points: [{ id: 'p1', text: 'Tracker moved a lot.' }] }] };
  assert.equal(fp(draft, 'discussion'), fp(edited, 'discussion'), 'the discussion does not feed its own stage');
  assert.notEqual(fp(draft, 'actions'), fp(edited, 'actions'));
  assert.notEqual(fp(draft, 'summary'), fp(edited, 'summary'));
  const retimed = { ...draft, actions: [{ ...draft.actions[0], timing: { kind: 'deadline', text: 'Friday' } }] };
  assert.equal(fp(draft, 'actions'), fp(retimed, 'actions'), 'actions do not feed their own stage');
  assert.notEqual(fp(draft, 'summary'), fp(retimed, 'summary'));
});

test('a stage result applied virtually reads like the persisted draft would', () => {
  const draft = { ...baseDraft(), staleStages: ['actions', 'summary'], reviewFlags: [] };
  const result = { changes: { actions: [{ id: 'a1', action: 'Do it.' }], passCache: [], qualityState: { actions: {} } }, reviewFlags: [], replaceCoverageFlags: false };
  const virtual = api.applyStageResultVirtually(draft, 'actions', result);
  assert.deepEqual(virtual.actions, result.changes.actions);
  assert.deepEqual(virtual.staleStages, ['summary']);
  assert.equal(virtual.currentStep, 3);
  assert.equal(virtual.generation, null);
});

test('a real run adopts a ready speculation only while the inputs still match', async () => {
  const draft = baseDraft();
  const fingerprint = api.meetingAgentStageInputFingerprint(draft, 'discussion');
  const result = { changes: { discussion: [{ topic: 'Tracker', points: [], decisions: [], openQuestions: [] }] }, reviewFlags: [] };
  api.privateStageSpeculations.set('d1:discussion', {
    draftId: 'd1', stage: 'discussion', fingerprint, status: 'ready', result,
    startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), expiresAt: Date.now() + 60000, passCache: []
  });
  assert.equal(api.meetingAgentSpeculationState(draft)?.status, 'ready');
  const mismatched = { ...draft, steer: 'Different focus' };
  assert.equal(await api.adoptStageSpeculation(mismatched, 'discussion', 'd1', 'u1'), null, 'changed inputs are never adopted');
  assert.ok(api.privateStageSpeculations.has('d1:discussion'), 'a mismatch leaves the entry for its pass cache');
  const adopted = await api.adoptStageSpeculation(draft, 'discussion', 'd1', 'u1');
  assert.equal(adopted.result, result);
  assert.ok(!api.privateStageSpeculations.has('d1:discussion'), 'an adopted entry is consumed');
  api.privateStageSpeculations.set('d1:discussion', { draftId: 'd1', stage: 'discussion', fingerprint, status: 'failed', expiresAt: Date.now() + 60000 });
  assert.equal(await api.adoptStageSpeculation(draft, 'discussion', 'd1', 'u1'), null, 'a failed speculation falls through to a real run');
  api.privateStageSpeculations.clear();
});

test('with the flag off nothing runs ahead and nothing is reported', () => {
  process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1 = '0';
  try {
    assert.equal(api.startStageSpeculation(baseDraft(), 'u1'), null);
    assert.equal(api.meetingAgentSpeculationState(baseDraft()), null);
  } finally {
    process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1 = '1';
  }
});

test('flow replies wrapped in a Markdown JSON fence are parsed; prose is still rejected', () => {
  const { parseJsonLenient } = api;
  assert.deepEqual(parseJsonLenient('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonLenient('```json\n{"a":1,"b":[2]}\n```'), { a: 1, b: [2] });
  assert.deepEqual(parseJsonLenient('```\n{"a":1}\n```'), { a: 1 });
  assert.equal(parseJsonLenient('An error has occurred. Error code: ContentValidationError'), null);
  assert.equal(parseJsonLenient('```json\nnot json\n```'), null);
  assert.equal(parseJsonLenient('Here you go: {"a":1}'), null, 'no brace-hunting inside prose');
});

// Load the whole production owner and canonical policies. Only storage, network,
// clock/scheduling and logs are controlled; no generated policy is replaced.
function lifecycleHarness() {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const { createRequire } = require('node:module');
  const root = path.resolve(__dirname, '..'), cache = new Map(), drafts = new Map();
  const executions = [], writes = [], logs = [], immediates = [], timeouts = new Map(), intervals = new Map();
  let now = Date.now(), workerFailure = false, workerCalls = 0;
  const copy = value => structuredClone(value);
  const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
  const timer = (target, callback, delay) => { const handle = { callback, delay, unref() { this.unreferenced = true; } }; target.set(handle, handle); return handle; };
  const db = {
    getMeetingMinutesAgentDraft: async (id, userId) => userId === 'u1' ? copy(drafts.get(String(id)) || null) : null,
    createMeetingMinutesAgentDraft: async () => assert.fail('Original lifecycle must not create a Parallel copy'),
    linkMeetingMinutesAgentDraftToProject: async () => assert.fail('Original lifecycle must not link a Parallel copy')
  };
  const saveMeetingAgentDraft = async (fresh, req, changes) => {
    assert.equal(req.authUser.userId, 'u1');
    const current = drafts.get(String(fresh.draftId));
    assert.equal(fresh.revision, current.revision);
    const saved = copy({ ...current, ...changes, revision: current.revision + 1, updatedAt: new Date(now).toISOString() });
    drafts.set(String(fresh.draftId), saved); writes.push(copy(changes));
    logs.push({ event: 'fixture_save', stage: changes.generation?.stage });
    return copy(saved);
  };
  const workerFetch = async (url, options) => {
    assert.equal(new URL(url).pathname, '/cache/reset', 'no provider request is allowed');
    assert.equal(options.method, 'POST'); workerCalls += 1;
    if (workerFailure) throw Error('worker offline');
    return { ok: true, json: async () => ({ ok: true, cleared: 3 }) };
  };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = vm.createContext({
    process: { ...process, env: { ...process.env, MEETING_MINUTES_AGENT_HYBRID_V4: '1', MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1: '1', MEETING_MINUTES_AGENT_SPECULATION_MAX_RUNNING: '2' } },
    Date: Clock, Buffer, URL, URLSearchParams, AbortController, structuredClone, Promise,
    setTimeout: (fn, ms) => timer(timeouts, fn, ms), clearTimeout: handle => timeouts.delete(handle),
    setInterval: (fn, ms) => timer(intervals, fn, ms), clearInterval: handle => intervals.delete(handle),
    setImmediate: fn => { immediates.push(fn); }, clearImmediate() {},
    fetch: async () => assert.fail('no global provider request is allowed'),
    console: Object.fromEntries(['info', 'log', 'warn', 'error'].map(level => [level, value => {
      try { logs.push(JSON.parse(value)); } catch { logs.push({ level, value }); }
    }]))
  });
  function load(file) {
    if (file === path.join(root, 'utils/db.js')) return db;
    if (file === path.join(root, 'utils/meetingMinutesDraftPersistence.js')) return { saveMeetingAgentDraft };
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    if (file.endsWith('.json')) return module.exports = JSON.parse(fs.readFileSync(file, 'utf8'));
    const native = createRequire(file);
    const requireOwned = spec => {
      if (spec === 'node-fetch') return workerFetch;
      const resolved = native.resolve(spec);
      return resolved.startsWith(root + path.sep) && !resolved.includes(path.sep + 'node_modules' + path.sep)
        ? load(resolved) : native(spec);
    };
    requireOwned.resolve = native.resolve;
    const wrapper = vm.runInContext('(function(exports,require,module,__filename,__dirname){\n' + fs.readFileSync(file, 'utf8') + '\n})', context, { filename: file });
    wrapper(module.exports, requireOwned, module, file, path.dirname(file));
    return module.exports;
  }
  const runtime = load(path.join(root, 'utils/meetingMinutesGenerationRuntime.js'));
  const transport = load(path.join(root, 'utils/meetingMinutesAgentTransport.js'));
  const execute = kind => (draft, stage, options) => {
    const completion = deferred();
    executions.push({ ...completion, kind, draft: copy(draft), stage, options, context: copy(transport.meetingAgentCallContext.getStore()) });
    logs.push({ event: 'fixture_execute', stage });
    return completion.promise;
  };
  const lifecycle = load(path.join(root, 'utils/meetingMinutesGenerationLifecycle.js'))
    .createMeetingMinutesGenerationLifecycle(execute('hybrid'), execute('legacy'));
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const fixture = (id = 'd1') => ({ ...baseDraft(), draftId: id, revision: 1, currentStep: 0, selectedStep: 1,
    sourceUnits: [{ id: 'T0001', speaker: 'Jacqui Fox', timestamp: '0:00', text: 'The tracker moved from thirteen to ten.', classification: 'keep' }], qualityState: {}, reviewFlags: [] });
  const result = () => ({ changes: { discussion: [{ topic: 'Tracker', points: [{ id: 'point', text: 'The tracker moved.', evidenceIds: ['T0001'] }], decisions: [], openQuestions: [] }],
    qualityState: { discussion: { completedAt: new Date(now).toISOString() } }, currentStep: 4, selectedStep: 4 }, reviewFlags: [], replaceCoverageFlags: false });
  const routes = new Map(), router = Object.fromEntries(['post', 'get'].map(method => [method, (url, ...handlers) => routes.set(method + ' ' + url, handlers.at(-1))]));
  lifecycle.registerMeetingMinutesBackgroundGeneration(router); lifecycle.registerMeetingMinutesGenerationStatus(router);
  const request = async (method, url, body = {}) => {
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = copy(value); return this; } };
    await routes.get(method + ' ' + url)({ params: { draftId: 'd1' }, authUser: { userId: 'u1' }, body }, response);
    return response;
  };
  return { lifecycle, runtime, drafts, executions, writes, logs, immediates, timeouts, intervals, deferred, fixture, result, settle, request,
    workerFailure: value => { workerFailure = value; }, workerCalls: () => workerCalls,
    runImmediate: async () => { assert.ok(immediates.length); immediates.shift()(); await settle(); } };
}

test('enabled speculation shares work, respects capacity before supersession, and persists before chaining', async () => {
  const h = lifecycleHarness(), draft = h.fixture(); h.drafts.set('d1', draft);
  const first = h.lifecycle.startStageSpeculation(draft, 'u1');
  assert.equal(h.lifecycle.startStageSpeculation(draft, 'u1'), first);
  assert.equal(h.executions.length, 1); assert.equal(h.executions[0].context.background, true);
  const other = h.lifecycle.startStageSpeculation(h.fixture('d2'), 'u1');
  const changed = { ...draft, steer: 'Focus on risks' };
  assert.equal(h.lifecycle.startStageSpeculation(changed, 'u1'), null);
  assert.equal(first.superseded, false, 'capacity refusal must not supersede the existing run');
  assert.equal([...h.timeouts.values()][0].delay, 15000);
  assert.equal([...h.timeouts.values()][0].unreferenced, true);
  h.executions[1].reject(Error('controlled failure')); await other.promise;
  assert.equal(other.status, 'failed'); assert.equal(h.immediates.length, 0);
  h.drafts.set('d1', changed);
  const replacement = h.lifecycle.startStageSpeculation(changed, 'u1');
  assert.equal(first.superseded, true); assert.equal(replacement.previous, first);
  h.executions[0].resolve(h.result()); await first.promise;
  assert.equal(h.immediates.length, 0, 'superseded completion cannot publish or chain');
  h.executions[2].resolve(h.result()); await replacement.promise;
  assert.equal(replacement.status, 'ready'); assert.equal(replacement.previous, null);
  assert.equal(h.immediates.length, 2); assert.equal(h.writes.length, 0);
  await h.runImmediate();
  assert.equal(h.writes.length, 1); assert.equal(h.executions.length, 3);
  assert.equal(h.drafts.get('d1').selectedStep, 1); assert.equal(h.drafts.get('d1').currentStep, 0);
  await h.runImmediate();
  assert.equal(h.executions.length, 4); assert.equal(h.executions[3].stage, 'actions');
  assert.ok(h.logs.findIndex(row => row.event === 'fixture_save') < h.logs.findIndex(row => row.event === 'fixture_execute' && row.stage === 'actions'));
  h.executions[3].reject(Error('stop controlled chain'));
  await h.runtime.privateStageSpeculations.get('d1:actions').promise;
  const reviewed = lifecycleHarness(), untouched = reviewed.fixture(); reviewed.drafts.set('d1', untouched);
  const late = reviewed.lifecycle.startStageSpeculation(untouched, 'u1');
  reviewed.executions[0].resolve(reviewed.result()); await late.promise;
  reviewed.drafts.set('d1', { ...untouched, discussion: [{ topic: 'Reviewer wording', points: [] }] });
  await reviewed.runImmediate();
  assert.equal(reviewed.writes.length, 0, 'late speculative publication must not overwrite reviewer content');
  assert.equal(reviewed.drafts.get('d1').discussion[0].topic, 'Reviewer wording');
});

test('in-flight adoption forwards actual progress and releases its interval on success and failure', async () => {
  for (const succeeds of [true, false]) {
    const h = lifecycleHarness(), draft = h.fixture(); h.drafts.set('d1', draft);
    const entry = h.lifecycle.startStageSpeculation(draft, 'u1');
    const adoption = h.lifecycle.adoptStageSpeculation(draft, 'discussion', 'd1', 'u1');
    await h.settle();
    assert.equal(h.intervals.size, 1); assert.equal([...h.intervals.values()][0].delay, 1500);
    assert.equal(h.writes.length, 1); assert.equal(h.drafts.get('d1').generation.pass, 'starting');
    await [...h.intervals.values()][0].callback();
    assert.equal(h.writes.length, 2);
    if (succeeds) h.executions[0].resolve(h.result()); else h.executions[0].reject(Error('controlled failure'));
    const adopted = await adoption;
    assert.equal(h.intervals.size, 0);
    assert.equal(adopted, succeeds ? entry : null);
    assert.equal(h.runtime.privateStageSpeculations.has('d1:discussion'), !succeeds);
  }
});

test('actual reset is busy-safe and worker-first, while serialized writes recover after rejection', async () => {
  const h = lifecycleHarness(), draft = h.fixture(); h.drafts.set('d1', draft);
  const entry = h.lifecycle.startStageSpeculation(draft, 'u1');
  await assert.rejects(h.lifecycle.clearMeetingAgentMemoryCaches(), { code: 'BASELINE_RESET_BUSY' });
  assert.equal(h.workerCalls(), 0);
  h.executions[0].resolve(h.result()); await entry.promise;
  h.runtime.privateStagedCandidateCache.set('ready-staged', { status: 'ready', expiresAt: Date.now() + 60000 });
  h.runtime.privateActionPrimaryCache.set('ready-primary', { status: 'ready', expiresAt: Date.now() + 60000 });
  h.lifecycle.scheduleStageSpeculation('d1', 'u1');
  const before = structuredClone(h.lifecycle.meetingAgentMemoryCacheState());
  h.workerFailure(true);
  await assert.rejects(h.lifecycle.clearMeetingAgentMemoryCaches(), { code: 'BASELINE_RESET_WORKER_UNAVAILABLE' });
  assert.deepEqual(structuredClone(h.lifecycle.meetingAgentMemoryCacheState()), before);
  assert.equal(h.timeouts.size, 1, 'worker failure cannot clear the speculative debounce timer');
  h.workerFailure(false);
  const reset = await h.lifecycle.clearMeetingAgentMemoryCaches();
  for (const field of ['stagedCandidates', 'actionPrimary', 'stageSpeculations', 'speculationTimers', 'draftWrites', 'observedGenerationCompletions']) assert.equal(reset.after[field], 0);
  assert.equal(h.workerCalls(), 2); assert.equal(h.timeouts.size, 0);
  const gate = h.deferred();
  const rejected = h.lifecycle.meetingAgentSerialDraftWrite('same', async () => { throw Error('controlled write failure'); });
  const pending = h.lifecycle.meetingAgentSerialDraftWrite('same', () => gate.promise);
  await assert.rejects(rejected, /controlled write failure/); await h.settle();
  assert.equal(h.lifecycle.meetingAgentMemoryCacheState().draftWrites, 1, 'older cleanup cannot delete a newer tracked write');
  assert.equal(await h.lifecycle.meetingAgentSerialDraftWrite('other', async () => 'independent'), 'independent');
  const next = h.lifecycle.meetingAgentSerialDraftWrite('same', async () => 'recovered');
  gate.resolve('held'); assert.equal(await pending, 'held'); assert.equal(await next, 'recovered');
  assert.equal(h.lifecycle.meetingAgentMemoryCacheState().draftWrites, 0);
});

test('actual Original background dispatch persists completion and every completed poll includes the draft', async () => {
  const h = lifecycleHarness(); h.drafts.set('d1', h.fixture());
  const background = '/meeting-minutes-agent/drafts/:draftId/generate-background';
  const polling = '/meeting-minutes-agent/drafts/:draftId/generation';
  const started = await h.request('post', background, { revision: 1, stage: 'discussion', selectedStep: 0 });
  assert.equal(started.statusCode, 202); assert.equal(started.body.generation.status, 'running');
  assert.equal(h.writes.length, 1); assert.equal(h.executions.length, 0);
  await h.runImmediate();
  assert.equal(h.executions.length, 1); assert.equal(h.executions[0].kind, 'hybrid');
  assert.equal(h.lifecycle.meetingAgentMemoryCacheState().backgroundStagesActive, 1);
  await assert.rejects(h.lifecycle.clearMeetingAgentMemoryCaches(), { code: 'BASELINE_RESET_BUSY' });
  assert.equal(h.workerCalls(), 0);
  assert.equal((await h.request('get', polling)).body.draft, undefined);
  await h.executions[0].options.onProgress({ pass: 'referee', message: 'Checking the evidence' });
  h.executions[0].resolve(h.result()); await h.settle();
  assert.equal(h.lifecycle.meetingAgentMemoryCacheState().backgroundStagesActive, 0);
  const first = await h.request('get', polling), repeated = await h.request('get', polling);
  assert.equal(first.body.generation, null); assert.equal(repeated.body.generation, null);
  assert.ok(first.body.draft); assert.ok(repeated.body.draft);
  assert.equal(first.body.draft.revision, repeated.body.draft.revision);
  assert.equal(first.body.draft.discussion[0].topic, 'Tracker');
  assert.equal(first.body.performance.stage, 'discussion');
  assert.equal(h.logs.filter(row => row.event === 'meeting_agent_poll_observed').length, 1);
  assert.equal(h.logs.filter(row => row.event === 'meeting_agent_stage_performance' && row.ok).length, 1);
  assert.equal(h.lifecycle.meetingAgentMemoryCacheState().observedGenerationCompletions, 1);
});
