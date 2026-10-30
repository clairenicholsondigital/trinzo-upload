'use strict';

const { buildMeetingMinutesJobEditedPayload } = require('../utils/meetingMinutesJobEdits');

// Keep list and command registration separate to preserve their existing router positions.
function registerMeetingMinutesJobList(router, {
  store = require('../utils/db'),
  requireAuth = require('./auth').requireAuth
} = {}) {
  const { listMeetingMinutesJobs } = store;

  router.get('/meeting-minutes-final/jobs', requireAuth, async (req, res) => {
    try {
      const jobs = await listMeetingMinutesJobs(req.query?.limit || 75);
      return res.json({ ok: true, success: true, jobs });
    } catch (error) {
      return res.status(error.statusCode || 500).json({ ok: false, success: false, error: error.message || 'Failed to list jobs.' });
    }
  });
}

function registerMeetingMinutesJobCommands(router, {
  store = require('../utils/db'),
  requireAuth = require('./auth').requireAuth
} = {}) {
  const { getMeetingMinutesJob, updateMeetingMinutesJobResult, retryMeetingMinutesJob, cancelMeetingMinutesJob, deleteMeetingMinutesJob } = store;

  router.get('/meeting-minutes-final/jobs/:jobId', requireAuth, async (req, res) => {
    try {
      const job = await getMeetingMinutesJob(req.params.jobId);
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

  router.patch('/meeting-minutes-final/jobs/:jobId/result', requireAuth, async (req, res) => {
    try {
      const job = await getMeetingMinutesJob(req.params.jobId);
      if (!job) return res.status(404).json({ ok: false, success: false, error: 'Job not found.' });
      if (job.status !== 'completed') {
        return res.status(409).json({ ok: false, success: false, error: 'Only completed meeting-minutes jobs can be edited.' });
      }

      const editedRows = Array.isArray(req.body?.editedRows) ? req.body.editedRows : null;
      if (!editedRows) {
        return res.status(400).json({ ok: false, success: false, error: 'Provide editedRows as an array.' });
      }

      const nextPayload = buildMeetingMinutesJobEditedPayload(job, editedRows, req.body?.editedMeta, req.authUser?.email);

      const updated = await updateMeetingMinutesJobResult(req.params.jobId, nextPayload);
      if (!updated) return res.status(404).json({ ok: false, success: false, error: 'Editable completed job not found.' });
      return res.json({ ok: true, success: true, job: updated, result: updated.resultPayload });
    } catch (error) {
      return res.status(error.statusCode || 500).json({ ok: false, success: false, error: error.message || 'Failed to save edited result.' });
    }
  });

  router.post('/meeting-minutes-final/jobs/:jobId/retry', requireAuth, async (req, res) => {
    try {
      const job = await retryMeetingMinutesJob(req.params.jobId);
      if (!job) return res.status(404).json({ ok: false, success: false, error: 'Retryable job not found.' });
      return res.json({ ok: true, success: true, job });
    } catch (error) {
      return res.status(error.statusCode || 500).json({ ok: false, success: false, error: error.message || 'Failed to retry job.' });
    }
  });

  router.post('/meeting-minutes-final/jobs/:jobId/cancel', requireAuth, async (req, res) => {
    try {
      const job = await cancelMeetingMinutesJob(req.params.jobId);
      if (!job) return res.status(404).json({ ok: false, success: false, error: 'Cancellable job not found.' });
      return res.json({ ok: true, success: true, job });
    } catch (error) {
      return res.status(error.statusCode || 500).json({ ok: false, success: false, error: error.message || 'Failed to cancel job.' });
    }
  });

  router.delete('/meeting-minutes-final/jobs/:jobId', requireAuth, async (req, res) => {
    try {
      const deleted = await deleteMeetingMinutesJob(req.params.jobId);
      if (!deleted) return res.status(404).json({ ok: false, success: false, error: 'Deletable completed/failed/cancelled job not found.' });
      return res.json({ ok: true, success: true });
    } catch (error) {
      return res.status(error.statusCode || 500).json({ ok: false, success: false, error: error.message || 'Failed to delete job.' });
    }
  });
}

module.exports = { registerMeetingMinutesJobList, registerMeetingMinutesJobCommands };
