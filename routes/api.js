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
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch (error) {
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

async function askAgent(prompt, userId) {
  const token = await generateToken();
  const conversationId = await startConversation(token);
  await sendMessage(token, conversationId, userId, prompt);
  await new Promise((resolve) => setTimeout(resolve, 9000));
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
      return res.status(400).json({ ok: false, error: 'Text extraction succeeded but content is empty.' });
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
    return res.status(500).json({ ok: false, error: error.message || 'Failed text extraction.' });
  }
});

router.post('/agent/process', async (req, res) => {
  try {
    const extractedText = req.body?.extractedText;
    if (!extractedText || !extractedText.trim()) {
      return res.status(400).json({ ok: false, error: 'Missing extractedText.' });
    }

    const prompt = `Process the following meeting transcript/document text and return structured meeting minutes output. Return ONLY valid JSON with exactly these string fields:\n${JSON.stringify(REVIEW_TEMPLATE, null, 2)}\n\nTranscript text:\n${extractedText}`;

    const agent = await askAgent(prompt, 'trinzo-process-user');

    if (!agent.finalText) {
      return res.status(502).json({ ok: false, error: 'Agent processing failed: empty response.', conversationId: agent.conversationId });
    }

    const parsed = extractJsonFromText(agent.finalText);
    if (!parsed) {
      return res.status(502).json({
        ok: false,
        error: 'Agent returned invalid output (JSON not found).',
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
    return res.status(500).json({ ok: false, error: error.message || 'Agent processing failed.' });
  }
});

router.post('/agent/finalise', async (req, res) => {
  try {
    const reviewData = normalizeReviewData(req.body?.reviewData);
    const approvedContent = JSON.stringify(reviewData, null, 2);

    if (!approvedContent.trim() || approvedContent === JSON.stringify(REVIEW_TEMPLATE, null, 2)) {
      return res.status(400).json({ ok: false, error: 'No approved review content provided.' });
    }

    const prompt = `The user has reviewed and approved the following meeting minutes output. Trigger the configured Power Automate flow using this approved content. Return the file link or confirmation message if available.\n\nApproved content JSON:\n${approvedContent}`;

    const agent = await askAgent(prompt, 'trinzo-finalise-user');

    if (!agent.finalText) {
      return res.status(502).json({ ok: false, error: 'Final agent call failed: empty response.', conversationId: agent.conversationId });
    }

    const hasLink = /(https?:\/\/\S+)/i.test(agent.finalText);
    const hasConfirmation = /(confirm|success|created|submitted|completed|generated)/i.test(agent.finalText);

    return res.json({
      ok: true,
      conversationId: agent.conversationId,
      finalMessage: agent.finalText,
      confirmationDetected: hasLink || hasConfirmation,
      // TODO: In Copilot Studio, ensure the topic/tool invokes Power Automate and returns an explicit file link/confirmation string.
      warning: hasLink || hasConfirmation ? null : 'Power Automate confirmation/file link missing from the agent reply.'
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: error.message || 'Final agent call failed.' });
  }
});

module.exports = router;
