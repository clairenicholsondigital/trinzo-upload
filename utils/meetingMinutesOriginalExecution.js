'use strict';

const { meetingAgentTimingAnchor, meetingAgentPromptDetails } = require('./meetingMinutesDraftContext');
const { meetingAgentPassCacheKey, meetingMinutesAgentReplayPassCacheEnabled } = require('./meetingMinutesPassCache');
const { meetingAgentResultError, meetingAgentRefereeRoute } = require('./meetingMinutesResponseContracts');

const actionDiagnostics = require("./meetingMinutesActionDiagnostics");
const { appendRefereeFailureAudit } = require("./meetingMinutesRefereeFailureAudit");
const crypto = require("crypto");
const { meetingAgentExecutionTelemetry } = require("./meetingMinutesAgentGeneration");
const { meetingAgentFailureClass } = require("./meetingMinutesAgentGeneration");
const { meetingAgentPassTimingPolicy } = require("./meetingMinutesAgentGeneration");
const { meetingAgentResultCounts } = require("./meetingMinutesAgentGeneration");
const { meetingMinutesAgentText } = require("./meetingMinutesPlainText");
const { normaliseMeetingAgentPassCache } = require("./meetingMinutesPassCache");
const { refereeFailureSnapshot } = require("./meetingMinutesRefereeFailureAudit");

function createOriginalExecution(services) {
  const { askPowerAutomateMeetingMinutesAgentWithRetry } = require('./meetingMinutesAgentTransport');
  const {
    usePrivateActionPrimaryPrewarm,
  } = services;

  return function createOriginalExecutionContext(draft, stage, options = {}) {
  const transcript = String(draft.preparedTranscript || '').trim();
  const details = meetingAgentPromptDetails(draft);
  const timingAnchor = meetingAgentTimingAnchor(draft);
  const salientDetails = draft.salientDetails || [];
  const passProvenance = [];
  const completedPasses = [];
  const degradedSources = [];
  const execution = {};
  execution.passCache = normaliseMeetingAgentPassCache(draft.passCache);
  execution.refereeFailureAudit = draft.qualityState?.[stage]?.refereeFailureAudit;
  const refereeAuditRunId = crypto.randomUUID();
  const stageStartedAt = Date.now();
  execution.stageDeadlineAt = stageStartedAt + Math.max(180000, Number(process.env.MEETING_MINUTES_AGENT_STAGE_TIMEOUT_MS || 360000));
  const progress = async (pass, message, activeTimings = []) => {
    const progressProvenance = [
      ...passProvenance,
      ...(activeTimings.length ? [{ stage, pass, timings: activeTimings }] : [])
    ];
    if (options.onProgress) await options.onProgress({
      pass, message, completedPasses,
      callTimings: [...passProvenance.flatMap((item) => item.timings || []), ...activeTimings],
      telemetry: meetingAgentExecutionTelemetry(progressProvenance), degradedSources
    });
  };
  const call = (pass, prompt, callOptions = {}) => actionDiagnostics.scoped(pass, () => callRaw(pass, prompt, callOptions));
  const callRaw = async (pass, prompt, callOptions = {}) => {
    const isRefereeCall = callOptions.responseKind === 'referee' || pass === 'referee' || pass.startsWith('referee-');
    const baseMessage = pass === 'primary' || pass === 'primary-2' ? 'Finding the main points…' : pass === 'recovery' ? `Recovering missed ${stage}…` : pass === 'topic-arranger' ? 'Arranging related discussion topics…' : isRefereeCall ? `Checking ${stage} evidence…` : 'Verifying the draft…';
    const promptSha256 = meetingAgentPassCacheKey(prompt);
    const requestId = meetingMinutesAgentText(callOptions.requestId, 160)
      || `${stage}:${pass}:${promptSha256.slice(0, 16)}`;
    const candidateCount = Math.max(0, Number(callOptions.candidateCount || 0));
    const candidateIds = Array.isArray(callOptions.candidateIds)
      ? callOptions.candidateIds.map((candidateId) => meetingMinutesAgentText(candidateId, 160)).filter(Boolean)
      : [];
    const exact = execution.passCache.find((entry) => entry.stage === stage && entry.pass === pass
      && entry.promptSha256 === promptSha256);
    // Offline replay (harness only): serve a pass by name when its prompt no
    // longer hashes the same, so the assembly after the model calls can be
    // re-run from a stored draft without calling the flow. Never on live.
    const replayed = !exact && meetingMinutesAgentReplayPassCacheEnabled()
      ? execution.passCache.find((entry) => entry.stage === stage && entry.pass === pass) : null;
    const cached = exact || replayed;
    if (cached) {
      const reportedError = meetingAgentResultError(cached.result);
      const validationError = !replayed && typeof callOptions.validateResult === 'function'
        ? callOptions.validateResult(cached.result) : null;
      if (!reportedError && !validationError) {
        const resultCounts = meetingAgentResultCounts(cached.result);
        completedPasses.push(pass);
        passProvenance.push({
          stage, pass, completedAt: cached.completedAt || new Date().toISOString(),
          requestId, promptChars: String(prompt || '').length, elapsedMs: 0, timings: [], cached: true,
          candidateCount, candidateIds, ...resultCounts,
          ...(isRefereeCall ? {
            refereeRoute: meetingAgentRefereeRoute(cached.result, callOptions.refereeContract || {})
          } : {})
        });
        await progress(pass, `${baseMessage.replace(/…$/, '')} — using saved result…`);
        actionDiagnostics.origin(pass, cached.result.actions || [], { cached: true, replayed: Boolean(replayed) });
        return cached.result;
      }
      execution.passCache = execution.passCache.filter((entry) => entry !== cached);
    }
    if (stage === 'actions' && pass === 'primary') {
      await progress(pass, 'Using the action search prepared during Discussion review…');
      const joinedAt = Date.now();
      const prewarmed = await usePrivateActionPrimaryPrewarm(draft, prompt);
      const prewarmValidationError = prewarmed && typeof callOptions.validateResult === 'function'
        ? callOptions.validateResult(prewarmed.result) : null;
      if (prewarmed && !meetingAgentResultError(prewarmed.result) && !prewarmValidationError) {
        const resultCounts = meetingAgentResultCounts(prewarmed.result);
        completedPasses.push(pass);
        passProvenance.push({
          stage, pass, requestId: prewarmed.requestId || requestId,
          completedAt: prewarmed.completedAt || new Date().toISOString(),
          promptChars: String(prompt || '').length,
          elapsedMs: Date.now() - joinedAt,
          timings: prewarmed.timings || [], cached: true, prewarmed: true,
          candidateCount, candidateIds, ...resultCounts
        });
        execution.passCache = normaliseMeetingAgentPassCache([
          ...execution.passCache.filter((entry) => !(entry.stage === stage && entry.pass === pass)),
          { stage, pass, promptSha256, completedAt: prewarmed.completedAt || new Date().toISOString(), result: prewarmed.result }
        ]);
        if (options.onCheckpoint) await options.onCheckpoint(execution.passCache);
        console.info(JSON.stringify({
          event: 'meeting_agent_pass', journeyId: draft.draftId || '', stage, pass,
          requestId: prewarmed.requestId || requestId, promptChars: String(prompt || '').length,
          candidateCount, ...resultCounts, attempts: (prewarmed.timings || []).length,
          elapsedMs: Date.now() - joinedAt, prewarmed: true, ok: true
        }));
        actionDiagnostics.origin(pass, prewarmed.result.actions || [], { cached: true, prewarmed: true });
        return prewarmed.result;
      }
    }
    await progress(pass, baseMessage);
    // A connected-agent referee can transiently return the parent's contract error
    // while Copilot Studio is still completing the child hand-off. Use the complete
    // retry ladder for this pass; successful first responses still make one call.
    const maxAttempts = Math.max(1, Number(callOptions.maxAttempts
      || (isRefereeCall ? 2 : pass === 'primary' ? 3 : 2)));
    const timingPolicy = meetingAgentPassTimingPolicy(callOptions, isRefereeCall, execution.stageDeadlineAt);
    try {
      const response = await askPowerAutomateMeetingMinutesAgentWithRetry(prompt, {
        pass: `${stage}:${pass}`, maxAttempts, deadlineAt: timingPolicy.deadlineAt,
        requestId,
        // Referee calls have repeatedly completed just beyond the former
        // 65-second boundary. Give the structured tool enough time to return
        // instead of turning valid in-flight work into a duplicate request.
        attemptTimeoutMs: timingPolicy.attemptTimeoutMs,
        responseKind: callOptions.responseKind,
        transformResult: callOptions.transformResult,
        validateResult: callOptions.validateResult,
        repairPrompt: callOptions.repairPrompt,
        combineResults: callOptions.combineResults,
        ...(isRefereeCall ? { onFailure: async ({ prompt: exactPrompt, wireReply, rawReply, normalizedReply, attemptInfo, error }) => {
          execution.refereeFailureAudit = appendRefereeFailureAudit(execution.refereeFailureAudit, {
            runId: refereeAuditRunId, stage, pass, requestId, attempt: attemptInfo.attempt,
            prompt: exactPrompt, wireReply, rawReply, normalizedReply,
            contract: refereeFailureSnapshot(callOptions.refereeContract || {}),
            validation: { code: meetingMinutesAgentText(error.code, 120),
              invalidCandidateIds: (error.invalidCandidateIds || []).slice(0, 120),
              missingCandidateIds: (error.missingCandidateIds || []).slice(0, 120) }
          });
          if (options.onRefereeFailure) await options.onRefereeFailure(execution.refereeFailureAudit);
        } } : {}),
        onAttempt: (attempt) => progress(pass,
          // Retry counts are our plumbing, not the reviewer's business: they
          // only need to know it is still going.
          attempt.attempt > 1 ? `${baseMessage.replace(/…$/, '')} — still working…` : baseMessage,
          [{ ...attempt, ok: null }])
      });
      const resultCounts = meetingAgentResultCounts(response.result);
      completedPasses.push(pass);
      passProvenance.push({
        stage, pass, requestId, completedAt: new Date().toISOString(), promptChars: String(prompt || '').length,
        elapsedMs: response.timings.reduce((sum, item) => sum + Number(item.elapsedMs || 0), 0), timings: response.timings,
        candidateCount, candidateIds, ...resultCounts,
        ...(isRefereeCall ? {
          refereeRoute: meetingAgentRefereeRoute(response.result, callOptions.refereeContract || {})
        } : {})
      });
      console.info(JSON.stringify({
        event: 'meeting_agent_pass', journeyId: draft.draftId || '', stage, pass, requestId,
        promptChars: String(prompt || '').length, candidateCount, ...resultCounts,
        attempts: response.timings.length, elapsedMs: passProvenance.at(-1).elapsedMs, ok: true
      }));
      execution.passCache = normaliseMeetingAgentPassCache([
        ...execution.passCache.filter((entry) => !(entry.stage === stage && entry.pass === pass)),
        { stage, pass, promptSha256, completedAt: new Date().toISOString(), result: response.result }
      ]);
      if (options.onCheckpoint) await options.onCheckpoint(execution.passCache);
      actionDiagnostics.origin(pass, response.result.actions || [], { requestId });
      return response.result;
    } catch (error) {
      const failedTimings = Array.isArray(error.callTimings) ? error.callTimings : [];
      passProvenance.push({
        stage, pass, requestId, completedAt: new Date().toISOString(), promptChars: String(prompt || '').length,
        elapsedMs: failedTimings.reduce((sum, item) => sum + Number(item.elapsedMs || 0), 0),
        timings: failedTimings, failed: true, candidateCount, candidateIds,
        failureClass: meetingAgentFailureClass(error),
        errorCode: meetingMinutesAgentText(error.code, 120),
        errorMessage: meetingMinutesAgentText(error.message, 300)
      });
      console.warn(JSON.stringify({
        event: 'meeting_agent_pass', journeyId: draft.draftId || '', stage, pass, requestId,
        promptChars: String(prompt || '').length, candidateCount,
        attempts: error.callTimings?.length || 0,
        elapsedMs: (error.callTimings || []).reduce((sum, item) => sum + Number(item.elapsedMs || 0), 0), ok: false,
        statusCode: Number(error.statusCode || 0) || undefined,
        upstreamStatus: Number(error.upstreamStatus || 0) || undefined,
        errorCode: meetingMinutesAgentText(error.code, 120) || undefined,
        errorMessage: meetingMinutesAgentText(error.message, 300) || undefined,
        failureClass: meetingAgentFailureClass(error) || undefined,
        invalidCandidateIds: Array.isArray(error.invalidCandidateIds) ? error.invalidCandidateIds.slice(0, 20) : undefined,
        invalidReasons: Array.isArray(error.invalidReasons) ? error.invalidReasons.slice(0, 20) : undefined,
        callTimings: error.callTimings || []
      }));
      actionDiagnostics.event('provider_failed', [], [], { stage, failedPass: pass, code: String(error.code || 'provider_failure') });
      if (typeof callOptions.captureError === 'function') callOptions.captureError(error);
      if (!callOptions.optional) throw error;
      if (callOptions.silentOptionalFailure !== true) {
        degradedSources.push(`The optional ${pass} quality pass did not complete: ${error.message}`);
      }
      return null;
    }
  };

    return {
      draft,
      stage,
      options,
      execution,
      transcript,
      details,
      timingAnchor,
      salientDetails,
      passProvenance,
      completedPasses,
      degradedSources,
      stageStartedAt,
      call,
    };
  };
}

module.exports = { createOriginalExecution };
