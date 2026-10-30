'use strict';

const crypto = require('crypto');
const { meetingMinutesAgentText } = require('./meetingMinutesPlainText');

function meetingAgentDiscussionFingerprint(discussion = []) {
  const rows = (Array.isArray(discussion) ? discussion : []).map((topic) => ({
    topic: meetingMinutesAgentText(topic?.topic, 220),
    points: (topic?.points || []).map((item) => meetingMinutesAgentText(item?.text, 1600)),
    decisions: (topic?.decisions || []).map((item) => meetingMinutesAgentText(item?.text, 1600)),
    openQuestions: (topic?.openQuestions || []).map((item) => meetingMinutesAgentText(item?.text, 1600))
  }));
  return crypto.createHash('sha1').update(JSON.stringify(rows)).digest('hex').slice(0, 16);
}

module.exports = { meetingAgentDiscussionFingerprint };
