'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stagedEvaluation } = require('../routes/api');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'commitment-language-v1.txt'), 'utf8').trim();
const draft = {
  preparedTranscript: '[T0001] Stuart 00:10: Jacqui, you might want to have a look at the timeline for that.',
  details: { meetingTitle: 'Test', meetingDate: '2026-09-26' }, salientDetails: []
};
function withFlag(value, run) {
  const before = process.env.MEETING_MINUTES_AGENT_COMMITMENT_LANGUAGE_V1;
  process.env.MEETING_MINUTES_AGENT_COMMITMENT_LANGUAGE_V1 = value;
  try { return run(); } finally {
    if (before === undefined) delete process.env.MEETING_MINUTES_AGENT_COMMITMENT_LANGUAGE_V1;
    else process.env.MEETING_MINUTES_AGENT_COMMITMENT_LANGUAGE_V1 = before;
  }
}

test('the block in code is the block that was measured', () => {
  assert.equal(stagedEvaluation.MEETING_AGENT_COMMITMENT_LANGUAGE, FIXTURE);
});

test('with the flag on, action discovery carries it on line 2, after the routing marker', () => {
  const prompt = withFlag('1', () => stagedEvaluation.meetingAgentActionPrimaryPromptForDraft(draft));
  const lines = prompt.split('\n');
  assert.equal(lines[0], 'ACTION_DISCOVERY');
  assert.equal(lines.slice(1, 1 + FIXTURE.split('\n').length).join('\n'), FIXTURE);
});

test('with the flag off, the prompt is exactly what it was', () => {
  const prompt = withFlag('0', () => stagedEvaluation.meetingAgentActionPrimaryPromptForDraft(draft));
  assert.equal(prompt.split('\n')[0], 'ACTION_DISCOVERY');
  assert.equal(prompt.includes('COMMITMENT LANGUAGE'), false);
});

test('other stages are not touched, measured or not', () => {
  for (const stage of ['discussion', 'summary']) {
    const prompt = withFlag('1', () => stagedEvaluation.meetingMinutesAgentPrimaryPrompt({ stage, transcript: draft.preparedTranscript, details: draft.details }));
    assert.equal(prompt.includes('COMMITMENT LANGUAGE'), false, stage);
  }
});
