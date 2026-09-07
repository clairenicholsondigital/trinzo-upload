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

async function startConversation(token) {
  const response = await fetch(`${DIRECT_LINE_BASE_URL}/conversations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  });

  const data = await response.json();
  if (!data || !data.conversationId) {
    const error = new Error('No conversationId returned');
    error.details = data;
    throw error;
  }

  return data.conversationId;
}

async function sendMessage(token, conversationId, fromId, text) {
  const response = await fetch(`${DIRECT_LINE_BASE_URL}/conversations/${conversationId}/activities`, {
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

  return response.json();
}

async function getBotMessages(token, conversationId, userId) {
  const activitiesResponse = await fetch(`${DIRECT_LINE_BASE_URL}/conversations/${conversationId}/activities`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  const activitiesData = await activitiesResponse.json();
  const botMessages = (activitiesData.activities || [])
    .filter(activity => activity.type === 'message' && activity.from && activity.from.id !== userId && activity.text)
    .map(activity => activity.text);

  return { botMessages, activitiesData };
}

module.exports = {
  DIRECT_LINE_BASE_URL,
  generateCopilotStudioTokenDetails,
  generateTokenDetails,
  generateToken,
  generateM365AgentToken,
  startConversation,
  sendMessage,
  getBotMessages
};
