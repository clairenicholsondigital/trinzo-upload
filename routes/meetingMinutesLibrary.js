'use strict';

const { safeLogError } = require('../utils/apiErrors');
const { deleteMeetingMinutesAgentDraft, getMeetingMinutesAgentDraft, getProjectManagementDetail, linkMeetingMinutesAgentDraftToProject, listMeetingMinutesAgentDraftPage, listMeetingMinutesAgentDrafts, unlinkMeetingMinutesAgentDraftFromProject } = require('../utils/db');
const { docxFilename, generateMeetingMinutesAgentDocx } = require('../utils/meetingMinutesAgentDocx');
const { loadOwnedMeetingAgentDraft, sendMeetingAgentFailure } = require('../utils/meetingMinutesDraftHttp');
const { buildMeetingInsights, publicMeetingAgentDraft } = require('../utils/meetingMinutesDraftView');
const { meetingAgentDraftForDocx, meetingAgentDraftForPdf } = require('../utils/meetingMinutesPublication');
const { generateStagedMinutesPdf, stagedMinutesPdfFilename } = require('../utils/stagedMinutesPdf');
const { requireAuth } = require('./auth');

// Preserve the four existing composition slots among reviewer and generation routes.
function registerMeetingMinutesLibraryList(router) {
  router.get('/meeting-minutes-agent/drafts', requireAuth, async (req, res) => {
    try {
      const page = await listMeetingMinutesAgentDraftPage(req.authUser?.userId, {
        limit: req.query?.limit,
        offset: req.query?.offset,
        search: req.query?.search,
        status: req.query?.status,
        sort: req.query?.sort,
        projectId: req.query?.projectId
      });
      return res.json({
        ok: true,
        drafts: page.drafts.map((draft) => publicMeetingAgentDraft(draft, { summary: true })),
        pagination: { total: page.total, limit: page.limit, offset: page.offset }
      });
    } catch (error) {
      return sendMeetingAgentFailure(res, error);
    }
  });

  // Remembers which project these minutes were written for, so the project's
  // Process tab can list only its own minutes. Does not change the minutes.
  router.post('/meeting-minutes-agent/drafts/:draftId/project-link', requireAuth, async (req, res) => {
    try {
      const draftId = String(req.params.draftId || '');
      const projectId = Number(req.body?.projectId);
      if (!/^\d+$/.test(draftId) || !Number.isSafeInteger(projectId) || projectId <= 0) {
        return res.status(400).json({ ok: false, error: 'Choose saved minutes and a project to link.' });
      }
      const project = await getProjectManagementDetail(projectId);
      if (!project) return res.status(404).json({ ok: false, error: 'Selected project was not found.' });
      const linked = await linkMeetingMinutesAgentDraftToProject(draftId, req.authUser?.userId, projectId);
      if (!linked) return res.status(404).json({ ok: false, error: 'Meeting minutes not found.' });
      return res.json({ ok: true, ...linked });
    } catch (error) {
      return sendMeetingAgentFailure(res, error);
    }
  });

  router.delete('/meeting-minutes-agent/drafts/:draftId/project-link', requireAuth, async (req, res) => {
    try {
      const draftId = String(req.params.draftId || '');
      const projectId = Number(req.body?.projectId);
      if (!/^\d+$/.test(draftId) || !Number.isSafeInteger(projectId) || projectId <= 0) {
        return res.status(400).json({ ok: false, error: 'Choose saved minutes and their linked project.' });
      }
      if (!await getMeetingMinutesAgentDraft(draftId, req.authUser?.userId)) {
        return res.status(404).json({ ok: false, error: 'Meeting minutes not found.' });
      }
      const unlinked = await unlinkMeetingMinutesAgentDraftFromProject(draftId, req.authUser?.userId, projectId);
      if (!unlinked) return res.status(409).json({ ok: false, error: 'The linked project changed. Reload these minutes before unlinking.' });
      return res.json({ ok: true, ...unlinked });
    } catch (error) {
      return sendMeetingAgentFailure(res, error);
    }
  });

  router.get('/meeting-minutes-agent/insights', requireAuth, async (req, res) => {
    try {
      const drafts = await listMeetingMinutesAgentDrafts(req.authUser?.userId, 100);
      return res.json({ ok: true, ...buildMeetingInsights(drafts, req.query || {}) });
    } catch (error) {
      return sendMeetingAgentFailure(res, error);
    }
  });
}

function registerMeetingMinutesLibraryDetail(router) {
  router.get('/meeting-minutes-agent/drafts/:draftId', requireAuth, async (req, res) => {
    try {
      const draft = await loadOwnedMeetingAgentDraft(req);
      return res.json({ ok: true, draft: publicMeetingAgentDraft(draft) });
    } catch (error) {
      return sendMeetingAgentFailure(res, error);
    }
  });
}

function registerMeetingMinutesLibraryDelete(router) {
  router.delete('/meeting-minutes-agent/drafts/:draftId', requireAuth, async (req, res) => {
    try {
      const deleted = await deleteMeetingMinutesAgentDraft(req.params.draftId, req.authUser?.userId);
      if (!deleted) return res.status(404).json({ ok: false, error: 'Meeting-minutes draft not found.' });
      return res.json({ ok: true });
    } catch (error) {
      return sendMeetingAgentFailure(res, error);
    }
  });
}

function registerMeetingMinutesLibraryExports(router) {
  router.post('/meeting-minutes-agent/drafts/:draftId/export.docx', requireAuth, async (req, res) => {
    try {
      const draft = await loadOwnedMeetingAgentDraft(req);
      const exportDraft = meetingAgentDraftForDocx(draft);
      const buffer = await generateMeetingMinutesAgentDocx(exportDraft, req.body?.includeEvidence === true);
      const filename = docxFilename(exportDraft).replace(/["\\]/g, '');
      res.set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(buffer.length),
        'Cache-Control': 'no-store'
      });
      return res.send(buffer);
    } catch (error) {
      safeLogError('[meeting-minutes-agent/export] failed', error);
      return sendMeetingAgentFailure(res, error);
    }
  });

  router.post('/meeting-minutes-agent/drafts/:draftId/export.pdf', requireAuth, async (req, res) => {
    try {
      const draft = await loadOwnedMeetingAgentDraft(req);
      const minutes = meetingAgentDraftForPdf(draft, req.body?.includeEvidence === true);
      const pdf = await generateStagedMinutesPdf(minutes);
      const filename = stagedMinutesPdfFilename(minutes).replace(/["\\]/g, '');
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
        'Content-Length': String(pdf.length)
      });
      return res.send(pdf);
    } catch (error) {
      safeLogError('[meeting-minutes-agent/pdf] failed', error);
      return sendMeetingAgentFailure(res, error);
    }
  });
}

module.exports = {
  registerMeetingMinutesLibraryList,
  registerMeetingMinutesLibraryDetail,
  registerMeetingMinutesLibraryDelete,
  registerMeetingMinutesLibraryExports
};
