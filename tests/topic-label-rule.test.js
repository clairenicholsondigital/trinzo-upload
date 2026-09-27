'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stagedEvaluation } = require('../routes/api');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'topic-label-rule-v1.txt'), 'utf8').trim();
const args = {
  transcript: '[T0001] Jacqui 00:10: Back to the risk management plan.',
  details: { meetingTitle: 'Test', meetingDate: '2026-09-27' },
  anchors: [{ anchorId: 'DA-1', evidenceIds: ['T0001'], window: '[T0001] Jacqui: Back to the risk management plan.', cues: 'discussion_fact', priority: 1 }]
};
function withFlag(value, run) {
  const before = process.env.MEETING_MINUTES_AGENT_TOPIC_LABEL_RULE_V1;
  process.env.MEETING_MINUTES_AGENT_TOPIC_LABEL_RULE_V1 = value;
  try { return run(); } finally {
    if (before === undefined) delete process.env.MEETING_MINUTES_AGENT_TOPIC_LABEL_RULE_V1;
    else process.env.MEETING_MINUTES_AGENT_TOPIC_LABEL_RULE_V1 = before;
  }
}
const payloadOf = (prompt) => JSON.parse(prompt.slice(prompt.indexOf('\n') + 1));

test('the rule in code is the rule that was measured', () => {
  assert.equal(stagedEvaluation.MEETING_AGENT_TOPIC_LABEL_RULE, FIXTURE);
});

test('with the flag on, anchored discussion discovery carries it as a writing rule before the transcript', () => {
  const prompt = withFlag('1', () => stagedEvaluation.meetingMinutesAgentAnchoredDiscussionPrompt(args));
  assert.equal(prompt.split('\n')[0], '[DISCUSSION_ANCHORED_DISCOVERY]');
  const payload = payloadOf(prompt);
  assert.deepEqual(payload.writingRules, [FIXTURE]);
  const keys = Object.keys(payload);
  assert.ok(keys.indexOf('writingRules') < keys.indexOf('preparedTranscript'));
});

test('with the flag off, the request is unchanged', () => {
  const prompt = withFlag('0', () => stagedEvaluation.meetingMinutesAgentAnchoredDiscussionPrompt(args));
  assert.equal(payloadOf(prompt).writingRules, undefined);
});
