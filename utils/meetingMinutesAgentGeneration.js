'use strict';

const { meetingMinutesAgentText } = require('./meetingMinutesPlainText');
const { normaliseSemanticPolicy } = require('./meetingMinutesSemanticPolicy');
const { normaliseDiscussionCoveragePolicy } = require('./meetingMinutesDiscussionCoveragePolicy');

// A generation is only ever run by the process that started it, so a record from
// another boot is dead by definition. The time check catches the rarer case of an
// unhandled rejection inside this same process. Both are evaluated at READ time -
// there is no sweeper, and a stale record self-heals on the next save.
function meetingAgentGenerationState(generation, { bootId, hybridEnabled }) {
  if (!generation || generation.status !== 'running') return generation || null;
  const timeoutMs = hybridEnabled
    // Discussion has a bounded core stage plus a separately bounded final
    // topic-arrangement pass. Do not report a healthy slow arranger as an
    // interrupted workflow while that dedicated allowance is still active.
    ? Math.max(300000, Number(process.env.MEETING_MINUTES_AGENT_WORKFLOW_TIMEOUT_MS || 720000))
    : Math.max(10000, Number(process.env.POWER_AUTOMATE_AGENT_TIMEOUT_MS || 120000)) + 60000;
  const orphaned = generation.bootId !== bootId;
  const expired = Date.now() - Number(new Date(generation.startedAt || 0)) > timeoutMs;
  if (!orphaned && !expired) return generation;
  return { ...generation, status: 'failed', error: 'Generation was interrupted. Generate it again.' };
}

function meetingAgentPassTimingPolicy(callOptions = {}, isRefereeCall = false, stageDeadlineAt = 0, now = Date.now()) {
  const independentBudgetMs = Math.max(0, Number(callOptions.independentBudgetMs || 0));
  const deadlineAt = independentBudgetMs
    ? Number(now) + Math.max(10000, independentBudgetMs)
    : Number(stageDeadlineAt || 0);
  const attemptTimeoutMs = Number(callOptions.attemptTimeoutMs
    || (isRefereeCall ? process.env.MEETING_MINUTES_AGENT_REFEREE_TIMEOUT_MS || 90000 : 0)) || undefined;
  return { deadlineAt, attemptTimeoutMs };
}

function normaliseMeetingAgentGeneration(generation, stageSteps) {
  if (!generation || typeof generation !== 'object') return null;
  const status = ['running', 'failed'].includes(generation.status) ? generation.status : null;
  if (!status) return null;
  return {
    stage: Object.hasOwn(stageSteps, generation.stage) ? generation.stage : 'discussion',
    status,
    bootId: meetingMinutesAgentText(generation.bootId, 80),
    semanticPolicy: normaliseSemanticPolicy(generation.semanticPolicy),
    discussionCoveragePolicy: normaliseDiscussionCoveragePolicy(generation.discussionCoveragePolicy),
    startedAt: meetingMinutesAgentText(generation.startedAt, 40),
    error: meetingMinutesAgentText(generation.error, 400),
    pass: meetingMinutesAgentText(generation.pass, 80),
    message: meetingMinutesAgentText(generation.message, 240),
    completedPasses: (Array.isArray(generation.completedPasses) ? generation.completedPasses : []).map((value) => meetingMinutesAgentText(value, 80)).filter(Boolean).slice(-12),
    callTimings: (Array.isArray(generation.callTimings) ? generation.callTimings : []).slice(-60),
    telemetry: normaliseMeetingAgentExecutionTelemetry(generation.telemetry),
    degradedSources: (Array.isArray(generation.degradedSources) ? generation.degradedSources : []).map((value) => meetingMinutesAgentText(value, 160)).filter(Boolean).slice(-8),
    previewActions: (Array.isArray(generation.previewActions) ? generation.previewActions : []).map((item, index) => ({
      id: meetingMinutesAgentText(item?.id, 80) || `preview-action-${index + 1}`,
      action: meetingMinutesAgentText(item?.action, 1600),
      owners: (Array.isArray(item?.owners) ? item.owners : []).map((owner) => meetingMinutesAgentText(owner, 180)).filter(Boolean).slice(0, 12),
      timing: {
        kind: ['deadline', 'target', 'dependency', 'not_stated'].includes(item?.timing?.kind) ? item.timing.kind : 'not_stated',
        wording: meetingMinutesAgentText(item?.timing?.wording, 220),
        exactDate: meetingMinutesAgentText(item?.timing?.exactDate, 20)
      },
      evidenceIds: (Array.isArray(item?.evidenceIds) ? item.evidenceIds : []).map((id) => meetingMinutesAgentText(id, 30)).filter(Boolean).slice(0, 12),
      reviewFlagIds: []
    })).filter((item) => item.action).slice(0, 60),
    ...(Array.isArray(generation.previewSavedActions) ? { previewSavedActions: generation.previewSavedActions.map((item, index) => ({
      id: meetingMinutesAgentText(item?.id, 80) || `saved-action-${index + 1}`,
      action: meetingMinutesAgentText(item?.action, 1600),
      owners: (Array.isArray(item?.owners) ? item.owners : []).map((owner) => meetingMinutesAgentText(owner, 180)).filter(Boolean).slice(0, 12),
      timing: {
        kind: ['deadline', 'target', 'dependency', 'not_stated'].includes(item?.timing?.kind) ? item.timing.kind : 'not_stated',
        wording: meetingMinutesAgentText(item?.timing?.wording, 220),
        exactDate: meetingMinutesAgentText(item?.timing?.exactDate, 20)
      },
      evidenceIds: (Array.isArray(item?.evidenceIds) ? item.evidenceIds : []).map((id) => meetingMinutesAgentText(id, 30)).filter(Boolean).slice(0, 12),
      reviewFlagIds: []
    })).filter((item) => item.action).slice(0, 60) } : {}),
    previewUpdatedAt: meetingMinutesAgentText(generation.previewUpdatedAt, 40)
  };
}

function normaliseMeetingAgentExecutionTelemetry(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const number = (key) => Math.max(0, Number(source[key] || 0));
  return {
    qualityPassCount: number('qualityPassCount'),
    externalCallCount: number('externalCallCount'),
    firstAttemptSuccessCount: number('firstAttemptSuccessCount'),
    retryCount: number('retryCount'),
    repairCallCount: number('repairCallCount'),
    failedCallCount: number('failedCallCount'),
    validationFailureCount: number('validationFailureCount'),
    transportFailureCount: number('transportFailureCount'),
    totalPromptChars: number('totalPromptChars'),
    retryPromptChars: number('retryPromptChars'),
    externalCallElapsedMs: number('externalCallElapsedMs'),
    candidateCount: number('candidateCount'),
    outputRecordCount: number('outputRecordCount'),
    outputChars: number('outputChars'),
    materialContributionCount: number('materialContributionCount')
  };
}

function meetingAgentFailureClass(value = {}) {
  const code = meetingMinutesAgentText(value?.errorCode || value?.code, 120).toLowerCase();
  const status = Number(value?.upstreamStatus || value?.statusCode || 0);
  if (code === 'unmaterialized_referee_action' || code === 'invalid_referee_target'
    || /(?:invalid|incomplete|unexpected|missing).*(?:structure|contract|disposition|candidate|response)|empty_(?:discussion|action)/.test(code)) {
    return 'response_contract';
  }
  if (status === 429 || /(?:rate|usage|thrott)/.test(code)) return 'rate_limit';
  if (status >= 500 || /(?:timeout|system|transport|network|no_?response|child|handoff)/.test(code)) return 'transport';
  return code ? 'other' : '';
}

function meetingAgentResultCounts(result = {}) {
  const discussion = Array.isArray(result?.discussion) ? result.discussion : [];
  const discussionRecords = discussion.reduce((sum, topic) => sum
    + (Array.isArray(topic?.points) ? topic.points.length : 0)
    + (Array.isArray(topic?.decisions) ? topic.decisions.length : 0)
    + (Array.isArray(topic?.openQuestions) ? topic.openQuestions.length : 0), 0);
  const actions = Array.isArray(result?.actions) ? result.actions.length : 0;
  const proposals = Array.isArray(result?.actionProposals) ? result.actionProposals.length : 0;
  const dispositions = Array.isArray(result?.candidateDispositions) ? result.candidateDispositions.length : 0;
  return {
    discussionRecordCount: discussionRecords,
    actionCount: actions,
    proposalCount: proposals,
    dispositionCount: dispositions,
    reviewFlagCount: Array.isArray(result?.reviewFlags) ? result.reviewFlags.length : 0,
    outputRecordCount: discussionRecords + actions + proposals,
    outputChars: JSON.stringify(result && typeof result === 'object' ? result : {}).length
  };
}

function meetingAgentMaterialPassImpact(candidateDispositions = [], overrides = {}) {
  const impact = {};
  for (const item of Array.isArray(candidateDispositions) ? candidateDispositions : []) {
    const pass = meetingMinutesAgentText(item?.sourcePass, 80) || 'unknown';
    if (!impact[pass]) impact[pass] = {
      candidateCount: 0, publishedCount: 0, proposalCount: 0,
      supportingCount: 0, materiallyChangedFinalMinutes: false
    };
    impact[pass].candidateCount += 1;
    if (item?.disposition === 'publish') impact[pass].publishedCount += 1;
    if (item?.disposition === 'proposal') impact[pass].proposalCount += 1;
    if (item?.disposition === 'supporting') impact[pass].supportingCount += 1;
    if (['publish', 'proposal', 'supporting'].includes(item?.disposition) && item?.candidateId) {
      if (!Array.isArray(impact[pass].materialCandidateIds)) impact[pass].materialCandidateIds = [];
      impact[pass].materialCandidateIds.push(meetingMinutesAgentText(item.candidateId, 160));
    }
  }
  for (const [pass, supplied] of Object.entries(overrides || {})) {
    impact[pass] = { ...(impact[pass] || {}), ...(supplied || {}) };
  }
  for (const value of Object.values(impact)) {
    value.materialContributionCount = Math.max(0, Number(value.materialContributionCount
      ?? ((value.publishedCount || 0) + (value.proposalCount || 0) + (value.supportingCount || 0))));
    value.materiallyChangedFinalMinutes = value.materialContributionCount > 0;
  }
  return impact;
}

function annotateMeetingAgentPassImpact(provenance = [], impact = {}) {
  const counted = new Set();
  return (Array.isArray(provenance) ? provenance : []).map((item) => {
    const logicalPass = /^referee-/.test(item?.pass || '') ? 'referee' : item?.pass;
    const passImpact = impact[logicalPass] || {};
    const materialCandidateIds = new Set(Array.isArray(passImpact.materialCandidateIds)
      ? passImpact.materialCandidateIds : []);
    const callCandidateIds = Array.isArray(item?.candidateIds) ? item.candidateIds : [];
    const candidateContributionCount = callCandidateIds.filter((candidateId) =>
      materialCandidateIds.has(candidateId)).length;
    const firstLogicalCall = !counted.has(logicalPass);
    counted.add(logicalPass);
    const contributionCount = item?.failed === true ? 0
      : logicalPass === 'referee' && callCandidateIds.length
        ? candidateContributionCount
        : firstLogicalCall
          ? Math.max(0, Number(passImpact.materialContributionCount || 0)) : 0;
    return {
      ...item,
      materialContributionCount: contributionCount,
      materiallyChangedFinalMinutes: contributionCount > 0
    };
  });
}

function meetingAgentCallPerformance(provenance = []) {
  return (Array.isArray(provenance) ? provenance : []).map((item) => ({
    stage: item?.stage || '',
    pass: item?.pass || '',
    requestId: meetingMinutesAgentText(item?.requestId, 160),
    cached: item?.cached === true,
    failed: item?.failed === true,
    candidateCount: Math.max(0, Number(item?.candidateCount || 0)),
    outputRecordCount: Math.max(0, Number(item?.outputRecordCount || 0)),
    outputChars: Math.max(0, Number(item?.outputChars || 0)),
    attemptCount: Array.isArray(item?.timings) ? item.timings.length : 0,
    elapsedMs: Math.max(0, Number(item?.elapsedMs || 0)),
    materialContributionCount: Math.max(0, Number(item?.materialContributionCount || 0)),
    materiallyChangedFinalMinutes: item?.materiallyChangedFinalMinutes === true
  }));
}

function meetingAgentExecutionTelemetry(provenance = []) {
  const passes = Array.isArray(provenance) ? provenance : [];
  const timings = passes.flatMap((item) => Array.isArray(item?.timings) ? item.timings : []);
  const byPass = new Map();
  for (const timing of timings) {
    const pass = meetingMinutesAgentText(timing?.pass, 120) || 'unknown';
    if (!byPass.has(pass)) byPass.set(pass, []);
    byPass.get(pass).push(timing);
  }
  let retryCount = 0;
  let firstAttemptSuccessCount = 0;
  for (const rows of byPass.values()) {
    const ordered = [...rows].sort((left, right) => Number(left?.attempt || 1) - Number(right?.attempt || 1));
    retryCount += ordered.filter((item) => Number(item?.attempt || 1) > 1).length;
    if (ordered[0]?.ok === true) firstAttemptSuccessCount += 1;
  }
  return {
    qualityPassCount: new Set(passes.map((item) => `${item?.stage || ''}:${item?.pass || ''}`)
      .filter((key) => key !== ':')).size,
    externalCallCount: timings.length,
    firstAttemptSuccessCount,
    retryCount,
    repairCallCount: timings.filter((item) => item?.repair === true
      || /(?:^|:)referee-repair-/.test(String(item?.pass || ''))).length,
    failedCallCount: timings.filter((item) => item?.ok === false).length,
    validationFailureCount: timings.filter((item) => meetingAgentFailureClass(item) === 'response_contract').length,
    transportFailureCount: timings.filter((item) => meetingAgentFailureClass(item) === 'transport').length,
    totalPromptChars: timings.reduce((sum, item) => sum + Math.max(0, Number(item?.promptChars || 0)), 0),
    retryPromptChars: timings.filter((item) => Number(item?.attempt || 1) > 1)
      .reduce((sum, item) => sum + Math.max(0, Number(item?.promptChars || 0)), 0),
    externalCallElapsedMs: timings.reduce((sum, item) => sum + Math.max(0, Number(item?.elapsedMs || 0)), 0),
    candidateCount: passes.reduce((sum, item) => sum + Math.max(0, Number(item?.candidateCount || 0)), 0),
    outputRecordCount: passes.reduce((sum, item) => sum + Math.max(0, Number(item?.outputRecordCount || 0)), 0),
    outputChars: passes.reduce((sum, item) => sum + Math.max(0, Number(item?.outputChars || 0)), 0),
    materialContributionCount: passes.reduce((sum, item) => sum + Math.max(0, Number(item?.materialContributionCount || 0)), 0)
  };
}

module.exports = {
  meetingAgentGenerationState,
  meetingAgentPassTimingPolicy,
  normaliseMeetingAgentGeneration,
  normaliseMeetingAgentExecutionTelemetry,
  meetingAgentFailureClass,
  meetingAgentResultCounts,
  meetingAgentMaterialPassImpact,
  annotateMeetingAgentPassImpact,
  meetingAgentCallPerformance,
  meetingAgentExecutionTelemetry
};
