const express = require('express');
const multer = require('multer');
const mammoth = require('mammoth');
const {
  generateToken,
  startConversation,
  sendMessage,
  getBotMessages
} = require('../utils/copilot');
const { extractTextFromUpload } = require('../utils/transcript');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const REVIEW_TEMPLATE = {
  meetingTitle: '',
  meetingDate: '',
  meetingDescription: '',
  meetingObjectives: '',
  clientAttendees: '',
  participantsTrinzo: '',
  itemTopic: '',
  discussionPoints: '',
  meetingActionPoint: '',
  meetingActionPointOwner: ''
};

function extractJsonFromText(text) {
  if (!text) return null;

  let cleaned = String(text).trim();

  cleaned = cleaned
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  const jsonText = cleaned.slice(firstBrace, lastBrace + 1);

  try {
    return JSON.parse(jsonText);
  } catch (error) {
    console.error('JSON parse failed:', error.message);
    console.error('Raw agent output:', text);
    return null;
  }
}

function normalizeReviewData(candidate) {
  const result = { ...REVIEW_TEMPLATE };
  if (!candidate || typeof candidate !== 'object') return result;

  Object.keys(REVIEW_TEMPLATE).forEach((key) => {
    const value = candidate[key];

    if (Array.isArray(value)) {
      result[key] = value.join(', ');
    } else if (typeof value === 'string') {
      result[key] = value;
    } else if (value != null) {
      result[key] = String(value);
    }
  });

  return result;
}

function hasAnyApprovedContent(reviewData) {
  return Object.values(reviewData).some((value) => String(value || '').trim().length > 0);
}

async function askAgent(prompt, userId) {
  const token = await generateToken();
  const conversationId = await startConversation(token);

  await sendMessage(token, conversationId, userId, prompt);

  await new Promise((resolve) => setTimeout(resolve, 90000));

  const { botMessages, activitiesData } = await getBotMessages(token, conversationId, userId);

  return {
    conversationId,
    botMessages,
    activitiesData,
    finalText: botMessages[botMessages.length - 1] || ''
  };
}

router.post('/extract-docx', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'No file selected.' });
    }

    const { fileName, mimeType, text, unsupported } = await extractTextFromUpload(req.file, mammoth);

    if (unsupported) {
      return res.status(400).json({
        ok: false,
        error: 'Unsupported file type. Please upload a .docx or .txt file.'
      });
    }

    if (!text || !text.trim()) {
      return res.status(400).json({
        ok: false,
        error: 'Text extraction succeeded but content is empty.'
      });
    }

    return res.json({
      ok: true,
      fileName,
      mimeType,
      extractedText: text,
      extractedTextLength: text.length
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      ok: false,
      error: error.message || 'Failed text extraction.'
    });
  }
});

router.post('/agent/process', async (req, res) => {
  try {
    const extractedText = req.body?.extractedText;

    if (!extractedText || !extractedText.trim()) {
      return res.status(400).json({ ok: false, error: 'Missing extractedText.' });
    }

    const prompt = `Format meeting transcript for review

Return meeting minutes as JSON.

You must reply with a single valid JSON object only.

Do not trigger Power Automate.
Do not finalise anything.
Do not save anything.
Do not ask for confirmation.
Do not say "sure".
Do not say "here is".
Do not use markdown.
Do not wrap the JSON in code fences.
Do not ask a follow-up question.
Do not include any text before or after the JSON.

The JSON object must use exactly these keys:
${JSON.stringify(REVIEW_TEMPLATE, null, 2)}

Rules:
- Use only information explicitly present in the transcript.
- If a value is missing, use an empty string.
- Every value must be a string.
- No arrays.
- No nested objects.
- No extra keys.

Transcript:
${extractedText}`;

    const agent = await askAgent(prompt, 'trinzo-process-user');

    if (!agent.finalText) {
      return res.status(502).json({
        ok: false,
        error: 'Agent processing failed: empty response.',
        conversationId: agent.conversationId
      });
    }

    const parsed = extractJsonFromText(agent.finalText);

    if (!parsed) {
      return res.status(502).json({
        ok: false,
        error: 'Agent returned invalid output. JSON not found.',
        agentRawOutput: agent.finalText,
        conversationId: agent.conversationId
      });
    }

    const reviewData = normalizeReviewData(parsed);

    return res.json({
      ok: true,
      conversationId: agent.conversationId,
      reviewData,
      agentRawOutput: agent.finalText
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      ok: false,
      error: error.message || 'Agent processing failed.'
    });
  }
});

router.post('/agent/finalise', async (req, res) => {
  try {
    const reviewData = normalizeReviewData(req.body?.reviewData);

    if (!hasAnyApprovedContent(reviewData)) {
      return res.status(400).json({
        ok: false,
        error: 'Cannot finalise. No reviewed meeting minutes content was provided.'
      });
    }

    const approvedContent = JSON.stringify(reviewData, null, 2);

    const agent = await askAgent(approvedContent, 'trinzo-finalise-user');

    if (!agent.finalText) {
      return res.status(502).json({
        ok: false,
        error: 'Final agent call failed: empty response.',
        conversationId: agent.conversationId
      });
    }

    const hasLink = /(https?:\/\/\S+)/i.test(agent.finalText);
    const hasConfirmation = /(success|successful|created|submitted|completed|generated|saved|file link|document|triggered)/i.test(agent.finalText);
    const looksLikeQuestion = /\?\s*$/.test(agent.finalText);

    return res.json({
      ok: true,
      conversationId: agent.conversationId,
      approvedContent,
      finalMessage: agent.finalText,
      confirmationDetected: (hasLink || hasConfirmation) && !looksLikeQuestion,
      warning:
        (hasLink || hasConfirmation) && !looksLikeQuestion
          ? null
          : 'The agent replied, but did not clearly confirm that Power Automate ran. Check the finalise topic and flow mapping.'
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      ok: false,
      error: error.message || 'Final agent call failed.'
    });
  }
});

router.post('/copilot-chat', async (req, res) => {
  try {
    const prompt = req.body?.prompt;

    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ ok: false, error: 'Missing prompt.' });
    }

    const agent = await askAgent(prompt, 'trinzo-chat-test-user');

    return res.json({
      ok: true,
      conversationId: agent.conversationId,
      botMessages: agent.botMessages,
      finalText: agent.finalText
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      ok: false,
      error: error.message || 'Chat test failed.'
    });
  }
});

module.exports = router;
