require('dotenv').config();

const path = require('path');
const fs = require('fs/promises');
const express = require('express');
const apiRoutes = require('./routes/api');
const authRoutes = require('./routes/auth');
const { startProjectKnowledgeEmbedInterval } = require('./utils/knowledge');

const app = express();
const PORT = process.env.PORT || 3978;

app.use(express.json({ limit: '25mb' }));
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

app.get('/archive', (req, res) => {
  sendView(res, 'archive.html').catch((error) => res.status(404).send(error.message));
});

// Legacy/archive routes. These are kept for reference but intentionally removed
// from the main dashboard navigation.
const legacyViews = {
  '/archive/legacy-transcript-workflow': 'index.html',
  '/archive/meetings': 'meetings.html',
  '/archive/review': 'review.html',
  '/archive/meeting-minutes-test': 'meeting-minutes-test.html',
  '/archive/meeting-minutes-numbers': 'meeting-minutes-numbers.html',
  '/archive/meeting-minutes-comparison': 'meeting-minutes-comparison.html',
  '/archive/meeting-minutes-minilm-only': 'meeting-minutes-minilm-only.html'
};
for (const [route, fileName] of Object.entries(legacyViews)) {
  app.get(route, (req, res) => {
    sendView(res, fileName).catch((error) => res.status(404).send(error.message));
  });
}
const legacyRedirects = {
  '/meetings': '/archive/meetings',
  '/review': '/archive/review',
  '/meeting-minutes-test': '/archive/meeting-minutes-test',
  '/meeting-minutes-numbers': '/archive/meeting-minutes-numbers',
  '/meeting-minutes-comparison': '/archive/meeting-minutes-comparison',
  '/meeting-minutes-minilm-only': '/archive/meeting-minutes-minilm-only'
};
for (const [route, target] of Object.entries(legacyRedirects)) {
  app.get(route, (req, res) => res.redirect(302, target));
}

app.get('/meeting-minutes-final', (req, res) => {
  sendView(res, 'meeting-minutes-final.html').catch((error) => res.status(404).send(error.message));
});

app.get('/meeting-minutes-feedback', authRoutes.requireAuth, (req, res) => {
  sendView(res, 'meeting-minutes-feedback.html').catch((error) => res.status(404).send(error.message));
});

app.get('/meeting-minutes-feedback/:feedbackId', authRoutes.requireAuth, (req, res) => {
  sendView(res, 'meeting-minutes-feedback.html').catch((error) => res.status(404).send(error.message));
});

app.get('/project-update-test', (req, res) => {
  sendView(res, 'project-update-test.html').catch((error) => res.status(404).send(error.message));
});

app.get('/project-update-test/reports', (req, res) => {
  sendView(res, 'project-update-reports.html').catch((error) => res.status(404).send(error.message));
});

app.get('/project-update-test/reports/:reportId', (req, res) => {
  sendView(res, 'project-update-reports.html').catch((error) => res.status(404).send(error.message));
});

app.get('/project-update-test/milestones', (req, res) => {
  sendView(res, 'project-update-milestones.html').catch((error) => res.status(404).send(error.message));
});

app.get('/project-update-test/milestones/:milestoneId', (req, res) => {
  sendView(res, 'project-update-milestones.html').catch((error) => res.status(404).send(error.message));
});

app.get('/project-update-test/context', (req, res) => {
  sendView(res, 'project-update-context.html').catch((error) => res.status(404).send(error.message));
});

app.get('/project-update-test/context/snapshots/:snapshotId', (req, res) => {
  sendView(res, 'project-update-context.html').catch((error) => res.status(404).send(error.message));
});

app.get('/project-update-test/roadmap', (req, res) => {
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

app.listen(PORT, '0.0.0.0', () => {
  console.log('Agent listening on port ' + PORT);
  const knowledgeInterval = startProjectKnowledgeEmbedInterval();
  if (knowledgeInterval.started) {
    console.log(JSON.stringify({ event: 'project_knowledge_embed_interval_started', intervalMs: knowledgeInterval.intervalMs }));
  }
});
