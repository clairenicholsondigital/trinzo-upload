'use strict';

const { flattenHybridDiscussion } = require('./meetingMinutesDiscussionRows');
const { meetingMinutesAgentText } = require('./meetingMinutesPlainText');
const { normaliseSourceUnits } = require('./meetingMinutesSource');
const { normaliseFlag: normaliseMeetingAgentFlag } = require('./meetingMinutesReviewFlags');
const crypto = require('crypto');

function meetingAgentResultError(result) {
  const reported = result?.error;
  if (!reported) return null;
  const code = meetingMinutesAgentText(
    typeof reported === 'object' ? reported.code : '', 120
  ) || 'agent_error';
  const message = meetingMinutesAgentText(
    typeof reported === 'object' ? reported.message : reported, 500
  ) || 'The connected meeting-minutes agent returned an error.';
  const error = new Error(message);
  error.code = code;
  error.statusCode = 502;
  error.retryable = /(?:system|timeout|noresponse|no_response|invalid_.+_structure|missing_candidate_dispositions|child|handoff)/i.test(code)
    // The route explicitly reports a transient hand-off failure. Keep this
    // bounded exception separate from semantic/validation retry hints.
    || (code === 'microsoft_route_failure' && reported?.retryable === true);
  if (typeof reported === 'object') {
    error.invalidCandidateIds = [...new Set((Array.isArray(reported.invalidCandidateIds)
      ? reported.invalidCandidateIds : []).map((value) => meetingMinutesAgentText(value, 160)).filter(Boolean))];
    error.invalidReasons = (Array.isArray(reported.reasons) ? reported.reasons : [])
      .map((value) => meetingMinutesAgentText(value, 500)).filter(Boolean).slice(0, 40);
    error.validCandidateDispositions = Array.isArray(reported.validCandidateDispositions)
      ? reported.validCandidateDispositions : [];
  }
  return error;
}

function meetingAgentRefereeRoute(result = {}, contract = {}) {
  const declaredExpected = result?.expectedCandidateCount ?? result?.candidateCount;
  const declaredReturned = result?.returnedDispositionCount ?? result?.dispositionCount;
  const structured = Boolean(result?.requestId && result?.stage
    && declaredExpected != null && declaredReturned != null);
  if (structured && result.requestId === contract.requestId && result.stage === contract.stage) return 'structured_prompt';
  if (Array.isArray(result?.discussion) && Array.isArray(result?.actions)) return 'connected_fallback';
  return 'unknown';
}

function meetingAgentInfrastructureFailure(error) {
  if (!error) return false;
  if (error.code === 'unmaterialized_referee_action') return false;
  if (new Set([
    'power_automate_empty_response', 'power_automate_timeout', 'power_automate_unreachable',
    'power_automate_http_500', 'power_automate_http_502', 'power_automate_http_503', 'power_automate_http_504'
  ]).has(error.code)) return true;
  return Number(error.upstreamStatus || error.statusCode || 0) >= 500;
}

function refereeActionMaterializationIssues(dispositions = [], candidates = [], targetCandidates = candidates) {
  const uniqueById = (rows) => {
    const result = new Map();
    for (const candidate of Array.isArray(rows) ? rows : []) {
      const id = String(candidate?.candidateId || '');
      if (id) result.set(id, result.has(id) ? null : candidate);
    }
    return result;
  };
  // An ID must identify one writable action. Mere membership, or the last
  // record winning a duplicate ID, cannot establish an atomic mapping.
  const byId = uniqueById(candidates);
  const targetsById = uniqueById(targetCandidates);
  return (Array.isArray(dispositions) ? dispositions : []).flatMap((item) => {
    const disposition = item?.disposition || item?.classification;
    if (!['publish', 'proposal', 'core', 'keep'].includes(disposition)) return [];
    const candidateId = meetingMinutesAgentText(item?.candidateId, 160);
    const candidate = byId.get(candidateId);
    const targetId = meetingMinutesAgentText(item?.targetId || item?.mergeTarget, 160);
    let reason = '';
    // Group IDs describe source context, not writable action records. The
    // current Referee protocol has no validated group-to-atomic mapping; a
    // target alias alone must not approve its children or donate their fields.
    if (!byId.has(candidateId)) reason = 'action_candidate_not_found';
    else if (!candidate) reason = 'ambiguous_action_candidate';
    else if (['action_thread', 'action_chain'].includes(candidate.recordType)) reason = 'group_requires_atomic_action_mapping';
    else if (candidate.recordType !== 'action') reason = 'candidate_is_not_an_action';
    else if (candidate?.recordType === 'action'
      && !meetingMinutesAgentText(candidate.record?.action || candidate.text, 1200)) reason = 'action_wording_missing';
    else if (targetId && !targetsById.has(targetId)) reason = 'action_target_not_found';
    else if (targetId && !targetsById.get(targetId)) reason = 'ambiguous_action_target';
    else if (targetId && (targetsById.get(targetId).recordType !== 'action'
      || !meetingMinutesAgentText(targetsById.get(targetId).record?.action || targetsById.get(targetId).text, 1200))) {
      reason = 'action_target_not_writable';
    }
    if (!reason) return [];
    return [{ candidateId, disposition, recordType: candidate?.recordType || '', targetId, reason,
      refereeReason: meetingMinutesAgentText(item?.reason, 500),
      memberCandidateIds: [...new Set(candidate?.candidateIds || [])].slice(0, 120),
      evidenceIds: [...new Set([...(candidate?.evidenceIds || candidate?.record?.evidenceIds || []),
        ...(Array.isArray(item?.evidenceIds) ? item.evidenceIds : [])])].slice(0, 20) }];
  });
}

function refereeDiscussionTargetId(disposition = {}) {
  return meetingMinutesAgentText(disposition.targetId || disposition.mergeTarget
    || disposition.discussionId || disposition.targetRecordId
    || disposition.primaryId || disposition.coreId, 120);
}

function meetingAgentDispositionError(result, candidates = [], contract = {}, targetCandidates = candidates) {
  const expectedIds = [...new Set((Array.isArray(candidates) ? candidates : [])
    .map((candidate) => meetingMinutesAgentText(candidate?.candidateId, 160)).filter(Boolean))];
  if (!expectedIds.length) return null;
  const dispositions = Array.isArray(result?.candidateDispositions) ? result.candidateDispositions : [];
  const materializationIssues = contract.stage === 'ACTION_REFEREE'
    ? refereeActionMaterializationIssues(dispositions, candidates, targetCandidates) : [];
  const unmaterialized = new Set(materializationIssues.map((item) => item.candidateId));
  const allowed = contract.stage === 'DISCUSSION_REFEREE'
    ? new Set(['core', 'supporting', 'merge', 'reject'])
    : new Set(['publish', 'proposal', 'completed', 'suggestion', 'reject']);
  const dispositionValid = (item) => allowed.has(item?.disposition || item?.classification)
    && Boolean(meetingMinutesAgentText(item?.reason, 500))
    && Array.isArray(item?.evidenceIds);
  const coreTargets = new Set([
    ...(contract.knownDiscussionTargetIds || []),
    ...dispositions.filter((item) => (item.disposition || item.classification) === 'core')
      .map((item) => refereeDiscussionTargetId(item) || String(item.candidateId || '')),
    ...flattenHybridDiscussion(result?.discussion || []).map((item) => String(item.record?.id || ''))
  ].filter(Boolean));
  const targetValid = (item) => {
    if (contract.stage !== 'DISCUSSION_REFEREE') return true;
    const kind = item?.disposition || item?.classification;
    if (!['merge', 'supporting'].includes(kind)) return true;
    const target = refereeDiscussionTargetId(item);
    // Untargeted context can remain supporting. A merge must identify a real
    // primary target; a typo must trigger the existing subset-repair path.
    return !target ? kind === 'supporting' : coreTargets.has(target);
  };
  const counts = new Map();
  for (const disposition of dispositions) {
    const candidateId = meetingMinutesAgentText(disposition?.candidateId, 160);
    if (candidateId) counts.set(candidateId, Number(counts.get(candidateId) || 0) + 1);
  }
  const missing = expectedIds.filter((candidateId) => counts.get(candidateId) !== 1);
  const unexpected = [...counts.keys()].filter((candidateId) => !expectedIds.includes(candidateId));
  const declaredExpected = result?.expectedCandidateCount ?? result?.candidateCount;
  const declaredReturned = result?.returnedDispositionCount ?? result?.dispositionCount;
  const route = meetingAgentRefereeRoute(result, contract);
  let message = '';
  let code = '';
  if (missing.length) {
    message = `The evidence referee did not return exactly one disposition for ${missing.length} supplied candidate${missing.length === 1 ? '' : 's'}.`;
    code = 'incomplete_candidate_dispositions';
  } else if (unexpected.length) {
    message = `The evidence referee returned ${unexpected.length} candidate ID${unexpected.length === 1 ? '' : 's'} that were not supplied.`;
    code = 'unexpected_candidate_dispositions';
  } else if (route === 'structured_prompt' && (Number(declaredExpected) !== expectedIds.length
    || Number(declaredReturned) !== dispositions.length)) {
    message = 'The structured evidence referee accounting fields do not match the supplied and returned candidates.';
    code = 'invalid_referee_accounting';
  } else if (route === 'structured_prompt' && dispositions.some((item) => !dispositionValid(item))) {
    message = 'The structured evidence referee returned an incomplete or stage-incompatible candidate disposition.';
    code = 'invalid_referee_disposition';
  } else if (route === 'structured_prompt' && dispositions.some((item) => !targetValid(item))) {
    message = 'The discussion referee referenced a missing primary target.';
    code = 'invalid_referee_target';
  } else if (materializationIssues.length) {
    message = 'The action referee accepted a candidate without a writable atomic action or valid target; its materialization remains unresolved.';
    code = 'unmaterialized_referee_action';
  } else if (route === 'unknown') {
    message = 'The evidence referee response matched neither the structured Prompt contract nor the connected-agent fallback contract.';
    code = 'invalid_referee_contract';
  }
  if (!code) return null;
  const error = new Error(message);
  error.code = code;
  error.statusCode = 502;
  error.retryable = true;
  error.missingCandidateIds = missing;
  error.unexpectedCandidateIds = unexpected;
  error.validCandidateDispositions = dispositions.filter((item) => {
    const candidateId = meetingMinutesAgentText(item?.candidateId, 160);
    return expectedIds.includes(candidateId) && counts.get(candidateId) === 1
      && dispositionValid(item) && targetValid(item) && !unmaterialized.has(candidateId);
  });
  if (materializationIssues.length) error.unresolvedMaterializations = materializationIssues;
  // A complete, valid structured response cannot materialize a positive group:
  // this protocol has no group-to-atomic mapping. Another model call cannot
  // supply one. Keep the failure and its evidence; only skip that futile repair.
  error.structurallyUnwritableGroupsOnly = code === 'unmaterialized_referee_action'
    && route === 'structured_prompt'
    && materializationIssues.every((issue) => issue.reason === 'group_requires_atomic_action_mapping')
    && dispositions.every(dispositionValid)
    && error.validCandidateDispositions.length + materializationIssues.length === expectedIds.length;

  if (code === 'unmaterialized_referee_action') {
    error.invalidCandidateIds = [...unmaterialized];
    error.invalidReasons = materializationIssues.map((item) => `${item.candidateId}: ${item.reason}`);
  }
  if (code === 'invalid_referee_target') {
    error.invalidCandidateIds = dispositions.filter((item) => !targetValid(item)).map((item) => item.candidateId);
  }
  if (code === 'invalid_referee_disposition') {
    const invalid = dispositions.filter((item) => !dispositionValid(item));
    error.invalidCandidateIds = [...new Set(invalid
      .map((item) => meetingMinutesAgentText(item?.candidateId, 160)).filter(Boolean))];
    error.invalidReasons = invalid.map((item) => {
      const candidateId = meetingMinutesAgentText(item?.candidateId, 160) || '(missing candidateId)';
      if (!allowed.has(item?.disposition || item?.classification)) return `${candidateId}: invalid disposition`;
      if (!meetingMinutesAgentText(item?.reason, 500)) return `${candidateId}: missing reason`;
      return `${candidateId}: evidenceIds must be an array`;
    });
  }
  return error;
}

function meetingAgentRefereeAccountedForAllCandidates(refereeParsed = {}, refereeContract = {}, refereeRoute = '') {
  const expected = Array.isArray(refereeContract?.expectedCandidateIds) ? refereeContract.expectedCandidateIds : [];
  if (refereeRoute !== 'structured_prompt' || !expected.length) return false;
  if (Array.isArray(refereeContract.candidates)
    && meetingAgentDispositionError(refereeParsed, refereeContract.candidates, refereeContract)) return false;
  const returned = new Set((Array.isArray(refereeParsed?.candidateDispositions) ? refereeParsed.candidateDispositions : [])
    .map((item) => meetingMinutesAgentText(item?.candidateId, 160)).filter(Boolean));
  return returned.size === expected.length && expected.every((candidateId) => returned.has(candidateId));
}

// Labels the models return that mean one of ours beyond doubt. Kept small on
// purpose: a guess here would misreport a pass's judgement rather than record
// it, which is the thing this is meant to stop.
const MEETING_AGENT_DISPOSITION_ALIASES = {
  core: 'publish', keep: 'publish', complete: 'completed', rejected: 'reject'
};
const MEETING_AGENT_DISPOSITIONS = new Set(['publish', 'proposal', 'completed', 'suggestion', 'reject']);

// An unrecognised disposition used to be filtered out here without a trace.
// Across the stored corpus that discarded 1038 records under 116 invented
// labels - 714 of them from the critic, which answered on 724 candidates and
// was heard on 10. The pass looked mute when it was talking the whole time.
//
// Anything we cannot map is now kept as 'unclassified', carrying the label the
// model actually used, so it lands in qualityState and can be read back. It
// counts towards no published or proposed total, so what the reviewer sees is
// unchanged - this records the judgement, it does not act on it.
function normaliseAgentCandidateDispositions(result = {}, sourceUnits = []) {
  const validIds = new Set(normaliseSourceUnits(sourceUnits).map((unit) => unit.id));
  const unclassified = new Map();
  const normalised = (Array.isArray(result?.candidateDispositions) ? result.candidateDispositions : [])
    .filter((item) => item?.candidateId)
    .map((item) => {
      const raw = meetingMinutesAgentText(item?.disposition, 80);
      const mapped = MEETING_AGENT_DISPOSITION_ALIASES[raw] || raw;
      const known = MEETING_AGENT_DISPOSITIONS.has(mapped);
      if (!known && raw) unclassified.set(raw, (unclassified.get(raw) || 0) + 1);
      return {
        candidateId: meetingMinutesAgentText(item.candidateId, 120),
        disposition: known ? mapped : 'unclassified',
        rawDisposition: known && mapped === raw ? '' : raw,
        reason: meetingMinutesAgentText(item.reason, 500),
        evidenceIds: [...new Set((Array.isArray(item.evidenceIds) ? item.evidenceIds : []).filter((id) => validIds.has(id)))].slice(0, 12),
        uncertainties: (Array.isArray(item.uncertainties) ? item.uncertainties : []).map((value) => meetingMinutesAgentText(value, 160)).filter(Boolean).slice(0, 8)
      };
    }).slice(0, 320);
  if (unclassified.size) {
    console.info(JSON.stringify({
      event: 'meeting_agent_disposition_unclassified',
      labels: [...unclassified.entries()].map(([label, count]) => ({ label, count }))
    }));
  }
  return normalised;
}

function meetingAgentRefereeRepairCandidates(candidates = [], validDispositions = []) {
  const retainedValidIds = new Set((Array.isArray(validDispositions) ? validDispositions : [])
    .map((item) => meetingMinutesAgentText(item?.candidateId, 160))
    .filter(Boolean));
  const supplied = Array.isArray(candidates) ? candidates : [];
  return retainedValidIds.size
    ? supplied.filter((candidate) => !retainedValidIds.has(
      meetingMinutesAgentText(candidate?.candidateId, 160)
    ))
    : supplied;
}

function normaliseMeetingAgentRefereeContractResult(result = {}, candidates = [], contract = {}) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.candidateDispositions)) return result;
  const candidateById = new Map((Array.isArray(candidates) ? candidates : [])
    .map((candidate) => [meetingMinutesAgentText(candidate?.candidateId, 160), candidate])
    .filter(([candidateId]) => candidateId));
  const expected = new Set(candidateById.keys());
  const aliases = contract.stage === 'DISCUSSION_REFEREE' ? {
    publish: 'core', keep: 'core', visible: 'core', primary: 'core', material: 'core',
    proposal: 'supporting', context: 'supporting', secondary: 'supporting', non_core: 'supporting',
    uncertain: 'supporting', unclear: 'supporting', duplicate: 'merge', merged: 'merge',
    discard: 'reject', discarded: 'reject'
  } : {
    core: 'publish', keep: 'publish', committed: 'publish', accepted_request: 'publish',
    conditional_commitment: 'proposal', supporting: 'proposal', unaccepted_request: 'reject',
    rejected: 'reject', status_only: 'completed', historical: 'completed', idea: 'suggestion', discard: 'reject'
  };
  const candidateDispositions = result.candidateDispositions
    .map((item) => {
      const candidateId = meetingMinutesAgentText(item?.candidateId, 160);
      const rawDisposition = meetingMinutesAgentText(item?.disposition || item?.classification, 80)
        .toLowerCase().replace(/[\s-]+/g, '_');
      const candidate = candidateById.get(candidateId);
      const allowedDiscussion = new Set(['core', 'supporting', 'merge', 'reject']);
      let disposition = aliases[rawDisposition] || rawDisposition;
      let websiteNormalisedDisposition = false;
      if (contract.stage === 'DISCUSSION_REFEREE' && !allowedDiscussion.has(disposition)
        && candidate && Array.isArray(candidate.evidenceIds) && candidate.evidenceIds.length) {
        // AI Builder occasionally emits an empty/free-form enum while still
        // returning the correct candidate ID, reason and evidence. Retrying the
        // whole reasoning step is unnecessary. Preserve a prior anchored hint
        // when available; otherwise keep the row as collapsed context. This
        // fallback can never promote an unclassified row into visible minutes.
        disposition = ['core', 'supporting'].includes(candidate.dispositionHint)
          ? candidate.dispositionHint : 'supporting';
        websiteNormalisedDisposition = true;
      }
      return {
        ...item,
        candidateId,
        disposition,
        ...(websiteNormalisedDisposition ? { websiteNormalisedDisposition: true } : {})
      };
    })
    // An unexpected ID cannot affect a supplied candidate and is safe to
    // discard. Missing or duplicate expected IDs are still repaired below.
    .filter((item) => expected.has(item.candidateId));
  return {
    ...result,
    candidateDispositions,
    returnedDispositionCount: candidateDispositions.length,
    dispositionCount: candidateDispositions.length
  };
}

function reconcileRefereeActionMaterialization(issues = [], candidates = [], dispositions = [], sourceUnits = [], settled = []) {
  const validEvidence = new Set((sourceUnits || []).map((unit) => unit.id));
  const settledById = new Map((settled || []).filter((item) =>
    ['reject', 'completed', 'suggestion'].includes(item?.disposition)
    && meetingMinutesAgentText(item?.reason, 500)).map((item) => [item.candidateId, item]));
  const unresolved = [...new Map((issues || []).map((issue) => [issue.candidateId, issue])).values()]
    .filter((issue) => !settledById.has(issue.candidateId))
    .map((issue) => ({ ...issue, evidenceIds: (issue.evidenceIds || []).filter((id) => validEvidence.has(id)) }));
  const unresolvedById = new Map(unresolved.map((issue) => [issue.candidateId, issue]));
  const memberIds = new Set(unresolved.flatMap((issue) => issue.memberCandidateIds || []));
  const groupIds = new Set(candidates.filter((candidate) => ['action_thread', 'action_chain'].includes(candidate.recordType))
    .map((candidate) => candidate.candidateId));
  const rows = dispositions.map((item) => {
    const groupVerdict = groupIds.has(item.candidateId) && settledById.get(item.candidateId);
    if (groupVerdict) return { ...item, disposition: groupVerdict.disposition,
      matchedRecordId: '', reason: groupVerdict.reason };
    const issue = unresolvedById.get(item.candidateId);
    // A separately represented or explicitly rejected child keeps its own
    // outcome. A missing sibling has no rejection verdict merely because the
    // broad group could not be materialized.
    if (!issue && (!memberIds.has(item.candidateId) || item.disposition !== 'reject'
      || settledById.has(item.candidateId))) return item;
    return { ...item, disposition: 'unresolved', matchedRecordId: '',
      reason: issue ? `Referee ${issue.disposition} could not be materialized: ${issue.reason}.`
        : 'Not independently represented or adjudicated after an unresolved grouped-action disposition.' };
  });
  const flags = unresolved.map((issue, index) => {
    const candidate = candidates.find((entry) => entry.candidateId === issue.candidateId);
    return normaliseMeetingAgentFlag({
      id: `action-materialization-${crypto.createHash('sha256').update(issue.candidateId).digest('hex').slice(0, 20)}`,
      kind: 'possible_missed_follow_up', reviewDisposition:'coverage_unresolved',
      message: `The agent could not establish complete action coverage for this passage. Some work may already be present. Check the source if you want to verify coverage: ${meetingMinutesAgentText(candidate?.text || candidate?.record?.action, 240) || 'Review the cited source.'}`,
      evidenceIds: issue.evidenceIds
    }, index);
  });
  return { candidateDispositions: rows, flags,
    accounting: { complete: unresolved.length === 0, unresolvedCount: unresolved.length,
      unresolvedCandidateIds: unresolved.map((item) => item.candidateId), unresolved } };
}

function refereeDiscussionContractDiagnostics(discussion = [], dispositions = [], candidates = []) {
  const returnedIds = new Set(flattenHybridDiscussion(discussion)
    .map((item) => String(item.record?.id || '')).filter(Boolean));
  const suppliedIds = new Set((Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => ['discussion_point', 'decision', 'open_question'].includes(candidate?.recordType))
    .map((candidate) => String(candidate.candidateId || '')).filter(Boolean));
  const rows = Array.isArray(dispositions) ? dispositions : [];
  const seen = new Set();
  let unknownCandidateCount = 0; let duplicateCandidateCount = 0; let incompleteDispositionCount = 0;
  const danglingTargetIds = new Set();
  for (const row of rows) {
    const candidateId = String(row?.candidateId || '');
    const kind = row?.disposition || row?.classification;
    const targetId = refereeDiscussionTargetId(row);
    if (!candidateId || !kind || !meetingMinutesAgentText(row?.reason, 500)
      || !Array.isArray(row?.evidenceIds)) incompleteDispositionCount += 1;
    if (candidateId && seen.has(candidateId)) duplicateCandidateCount += 1;
    if (candidateId) seen.add(candidateId);
    if (candidateId && !suppliedIds.has(candidateId)) unknownCandidateCount += 1;
    if (kind !== 'reject' && (!targetId || !returnedIds.has(targetId))) danglingTargetIds.add(targetId || '(missing)');
  }
  return {
    suppliedCandidateCount: suppliedIds.size,
    returnedDispositionCount: rows.length,
    uniqueDispositionCandidateCount: seen.size,
    undisposedCandidateCount: [...suppliedIds].filter((id) => !seen.has(id)).length,
    unknownCandidateCount, duplicateCandidateCount, incompleteDispositionCount,
    danglingTargetIds: [...danglingTargetIds]
  };
}

function discussionRefereeHasCompleteCandidateAccounting(diagnostics = {}) {
  const supplied = Number(diagnostics?.suppliedCandidateCount || 0);
  return supplied > 0
    && Number(diagnostics?.returnedDispositionCount || 0) === supplied
    && Number(diagnostics?.uniqueDispositionCandidateCount || 0) === supplied
    && Number(diagnostics?.undisposedCandidateCount || 0) === 0
    && Number(diagnostics?.unknownCandidateCount || 0) === 0
    && Number(diagnostics?.duplicateCandidateCount || 0) === 0
    && Number(diagnostics?.incompleteDispositionCount || 0) === 0;
}

module.exports = {
  meetingAgentResultError,
  meetingAgentRefereeRoute,
  meetingAgentInfrastructureFailure,
  refereeActionMaterializationIssues,
  refereeDiscussionTargetId,
  meetingAgentDispositionError,
  meetingAgentRefereeAccountedForAllCandidates,
  normaliseMeetingAgentRefereeContractResult,
  meetingAgentRefereeRepairCandidates,
  normaliseAgentCandidateDispositions,
  refereeDiscussionContractDiagnostics,
  discussionRefereeHasCompleteCandidateAccounting,
  reconcileRefereeActionMaterialization,
};
