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

function assertWritingRulesBeforeTranscript(payload, topicLabelEnabled) {
  assert.ok(Array.isArray(payload.writingRules));
  const timingRules = payload.writingRules.filter((rule) => rule.startsWith('Timing precision.'));
  assert.equal(timingRules.length, 1, 'timing precision is unconditional');
  assert.match(timingRules[0], /Preserve the source timing, its task, conditions and qualifications/);
  assert.match(timingRules[0], /Keep exactDate empty unless a single calendar date is unambiguously supported/);
  assert.match(timingRules[0], /a rejected or uncertain date does not reject an otherwise supported action/);
  assert.deepEqual(payload.writingRules.filter((rule) => rule.startsWith('TOPIC LABELS.')),
    topicLabelEnabled ? [FIXTURE] : []);
  assert.equal(payload.writingRules.filter((rule) => rule === stagedEvaluation.MEETING_AGENT_DISCUSSION_COVERAGE_RULE).length, 1,
    'discussion coverage remains active with either topic-label flag value');
  const keys = Object.keys(payload);
  assert.ok(keys.includes('writingRules') && keys.includes('preparedTranscript'));
  assert.ok(keys.indexOf('writingRules') < keys.indexOf('preparedTranscript'),
    'all writing rules must appear before the prepared transcript');
  assert.equal(payload.preparedTranscript, args.transcript);
}

test('the rule in code is the rule that was measured', () => {
  assert.equal(stagedEvaluation.MEETING_AGENT_TOPIC_LABEL_RULE, FIXTURE);
});

test('with the flag on, anchored discussion discovery carries it as a writing rule before the transcript', () => {
  const prompt = withFlag('1', () => stagedEvaluation.meetingMinutesAgentAnchoredDiscussionPrompt(args));
  assert.equal(prompt.split('\n')[0], '[DISCUSSION_ANCHORED_DISCOVERY]');
  const payload = payloadOf(prompt);
  assertWritingRulesBeforeTranscript(payload, true);
});

test('with the flag off, timing and discussion coverage rules remain before the transcript', () => {
  const prompt = withFlag('0', () => stagedEvaluation.meetingMinutesAgentAnchoredDiscussionPrompt(args));
  assert.equal(prompt.split('\n')[0], '[DISCUSSION_ANCHORED_DISCOVERY]');
  assertWritingRulesBeforeTranscript(payloadOf(prompt), false);
});
