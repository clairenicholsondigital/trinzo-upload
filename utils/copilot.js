const fetch = require('node-fetch');

const DIRECT_LINE_BASE_URL = 'https://europe.directline.botframework.com/v3/directline';

async function generateToken() {
  const tokenResponse = await fetch(`${DIRECT_LINE_BASE_URL}/tokens/generate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.DIRECTLINE_SECRET}`
    }
  });

  const tokenData = await tokenResponse.json();
  if (!tokenData || !tokenData.token) {
    const error = new Error('No token returned');
    error.details = tokenData;
    throw error;
  }

  return tokenData.token;
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
  generateToken,
  startConversation,
  sendMessage,
  getBotMessages
};
