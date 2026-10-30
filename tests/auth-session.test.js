'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const db = require('../utils/db');
const token = 'synthetic-session-token';
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
let role = 'admin', refreshed = 0, deleted = '';
db.getAuthSession = async hash => hash === tokenHash ? { userId: 7, email: 'owner@fixture.invalid', fullName: 'Fixture Owner', role } : null;
db.touchAuthSession = async hash => { assert.equal(hash, tokenHash); refreshed++; };
db.deleteAuthSession = async hash => { deleted = hash; };
const auth = require('../routes/auth');
const app = express();
app.use(express.json());
app.get('/private', auth.requireAuth, (req, res) => res.json(req.authUser));
app.use('/api', require('../routes/api'));
app.use('/api/auth', auth);
let server, origin;
test.before(async () => { server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); origin = 'http://127.0.0.1:' + server.address().port; });
test.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
const protectedRoutes = [
  ["POST", "/meeting-minutes-agent/prepare"],
  ["POST", "/meeting-minutes-agent/generate"],
  ["GET", "/meeting-minutes-agent/drafts"],
  ["PATCH", "/meeting-minutes-agent/drafts/1"],
  ["PATCH", "/meeting-minutes-agent/drafts/1/source/1"],
  ["POST", "/meeting-minutes-agent/drafts/1/audit-actions"],
  ["POST", "/meeting-minutes-agent/drafts/1/proposal"],
  ["POST", "/meeting-minutes-agent/drafts/1/undo"],
  ["POST", "/meeting-minutes-agent/drafts/1/export.docx"],
  ["POST", "/meeting-minutes-agent/drafts/1/export.pdf"],
  ["POST", "/meeting-minutes-agent/drafts/1/generate-background"],
  ["GET", "/meeting-minutes-agent/drafts/1/generation"],
  ["GET", "/meeting-minutes-final/feedback-submissions"],
  ["PATCH", "/meeting-minutes-final/feedback-submissions/1"],
  ["DELETE", "/meeting-minutes-final/feedback-submissions/1"],
  ["GET", "/staged-meeting-minutes/pre-testing"],
  ["POST", "/project-update-test/from-minutes"],
  ["GET", "/project-update-test/projects"],
  ["POST", "/project-update-test/projects"],
  ["PATCH", "/project-update-test/projects/1"],
  ["DELETE", "/project-update-test/projects/1"],
  ["GET", "/jobs"],
  ["GET", "/jobs/1"],
  ["POST", "/jobs/1/retry"],
  ["POST", "/jobs/1/cancel"],
  ["DELETE", "/jobs/1"],
  ["POST", "/jobs/archive"],
  ["GET", "/meeting-minutes-final/jobs"],
  ["GET", "/meeting-minutes-final/jobs/1"],
  ["PATCH", "/meeting-minutes-final/jobs/1/result"],
  ["POST", "/meeting-minutes-final/jobs/1/retry"],
  ["POST", "/meeting-minutes-final/jobs/1/cancel"],
  ["DELETE", "/meeting-minutes-final/jobs/1"],
  ["GET", "/project-update-test/context"],
  ["POST", "/project-update-test/context/snapshots"],
  ["GET", "/project-update-test/context/snapshots/1"],
  ["POST", "/project-update-test/context/mark-official"],
  ["POST", "/project-update-test/context/cleanup-tests"],
  ["GET", "/project-update-test/knowledge/items"],
  ["PATCH", "/project-update-test/knowledge/items/1"],
  ["DELETE", "/project-update-test/knowledge/items/1"],
  ["POST", "/project-update-test/knowledge/items"],
  ["POST", "/project-update-test/knowledge/embeddings/process"],
  ["GET", "/project-update-test/knowledge/status"],
  ["POST", "/project-update-test/knowledge/ask"]
];

test('registered minutes/project APIs reject unauthenticated requests before processing data', async () => {
  for (const [method, route] of protectedRoutes) {
    const response = await fetch(origin + '/api' + route, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json' }, ...(['POST', 'PATCH'].includes(method) ? { body: '{}' } : {}) });
    assert.equal(response.status, 401, method + ' ' + route);
    assert.equal((await response.json()).success, false);
  }
});
test('a protected page redirects to sign-in and retains its return destination', async () => {
  const response = await fetch(origin + '/private?draft=7', { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/auth/login?returnTo=%2Fprivate%3Fdraft%3D7');
  await response.text();
});
test('valid admin/client sessions propagate identity and refresh a secure cookie', async () => {
  for (const currentRole of ['admin', 'client']) {
    role = currentRole;
    const response = await fetch(origin + '/private', { headers: { Cookie: 'auth_session=' + token } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { userId: 7, email: 'owner@fixture.invalid', fullName: 'Fixture Owner', role: currentRole });
    assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  }
  assert.equal(refreshed, 2);
});
test('an unknown session is cleared and logout invalidates the token hash', async () => {
  const response = await fetch(origin + '/api/auth/me', { headers: { Cookie: 'auth_session=unknown-token' } });
  assert.equal(response.status, 401);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  await response.json();
  const logout = await fetch(origin + '/api/auth/logout', { method: 'POST', headers: { Cookie: 'auth_session=' + token } });
  assert.equal(logout.status, 200);
  await logout.json();
  assert.equal(deleted, tokenHash);
});
