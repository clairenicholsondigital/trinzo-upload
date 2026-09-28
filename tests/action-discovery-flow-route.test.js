'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { stagedEvaluation } = require('../routes/api');

function withEnv(values, run) {
  const before = {};
  for (const [k, v] of Object.entries(values)) { before[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return run(); } finally { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const MAIN = 'https://example.invalid/main';
const DIRECT = 'https://example.invalid/direct';

test('action discovery goes to the direct flow when one is configured; nothing else does', () => {
  withEnv({ POWER_AUTOMATE_AGENT_WEBHOOK_URL: MAIN, POWER_AUTOMATE_ACTION_DISCOVERY_WEBHOOK_URL: DIRECT }, () => {
    assert.equal(stagedEvaluation.meetingAgentFlowUrlFor('ACTION_DISCOVERY\n{"stage":"actions"}'), DIRECT);
    assert.equal(stagedEvaluation.meetingAgentFlowUrlFor('ACTION_DISCOVERY'), DIRECT);
    assert.equal(stagedEvaluation.meetingAgentFlowUrlFor('ACTION_CRITIC\n{}'), MAIN);
    assert.equal(stagedEvaluation.meetingAgentFlowUrlFor('[ACTION_ANCHORED_DISCOVERY]\n{}'), MAIN);
    assert.equal(stagedEvaluation.meetingAgentFlowUrlFor('[DISCUSSION_ANCHORED_DISCOVERY]\n{}'), MAIN);
    assert.equal(stagedEvaluation.meetingAgentFlowUrlFor('SUMMARY\n{}'), MAIN);
    assert.equal(stagedEvaluation.meetingAgentFlowUrlFor('Invoke Structured Meeting Evidence Referee'), MAIN);
  });
});

test('without the direct flow every prompt uses the main flow', () => {
  withEnv({ POWER_AUTOMATE_AGENT_WEBHOOK_URL: MAIN, POWER_AUTOMATE_ACTION_DISCOVERY_WEBHOOK_URL: undefined }, () => {
    assert.equal(stagedEvaluation.meetingAgentFlowUrlFor('ACTION_DISCOVERY\n{}'), MAIN);
  });
  withEnv({ POWER_AUTOMATE_AGENT_WEBHOOK_URL: MAIN, POWER_AUTOMATE_ACTION_DISCOVERY_WEBHOOK_URL: '   ' }, () => {
    assert.equal(stagedEvaluation.meetingAgentFlowUrlFor('ACTION_DISCOVERY\n{}'), MAIN);
  });
});
