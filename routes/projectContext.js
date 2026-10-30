'use strict';

const { truthyFlag } = require('../utils/requestFlags');

// Register on the existing router to retain middleware order, paths and stack compatibility.
module.exports = function registerProjectContext(router, {
  store = require('../utils/db'),
  requireAuth = require('./auth').requireAuth,
  sendTestError = require('../utils/apiErrors').sendTestError
} = {}) {
  const {
    getProjectContext,
    createProjectContextSnapshot,
    getProjectContextSnapshot,
    markProjectContextOfficial,
    cleanupProjectUpdateTestContext
  } = store;

  router.get('/project-update-test/context', requireAuth, async (req, res) => {
    try {
      const context = await getProjectContext({ projectId: req.query?.projectId, projectName: req.query?.projectName }, req.query?.limit);
      return res.json({ ok: true, context });
    } catch (error) {
      return sendTestError(res, error);
    }
  });

  router.post('/project-update-test/context/snapshots', requireAuth, async (req, res) => {
    try {
      const snapshot = await createProjectContextSnapshot({ projectId: req.body?.projectId || req.query?.projectId, projectName: req.body?.projectName || req.query?.projectName }, req.body || {});
      return res.status(201).json({ ok: true, snapshot });
    } catch (error) {
      return sendTestError(res, error);
    }
  });

  router.get('/project-update-test/context/snapshots/:snapshotId', requireAuth, async (req, res) => {
    try {
      const snapshot = await getProjectContextSnapshot(req.params.snapshotId);
      if (!snapshot) return res.status(404).json({ ok: false, error: 'Project context snapshot not found.' });
      return res.json({ ok: true, snapshot });
    } catch (error) {
      return sendTestError(res, error);
    }
  });

  router.post('/project-update-test/context/mark-official', requireAuth, async (req, res) => {
    try {
      const result = await markProjectContextOfficial(
        { projectId: req.body?.projectId || req.query?.projectId, projectName: req.body?.projectName || req.query?.projectName },
        req.body?.officialLabel || req.query?.officialLabel || 'Official baseline'
      );
      return res.json({ ok: true, result });
    } catch (error) {
      return sendTestError(res, error);
    }
  });

  router.post('/project-update-test/context/cleanup-tests', requireAuth, async (req, res) => {
    try {
      const result = await cleanupProjectUpdateTestContext({ projectId: req.body?.projectId || req.query?.projectId, projectName: req.body?.projectName || req.query?.projectName }, {
        archiveReports: !truthyFlag(req.body?.keepReports) && !truthyFlag(req.query?.keepReports),
        deleteNonOfficialSnapshots: !truthyFlag(req.body?.keepSnapshots) && !truthyFlag(req.query?.keepSnapshots)
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return sendTestError(res, error);
    }
  });
};
