'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { createBaselineTestingRouter } = require('../routes/baselineTesting');

async function startApp(options) {
  const app = express();
  app.use('/api/meeting-minutes-agent/testing', createBaselineTestingRouter(options));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({
      server,
      url: `http://127.0.0.1:${server.address().port}/api/meeting-minutes-agent/testing/reset-memory-cache`
    }));
  });
}

test('the baseline reset endpoint requires its dedicated bearer token', async (t) => {
  let resetCalls = 0;
  const { server, url } = await startApp({
    token: 'correct-token',
    clearMemoryCaches: async () => { resetCalls += 1; return {}; }
  });
  t.after(() => server.close());

  for (const authorization of ['', 'Bearer wrong-token']) {
    const response = await fetch(url, { method: 'POST', headers: authorization ? { Authorization: authorization } : {} });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal(resetCalls, 0);
});

test('a token hash can authorise a reset without storing the bearer token', async (t) => {
  const token = 'baseline-secret';
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const { server, url } = await startApp({
    token: '', tokenHash,
    clearMemoryCaches: async () => ({ cleared: { stagedCandidates: 2 } })
  });
  t.after(() => server.close());

  const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.cleared.stagedCandidates, 2);
  assert.match(body.note, /Persisted drafts/);
});

test('a busy reset is a retryable conflict with cache state', async (t) => {
  const { server, url } = await startApp({
    token: 'correct-token',
    clearMemoryCaches: async () => {
      const error = new Error('Meeting-minutes work is still running. Retry the reset after it finishes.');
      error.statusCode = 409;
      error.code = 'BASELINE_RESET_BUSY';
      error.state = { stageSpeculationsRunning: 1 };
      throw error;
    }
  });
  t.after(() => server.close());

  const response = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer correct-token' } });
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.code, 'BASELINE_RESET_BUSY');
  assert.equal(body.state.stageSpeculationsRunning, 1);
});
