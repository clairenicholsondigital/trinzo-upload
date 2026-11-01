'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { meetingMinutesAgentPrimaryUnionEnabled } = require('../utils/meetingMinutesOriginalFeatures');

test('off unless switched on', () => {
  const before = process.env.MEETING_MINUTES_AGENT_PRIMARY_UNION_V1;
  delete process.env.MEETING_MINUTES_AGENT_PRIMARY_UNION_V1;
  assert.equal(meetingMinutesAgentPrimaryUnionEnabled(), false);
  process.env.MEETING_MINUTES_AGENT_PRIMARY_UNION_V1 = '1';
  assert.equal(meetingMinutesAgentPrimaryUnionEnabled(), true);
  if (before === undefined) delete process.env.MEETING_MINUTES_AGENT_PRIMARY_UNION_V1; else process.env.MEETING_MINUTES_AGENT_PRIMARY_UNION_V1 = before;
});
