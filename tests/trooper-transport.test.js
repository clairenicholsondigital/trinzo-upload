'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { trooperFetch, retryAfterMs, resetTrooperTransportForTests } = require('../utils/trooperTransport');

function response(status, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => '',
    json: async () => ({})
  };
}

test.beforeEach(() => resetTrooperTransportForTests());

test('Trooper transport serialises calls across concurrent staged work', async () => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const started = [];
  const fetchImpl = async (_url, init) => {
    started.push(init.body);
    if (started.length === 1) await firstGate;
    return response(200);
  };
  const first = trooperFetch('https://trooper.test', { body: 'first' }, { fetchImpl, maxRetries: 0, minIntervalMs: 0 });
  const second = trooperFetch('https://trooper.test', { body: 'second' }, { fetchImpl, maxRetries: 0, minIntervalMs: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['first']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(started, ['first', 'second']);
});

test('Trooper transport retries a 429 and records the attempt count', async () => {
  let calls = 0;
  const result = await trooperFetch('https://trooper.test', {}, {
    fetchImpl: async () => response(++calls === 1 ? 429 : 200, { 'retry-after': '0' }),
    maxRetries: 1,
    minIntervalMs: 0,
    baseDelayMs: 0,
    jitterMs: 0,
    waitImpl: async () => {}
  });
  assert.equal(calls, 2);
  assert.equal(result.trooperTransport.attempts, 2);
  assert.equal(result.trooperTransport.retries, 1);
});

test('Trooper transport preserves exhausted rate-limit diagnostics', async () => {
  await assert.rejects(
    trooperFetch('https://trooper.test', {}, {
      fetchImpl: async () => response(429, { 'retry-after': '2', 'x-ratelimit-remaining': '0' }),
      maxRetries: 0,
      minIntervalMs: 0,
      jitterMs: 0
    }),
    (error) => error.statusCode === 429 && error.retryable === true && error.rateLimitHeaders['x-ratelimit-remaining'] === '0'
  );
  assert.equal(retryAfterMs(response(429, { 'retry-after': '2' }), 10), 2000);
});
