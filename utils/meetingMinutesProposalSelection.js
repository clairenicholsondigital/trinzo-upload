'use strict';

const { ACTION_DEPENDENCY_CLAUSE, distinctActionDeliverables, hybridActionTypes, sharesDistinctivePhrase } = require('./meetingMinutesActionDuplicatePolicy');
const { acceptanceAroundEvidence } = require('./meetingMinutesActionAcceptance');
const { actionEvidenceDisposition } = require('./meetingMinutesActionEvidence');
const { destructiveActionEdit, duplicateMeetingAgentActionModification, meetingAgentEditableActionSignature, proposalOwnersOf } = require('./meetingMinutesProposalReview');
const { filterIncompleteProposalChanges } = require('./meetingMinutesDraftView');
const { hybridContentTokenOverlap, hybridTokenOverlap } = require('./meetingMinutesRecordMatching');
const { meetingMinutesAgentText } = require('./meetingMinutesPlainText');
const { normaliseSourceUnits } = require('./meetingMinutesSource');

function hybridActionsEquivalent(left = '', right = '') {
  const leftTypes = hybridActionTypes(left);
  const rightTypes = hybridActionTypes(right);
  if (leftTypes.size && rightTypes.size && ![...leftTypes].some((type) => rightTypes.has(type))) return false;
  return hybridTokenOverlap(left, right) >= 0.55;
}

function actionDispositionWithContext(action = {}, sourceUnits = [], evidence = '') {
  const disposition = actionEvidenceDisposition(action?.action || '', evidence);
  if (!['unclear', 'unaccepted_request'].includes(disposition)) return disposition;
  return acceptanceAroundEvidence(action, sourceUnits) || disposition;
}

const PRESELECTABLE_ADD_DISPOSITIONS = new Set(['committed', 'accepted_request', 'conditional_commitment']);

function proposalEvidenceText(sourceUnits = [], evidenceIds = []) {
  const byId = new Map(normaliseSourceUnits(sourceUnits).map((unit) => [unit.id, unit]));
  return (Array.isArray(evidenceIds) ? evidenceIds : []).map((id) => byId.get(id)).filter(Boolean)
    .map((unit) => `${unit.speaker || ''}: ${unit.text || ''}`).join(' ');
}

function withSelection(change, selected, context = null) {
  const next = { ...change, selected };
  if (context && !change.reviewContext) next.reviewContext = context;
  return next;
}

function echoesPublishedAction(published = {}, proposal = {}) {
  const a = meetingMinutesAgentText(published.action, 1600);
  const b = meetingMinutesAgentText(proposal.action, 1600);
  if (!a || !b) return false;
  // A different wait condition does not make the underlying deliverable a
  // different action for duplicate-suggestion review. The normal action
  // deduper still preserves meaningful conditions; this narrower check only
  // decides whether an optional suggestion should be pre-ticked.
  const withoutDependency = (value) => String(value || '')
    .replace(ACTION_DEPENDENCY_CLAUSE, '')
    .replace(/[\s,.;:]+$/, '');
  if (distinctActionDeliverables(published, proposal)
    && distinctActionDeliverables({ action: withoutDependency(a) }, { action: withoutDependency(b) })) return false;
  const unhyphen = (value) => String(value || '').replace(/(\w)-(\w)/g, '$1 $2');
  return sharesDistinctivePhrase(a, b) || hybridContentTokenOverlap(unhyphen(a), unhyphen(b)) >= 0.45;
}

function preselectActionProposal(proposal, resulting = [], sourceUnits = []) {
  proposal = filterIncompleteProposalChanges(proposal, sourceUnits);
  if (!proposal || !Array.isArray(proposal.changes)) return proposal;
  const removedTargets = new Set(proposal.changes.filter((change) => change.type === 'remove')
    .map((change) => change.before).filter(Boolean));
  const removedIds = new Set([...removedTargets].map((row) => row.id).filter(Boolean));
  const survivors = [
    ...(Array.isArray(resulting) ? resulting : []).filter((row) => !removedTargets.has(row) && !(row?.id && removedIds.has(row.id))),
    ...proposal.changes.filter((change) => ['add', 'modify'].includes(change.type) && change.after).map((change) => change.after)
  ];
  const changes = proposal.changes.map((change) => {
    // An earlier check deliberately left this for the reviewer (answered in
    // the meeting, completed, a social aside...). Never re-tick it.
    if (change.selected === false) return change;
    if (change.type === 'remove') {
      const removed = change.before || {};
      const removedOwners = proposalOwnersOf(removed);
      const partner = survivors.find((row) => row && row !== removed && (!row.id || row.id !== removed.id)
        && hybridActionsEquivalent(removed.action || '', row.action || '')
        && (!removedOwners.length || !proposalOwnersOf(row).length || proposalOwnersOf(row).some((owner) => removedOwners.includes(owner))));
      if (partner) {
        return withSelection(change, true, {
          label: 'duplicate',
          reason: `Duplicates "${meetingMinutesAgentText(partner.action, 200)}", which stays in the list.`,
          evidenceIds: removed.evidenceIds || []
        });
      }
      return withSelection(change, false, {
        label: 'removal not confirmed',
        reason: 'A later check did not reproduce this action, but nothing shows it is wrong or a duplicate. It stays unless you tick this.',
        evidenceIds: removed.evidenceIds || []
      });
    }
    if (change.type === 'modify') {
      const duplicate = duplicateMeetingAgentActionModification(change, resulting);
      if (duplicate) {
        return withSelection(change, false, {
          label: 'already in the list',
          reason: 'This edit would copy the wording, owners and timing of another action. Tick it only if both occurrences are intended.',
          evidenceIds: change.after?.evidenceIds || change.before?.evidenceIds || []
        });
      }
      const lost = destructiveActionEdit(change.before || {}, change.after || {}, sourceUnits);
      if (lost) {
        return withSelection(change, false, {
          label: 'edit loses detail',
          reason: `Left unticked because ${lost}. Tick it only if the current version is wrong.`,
          evidenceIds: change.after?.evidenceIds || change.before?.evidenceIds || []
        });
      }
      return withSelection(change, true);
    }
    if (change.type === 'add') {
      const record = change.after || {};
      if (!proposalOwnersOf(record).length) {
        return withSelection(change, false, {
          label: 'no owner',
          reason: 'Nobody is shown taking this on. Tick it and add an owner if it is a real commitment.',
          evidenceIds: record.evidenceIds || []
        });
      }
      // Applying a suggestion that repeats an action already in the list
      // creates the duplicate the deduper just avoided. The bar here is lower
      // than the bar for dropping it: the owner may differ (the same follow-up
      // meeting offered under a second name), and the reviewer can still tick
      // it. See echoesPublishedAction.
      const echoed = (Array.isArray(resulting) ? resulting : [])
        .find((row) => row && row !== record && echoesPublishedAction(row, record));
      if (echoed) {
        return withSelection(change, false, {
          label: 'already in the list',
          reason: `This looks like "${meetingMinutesAgentText(echoed.action, 200)}", which is already an action. Tick it only if it is separate work.`,
          evidenceIds: record.evidenceIds || []
        });
      }
      // A 40-word "action" listing hotels, dates, travel and report writing is
      // a summary of the meeting. Offer it, but never apply it unasked.
      if (meetingMinutesAgentText(record.action, 1600).split(/\s+/).filter(Boolean).length > 40) {
        return withSelection(change, false, {
          label: 'reads as a summary',
          reason: 'This is long enough to be a summary of several things rather than one deliverable. Tick it only if it is a single action.',
          evidenceIds: record.evidenceIds || []
        });
      }
      const evidence = proposalEvidenceText(sourceUnits, record.evidenceIds);
      const disposition = evidence ? actionDispositionWithContext(record, sourceUnits, evidence) : 'unclear';
      if (!PRESELECTABLE_ADD_DISPOSITIONS.has(disposition)) {
        return withSelection(change, false, {
          label: 'commitment not clear',
          reason: 'The cited lines do not clearly show this being agreed. Tick it if it was.',
          evidenceIds: record.evidenceIds || []
        });
      }
      // Everything above has been ruled out: this addition is owned, distinct,
      // short enough to be one deliverable and clearly evidenced. It is still
      // offered unticked. A pre-ticked suggestion is applied by default, and
      // the ones that survive to here are exactly the plausible-looking rows a
      // reviewer waves through - DITA's duplicate Cody follow-up arrived that
      // way. Adding an action is the change a reviewer should make on purpose.
      return withSelection(change, false, {
        label: 'ready to add',
        reason: 'This reads as a clear, owned commitment in the cited lines. Tick it to add it.',
        evidenceIds: record.evidenceIds || []
      });
    }
    return withSelection(change, false);
  });
  return { ...proposal, changes };
}

function preselectDiscussionProposal(proposal) {
  proposal = filterIncompleteProposalChanges(proposal);
  if (!proposal || !Array.isArray(proposal.changes)) return proposal;
  return {
    ...proposal,
    changes: proposal.changes.map((change) => {
      if (change.selected === false) return change;
      if (change.type === 'remove') {
        return withSelection(change, false, {
          label: 'removal not confirmed',
          reason: 'The regenerated discussion left this out. It stays unless you tick this.',
          evidenceIds: change.before?.evidenceIds || []
        });
      }
      return withSelection(change, true);
    })
  };
}

function preselectRequestedProposal(proposal) {
  proposal = filterIncompleteProposalChanges(proposal);
  if (!proposal || !Array.isArray(proposal.changes)) return proposal;
  return { ...proposal, changes: proposal.changes.map((change) => ({ ...change, selected: change.selected !== false })) };
}

function meetingAgentProposalChangeIsVisible(change = {}) {
  if (change?.type !== 'modify') return true;
  return meetingAgentEditableActionSignature(change.before) !== meetingAgentEditableActionSignature(change.after);
}

module.exports = {
  hybridActionsEquivalent,
  actionDispositionWithContext,
  PRESELECTABLE_ADD_DISPOSITIONS,
  proposalEvidenceText,
  withSelection,
  echoesPublishedAction,
  preselectActionProposal,
  preselectDiscussionProposal,
  preselectRequestedProposal,
  meetingAgentProposalChangeIsVisible
};
