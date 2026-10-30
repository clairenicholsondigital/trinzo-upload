'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

function fixture({ configured = true, implementations = {}, authenticated = true } = {}) {
  const calls = [];
  const routeMap = new Map();
  const registrations = [];
  const implementationsByName = {
    createProjectKnowledgeItem: async input => ({ itemId: 41, ...input }),
    listProjectKnowledgeItems: async () => [{ itemId: 41 }],
    updateProjectKnowledgeItem: async () => ({ itemId: 41 }),
    archiveProjectKnowledgeItem: async () => ({ itemId: 41, archived: true }),
    getProjectContext: async () => ({ projectId: 23, activeMilestones: [{ milestoneName: 'Launch' }] }),
    getProjectKnowledgeStatus: async () => ({ active: 1, pendingEmbeddings: 0 }),
    answerProjectKnowledge: async () => ({ ok: true, answer: 'The launch is Friday.', citations: ['K1'] }),
    spawnProjectKnowledgeEmbedWorker: () => ({ spawned: true, pid: 123 }),
    ...implementations
  };
  const operation = name => (...args) => {
    calls.push({ name, args });
    return implementationsByName[name](...args);
  };
  const store = {
    hasDatabaseConfig: () => configured,
    getDatabaseConfigError: () => 'Database is not configured.',
    ...Object.fromEntries([
      'createProjectKnowledgeItem', 'listProjectKnowledgeItems', 'updateProjectKnowledgeItem',
      'archiveProjectKnowledgeItem', 'getProjectContext', 'getProjectKnowledgeStatus'
    ].map(name => [name, operation(name)]))
  };
  const knowledge = Object.fromEntries([
    'spawnProjectKnowledgeEmbedWorker', 'answerProjectKnowledge'
  ].map(name => [name, operation(name)]));
  const requireAuth = (req, res, next) => {
    if (!authenticated) return res.status(401).json({ ok: false, error: 'Authentication required.' });
    req.authUser = { userId: 7 };
    return next();
  };
  const router = Object.fromEntries(['get', 'post', 'patch', 'delete'].map(method => [method, (routePath, ...handlers) => {
    const entry = { method, path: routePath, handlers };
    registrations.push(entry);
    routeMap.set(`${method} ${routePath}`, entry);
  }]));
  // All database, provider, process and authentication I/O must use the fixture
  // ports. Module loading must not silently fall back to the production API.
  const load = Module._load;
  Module._load = function guardedLoad(request, parent, isMain) {
    if (request === 'child_process' || request === 'node:child_process'
      || /(?:^|\/)(?:db|knowledge|auth|api)(?:\.js)?$/.test(request)) {
      throw new Error(`Unexpected production dependency: ${request}`);
    }
    return load.call(this, request, parent, isMain);
  };
  try {
    require('../routes/projectKnowledge')(router, { store, knowledge, requireAuth });
  } finally {
    Module._load = load;
  }
  async function request(method, suffix, input = {}) {
    const route = routeMap.get(`${method} /project-update-test/knowledge/${suffix}`);
    assert.ok(route, `Missing route: ${method} ${suffix}`);
    const req = { query: {}, body: {}, params: {}, ...input };
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

test('knowledge routes retain their order and authentication on every handler without loading application I/O', async () => {
  const f = fixture({ authenticated: false });
  assert.deepEqual(f.registrations.map(route => [route.method, route.path.replace('/project-update-test/knowledge/', '')]), [
    ['post', 'items'], ['get', 'items'], ['patch', 'items/:itemId'], ['delete', 'items/:itemId'],
    ['post', 'ask'], ['get', 'status'], ['post', 'embeddings/process']
  ]);
  for (const route of f.registrations) {
    assert.equal(route.handlers.length, 2);
    assert.equal(route.handlers[0], f.requireAuth);
    const res = await f.request(route.method, route.path.replace('/project-update-test/knowledge/', ''));
    assert.equal(res.statusCode, 401);
  }
  assert.deepEqual(f.calls, []);
  assert.ok(!require.cache[path.resolve(__dirname, '../routes/api.js')]);
  assert.ok(!require.cache[path.resolve(__dirname, '../utils/db.js')]);
  assert.ok(!require.cache[path.resolve(__dirname, '../utils/knowledge.js')]);
});

test('knowledge creation preserves manual defaults and starts embeddings only after the item is saved', async () => {
  const f = fixture();
  const res = await f.request('post', 'items', { body: { projectId: '23', title: 'Brief', content: 'Launch Friday.' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(f.calls, [
    { name: 'createProjectKnowledgeItem', args: [{ projectId: 23, title: 'Brief', content: 'Launch Friday.', itemType: 'background_doc', isOfficial: true, metadata: { source: 'manual' } }] },
    { name: 'spawnProjectKnowledgeEmbedWorker', args: [['--project-id', '23']] }
  ]);
  assert.deepEqual(res.body.embeddingWorker, { spawned: true, pid: 123 });
  const metadata = { source: 'import', category: 'risk' };
  const explicit = fixture();
  await explicit.request('post', 'items', { body: { projectId: 23, itemType: 'decision', isOfficial: false, metadata } });
  assert.equal(explicit.calls[0].args[0].metadata, metadata);
  assert.equal(explicit.calls[0].args[0].isOfficial, false);
  assert.equal(explicit.calls[0].args[0].itemType, 'decision');
});

test('knowledge listing and status forward project filters without changing their storage contracts', async () => {
  const f = fixture();
  const list = await f.request('get', 'items', { query: { projectId: '23', itemType: 'decision', limit: '4' } });
  assert.deepEqual(f.calls[0], { name: 'listProjectKnowledgeItems', args: [{ projectId: '23', itemType: 'decision', status: 'active', limit: '4' }] });
  assert.deepEqual(list.body, { ok: true, items: [{ itemId: 41 }] });
  await f.request('get', 'items', { query: { projectId: '23', status: 'archived' } });
  assert.equal(f.calls[1].args[0].status, 'archived');
  const status = await f.request('get', 'status', { query: { projectId: '23' } });
  assert.deepEqual(f.calls[2], { name: 'getProjectKnowledgeStatus', args: [{ projectId: '23' }] });
  assert.deepEqual(status.body, { ok: true, status: { active: 1, pendingEmbeddings: 0 } });
});

test('knowledge updates trigger embeddings for an explicitly supplied content field including empty content', async () => {
  for (const body of [{ content: 'Changed.' }, { content: '' }]) {
    const f = fixture();
    const res = await f.request('patch', 'items/:itemId', { params: { itemId: '41' }, body });
    assert.deepEqual(f.calls, [
      { name: 'updateProjectKnowledgeItem', args: ['41', body] },
      { name: 'spawnProjectKnowledgeEmbedWorker', args: [['--item-id', '41']] }
    ]);
    assert.equal(res.body.ok, true);
  }
  const f = fixture();
  const res = await f.request('patch', 'items/:itemId', { params: { itemId: '41' }, body: { title: 'Renamed' } });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(res.body.embeddingWorker, { spawned: false, reason: 'content unchanged' });
});

test('missing knowledge items return JSON 404s and never start an embedding worker', async () => {
  const f = fixture({ implementations: { updateProjectKnowledgeItem: async () => null, archiveProjectKnowledgeItem: async () => null } });
  for (const method of ['patch', 'delete']) {
    const res = await f.request(method, 'items/:itemId', { params: { itemId: 'missing' } });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { ok: false, error: 'Knowledge item not found.' });
  }
  assert.ok(f.calls.every(call => call.name !== 'spawnProjectKnowledgeEmbedWorker'));
});

test('knowledge deletion keeps soft deletion by default and existing hard-delete flag semantics', async () => {
  for (const [hard, expected] of [[undefined, false], ['false', false], ['yes', true], [['false', 'ON'], true]]) {
    const f = fixture();
    const res = await f.request('delete', 'items/:itemId', { params: { itemId: '41' }, query: { hard } });
    assert.deepEqual(f.calls, [{ name: 'archiveProjectKnowledgeItem', args: ['41', { hard: expected }] }]);
    assert.deepEqual(res.body, { ok: true, item: { itemId: 41, archived: true } });
  }
});

test('knowledge questions reject invalid input as JSON before reading context or calling a provider', async () => {
  const invalid = [
    [{ projectId: 0, question: 'When?' }, 'Valid projectId is required.'],
    [{ projectId: -1, question: 'When?' }, 'Valid projectId is required.'],
    [{ projectId: 'Infinity', question: 'When?' }, 'Valid projectId is required.'],
    [{ projectId: 'invalid', question: 'When?' }, 'Valid projectId is required.'],
    [{ projectId: 23, question: '   ' }, 'Question is required.']
  ];
  for (const [body, error] of invalid) {
    const f = fixture();
    const res = await f.request('post', 'ask', { body });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { ok: false, error });
    assert.deepEqual(f.calls, []);
  }
});

test('knowledge questions carry project context, trimmed question and bounded provider limits', async () => {
  const cases = [
    [{}, {}, 8, 30000],
    [{ topK: 50, timeoutMs: 90000 }, {}, 25, 45000],
    [{ topK: -5, timeoutMs: 100 }, {}, 1, 5000],
    [{ topK: 4, timeoutMs: 12000 }, { topK: 18, timeoutMs: 20000 }, 4, 12000],
    [{}, { topK: 9, timeoutMs: 20000 }, 9, 30000]
  ];
  for (const [bodyLimits, queryLimits, topK, timeoutMs] of cases) {
    const projectContext = { projectId: 23, risks: [{ title: 'Supply delay' }] };
    const f = fixture({ implementations: { getProjectContext: async () => projectContext } });
    const res = await f.request('post', 'ask', { body: { projectId: '23', question: '  When is launch?  ', ...bodyLimits }, query: queryLimits });
    assert.deepEqual(f.calls[0], { name: 'getProjectContext', args: [{ projectId: 23 }, 8] });
    assert.deepEqual(f.calls[1], { name: 'answerProjectKnowledge', args: [{ projectId: 23, question: 'When is launch?', topK, timeoutMs, projectContext }] });
    assert.equal(f.calls[1].args[0].projectContext, projectContext);
    assert.deepEqual(res.body, { ok: true, answer: 'The launch is Friday.', citations: ['K1'] });
  }
  const query = fixture();
  await query.request('post', 'ask', { query: { projectId: '23', question: '  Query fallback  ' } });
  assert.equal(query.calls[1].args[0].question, 'Query fallback');
});

test('unconfigured knowledge storage returns JSON errors without touching storage, providers or embedding workers', async () => {
  const f = fixture({ configured: false });
  for (const [method, suffix] of [['post', 'items'], ['get', 'items'], ['patch', 'items/:itemId'], ['delete', 'items/:itemId'], ['post', 'ask'], ['get', 'status']]) {
    const res = await f.request(method, suffix);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { ok: false, error: 'Database is not configured.' });
  }
  assert.deepEqual(f.calls, []);
});

test('knowledge storage, answer and worker failures keep their intended JSON status and message', async () => {
  const routes = [
    ['post', 'items', 'createProjectKnowledgeItem'], ['get', 'items', 'listProjectKnowledgeItems'],
    ['patch', 'items/:itemId', 'updateProjectKnowledgeItem'], ['delete', 'items/:itemId', 'archiveProjectKnowledgeItem'],
    ['post', 'ask', 'getProjectContext'], ['post', 'ask', 'answerProjectKnowledge'],
    ['get', 'status', 'getProjectKnowledgeStatus'], ['post', 'embeddings/process', 'spawnProjectKnowledgeEmbedWorker']
  ];
  for (const [method, suffix, operation] of routes) {
    const error = Object.assign(new Error('Fixture operation failed.'), { statusCode: 422 });
    const f = fixture({ implementations: { [operation]: () => { throw error; } } });
    const res = await f.request(method, suffix, { body: { projectId: 23, question: 'When?' }, params: { itemId: '41' } });
    assert.equal(res.statusCode, 422);
    assert.deepEqual(res.body, { ok: false, error: 'Fixture operation failed.' });
    if (operation === 'createProjectKnowledgeItem') assert.equal(f.calls.length, 1);
  }
  const f = fixture({ implementations: { listProjectKnowledgeItems: () => { throw new Error('Unavailable.'); } } });
  const res = await f.request('get', 'items');
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { ok: false, error: 'Unavailable.' });
});

test('manual embedding processing remains available without database config and uses body then query project scope', async () => {
  for (const [input, expected] of [
    [{}, []],
    [{ body: { projectId: 23 }, query: { projectId: 99 } }, ['--project-id', '23']],
    [{ query: { projectId: '99' } }, ['--project-id', '99']]
  ]) {
    const f = fixture({ configured: false });
    const res = await f.request('post', 'embeddings/process', input);
    assert.deepEqual(f.calls, [{ name: 'spawnProjectKnowledgeEmbedWorker', args: [expected] }]);
    assert.deepEqual(res.body, { ok: true, embeddingWorker: { spawned: true, pid: 123 } });
  }
});
