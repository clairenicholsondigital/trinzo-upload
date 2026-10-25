'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');
const timingRules = require('../utils/meetingMinutesTimingInstructions');

test('every timing request carries the complete timing safeguards without relying on Microsoft persistent instructions', () => {
  const prompt = V.timingCheckPrompt([{ id: 'a1', action: 'Inspect the pump.', owners: ['Alex'],
    timing: { kind: 'target', wording: 'next week', exactDate: '' }, passage: 'Alex: I will inspect the pump next week.' }], '2026-10-25');
  assert.equal(prompt.split('\n')[0], 'ACTION_CRITIC_TIMING');
  assert.ok(prompt.includes(timingRules));
  for (const rule of ['Test kind, wording and exactDate separately', 'A candidate exactDate inside a valid range',
    'A different work item', 'same work for THIS same assignee', 'Preserve stated clock times and zones',
    'A source weekday/date/year conflict needs review', 'An explicit overdue deadline',
    'at most 25 words', 'no duplicate/unknown IDs']) assert.ok(timingRules.includes(rule), rule);
  assert.ok(prompt.includes('"schemaVersion":1,"results"'));
  assert.equal(JSON.parse(prompt.split('ITEMS:\n').at(-1))[0].id, 'a1');
});

test('other task contracts do not inherit the timing-only instruction block', () => {
  for (const build of [V.commitmentCheckPrompt, V.finalActionLifecycleCheckPrompt, V.answeredCheckPrompt,
    V.completedInMeetingCheckPrompt, V.actionCompletenessCheckPrompt]) {
    const prompt = build([]);
    assert.ok(!prompt.includes(timingRules));
    assert.ok(!prompt.includes('Test kind, wording and exactDate separately'));
  }
});
