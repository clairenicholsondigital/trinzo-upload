'use strict';

const actionDiagnostics = require('./meetingMinutesActionDiagnostics');
const actionPhase = require('./meetingMinutesActionPhaseCorrection');
const actionUnion = require('./meetingMinutesActionUnionRewrite');
const {
  actionContainmentConflict, actionIsLosslesslyCovered, conflictingTimings,
  exactActionIdentityConflict, sameActionText, sourceBoundIdenticalActionTimingCompletion,
  sourceBoundLiteralDependencyTiming, sourceBoundReviewTimingContext
} = require('./canonicalMinutes/actionDuplicateCoverage');
const {
  commitmentCanBeRepresented, commitmentDetailsCovered, reconcileCommitmentVariants,
  sourceAwareParaphraseDuplicate, sourceBoundRoleClarificationDuplicate
} = require('./canonicalMinutes/commitmentDuplicates');
const { isReviewerAuthored } = require('./canonicalMinutes/state');
const { reconcileDetailedContacts } = require('./canonicalMinutes/detailedContactCoverage');
const { sameActionPresentation, strictActionDeliverableMatch } = require('./meetingMinutesActionDuplicatePolicy');
const { sameEnquiryActionSnapshot } = require('./meetingMinutesEnquiryRecovery');
const { sameCanonicalDocumentWorkflow, sameOrNestedActionDeliverable } = require('./canonicalMinutes/actionDeliverableIdentity');
const { validateReconciliationReceipt } = require('./canonicalMinutes/actionSemanticReconciliation');
const { actionProvenanceSignature } = require('./meetingMinutesActionIdentity');

function reconcileFinalApprovedActions(published = [], approved = [], options = {}) {
  const actions = [...(Array.isArray(published) ? published : [])];
  const restored = [];
  const representedReviewerOccurrences = new Set();
  for (const record of Array.isArray(approved) ? approved : []) {
    if (isReviewerAuthored(record)) {
      // Generation boundaries clone rows. Match each unchanged reviewer row to
      // one visible occurrence, not object identity or a possibly repeated ID.
      // Two deliberately identical reviewer entries therefore remain two.
      const index = actions.findIndex((existing, at) => !representedReviewerOccurrences.has(at)
        && isReviewerAuthored(existing) && sameActionPresentation(record, existing));
      if (index >= 0) {
        representedReviewerOccurrences.add(index);
      } else {
        representedReviewerOccurrences.add(actions.length);
        actions.push(record);
        restored.push(record);
        actionDiagnostics.transition('restored', [record], [record], { mechanism: 'approved_action_preservation', reason: 'not_proved_represented' });
      }
      continue;
    }
    // An unchanged approved record already present must not enrich a different
    // variant first: doing so can overwrite that variant's occurrence identity.
    // Compare the full snapshot, never a possibly reused model ID.
    if (actions.some(existing => sameEnquiryActionSnapshot(record, existing))) continue;
    const completedTimingIndex = actions.findIndex(existing =>
      sourceBoundIdenticalActionTimingCompletion(record, existing, options.sourceUnits || [])
      || sourceBoundLiteralDependencyTiming(record, existing, options.sourceUnits || []));
    if (completedTimingIndex >= 0) {
      actions[completedTimingIndex] = sourceBoundIdenticalActionTimingCompletion(
        record, actions[completedTimingIndex], options.sourceUnits || [])
        || sourceBoundLiteralDependencyTiming(record, actions[completedTimingIndex], options.sourceUnits || []);
      continue;
    }
    const contactIndex = actions.findIndex(existing => reconcileDetailedContacts(existing, record));
    if (contactIndex >= 0) {
      actions[contactIndex] = reconcileDetailedContacts(actions[contactIndex], record).record;
      continue;
    }
    const contextualReviewIndex = actions.findIndex(existing =>
      sourceBoundReviewTimingContext(record, existing, options.sourceUnits || []));
    if (contextualReviewIndex >= 0) {
      const existing = actions[contextualReviewIndex];
      const preferred = sourceBoundReviewTimingContext(record, existing, options.sourceUnits || []);
      const recovery = {};
      for (const key of ['_unsupportedEvidenceIds', '_weakEvidenceIds', '_timingConflicts']) {
        if (Array.isArray(existing[key]) || Array.isArray(record[key])) {
          recovery[key] = [...new Set([...(existing[key] || []), ...(record[key] || [])])];
        }
      }
      for (const key of ['_timingPublicationIssue', '_timingClauseNote']) {
        if (existing[key] || record[key]) recovery[key] = preferred[key] || existing[key] || record[key];
      }
      actions[contextualReviewIndex] = {
        ...preferred,
        evidenceIds: [...new Set([...(existing.evidenceIds || []), ...(record.evidenceIds || [])])],
        reviewFlagIds: [...new Set([...(existing.reviewFlagIds || []), ...(record.reviewFlagIds || [])])],
        ...recovery
      };
      continue;
    }
    // New source-bound semantic reconciliation supplies exact, immutable
    // original-to-final receipts. No raw-ID skip list: changed wording, source,
    // timing or metadata invalidates the receipt and work is restored normally.
    const semanticallyRepresented = Array.isArray(options.receipts) && actions.some(existing =>
      options.receipts.some(receipt => validateReconciliationReceipt(receipt, record, existing, options.sourceUnits || [])));
    if ((options.phaseReceipts || []).some(receipt => actionPhase.covers(receipt,record,actions,options.sourceUnits||[],options.meetingDate))) continue;
    if (semanticallyRepresented || (options.unionReceipts || []).some(receipt => actions.some(existing =>
      actionUnion.valid(receipt, record, existing, options.sourceUnits || [], options.meetingDate)))) continue;
    // Use the same directional, lossless variant proof as the final deduper.
    // If its survivor needs an approved row's extra detail, enrich that single
    // instruction rather than restoring a second wording of the same task.
    const variantIndex = actions.findIndex(existing => !sameActionText(existing, record)
      && reconcileCommitmentVariants(existing, record));
    if (variantIndex >= 0) {
      actions[variantIndex] = reconcileCommitmentVariants(actions[variantIndex], record).record;
      continue;
    }
    const represented = actions.some((existing) => existing === record || (!exactActionIdentityConflict(record, existing)
      && !conflictingTimings(record, existing)
      && !isReviewerAuthored(existing)
      && (sourceBoundRoleClarificationDuplicate(record, existing, options.sourceUnits || [])
        || sourceAwareParaphraseDuplicate(record, existing, { sourceUnits: options.sourceUnits })
        || (!actionContainmentConflict(record, existing)
          // A loose deliverable match is only a nomination. The published row
          // must retain this approved instruction's scope and relationships too.
          && commitmentCanBeRepresented(record, existing)))
      && (sourceBoundRoleClarificationDuplicate(record, existing, options.sourceUnits || [])
        || sourceAwareParaphraseDuplicate(record, existing, { sourceUnits: options.sourceUnits })
        || actionIsLosslesslyCovered(record, existing)
        || (!sameActionText(record, existing)
          && strictActionDeliverableMatch(record, existing, { includeDocumentation: true })
          && strictActionDeliverableMatch(existing, record, { includeDocumentation: true })
          && commitmentDetailsCovered(record, existing))
        || (!sameActionText(record, existing) && sameCanonicalDocumentWorkflow(record, existing)
          && sameOrNestedActionDeliverable(record, existing)))));
    if (represented) continue;
    actions.push(record);
    restored.push(record);
    actionDiagnostics.transition('restored', [record], [record], { mechanism: 'approved_action_preservation', reason: 'not_proved_represented' });
  }
  const firstEvidence = (record) => Math.min(...(record.evidenceIds || [])
    .map((id) => Number(String(id).match(/\d+/)?.[0] || Infinity)));
  actions.sort((left, right) => firstEvidence(left) - firstEvidence(right)
    || String(left.action || '').localeCompare(String(right.action || '')));
  return { actions, restored };
}

function semanticReceiptCoversActionProposal(record = {}, published = [], options = {}) {
  if (!isReviewerAuthored(record) && (options.phaseReceipts||[]).some(receipt =>
    actionPhase.covers(receipt,record,published,options.sourceUnits||[],options.meetingDate))) return true;
  if ((options.unionReceipts || []).some(receipt => published.some(survivor =>
    actionUnion.valid(receipt, record, survivor, options.sourceUnits || [], options.meetingDate)))) return true;
  if (!Array.isArray(options.receipts) || isReviewerAuthored(record)) return false;
  // Only an unchanged original covered by an exact CURRENT survivor qualifies.
  // Identity differences at generated admission never grant an ID-wide exemption.
  return options.receipts.some(receipt => receipt?.original
    && actionProvenanceSignature(record) === actionProvenanceSignature(receipt.original)
    && published.some(survivor => validateReconciliationReceipt(receipt, receipt.original,
      survivor, options.sourceUnits || [])));
}

module.exports = { reconcileFinalApprovedActions, semanticReceiptCoversActionProposal };
