'use strict';

const crypto = require('crypto');
const { TIMING_POLICY_VERSION } = require('./meetingMinutesTiming');

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

function meetingAgentPassCacheKey(prompt) {
  // Microsoft prompt policies can change without changing a caller's text.
  // Version these results too, so pre-fix discovery/check responses cannot
  // bypass the new policy just because the same draft is regenerated warm.
  return crypto.createHash('sha256').update(JSON.stringify({
    timingPolicyVersion: TIMING_POLICY_VERSION, prompt: String(prompt || '')
  })).digest('hex');
}

function meetingMinutesAgentReplayPassCacheEnabled() {
  return /^(?:1|true|yes|on)$/i.test(String(process.env.MEETING_MINUTES_AGENT_REPLAY_PASS_CACHE || '0'));
}

module.exports = { normaliseMeetingAgentPassCache, meetingAgentPassCacheKey, meetingMinutesAgentReplayPassCacheEnabled };
