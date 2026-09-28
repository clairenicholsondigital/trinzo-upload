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
const route = (prompt, pass) => stagedEvaluation.meetingAgentFlowUrlFor(prompt, { pass });

test('by default only the second action-discovery leg goes to the direct flow', () => {
  withEnv({ POWER_AUTOMATE_AGENT_WEBHOOK_URL: MAIN, POWER_AUTOMATE_ACTION_DISCOVERY_WEBHOOK_URL: DIRECT, POWER_AUTOMATE_ACTION_DISCOVERY_ROUTE: undefined }, () => {
    assert.equal(route('ACTION_DISCOVERY\n{"stage":"actions"}', 'actions:primary-2'), DIRECT);
    assert.equal(route('ACTION_DISCOVERY\n{"stage":"actions"}', 'actions:primary'), MAIN);
    assert.equal(route('ACTION_CRITIC\n{}', 'actions:critic'), MAIN);
    assert.equal(route('[ACTION_ANCHORED_DISCOVERY]\n{}', 'actions:recovery'), MAIN);
    assert.equal(route('SUMMARY\n{}', 'summary:summary'), MAIN);
  });
});

test('ROUTE=all sends both discovery legs to the direct flow and nothing else', () => {
  withEnv({ POWER_AUTOMATE_AGENT_WEBHOOK_URL: MAIN, POWER_AUTOMATE_ACTION_DISCOVERY_WEBHOOK_URL: DIRECT, POWER_AUTOMATE_ACTION_DISCOVERY_ROUTE: 'all' }, () => {
    assert.equal(route('ACTION_DISCOVERY\n{}', 'actions:primary'), DIRECT);
    assert.equal(route('ACTION_DISCOVERY\n{}', 'actions:primary-2'), DIRECT);
    assert.equal(route('Invoke Structured Meeting Evidence Referee', 'actions:referee-batch-1'), MAIN);
  });
});

test('without the direct flow every prompt uses the main flow', () => {
  withEnv({ POWER_AUTOMATE_AGENT_WEBHOOK_URL: MAIN, POWER_AUTOMATE_ACTION_DISCOVERY_WEBHOOK_URL: undefined }, () => {
    assert.equal(route('ACTION_DISCOVERY\n{}', 'actions:primary-2'), MAIN);
  });
  withEnv({ POWER_AUTOMATE_AGENT_WEBHOOK_URL: MAIN, POWER_AUTOMATE_ACTION_DISCOVERY_WEBHOOK_URL: '   ' }, () => {
    assert.equal(route('ACTION_DISCOVERY\n{}', 'actions:primary-2'), MAIN);
  });
});
