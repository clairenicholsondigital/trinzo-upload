const express = require('express');
const multer = require('multer');
const mammoth = require('mammoth');
const {
  generateToken,
  startConversation,
  sendMessage,
  getBotMessages
} = require('../utils/copilot');
const { extractTextFromUpload, chunkText } = require('../utils/transcript');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post('/messages', async (req, res) => {
  res.json({
    type: 'message',
    text: 'Hello from your VPS Microsoft 365 agent'
  });
});

router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'No file uploaded. Use form-data field name: file' });
    }

    const { fileName, mimeType, text } = await extractTextFromUpload(req.file, mammoth);

    return res.json({
      ok: true,
      fileName,
      mimeType,
      sizeBytes: req.file.size,
      extractedTextPreview: text.slice(0, 3000),
      extractedTextLength: text.length
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: error.message || 'Upload failed' });
  }
});

router.post('/copilot-ask', async (req, res) => {
  try {
    const prompt = req.body?.prompt;
    if (!prompt) return res.status(400).json({ ok: false, error: 'Missing prompt' });

    const tokenData = { token: await generateToken() };
    return res.json({ ok: true, tokenData });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: error.message, details: error.details });
  }
});

router.post('/copilot-chat', async (req, res) => {
  try {
    const prompt = req.body?.prompt;
    if (!prompt) return res.status(400).json({ ok: false, error: 'Missing prompt' });

    const token = await generateToken();
    const conversationId = await startConversation(token);

    const sendData = await sendMessage(token, conversationId, 'trinzo-test-user', prompt);

    await new Promise(resolve => setTimeout(resolve, 9000));

    const { botMessages, activitiesData } = await getBotMessages(token, conversationId, 'trinzo-test-user');

    if (!botMessages.length) {
      return res.status(502).json({
        ok: false,
        error: 'No bot response returned',
        conversationId,
        activitiesData
      });
    }

    return res.json({ ok: true, conversationId, sendData, botMessages, activitiesData });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: error.message, details: error.details });
  }
});

router.post('/process-meeting', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });

    const { fileName, text } = await extractTextFromUpload(req.file, mammoth);
    const transcriptText = text || '';

    if (!transcriptText.trim()) {
      return res.status(400).json({ ok: false, error: 'No transcript text extracted' });
    }

    const chunks = chunkText(transcriptText, 6000);

    const token = await generateToken();
    const conversationId = await startConversation(token);

    const chunkSummaries = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const chunkPrompt = `You are assisting with meeting-minutes extraction. Read transcript chunk ${i + 1} of ${chunks.length} and return concise notes only for later consolidation. Focus on title/date/context/objectives/attendees/trinzo participants/topics/discussion/action points/owners/deadlines.\n\n${chunks[i]}`;
      await sendMessage(token, conversationId, 'trinzo-meeting-parser', chunkPrompt);
      await new Promise(resolve => setTimeout(resolve, 9000));
      const { botMessages } = await getBotMessages(token, conversationId, 'trinzo-meeting-parser');
      chunkSummaries.push(botMessages[botMessages.length - 1] || '');

      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 6000));
      }
    }

    const finalPrompt = `Create ONE whole-meeting JSON object from all chunk notes. Return ONLY valid JSON with exactly these fields:\n{\n  "meetingTitle": "",\n  "meetingDate": "",\n  "meetingDescription": "",\n  "meetingObjectives": [],\n  "clientAttendees": [],\n  "participantsTrinzo": [],\n  "itemTopic": "",\n  "discussionPoints": [],\n  "meetingActionPoint": "",\n  "meetingActionPointOwner": "",\n  "meetingActionPointDeadline": ""\n}\n\nChunk notes:\n${chunkSummaries.join('\n\n---\n\n')}`;

    await sendMessage(token, conversationId, 'trinzo-meeting-parser', finalPrompt);
    await new Promise(resolve => setTimeout(resolve, 9000));

    const { botMessages, activitiesData } = await getBotMessages(token, conversationId, 'trinzo-meeting-parser');
    const finalResponseText = botMessages[botMessages.length - 1];

    if (!finalResponseText) {
      return res.status(502).json({ ok: false, error: 'No bot response returned', conversationId, activitiesData });
    }

    return res.json({ ok: true, fileName, chunkCount: chunks.length, meeting: finalResponseText });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: error.message, details: error.details });
  }
});

module.exports = router;
