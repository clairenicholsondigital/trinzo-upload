'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const db = require('../utils/db');
const { registerMeetingMinutesJobList, registerMeetingMinutesJobCommands } = require('../routes/meetingMinutesJobs');
const { buildMeetingMinutesJobEditedPayload } = require('../utils/meetingMinutesJobEdits');

// Exercise production authentication while replacing only its session storage.
const originalSessionReads = { getAuthSession: db.getAuthSession, touchAuthSession: db.touchAuthSession };
const token = 'meeting-job-fixture-session';
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
db.getAuthSession = async hash => hash === tokenHash
  ? { userId: 17, email: 'reviewer@example.invalid', fullName: 'Job reviewer', role: 'admin' }
  : null;
db.touchAuthSession = async () => {};
const { requireAuth } = require('../routes/auth');
Object.assign(db, originalSessionReads);

const basePath = '/meeting-minutes-final/jobs';
const routeSpecs = [
  ['GET', basePath, 'listMeetingMinutesJobs', 'Failed to list jobs.'],
  ['GET', basePath + '/42', 'getMeetingMinutesJob', 'Failed to load job.'],
  ['PATCH', basePath + '/42/result', 'getMeetingMinutesJob', 'Failed to save edited result.'],
  ['POST', basePath + '/42/retry', 'retryMeetingMinutesJob', 'Failed to retry job.'],
  ['POST', basePath + '/42/cancel', 'cancelMeetingMinutesJob', 'Failed to cancel job.'],
  ['DELETE', basePath + '/42', 'deleteMeetingMinutesJob', 'Failed to delete job.']
];

async function fixture(t, store) {
  const app = express();
  const router = express.Router();
  app.use(express.json());
  registerMeetingMinutesJobList(router, { store, requireAuth });
  registerMeetingMinutesJobCommands(router, { store, requireAuth });
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
      headers: { 'Content-Type': 'application/json', ...(signedIn ? { Cookie: `auth_session=${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() };
  };
}

test('all historical meeting job management routes authenticate before storage', async t => {
  const calls = [];
  const store = Object.fromEntries(routeSpecs.map(([, , name]) => [name, async () => { calls.push(name); }]));
  const request = await fixture(t, store);
  for (const [method, path] of routeSpecs) {
    assert.deepEqual(await request(method, path, undefined, false), {
      status: 401, body: { success: false, error: 'Not authenticated.' }
    });
  }
  assert.deepEqual(calls, []);
});

test('meeting job listing keeps its default limit and historical response fields', async t => {
  const limits = [];
  const jobs = [{ jobId: '42', status: 'completed', progress: 100 }];
  const request = await fixture(t, {
    listMeetingMinutesJobs: async limit => { limits.push(limit); return jobs; }
  });
  for (const query of ['', '?limit=12', '?limit=']) {
    assert.deepEqual(await request('GET', basePath + query), {
      status: 200, body: { ok: true, success: true, jobs }
    });
  }
  assert.deepEqual(limits, [75, '12', 75]);
});

test('job polling exposes results only for completed jobs and retains missing-job status', async t => {
  let job = { jobId: '42', status: 'queued', resultPayload: { privatePartial: true } };
  const identities = [];
  const request = await fixture(t, {
    getMeetingMinutesJob: async id => { identities.push(id); return job; }
  });
  for (const status of ['queued', 'running', 'failed', 'cancelled']) {
    job.status = status;
    assert.deepEqual(await request('GET', basePath + '/42'), {
      status: 200, body: { ok: true, success: true, job, result: null }
    });
  }
  job.status = 'completed';
  assert.deepEqual(await request('GET', basePath + '/42'), {
    status: 200, body: { ok: true, success: true, job, result: job.resultPayload }
  });
  job = null;
  assert.deepEqual(await request('GET', basePath + '/42'), {
    status: 404, body: { ok: false, success: false, error: 'Job not found.' }
  });
  assert.deepEqual(identities, Array(6).fill('42'));
});

test('result editing rejects missing and unfinished jobs before validating the rows array', async t => {
  let job = null;
  const writes = [];
  const request = await fixture(t, {
    getMeetingMinutesJob: async () => job,
    updateMeetingMinutesJobResult: async (...args) => { writes.push(args); }
  });
  const path = basePath + '/42/result';
  assert.deepEqual(await request('PATCH', path, { editedRows: [] }), {
    status: 404, body: { ok: false, success: false, error: 'Job not found.' }
  });
  for (const status of ['queued', 'running', 'failed', 'cancelled']) {
    job = { jobId: '42', status };
    assert.deepEqual(await request('PATCH', path, {}), {
      status: 409, body: { ok: false, success: false, error: 'Only completed meeting-minutes jobs can be edited.' }
    });
  }
  job = { jobId: '42', status: 'completed' };
  for (const editedRows of [undefined, null, {}, 'text']) {
    assert.deepEqual(await request('PATCH', path, { editedRows }), {
      status: 400, body: { ok: false, success: false, error: 'Provide editedRows as an array.' }
    });
  }
  assert.deepEqual(writes, []);
});

test('reviewed results preserve unknown payload fields, grouped and flat formats and the first original output', async t => {
  const originalOutput = {
    title: 'Historical meeting', date: '2026-10-20', location: 'Cork',
    meetingObjectives: [' Confirm delivery '],
    'participants.client': [' Client '], 'participants.trinzo': [' Trinzo '],
    discussionTopics: [{ topic: 'Before editing' }], customOutput: { retained: true }
  };
  let job = {
    jobId: '42', status: 'completed', resultPayload: {
      customEnvelope: { source: 'legacy' }, result: { requestId: 'preserve', output: originalOutput }
    }
  };
  const writes = [];
  const request = await fixture(t, {
    getMeetingMinutesJob: async () => structuredClone(job),
    updateMeetingMinutesJobResult: async (id, payload) => {
      writes.push({ id, payload: structuredClone(payload) });
      job = { ...job, resultPayload: structuredClone(payload) };
      return job;
    }
  });
  const editedRows = [
    { type: 'Discussion', topic: 'Delivery & dates', itemType: 'Open question', text: 'Confirm the final date.', owner: 'Sam', deadline: 'Friday', detail: 'Date remains provisional.', evidence: 'T01' },
    { type: 'DISCUSSION', topic: 'Delivery & dates', itemType: 'Decision', text: 'Keep the staged rollout.' },
    { type: 'Action', topic: 'Delivery & dates', text: 'Send the dates.', owner: 'Sam', deadline: 'Friday', detail: 'Include dependencies.', evidence: 'T02' },
    { type: 'action', text: 'Confirm the owner.', detail: 'After the handover' },
    { type: 'Note', text: 'Reviewer-only note.' }
  ];
  const first = await request('PATCH', basePath + '/42/result', {
    editedRows, editedMeta: { meetingTitle: 'Reviewed meeting', participants: { client: [' New client '] } },
    humanEditedBy: 'forged@example.invalid'
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.success, true);
  assert.deepEqual(first.body.result, first.body.job.resultPayload);
  assert.equal(writes[0].id, '42');
  const payload = writes[0].payload;
  const output = payload.result.output;
  assert.deepEqual(payload.customEnvelope, { source: 'legacy' });
  assert.equal(payload.result.requestId, 'preserve');
  assert.deepEqual(output.customOutput, { retained: true });
  assert.deepEqual(payload.result.originalOutput, originalOutput);
  assert.equal(output.meetingTitle, 'Reviewed meeting');
  assert.equal(output.meetingDate, '2026-10-20');
  assert.equal(output.meetingLocation, 'Cork');
  assert.deepEqual(output.meetingObjectives, ['Confirm delivery']);
  assert.deepEqual(output.participants, { client: ['New client'], trinzo: ['Trinzo'] });
  assert.deepEqual(output.discussionTopics, [{
    topicId: 'delivery-dates', topic: 'Delivery & dates', summary: '', outcome: '', items: [
      { type: 'open_question', text: 'Confirm the final date.', owner: 'Sam', deadline: 'Friday', detail: 'Date remains provisional.', evidence: 'T01' },
      { type: 'decision', text: 'Keep the staged rollout.' }
    ]
  }]);
  assert.deepEqual(output.meetingMinutes, [{ topic: 'Delivery & dates', discussionPoints: ['Confirm the final date.', 'Keep the staged rollout.'] }]);
  assert.deepEqual(output.discussionPoints, ['Confirm the final date.', 'Keep the staged rollout.']);
  assert.deepEqual(output.actions, [
    { meetingActionPoint: 'Send the dates.', meetingActionPointOwner: 'Sam', meetingActionPointDeadline: 'Friday', topic: 'Delivery & dates', detail: 'Include dependencies.', evidence: 'T02' },
    { meetingActionPoint: 'Confirm the owner.', meetingActionPointOwner: 'Not stated', meetingActionPointDeadline: 'After the handover', detail: 'After the handover' }
  ]);
  assert.deepEqual(output.meetingActionPoint, ['Send the dates.', 'Confirm the owner.']);
  assert.deepEqual(output.meetingActionPointOwner, ['Sam', 'Not stated']);
  assert.deepEqual(output.meetingActionPointDeadline, ['Friday', 'After the handover']);
  assert.deepEqual(output.nextSteps, [
    { action: 'Send the dates.', owner: 'Sam', deadline: 'Friday' },
    { action: 'Confirm the owner.', owner: 'Not stated', deadline: 'After the handover' }
  ]);
  assert.equal(output.editedRows.length, 5);
  assert.equal(output.humanEdited, true);
  assert.equal(payload.humanEdited, true);
  assert.equal(payload.humanEditedBy, 'reviewer@example.invalid');
  assert.equal(output.humanEditedBy, payload.humanEditedBy);
  assert.equal(output.humanEditedAt, payload.humanEditedAt);
  assert.ok(Number.isFinite(Date.parse(output.humanEditedAt)));

  const second = await request('PATCH', basePath + '/42/result', {
    editedRows: [{ type: 'Action', text: 'Replacement action.' }], editedMeta: { meetingTitle: '' }
  });
  assert.equal(second.status, 200);
  assert.deepEqual(writes[1].payload.result.originalOutput, originalOutput);
  assert.equal(writes[1].payload.result.output.meetingTitle, '');
  assert.deepEqual(writes[1].payload.result.output.discussionTopics, []);
  assert.deepEqual(writes[1].payload.result.output.actions, [{
    meetingActionPoint: 'Replacement action.', meetingActionPointOwner: 'Not stated', meetingActionPointDeadline: 'Not stated'
  }]);
});

test('result editing reports a job that ceases to be editable during the storage write', async t => {
  let wrote = false;
  const request = await fixture(t, {
    getMeetingMinutesJob: async () => ({ jobId: '42', status: 'completed' }),
    updateMeetingMinutesJobResult: async (id, payload) => {
      wrote = true;
      assert.equal(id, '42');
      assert.deepEqual(payload.result.output.editedRows, []);
      return null;
    }
  });
  assert.deepEqual(await request('PATCH', basePath + '/42/result', { editedRows: [] }), {
    status: 404, body: { ok: false, success: false, error: 'Editable completed job not found.' }
  });
  assert.equal(wrote, true);
});

test('retry, cancellation and deletion keep their successful and unavailable-job contracts', async t => {
  let available = true;
  const calls = [];
  const request = await fixture(t, {
    retryMeetingMinutesJob: async id => { calls.push(['retry', id]); return available ? { jobId: id, status: 'queued' } : null; },
    cancelMeetingMinutesJob: async id => { calls.push(['cancel', id]); return available ? { jobId: id, status: 'cancelled' } : null; },
    deleteMeetingMinutesJob: async id => { calls.push(['delete', id]); return available; }
  });
  assert.deepEqual(await request('POST', basePath + '/42/retry'), {
    status: 200, body: { ok: true, success: true, job: { jobId: '42', status: 'queued' } }
  });
  assert.deepEqual(await request('POST', basePath + '/42/cancel'), {
    status: 200, body: { ok: true, success: true, job: { jobId: '42', status: 'cancelled' } }
  });
  assert.deepEqual(await request('DELETE', basePath + '/42'), { status: 200, body: { ok: true, success: true } });
  available = false;
  for (const [method, path, error] of [
    ['POST', basePath + '/42/retry', 'Retryable job not found.'],
    ['POST', basePath + '/42/cancel', 'Cancellable job not found.'],
    ['DELETE', basePath + '/42', 'Deletable completed/failed/cancelled job not found.']
  ]) {
    assert.deepEqual(await request(method, path), { status: 404, body: { ok: false, success: false, error } });
  }
  assert.deepEqual(calls, [['retry', '42'], ['cancel', '42'], ['delete', '42'], ['retry', '42'], ['cancel', '42'], ['delete', '42']]);
});

test('each management route retains explicit and fallback storage errors', async t => {
  let withStatus = true;
  const store = Object.fromEntries(routeSpecs.map(([, , name]) => [name, async () => {
    if (withStatus) throw Object.assign(new Error('Fixture conflict.'), { statusCode: 409 });
    throw {};
  }]));
  const request = await fixture(t, store);
  for (const [method, path] of routeSpecs) {
    assert.deepEqual(await request(method, path), {
      status: 409, body: { ok: false, success: false, error: 'Fixture conflict.' }
    });
  }
  withStatus = false;
  for (const [method, path, , fallback] of routeSpecs) {
    assert.deepEqual(await request(method, path), { status: 500, body: { ok: false, success: false, error: fallback } });
  }
});

test('edited job payloads preserve sanitation limits and slice rows before filtering blank text', () => {
  const rows = Array.from({ length: 502 }, (_, index) => ({ text: `Row ${index}` }));
  rows[0] = { text: '   ' };
  rows[1] = {
    type: 'T'.repeat(100), topic: 'P'.repeat(400), itemType: 'I'.repeat(100),
    owner: 'O'.repeat(400), deadline: 'D'.repeat(400), text: 'X'.repeat(11000),
    detail: 'Y'.repeat(11000), evidence: 'Z'.repeat(11000), ignored: 'drop'
  };
  rows[500] = { text: 'Beyond the saved row limit' };
  const output = buildMeetingMinutesJobEditedPayload({}, rows, {
    meetingTitle: 'T'.repeat(400), meetingDate: 'D'.repeat(200), meetingLocation: 'L'.repeat(400), meetingType: 'M'.repeat(200),
    meetingObjectives: Array.from({ length: 102 }, () => 'A'.repeat(1100)),
    participants: { client: Array.from({ length: 102 }, () => 'C'.repeat(250)), trinzo: Array.from({ length: 102 }, () => 'R'.repeat(250)) }
  }).result.output;
  assert.equal(output.editedRows.length, 499);
  assert.equal(output.editedRows.at(-1).text, 'Row 499');
  assert.deepEqual(Object.fromEntries(Object.entries(output.editedRows[0]).map(([name, value]) => [name, value.length])), {
    type: 80, topic: 300, itemType: 80, owner: 300, deadline: 300, text: 10000, detail: 10000, evidence: 10000
  });
  assert.equal(output.meetingTitle.length, 300);
  assert.equal(output.meetingDate.length, 120);
  assert.equal(output.meetingLocation.length, 300);
  assert.equal(output.meetingType.length, 120);
  assert.equal(output.meetingObjectives.length, 100);
  assert.ok(output.meetingObjectives.every(item => item.length === 1000));
  for (const names of Object.values(output.participants)) {
    assert.equal(names.length, 100);
    assert.ok(names.every(item => item.length === 200));
  }
});

test('edited metadata retains historical nullish fallbacks, empty overrides and nested participant precedence', () => {
  const job = { resultPayload: { result: { output: {
    meetingTitle: 'Current title', title: 'Old title', meetingDate: '2026-10-20', date: 'Old date',
    meetingLocation: 'Cork', location: 'Old location', meetingType: 'Review',
    meetingObjectives: [' Current objective ', '', 0, false],
    participants: { client: [], trinzo: [' Nested Trinzo '] },
    'participants.client': ['Flat client'], 'participants.trinzo': ['Flat Trinzo']
  } } } };
  const before = structuredClone(job);
  const fallback = buildMeetingMinutesJobEditedPayload(job, [], 'invalid', '').result.output;
  assert.equal(fallback.meetingTitle, 'Current title');
  assert.equal(fallback.meetingDate, '2026-10-20');
  assert.equal(fallback.meetingLocation, 'Cork');
  assert.equal(fallback.meetingType, 'Review');
  assert.deepEqual(fallback.meetingObjectives, ['Current objective']);
  assert.deepEqual(fallback.participants, { client: [], trinzo: ['Nested Trinzo'] });
  assert.equal(fallback.humanEditedBy, 'OpenClaw');
  const overridden = buildMeetingMinutesJobEditedPayload(job, [], {
    meetingTitle: '', meetingDate: null, meetingLocation: 0, meetingType: false,
    meetingObjectives: [], participants: { client: [], trinzo: [] }
  }, 'actor@example.invalid').result.output;
  assert.equal(overridden.meetingTitle, '');
  assert.equal(overridden.meetingDate, '2026-10-20');
  assert.equal(overridden.meetingLocation, '0');
  assert.equal(overridden.meetingType, 'false');
  assert.deepEqual(overridden.meetingObjectives, []);
  assert.deepEqual(overridden.participants, { client: [], trinzo: [] });
  assert.equal(overridden.humanEditedBy, 'actor@example.invalid');
  assert.deepEqual(job, before, 'constructing a new payload leaves the loaded job unchanged');
});

test('edited result mapping keeps default discussion and note rows without inventing accepted actions', () => {
  const payload = buildMeetingMinutesJobEditedPayload({ resultPayload: 'legacy-invalid' }, [
    null, { type: 'discussion', topic: '!!!', text: 'Question remains open.' },
    { type: 'Discussion', text: 'Keep a separate default topic.' },
    { type: 'proposal', text: 'Possible follow-up.' }, { text: 23 },
    { type: 'action', text: 'Recorded commitment.' }
  ], null);
  const output = payload.result.output;
  assert.deepEqual(payload.result.originalOutput, {});
  assert.equal(output.discussionTopics.length, 2);
  assert.equal(output.discussionTopics[0].topicId, 'discussion');
  assert.equal(output.discussionTopics[1].topic, 'Discussion');
  assert.equal(output.discussionTopics[0].items[0].type, 'discussion');
  assert.equal(output.editedRows.length, 5);
  assert.equal(output.editedRows[3].type, 'Note');
  assert.equal(output.editedRows[3].text, '23');
  assert.deepEqual(output.actions, [{ meetingActionPoint: 'Recorded commitment.', meetingActionPointOwner: 'Not stated', meetingActionPointDeadline: 'Not stated' }]);
});
