'use strict';

const { meetingMinutesAgentText } = require('./meetingMinutesPlainText');
const { normaliseKnownTermsDeep: normaliseMeetingAgentKnownTermsDeep } = require('./meetingMinutesText');

const MEETING_AGENT_PASS_CACHE_MAX_ENTRIES = 16;

function normaliseMeetingAgentPassCache(value) {
  return (Array.isArray(value) ? value : []).filter((entry) =>
    entry && typeof entry === 'object'
      && /^[a-f0-9]{64}$/.test(String(entry.promptSha256 || ''))
      && entry.result && typeof entry.result === 'object')
    .slice(-MEETING_AGENT_PASS_CACHE_MAX_ENTRIES)
    .map((entry) => ({
      stage: ['discussion', 'actions', 'summary'].includes(entry.stage) ? entry.stage : '',
      pass: meetingMinutesAgentText(entry.pass, 40),
      promptSha256: entry.promptSha256,
      completedAt: entry.completedAt || '',
      result: normaliseMeetingAgentKnownTermsDeep(entry.result)
    }));
}

module.exports = { normaliseMeetingAgentPassCache };
