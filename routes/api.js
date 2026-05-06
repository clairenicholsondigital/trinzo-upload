const express = require('express');
const multer = require('multer');
const mammoth = require('mammoth');
const fetch = require('node-fetch');
const {
  generateToken,
  startConversation,
  sendMessage,
  getBotMessages
} = require('../utils/copilot');
const { extractTextFromUpload } = require('../utils/transcript');
const { testConnection, saveUploadedJob } = require('../utils/db');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const REVIEW_TEMPLATE = {
  meetingTitle: '',
  meetingDate: '',
  meetingLocation: '',
  meetingDescription: '',
  meetingObjectives: [],
  participants: {
    client: [],
    trinzo: []
  },
  meetingMinutes: [
    {
      topic: '',
      discussionPoints: []
    }
  ],
  nextSteps: [
    {
      action: '',
      owner: '',
      deadline: ''
    }
  ],
  autosave: {
    enabled: true,
    savedAt: '',
    transcript: '',
    transcriptLength: 0
  }
};

function extractJsonFromText(text) {
  if (!text) return null;
  let cleaned = String(text).trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
  try {
    return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
  } catch (error) {
    console.error('JSON parse failed:', error.message);
    return null;
  }
}

function asString(value) {
  if (value == null) return '';
  return typeof value === 'string' ? value : String(value);
}

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => asString(v)).filter(Boolean);
}

function normalizeReviewData(candidate, transcriptText = '') {
  const source = (candidate && typeof candidate === 'object') ? candidate : {};
  const normalized = {
    meetingTitle: asString(source.meetingTitle),
    meetingDate: asString(source.meetingDate),
    meetingLocation: asString(source.meetingLocation),
    meetingDescription: asString(source.meetingDescription),
    meetingObjectives: asStringArray(source.meetingObjectives),
    participants: {
      client: asStringArray(source.participants?.client),
      trinzo: asStringArray(source.participants?.trinzo)
    },
    meetingMinutes: Array.isArray(source.meetingMinutes)
      ? source.meetingMinutes.map((item) => ({
          topic: asString(item?.topic),
          discussionPoints: asStringArray(item?.discussionPoints)
        })).filter((item) => item.topic || item.discussionPoints.length)
      : [],
    nextSteps: Array.isArray(source.nextSteps)
      ? source.nextSteps.map((item) => ({
          action: asString(item?.action),
          owner: asString(item?.owner),
          deadline: asString(item?.deadline)
        })).filter((item) => item.action || item.owner || item.deadline)
      : []
  };

  normalized.autosave = {
    enabled: true,
    savedAt: new Date().toISOString(),
    transcript: asString(transcriptText || source.autosave?.transcript),
    transcriptLength: asString(transcriptText || source.autosave?.transcript).length
  };

  return normalized;
}

function hasAnyApprovedContent(reviewData) {
  return Boolean(
    reviewData.meetingTitle ||
    reviewData.meetingDate ||
    reviewData.meetingLocation ||
    reviewData.meetingDescription ||
    reviewData.meetingObjectives.length ||
    reviewData.participants.client.length ||
    reviewData.participants.trinzo.length ||
    reviewData.meetingMinutes.length ||
    reviewData.nextSteps.length
  );
}

function buildFinalisationPayload(reviewData) {
  return { approved: true, approvedAt: new Date().toISOString(), source: 'trinzo-upload', reviewData };
}

async function postToWebhook(payload) { /* unchanged */
  const webhookUrl = process.env.POWER_AUTOMATE_WEBHOOK_URL;
  if (!webhookUrl) { const error = new Error('POWER_AUTOMATE_WEBHOOK_URL is not configured.'); error.statusCode = 500; throw error; }
  const response = await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const rawBody = await response.text();
  let parsedBody = null;
  if (rawBody) { try { parsedBody = JSON.parse(rawBody); } catch { parsedBody = rawBody; } }
  if (!response.ok) { const error = new Error(`Webhook call failed with status ${response.status}.`); error.statusCode = 502; error.details = parsedBody || rawBody || null; throw error; }
  return { status: response.status, body: parsedBody, rawBody };
}

async function askAgent(prompt, userId) {
  const token = await generateToken();
  const conversationId = await startConversation(token);
  await sendMessage(token, conversationId, userId, prompt);
  await new Promise((resolve) => setTimeout(resolve, 90000));
  const { botMessages, activitiesData } = await getBotMessages(token, conversationId, userId);
  return { conversationId, botMessages, activitiesData, finalText: botMessages[botMessages.length - 1] || '' };
}



router.get('/db/health', async (req, res) => {
  try {
    const now = await testConnection();
    return res.json({ ok: true, connected: true, databaseTime: now });
  } catch (error) {
    return res.status(500).json({ ok: false, connected: false, error: error.message });
  }
});

router.post('/extract-docx', upload.single('file'), async (req, res) => { /* unchanged */
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file selected.' });
    const { fileName, mimeType, text, unsupported } = await extractTextFromUpload(req.file, mammoth);
    if (unsupported) return res.status(400).json({ ok: false, error: 'Unsupported file type. Please upload a .docx or .txt file.' });
    if (!text || !text.trim()) return res.status(400).json({ ok: false, error: 'Text extraction succeeded but content is empty.' });

    let savedJob = null;
    let dbWarning = null;
    try {
      savedJob = await saveUploadedJob({ fileName, mimeType, transcriptText: text });
    } catch (dbError) {
      dbWarning = `Upload processed but DB save failed: ${dbError.message}`;
      console.error('DB save failed:', dbError.message);
    }

    return res.json({ ok: true, fileName, mimeType, extractedText: text, extractedTextLength: text.length, savedJob, dbWarning });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: error.message || 'Failed text extraction.' });
  }
});

router.post('/agent/process', async (req, res) => {
  try {
    const extractedText = req.body?.extractedText;
    if (!extractedText || !extractedText.trim()) return res.status(400).json({ ok: false, error: 'Missing extractedText.' });

    const prompt = `Format meeting transcript for review\n\nReturn meeting minutes as JSON.\n\nYou must reply with a single valid JSON object only.\nNo markdown or extra text.\n\nUse this exact schema and key names:\n${JSON.stringify(REVIEW_TEMPLATE, null, 2)}\n\nRules:\n- Use only information explicitly present in the transcript.\n- Keep arrays and nested objects exactly as shown.\n- Use empty strings/arrays when missing.\n- Include autosave object with transcript left empty (server will fill it).\n\nTranscript:\n${extractedText}`;

    const agent = await askAgent(prompt, 'trinzo-process-user');
    if (!agent.finalText) return res.status(502).json({ ok: false, error: 'Agent processing failed: empty response.', conversationId: agent.conversationId });

    const parsed = extractJsonFromText(agent.finalText);
    if (!parsed) return res.status(502).json({ ok: false, error: 'Agent returned invalid output. JSON not found.', agentRawOutput: agent.finalText, conversationId: agent.conversationId });

    const reviewData = normalizeReviewData(parsed, extractedText);
    return res.json({ ok: true, conversationId: agent.conversationId, reviewData, reviewDataJson: JSON.stringify(reviewData, null, 2), agentRawOutput: agent.finalText });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: error.message || 'Agent processing failed.' });
  }
});

router.post('/agent/finalise', async (req, res) => {
  try {
    const reviewData = normalizeReviewData(req.body?.reviewData, req.body?.transcript || '');
    if (!hasAnyApprovedContent(reviewData)) return res.status(400).json({ ok: false, error: 'Cannot finalise. No reviewed meeting minutes content was provided.' });
    const payload = buildFinalisationPayload(reviewData);
    const webhookResult = await postToWebhook(payload);
    return res.json({ ok: true, approvedContent: JSON.stringify(reviewData, null, 2), payload, webhookStatus: webhookResult.status, webhookResponse: webhookResult.body || webhookResult.rawBody || null, finalMessage: 'Approved content sent to Power Automate webhook successfully.' });
  } catch (error) {
    console.error(error);
    return res.status(error.statusCode || 500).json({ ok: false, error: error.message || 'Finalisation webhook call failed.', details: error.details || null });
  }
});

router.post('/copilot-chat', async (req, res) => {
  try {
    const prompt = req.body?.prompt;
    if (!prompt || !prompt.trim()) return res.status(400).json({ ok: false, error: 'Missing prompt.' });
    const agent = await askAgent(prompt, 'trinzo-chat-test-user');
    return res.json({ ok: true, conversationId: agent.conversationId, botMessages: agent.botMessages, finalText: agent.finalText });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: error.message || 'Chat test failed.' });
  }
});

module.exports = router;
