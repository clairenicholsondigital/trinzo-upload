'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DIRECT_LINE_BASE_URL, generateTokenDetails } = require('../utils/copilot');

test('Direct Line secret is exchanged server-side for bounded conversation details', async () => {
  let request;
  const result = await generateTokenDetails('test-secret', async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      json: async () => ({ token: 'short-lived-token', conversationId: 'conversation-1', expires_in: 3600 })
    };
  });

  assert.equal(request.url, `${DIRECT_LINE_BASE_URL}/tokens/generate`);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, 'Bearer test-secret');
  assert.deepEqual(result, {
    token: 'short-lived-token',
    conversationId: 'conversation-1',
    expiresIn: 3600
  });
});

test('missing Direct Line secret fails before making a network request', async () => {
  let called = false;
  await assert.rejects(
    generateTokenDetails('', async () => { called = true; }),
    error => error.statusCode === 503 && /not configured/.test(error.message)
  );
  assert.equal(called, false);
});

test('upstream token errors expose status but not response or secret material', async () => {
  await assert.rejects(
    generateTokenDetails('do-not-leak', async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: 'upstream detail' })
    })),
    error => {
      assert.equal(error.statusCode, 502);
      assert.deepEqual(error.details, { upstreamStatus: 401 });
      assert.doesNotMatch(JSON.stringify(error), /do-not-leak|upstream detail/);
      return true;
    }
  );
});
