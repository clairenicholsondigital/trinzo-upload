'use strict';

const { flattenHybridDiscussion } = require('./meetingMinutesDiscussionRows');
const { meetingMinutesAgentText } = require('./meetingMinutesPlainText');

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

module.exports = {
  meetingAgentResultError,
  meetingAgentRefereeRoute,
  meetingAgentInfrastructureFailure,
  refereeActionMaterializationIssues,
  refereeDiscussionTargetId,
  meetingAgentDispositionError,
  meetingAgentRefereeAccountedForAllCandidates,
};
