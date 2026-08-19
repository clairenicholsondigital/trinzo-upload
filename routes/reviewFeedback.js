const express = require('express');

const {
  createReviewFeedback,
  listReviewFeedback,
  reviewScreenshotPath,
  updateReviewFeedbackStatus
} = require('../utils/reviewFeedbackStore');

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const entry = await createReviewFeedback(req.body || {}, req.authUser || {});
    return res.status(201).json({ ok: true, entry });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      ok: false,
      error: error.message || 'Feedback could not be saved.'
    });
  }
});

router.get('/', async (req, res) => {
  try {
    const entries = await listReviewFeedback({ limit: req.query?.limit || 100 });
    return res.json({ ok: true, entries });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'Feedback could not be loaded.' });
  }
});

router.patch('/:feedbackId', async (req, res) => {
  try {
    const entry = await updateReviewFeedbackStatus(String(req.params.feedbackId || ''), req.body?.status);
    if (!entry) return res.status(404).json({ ok: false, error: 'Feedback not found.' });
    return res.json({ ok: true, entry });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      ok: false,
      error: error.message || 'Feedback could not be updated.'
    });
  }
});

router.get('/screenshots/:fileName', async (req, res) => {
  const file = reviewScreenshotPath(req.params.fileName);
  if (!file) return res.status(404).send('Screenshot not found.');
  return res.sendFile(file, (error) => {
    if (error && !res.headersSent) res.status(404).send('Screenshot not found.');
  });
});

module.exports = router;
