'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const meetingAgentRoutes = require('../routes/meetingAgent');

const TENANT_ID = 'dc1777ad-431d-438b-a622-5b668de256bd';
const CLIENT_ID = 'dbd55bcd-ee38-4586-ab33-8c87ac26be2f';
const CONVERSATION_ID = '0d110e7e-2b7e-4270-a899-fd2af6fde333';

function token(overrides = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({
    tid: TENANT_ID, azp: CLIENT_ID, aud: '00000003-0000-0000-c000-000000000000', ...overrides
  })).toString('base64url');
  return `${header}.${claims}.signature`;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// Graph's own example turn: the prompt echoed back, then the answer.
function chatTurn(reply) {
  return {
    id: CONVERSATION_ID,
    turnCount: 1,
    messages: [
      { id: 'm1', text: 'the prompt echoed back' },
      { id: 'm2', text: reply, attributions: [{ attributionType: 'citation' }] }
    ]
  };
}

async function startApp(fetchImpl) {
  // The guard reads the expected tenant and client from the environment.
  process.env.MICROSOFT_TENANT_ID = TENANT_ID;
  process.env.MICROSOFT_APPLICATION_ID = CLIENT_ID;
  const app = express();
  app.use('/api/meeting-agent', meetingAgentRoutes.createMeetingAgentRouter({ fetchImpl }));
  app.use((error, req, res, next) => { void next; res.status(error.statusCode || 500).json({ ok: false, error: error.message }); });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

function fakeGraph(handlers = {}) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || 'GET', body: options.body });
      if (String(url).includes('/v1.0/me')) return json({ id: 'user-1', displayName: 'Claire Nicholson' });
      if (String(url).endsWith('/copilot/conversations')) {
        return handlers.create ? handlers.create() : json({ id: CONVERSATION_ID, createdDateTime: 'now', state: 'active' }, 201);
      }
      if (String(url).includes('/chat')) {
        return handlers.chat ? handlers.chat() : json(chatTurn('Copilot answered.'));
      }
      return json({ error: { message: 'unexpected url' } }, 500);
    }
  };
}

async function post(baseUrl, path, body, auth = token()) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

test('a chat turn returns the reply, not the prompt echoed back at you', async () => {
  const graph = fakeGraph();
  const { server, baseUrl } = await startApp(graph.fetchImpl);
  try {
    const result = await post(baseUrl, `/api/meeting-agent/conversation/${CONVERSATION_ID}/chat`, { message: 'Summarise this.' });
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.reply, 'Copilot answered.');
    assert.equal(result.body.conversationId, CONVERSATION_ID);
    // The whole turn is handed back too, so a test harness can read the
    // attributions and labels that make this API worth calling directly.
    assert.equal(result.body.conversation.messages.length, 2);
    assert.equal(result.body.conversation.messages[1].attributions[0].attributionType, 'citation');

    const chat = graph.calls.find((call) => call.url.includes('/chat'));
    const sent = JSON.parse(chat.body);
    assert.equal(sent.message.text, 'Summarise this.');
    // Graph requires locationHint; defaulting it saves every caller a 400.
    assert.equal(sent.locationHint.timeZone, 'Europe/London');
  } finally { server.close(); }
});

test('ask opens a conversation and takes a turn in one call', async () => {
  const graph = fakeGraph();
  const { server, baseUrl } = await startApp(graph.fetchImpl);
  try {
    const result = await post(baseUrl, '/api/meeting-agent/ask', { message: 'What is in my calendar?', timeZone: 'America/New_York' });
    assert.equal(result.status, 200);
    assert.equal(result.body.reply, 'Copilot answered.');
    const urls = graph.calls.map((call) => call.url);
    assert.ok(urls.some((url) => url.endsWith('/copilot/conversations')), 'created a conversation');
    assert.ok(urls.some((url) => url.includes(`/conversations/${CONVERSATION_ID}/chat`)), 'then chatted into it');
    assert.equal(JSON.parse(graph.calls.find((c) => c.url.includes('/chat')).body).locationHint.timeZone, 'America/New_York');
  } finally { server.close(); }
});

test('a failed turn still hands back the conversation it opened', async () => {
  // Otherwise the caller has a conversation they cannot find and cannot retry.
  const graph = fakeGraph({ chat: () => json({ error: { message: 'Copilot is busy.' } }, 429) });
  const { server, baseUrl } = await startApp(graph.fetchImpl);
  try {
    const result = await post(baseUrl, '/api/meeting-agent/ask', { message: 'Hello' });
    assert.equal(result.status, 429);
    assert.equal(result.body.ok, false);
    assert.match(result.body.error, /busy/);
    assert.equal(result.body.conversationId, CONVERSATION_ID);
  } finally { server.close(); }
});

test('the conversation id is checked before it reaches a Graph URL', async () => {
  const graph = fakeGraph();
  const { server, baseUrl } = await startApp(graph.fetchImpl);
  try {
    const result = await post(baseUrl, '/api/meeting-agent/conversation/not-a-uuid/chat', { message: 'Hello' });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /not valid/i);
    // Nothing was sent to Graph on the strength of an unchecked path segment.
    assert.equal(graph.calls.filter((call) => call.url.includes('/chat')).length, 0);
  } finally { server.close(); }
});

test('an empty or oversized message is refused here rather than at Graph', async () => {
  const graph = fakeGraph();
  const { server, baseUrl } = await startApp(graph.fetchImpl);
  try {
    const empty = await post(baseUrl, `/api/meeting-agent/conversation/${CONVERSATION_ID}/chat`, { message: '   ' });
    assert.equal(empty.status, 400);
    const huge = await post(baseUrl, `/api/meeting-agent/conversation/${CONVERSATION_ID}/chat`, { message: 'x'.repeat(16001) });
    assert.equal(huge.status, 400);
    assert.match(huge.body.error, /16000 characters/);
    assert.equal(graph.calls.filter((call) => call.url.includes('/chat')).length, 0);
  } finally { server.close(); }
});

test('extra grounding and the web-search switch are passed through as Graph defines them', async () => {
  const graph = fakeGraph();
  const { server, baseUrl } = await startApp(graph.fetchImpl);
  try {
    await post(baseUrl, `/api/meeting-agent/conversation/${CONVERSATION_ID}/chat`, {
      message: 'Whose birthday is it?',
      additionalContext: [{ text: "John Doe's birthday is on January 1st." }],
      webSearch: false
    });
    const sent = JSON.parse(graph.calls.find((call) => call.url.includes('/chat')).body);
    assert.deepEqual(sent.additionalContext, [{ text: "John Doe's birthday is on January 1st." }]);
    assert.equal(sent.contextualResources.webContext.isWebEnabled, false);
  } finally { server.close(); }
});

test('a sign-in from another tenant cannot use the proxy', async () => {
  const graph = fakeGraph();
  const { server, baseUrl } = await startApp(graph.fetchImpl);
  try {
    const other = token({ tid: '11111111-2222-4333-8444-555555555555' });
    const result = await post(baseUrl, '/api/meeting-agent/ask', { message: 'Hello' }, other);
    assert.equal(result.status, 401);
    assert.equal(graph.calls.length, 0, 'rejected before any Graph call');
  } finally { server.close(); }
});
