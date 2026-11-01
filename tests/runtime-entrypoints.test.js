'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const express = require('express');

const root = path.join(__dirname, '..');

function loadServer({blocked = false, sandbox = false, env = {}} = {}) {
  const calls = [], identities = [], listen = [];
  const app = express();
  app.listen = (...args) => { listen.push(args.slice(0, 2)); };
  const router = (name, route, method = 'get') => {
    const value = express.Router();
    value[method](route, (req, res) => {
      calls.push(name);
      res.json({ok: true, owner: name, body: req.body});
    });
    return value;
  };
  const api = router('prepare', '/meeting-minutes-agent/prepare', 'post');
  api.stagedEvaluation = {clearMeetingAgentMemoryCaches() {calls.push('cache');}};
  for (const [route, name, method] of [['/agent/finalise', 'delivery', 'post'],
    ['/jobs/run-once', 'manual-worker', 'post'], ['/project-update-test/projects', 'projects', 'get']]) {
    api[method](route, (req, res) => {calls.push(name); res.json({ok: true, owner: name});});
  }
  const auth = router('session', '/session');
  for (const [route, owner] of [['/login', 'login'], ['/forgot-password', 'forgot-password'], ['/reset-password', 'reset-password']]) {
    auth.post(route, (req, res) => {calls.push(owner); res.json({ok: true, owner});});
  }
  auth.requireAuth = (req, res, next) => next();
  const feedback = express.Router();
  feedback.summaryHandler = (req, res) => {calls.push('feedback'); res.json({ok: true});};
  const modules = {
    dotenv: {config() {}},
    path,
    'fs/promises': {readFile: async () => '<html>Existing page</html>'},
    express: Object.assign(() => app, express),
    './routes/api': api,
    './routes/auth': auth,
    './routes/meetingAgent': router('graph', '/transcript-subscription', 'post'),
    './routes/baselineTesting': {createBaselineTestingRouter: () => router('baseline', '/reset-memory-cache', 'post')},
    './routes/reviewFeedback': feedback,
    './routes/settings': router('settings', '/'),
    './utils/settingsStore': {
      refreshMiddleware(req, res, next) {calls.push('refresh'); next();},
      refresh: async () => ({source: 'fixture', people: [], terms: []})
    },
    './utils/knowledge': {startProjectKnowledgeEmbedInterval: () => ({started: false})},
    './utils/reviewSnippet': {addReviewSnippet: value => value},
    './routes/internalAiTasks': () => router('tasks', '/'),
    './utils/runtimeIdentity': {createRuntimeIdentity(options) {
      identities.push(options);
      return {sandbox, middleware(req, res, next) {
        calls.push('identity');
        if (blocked) return res.status(503).json({ok: false, code: 'RUNTIME_IDENTITY_UNAVAILABLE'});
        next();
      }};
    }}
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), {
    require(name) {
      assert.ok(Object.hasOwn(modules, name), 'Unexpected server dependency: ' + name);
      return modules[name];
    },
    __dirname: root,
    process: {env},
    console: {log() {}, error() {}}
  }, {filename: 'server.js'});
  return {app, calls, identities, listen};
}

async function localServer(t, app) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

test('the actual server blocks every API mount before parsing or owner work when parity fails', async t => {
  const {app, calls, identities} = loadServer({blocked: true});
  const base = await localServer(t, app);
  for (const [route, method] of [
    ['/api/meeting-minutes-agent/prepare', 'POST'],
    ['/api/settings', 'GET'],
    ['/api/auth/session', 'GET'],
    ['/api/meeting-agent/transcript-subscription', 'POST'],
    ['/api/meeting-minutes-agent/testing/reset-memory-cache', 'POST'],
    ['/api/project-update-test/projects/19/tasks', 'GET'],
    ['/api/review-feedback/summary', 'GET']
  ]) {
    const before = calls.length;
    const response = await fetch(base + route, {method,
      headers: {'Content-Type': 'application/json', Connection: 'close'},
      ...(method === 'POST' ? {body: '{invalid JSON'} : {})});
    assert.equal(response.status, 503, route);
    assert.equal((await response.json()).code, 'RUNTIME_IDENTITY_UNAVAILABLE');
    assert.deepEqual(calls.slice(before), ['identity'], route);
  }
  assert.equal(identities.length, 1);
  assert.equal(identities[0].role, 'web');
  assert.equal(identities[0].sourceRoot, root);
  const page = await fetch(base + '/dashboard', {headers: {Connection: 'close'}});
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Existing page/);
  assert.ok(calls.every(name => name === 'identity'), 'blocked requests cannot refresh settings or reach API owners');
});

test('the actual server preserves normal API parsing and honors the configured listener address', async t => {
  const {app, calls, listen} = loadServer({env: {PORT: '4178', HOST: '172.17.0.1'}});
  const base = await localServer(t, app);
  const response = await fetch(base + '/api/meeting-minutes-agent/prepare', {method: 'POST',
    headers: {'Content-Type': 'application/json', Connection: 'close'}, body: '{"transcript":"synthetic"}'});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {ok: true, owner: 'prepare', body: {transcript: 'synthetic'}});
  assert.deepEqual(calls, ['identity', 'refresh', 'prepare']);
  assert.deepEqual(listen, [['4178', '172.17.0.1']]);
  assert.deepEqual(loadServer().listen, [[3978, '0.0.0.0']], 'unconfigured live listening behavior is retained');
});

test('a ready sandbox blocks integrations and password resets while minutes, project and login APIs retain their normal dispatch', async t => {
  const {app, calls} = loadServer({sandbox: true});
  const base = await localServer(t, app);
  for (const route of ['/api/meeting-agent/transcript-subscription',
    '/api/meeting-minutes-agent/testing/reset-memory-cache', '/api/agent/finalise', '/api/jobs/run-once',
    '/api/auth/forgot-password', '/api/auth/reset-password']) {
    const before = calls.length;
    const response = await fetch(base + route, {method: 'POST',
      headers: {'Content-Type': 'application/json', Connection: 'close'}, body: '{invalid JSON'});
    assert.equal(response.status, 403, route);
    assert.deepEqual(await response.json(), {ok: false, error: 'This integration is disabled on the testing site.'});
    assert.deepEqual(calls.slice(before), ['identity'], 'integration block precedes parsing and owners: ' + route);
  }
  for (const [route, owner, method] of [['/api/meeting-minutes-agent/prepare', 'prepare', 'POST'],
    ['/api/project-update-test/projects', 'projects', 'GET'], ['/api/auth/login', 'login', 'POST']]) {
    const response = await fetch(base + route, {method, headers: {'Content-Type': 'application/json', Connection: 'close'},
      ...(method === 'POST' ? {body: '{}'} : {})});
    assert.equal(response.status, 200, route);
    assert.equal((await response.json()).owner, owner);
  }
});

test('normal production retains integration and password-reset endpoints without the sandbox-only block', async t => {
  const {app, calls} = loadServer();
  const base = await localServer(t, app);
  for (const [route, owner] of [['/api/meeting-agent/transcript-subscription', 'graph'],
    ['/api/meeting-minutes-agent/testing/reset-memory-cache', 'baseline'],
    ['/api/agent/finalise', 'delivery'], ['/api/jobs/run-once', 'manual-worker'],
    ['/api/auth/forgot-password', 'forgot-password'], ['/api/auth/reset-password', 'reset-password']]) {
    const before = calls.length;
    const response = await fetch(base + route, {method: 'POST',
      headers: {'Content-Type': 'application/json', Connection: 'close'}, body: '{}'});
    assert.equal(response.status, 200, route);
    assert.equal((await response.json()).owner, owner);
    assert.deepEqual(calls.slice(before), ['identity', 'refresh', owner]);
  }
});

async function loadWorker({blocked = false, result = true, jobType = 'meeting_minutes_generate'} = {}) {
  const calls = [], identities = [], sleeps = [];
  let claimed = false;
  const modules = {
    dotenv: {config() {calls.push('environment');}},
    '../utils/db': {
      ensureMeetingJobQueueSchema: async () => {calls.push('schema');},
      claimNextGenerationJob: async () => {
        calls.push('claim');
        if (claimed) return null;
        claimed = true;
        return {jobId: 1, meetingId: 2, jobType, transcriptLength: 10};
      }
    },
    '../utils/meetingMinutesGenerator': {
      processMeetingMinutesJob: async () => {calls.push('minutes'); return {ok: true};}
    },
    '../utils/projectUpdateGenerator': {
      processProjectUpdateJob: async () => {calls.push('project'); return {ok: true};}
    },
    '../utils/settingsStore': {
      refreshIfStale: async () => {calls.push('settings-if-stale');},
      refresh: async () => {calls.push('settings');}
    },
    '../utils/runtimeIdentity': {createRuntimeIdentity(options) {
      identities.push(options);
      return {assertCurrent() {
        calls.push('identity');
        if (blocked) throw Object.assign(new Error('Testing is unavailable.'), {statusCode: 503});
        return result;
      }};
    }}
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'scripts/meeting_minutes_final_worker.js'), 'utf8'), {
    require(name) {
      assert.ok(Object.hasOwn(modules, name), 'Unexpected worker dependency: ' + name);
      return modules[name];
    },
    process: {env: {}, pid: 123, exit() {assert.fail('Worker should not exit');}},
    setTimeout(callback, milliseconds) {sleeps.push(milliseconds);},
    console: {log() {}, error() {}}
  }, {filename: 'meeting_minutes_final_worker.js'});
  await new Promise(resolve => setImmediate(resolve));
  return {calls, identities, sleeps};
}

test('the actual queue worker never claims work or calls processing owners when parity fails', async () => {
  const {calls, identities, sleeps} = await loadWorker({blocked: true});
  assert.deepEqual(calls, ['environment', 'schema', 'identity']);
  assert.equal(identities.length, 1);
  assert.equal(identities[0].role, 'queue');
  assert.deepEqual(sleeps, [5000]);
});

for (const [jobType, owner, result] of [
  ['meeting_minutes_generate', 'minutes', true],
  ['project_update_generate', 'project', false]
]) test('the actual queue worker checks identity before claiming ' + jobType + ' and retains normal dispatch', async () => {
  const {calls, sleeps} = await loadWorker({jobType, result});
  assert.deepEqual(calls, ['environment', 'schema', 'identity', 'settings-if-stale', 'claim', 'settings', owner,
    'identity', 'settings-if-stale', 'claim']);
  assert.deepEqual(sleeps, [5000]);
});
