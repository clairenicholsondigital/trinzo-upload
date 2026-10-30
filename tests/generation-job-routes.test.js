'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

function fixture({ authenticated = true, implementations = {}, launch = true } = {}) {
  const calls = [], registrations = [], routeMap = new Map();
  const operations = {
    listGenerationJobs: async () => [{ jobId: 41, status: 'queued' }],
    getGenerationJob: async () => ({ jobId: 41, status: 'completed', resultPayload: { result: 'Ready.' } }),
    retryGenerationJob: async () => ({ jobId: 41, jobType: 'project_update_generate', status: 'queued' }),
    cancelGenerationJob: async () => ({ jobId: 41, status: 'cancelled' }),
    deleteGenerationJob: async () => true,
    archiveGenerationJobs: async () => [41],
    ...implementations
  };
  const store = Object.fromEntries(Object.keys(operations).map(name => [name, (...args) => {
    calls.push({ name, args });
    return operations[name](...args);
  }]));
  const requireAuth = (req, res, next) => authenticated
    ? next()
    : res.status(401).json({ ok: false, error: 'Authentication required.' });
  const launchQueuedStagedMeetingMinutesStage = jobId => {
    calls.push({ name: 'launchQueuedStagedMeetingMinutesStage', args: [jobId] });
  };
  const router = Object.fromEntries(['get', 'post', 'delete'].map(method => [method, (routePath, ...handlers) => {
    const route = { method, path: routePath, handlers };
    registrations.push(route);
    routeMap.set(`${method} ${routePath}`, route);
  }]));
  const load = Module._load;
  Module._load = function guardedLoad(request, parent, isMain) {
    if (request === 'child_process' || request === 'node:child_process'
      || /(?:^|\/)(?:db|auth|api)(?:\.js)?$/.test(request)) {
      throw new Error(`Unexpected production dependency: ${request}`);
    }
    return load.call(this, request, parent, isMain);
  };
  try {
    require('../routes/generationJobs')(router, {
      store, requireAuth,
      ...(launch ? { launchQueuedStagedMeetingMinutesStage } : {})
    });
  } finally {
    Module._load = load;
  }
  async function request(method, routePath, input = {}) {
    const route = routeMap.get(`${method} ${routePath}`);
    assert.ok(route, `Missing route: ${method} ${routePath}`);
    const req = { params: {}, query: {}, body: {}, ...input };
    const res = {
      statusCode: 200,
      status(statusCode) { this.statusCode = statusCode; return this; },
      json(payload) { this.body = payload; return this; }
    };
    const dispatch = index => route.handlers[index](req, res, () => dispatch(index + 1));
    await dispatch(0);
    return res;
  }
  return { calls, registrations, requireAuth, request };
}

test('generation job registration requires the existing staged launcher and retains route order and auth', async () => {
  assert.throws(() => fixture({ launch: false }), { name: 'TypeError', message: 'launchQueuedStagedMeetingMinutesStage is required.' });
  const f = fixture({ authenticated: false });
  assert.deepEqual(f.registrations.map(route => [route.method, route.path]), [
    ['get', '/jobs'], ['get', '/jobs/:jobId'], ['post', '/jobs/:jobId/retry'],
    ['post', '/jobs/:jobId/cancel'], ['delete', '/jobs/:jobId'], ['post', '/jobs/archive']
  ]);
  for (const route of f.registrations) {
    assert.equal(route.handlers.length, 2);
    assert.equal(route.handlers[0], f.requireAuth);
    const res = await f.request(route.method, route.path);
    assert.equal(res.statusCode, 401);
  }
  assert.deepEqual(f.calls, []);
  assert.ok(!require.cache[path.resolve(__dirname, '../routes/api.js')]);
  assert.ok(!require.cache[path.resolve(__dirname, '../utils/db.js')]);
});

test('generation job listing preserves default and caller-supplied limits and type filters', async () => {
  const f = fixture();
  const defaults = await f.request('get', '/jobs');
  assert.deepEqual(f.calls[0], { name: 'listGenerationJobs', args: [75, { type: '' }] });
  assert.deepEqual(defaults.body, { ok: true, success: true, jobs: [{ jobId: 41, status: 'queued' }] });
  await f.request('get', '/jobs', { query: { limit: '12', type: 'staged_meeting_minutes_stage' } });
  assert.deepEqual(f.calls[1], { name: 'listGenerationJobs', args: ['12', { type: 'staged_meeting_minutes_stage' }] });
});

test('generation job polling exposes the top-level result only for completed jobs and preserves the stored job', async () => {
  for (const status of ['queued', 'running', 'failed', 'cancelled', 'completed']) {
    const resultPayload = { result: { draftId: 'draft-41' }, message: 'Stored result.' };
    const job = { jobId: 41, status, resultPayload };
    const f = fixture({ implementations: { getGenerationJob: async () => job } });
    const res = await f.request('get', '/jobs/:jobId', { params: { jobId: '41' } });
    assert.deepEqual(f.calls, [{ name: 'getGenerationJob', args: ['41'] }]);
    assert.equal(res.body.job, job);
    assert.equal(res.body.result, status === 'completed' ? resultPayload : null);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.success, true);
  }
});

test('retry starts the existing staged launcher only after storage queues a staged meeting-minutes job', async () => {
  for (const jobType of ['staged_meeting_minutes_stage', 'meeting_minutes_generate', 'project_update_generate', 'historical_type']) {
    const job = { jobId: 52, jobType, status: 'queued' };
    const f = fixture({ implementations: { retryGenerationJob: async () => job } });
    const res = await f.request('post', '/jobs/:jobId/retry', { params: { jobId: '41' } });
    assert.deepEqual(f.calls, [
      { name: 'retryGenerationJob', args: ['41'] },
      ...(jobType === 'staged_meeting_minutes_stage' ? [{ name: 'launchQueuedStagedMeetingMinutesStage', args: [52] }] : [])
    ]);
    assert.deepEqual(res.body, { ok: true, success: true, job });
  }
});

test('generation job cancellation and terminal deletion preserve store arguments and response shapes', async () => {
  const f = fixture();
  const cancelled = await f.request('post', '/jobs/:jobId/cancel', { params: { jobId: '41' } });
  assert.deepEqual(cancelled.body, { ok: true, success: true, job: { jobId: 41, status: 'cancelled' } });
  const deleted = await f.request('delete', '/jobs/:jobId', { params: { jobId: '41' } });
  assert.deepEqual(deleted.body, { ok: true, success: true });
  assert.deepEqual(f.calls, [
    { name: 'cancelGenerationJob', args: ['41'] },
    { name: 'deleteGenerationJob', args: ['41'] }
  ]);
});

test('missing or ineligible generation jobs return operation-specific 404s without launching work', async () => {
  const routes = [
    ['get', '/jobs/:jobId', 'getGenerationJob', 'Job not found.'],
    ['post', '/jobs/:jobId/retry', 'retryGenerationJob', 'Retryable job not found.'],
    ['post', '/jobs/:jobId/cancel', 'cancelGenerationJob', 'Cancellable job not found.'],
    ['delete', '/jobs/:jobId', 'deleteGenerationJob', 'Deletable completed/failed/cancelled job not found.']
  ];
  for (const [method, routePath, operation, error] of routes) {
    const f = fixture({ implementations: { [operation]: async () => null } });
    const res = await f.request(method, routePath, { params: { jobId: 'missing' } });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { ok: false, success: false, error });
    assert.deepEqual(f.calls, [{ name: operation, args: ['missing'] }]);
  }
});

test('generation job archive requires selected ID arrays or the strict boolean archiveAll flag', async () => {
  for (const body of [undefined, {}, { jobIds: '41' }, { jobIds: [] }, { archiveAll: 'true' }, { archiveAll: 1 }]) {
    const f = fixture();
    const res = await f.request('post', '/jobs/archive', { body });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { ok: false, success: false, error: 'Select at least one item to archive.' });
    assert.deepEqual(f.calls, []);
  }
  for (const [body, expected] of [
    [{ jobIds: ['41', 52] }, { requestedIds: ['41', 52], archiveAll: false }],
    [{ jobIds: [41], archiveAll: 'true' }, { requestedIds: [41], archiveAll: false }],
    [{ archiveAll: true }, { requestedIds: [], archiveAll: true }],
    [{ jobIds: [41], archiveAll: true }, { requestedIds: [41], archiveAll: true }]
  ]) {
    const archivedIds = [41, 52];
    const f = fixture({ implementations: { archiveGenerationJobs: async () => archivedIds } });
    const res = await f.request('post', '/jobs/archive', { body });
    assert.deepEqual(f.calls, [{ name: 'archiveGenerationJobs', args: [expected.requestedIds, { archiveAll: expected.archiveAll }] }]);
    if (Array.isArray(body.jobIds)) assert.equal(f.calls[0].args[0], body.jobIds);
    assert.deepEqual(res.body, { ok: true, success: true, archivedIds, archivedCount: 2 });
  }
});

test('generation job storage failures retain explicit status/messages and per-route fallback errors', async () => {
  const routes = [
    ['get', '/jobs', 'listGenerationJobs', 'Failed to list jobs.'],
    ['get', '/jobs/:jobId', 'getGenerationJob', 'Failed to load job.'],
    ['post', '/jobs/:jobId/retry', 'retryGenerationJob', 'Failed to retry job.'],
    ['post', '/jobs/:jobId/cancel', 'cancelGenerationJob', 'Failed to cancel job.'],
    ['delete', '/jobs/:jobId', 'deleteGenerationJob', 'Failed to delete job.'],
    ['post', '/jobs/archive', 'archiveGenerationJobs', 'Failed to archive items.']
  ];
  for (const [method, routePath, operation, fallback] of routes) {
    for (const error of [Object.assign(new Error('Fixture conflict.'), { statusCode: 409 }), {}]) {
      const f = fixture({ implementations: { [operation]: async () => { throw error; } } });
      const res = await f.request(method, routePath, { params: { jobId: '41' }, body: { jobIds: [41] } });
      assert.equal(res.statusCode, error.statusCode || 500);
      assert.deepEqual(res.body, { ok: false, success: false, error: error.message || fallback });
      assert.equal(f.calls.length, 1);
    }
  }
});
