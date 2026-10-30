'use strict';

const { truthyFlag } = require('../utils/requestFlags');
const { sendJson } = require('../utils/apiErrors');

// Register on the existing router to retain middleware order, paths and stack compatibility.
module.exports = function registerProjectKnowledge(router, {
  store = require('../utils/db'),
  knowledge = require('../utils/knowledge'),
  requireAuth = require('./auth').requireAuth
} = {}) {
  const {
    hasDatabaseConfig,
    getDatabaseConfigError,
    createProjectKnowledgeItem,
    listProjectKnowledgeItems,
    updateProjectKnowledgeItem,
    archiveProjectKnowledgeItem,
    getProjectContext,
    getProjectKnowledgeStatus
  } = store;
  const { spawnProjectKnowledgeEmbedWorker, answerProjectKnowledge } = knowledge;

  router.post('/project-update-test/knowledge/items', requireAuth, async (req, res) => {
    try {
      if (!hasDatabaseConfig()) throw new Error(getDatabaseConfigError());
      const body = req.body || {};
      const projectId = Number(body.projectId || 0);
      const item = await createProjectKnowledgeItem({
        projectId,
        title: body.title,
        content: body.content,
        itemType: body.itemType || 'background_doc',
        isOfficial: body.isOfficial !== false,
        metadata: body.metadata || { source: 'manual' }
      });
      const embeddingWorker = spawnProjectKnowledgeEmbedWorker(['--project-id', String(projectId)]);
      res.json({ ok: true, item, embeddingWorker });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { ok: false, error: error.message });
    }
  });

  router.get('/project-update-test/knowledge/items', requireAuth, async (req, res) => {
    try {
      if (!hasDatabaseConfig()) throw new Error(getDatabaseConfigError());
      const items = await listProjectKnowledgeItems({
        projectId: req.query.projectId,
        itemType: req.query.itemType,
        status: req.query.status || 'active',
        limit: req.query.limit
      });
      res.json({ ok: true, items });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { ok: false, error: error.message });
    }
  });

  router.patch('/project-update-test/knowledge/items/:itemId', requireAuth, async (req, res) => {
    try {
      if (!hasDatabaseConfig()) throw new Error(getDatabaseConfigError());
      const item = await updateProjectKnowledgeItem(req.params.itemId, req.body || {});
      if (!item) return sendJson(res, 404, { ok: false, error: 'Knowledge item not found.' });
      const embeddingWorker = Object.prototype.hasOwnProperty.call(req.body || {}, 'content')
        ? spawnProjectKnowledgeEmbedWorker(['--item-id', String(req.params.itemId)])
        : { spawned: false, reason: 'content unchanged' };
      res.json({ ok: true, item, embeddingWorker });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { ok: false, error: error.message });
    }
  });

  router.delete('/project-update-test/knowledge/items/:itemId', requireAuth, async (req, res) => {
    try {
      if (!hasDatabaseConfig()) throw new Error(getDatabaseConfigError());
      const item = await archiveProjectKnowledgeItem(req.params.itemId, { hard: truthyFlag(req.query.hard) });
      if (!item) return sendJson(res, 404, { ok: false, error: 'Knowledge item not found.' });
      res.json({ ok: true, item });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { ok: false, error: error.message });
    }
  });

  router.post('/project-update-test/knowledge/ask', requireAuth, async (req, res) => {
    try {
      if (!hasDatabaseConfig()) throw new Error(getDatabaseConfigError());
      const projectId = Number(req.body?.projectId || req.query?.projectId || 0);
      const question = String(req.body?.question || req.query?.question || '').trim();
      if (!Number.isFinite(projectId) || projectId <= 0) return sendJson(res, 400, { ok: false, error: 'Valid projectId is required.' });
      if (!question) return sendJson(res, 400, { ok: false, error: 'Question is required.' });
      const projectContext = await getProjectContext({ projectId }, 8);
      const result = await answerProjectKnowledge({
        projectId,
        question,
        topK: Math.min(Math.max(Number(req.body?.topK || req.query?.topK || 8), 1), 25),
        timeoutMs: Math.min(Math.max(Number(req.body?.timeoutMs || 30000), 5000), 45000),
        projectContext
      });
      res.json(result);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { ok: false, error: error.message });
    }
  });

  router.get('/project-update-test/knowledge/status', requireAuth, async (req, res) => {
    try {
      if (!hasDatabaseConfig()) throw new Error(getDatabaseConfigError());
      const status = await getProjectKnowledgeStatus({ projectId: req.query.projectId });
      res.json({ ok: true, status });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { ok: false, error: error.message });
    }
  });

  router.post('/project-update-test/knowledge/embeddings/process', requireAuth, async (req, res) => {
    try {
      const projectId = req.body?.projectId || req.query?.projectId;
      const args = projectId ? ['--project-id', String(projectId)] : [];
      const embeddingWorker = spawnProjectKnowledgeEmbedWorker(args);
      res.json({ ok: true, embeddingWorker });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { ok: false, error: error.message });
    }
  });
};
