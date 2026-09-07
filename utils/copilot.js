const fetch = require('node-fetch');

const DIRECT_LINE_BASE_URL = 'https://europe.directline.botframework.com/v3/directline';

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
  return generateTokenDetails(process.env.M365AGENT_SECRET1);
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
  generateTokenDetails,
  generateToken,
  generateM365AgentToken,
  startConversation,
  sendMessage,
  getBotMessages
};
