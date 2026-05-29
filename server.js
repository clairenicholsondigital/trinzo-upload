require('dotenv').config();

const path = require('path');
const express = require('express');
const apiRoutes = require('./routes/api');
const authRoutes = require('./routes/auth');

const app = express();
const PORT = process.env.PORT || 3978;

app.use(express.json({ limit: '25mb' }));
app.use('/static', express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

app.get('/meetings', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'meetings.html'));
});

app.get('/review', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'review.html'));
});

app.get('/meeting-minutes-test', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'meeting-minutes-test.html'));
});

app.get('/project-update-test', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'project-update-test.html'));
});


app.get('/auth', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'auth.html'));
});

app.get('/auth/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'auth-login.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'auth-login.html'));
});

app.get('/auth/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'auth-register.html'));
});

app.get('/register-success', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'register-success.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

app.get('/auth/forgot-password', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'auth-forgot-password.html'));
});

app.use('/api', apiRoutes);
app.use('/api/auth', authRoutes);

app.listen(PORT, '0.0.0.0', () => {
  console.log('Agent listening on port ' + PORT);
});
