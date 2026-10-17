'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../utils/db');

// Exercise the actual route handlers without authentication, persistence or a
// model call. An invalid stage must be rejected before any draft is loaded.
let draftLoads = 0;
const originalGetDraft = db.getMeetingMinutesAgentDraft;
db.getMeetingMinutesAgentDraft = async () => {
  draftLoads += 1;
  return null;
};
let router;
try {
  router = require('../routes/api');
} finally {
  db.getMeetingMinutesAgentDraft = originalGetDraft;
}

test('stored generation markers cannot use inherited object properties as stages', () => {
  for (const stage of ['constructor', '__proto__']) {
    const generation = router.stagedEvaluation.normaliseMeetingAgentGeneration({ stage, status: 'running' });
    assert.equal(generation.stage, 'discussion');
  }
  for (const stage of ['discussion', 'actions', 'summary']) {
    const generation = router.stagedEvaluation.normaliseMeetingAgentGeneration({ stage, status: 'running' });
    assert.equal(generation.stage, stage);
  }
});

for (const routePath of [
  '/meeting-minutes-agent/generate',
  '/meeting-minutes-agent/drafts/:draftId/generate-background'
]) {
  const route = router.stack.find((layer) => layer.route?.path === routePath).route;
  const handler = route.stack.at(-1).handle;

  test(`${routePath} rejects unknown and inherited stage names before reading a draft`, async () => {
    for (const stage of ['', 'review', 'constructor', '__proto__']) {
      const before = draftLoads;
      const response = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
      };
      await handler({
        body: { stage, draftId: 'missing-draft', revision: 1 },
        params: { draftId: 'missing-draft' },
        authUser: { userId: 'test-user' }
      }, response);
      assert.equal(response.statusCode, 400, stage || 'empty stage');
      assert.equal(response.body.error, 'Choose discussion, actions or summary.');
      assert.equal(draftLoads, before, `invalid stage ${stage} must not reach persistence`);
    }
  });

  test(`${routePath} accepts all supported stages and normalises case and whitespace`, async () => {
    for (const stage of ['discussion', 'actions', 'summary', ' ACTIONS ']) {
      const before = draftLoads;
      const response = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
      };
      await handler({
        body: { stage, draftId: 'missing-draft', revision: 1 },
        params: { draftId: 'missing-draft' },
        authUser: { userId: 'test-user' }
      }, response);
      assert.equal(response.statusCode, 404, stage);
      assert.equal(draftLoads, before + 1, `supported stage ${stage} must load its draft`);
    }
  });
}
