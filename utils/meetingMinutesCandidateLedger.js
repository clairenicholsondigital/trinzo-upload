'use strict';

const crypto = require('crypto');
const actionDiagnostics = require('./meetingMinutesActionDiagnostics');
const { flattenHybridDiscussion } = require('./meetingMinutesDiscussionRows');
const { meetingMinutesAgentText } = require('./meetingMinutesPlainText');
const { meetingAgentCandidateTimingSignature } = require('./meetingMinutesRefereeCandidates');
const { groundedObjectiveRecords } = require('./meetingMinutesSummaryPublication');
const { meetingAgentTimingAnchor } = require('./meetingMinutesDraftContext');
const { normaliseAgentResult } = require('./meetingMinutesResultNormalization');
const { normaliseSourceUnits } = require('./meetingMinutesSource');
const { TIMING_INFERENCE_POLICY_VERSION } = require('./meetingMinutesActionTimingInference');
const { privateStagedCandidateCache, privateStagedCandidateCacheKey, prunePrivateStagedCandidateCache } = require('./meetingMinutesGenerationRuntime');

function hybridCandidateLedgerFromResult(result = {}, sourcePass = 'unknown') {
  const rows = [];
  for (const item of flattenHybridDiscussion(result.discussion)) {
    const discoveryDisposition = meetingMinutesAgentText(item.record?.discoveryDisposition, 40).toLowerCase();
    // Anchored discovery has already assessed every fixed evidence window. Keep
    // that signal when building the ensemble: otherwise a material `core` row
    // and secondary `supporting` context are both flattened to priority 5 and
    // compete equally for the finite Referee batch.
    const discoveryPriority = discoveryDisposition === 'core' ? 14
      : discoveryDisposition === 'supporting' ? 3 : 5;
    rows.push({
      candidateId: crypto.createHash('sha256').update(`${sourcePass}|${item.recordType}|${item.topic}|${item.record?.text || ''}`).digest('hex').slice(0, 20),
      sourcePass, recordType: item.recordType, topic: item.topic || 'Discussion',
      text: item.record?.text || '', evidenceIds: [...(item.record?.evidenceIds || [])], priority: discoveryPriority,
      ...(discoveryDisposition ? { dispositionHint: discoveryDisposition } : {}),
      record: structuredClone(item.record)
    });
  }
  for (const action of Array.isArray(result.actions) ? result.actions : []) {
    rows.push({
      candidateId: crypto.createHash('sha256').update(`${sourcePass}|action|${action.action || ''}|${(action.owners || []).join('|')}|${meetingAgentCandidateTimingSignature(action)}`).digest('hex').slice(0, 20),
      sourcePass, recordType: 'action', text: action.action || '', evidenceIds: [...(action.evidenceIds || [])], priority: 6,
      record: structuredClone(action)
    });
    actionDiagnostics.origin(sourcePass, [action], { kind: 'candidate_ledger', candidateId: rows.at(-1).candidateId });
  }
  for (const objective of Array.isArray(result.objectives) ? result.objectives : []) {
    rows.push({
      candidateId: crypto.createHash('sha256').update(`${sourcePass}|objective|${objective.text || objective}`).digest('hex').slice(0, 20),
      sourcePass, recordType: 'objective', text: objective.text || objective, evidenceIds: objective.evidenceIds || [], priority: 5,
      record: objective
    });
  }
  return rows.filter((row) => row.text);
}

function normaliseStagedCandidateResult(run, draft) {
  const stagedDiscussion = (run?.state?.discussion || []).map((topic) => ({
    topic: topic?.topic || 'Discussion',
    points: (topic?.points || []).map((item) => typeof item === 'string' ? { text: item } : item),
    decisions: (topic?.decisions || []).map((item) => typeof item === 'string' ? { text: item } : item),
    openQuestions: (topic?.openQuestions || []).map((item) => typeof item === 'string' ? { text: item } : item)
  }));
  const stagedActions = (run?.state?.actions || []).map((action) => ({
    action: action?.action || action?.meetingActionPoint || '',
    owners: [action?.owner || action?.meetingActionPointOwner || ''].filter((owner) => owner && owner !== 'Not stated'),
    timing: { kind: 'not_stated', wording: action?.deadline && action.deadline !== 'Not stated' ? action.deadline : '', exactDate: '' },
    evidenceIds: action?.evidenceIds || []
  }));
  const discussion = normaliseAgentResult({ discussion: stagedDiscussion }, draft.sourceUnits, 'discussion', {
    meetingDate: meetingAgentTimingAnchor(draft)
  });
  const actions = normaliseAgentResult({ actions: stagedActions }, draft.sourceUnits, 'actions', {
    meetingDate: meetingAgentTimingAnchor(draft)
  });
  const objectives = groundedObjectiveRecords(run?.state?.summary?.objectives || [], draft.sourceUnits);
  return { discussion: discussion.discussion, actions: actions.actions, objectives };
}

function stagedCandidateLedgerFromResult(result, draft) {
  // Stamp only freshly normalised actions. A persisted ledger may already
  // contain a date inferred under an older source-binding policy.
  return hybridCandidateLedgerFromResult(result, 'staged').map((candidate) =>
    candidate.recordType === 'action'
      ? { ...candidate, timingInferenceVersion: TIMING_INFERENCE_POLICY_VERSION,
        timingInferenceInputKey: privateStagedCandidateCacheKey(draft, 'actions') }
      : candidate);
}

function cachedStagedCandidatesForStage(draft, stage) {
  const types = stage === 'discussion'
    ? new Set(['discussion_point', 'decision', 'open_question', 'objective'])
    : new Set(['action']);
  const candidates = (draft.candidateLedger || []).filter((candidate) =>
    candidate.sourcePass === 'staged' && types.has(candidate.recordType));
  // Regenerate the entire action stage if any row is stale. Reusing just the
  // current subset would silently omit the remaining staged candidates.
  if (stage !== 'discussion' && candidates.some((candidate) =>
    candidate.timingInferenceVersion !== TIMING_INFERENCE_POLICY_VERSION
      || candidate.timingInferenceInputKey !== privateStagedCandidateCacheKey(draft, 'actions'))) return [];
  return candidates;
}

function peekReadyPrivateStagedCandidateLedger(draft, stage) {
  prunePrivateStagedCandidateCache();
  const entry = privateStagedCandidateCache.get(privateStagedCandidateCacheKey(draft, stage));
  if (!entry) return { status: 'absent', rows: [] };
  if (entry.status !== 'ready') return { status: 'pending', rows: [] };
  if (!Array.isArray(entry.value)) return { status: 'unavailable', rows: [] };
  if (entry.sourceHash !== crypto.createHash('sha256')
    .update(JSON.stringify(normaliseSourceUnits(draft.sourceUnits))).digest('hex')) return { status: 'stale', rows: [] };
  const rows = cachedStagedCandidatesForStage({ ...draft, candidateLedger: entry.value }, stage);
  if (rows.length !== entry.value.filter(row => row.sourcePass === 'staged'
    && (stage === 'actions' ? row.recordType === 'action'
      : ['discussion_point', 'decision', 'open_question', 'objective'].includes(row.recordType))).length) {
    return { status: 'stale', rows: [] };
  }
  // A completed extractor cannot mutate the ensemble after adjudication starts.
  return { status: 'ready', rows: structuredClone(rows) };
}

module.exports = {
  hybridCandidateLedgerFromResult,
  normaliseStagedCandidateResult,
  stagedCandidateLedgerFromResult,
  cachedStagedCandidatesForStage,
  peekReadyPrivateStagedCandidateLedger
};
