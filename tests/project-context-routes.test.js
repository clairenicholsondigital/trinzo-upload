'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const db = require('../utils/db');
const registerProjectContext = require('../routes/projectContext');

// Keep the production authentication middleware; substitute its session storage only.
const originalSessionReads = { getAuthSession: db.getAuthSession, touchAuthSession: db.touchAuthSession };
const token = 'project-context-fixture-session';
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
db.getAuthSession = async hash => hash === tokenHash
  ? { userId: 17, email: 'reviewer@example.invalid', fullName: 'Context reviewer', role: 'admin' }
  : null;
db.touchAuthSession = async () => {};
const { requireAuth } = require('../routes/auth');
Object.assign(db, originalSessionReads);

const routes = [
  ['GET', '/project-update-test/context'],
  ['POST', '/project-update-test/context/snapshots'],
  ['GET', '/project-update-test/context/snapshots/42'],
  ['POST', '/project-update-test/context/mark-official'],
  ['POST', '/project-update-test/context/cleanup-tests']
];
const storeMethods = [
  'getProjectContext', 'createProjectContextSnapshot', 'getProjectContextSnapshot',
  'markProjectContextOfficial', 'cleanupProjectUpdateTestContext'
];

async function fixture(t, store) {
  const app = express();
  const router = express.Router();
  app.use(express.json());
  registerProjectContext(router, { store, requireAuth });
  app.use('/api', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return async (method, route, body, signedIn = true) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${route}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(signedIn ? { Cookie: `auth_session=${token}` } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() };
  };
}

test('all project context routes authenticate before reading or changing storage', async t => {
  const calls = [];
  const store = Object.fromEntries(storeMethods.map(name => [name, async () => { calls.push(name); }]));
  const request = await fixture(t, store);
  for (const [method, route] of routes) {
    assert.deepEqual(await request(method, route, undefined, false), {
      status: 401, body: { success: false, error: 'Not authenticated.' }
    });
  }
  assert.deepEqual(calls, []);
});

test('context reads retain project identity, query limits and response shape', async t => {
  const calls = [];
  const context = { found: true, projectId: 17, activeMilestones: [{ milestoneId: 2 }] };
  const request = await fixture(t, {
    getProjectContext: async (...args) => { calls.push(args); return context; }
  });
  assert.deepEqual(await request('GET', '/project-update-test/context?projectId=17&projectName=Delivery&limit=8'), {
    status: 200, body: { ok: true, context }
  });
  await request('GET', '/project-update-test/context');
  assert.deepEqual(calls, [
    [{ projectId: '17', projectName: 'Delivery' }, '8'],
    [{ projectId: undefined, projectName: undefined }, undefined]
  ]);
});

test('snapshot creation prefers body identity and preserves the complete snapshot payload', async t => {
  const calls = [];
  const request = await fixture(t, {
    createProjectContextSnapshot: async (...args) => { calls.push(args); return { snapshotId: 42 }; }
  });
  const path = '/project-update-test/context/snapshots?projectId=3&projectName=Query';
  const body = { projectId: 17, projectName: 'Body', label: 'Reviewed baseline', limit: 9, notes: ['Retain'] };
  assert.deepEqual(await request('POST', path, body), {
    status: 201, body: { ok: true, snapshot: { snapshotId: 42 } }
  });
  await request('POST', path, { projectId: '', projectName: '' });
  await request('POST', '/project-update-test/context/snapshots');
  assert.deepEqual(calls, [
    [{ projectId: 17, projectName: 'Body' }, body],
    [{ projectId: '3', projectName: 'Query' }, { projectId: '', projectName: '' }],
    [{ projectId: undefined, projectName: undefined }, {}]
  ]);
});

test('snapshot lookups use the path identity and retain the missing-snapshot response', async t => {
  const calls = [];
  const request = await fixture(t, {
    getProjectContextSnapshot: async id => { calls.push(id); return id === '42' ? { snapshotId: 42 } : null; }
  });
  assert.deepEqual(await request('GET', '/project-update-test/context/snapshots/42?projectId=999'), {
    status: 200, body: { ok: true, snapshot: { snapshotId: 42 } }
  });
  assert.deepEqual(await request('GET', '/project-update-test/context/snapshots/43'), {
    status: 404, body: { ok: false, error: 'Project context snapshot not found.' }
  });
  assert.deepEqual(calls, ['42', '43']);
});

test('official context retains body/query precedence and the default baseline label', async t => {
  const calls = [];
  const request = await fixture(t, {
    markProjectContextOfficial: async (...args) => { calls.push(args); return { markedOfficial: true }; }
  });
  const path = '/project-update-test/context/mark-official';
  assert.deepEqual(await request('POST', path + '?projectId=3&projectName=Query&officialLabel=Query+label', {
    projectId: 17, projectName: 'Body', officialLabel: 'Approved baseline'
  }), { status: 200, body: { ok: true, result: { markedOfficial: true } } });
  await request('POST', path + '?projectId=3&projectName=Query&officialLabel=Query+label', {
    projectId: 0, projectName: '', officialLabel: ''
  });
  await request('POST', path);
  assert.deepEqual(calls, [
    [{ projectId: 17, projectName: 'Body' }, 'Approved baseline'],
    [{ projectId: '3', projectName: 'Query' }, 'Query label'],
    [{ projectId: undefined, projectName: undefined }, 'Official baseline']
  ]);
});

test('cleanup preserves report and snapshot flags from either location, including repeated and nested values', async t => {
  const calls = [];
  const request = await fixture(t, {
    cleanupProjectUpdateTestContext: async (...args) => { calls.push(args); return { archivedReports: 2 }; }
  });
  const path = '/project-update-test/context/cleanup-tests';
  assert.deepEqual(await request('POST', path + '?projectId=3&projectName=Query'), {
    status: 200, body: { ok: true, result: { archivedReports: 2 } }
  });
  await request('POST', path + '?projectId=3&projectName=Query&keepReports=0&keepReports=YES', {
    projectId: 17, projectName: 'Body', keepSnapshots: ['false', ['ON']]
  });
  await request('POST', path + '?keepSnapshots=true', { keepReports: ['0', false, 1], keepSnapshots: false });
  await request('POST', path, { keepReports: ['false', ' true ', 'no'], keepSnapshots: ['0', '', null] });
  assert.deepEqual(calls, [
    [{ projectId: '3', projectName: 'Query' }, { archiveReports: true, deleteNonOfficialSnapshots: true }],
    [{ projectId: 17, projectName: 'Body' }, { archiveReports: false, deleteNonOfficialSnapshots: false }],
    [{ projectId: undefined, projectName: undefined }, { archiveReports: false, deleteNonOfficialSnapshots: false }],
    [{ projectId: undefined, projectName: undefined }, { archiveReports: true, deleteNonOfficialSnapshots: true }]
  ]);
});

test('each context route retains explicit storage error statuses and messages', async t => {
  t.mock.method(console, 'error', () => {});
  const store = Object.fromEntries(storeMethods.map(name => [name, async () => {
    throw Object.assign(new Error(`Unavailable: ${name}`), { statusCode: 409 });
  }]));
  const request = await fixture(t, store);
  for (const [index, [method, route]] of routes.entries()) {
    assert.deepEqual(await request(method, route), {
      status: 409, body: { ok: false, error: `Unavailable: ${storeMethods[index]}` }
    });
  }
});

test('context storage failures without status or message retain the shared error fallback', async t => {
  t.mock.method(console, 'error', () => {});
  const request = await fixture(t, {
    getProjectContext: async () => { throw {}; }
  });
  assert.deepEqual(await request('GET', '/project-update-test/context'), {
    status: 500, body: { ok: false, error: 'Transcript analysis failed.' }
  });
});
