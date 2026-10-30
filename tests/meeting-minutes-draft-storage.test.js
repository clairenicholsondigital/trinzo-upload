'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { PAYLOAD_VERSION, migrateDraftPayload } = require('../utils/meetingMinutesDraftStorage');

test('a draft saved before the flow gained two screens opens where its owner left it', () => {
  // 0 details, 1 focus, 2 discussion, 3 actions, 4 summary, 5 review.
  // Old numbering had no focus or summary screen, so 1/2/3 mean 2/3/5 now.
  const cases = [[0, 0], [1, 2], [2, 3], [3, 5]];
  for (const [stored, expected] of cases) {
    const once = migrateDraftPayload({ currentStep: stored });
    assert.equal(once.currentStep, expected);
    assert.equal(once.payloadVersion, PAYLOAD_VERSION);
    // Idempotent: a read that is never saved must not shift the step again.
    assert.equal(migrateDraftPayload(once).currentStep, expected);
    assert.equal(migrateDraftPayload({ currentStep: stored, payloadVersion: 0 }).currentStep, expected);
  }
  // An empty payload (the column default) must migrate, not be skipped.
  assert.equal(migrateDraftPayload({}).currentStep, 0);
  // A draft already at the current version is left exactly as it is.
  const current = { payloadVersion: PAYLOAD_VERSION, currentStep: 5 };
  assert.equal(migrateDraftPayload(current), current);
});


test('reading stored drafts does not load the generation workflow', () => {
  execFileSync(process.execPath, ['-e', `require('./utils/db');
    if (Object.keys(require.cache).some(p => p.endsWith('/meetingMinutesAgentV2.js'))) {
      throw new Error('Database access loaded the generation workflow');
    }`], { cwd: require('node:path').resolve(__dirname, '..') });
});
