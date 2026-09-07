'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DIRECT_LINE_BASE_URL,
  generateCopilotStudioTokenDetails,
  generateTokenDetails
} = require('../utils/copilot');

const COPILOT_STUDIO_ENDPOINT = 'https://example.environment.api.powerplatform.com/powervirtualagents/botsbyschema/example_agent/directline/token?api-version=2022-03-01-preview';

test('Copilot Studio token endpoint and regional settings produce Web Chat connection details', async () => {
  const requests = [];
  const result = await generateCopilotStudioTokenDetails(COPILOT_STUDIO_ENDPOINT, async (url, options) => {
    requests.push({ url, options });
    if (url.includes('/regionalchannelsettings')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ channelUrlsById: { directline: 'https://europe.directline.botframework.com/' } })
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ token: 'endpoint-token', conversationId: 'conversation-2', expires_in: 3600 })
    };
  });

  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.options.method === 'GET'));
  assert.ok(requests.every(request => request.options.headers.Accept === 'application/json'));
  assert.ok(requests.some(request => request.url === COPILOT_STUDIO_ENDPOINT));
  assert.ok(requests.some(request => request.url === 'https://example.environment.api.powerplatform.com/powervirtualagents/regionalchannelsettings?api-version=2022-03-01-preview'));
  assert.deepEqual(result, {
    token: 'endpoint-token',
    conversationId: 'conversation-2',
    expiresIn: 3600,
    domain: 'https://europe.directline.botframework.com/v3/directline'
  });
});

test('Copilot Studio token endpoint rejects untrusted hosts', async () => {
  await assert.rejects(
    generateCopilotStudioTokenDetails('https://attacker.example/token', async () => {
      throw new Error('must not fetch');
    }),
    error => error.statusCode === 503 && /invalid/.test(error.message)
  );
});

test('Copilot Studio errors do not expose upstream payloads or endpoint details', async () => {
  await assert.rejects(
    generateCopilotStudioTokenDetails(COPILOT_STUDIO_ENDPOINT, async url => ({
      ok: false,
      status: url.includes('/regionalchannelsettings') ? 503 : 401,
      json: async () => ({ error: 'sensitive upstream detail' })
    })),
    error => {
      assert.equal(error.statusCode, 502);
      assert.deepEqual(error.details, { tokenStatus: 401, settingsStatus: 503 });
      assert.doesNotMatch(JSON.stringify(error), /sensitive upstream detail|example_agent/);
      return true;
    }
  );
});

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
