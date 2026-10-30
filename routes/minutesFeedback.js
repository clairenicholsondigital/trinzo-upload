'use strict';

// Register on the existing router to retain middleware order, paths and stack compatibility.
module.exports = function registerMinutesFeedback(router, {
  store = require('../utils/db'),
  requireAuth = require('./auth').requireAuth,
  sendTestError = require('../utils/apiErrors').sendTestError
} = {}) {
  const {
    listMeetingMinutesFeedback,
    getMeetingMinutesFeedback,
    updateMeetingMinutesFeedback,
    deleteMeetingMinutesFeedback,
    hasDatabaseConfig,
    getDatabaseConfigError
  } = store;

  router.get('/meeting-minutes-final/feedback-submissions', requireAuth, async (req, res) => {
    try {
      if (!hasDatabaseConfig()) {
        const error = new Error(getDatabaseConfigError());
        error.statusCode = 503;
        throw error;
      }
      const feedback = await listMeetingMinutesFeedback(req.query?.limit || 100);
      return res.json({ ok: true, feedback });
    } catch (error) {
      return sendTestError(res, error);
    }
  });

  router.get('/meeting-minutes-final/feedback-submissions/:feedbackId', requireAuth, async (req, res) => {
    try {
      if (!hasDatabaseConfig()) {
        const error = new Error(getDatabaseConfigError());
        error.statusCode = 503;
        throw error;
      }
      const feedback = await getMeetingMinutesFeedback(req.params.feedbackId);
      if (!feedback) return res.status(404).json({ ok: false, error: 'Feedback not found.' });
      return res.json({ ok: true, feedback });
    } catch (error) {
      return sendTestError(res, error);
    }
  });

  router.patch('/meeting-minutes-final/feedback-submissions/:feedbackId', requireAuth, async (req, res) => {
    try {
      if (!hasDatabaseConfig()) {
        const error = new Error(getDatabaseConfigError());
        error.statusCode = 503;
        throw error;
      }
      const feedback = await updateMeetingMinutesFeedback(req.params.feedbackId, {
        status: req.body?.status,
        claireComments: req.body?.claireComments,
        fixDetails: req.body?.fixDetails
      });
      if (!feedback) return res.status(404).json({ ok: false, error: 'Feedback not found.' });
      return res.json({ ok: true, feedback });
    } catch (error) {
      return sendTestError(res, error);
    }
  });

  router.delete('/meeting-minutes-final/feedback-submissions/:feedbackId', requireAuth, async (req, res) => {
    try {
      if (!hasDatabaseConfig()) {
        const error = new Error(getDatabaseConfigError());
        error.statusCode = 503;
        throw error;
      }
      const deleted = await deleteMeetingMinutesFeedback(req.params.feedbackId);
      if (!deleted) return res.status(404).json({ ok: false, error: 'Feedback not found.' });
      return res.json({ ok: true });
    } catch (error) {
      return sendTestError(res, error);
    }
  });
};
