'use strict';

const { tokenOverlap, stableId } = require('./meetingMinutesRecordMatching');
const { comparisonText, evidenceContextFor, evidenceWindowText } = require('./meetingMinutesEvidenceContext');
const { actionIsSafelyCovered } = require('./canonicalMinutes/actionDuplicateCoverage');
const { commitmentCanBeRepresented } = require('./canonicalMinutes/commitmentDuplicates');
const { text, cleanActionWording, isIdeaOnlyContemplation } = require('./meetingMinutesText');
const { resolveEvidence } = require('./meetingMinutesEvidenceResolution');
const { correctnessChecksEnabled, uncitedClaimSupported } = require('./meetingMinutesEvidenceChecks');
const { splitOwners, normaliseOwnerIdentity } = require('./meetingMinutesPeopleEvidence');
const { isReviewerAuthored } = require('./canonicalMinutes/state');
const {
  retainSuppliedActionFieldEvidence, anchorOwnerCommitment
} = require('./meetingMinutesActionFieldGrounding');
const { actionEvidenceDisposition, isMeetingAdminAction } = require('./meetingMinutesActionEvidence');
const {
  timingFrom, resolveOfferedDateChoice, backfillAskedTiming, backfillCitedTiming,
  recoveredTimingEvidence, replaceEmbeddedTiming, timingClauseChecksEnabled, timingClauseIssue
} = require('./meetingMinutesActionTimingInference');
const TimingIntegrity = require('./meetingMinutesTiming');
const {
  normaliseTimingWording, timingPublicationIssue, timingForPublication
} = require('./meetingMinutesTimingPublication');
const { reviewerProvenance } = require('./meetingMinutesReviewerEdits');
const { validOccurrenceId } = require('./meetingMinutesActionIdentity');
const actionDiagnostics = require('./meetingMinutesActionDiagnostics');

function actionSimilarity(left, right) {
  return tokenOverlap(comparisonText(left.action), comparisonText(right.action));
}

function ownersCompatible(left, right) {
  if (!left.owners.length || !right.owners.length) return true;
  const a = new Set(left.owners.map((owner) => owner.toLowerCase()));
  const b = new Set(right.owners.map((owner) => owner.toLowerCase()));
  return [...a].some((owner) => b.has(owner)) && ([...a].every((owner) => b.has(owner)) || [...b].every((owner) => a.has(owner)));
}

function coveringActionPair(left, right, related) {
  let leftCovered = actionIsSafelyCovered(left, right);
  let rightCovered = actionIsSafelyCovered(right, left);
  if (!leftCovered && !rightCovered && related) {
    leftCovered = commitmentCanBeRepresented(left, right);
    rightCovered = commitmentCanBeRepresented(right, left);
  }
  if (!leftCovered && !rightCovered) return null;
  // Fuller wording breaks a tie only after both directions preserve the work.
  // It cannot make a longer fragment displace a complete compound or date.
  return leftCovered && (!rightCovered || text(right.action).length > text(left.action).length)
    ? [right, left] : [left, right];
}

function mergeCoveredActionRecords(winner, loser) {
  const result = {
    ...winner,
    evidenceIds: [...new Set([...(winner.evidenceIds || []), ...(loser.evidenceIds || [])])],
    reviewFlagIds: [...new Set([...(winner.reviewFlagIds || []), ...(loser.reviewFlagIds || [])])]
  };
  for (const field of ['_unsupportedEvidenceIds', '_weakEvidenceIds', '_timingConflicts']) {
    if (Array.isArray(winner[field]) || Array.isArray(loser[field])) {
      result[field] = [...new Set([...(winner[field] || []), ...(loser[field] || [])])];
    }
  }
  for (const field of ['_timingPublicationIssue', '_timingClauseNote']) {
    if (!result[field] && loser[field]) result[field] = loser[field];
  }
  return result;
}

const COMMITMENT_RECHECK_DISPOSITIONS = new Set(['suggestion', 'status_only', 'meeting_admin', 'unaccepted_request']);

function normaliseActions(candidate = {}, units = [], options = {}) {
  const rows = (Array.isArray(candidate.actions) ? candidate.actions : []).slice(0, 250).map((item, index) => {
    let action = options.preserveReviewerEdits === true ? text(item?.action, 1600) : cleanActionWording(item?.action);
    if (!action || (options.preserveReviewerEdits !== true && isIdeaOnlyContemplation(action))) return null;
    const suppliedIds = (Array.isArray(item?.evidenceIds) ? item.evidenceIds : []).map((id) => text(id, 30)).filter(Boolean);
    const resolved = resolveEvidence(action, units, item?.evidenceIds, { action: true, meetingDate: options.meetingDate });
    const checks = correctnessChecksEnabled();
    if (checks && options.enforceEvidence === false && !suppliedIds.some((id) => evidenceContextFor(units).known.has(id))
      && resolved.evidenceIds.length && !uncitedClaimSupported(action, resolved, units)) {
      resolved.evidenceIds = [];
    }
    const owners = splitOwners(item?.owners || item?.owner).map((owner) => normaliseOwnerIdentity(owner, units));
    // Saving reviewer content is not a new source-allocation decision. Keep
    // their valid references; the existing support/owner checks may flag them.
    const preserveEvidence = options.preserveReviewerEdits === true || isReviewerAuthored(item);
    const fieldEvidenceIds = preserveEvidence
      ? [...new Set(suppliedIds)].filter(id => evidenceContextFor(units).known.has(id)).slice(0, 8)
      : retainSuppliedActionFieldEvidence(action, owners, units, suppliedIds, resolved.evidenceIds, item?.timing, options);
    let evidenceIds = preserveEvidence ? fieldEvidenceIds : anchorOwnerCommitment(action, owners, units, fieldEvidenceIds);
    const evidenceText = evidenceWindowText(units, evidenceIds, 1);
    const disposition = actionEvidenceDisposition(action, evidenceText);
    if (options.enforceEvidence !== false && !evidenceIds.length) return null;
    if (options.enforceEvidence !== false && ['completed', 'suggestion', 'status_only', 'meeting_admin', 'unaccepted_request', 'rejected'].includes(disposition)) {
      // The keyword reading can be wrong ("Janine and Adil, you're involved in
      // that next week" reads as no commitment). A caller may collect these
      // for a quote-verified second look; they are never published from here.
      if (Array.isArray(options.vetoed) && COMMITMENT_RECHECK_DISPOSITIONS.has(disposition) && !isMeetingAdminAction(action)) {
        options.vetoed.push({ id: text(item?.id, 80) || stableId('action', action, index), action, owners, timing: timingFrom(item, options), evidenceIds, reviewFlagIds: [], disposition });
      }
      return null;
    }
    // Recovery fills gaps in fresh agent output only. A save (enforceEvidence
    // false) carries timings a reviewer or a timing check has already settled,
    // so an empty timing there is deliberate and must stay empty.
    const activeTimingDecision = TimingIntegrity.assessmentMatches({ ...item, action, owners, evidenceIds }, units,
      options.meetingDate || item.timingDecision?.meetingDate, item.timingDecision) ? item.timingDecision : undefined;
    const timingRecoveryIssues = [], recoveredTimingEvidenceIds = [];
    const timingOptions = { ...options, action, owners, timingRecoveryIssues, recoveredTimingEvidenceIds,
      timingMode: options.timingMode || (options.enforceEvidence !== false ? 'derive' : 'preserve'),
      timingDecision: activeTimingDecision
    };
    let timing = timingFrom(item, timingOptions);
    let timingShapeIssue = '';
    if (options.enforceEvidence !== false) {
      // Shape is checked before the transcript backfills, not after: a copied
      // sentence in the timing column ("I'll draft that.") used to block the
      // backfills, which only fill an empty timing, so the real answer three
      // rows later ("Okay so that's the fifteenth") was never looked for.
      timing = normaliseTimingWording(timing);
      timingShapeIssue = timingPublicationIssue(timing);
      if (timingShapeIssue) timing = timingForPublication(timing);
      if (!['rejected', 'needs_rebind'].includes(activeTimingDecision?.status)) {
        timing = resolveOfferedDateChoice(backfillAskedTiming(backfillCitedTiming(timing, units, evidenceIds, timingOptions), units, evidenceIds, timingOptions), units, evidenceIds, timingOptions);
      }
      evidenceIds = recoveredTimingEvidence(evidenceIds, recoveredTimingEvidenceIds);
      // A generated action should name the work once. Its agreed deadline or
      // target belongs in the structured timing field, where it remains
      // searchable and can be checked independently of the action wording.
      if (timing.kind !== 'not_stated' && timing.wording) {
        action = replaceEmbeddedTiming(action, timing.wording, '', timing.exactDate);
      }
      // Replaced from the transcript rather than removed: nothing to report.
      if (timingShapeIssue && timing.kind !== 'not_stated' && timing.wording) timingShapeIssue = '';
    }
    // Agent output is corrected once, on the published actions, so every
    // change reaches the reviewer with its flag (see applyTimingClauseChecks).
    // Here only a reviewer's own entry is checked, and only flagged.
    const timingClauseNote = timingClauseChecksEnabled() && options.enforceEvidence === false
      ? timingClauseIssue(action, timing, units, evidenceIds) : null;
    const timingAssessment = TimingIntegrity.assessActionTiming({
      ...reviewerProvenance(item, options), id: item.id, action, owners, evidenceIds, timing,
      ...(item.timingDecision ? { timingDecision: item.timingDecision } : {})
    }, units, {
      meetingDate: options.meetingDate,
      reviewerAuthored: options.preserveReviewerEdits === true
    });
    timing = timingAssessment.action.timing;
    const normalised = {
      id: text(item?.id, 80) || stableId('action', action, index),
      ...(validOccurrenceId(item?.occurrenceId) ? { occurrenceId: item.occurrenceId } : {}),
      ...reviewerProvenance(item, options),
      action,
      owners,
      timing,
      ...(timingAssessment.assessment ? { timingDecision: timingAssessment.assessment } : {}),
      _timingDateIssues: [...timingAssessment.issues, ...(timing.kind === 'not_stated' ? timingRecoveryIssues : [])],
      _timingPublicationIssue: timingShapeIssue,
      _timingClauseNote: timingClauseNote,
      evidenceIds,
      reviewFlagIds: [...new Set((Array.isArray(item?.reviewFlagIds) ? item.reviewFlagIds : []).map((id) => text(id, 80)).filter(Boolean))],
      _unsupportedEvidenceIds: resolved.invalidIds,
      _weakEvidenceIds: resolved.weakIds,
      _evidenceDisposition: disposition,
      _timingConflicts: []
    };
    actionDiagnostics.transition('normalised', [item], [normalised], { mechanism: 'normaliseActions', index,
      suppliedEvidenceIds: suppliedIds, resolvedEvidenceIds: resolved.evidenceIds, fieldEvidenceIds,
      resolutionEvent: actionDiagnostics.resolutionEvent(action, suppliedIds),
      reason: preserveEvidence ? 'reviewer_evidence_preserved' : 'source_and_field_normalisation' });
    return normalised;
  }).filter(Boolean);
  // A reviewer save is a persistence boundary, not another generation pass.
  // Preserve the exact visible register (including two similar rows) so an
  // autosave cannot silently remove an action or make a pending proposal's
  // indexes stale. Generated candidates still use the normal deduper.
  if (options.dedupeActions === false || options.preserveReviewerEdits === true) return rows;
  const merged = [];
  for (const row of rows) {
    let pair;
    const index = merged.findIndex((existing) => {
      pair = coveringActionPair(existing, row, actionSimilarity(existing, row) >= 0.78 && ownersCompatible(existing, row));
      return Boolean(pair);
    });
    if (index < 0) {
      merged.push(row);
      continue;
    }
    const before = actionDiagnostics.refs(pair);
    merged[index] = mergeCoveredActionRecords(...pair);
    actionDiagnostics.event('combined', before, actionDiagnostics.refs([merged[index]]), { mechanism: 'normaliseActions_coverage' });
  }
  return merged;
}

module.exports = { coveringActionPair, mergeCoveredActionRecords, normaliseActions };
