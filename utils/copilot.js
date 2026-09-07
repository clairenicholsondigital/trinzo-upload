const fetch = require('node-fetch');

const DIRECT_LINE_BASE_URL = 'https://europe.directline.botframework.com/v3/directline';

function parseCopilotStudioTokenEndpoint(endpoint) {
  let url;
  try {
    url = new URL(String(endpoint || '').trim());
  } catch {
    const error = new Error('Copilot Studio token endpoint is not configured.');
    error.statusCode = 503;
    throw error;
  }

  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.environment.api.powerplatform.com') ||
    !/^\/powervirtualagents\/botsbyschema\/[^/]+\/directline\/token$/i.test(url.pathname) ||
    !url.searchParams.get('api-version')
  ) {
    const error = new Error('Copilot Studio token endpoint is invalid.');
    error.statusCode = 503;
    throw error;
  }

  return url;
}

async function generateCopilotStudioTokenDetails(endpoint, fetchImpl = fetch) {
  const tokenUrl = parseCopilotStudioTokenEndpoint(endpoint);
  const regionalSettingsUrl = new URL('/powervirtualagents/regionalchannelsettings', tokenUrl.origin);
  regionalSettingsUrl.searchParams.set('api-version', tokenUrl.searchParams.get('api-version'));

  const [tokenResponse, settingsResponse] = await Promise.all([
    fetchImpl(tokenUrl.toString(), { method: 'GET', headers: { Accept: 'application/json' } }),
    fetchImpl(regionalSettingsUrl.toString(), { method: 'GET', headers: { Accept: 'application/json' } })
  ]);
  const [tokenData, settingsData] = await Promise.all([
    tokenResponse.json().catch(() => ({})),
    settingsResponse.json().catch(() => ({}))
  ]);
  const regionalBaseUrl = settingsData?.channelUrlsById?.directline;

  if (!tokenResponse.ok || !tokenData?.token || !settingsResponse.ok || !regionalBaseUrl) {
    const error = new Error('Copilot Studio did not issue valid conversation settings.');
    error.statusCode = 502;
    error.details = {
      tokenStatus: tokenResponse.status,
      settingsStatus: settingsResponse.status
    };
    throw error;
  }

  let regionalUrl;
  try {
    regionalUrl = new URL(regionalBaseUrl);
  } catch {
    const error = new Error('Copilot Studio returned an invalid Direct Line URL.');
    error.statusCode = 502;
    throw error;
  }
  if (regionalUrl.protocol !== 'https:' || !regionalUrl.hostname.endsWith('.directline.botframework.com')) {
    const error = new Error('Copilot Studio returned an invalid Direct Line URL.');
    error.statusCode = 502;
    throw error;
  }

  return {
    token: tokenData.token,
    conversationId: tokenData.conversationId || '',
    expiresIn: Number(tokenData.expires_in || 0),
    domain: `${regionalUrl.toString().replace(/\/+$/, '')}/v3/directline`
  };
}

async function generateTokenDetails(secret, fetchImpl = fetch) {
  if (!secret || !String(secret).trim()) {
    const error = new Error('Direct Line secret is not configured.');
    error.statusCode = 503;
    throw error;
  }

  const tokenResponse = await fetchImpl(`${DIRECT_LINE_BASE_URL}/tokens/generate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${String(secret).trim()}`
    }
  });

  const tokenData = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokenData || !tokenData.token) {
    const error = new Error('Direct Line did not issue a conversation token.');
    error.statusCode = 502;
    error.details = { upstreamStatus: tokenResponse.status };
    throw error;
  }

  return {
    token: tokenData.token,
    conversationId: tokenData.conversationId || '',
    expiresIn: Number(tokenData.expires_in || 0)
  };
}

async function generateToken() {
  const tokenData = await generateTokenDetails(process.env.DIRECTLINE_SECRET);
  return tokenData.token;
}

async function generateM365AgentToken() {
  return generateCopilotStudioTokenDetails(process.env.M365AGENT_TOKEN_ENDPOINT);
}

function safeDirectLineDomain(domain = DIRECT_LINE_BASE_URL) {
  const value = String(domain || '').replace(/\/+$/, '');
  let url;
  try { url = new URL(value); } catch { url = null; }
  if (!url || url.protocol !== 'https:' || !url.hostname.endsWith('.directline.botframework.com') || !/\/v3\/directline$/i.test(url.pathname)) {
    const error = new Error('Direct Line domain is invalid.');
    error.statusCode = 502;
    throw error;
  }
  return value;
}

async function startConversation(token, domain = DIRECT_LINE_BASE_URL) {
  const response = await fetch(`${safeDirectLineDomain(domain)}/conversations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data || !data.conversationId) {
    const error = new Error('No conversationId returned');
    error.statusCode = 502;
    error.details = data;
    throw error;
  }

  return data.conversationId;
}

async function sendMessage(token, conversationId, fromId, text, domain = DIRECT_LINE_BASE_URL) {
  const response = await fetch(`${safeDirectLineDomain(domain)}/conversations/${encodeURIComponent(conversationId)}/activities`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      type: 'message',
      from: { id: fromId },
      text
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.id) {
    const error = new Error('Direct Line did not accept the message.');
    error.statusCode = 502;
    throw error;
  }
  return data;
}

async function getBotMessages(token, conversationId, userId, domain = DIRECT_LINE_BASE_URL) {
  const activitiesResponse = await fetch(`${safeDirectLineDomain(domain)}/conversations/${encodeURIComponent(conversationId)}/activities`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  const activitiesData = await activitiesResponse.json().catch(() => ({}));
  if (!activitiesResponse.ok) {
    const error = new Error('Direct Line messages could not be retrieved.');
    error.statusCode = 502;
    throw error;
  }
  const botMessages = (activitiesData.activities || [])
    .filter(activity => activity.type === 'message' && activity.from && activity.from.id !== userId && activity.text)
    .map(activity => activity.text);

  return { botMessages, activitiesData };
}

async function askM365Agent(prompt, options = {}) {
  const tokenData = await generateM365AgentToken();
  const conversationId = await startConversation(tokenData.token, tokenData.domain);
  const userId = `trinzo-meeting-minutes-${Date.now()}`;
  const sent = await sendMessage(tokenData.token, conversationId, userId, prompt, tokenData.domain);
  const maxWaitMs = Math.max(5000, Number(options.maxWaitMs || 90000));
  const pollEveryMs = Math.max(500, Number(options.pollEveryMs || 2000));
  const startedAt = Date.now();

  while (Date.now() - startedAt < maxWaitMs) {
    await new Promise((resolve) => setTimeout(resolve, pollEveryMs));
    const { activitiesData } = await getBotMessages(tokenData.token, conversationId, userId, tokenData.domain);
    const botMessages = (activitiesData.activities || [])
      .filter((activity) => activity.type === 'message'
        && activity.replyToId === sent.id
        && (activity.from?.role === 'bot' || Boolean(activity.from?.name)))
      .map((activity) => String(activity.text || '').trim())
      .filter(Boolean);
    if (botMessages.length) {
      return {
        conversationId,
        botName: (activitiesData.activities || []).find((activity) => activity.replyToId === sent.id && (activity.from?.role === 'bot' || activity.from?.name))?.from?.name || '',
        finalText: botMessages[botMessages.length - 1]
      };
    }
  }

  const error = new Error('The meeting-minutes agent did not reply in time.');
  error.statusCode = 504;
  throw error;
}

module.exports = {
  DIRECT_LINE_BASE_URL,
  generateCopilotStudioTokenDetails,
  generateTokenDetails,
  generateToken,
  generateM365AgentToken,
  askM365Agent,
  startConversation,
  sendMessage,
  getBotMessages
};
