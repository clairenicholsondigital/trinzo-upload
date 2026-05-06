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
const {
  testConnection,
  saveUploadedJob,
  saveMeetingMinutes,
  listMeetings,
  getMeetingById,
  deleteMeetingById,
  updateMeetingById,
  getMeetingStatus,
  claimNextJob,
  markJobCompleted,
  markJobFailure,
  queueWebhookJob,
  markWebhookSuccess,
  markWebhookFailure,
  hasDatabaseConfig,
  getDatabaseConfigError
} = require('../utils/db');

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
  const minutes = Array.isArray(reviewData.meetingMinutes) ? reviewData.meetingMinutes : [];
  const nextSteps = Array.isArray(reviewData.nextSteps) ? reviewData.nextSteps : [];

  return {
    approved: 'true',
    approvedAt: new Date().toISOString(),
    source: 'trinzo-upload',

    meetingTitle: asString(reviewData.meetingTitle),
    meetingDate: asString(reviewData.meetingDate),
    meetingLocation: asString(reviewData.meetingLocation),
    meetingDescription: asString(reviewData.meetingDescription),

    meetingObjectives: asStringArray(reviewData.meetingObjectives).join('\n'),

    clientAttendees: asStringArray(reviewData.participants?.client).join('\n'),
    participantsTrinzo: asStringArray(reviewData.participants?.trinzo).join('\n'),

    itemTopic: minutes.map((item) => asString(item.topic)).filter(Boolean).join('\n'),

    discussionPoints: minutes
      .flatMap((item) => asStringArray(item.discussionPoints))
      .join('\n'),

    meetingActionPoint: nextSteps
      .map((item) => asString(item.action))
      .filter(Boolean)
      .join('\n'),

    meetingActionPointOwner: nextSteps
      .map((item) => asString(item.owner))
      .filter(Boolean)
      .join('\n'),

    approvedcontent: JSON.stringify(reviewData, null, 2)
  };
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

router.post('/extract-docx', upload.single('file'), async (req, res) => { /* unchanged */
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file selected.' });
    const { fileName, mimeType, text, unsupported } = await extractTextFromUpload(req.file, mammoth);
    if (unsupported) return res.status(400).json({ ok: false, error: 'Unsupported file type. Please upload a .docx or .txt file.' });
    if (!text || !text.trim()) return res.status(400).json({ ok: false, error: 'Text extraction succeeded but content is empty.' });
    return res.json({ ok: true, fileName, mimeType, extractedText: text, extractedTextLength: text.length });
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


router.post('/meetings/save', async (req, res) => {
  console.log('[POST /api/meetings/save] Route hit');

  if (!hasDatabaseConfig()) {
    return res.status(500).json({ success: false, error: getDatabaseConfigError() });
  }

  try {
    const result = await saveMeetingMinutes(req.body || {});
    console.log(`[POST /api/meetings/save] Meeting inserted with ID ${result.meetingId}`);
    return res.json({ success: true, meetingId: result.meetingId, jobId: result.jobId, status: result.status });
  } catch (error) {
    console.error('[POST /api/meetings/save] Database save failed:', error.message);
    return res.status(500).json({ success: false, error: error.message || 'Database save failed.' });
  }
});

router.get('/meetings', async (req, res) => {
  if (!hasDatabaseConfig()) return res.status(500).json({ success: false, error: getDatabaseConfigError() });
  try {
    const meetings = await listMeetings();
    return res.json({ success: true, meetings });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to load meetings.' });
  }
});

router.get('/meetings/:id', async (req, res) => {
  if (!hasDatabaseConfig()) return res.status(500).json({ success: false, error: getDatabaseConfigError() });
  try {
    const meeting = await getMeetingById(req.params.id);
    if (!meeting) return res.status(404).json({ success: false, error: 'Meeting not found.' });
    return res.json({ success: true, meeting });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to load meeting.' });
  }
});

router.put('/meetings/:id', async (req, res) => {
  if (!hasDatabaseConfig()) return res.status(500).json({ success: false, error: getDatabaseConfigError() });
  try {
    const existing = await getMeetingById(req.params.id);
    if (!existing) return res.status(404).json({ success: false, error: 'Meeting not found.' });
    const payload = { ...req.body, payload: { ...(req.body?.payload || {}), source: 'meeting-update' } };
    const result = await updateMeetingById(req.params.id, payload);
    return res.json({ success: true, meetingId: result.meetingId, message: 'Meeting updated.' });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to update meeting.' });
  }
});



router.get('/meetings/:meetingId/status', async (req, res) => {
  if (!hasDatabaseConfig()) return res.status(500).json({ success: false, error: getDatabaseConfigError() });
  try {
    const data = await getMeetingStatus(req.params.meetingId);
    if (!data) return res.status(404).json({ success: false, error: 'Meeting not found.' });
    return res.json({ success: true, ...data });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to load meeting status.' });
  }
});

router.post('/jobs/run-once', async (req, res) => {
  if (!hasDatabaseConfig()) return res.status(500).json({ success: false, error: getDatabaseConfigError() });
  const workerId = `manual-${process.pid}`;
  try {
    const job = await claimNextJob(workerId);
    if (!job) return res.json({ success: true, message: 'No queued jobs available.' });

    if (job.jobType === 'agent_extract') {
      // Hook existing extraction pipeline here when background extraction is wired.
      await markJobCompleted(job.id, job.meetingId, { message: 'Agent extract job claimed successfully. Hook existing extraction here.' });
      return res.json({ success: true, processed: { ...job, finalStatus: 'completed' } });
    }

    if (job.jobType === 'webhook_send') {
      const meeting = await getMeetingById(job.meetingId);
      const payload = buildFinalisationPayload({ meetingTitle: meeting?.meetingTitle || '', meetingDate: meeting?.meetingDate || '', meetingLocation: meeting?.meetingLocation || '', meetingDescription: meeting?.meetingDescription || '', meetingObjectives: [], participants: { client: [], trinzo: [] }, meetingMinutes: [], nextSteps: [] });
      try {
        const webhookResult = await postToWebhook(payload);
        await markWebhookSuccess(job.id, job.meetingId, { webhookStatus: webhookResult.status, webhookResponse: webhookResult.body || webhookResult.rawBody || null });
        return res.json({ success: true, processed: { ...job, finalStatus: 'completed' } });
      } catch (error) {
        await markWebhookFailure(job, error.message || 'Webhook send failed.');
        return res.status(502).json({ success: false, processed: { ...job, finalStatus: 'failed' }, error: error.message || 'Webhook send failed.' });
      }
    }

    await markJobFailure(job, `Unsupported job type: ${job.jobType}`);
    return res.status(400).json({ success: false, error: `Unsupported job type: ${job.jobType}` });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Job runner failed.' });
  }
});

router.post('/meetings/:meetingId/webhook', async (req, res) => {
  if (!hasDatabaseConfig()) return res.status(500).json({ success: false, error: getDatabaseConfigError() });
  try {
    const meeting = await getMeetingById(req.params.meetingId);
    if (!meeting) return res.status(404).json({ success: false, error: 'Meeting not found.' });
    const reviewData = normalizeReviewData(req.body?.reviewData || meeting, req.body?.transcript || '');
    const payload = buildFinalisationPayload(reviewData);
    const queued = await queueWebhookJob(req.params.meetingId, payload);
    return res.json({ success: true, meetingId: Number(req.params.meetingId), jobId: queued.jobId, webhookStatus: queued.webhookStatus });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to queue webhook job.' });
  }
});

router.delete('/meetings/:id', async (req, res) => {
  if (!hasDatabaseConfig()) return res.status(500).json({ success: false, error: getDatabaseConfigError() });
  try {
    const deleted = await deleteMeetingById(req.params.id);
    if (!deleted) return res.status(404).json({ success: false, error: 'Meeting not found.' });
    return res.json({ success: true, message: 'Meeting deleted.' });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'Failed to delete meeting.' });
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
