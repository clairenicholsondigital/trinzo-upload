'use strict';

const { validOccurrenceId, actionProvenanceSignature, findActionOccurrenceIndex, preserveActionIdentity } = require('./meetingMinutesActionIdentity');
const { meetingMinutesAgentText } = require('./meetingMinutesPlainText');
const { requiresDocumentReferenceReview } = require('./meetingMinutesAssessmentEvidence');
const { applyProposal } = require('./meetingMinutesProposals');
const { actionIsLosslesslyCovered } = require('./canonicalMinutes/actionDuplicateCoverage');
const { meetingAgentProposalReviewFlagId, normaliseFlag: normaliseMeetingAgentFlag, mergeMeetingAgentFlags, reconcileRecordFlags } = require('./meetingMinutesReviewFlags');
const { numericActionEditIssue } = require('./meetingMinutesActionNumericPreservation');
const { gateEnabled: transcriptTextGateEnabled, transcriptTextIssue } = require('./actionTextGate');
const { meetingAgentProposalFlagMatchesChange } = require('./meetingMinutesDraftView');

function retainedDocumentReferenceReviewFlags(records = [], flags = []) {
  const rows = records.filter(requiresDocumentReferenceReview);
  return reconcileRecordFlags({ actions: rows }, flags).flags.filter(flag =>
    flag.documentReferenceContext && rows.some(row => (row.reviewFlagIds || []).includes(flag.id)))
    .map(flag => {
      const row = rows.find(record => (record.reviewFlagIds || []).includes(flag.id));
      return normaliseMeetingAgentFlag({ ...flag, kind: 'possible_missed_follow_up', reviewDisposition: 'not_applied_addition',
        message: flag.message.startsWith('Possible assessment to review:') ? flag.message
          : `Possible assessment to review: ${flag.message} Proposed wording: ${meetingMinutesAgentText(row.action, 160)}` });
    });
}

function resolveMeetingAgentProposalFlags(flags = [], proposal = {}, acceptedIds = [], rejectedIds) {
  const changes = Array.isArray(proposal?.changes) ? proposal.changes : [];
  const accepted = new Set(acceptedIds || []);
  // Preserve the original three-argument helper contract for internal callers
  // and older tests. The review endpoint passes an explicit fourth argument so
  // unchecked changes can remain pending rather than being treated as rejected.
  const rejected = new Set(arguments.length < 4
    ? changes.map((change) => change.id).filter((id) => !accepted.has(id))
    : (rejectedIds || []));
  return (Array.isArray(flags) ? flags : []).map((flag) => {
    const change = changes.find((candidate) => meetingAgentProposalFlagMatchesChange(flag, candidate));
    if (!change || flag.status !== 'open' || (!accepted.has(change.id) && !rejected.has(change.id))) return flag;
    return {
      ...flag,
      status: accepted.has(change.id) ? 'confirmed' : 'dismissed',
      correctionNote: flag.correctionNote || (accepted.has(change.id)
        ? 'Resolved when the proposed change was accepted.'
        : 'Resolved when the proposed change was rejected.')
    };
  });
}

function rebaseMeetingAgentProposal(proposal = {}, originalRows = [], currentRows = [], completedIds = [], options = {}) {
  const completed = new Set(completedIds || []);
  const original = Array.isArray(originalRows) ? originalRows : [];
  const current = Array.isArray(currentRows) ? currentRows : [];
  const rowIndex = (row) => {
    if (row?.action != null) {
      const exactReferences = current.map((candidate, index) => candidate === row ? index : -1).filter(index => index >= 0);
      if (!validOccurrenceId(row.occurrenceId) && exactReferences.length === 1) return exactReferences[0];
      // Identical legacy occurrences cannot be distinguished after one has
      // disappeared. A surviving ordinal ID must not inherit its suggestion.
      if (!validOccurrenceId(row.occurrenceId)) {
        const same = candidate => String(candidate?.id || '') === String(row.id || '')
          && actionProvenanceSignature(candidate) === actionProvenanceSignature(row);
        if (original.filter(same).length > 1 && current.filter(same).length < original.filter(same).length) return -1;
      }
      return findActionOccurrenceIndex(current, row);
    }
    const id = meetingMinutesAgentText(row?.id, 80);
    if (id) {
      const candidates = current.map((candidate, index) => meetingMinutesAgentText(candidate?.id, 80) === id ? index : -1)
        .filter((index) => index >= 0);
      return candidates.length === 1 ? candidates[0] : -1;
    }
    const serialised = JSON.stringify(row || null);
    return current.findIndex((candidate) => JSON.stringify(candidate || null) === serialised);
  };
  const changes = (Array.isArray(proposal.changes) ? proposal.changes : []).filter((change) => !completed.has(change.id)).flatMap((change) => {
    let beforeIndex;
    if (change.type === 'add') {
      const originalIndex = Number.isInteger(change.beforeIndex) ? change.beforeIndex : Number(change.index) || 0;
      beforeIndex = originalIndex >= original.length ? current.length : rowIndex(original[originalIndex]);
      if (beforeIndex < 0) beforeIndex = Math.min(originalIndex, current.length);
    } else {
      beforeIndex = rowIndex(change.before, change);
      // A destructive/edit suggestion whose named target no longer exists is
      // obsolete. Keeping it with a fallback numeric index lets it point at a
      // completely unrelated action after an autosave or earlier review.
      if (beforeIndex < 0) return [];
    }
    // These are precisely the suggestions the reviewer left unchecked when
    // applying a subset. Persist that choice so a refresh cannot silently
    // select them again.
    return [{
      ...change,
      beforeIndex,
      index: beforeIndex,
      selected: options.preserveSelection === true ? change.selected : false
    }];
  });
  return changes.length ? { ...proposal, changes } : null;
}

function proposalOwnersOf(record = {}) {
  return (Array.isArray(record?.owners) ? record.owners : [])
    .map((owner) => String(owner || '').trim().toLowerCase()).filter(Boolean);
}

function proposalTimingStated(timing = {}) {
  return Boolean(timing && timing.kind && timing.kind !== 'not_stated');
}

function destructiveActionEdit(before = {}, after = {}, sourceUnits = []) {
  const beforeOwners = proposalOwnersOf(before);
  const afterOwners = proposalOwnersOf(after);
  if (beforeOwners.some((owner) => !afterOwners.includes(owner))) return 'it removes an owner';
  if (proposalTimingStated(before.timing) && !proposalTimingStated(after.timing)) return 'it removes the timing';
  if (before.timing?.exactDate && !after.timing?.exactDate) return 'it removes the date';
  if (before.timing?.exactDate && after.timing?.exactDate
    && before.timing.exactDate !== after.timing.exactDate) return 'it changes the date';
  const numericIssue = numericActionEditIssue(before, after);
  if (numericIssue) return numericIssue;
  if (transcriptTextGateEnabled() && transcriptTextIssue(after.action, sourceUnits)) return 'the new wording reads as a line of the conversation';
  return '';
}

function duplicateMeetingAgentActionModification(change = {}, currentRows = []) {
  if (change.type !== 'modify' || !change.before || !change.after) return null;
  const rows = Array.isArray(currentRows) ? currentRows : [];
  const targetIndex = findActionOccurrenceIndex(rows, change.before);
  if (targetIndex < 0) return null;
  const signature = meetingAgentEditableActionSignature(change.after);
  return rows.find((row, index) => index !== targetIndex
    && meetingAgentEditableActionSignature(row) === signature) || null;
}

function automaticMeetingAgentProposalReview(proposal = {}, flags = [], currentRows = [], sourceUnits = []) {
  // Saved selections can predate current proposal checks. Recheck the actual
  // uniquely matched row before a rejected edit can claim its transaction
  // target and suppress a separate safe suggestion for the same occurrence.
  const destructiveModifications = new Map(proposal.stage === 'actions'
    ? (proposal.changes || []).flatMap(change => {
      if (change.type !== 'modify' || !change.before || !change.after) return [];
      const index = findActionOccurrenceIndex(currentRows, change.before);
      if (index < 0) return [];
      const reason = destructiveActionEdit(currentRows[index], change.after, sourceUnits);
      return reason ? [[change.id, reason]] : [];
    }) : []);
  const duplicateModifications = new Set(proposal.stage === 'actions'
    ? (proposal.changes || []).filter(change => duplicateMeetingAgentActionModification(change, currentRows)).map(change => change.id)
    : []);
  const noOpModifications = new Set(proposal.stage === 'actions'
    ? (proposal.changes || []).filter(change => {
      if (change.type !== 'modify' || !change.before || !change.after) return false;
      const index = findActionOccurrenceIndex(currentRows, change.before);
      return index >= 0 && actionProvenanceSignature(currentRows[index])
        === actionProvenanceSignature(preserveActionIdentity(currentRows[index], change.after));
    }).map(change => change.id) : []);
  const referenceReviewChanges = new Set(proposal.stage === 'actions'
    ? (proposal.changes || []).filter(change => requiresDocumentReferenceReview(change.after)).map(change => change.id) : []);
  const proposed = (proposal.changes || []).filter(change => change.selected === true
    && !referenceReviewChanges.has(change.id)
    && !duplicateModifications.has(change.id) && !noOpModifications.has(change.id)
    && !destructiveModifications.has(change.id));
  const unsafeRemovals = new Set();
  let acceptedIds = proposed.map(change => change.id);
  const unapplied = new Set();
  if (proposal.stage === 'actions') {
    // Use the transaction's own occurrence/legacy ambiguity checks and target
    // claims. A covered sentence is not proof that its named occurrence was
    // actually removed, and a second edit of one target cannot both apply.
    // Re-run after refusing an unsafe removal: it must not consume the target
    // of an otherwise valid edit. Each retry removes at least one candidate.
    let candidates = proposed;
    for (;;) {
      const applied = new Set();
      const retained = applyProposal(currentRows, proposal, candidates.map(change => change.id), {
        onAppliedChange: change => applied.add(change.id)
      });
      const rejectedRemovals = candidates.filter(change => change.type === 'remove' && applied.has(change.id)
        && !retained.some(row => actionIsLosslesslyCovered(change.before, row)));
      if (rejectedRemovals.length) {
        rejectedRemovals.forEach(change => unsafeRemovals.add(change.id));
        candidates = candidates.filter(change => !unsafeRemovals.has(change.id));
        continue;
      }
      acceptedIds = candidates.filter(change => applied.has(change.id)).map(change => change.id);
      candidates.filter(change => !applied.has(change.id)).forEach(change => unapplied.add(change.id));
      break;
    }
  }
  const accepted = new Set(acceptedIds);
  const uncertain = (proposal.changes || []).filter(change => !accepted.has(change.id));
  const replacedIds = new Set(uncertain.map(meetingAgentProposalReviewFlagId));
  const checks = uncertain.flatMap((change, index) => {
    const record = change.after || change.before || {};
    const wording = meetingMinutesAgentText(record.action || record.text || record.topic, 1600);
    if (referenceReviewChanges.has(change.id)) {
      const linked = retainedDocumentReferenceReviewFlags([record], flags);
      if (linked.length) return linked;
    }
    const reason = String(referenceReviewChanges.has(change.id)
      ? 'The document reference requires explicit human review.' : duplicateModifications.has(change.id)
      ? 'This edit would copy the wording, owners and timing of another current action.'
      : noOpModifications.has(change.id) ? 'This edit would not change the current action.'
        : destructiveModifications.has(change.id) ? `This edit was left for review because ${destructiveModifications.get(change.id)}.`
          : unsafeRemovals.has(change.id) ? 'The current list does not prove that all of this action survives elsewhere.'
          : unapplied.has(change.id) ? (change.type === 'add'
            ? 'This suggestion did not insert a new action because that occurrence was already present.'
            : 'The proposed occurrence could not be changed uniquely in the current list; it may be stale, ambiguous or already handled by another suggestion.')
            : change.reviewContext?.reason || 'Check the source before changing the minutes.')
      .replace(/\b(?:Tick it[^.]*|It stays unless you tick this)\./gi, '').trim();
    return [normaliseMeetingAgentFlag({
      // This is now a source check, not a link to a consumed proposal. Keep it
      // open even when there is deliberately no corresponding published item.
      id: meetingMinutesAgentText(`automatic-review-${change.id || ''}`, 80),
      kind: change.type === 'add' ? 'possible_missed_follow_up' : 'uncertain_fact',
      ...(noOpModifications.has(change.id) ? {reviewDisposition:'not_applied_noop'}
        : duplicateModifications.has(change.id) ? {reviewDisposition:'not_applied_duplicate'}
          : change.reviewContext?.disposition === 'not_outstanding' ? {reviewDisposition:'not_outstanding'}
            : change.type === 'add' ? {reviewDisposition:'not_applied_addition'} : {}),
      message: `Cannot verify that this AI suggestion should change the minutes; it was not applied. ${wording} ${reason}`,
      evidenceIds: record.evidenceIds || change.reviewContext?.evidenceIds || []
    }, index)];
  });
  return { acceptedIds, reviewFlags: mergeMeetingAgentFlags(
    resolveMeetingAgentProposalFlags(flags, proposal, acceptedIds, []).filter(flag => !replacedIds.has(flag.id)), checks
  ) };
}

function meetingAgentEditableActionSignature(action = {}) {
  return JSON.stringify([
    meetingMinutesAgentText(action?.action || action?.text, 1600),
    (Array.isArray(action?.owners) ? action.owners : []).map((owner) => meetingMinutesAgentText(owner, 180)),
    meetingMinutesAgentText(action?.timing?.kind, 40),
    meetingMinutesAgentText(action?.timing?.wording, 220),
    meetingMinutesAgentText(action?.timing?.exactDate, 20)
  ]);
}

module.exports = {
  rebaseMeetingAgentProposal,
  automaticMeetingAgentProposalReview,
  destructiveActionEdit,
  proposalOwnersOf,
  proposalTimingStated,
  duplicateMeetingAgentActionModification,
  meetingAgentEditableActionSignature,
  retainedDocumentReferenceReviewFlags,
  resolveMeetingAgentProposalFlags
};
