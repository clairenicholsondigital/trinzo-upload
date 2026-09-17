'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const meetingAgentRoutes = require('../routes/meetingAgent');

const TENANT_ID = 'dc1777ad-431d-438b-a622-5b668de256bd';
const CLIENT_ID = 'dbd55bcd-ee38-4586-ab33-8c87ac26be2f';

function token(overrides = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({
    tid: TENANT_ID,
    azp: CLIENT_ID,
    aud: '00000003-0000-0000-c000-000000000000',
    ...overrides
  })).toString('base64url');
  return `${header}.${claims}.signature`;
}

async function startApp(fetchImpl, options = {}) {
  const app = express();
  app.use('/api/meeting-agent', meetingAgentRoutes.createMeetingAgentRouter({ fetchImpl, ...options }));
  app.use((error, req, res, next) => {
    void next;
    res.status(error.statusCode || 500).json({ ok: false, error: error.message });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({
      server,
      baseUrl: `http://127.0.0.1:${server.address().port}`
    }));
  });
}

function graphProfileFetch(requests) {
  return async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({
      id: 'microsoft-user-1',
      displayName: 'Claire Nicholson',
      mail: 'clairenicholson@trinzo.com',
      userPrincipalName: 'clairenicholson@trinzo.com'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

test.before(() => {
  process.env.MICROSOFT_TENANT_ID = TENANT_ID;
  process.env.MICROSOFT_APPLICATION_ID = CLIENT_ID;
});

test('public config exposes identifiers but no secrets', async (t) => {
  const { server, baseUrl } = await startApp(async () => { throw new Error('must not call Graph'); });
  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/api/meeting-agent/config`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(body, {
    ok: true,
    clientId: CLIENT_ID,
    tenantId: TENANT_ID,
    redirectPath: '/meeting-agent/auth-redirect',
    scopes: [
      'User.Read',
      'Sites.Read.All',
      'Mail.Read',
      'People.Read.All',
      'OnlineMeetingTranscript.Read.All',
      'Chat.Read',
      'ChannelMessage.Read.All',
      'ExternalItem.Read.All'
    ]
  });
  assert.doesNotMatch(JSON.stringify(body), /secret|token/i);
});

test('session rejects missing, wrong-tenant, and wrong-client bearer tokens before Graph', async (t) => {
  let graphCalls = 0;
  const { server, baseUrl } = await startApp(async () => {
    graphCalls += 1;
    throw new Error('must not call Graph');
  });
  t.after(() => server.close());

  const attempts = [
    {},
    { Authorization: `Bearer ${token({ tid: '11111111-1111-4111-8111-111111111111' })}` },
    { Authorization: `Bearer ${token({ azp: '22222222-2222-4222-8222-222222222222' })}` }
  ];
  for (const headers of attempts) {
    const response = await fetch(`${baseUrl}/api/meeting-agent/session`, { headers });
    assert.equal(response.status, 401);
  }
  assert.equal(graphCalls, 0);
});

test('session verifies the Graph token and returns a bounded user profile', async (t) => {
  const requests = [];
  const { server, baseUrl } = await startApp(graphProfileFetch(requests));
  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/api/meeting-agent/session`, {
    headers: { Authorization: `Bearer ${token()}` }
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.user, {
    id: 'microsoft-user-1',
    displayName: 'Claire Nicholson',
    email: 'clairenicholson@trinzo.com'
  });
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /^https:\/\/graph\.microsoft\.com\/v1\.0\/me/);
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${token()}`);
});

test('conversation verifies the user and creates a Copilot conversation without exposing the token', async (t) => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.includes('/v1.0/me')) {
      return new Response(JSON.stringify({
        id: 'microsoft-user-1',
        displayName: 'Claire Nicholson',
        userPrincipalName: 'clairenicholson@trinzo.com'
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      id: 'copilot-conversation-1',
      createdDateTime: '2026-09-17T13:41:12Z',
      status: 'active'
    }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  };
  const { server, baseUrl } = await startApp(fetchImpl);
  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/api/meeting-agent/conversation`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}` }
  });
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.deepEqual(body.conversation, {
    id: 'copilot-conversation-1',
    createdDateTime: '2026-09-17T13:41:12Z',
    state: 'active'
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, 'https://graph.microsoft.com/beta/copilot/conversations');
  assert.equal(requests[1].options.method, 'POST');
  assert.equal(requests[1].options.body, '{}');
  assert.equal(JSON.stringify(body).includes(token()), false);
});

test('transcript webhook echoes Microsoft validation tokens as plain text', async (t) => {
  const { server, baseUrl } = await startApp(async () => { throw new Error('must not call Graph'); });
  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/api/meeting-agent/transcript-notifications?validationToken=graph-check`, {
    method: 'POST'
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/plain/);
  assert.equal(await response.text(), 'graph-check');
});

test('transcript subscription uses the granted user-scoped resource and stores no access token', async (t) => {
  const directory = fs.mkdtempSync('/tmp/meeting-agent-subscription-');
  const storePath = path.join(directory, 'subscriptions.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.includes('/v1.0/me')) return graphProfileFetch([])(url, options);
    return new Response(JSON.stringify({
      id: 'subscription-1',
      expirationDateTime: '2026-09-20T12:00:00Z'
    }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  };
  const { server, baseUrl } = await startApp(fetchImpl, { transcriptStorePath: storePath });
  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/api/meeting-agent/transcript-subscription`, {
    method: 'POST', headers: { Authorization: `Bearer ${token()}` }
  });
  const body = await response.json();
  const graphBody = JSON.parse(requests[1].options.body);

  assert.equal(response.status, 201);
  assert.equal(body.subscription.id, 'subscription-1');
  assert.equal(requests[1].url, 'https://graph.microsoft.com/v1.0/subscriptions');
  assert.equal(graphBody.resource, 'users/microsoft-user-1/onlineMeetings/getAllTranscripts');
  assert.equal(graphBody.includeResourceData, false);
  assert.equal(graphBody.notificationUrl, 'https://trinzo.virtual-hub.online/api/meeting-agent/transcript-notifications');
  assert.equal(graphBody.lifecycleNotificationUrl, graphBody.notificationUrl);
  assert.equal(graphBody.clientState.length, 64);
  const persisted = fs.readFileSync(storePath, 'utf8');
  assert.equal(persisted.includes(token()), false);
  assert.equal(fs.statSync(storePath).mode & 0o777, 0o600);
});

test('transcript webhook accepts only matching client state and events remain user-scoped', async (t) => {
  const subscriptions = {
    'subscription-1': {
      id: 'subscription-1', userId: 'microsoft-user-1', clientState: 'correct-secret',
      expirationDateTime: '2099-01-01T00:00:00Z'
    }
  };
  const events = [];
  const transcriptStore = {
    subscriptionById: async (id) => subscriptions[id] || null,
    markLifecycle: async () => true,
    addEvent: async (event) => { events.push(event); return true; },
    eventsForUser: async (userId) => events.filter((event) => event.userId === userId),
    subscriptionForUser: async (userId) => Object.values(subscriptions).find((item) => item.userId === userId),
    saveSubscription: async () => {}
  };
  const { server, baseUrl } = await startApp(graphProfileFetch([]), { transcriptStore });
  t.after(() => server.close());

  for (const clientState of ['wrong-secret', 'correct-secret']) {
    const response = await fetch(`${baseUrl}/api/meeting-agent/transcript-notifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: [{
        subscriptionId: 'subscription-1', clientState, changeType: 'created',
        resource: "users/microsoft-user-1/onlineMeetings('meeting')/transcripts('transcript')"
      }] })
    });
    assert.equal(response.status, 202);
  }
  assert.equal(events.length, 1);

  const response = await fetch(`${baseUrl}/api/meeting-agent/transcript-events`, {
    headers: { Authorization: `Bearer ${token()}` }
  });
  const body = await response.json();
  assert.equal(body.events.length, 1);
  assert.equal(body.events[0].resource, undefined);
});

test('transcript subscription explains the tenant-level Teams transcript block', async (t) => {
  const fetchImpl = async (url, options) => {
    if (url.includes('/v1.0/me')) return graphProfileFetch([])(url, options);
    return new Response(JSON.stringify({ error: {
      code: 'Forbidden',
      message: 'Graph API access to transcripts is disabled for this tenant.',
      innerError: { code: 'GraphAccessToTranscriptsDisabled' }
    } }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  };
  const transcriptStore = {
    subscriptionForUser: async () => null
  };
  const { server, baseUrl } = await startApp(fetchImpl, { transcriptStore });
  t.after(() => server.close());

  const response = await fetch(`${baseUrl}/api/meeting-agent/transcript-subscription`, {
    method: 'POST', headers: { Authorization: `Bearer ${token()}` }
  });
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.equal(body.code, 'GraphAccessToTranscriptsDisabled');
  assert.match(body.error, /administrator needs to enable Teams transcript API access/);
});

test('upload rejects non-DOCX files and accepts a readable DOCX without returning its text', async (t) => {
  const requests = [];
  const { server, baseUrl } = await startApp(graphProfileFetch(requests));
  t.after(() => server.close());
  const headers = { Authorization: `Bearer ${token()}` };

  const invalidForm = new FormData();
  invalidForm.append('file', new Blob(['plain text'], { type: 'text/plain' }), 'notes.txt');
  const invalidResponse = await fetch(`${baseUrl}/api/meeting-agent/upload`, {
    method: 'POST', headers, body: invalidForm
  });
  assert.equal(invalidResponse.status, 400);

  const fixture = path.resolve(__dirname, '../scripts/meeting-minutes-core-golden/cases/08_attendee_provenance/transcript.docx');
  const validForm = new FormData();
  validForm.append('file', new Blob([fs.readFileSync(fixture)], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }), 'meeting.docx');
  const validResponse = await fetch(`${baseUrl}/api/meeting-agent/upload`, {
    method: 'POST', headers, body: validForm
  });
  const body = await validResponse.json();

  assert.equal(validResponse.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.file.name, 'meeting.docx');
  assert.ok(body.file.extractedCharacters > 0);
  assert.equal(body.extractedText, undefined);
  assert.equal(JSON.stringify(body).includes('Meeting transcript'), false);
});

test('meeting agent frontend assets are built locally and avoid the legacy auth route', () => {
  const root = path.resolve(__dirname, '..');
  const view = fs.readFileSync(path.join(root, 'views/meeting-agent.html'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const bundle = fs.readFileSync(path.join(root, 'public/meeting-agent.js'), 'utf8');

  assert.match(view, /Sign in with Microsoft/);
  assert.match(view, /\/static\/meeting-agent\.js/);
  assert.match(server, /app\.get\('\/meeting-agent', \(req, res\)/);
  assert.doesNotMatch(server, /app\.get\('\/meeting-agent', authRoutes\.requireAuth/);
  assert.match(bundle, /\/api\/meeting-agent\/upload/);
});
