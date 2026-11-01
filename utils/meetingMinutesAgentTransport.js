'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const fetch = require('node-fetch');
const { meetingAgentResultError } = require('./meetingMinutesResponseContracts');
const { meetingMinutesAgentText } = require('./meetingMinutesPlainText');
const { refereeFailureSnapshot } = require('./meetingMinutesRefereeFailureAudit');
const { meetingAgentFailureClass, meetingAgentResultCounts } = require('./meetingMinutesAgentGeneration');

// Models on some AI Builder prompts wrap an otherwise valid JSON reply in a
// Markdown fence. Accept that shape quietly; anything that is still not JSON
// returns null and is rejected by the caller exactly as before.
function parseJsonLenient(text) {
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch { /* try the fenced form */ }
  const cleaned = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  if (cleaned === text.trim() || !cleaned.startsWith('{')) return null;
  try { return JSON.parse(cleaned); } catch { return null; }
}

const meetingAgentCallQueue = [];
let meetingAgentActiveCalls = 0;
let meetingAgentLastCallStartedAt = 0;
let meetingAgentQueueTimer = null;

// Defaults are unchanged (2 in flight, 6.5 s between starts). The clamps used
// to pin both values regardless of the environment, so three "parallel"
// referee batches always paid a 13 s stagger; they can now be tuned per
// deployment and measured with the performance baseline harness.
const MEETING_AGENT_MAX_ACTIVE_CALLS = Math.max(1, Math.min(4,
  Number(process.env.MEETING_MINUTES_AGENT_MAX_ACTIVE_CALLS || 2)));
const MEETING_AGENT_CALL_START_GAP_MS = Math.max(1000,
  Number(process.env.MEETING_MINUTES_AGENT_CALL_START_GAP_MS || 6500));

function drainMeetingAgentCallQueue() {
  if (meetingAgentActiveCalls >= MEETING_AGENT_MAX_ACTIVE_CALLS || !meetingAgentCallQueue.length) return;
  const waitMs = Math.max(0, MEETING_AGENT_CALL_START_GAP_MS - (Date.now() - meetingAgentLastCallStartedAt));
  if (waitMs > 0) {
    if (!meetingAgentQueueTimer) meetingAgentQueueTimer = setTimeout(() => {
      meetingAgentQueueTimer = null;
      drainMeetingAgentCallQueue();
    }, waitMs);
    return;
  }
  // Speculative work never delays a reviewer who is waiting on screen: a
  // foreground request queues ahead of every background one.
  const foregroundIndex = meetingAgentCallQueue.findIndex((entry) => !entry.background);
  const { resolve } = meetingAgentCallQueue.splice(foregroundIndex >= 0 ? foregroundIndex : 0, 1)[0];
  meetingAgentActiveCalls += 1;
  meetingAgentLastCallStartedAt = Date.now();
  resolve(() => {
    meetingAgentActiveCalls = Math.max(0, meetingAgentActiveCalls - 1);
    drainMeetingAgentCallQueue();
  });
  if (meetingAgentCallQueue.length) setTimeout(drainMeetingAgentCallQueue, MEETING_AGENT_CALL_START_GAP_MS);
}

const meetingAgentCallContext = new AsyncLocalStorage();

function meetingAgentCallIsBackground() {
  return Boolean(meetingAgentCallContext.getStore()?.background);
}

function acquireMeetingAgentCallSlot() {
  return new Promise((resolve) => {
    meetingAgentCallQueue.push({ resolve, background: meetingAgentCallIsBackground() });
    drainMeetingAgentCallQueue();
  });
}

// Which flow answers a prompt. Action discovery (prompt line 1 is the
// ACTION_DISCOVERY marker) can go to a flow that calls the Meeting Action
// Extractor child agent directly: traced on 2026-09-27, every flow non-answer
// (ContentValidationError, Escalate topic, {"Done":true}, invalid_output) was
// the parent orchestrator's own turn failing after the child had already
// returned a full answer. Measured 2026-09-28, 5 transcripts x 5 runs per arm,
// failures counted as empty: parent flow 75.7% of gold per call (4 of 25
// calls non-answers, 36 s), child flow 89.4% (0 non-answers, 14 s), but two
// child runs unioned reach only 90.4% where two parent runs reach 95.1% -
// the parent's variance is worth keeping. One parent leg unioned with one
// child leg: 93.2% with no retries. So by default only the second discovery
// leg ('actions:primary-2') goes to the direct flow;
// POWER_AUTOMATE_ACTION_DISCOVERY_ROUTE=all sends both. Everything else keeps
// the main flow. An unset direct URL means no change.
function meetingAgentFlowUrlFor(prompt = '', options = {}) {
  const main = String(process.env.POWER_AUTOMATE_AGENT_WEBHOOK_URL || '').trim();
  const direct = String(process.env.POWER_AUTOMATE_ACTION_DISCOVERY_WEBHOOK_URL || '').trim();
  if (!direct) return main;
  const marker = String(prompt || '').split('\n', 1)[0].trim();
  if (marker !== 'ACTION_DISCOVERY') return main;
  const route = String(process.env.POWER_AUTOMATE_ACTION_DISCOVERY_ROUTE || 'second-leg').trim().toLowerCase();
  if (route === 'all') return direct;
  return /:primary-2$/.test(String(options.pass || '')) ? direct : main;
}

// Typed upstream failures use their own envelope, independent of the requested
// success schema. Recognising one never makes it a successful minutes result:
// the retry wrapper still raises meetingAgentResultError before validation.
function meetingAgentHasTypedError(value) {
  const error = value && typeof value === 'object' && !Array.isArray(value) ? value.error : null;
  return Boolean(error && typeof error === 'object' && !Array.isArray(error)
    && typeof error.code === 'string' && error.code.trim()
    && typeof error.message === 'string' && error.message.trim());
}

// Observations never join the provider promise chain. Only bounded metadata is
// passed to an observer, and a failed or pending observer cannot alter a call.
function notifyMeetingAgentStatus(options, code, result) {
  const context = meetingAgentCallContext.getStore();
  const onStatus = typeof options.onStatus === 'function' ? options.onStatus : context?.onStatus;
  const stage = options.stage || context?.stage;
  if (typeof onStatus !== 'function' || !['summary', 'discussion', 'actions'].includes(stage)) return;
  Promise.resolve().then(() => {
    const event = { stage, code };
    if (code === 'validated' && result) {
      if (stage === 'summary' && (typeof result.executiveSummary === 'string' || Array.isArray(result.meetingObjectives))) {
        event.counts = { records: Number(typeof result.executiveSummary === 'string' && Boolean(result.executiveSummary.trim()))
          + (Array.isArray(result.meetingObjectives) ? result.meetingObjectives.length : 0),
          proposals: 0, flags: Array.isArray(result.reviewFlags) ? result.reviewFlags.length : 0 };
      } else if (stage !== 'summary' && (Array.isArray(result.discussion)
        || Array.isArray(result.actions) || Array.isArray(result.actionProposals))) {
        const counts = meetingAgentResultCounts(result);
        event.counts = { records: counts.outputRecordCount, proposals: counts.proposalCount, flags: counts.reviewFlagCount };
      }
    }
    return onStatus(event);
  }).catch(() => {});
}

async function askPowerAutomateMeetingMinutesAgent(prompt, options = {}) {
  const webhookUrl = meetingAgentFlowUrlFor(prompt, options);
  if (!webhookUrl) {
    const error = new Error('POWER_AUTOMATE_AGENT_WEBHOOK_URL is not configured.');
    error.statusCode = 500;
    throw error;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(webhookUrl);
  } catch {
    const error = new Error('POWER_AUTOMATE_AGENT_WEBHOOK_URL is invalid.');
    error.statusCode = 500;
    throw error;
  }
  if (parsedUrl.protocol !== 'https:') {
    const error = new Error('The Power Automate agent endpoint must use HTTPS.');
    error.statusCode = 500;
    throw error;
  }

  if (options.paced === true) notifyMeetingAgentStatus(options, 'queued');
  const release = options.paced === true ? await acquireMeetingAgentCallSlot() : () => {};
  const controller = new AbortController();
  const timeoutMs = Math.max(10000, Number(options.timeoutMs || process.env.POWER_AUTOMATE_AGENT_TIMEOUT_MS || 120000));
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response, rawBody;
  try {
    notifyMeetingAgentStatus(options, 'request_sent');
    response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { prompt } }),
      signal: controller.signal
    });
    // Headers alone are not a completed call. Keep the deadline and active
    // slot until the full response body has arrived.
    rawBody = await response.text();
    notifyMeetingAgentStatus(options, 'response_received');
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('The meeting-minutes agent did not reply in time.');
      timeoutError.statusCode = 504;
      timeoutError.retryable = true;
      timeoutError.code = 'power_automate_timeout';
      throw timeoutError;
    }
    const requestError = new Error('Power Automate could not be reached.');
    requestError.statusCode = 502;
    requestError.retryable = true;
    requestError.code = 'power_automate_unreachable';
    throw requestError;
  } finally {
    clearTimeout(timeout);
    release();
  }

  // Optional private diagnostics must see the wire body before parsing can
  // reject it. Never attach source content to errors or public/log metadata.
  if (typeof options.onRawResponse === 'function') {
    try { await options.onRawResponse(rawBody); } catch { /* Diagnostics cannot change the provider outcome. */ }
  }
  if (!response.ok) {
    const error = new Error(`Power Automate agent call failed with status ${response.status}.`);
    error.statusCode = response.status === 429 || response.status >= 500 ? 503 : 502;
    error.retryable = response.status === 429 || response.status >= 500;
    error.upstreamStatus = response.status;
    error.code = response.status === 429 ? 'power_automate_throttled' : `power_automate_http_${response.status}`;
    throw error;
  }
  if (!rawBody.trim()) {
    const error = new Error('Power Automate returned an empty agent response.');
    error.statusCode = 502;
    error.retryable = true;
    error.code = 'power_automate_empty_response';
    throw error;
  }

  notifyMeetingAgentStatus(options, 'validating');
  const parsed = parseJsonLenient(rawBody);
  const queue = [parsed];
  const seen = new Set();
  let structured = null;
  while (queue.length && !structured) {
    const candidate = queue.shift();
    if (candidate == null || (typeof candidate !== 'object' && typeof candidate !== 'string')) continue;
    if (typeof candidate === 'object' && seen.has(candidate)) continue;
    if (typeof candidate === 'object') seen.add(candidate);
    const isMinutesResult = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      && Array.isArray(candidate.discussion) && Array.isArray(candidate.actions);
    const isRefereeResult = options.responseKind === 'referee'
      && candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      && (Array.isArray(candidate.candidateDispositions) || Boolean(candidate.error));
    const isFlatDiscussionDiscoveryResult = options.responseKind === 'discussion_discovery'
      && candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      && Array.isArray(candidate.discussionCandidates);
    const isAnchoredDiscussionDiscoveryResult = options.responseKind === 'anchored_discussion_discovery'
      && candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      && Array.isArray(candidate.anchorResults);
    const isAnchoredActionDiscoveryResult = options.responseKind === 'anchored_action_discovery'
      && candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      && Array.isArray(candidate.actionResults);
    const isTopicArrangementResult = options.responseKind === 'topic_arrangement'
      && candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      && Array.isArray(candidate.groups);
    const isSemanticReconciliationResult = options.responseKind === 'semantic_reconciliation'
      && candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      && Array.isArray(candidate.decisions);
    const isTimingCheckResult = ['timing_check', 'decision_check', 'commitment_check', 'answered_check', 'correction_check'].includes(options.responseKind)
      && candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      && Array.isArray(candidate.results);
    if (meetingAgentHasTypedError(candidate) || isMinutesResult || isRefereeResult || isFlatDiscussionDiscoveryResult
      || isAnchoredDiscussionDiscoveryResult || isAnchoredActionDiscoveryResult
      || isTopicArrangementResult || isTimingCheckResult || isSemanticReconciliationResult) {
      structured = candidate;
      break;
    }
    if (typeof candidate === 'string') {
      const nested = parseJsonLenient(candidate);
      if (nested !== null) queue.push(nested); /* prose is rejected below */
    } else if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      for (const key of ['result', 'output', 'response', 'lastResponse', 'body', 'value']) {
        if (Object.prototype.hasOwnProperty.call(candidate, key)) queue.push(candidate[key]);
      }
    }
  }
  if (!structured) {
    const error = new Error('Power Automate returned an invalid meeting-minutes structure.');
    error.statusCode = 502;
    error.retryable = true;
    error.code = 'power_automate_invalid_structure';
    throw error;
  }
  const parsedResult = structured;
  // Direct generation/audit callers have no retry wrapper to raise this.
  // Preserve the existing referee hand-off (including its decoded audit),
  // but never let another caller normalise a provider failure as empty output.
  if (options.responseKind !== 'referee' && meetingAgentHasTypedError(parsedResult)) {
    throw meetingAgentResultError(parsedResult);
  }
  const flatDiscussionDiscovery = options.responseKind === 'discussion_discovery'
    && Array.isArray(parsedResult?.discussionCandidates);
  const anchoredDiscussionDiscovery = options.responseKind === 'anchored_discussion_discovery'
    && Array.isArray(parsedResult?.anchorResults);
  const anchoredActionDiscovery = options.responseKind === 'anchored_action_discovery'
    && Array.isArray(parsedResult?.actionResults);
  const topicArrangement = options.responseKind === 'topic_arrangement'
    && Array.isArray(parsedResult?.groups);
  const timingCheck = ['timing_check', 'decision_check', 'commitment_check', 'answered_check', 'correction_check'].includes(options.responseKind) && Array.isArray(parsedResult?.results);
  const semanticReconciliation = options.responseKind === 'semantic_reconciliation'
    && Array.isArray(parsedResult?.decisions);
  if (!parsedResult || typeof parsedResult !== 'object'
    || (options.responseKind !== 'referee'
      && !meetingAgentHasTypedError(parsedResult)
      && !timingCheck
      && !flatDiscussionDiscovery
      && !anchoredDiscussionDiscovery
      && !anchoredActionDiscovery
      && !topicArrangement
      && !semanticReconciliation
      && (!Array.isArray(parsedResult.discussion) || !Array.isArray(parsedResult.actions)))) {
    const error = new Error('Power Automate returned an invalid meeting-minutes structure.');
    error.statusCode = 502;
    error.retryable = true;
    error.code = 'power_automate_invalid_structure';
    throw error;
  }
  if (!options.deferValidationStatus && !meetingAgentHasTypedError(parsedResult)) {
    notifyMeetingAgentStatus(options, 'validated', parsedResult);
  }
  return parsedResult;
}

async function askPowerAutomateMeetingMinutesAgentWithRetry(prompt, options = {}) {
  const timings = [];
  let lastError;
  let accumulatedResult = null;
  const maxAttempts = Math.max(1, Math.min(MEETING_AGENT_RETRY_MS.length + 1, Number(options.maxAttempts || MEETING_AGENT_RETRY_MS.length + 1)));
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) {
      const delay = MEETING_AGENT_RETRY_MS[attempt - 1];
      const remaining = options.deadlineAt ? options.deadlineAt - Date.now() : Infinity;
      if (remaining <= delay + 1000) break;
      notifyMeetingAgentStatus(options, 'retrying');
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    const remaining = options.deadlineAt ? options.deadlineAt - Date.now() : Infinity;
    if (remaining <= 1000) break;
    const attemptPrompt = attempt > 0 && accumulatedResult && typeof options.repairPrompt === 'function'
      ? options.repairPrompt({ result: accumulatedResult, error: lastError, attempt: attempt + 1, originalPrompt: prompt })
      : prompt;
    const started = Date.now();
    const attemptInfo = {
      pass: options.pass || '', attempt: attempt + 1, maxAttempts,
      promptChars: String(attemptPrompt || '').length, repair: attemptPrompt !== prompt,
      startedAt: new Date().toISOString(),
      requestId: meetingMinutesAgentText(options.requestId, 160)
    };
    if (options.onAttempt) await options.onAttempt(attemptInfo).catch(() => {});
    let wireReply, rawReply, normalizedReply;
    try {
      const configuredAttemptTimeoutMs = Number(options.attemptTimeoutMs
        || process.env.POWER_AUTOMATE_AGENT_TIMEOUT_MS || 120000);
      const attemptTimeoutMs = Number.isFinite(remaining)
        ? Math.max(10000, Math.min(configuredAttemptTimeoutMs, remaining))
        : configuredAttemptTimeoutMs;
      const freshResult = await askPowerAutomateMeetingMinutesAgent(attemptPrompt, {
        paced: true, timeoutMs: attemptTimeoutMs, responseKind: options.responseKind, pass: options.pass,
        onStatus: options.onStatus, stage: options.stage, deferValidationStatus: true,
        ...(typeof options.onFailure === 'function' ? {
          onRawResponse: (body) => { wireReply = refereeFailureSnapshot(body); }
        } : {})
      });
      if (typeof options.onFailure === 'function') rawReply = refereeFailureSnapshot(freshResult);
      if (typeof options.onResult === 'function') await options.onResult(freshResult, attemptInfo);
      const transformedResult = typeof options.transformResult === 'function'
        ? options.transformResult(freshResult) : freshResult;
      const result = accumulatedResult && typeof options.combineResults === 'function'
        ? options.combineResults(accumulatedResult, transformedResult)
        : transformedResult;
      if (typeof options.onFailure === 'function') normalizedReply = refereeFailureSnapshot(result);
      const reportedError = meetingAgentResultError(result);
      if (reportedError) throw reportedError;
      const validationError = typeof options.validateResult === 'function' ? options.validateResult(result) : null;
      if (validationError) {
        if (typeof options.repairPrompt === 'function') accumulatedResult = result;
        throw validationError;
      }
      timings.push({ ...attemptInfo, elapsedMs: Date.now() - started, ok: true });
      notifyMeetingAgentStatus(options, 'validated', result);
      return { result, timings };
    } catch (error) {
      lastError = error;
      // Diagnostics are private and optional. Storage failure must never cause
      // another provider request or replace the original validation outcome.
      if (typeof options.onFailure === 'function') {
        try { await options.onFailure({ prompt: refereeFailureSnapshot(attemptPrompt),
          wireReply: wireReply || refereeFailureSnapshot(undefined),
          rawReply: rawReply || refereeFailureSnapshot(undefined),
          normalizedReply: normalizedReply || refereeFailureSnapshot(undefined), attemptInfo, error }); }
        catch { console.warn(JSON.stringify({ event: 'meeting_agent_referee_audit_unavailable',
          pass: options.pass || '', requestId: attemptInfo.requestId })); }
      }
      timings.push({
        ...attemptInfo, elapsedMs: Date.now() - started, ok: false,
        statusCode: Number(error.statusCode || 0) || undefined,
        upstreamStatus: Number(error.upstreamStatus || 0) || undefined,
        errorCode: meetingMinutesAgentText(error.code, 120) || undefined,
        errorMessage: meetingMinutesAgentText(error.message, 300) || undefined,
        failureClass: meetingAgentFailureClass(error) || undefined
      });
      if (!error.retryable || attempt === maxAttempts - 1) break;
    }
  }
  if (!lastError) {
    lastError = new Error('The meeting-minutes generation exceeded its stage time budget.');
    lastError.statusCode = 504;
    lastError.retryable = true;
  }
  if (lastError) lastError.callTimings = timings;
  throw lastError;
}

const MEETING_AGENT_RETRY_MS = [5000, 15000, 30000];

module.exports = {
  askPowerAutomateMeetingMinutesAgent,
  askPowerAutomateMeetingMinutesAgentWithRetry,
  meetingAgentFlowUrlFor,
  meetingAgentCallContext,
  parseJsonLenient,
  MEETING_AGENT_RETRY_MS
};
