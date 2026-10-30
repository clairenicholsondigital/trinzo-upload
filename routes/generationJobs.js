'use strict';

// Register on the existing router to retain middleware order, paths and stack compatibility.
module.exports = function registerGenerationJobs(router, {
  store = require('../utils/db'),
  requireAuth = require('./auth').requireAuth,
  launchQueuedStagedMeetingMinutesStage
} = {}) {
  if (typeof launchQueuedStagedMeetingMinutesStage !== 'function') {
    throw new TypeError('launchQueuedStagedMeetingMinutesStage is required.');
  }
  const {
    listGenerationJobs,
    getGenerationJob,
    retryGenerationJob,
    cancelGenerationJob,
    deleteGenerationJob,
    archiveGenerationJobs
  } = store;

  router.get('/jobs', requireAuth, async (req, res) => {
    try {
      const jobs = await listGenerationJobs(req.query?.limit || 75, { type: req.query?.type || '' });
      return res.json({ ok: true, success: true, jobs });
    } catch (error) {
      return res.status(error.statusCode || 500).json({ ok: false, success: false, error: error.message || 'Failed to list jobs.' });
    }
  });

  router.get('/jobs/:jobId', requireAuth, async (req, res) => {
    try {
      const job = await getGenerationJob(req.params.jobId);
      if (!job) return res.status(404).json({ ok: false, success: false, error: 'Job not found.' });
      return res.json({
        ok: true,
        success: true,
        job,
        result: job.status === 'completed' ? job.resultPayload : null
      });
    } catch (error) {
      return res.status(error.statusCode || 500).json({ ok: false, success: false, error: error.message || 'Failed to load job.' });
    }
  });

  router.post('/jobs/:jobId/retry', requireAuth, async (req, res) => {
    try {
      const job = await retryGenerationJob(req.params.jobId);
      if (!job) return res.status(404).json({ ok: false, success: false, error: 'Retryable job not found.' });
      if (job.jobType === 'staged_meeting_minutes_stage') {
        launchQueuedStagedMeetingMinutesStage(job.jobId);
      }
      return res.json({ ok: true, success: true, job });
    } catch (error) {
      return res.status(error.statusCode || 500).json({ ok: false, success: false, error: error.message || 'Failed to retry job.' });
    }
  });

  router.post('/jobs/:jobId/cancel', requireAuth, async (req, res) => {
    try {
      const job = await cancelGenerationJob(req.params.jobId);
      if (!job) return res.status(404).json({ ok: false, success: false, error: 'Cancellable job not found.' });
      return res.json({ ok: true, success: true, job });
    } catch (error) {
      return res.status(error.statusCode || 500).json({ ok: false, success: false, error: error.message || 'Failed to cancel job.' });
    }
  });

  router.delete('/jobs/:jobId', requireAuth, async (req, res) => {
    try {
      const deleted = await deleteGenerationJob(req.params.jobId);
      if (!deleted) return res.status(404).json({ ok: false, success: false, error: 'Deletable completed/failed/cancelled job not found.' });
      return res.json({ ok: true, success: true });
    } catch (error) {
      return res.status(error.statusCode || 500).json({ ok: false, success: false, error: error.message || 'Failed to delete job.' });
    }
  });

  router.post('/jobs/archive', requireAuth, async (req, res) => {
    try {
      const requestedIds = Array.isArray(req.body?.jobIds) ? req.body.jobIds : [];
      const archiveAll = req.body?.archiveAll === true;
      if (!archiveAll && !requestedIds.length) {
        return res.status(400).json({ ok: false, success: false, error: 'Select at least one item to archive.' });
      }
      const archivedIds = await archiveGenerationJobs(requestedIds, { archiveAll });
      return res.json({ ok: true, success: true, archivedIds, archivedCount: archivedIds.length });
    } catch (error) {
      return res.status(error.statusCode || 500).json({ ok: false, success: false, error: error.message || 'Failed to archive items.' });
    }
  });
};
