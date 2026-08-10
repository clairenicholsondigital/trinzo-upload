require('dotenv').config();

const path = require('path');
const fs = require('fs/promises');
const express = require('express');
const apiRoutes = require('./routes/api');
const authRoutes = require('./routes/auth');
const { startProjectKnowledgeEmbedInterval } = require('./utils/knowledge');

const app = express();
const PORT = process.env.PORT || 3978;

// 4mb comfortably covers the largest legitimate JSON payload today (a ~2MB-char
// transcript plus review-data structure); previously 25mb, which let a client
// buffer a much larger body in memory before any app-level size check ran.
app.use(express.json({ limit: '4mb' }));
app.use('/static', express.static(path.join(__dirname, 'public')));

async function sendView(res, fileName) {
  const html = await fs.readFile(path.join(__dirname, 'views', fileName), 'utf8');
  res.type('html').send(html);
}

app.get('/', (req, res) => {
  sendView(res, 'dashboard.html').catch((error) => res.status(404).send(error.message));
});

app.get('/dashboard', (req, res) => {
  sendView(res, 'dashboard.html').catch((error) => res.status(404).send(error.message));
});

app.get('/meeting-minutes-final', authRoutes.requireAuth, (req, res) => {
  sendView(res, 'meeting-minutes-final.html').catch((error) => res.status(404).send(error.message));
});

app.get('/staged-meeting-minutes', authRoutes.requireAuth, (req, res) => {
  sendView(res, 'staged-meeting-minutes.html').catch((error) => res.status(404).send(error.message));
});

app.get('/jobs', authRoutes.requireAuth, (req, res) => {
  sendView(res, 'meeting-minutes-jobs.html').catch((error) => res.status(404).send(error.message));
});

app.get('/jobs/:jobId', authRoutes.requireAuth, (req, res) => {
  sendView(res, 'meeting-minutes-jobs.html').catch((error) => res.status(404).send(error.message));
});

app.get('/jobs/:jobId/result', authRoutes.requireAuth, (req, res) => {
  sendView(res, 'meeting-minutes-jobs.html').catch((error) => res.status(404).send(error.message));
});

app.get('/meeting-minutes-final/jobs', authRoutes.requireAuth, (req, res) => {
  sendView(res, 'meeting-minutes-jobs.html').catch((error) => res.status(404).send(error.message));
});

app.get('/meeting-minutes-final/jobs/:jobId', authRoutes.requireAuth, (req, res) => {
  sendView(res, 'meeting-minutes-jobs.html').catch((error) => res.status(404).send(error.message));
});

app.get('/meeting-minutes-final/jobs/:jobId/result', authRoutes.requireAuth, (req, res) => {
  sendView(res, 'meeting-minutes-jobs.html').catch((error) => res.status(404).send(error.message));
});

app.get('/meeting-minutes-feedback', authRoutes.requireAuth, (req, res) => {
  sendView(res, 'meeting-minutes-feedback.html').catch((error) => res.status(404).send(error.message));
});

app.get('/meeting-minutes-feedback/:feedbackId', authRoutes.requireAuth, (req, res) => {
  sendView(res, 'meeting-minutes-feedback.html').catch((error) => res.status(404).send(error.message));
});

// The project workspace: one project-first page hosting the Setup → Process →
// Reports → Insights stages. The old standalone list pages now redirect into the
// matching workspace stage; the detail pages (single report/milestone/snapshot)
// are kept as deep-link targets.
app.get('/project-update-test', authRoutes.requireAuth, (req, res) => {
  sendView(res, 'project-update-workspace.html').catch((error) => res.status(404).send(error.message));
});

app.get('/project-update-test/reports', authRoutes.requireAuth, (req, res) => {
  res.redirect(302, '/project-update-test?stage=reports');
});

app.get('/project-update-test/reports/:reportId', authRoutes.requireAuth, (req, res) => {
  sendView(res, 'project-update-reports.html').catch((error) => res.status(404).send(error.message));
});

app.get('/project-update-test/milestones', authRoutes.requireAuth, (req, res) => {
  res.redirect(302, '/project-update-test?stage=setup');
});

app.get('/project-update-test/milestones/:milestoneId', authRoutes.requireAuth, (req, res) => {
  sendView(res, 'project-update-milestones.html').catch((error) => res.status(404).send(error.message));
});

app.get('/project-update-test/context', authRoutes.requireAuth, (req, res) => {
  const params = new URLSearchParams();
  params.set('stage', 'memory');
  if (req.query.projectName) params.set('projectName', String(req.query.projectName));
  if (req.query.projectId) params.set('projectId', String(req.query.projectId));
  res.redirect(302, `/project-update-test?${params.toString()}`);
});

app.get('/project-update-test/settings', authRoutes.requireAuth, (req, res) => {
  res.redirect(302, '/project-update-test?stage=settings');
});

app.get('/project-update-test/context/snapshots/:snapshotId', authRoutes.requireAuth, (req, res) => {
  sendView(res, 'project-update-context.html').catch((error) => res.status(404).send(error.message));
});

app.get('/project-update-test/roadmap', authRoutes.requireAuth, (req, res) => {
  sendView(res, 'project-update-roadmap.html').catch((error) => res.status(404).send(error.message));
});

app.get('/roadmap', authRoutes.requireAuth, (req, res) => {
  sendView(res, 'project-update-roadmap.html').catch((error) => res.status(404).send(error.message));
});

app.get('/auth', (req, res) => {
  sendView(res, 'auth.html').catch((error) => res.status(404).send(error.message));
});

app.get('/auth/login', (req, res) => {
  sendView(res, 'auth-login.html').catch((error) => res.status(404).send(error.message));
});

app.get('/login', (req, res) => {
  sendView(res, 'auth-login.html').catch((error) => res.status(404).send(error.message));
});

app.get('/auth/register', (req, res) => {
  res.redirect('/auth/login');
});

app.get('/register-success', (req, res) => {
  res.redirect('/auth/login');
});

app.get('/auth/forgot-password', (req, res) => {
  sendView(res, 'auth-forgot-password.html').catch((error) => res.status(404).send(error.message));
});

app.use('/api', apiRoutes);
app.use('/api/auth', authRoutes);

app.use('/api', (error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.status || error.statusCode || 500;
  return res.status(status).json({
    ok: false,
    error: error.message || 'API request failed.'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('Agent listening on port ' + PORT);
  const knowledgeInterval = startProjectKnowledgeEmbedInterval();
  if (knowledgeInterval.started) {
    console.log(JSON.stringify({ event: 'project_knowledge_embed_interval_started', intervalMs: knowledgeInterval.intervalMs }));
  }
});
