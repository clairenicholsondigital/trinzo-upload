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

const PROGRESS_STAGES = ['summary', 'discussion', 'actions'];
const PROGRESS_CODES = ['preparing', 'queued', 'request_sent', 'response_received',
  'validating', 'validated', 'retrying', 'extracting', 'checking', 'arranging', 'saving', 'failed'];

// Read-only Beta previews share the existing progress snapshot. Keep only
// display text; provider IDs, evidence, proposals and diagnostics stay private.
function normaliseMeetingAgentSectionPreview(stage, value) {
  if (!value || typeof value !== 'object') return null;
  const text = (input, limit = 1600) => typeof input === 'string' ? input.slice(0, limit) : '';
  const records = (items, limit = 80) => (Array.isArray(items) ? items : []).slice(0, limit)
    .map(item => ({ text: text(item?.text) })).filter(item => item.text.trim());
  if (stage === 'summary' && typeof value.executiveSummary === 'string' && Array.isArray(value.meetingObjectives)) {
    return { executiveSummary: text(value.executiveSummary, 4000), meetingObjectives: records(value.meetingObjectives, 4) };
  }
  if (stage === 'discussion' && Array.isArray(value.discussion)) {
    let remaining = 80;
    const discussion = value.discussion.slice(0, 30).map(topic => {
      const result = { topic: text(topic?.topic, 500),
        ...(typeof topic?.hideHeading === 'boolean' ? { hideHeading: topic.hideHeading } : {}) };
      for (const key of ['points', 'decisions', 'openQuestions']) {
        result[key] = records(topic?.[key], remaining);
        remaining -= result[key].length;
      }
      return result;
    }).filter(topic => topic.points.length || topic.decisions.length || topic.openQuestions.length);
    return { discussion };
  }
  if (stage === 'actions' && Array.isArray(value.actions)) {
    return { actions: value.actions.slice(0, 60).map(action => ({
      action: text(action?.action),
      owners: (Array.isArray(action?.owners) ? action.owners : []).slice(0, 12)
        .map(owner => text(owner, 180)).filter(owner => owner.trim()),
      timing: { kind: ['deadline', 'target', 'dependency', 'not_stated', 'stated'].includes(action?.timing?.kind)
        ? action.timing.kind : 'not_stated', wording: text(action?.timing?.wording, 600), exactDate: text(action?.timing?.exactDate, 20) }
    })).filter(action => action.action.trim()) };
  }
  return null;
}

function normaliseMeetingAgentProgress(value, { includePreviews = false } = {}) {
  if (!value || typeof value !== 'object' || !PROGRESS_CODES.includes(value.code)) return null;
  const date = (input) => typeof input === 'string' && Number.isFinite(Date.parse(input))
    ? new Date(input).toISOString() : '';
  const sections = {};
  for (const stage of PROGRESS_STAGES) {
    const section = value.sections?.[stage];
    if (!section || !PROGRESS_CODES.includes(section.code)) continue;
    const counts = {};
    for (const key of ['records', 'proposals', 'flags']) {
      if (Number.isFinite(section.counts?.[key])) counts[key] = Math.min(100000, Math.max(0, Math.floor(section.counts[key])));
    }
    const preview = includePreviews && section.code === 'validated'
      ? normaliseMeetingAgentSectionPreview(stage, section.preview) : null;
    sections[stage] = { code: section.code, updatedAt: date(section.updatedAt),
      ...(Object.keys(counts).length ? { counts } : {}), ...(preview ? { preview } : {}) };
  }
  return { code: value.code, updatedAt: date(value.updatedAt), sections };
}

// Preview projection is an explicit Beta-only opt-in; other callers retain metadata only.
function mergeMeetingAgentProgress(prior, event = {}, options = {}) {
  const progress = normaliseMeetingAgentProgress(prior, options);
  if (!PROGRESS_CODES.includes(event.code)) return progress;
  const updatedAt = new Date().toISOString();
  const sections = { ...(progress?.sections || {}) };
  if (PROGRESS_STAGES.includes(event.stage)) {
    sections[event.stage] = { code: event.code, updatedAt,
      ...(event.code === 'validated' && event.counts ? { counts: event.counts } : {}),
      ...(options.includePreviews && event.code === 'validated' && event.preview ? { preview: event.preview } : {}) };
  }
  return normaliseMeetingAgentProgress({ code: event.code, updatedAt, sections }, options);
}

function publicMeetingAgentProgress(draft = {}, generation = null, now = Date.now(), options = {}) {
  const parallel = draft.generationProvider === 'parallel-specialists-v1';
  const completed = PROGRESS_STAGES.map(stage => ({ ...draft.qualityState?.[stage], stage }))
    .filter(item => Number.isFinite(Date.parse(item.completedAt || '')))
    .sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt))[0];
  if (!generation && !completed) return null;
  const active = Boolean(generation);
  const failed = generation?.status === 'failed';
  const interrupted = failed && draft.generation?.status === 'running';
  const includePreviews = options.includePreviews === true && parallel && generation?.status === 'running'
    && Number.isFinite(Date.parse(generation.startedAt)) && now - Date.parse(generation.startedAt) <= 240000;
  const progress = normaliseMeetingAgentProgress(generation?.progress, { includePreviews });
  const healthyPreviews = includePreviews && !Object.values(progress?.sections || {}).some(section => section.code === 'failed');
  const stage = parallel ? 'all' : PROGRESS_STAGES.includes(generation?.stage) ? generation.stage : completed?.stage || 'discussion';
  const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : '';
  const parallelStartedAt = parallel && !active ? PROGRESS_STAGES
    .map(key => timestamp(draft.qualityState?.parallel?.branches?.[key]?.startedAt)).filter(Boolean).sort()[0] : '';
  const startedAt = timestamp(active ? generation.startedAt : parallelStartedAt || completed.backgroundStartedAt);
  const updatedAt = active ? progress?.updatedAt || startedAt : timestamp(completed.completedAt);
  const elapsedMs = Number.isFinite(Date.parse(startedAt))
    ? Math.max(0, (active ? now : Date.parse(updatedAt)) - Date.parse(startedAt)) : 0;
  const fallback = /referee|check/.test(generation?.pass || '') ? 'checking'
    : generation?.pass === 'topic-arranger' ? 'arranging'
    : /primary|recovery/.test(generation?.pass || '') ? 'extracting' : 'preparing';
  const code = !active ? 'ready' : failed ? (interrupted ? 'interrupted' : 'failed') : progress?.code || fallback;
  const subject = parallel ? 'meeting minutes' : stage || 'meeting minutes';
  const messages = {
    preparing: 'Preparing the ' + subject + ' request.',
    queued: 'Waiting for an available processing slot.',
    request_sent: 'Waiting for the ' + subject + ' response from Microsoft.',
    response_received: 'Received the ' + subject + ' response.',
    validating: 'Checking the response structure and source references.',
    validated: 'The response has passed its checks.',
    retrying: 'Waiting to retry a temporary service failure.',
    extracting: 'Finding the main ' + subject + ' content.',
    checking: 'Checking the ' + subject + ' evidence.',
    arranging: 'Arranging related discussion topics.',
    saving: 'Saving the generated draft.',
    failed: 'Generation did not complete. Your saved content has been kept.',
    interrupted: 'Generation was interrupted. Start generation again to continue.',
    ready: parallel ? 'The draft is saved and ready to review.' : 'The generated section is saved and ready to review.'
  };
  const sections = {};
  for (const sectionStage of PROGRESS_STAGES) {
    const savedAt = timestamp(draft.qualityState?.[sectionStage]?.completedAt);
    if (!active && savedAt) { sections[sectionStage] = { state: 'saved', updatedAt: savedAt }; continue; }
    const section = progress?.sections[sectionStage];
    if (!section) continue;
    const state = section.code === 'validated' ? 'validated' : section.code === 'failed' ? 'failed'
      : ['response_received', 'validating'].includes(section.code) ? 'received'
      : ['preparing', 'queued', 'retrying'].includes(section.code) ? 'waiting' : 'running';
    sections[sectionStage] = { state, updatedAt: section.updatedAt,
      ...(section.counts ? { counts: section.counts } : {}),
      ...(healthyPreviews && section.preview ? { preview: section.preview } : {}) };
  }
  let message = messages[code];
  if (parallel && active && !failed && code !== 'saving') {
    const checked = PROGRESS_STAGES.filter(key => sections[key]?.state === 'validated');
    const pending = PROGRESS_STAGES.filter(key => !['validated', 'failed'].includes(sections[key]?.state));
    const unsuccessful = PROGRESS_STAGES.filter(key => sections[key]?.state === 'failed');
    if (unsuccessful.length) message = 'A section could not complete. Waiting for the remaining requests to finish.';
    else if (checked.length === 3) message = 'All three responses checked. Preparing to save the draft.';
    else if (checked.length) message = checked.join(' and ') + ' received and checked. Still waiting for ' + pending.join(' and ') + '.';
  }
  return { status: !active ? 'ready' : failed ? 'failed' : 'running', code, message, stage,
    startedAt, updatedAt, elapsedMs, sections };
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
    previewUpdatedAt: meetingMinutesAgentText(generation.previewUpdatedAt, 40),
    ...(normaliseMeetingAgentProgress(generation.progress) ? { progress: normaliseMeetingAgentProgress(generation.progress) } : {})
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
  normaliseMeetingAgentSectionPreview,
  normaliseMeetingAgentProgress,
  mergeMeetingAgentProgress,
  publicMeetingAgentProgress,
  normaliseMeetingAgentExecutionTelemetry,
  meetingAgentFailureClass,
  meetingAgentResultCounts,
  meetingAgentMaterialPassImpact,
  annotateMeetingAgentPassImpact,
  meetingAgentCallPerformance,
  meetingAgentExecutionTelemetry
};
