'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const registerProjects = require('../routes/projectRecords');
const registerFeedback = require('../routes/minutesFeedback');
const { sendTestError } = require('../utils/apiErrors');

async function fixture(t, store, register) {
  const app = express(), router = express.Router();
  app.use(express.json());
  register(router, { store, sendTestError, requireAuth(req, res, next) {
    if (!req.get('x-fixture-user')) return res.status(401).json({ success: false });
    req.authUser = { fullName: 'Signed-in reviewer', email: 'fixture@example.invalid' }; next();
  } });
  app.use('/api', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return async (method, route, body, signedIn = true) => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api' + route, {
      method, headers: { 'Content-Type': 'application/json', ...(signedIn ? { 'x-fixture-user': 'reviewer' } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() };
  };
}

test('project records require authentication before storage and preserve CRUD response contracts', async t => {
  let current, reads = 0;
  const request = await fixture(t, {
    listProjectOptions: async limit => { reads++; assert.equal(limit, '10'); return current ? [current] : []; },
    createProject: async body => (current = { projectId: 17, ...body }),
    updateProject: async (id, body) => { assert.equal(id, '17'); return current = { ...current, ...body }; },
    deleteProject: async id => { assert.equal(id, '17'); const before = current; current = null; return before; }
  }, registerProjects);
  const path = '/project-update-test/projects';
  assert.equal((await request('GET', path + '?limit=10', undefined, false)).status, 401);
  assert.equal(reads, 0);
  assert.deepEqual(await request('POST', path, { projectName: 'Review project' }), {
    status: 201, body: { ok: true, project: { projectId: 17, projectName: 'Review project' } }
  });
  assert.equal((await request('PATCH', path + '/17', { projectName: 'Renamed project' })).body.project.projectName, 'Renamed project');
  assert.equal((await request('GET', path + '?limit=10')).body.projects[0].projectName, 'Renamed project');
  assert.equal((await request('DELETE', path + '/17')).status, 200);
  assert.deepEqual(await request('DELETE', path + '/17'), { status: 404, body: { ok: false, error: 'Project not found.' } });
});

test('report approval uses the signed-in actor and preserves version conflict errors', async t => {
  let received;
  const request = await fixture(t, {
    saveProjectReportDetail: async (id, body) => {
      assert.equal(id, '42'); received = body;
      if (body.baseVersionId === 1) throw Object.assign(new Error('Saved report changed.'), { statusCode: 409 });
      return { reportId: 42, savedBy: body.savedBy };
    }
  }, registerProjects);
  t.mock.method(console, 'error', () => {});
  const path = '/project-update-test/reports/42';
  const result = await request('PATCH', path, { approve: true, baseVersionId: 2, savedBy: 'Forged actor' });
  assert.equal(result.body.report.savedBy, 'Signed-in reviewer');
  assert.equal(received.approve, true); assert.equal(received.baseVersionId, 2);
  assert.deepEqual(await request('PATCH', path, { baseVersionId: 1 }), {
    status: 409, body: { ok: false, error: 'Saved report changed.' }
  });
});

test('milestones and risks retain created/existing status codes and missing-record responses', async t => {
  const request = await fixture(t, {
    createProjectMilestone: async body => ({ milestoneId: 3, created: body.new }),
    createProjectRisk: async body => ({ riskId: 4, created: body.new }),
    getProjectMilestoneDetail: async () => null,
    getProjectRiskDetail: async () => null,
    getProjectReportDetail: async () => null
  }, registerProjects);
  for (const kind of ['milestones', 'risks']) {
    const path = '/project-update-test/' + kind;
    assert.equal((await request('POST', path, { new: true })).status, 201);
    assert.equal((await request('POST', path, { new: false })).status, 200);
    assert.equal((await request('GET', path + '/99')).status, 404);
  }
  assert.equal((await request('GET', '/project-update-test/reports/99')).status, 404);
});

test('feedback configuration and authentication fail before reading storage', async t => {
  let configured = false, reads = 0;
  const request = await fixture(t, {
    hasDatabaseConfig: () => configured, getDatabaseConfigError: () => 'Database unavailable.',
    listMeetingMinutesFeedback: async limit => { reads++; assert.equal(limit, '12'); return [{ feedbackId: 7 }]; }
  }, registerFeedback);
  t.mock.method(console, 'error', () => {});
  const path = '/meeting-minutes-final/feedback-submissions?limit=12';
  assert.equal((await request('GET', path, undefined, false)).status, 401);
  assert.deepEqual(await request('GET', path), { status: 503, body: { ok: false, error: 'Database unavailable.' } });
  assert.equal(reads, 0); configured = true;
  assert.deepEqual((await request('GET', path)).body.feedback, [{ feedbackId: 7 }]);
});

test('feedback review persists the supported fields and retains not-found responses', async t => {
  let current = { feedbackId: 7 }, received;
  const request = await fixture(t, {
    hasDatabaseConfig: () => true,
    getMeetingMinutesFeedback: async id => { assert.equal(id, '7'); return current; },
    updateMeetingMinutesFeedback: async (id, body) => { assert.equal(id, '7'); received = body; return current && { ...current, ...body }; },
    deleteMeetingMinutesFeedback: async () => { const before = current; current = null; return Boolean(before); }
  }, registerFeedback);
  const path = '/meeting-minutes-final/feedback-submissions/7';
  assert.equal((await request('GET', path)).body.feedback.feedbackId, 7);
  const body = { status: 'resolved', claireComments: 'Reviewed', fixDetails: 'Fixed', ignored: 'omit' };
  assert.equal((await request('PATCH', path, body)).status, 200);
  assert.deepEqual(received, { status: 'resolved', claireComments: 'Reviewed', fixDetails: 'Fixed' });
  assert.deepEqual(await request('DELETE', path), { status: 200, body: { ok: true } });
  for (const method of ['GET', 'PATCH', 'DELETE']) assert.equal((await request(method, path, method === 'PATCH' ? {} : undefined)).status, 404);
});
