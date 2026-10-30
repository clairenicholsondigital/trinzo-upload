'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
let createOriginalExecution;
Module._load = function (request, parent) {
  const resolved = Module._resolveFilename(request, parent);
  assert.ok(!/\/(?:routes\/api|utils\/meetingMinutesAgentV2)\.js$/.test(resolved),
    'Execution policy must load without the API or V2: ' + resolved);
  return originalLoad.apply(this, arguments);
};
try { ({ createOriginalExecution } = require('../utils/meetingMinutesOriginalExecution')); }
finally { Module._load = originalLoad; }

function context(t, provider, options = {}) {
  t.mock.method(console, 'info', () => {});
  t.mock.method(console, 'warn', () => {});
  const create = createOriginalExecution({
    askPowerAutomateMeetingMinutesAgentWithRetry: provider,
    usePrivateActionPrimaryPrewarm: async () => {
      throw new Error('Discussion execution must not perform action prewarm I/O.');
    }
  });
  return create({ draftId: 'execution-fixture', details: { meetingDate: '2026-10-30' },
    sourceUnits: [], discussion: [], actions: [], passCache: [] }, 'discussion', options);
}
function response(label) {
  return { result: { discussion: [], actions: [], label }, timings: [{ elapsedMs: 3, ok: true }] };
}

test('Original execution reuses an exact completed pass without another provider request', async t => {
  let requests = 0;
  const checkpoints = [];
  const c = context(t, async () => { requests += 1; return response('completed'); },
    { onCheckpoint: cache => checkpoints.push(cache) });
  const first = await c.call('critic', 'Exact fixture prompt');
  const again = await c.call('critic', 'Exact fixture prompt');
  assert.deepEqual(again, first);
  assert.equal(requests, 1);
  assert.equal(checkpoints.length, 1);
  assert.equal(c.execution.passCache.length, 1);
  assert.equal(c.passProvenance.at(-1).cached, true);
});

test('Original execution uses a stage deadline extension and retains all completed call caches', async t => {
  const deadlines = [];
  const c = context(t, async (_prompt, options) => {
    deadlines.push(options.deadlineAt);
    return response(options.pass);
  });
  await c.call('critic-first', 'First fixture prompt');
  c.execution.stageDeadlineAt += 45000;
  await c.call('critic-second', 'Second fixture prompt');
  assert.equal(deadlines[1] - deadlines[0], 45000);
  assert.equal(deadlines[1], c.execution.stageDeadlineAt);
  assert.deepEqual(c.execution.passCache.map(entry => entry.pass), ['critic-first', 'critic-second']);
  assert.deepEqual(c.completedPasses, ['critic-first', 'critic-second']);
});

test('Original concurrent pass completions preserve both results in the live cache', async t => {
  const pending = new Map();
  const c = context(t, (_prompt, options) => new Promise(resolve => pending.set(options.pass, resolve)));
  const originalCache = c.execution.passCache;
  const a = c.call('critic-a', 'Concurrent A');
  const b = c.call('critic-b', 'Concurrent B');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.size, 2);
  pending.get('discussion:critic-b')(response('B'));
  await b;
  assert.notEqual(c.execution.passCache, originalCache);
  pending.get('discussion:critic-a')(response('A'));
  await a;
  assert.deepEqual(c.execution.passCache.map(entry => entry.result.label), ['B', 'A']);
  assert.deepEqual(c.completedPasses, ['critic-b', 'critic-a']);
  assert.equal(c.passProvenance.length, 2);
});

test('Original execution retains mandatory failures and records optional failures without caching them', async t => {
  const failure = Object.assign(new Error('Fixture upstream unavailable'), { code: 'fixture_unavailable' });
  const c = context(t, async () => { throw failure; });
  await assert.rejects(c.call('critic-required', 'Required fixture prompt'), error => error === failure);
  assert.equal(await c.call('critic-optional', 'Optional fixture prompt', { optional: true }), null);
  assert.deepEqual(c.execution.passCache, []);
  assert.deepEqual(c.completedPasses, []);
  assert.equal(c.passProvenance.length, 2);
  assert.ok(c.passProvenance.every(entry => entry.failed && entry.errorCode === failure.code));
  assert.equal(c.degradedSources.length, 1);
  assert.match(c.degradedSources[0], /critic-optional.*Fixture upstream unavailable/);
});
