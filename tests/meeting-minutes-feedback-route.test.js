'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../utils/db');

// Exercise the real registered handler with a storage boundary that never
// constructs a database client or performs a write.
const saved = [];
const originals = {
  hasDatabaseConfig: db.hasDatabaseConfig,
  saveMeetingMinutesFeedback: db.saveMeetingMinutesFeedback
};
db.hasDatabaseConfig = () => true;
db.saveMeetingMinutesFeedback = async payload => {
  saved.push(structuredClone(payload));
  return { feedbackId: 'offline-feedback', createdAt: '2026-10-21T12:00:00Z' };
};
let router;
try {
  router = require('../routes/api');
} finally {
  Object.assign(db, originals);
}
const route = router.stack.find(layer => layer.route?.path === '/meeting-minutes-final/feedback').route;
const handler = route.stack.at(-1).handle;

async function request(body) {
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
  await handler({ body, get: header => header === 'user-agent' ? 'offline-feedback-test' : '' }, response);
  return response;
}

test('feedback stores only its allowlisted fields even when unrelated request fields are supplied', async () => {
  saved.length = 0;
  const response = await request({
    feedbackType: ' BUG ', message: '  The save button was confusing.  ', contactName: ' Reviewer ',
    contactEmail: ' reviewer@example.test ', route: '/meeting-minutes-final?review=1',
    selectedSnippet: ' Selected wording ', transcriptText: 'UNRELATED_RAW_INPUT',
    metadata: { transcriptText: 'UNRELATED_NESTED_INPUT' }, unexpectedField: 'UNRELATED_FIELD'
  });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.body, { ok: true, feedbackId: 'offline-feedback', createdAt: '2026-10-21T12:00:00Z' });
  assert.deepEqual(saved, [{
    route: '/meeting-minutes-final', feedbackType: 'bug', message: 'The save button was confusing.',
    contactName: 'Reviewer', contactEmail: 'reviewer@example.test', userAgent: 'offline-feedback-test',
    metadata: {
      source: 'meeting-minutes-final-feedback-widget', pathname: '/meeting-minutes-final?review=1',
      selectedSnippet: 'Selected wording'
    }
  }]);
});

test('feedback uses safe defaults for an unknown type and absent optional fields', async () => {
  saved.length = 0;
  assert.equal((await request({ feedbackType: 'unknown', message: 'The screen was easy to use.' })).statusCode, 201);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].feedbackType, 'general');
  assert.equal(saved[0].contactName, '');
  assert.equal(saved[0].contactEmail, '');
  assert.deepEqual(saved[0].metadata, {
    source: 'meeting-minutes-final-feedback-widget', pathname: '/meeting-minutes-final', selectedSnippet: null
  });
});

test('invalid feedback is rejected before the storage boundary', async () => {
  saved.length = 0;
  const valid = { message: 'The save button was confusing.' };
  for (const invalid of [
    { message: '' }, { message: 'too short' }, { message: 'x'.repeat(2001) },
    { contactName: 'x'.repeat(121) }, { contactEmail: 'invalid-email' },
    { contactEmail: `${'x'.repeat(250)}@example.test` }, { selectedSnippet: 'x'.repeat(4001) }
  ]) {
    const response = await request({ ...valid, ...invalid });
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.ok, false);
    assert.ok(response.body.error);
  }
  assert.deepEqual(saved, []);
});
