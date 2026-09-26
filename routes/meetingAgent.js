const express = require('express');
const crypto = require('node:crypto');
const multer = require('multer');
const mammoth = require('mammoth');
const fetch = require('node-fetch');

const { extractTextFromUpload } = require('../utils/transcript');
const { createTranscriptStore } = require('../utils/meetingAgentTranscriptStore');

const GRAPH_AUDIENCES = new Set([
  '00000003-0000-0000-c000-000000000000',
  'https://graph.microsoft.com'
]);
const GRAPH_ME_URL = 'https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName';
const COPILOT_CONVERSATIONS_URL = 'https://graph.microsoft.com/beta/copilot/conversations';
// Copilot answers a document summary in ten seconds or so, and a cold one takes
// longer; 20s is right for opening a conversation and too short for a turn.
const COPILOT_CHAT_TIMEOUT_MS = 120000;
const COPILOT_MESSAGE_LIMIT = 16000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GRAPH_SUBSCRIPTIONS_URL = 'https://graph.microsoft.com/v1.0/subscriptions';
const COPILOT_SCOPES = [
  'User.Read',
  'Sites.Read.All',
  'Mail.Read',
  'People.Read.All',
  'OnlineMeetingTranscript.Read.All',
  'Chat.Read',
  'ChannelMessage.Read.All',
  'ExternalItem.Read.All'
];
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_EXTRACTED_CHARACTERS = 2 * 1024 * 1024;
const UPLOAD_WINDOW_MS = 10 * 60 * 1000;
const UPLOADS_PER_WINDOW = 10;
const SUBSCRIPTION_LIFETIME_MS = 71 * 60 * 60 * 1000;
const SUBSCRIPTION_RENEWAL_WINDOW_MS = 12 * 60 * 60 * 1000;
const DEFAULT_TRANSCRIPT_STORE_PATH = '/var/lib/m365-agent-test/transcript-subscriptions.json';

function configuredUuid(name) {
  const value = String(process.env[name] || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : '';
}

function bearerToken(req) {
  const value = String(req.headers.authorization || '');
  const match = value.match(/^Bearer\s+([^\s]+)$/i);
  return match && match[1].length <= 20000 ? match[1] : '';
}

function decodeJwtClaims(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function createMicrosoftUserMiddleware({ fetchImpl = fetch } = {}) {
  return async function requireMicrosoftUser(req, res, next) {
    try {
      const expectedTenant = configuredUuid('MICROSOFT_TENANT_ID');
      const expectedClient = configuredUuid('MICROSOFT_APPLICATION_ID');
      if (!expectedTenant || !expectedClient) {
        return res.status(503).json({ ok: false, error: 'Microsoft authentication is not configured.' });
      }

      const token = bearerToken(req);
      const claims = decodeJwtClaims(token);
      const callingClient = String(claims?.azp || claims?.appid || '').toLowerCase();
      const audience = String(claims?.aud || '').toLowerCase();

      if (!token || !claims
        || String(claims.tid || '').toLowerCase() !== expectedTenant
        || callingClient !== expectedClient
        || !GRAPH_AUDIENCES.has(audience)) {
        return res.status(401).json({ ok: false, error: 'A valid Trinzo Microsoft sign-in is required.' });
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      let graphResponse;
      try {
        graphResponse = await fetchImpl(GRAPH_ME_URL, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeout);
      }

      const profile = await readJson(graphResponse);
      if (!graphResponse.ok || !profile?.id) {
        return res.status(401).json({ ok: false, error: 'Your Microsoft sign-in has expired or is not authorised.' });
      }

      req.microsoftUser = {
        id: String(profile.id),
        displayName: String(profile.displayName || ''),
        email: String(profile.mail || profile.userPrincipalName || '')
      };
      req.microsoftAccessToken = token;
      return next();
    } catch (error) {
      if (error.name === 'AbortError') {
        return res.status(503).json({ ok: false, error: 'Microsoft identity verification timed out. Please try again.' });
      }
      return next(error);
    }
  };
}

function createUploadRateLimiter() {
  const windows = new Map();
  return function uploadRateLimit(req, res, next) {
    const key = req.microsoftUser?.id || req.ip || 'unknown';
    const now = Date.now();
    const current = windows.get(key);
    const entry = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + UPLOAD_WINDOW_MS }
      : current;
    entry.count += 1;
    windows.set(key, entry);

    if (windows.size > 1000) {
      for (const [candidate, value] of windows) {
        if (value.resetAt <= now) windows.delete(candidate);
      }
    }

    res.set('X-RateLimit-Limit', String(UPLOADS_PER_WINDOW));
    res.set('X-RateLimit-Remaining', String(Math.max(0, UPLOADS_PER_WINDOW - entry.count)));
    if (entry.count > UPLOADS_PER_WINDOW) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ ok: false, error: 'Too many uploads. Please wait a few minutes and try again.' });
    }
    return next();
  };
}

const docxUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (req, file, callback) => {
    if (!String(file.originalname || '').toLowerCase().endsWith('.docx')) {
      const error = new Error('Please upload a Microsoft Word .docx file.');
      error.statusCode = 400;
      return callback(error);
    }
    return callback(null, true);
  }
});

function runSingleUpload(req, res) {
  return new Promise((resolve, reject) => {
    docxUpload.single('file')(req, res, (error) => (error ? reject(error) : resolve()));
  });
}

function publicUser(user) {
  return { id: user.id, displayName: user.displayName, email: user.email };
}

function publicOrigin() {
  const candidate = String(process.env.MEETING_AGENT_PUBLIC_ORIGIN || 'https://trinzo.virtual-hub.online').trim();
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) return '';
    return url.origin;
  } catch {
    return '';
  }
}

function publicSubscription(subscription) {
  return {
    id: subscription.id,
    expirationDateTime: subscription.expirationDateTime,
    active: Date.parse(subscription.expirationDateTime) > Date.now(),
    lifecycleEvent: subscription.lifecycleEvent || ''
  };
}

async function graphJson(fetchImpl, url, options, timeoutMs = 20000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    return { response, body: await readJson(response) };
  } finally {
    clearTimeout(timeout);
  }
}

// The conversation id is interpolated into a Graph URL, so it is checked
// against the shape Graph issues rather than escaped and hoped for.
function copilotConversationUrl(conversationId) {
  const id = String(conversationId || '').trim();
  if (!UUID_PATTERN.test(id)) return '';
  return `${COPILOT_CONVERSATIONS_URL}/${id}/chat`;
}

// The request body Graph expects. locationHint is required by the API, so it is
// defaulted rather than left for the caller to discover through a 400.
function copilotChatBody(payload = {}) {
  const text = String(payload.message ?? payload.text ?? '');
  if (!text.trim()) return { error: 'Send a message to ask Copilot.' };
  if (text.length > COPILOT_MESSAGE_LIMIT) {
    return { error: `A message must be ${COPILOT_MESSAGE_LIMIT} characters or fewer.` };
  }
  const body = {
    message: { text },
    locationHint: { timeZone: String(payload.timeZone || 'Europe/London') }
  };
  if (Array.isArray(payload.additionalContext) && payload.additionalContext.length) {
    body.additionalContext = payload.additionalContext
      .map((item) => ({ text: String(item?.text ?? item ?? '') }))
      .filter((item) => item.text.trim())
      .slice(0, 20);
  }
  if (payload.contextualResources && typeof payload.contextualResources === 'object') {
    body.contextualResources = payload.contextualResources;
  } else if (payload.webSearch === false) {
    body.contextualResources = { webContext: { isWebEnabled: false } };
  }
  return { body };
}

// Graph returns the whole turn: the prompt echoed back, then the answer. The
// reply is the last message, and pulling it out is the difference between a
// usable test harness and one that makes every caller re-derive it.
function copilotReplyText(conversation = {}) {
  const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = String(messages[index]?.text || '').trim();
    if (text) return text;
  }
  return '';
}

function createMeetingAgentRouter(options = {}) {
  const router = express.Router();
  const fetchImpl = options.fetchImpl || fetch;
  const requireMicrosoftUser = createMicrosoftUserMiddleware(options);
  const uploadRateLimit = createUploadRateLimiter();
  const transcriptStore = options.transcriptStore || createTranscriptStore(
    options.transcriptStorePath || process.env.MEETING_AGENT_TRANSCRIPT_STORE_PATH || DEFAULT_TRANSCRIPT_STORE_PATH
  );

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.post('/transcript-notifications', express.json({ limit: '256kb' }), async (req, res, next) => {
    const validationToken = typeof req.query.validationToken === 'string' ? req.query.validationToken : '';
    if (validationToken) {
      res.type('text/plain');
      return res.status(200).send(validationToken);
    }

    try {
      const notifications = Array.isArray(req.body?.value) ? req.body.value.slice(0, 100) : [];
      for (const notification of notifications) {
        const subscriptionId = String(notification?.subscriptionId || '');
        const clientState = String(notification?.clientState || '');
        if (!subscriptionId || !clientState) continue;
        const subscription = await transcriptStore.subscriptionById(subscriptionId);
        const supplied = Buffer.from(clientState);
        const expected = Buffer.from(String(subscription?.clientState || ''));
        if (!subscription || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) continue;

        const lifecycleEvent = String(notification?.lifecycleEvent || '');
        if (lifecycleEvent) {
          await transcriptStore.markLifecycle(subscriptionId, lifecycleEvent.slice(0, 80));
          continue;
        }

        const resource = String(notification?.resource || '').slice(0, 2000);
        if (!resource) continue;
        await transcriptStore.addEvent({
          id: crypto.randomUUID(),
          subscriptionId,
          userId: subscription.userId,
          changeType: String(notification?.changeType || 'created').slice(0, 40),
          resource,
          resourceId: String(notification?.resourceData?.id || '').slice(0, 1000),
          receivedAt: new Date().toISOString()
        });
      }
      return res.sendStatus(202);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/config', (req, res) => {
    const clientId = configuredUuid('MICROSOFT_APPLICATION_ID');
    const tenantId = configuredUuid('MICROSOFT_TENANT_ID');
    if (!clientId || !tenantId) {
      return res.status(503).json({ ok: false, error: 'Microsoft authentication is not configured.' });
    }
    return res.json({
      ok: true,
      clientId,
      tenantId,
      redirectPath: '/meeting-agent/auth-redirect',
      scopes: COPILOT_SCOPES
    });
  });

  router.get('/session', requireMicrosoftUser, (req, res) => {
    return res.json({ ok: true, user: publicUser(req.microsoftUser) });
  });

  router.post('/transcript-subscription', requireMicrosoftUser, async (req, res, next) => {
    try {
      const origin = publicOrigin();
      if (!origin) return res.status(503).json({ ok: false, error: 'The transcript webhook URL is not configured.' });

      const existing = await transcriptStore.subscriptionForUser(req.microsoftUser.id);
      const remainingMs = existing ? Date.parse(existing.expirationDateTime) - Date.now() : 0;
      if (remainingMs > SUBSCRIPTION_RENEWAL_WINDOW_MS && !existing.lifecycleEvent) {
        return res.json({ ok: true, subscription: publicSubscription(existing), renewed: false });
      }

      const expirationDateTime = new Date(Date.now() + SUBSCRIPTION_LIFETIME_MS).toISOString();
      const headers = {
        Authorization: `Bearer ${req.microsoftAccessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      };
      let graphResult;
      if (existing?.id && remainingMs > 0 && !existing.lifecycleEvent) {
        graphResult = await graphJson(fetchImpl, `${GRAPH_SUBSCRIPTIONS_URL}/${encodeURIComponent(existing.id)}`, {
          method: 'PATCH', headers, body: JSON.stringify({ expirationDateTime })
        });
      }

      if (!graphResult || graphResult.response.status === 404) {
        const webhookUrl = `${origin}/api/meeting-agent/transcript-notifications`;
        const requestBody = {
          changeType: 'created',
          notificationUrl: webhookUrl,
          lifecycleNotificationUrl: webhookUrl,
          resource: `users/${req.microsoftUser.id}/onlineMeetings/getAllTranscripts`,
          expirationDateTime,
          clientState: crypto.randomBytes(32).toString('hex'),
          includeResourceData: false,
          latestSupportedTlsVersion: 'v1_2'
        };
        graphResult = await graphJson(fetchImpl, GRAPH_SUBSCRIPTIONS_URL, {
          method: 'POST', headers, body: JSON.stringify(requestBody)
        });
        if (graphResult.response.status === 201 && graphResult.body?.id) {
          await transcriptStore.saveSubscription({
            id: String(graphResult.body.id),
            userId: req.microsoftUser.id,
            clientState: requestBody.clientState,
            resource: requestBody.resource,
            expirationDateTime: String(graphResult.body.expirationDateTime || expirationDateTime),
            createdAt: new Date().toISOString()
          });
        } else if (graphResult.response.ok) {
          return res.status(502).json({ ok: false, error: 'Microsoft created an incomplete transcript subscription.' });
        }
      } else if (graphResult.response.ok && existing) {
        await transcriptStore.saveSubscription({
          ...existing,
          expirationDateTime: String(graphResult.body?.expirationDateTime || expirationDateTime),
          lifecycleEvent: '',
          renewedAt: new Date().toISOString()
        });
      }

      if (!graphResult.response.ok) {
        const graphErrorCode = String(graphResult.body?.error?.innerError?.code || '');
        const detail = graphErrorCode === 'GraphAccessToTranscriptsDisabled'
          ? 'A Microsoft 365 administrator needs to enable Teams transcript API access before monitoring can start.'
          : graphResult.body?.error?.message || 'Microsoft could not start transcript monitoring.';
        return res.status(graphResult.response.status >= 400 && graphResult.response.status < 500
          ? graphResult.response.status : 502).json({ ok: false, error: detail, code: graphErrorCode });
      }

      const saved = await transcriptStore.subscriptionForUser(req.microsoftUser.id);
      if (!saved) return res.status(502).json({ ok: false, error: 'The transcript subscription could not be saved.' });
      return res.status(graphResult.response.status === 201 ? 201 : 200).json({
        ok: true,
        subscription: publicSubscription(saved),
        renewed: Boolean(existing)
      });
    } catch (error) {
      if (error.name === 'AbortError') {
        return res.status(503).json({ ok: false, error: 'Microsoft transcript monitoring timed out. Please try again.' });
      }
      return next(error);
    }
  });

  router.get('/transcript-events', requireMicrosoftUser, async (req, res, next) => {
    try {
      const events = await transcriptStore.eventsForUser(req.microsoftUser.id);
      return res.json({
        ok: true,
        events: events.map((event) => ({
          id: event.id,
          changeType: event.changeType,
          receivedAt: event.receivedAt
        }))
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/conversation', requireMicrosoftUser, async (req, res, next) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      let graphResponse;
      try {
        graphResponse = await fetchImpl(COPILOT_CONVERSATIONS_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${req.microsoftAccessToken}`,
            Accept: 'application/json',
            'Content-Type': 'application/json'
          },
          body: '{}',
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeout);
      }

      const conversation = await readJson(graphResponse);
      if (graphResponse.status !== 201 || !conversation?.id) {
        const detail = conversation?.error?.message || 'Microsoft 365 Copilot could not create a conversation.';
        return res.status(graphResponse.status >= 400 && graphResponse.status < 500 ? graphResponse.status : 502)
          .json({ ok: false, error: detail });
      }

      return res.status(201).json({
        ok: true,
        conversation: {
          id: String(conversation.id),
          createdDateTime: String(conversation.createdDateTime || ''),
          state: String(conversation.state || conversation.status || 'active')
        }
      });
    } catch (error) {
      if (error.name === 'AbortError') {
        return res.status(503).json({ ok: false, error: 'Microsoft 365 Copilot timed out. Please try again.' });
      }
      return next(error);
    }
  });

  // Shared by both shapes below: send one turn into a conversation.
  async function sendCopilotChat(accessToken, conversationId, payload) {
    const url = copilotConversationUrl(conversationId);
    if (!url) return { status: 400, error: 'That conversation id is not valid.' };
    const built = copilotChatBody(payload);
    if (built.error) return { status: 400, error: built.error };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), COPILOT_CHAT_TIMEOUT_MS);
    let graphResponse;
    try {
      graphResponse = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(built.body),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    const conversation = await readJson(graphResponse);
    if (!graphResponse.ok) {
      return {
        status: graphResponse.status >= 400 && graphResponse.status < 500 ? graphResponse.status : 502,
        error: conversation?.error?.message || 'Microsoft 365 Copilot could not answer.'
      };
    }
    return { status: 200, conversation };
  }

  // Continue an existing conversation. The whole Graph turn is returned as well
  // as the reply, because the point of this endpoint is looking at what came
  // back - attributions, sensitivity labels and all.
  router.post('/conversation/:conversationId/chat', requireMicrosoftUser, express.json({ limit: '256kb' }), async (req, res, next) => {
    try {
      const result = await sendCopilotChat(req.microsoftAccessToken, req.params.conversationId, req.body || {});
      if (result.error) return res.status(result.status).json({ ok: false, error: result.error });
      return res.json({
        ok: true,
        conversationId: String(result.conversation.id || req.params.conversationId),
        turnCount: Number(result.conversation.turnCount || 0),
        reply: copilotReplyText(result.conversation),
        conversation: result.conversation
      });
    } catch (error) {
      if (error.name === 'AbortError') {
        return res.status(504).json({ ok: false, error: 'Microsoft 365 Copilot timed out. Please try again.' });
      }
      return next(error);
    }
  });

  // One call for a single-shot question: open a conversation and take one turn
  // in it. A test harness should not need two round trips to ask one thing.
  router.post('/ask', requireMicrosoftUser, express.json({ limit: '256kb' }), async (req, res, next) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      let createResponse;
      try {
        createResponse = await fetchImpl(COPILOT_CONVERSATIONS_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${req.microsoftAccessToken}`,
            Accept: 'application/json',
            'Content-Type': 'application/json'
          },
          body: '{}',
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeout);
      }
      const created = await readJson(createResponse);
      if (createResponse.status !== 201 || !created?.id) {
        return res.status(createResponse.status >= 400 && createResponse.status < 500 ? createResponse.status : 502)
          .json({ ok: false, error: created?.error?.message || 'Microsoft 365 Copilot could not create a conversation.' });
      }

      const result = await sendCopilotChat(req.microsoftAccessToken, created.id, req.body || {});
      if (result.error) {
        // The conversation exists even though the turn failed; hand its id back
        // so the caller can retry into it rather than orphaning it.
        return res.status(result.status).json({ ok: false, error: result.error, conversationId: String(created.id) });
      }
      return res.json({
        ok: true,
        conversationId: String(result.conversation.id || created.id),
        turnCount: Number(result.conversation.turnCount || 0),
        reply: copilotReplyText(result.conversation),
        conversation: result.conversation
      });
    } catch (error) {
      if (error.name === 'AbortError') {
        return res.status(504).json({ ok: false, error: 'Microsoft 365 Copilot timed out. Please try again.' });
      }
      return next(error);
    }
  });

  router.post('/upload', requireMicrosoftUser, uploadRateLimit, async (req, res, next) => {
    try {
      await runSingleUpload(req, res);
      if (!req.file) return res.status(400).json({ ok: false, error: 'Choose a Word document to upload.' });

      const extracted = await extractTextFromUpload(req.file, mammoth);
      const text = String(extracted.text || '');
      if (extracted.unsupported || !text.trim()) {
        return res.status(400).json({ ok: false, error: 'The Word document is empty or could not be read.' });
      }
      if (text.length > MAX_EXTRACTED_CHARACTERS) {
        return res.status(413).json({ ok: false, error: 'The Word document contains too much text.' });
      }

      return res.json({
        ok: true,
        file: {
          name: extracted.fileName,
          size: req.file.size,
          extractedCharacters: text.length
        },
        user: publicUser(req.microsoftUser)
      });
    } catch (error) {
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ ok: false, error: 'The Word document is too large. Maximum size is 5 MB.' });
      }
      if (error.statusCode && error.statusCode < 500) {
        return res.status(error.statusCode).json({ ok: false, error: error.message });
      }
      return next(error);
    }
  });

  return router;
}

const router = createMeetingAgentRouter();
router.createMeetingAgentRouter = createMeetingAgentRouter;
router.createMicrosoftUserMiddleware = createMicrosoftUserMiddleware;
router.decodeJwtClaims = decodeJwtClaims;
router.bearerToken = bearerToken;

module.exports = router;
