'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { stagedEvaluation } = require('../routes/api');

test('global topic arranger is opt-in and accepts the standard boolean forms', () => {
  const previous = process.env.MEETING_MINUTES_AGENT_GLOBAL_TOPIC_ARRANGER_V1;
  try {
    delete process.env.MEETING_MINUTES_AGENT_GLOBAL_TOPIC_ARRANGER_V1;
    assert.equal(stagedEvaluation.meetingMinutesAgentGlobalTopicArrangerEnabled(), false);
    process.env.MEETING_MINUTES_AGENT_GLOBAL_TOPIC_ARRANGER_V1 = 'yes';
    assert.equal(stagedEvaluation.meetingMinutesAgentGlobalTopicArrangerEnabled(), true);
  } finally {
    if (previous == null) delete process.env.MEETING_MINUTES_AGENT_GLOBAL_TOPIC_ARRANGER_V1;
    else process.env.MEETING_MINUTES_AGENT_GLOBAL_TOPIC_ARRANGER_V1 = previous;
  }
});

test('topic arrangement prompt asks for a lossless global partition and treats related timings as one schedule', () => {
  const prompt = stagedEvaluation.meetingMinutesAgentTopicArrangementPrompt({
    discussion: [
      { id: 'dates', topic: 'Key dates', points: [
        { id: 'date-row', text: 'Preparation starts on Monday.', evidenceIds: ['T0002'] }
      ], decisions: [], openQuestions: [] },
      { id: 'hours', topic: 'Working hours', points: [
        { id: 'hours-row', text: 'The working day is 08:30 to 17:00.', evidenceIds: ['T0003'] }
      ], decisions: [], openQuestions: [] }
    ],
    sourceUnits: [
      { id: 'T0002', text: 'Preparation starts Monday.' },
      { id: 'T0003', text: 'We work from eight thirty until five.' }
    ]
  });
  assert.match(prompt, /Every supplied recordId must appear exactly once/);
  assert.match(prompt, /calendar dates, phases, start and finish times, working hours and deadlines/);
  assert.match(prompt, /same event or workstream/);
  assert.match(prompt, /Keep team membership, accommodation, travel, technical content/);
  assert.match(prompt, /There are exactly 2 supplied recordIds/);
  const records = JSON.parse(prompt.split('RECORDS_JSON=')[1]);
  assert.deepEqual(records.map((record) => record.recordId), ['date-row', 'hours-row']);
  assert.deepEqual(records.map((record) => record.evidenceOrder), [1, 2]);
});
