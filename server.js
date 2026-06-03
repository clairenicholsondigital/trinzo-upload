require('dotenv').config();

const path = require('path');
const fs = require('fs/promises');
const express = require('express');
const apiRoutes = require('./routes/api');
const authRoutes = require('./routes/auth');

const app = express();
const PORT = process.env.PORT || 3978;

app.use(express.json({ limit: '25mb' }));
app.use('/static', express.static(path.join(__dirname, 'public')));

async function sendView(res, fileName) {
  const html = await fs.readFile(path.join(__dirname, 'views', fileName), 'utf8');
  res.type('html').send(html);
}

app.get('/', (req, res) => {
  sendView(res, 'index.html').catch((error) => res.status(404).send(error.message));
});

app.get('/meetings', (req, res) => {
  sendView(res, 'meetings.html').catch((error) => res.status(404).send(error.message));
});

app.get('/review', (req, res) => {
  sendView(res, 'review.html').catch((error) => res.status(404).send(error.message));
});

app.get('/meeting-minutes-test', (req, res) => {
  sendView(res, 'meeting-minutes-test.html').catch((error) => res.status(404).send(error.message));
});

app.get('/meeting-minutes-numbers', (req, res) => {
  sendView(res, 'meeting-minutes-numbers.html').catch((error) => res.status(404).send(error.message));
});

app.get('/meeting-minutes-comparison', (req, res) => {
  sendView(res, 'meeting-minutes-comparison.html').catch((error) => res.status(404).send(error.message));
});

app.get('/meeting-minutes-minilm-only', (req, res) => {
  sendView(res, 'meeting-minutes-minilm-only.html').catch((error) => res.status(404).send(error.message));
});

app.get('/meeting-minutes-final', (req, res) => {
  sendView(res, 'meeting-minutes-final.html').catch((error) => res.status(404).send(error.message));
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
  sendView(res, 'auth-register.html').catch((error) => res.status(404).send(error.message));
});

app.get('/register-success', (req, res) => {
  sendView(res, 'register-success.html').catch((error) => res.status(404).send(error.message));
});

app.get('/dashboard', (req, res) => {
  sendView(res, 'dashboard.html').catch((error) => res.status(404).send(error.message));
});

app.get('/auth/forgot-password', (req, res) => {
  sendView(res, 'auth-forgot-password.html').catch((error) => res.status(404).send(error.message));
});

app.use('/api', apiRoutes);
app.use('/api/auth', authRoutes);

app.listen(PORT, '0.0.0.0', () => {
  console.log('Agent listening on port ' + PORT);
});
