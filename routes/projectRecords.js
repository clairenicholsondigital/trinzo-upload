'use strict';

// Register on the existing router to retain middleware order, paths and stack compatibility.
module.exports = function registerProjectRecords(router, {
  store = require('../utils/db'),
  requireAuth = require('./auth').requireAuth,
  sendTestError = require('../utils/apiErrors').sendTestError
} = {}) {
  const {
    listProjectReports,
    getProjectReportDetail,
    saveProjectReportDetail,
    deleteProjectReport,
    deleteProjectReports,
    listProjectMilestones,
    getProjectMilestoneDetail,
    createProjectMilestone,
    updateProjectMilestone,
    deleteProjectMilestone,
    deactivateProjectMilestones,
    listProjectRisks,
    getProjectRiskDetail,
    createProjectRisk,
    updateProjectRisk,
    deleteProjectRisk,
    listProjectOptions,
    createProject,
    updateProject,
    deleteProject
  } = store;

  router.get('/project-update-test/reports', requireAuth, async (req, res) => {
    try {
      const reports = await listProjectReports(req.query?.limit, { projectId: req.query?.projectId });
      return res.json({ ok: true, reports });
    } catch (error) {
      return sendTestError(res, error);
    }
  });

  router.get('/project-update-test/projects', requireAuth, async (req, res) => {
    try {
      const projects = await listProjectOptions(req.query?.limit);
      return res.json({ ok: true, projects });
    } catch (error) {
      return sendTestError(res, error);
    }
  });

  router.post('/project-update-test/projects', requireAuth, async (req, res) => {
    try {
      const project = await createProject(req.body || {});
      return res.status(201).json({ ok: true, project });
    } catch (error) {
      return sendTestError(res, error);
    }
  });

  router.patch('/project-update-test/projects/:projectId', requireAuth, async (req, res) => {
    try {
      const project = await updateProject(req.params.projectId, req.body || {});
      return res.json({ ok: true, project });
    } catch (error) {
      return sendTestError(res, error);
    }
  });

  router.delete('/project-update-test/projects/:projectId', requireAuth, async (req, res) => {
    try {
      const project = await deleteProject(req.params.projectId);
      if (!project) return res.status(404).json({ ok: false, error: 'Project not found.' });
      return res.json({ ok: true, project });
    } catch (error) {
      return sendTestError(res, error);
    }
  });

  router.get('/project-update-test/reports/:reportId', requireAuth, async (req, res) => {
    try {
      const report = await getProjectReportDetail(req.params.reportId);
      if (!report) {
        return res.status(404).json({ ok: false, error: 'Project report not found.' });
      }
      return res.json({ ok: true, report });
    } catch (error) {
      return sendTestError(res, error);
    }
  });

  router.post('/project-update-test/reports/bulk-delete', requireAuth, async (req, res) => {
    try {
      const result = await deleteProjectReports(req.body?.reportIds || []);
      return res.json({ ok: true, result });
    } catch (error) {
      return sendTestError(res, error);
    }
  });

  router.patch('/project-update-test/reports/:reportId', requireAuth, async (req, res) => {
    try {
      // Record who saved or approved from the signed-in session, not the request body.
      const savedBy = req.authUser?.fullName || req.authUser?.email || 'Unknown user';
      const report = await saveProjectReportDetail(req.params.reportId, { ...(req.body || {}), savedBy });
      if (!report) {
        return res.status(404).json({ ok: false, error: 'Project report not found.' });
      }
      return res.json({ ok: true, report });
    } catch (error) {
      return sendTestError(res, error);
    }
  });

  router.delete('/project-update-test/reports/:reportId', requireAuth, async (req, res) => {
    try {
      const report = await deleteProjectReport(req.params.reportId);
      if (!report) {
        return res.status(404).json({ ok: false, error: 'Project report not found.' });
      }
      return res.json({ ok: true, report });
    } catch (error) {
      return sendTestError(res, error);
    }
  });

  router.get('/project-update-test/milestones', requireAuth, async (req, res) => {
    try {
      const milestones = await listProjectMilestones(req.query?.limit, { projectId: req.query?.projectId });
      return res.json({ ok: true, milestones });
    } catch (error) {
      return sendTestError(res, error);
    }
  });

  router.post('/project-update-test/milestones', requireAuth, async (req, res) => {
    try {
      const milestone = await createProjectMilestone(req.body || {});
      return res.status(milestone?.created ? 201 : 200).json({ ok: true, milestone });
    } catch (error) {
      return sendTestError(res, error);
    }
  });

  router.get('/project-update-test/milestones/:milestoneId', requireAuth, async (req, res) => {
    try {
      const milestone = await getProjectMilestoneDetail(req.params.milestoneId);
      if (!milestone) {
        return res.status(404).json({ ok: false, error: 'Project milestone not found.' });
      }
      return res.json({ ok: true, milestone });
    } catch (error) {
      return sendTestError(res, error);
    }
  });

  router.post('/project-update-test/milestones/bulk-inactivate', requireAuth, async (req, res) => {
    try {
      const result = await deactivateProjectMilestones(req.body?.milestoneIds || []);
      return res.json({ ok: true, result });
    } catch (error) {
      return sendTestError(res, error);
    }
  });

  router.patch('/project-update-test/milestones/:milestoneId', requireAuth, async (req, res) => {
    try {
      const milestone = await updateProjectMilestone(req.params.milestoneId, req.body || {});
      if (!milestone) {
        return res.status(404).json({ ok: false, error: 'Project milestone not found.' });
      }
      return res.json({ ok: true, milestone });
    } catch (error) {
      return sendTestError(res, error);
    }
  });

  router.delete('/project-update-test/milestones/:milestoneId', requireAuth, async (req, res) => {
    try {
      const milestone = await deleteProjectMilestone(req.params.milestoneId);
      if (!milestone) {
        return res.status(404).json({ ok: false, error: 'Project milestone not found.' });
      }
      return res.json({ ok: true, milestone });
    } catch (error) {
      return sendTestError(res, error);
    }
  });

  router.get('/project-update-test/risks', requireAuth, async (req, res) => {
    try {
      const risks = await listProjectRisks(req.query?.limit, { projectId: req.query?.projectId });
      return res.json({ ok: true, risks });
    } catch (error) {
      return sendTestError(res, error);
    }
  });

  router.post('/project-update-test/risks', requireAuth, async (req, res) => {
    try {
      const risk = await createProjectRisk(req.body || {});
      return res.status(risk?.created ? 201 : 200).json({ ok: true, risk });
    } catch (error) {
      return sendTestError(res, error);
    }
  });

  router.get('/project-update-test/risks/:riskId', requireAuth, async (req, res) => {
    try {
      const risk = await getProjectRiskDetail(req.params.riskId);
      if (!risk) return res.status(404).json({ ok: false, error: 'Project risk not found.' });
      return res.json({ ok: true, risk });
    } catch (error) {
      return sendTestError(res, error);
    }
  });

  router.patch('/project-update-test/risks/:riskId', requireAuth, async (req, res) => {
    try {
      const risk = await updateProjectRisk(req.params.riskId, req.body || {});
      if (!risk) return res.status(404).json({ ok: false, error: 'Project risk not found.' });
      return res.json({ ok: true, risk });
    } catch (error) {
      return sendTestError(res, error);
    }
  });

  router.delete('/project-update-test/risks/:riskId', requireAuth, async (req, res) => {
    try {
      const risk = await deleteProjectRisk(req.params.riskId);
      if (!risk) return res.status(404).json({ ok: false, error: 'Project risk not found.' });
      return res.json({ ok: true, risk });
    } catch (error) {
      return sendTestError(res, error);
    }
  });
};
