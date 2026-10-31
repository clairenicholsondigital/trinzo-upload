'use strict';

const { actionCandidateInventory, actionCommitmentChainInventory, actionCommitmentThreadInventory, DISCUSSION_UNRESOLVED_POSITION_PATTERN, LOW_INFORMATION_UTTERANCE } = require('./meetingMinutesActionCandidateInventory');
const { salientDetailInventory, MEETING_ADMIN_PATTERN } = require('./meetingMinutesAssessmentEvidence');
const { evidenceSupportScore, includedUnit } = require('./meetingMinutesEvidenceContext');
const { normaliseSourceUnits } = require('./meetingMinutesSource');
const { stableId, contentTokens } = require('./meetingMinutesRecordMatching');
const { text } = require('./meetingMinutesText');
const { DELIVERABLE_CONTEXT_PATTERN, LEAVING_REMARK_PATTERN, actionEvidenceFits, actionPredicatesCompatible } = require('./meetingMinutesActionEvidence');

// The discovery inventory lists one commitment up to three times: as a chain,
// as the thread inside it, and as each raw candidate the chain was built
// from. Every coverage test (recovery, critic, salvage) then counts the same
// gap three times. Keep the chain, drop the members it already contains.
function dedupeActionDiscoveryInventory(chains = [], threads = [], candidates = []) {
  const covered = new Set();
  const chainCovered = new Set();
  const candidatesById = new Map((Array.isArray(candidates) ? candidates : [])
    .map((candidate) => [String(candidate?.candidateId || ''), candidate]));
  const retainedComponentIds = new Set();
  for (const chain of chains) {
    const members = (chain?.candidateIds || []).map((id) => candidatesById.get(String(id))).filter(Boolean);
    const actionFamilies = new Set(members.map((candidate) => String(candidate?.actionFamily || '').trim()).filter(Boolean));
    // A chain is a context graph, not automatically one deliverable. Keep its
    // component candidates when it contains different operations so that the
    // referee can retain separate send/test, trace/incorporate, or review/follow-up
    // work. Same-operation request/acceptance pairs remain safely collapsed.
    if (actionFamilies.size > 1) {
      for (const member of members) retainedComponentIds.add(String(member.candidateId));
    }
    for (const id of chain?.candidateIds || []) {
      chainCovered.add(String(id));
      if (!retainedComponentIds.has(String(id))) covered.add(String(id));
    }
  }
  const keptThreads = threads.filter((thread) => {
    const members = (thread?.candidateIds || []).map(String);
    return !(members.length && members.every((id) => chainCovered.has(id)));
  });
  for (const thread of keptThreads) for (const id of thread?.candidateIds || []) covered.add(String(id));
  const keptCandidates = candidates.filter((candidate) => !covered.has(String(candidate?.candidateId || '')));
  return [...chains, ...keptThreads, ...keptCandidates];
}

function deterministicHybridLedger(draft, stage) {
  if (stage === 'actions') {
    const candidates = actionCandidateInventory(draft.sourceUnits);
    const rows = candidates.map((candidate) => ({
      ...candidate, sourcePass: 'deterministic', recordType: 'action', text: candidate.focusText,
      record: { action: candidate.focusText, owners: [], timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: candidate.evidenceIds }
    }));
    return [
      ...actionCommitmentChainInventory(draft.sourceUnits, candidates),
      ...actionCommitmentThreadInventory(draft.sourceUnits, candidates),
      ...rows
    ];
  }
  return discussionCandidateInventory(draft.sourceUnits).map((candidate) => ({
    ...candidate, sourcePass: 'deterministic', recordType: candidate.kindHints?.includes('decision') ? 'decision' : candidate.kindHints?.includes('open_question') ? 'open_question' : 'discussion_point',
    text: candidate.focusText, record: { text: candidate.focusText, evidenceIds: candidate.evidenceIds }
  }));
}

// Declarative technical behaviour is discussion evidence even when it contains no
// decision, owner or future action. Giving it an explicit candidate kind protects
// statements such as "the device does not..." from being crowded out by commitments.
const TECHNICAL_BEHAVIOUR_PATTERN = /\b(?:the|a|an)\s+(?:device|system|software|application|platform|interface|firmware|product|feature|module|component|test|procedure|process)\b[^.!?]{0,140}\b(?:is|are|was|were|does|do|did|doesn['’]t|do not|did not|can|cannot|will|supports?|allows?|prevents?|requires?)\b/i;

// Preserve generic responsibility boundaries, provisional workstream
// allocation and operational coordination for later classification.
const MATERIAL_DISCUSSION_CONTEXT_PATTERN = /\b(?:corporate|head office|site[- ]level|top[- ]level|handled (?:at|by)|fed down|responsibil(?:ity|ities)|separate track|workstream|in parallel|coordinate|coordination|handover|debrief|end of day|after (?:the )?site|on the way back|return journey)\b/i;

const DISCUSSION_DECISION_PATTERN = /\b(?:agreed|decided|confirmed|approved|accepted|selected|settled|concluded|signed off|will proceed|going ahead|the decision)\b/i;

const DISCUSSION_QUESTION_PATTERN = /\?|\b(?:open question|outstanding|to be confirmed|to be decided|not (?:yet )?(?:decided|confirmed|clear|resolved)|need to (?:confirm|clarify|determine|decide)|whether|which option|who will)\b/i;

const DISCUSSION_NEGATIVE_POSITION_PATTERN = /\b(?:(?:i|we)\s+(?:will not|won['’]?t|am not going to|are not going to|do not agree|don['’]?t agree|cannot accept|can['’]?t accept|refuse|decline)|i['’](?:ll not|m not going to)|we['’](?:ll not|re not going to))\b/i;

function discussionCandidateInventory(units = []) {
  const rows = normaliseSourceUnits(units).filter(includedUnit);
  const salientIds = new Set(salientDetailInventory(rows).flatMap((item) => item.evidenceIds || []));
  const actionIds = new Set(actionCandidateInventory(rows).map((item) => item.focusEvidenceId));
  const candidates = [];
  for (let index = 0; index < rows.length; index += 1) {
    const unit = rows[index];
    const words = contentTokens(unit.text);
    if (LOW_INFORMATION_UTTERANCE.test(unit.text) || words.length < 4) continue;
    if ((MEETING_ADMIN_PATTERN.test(unit.text) || LEAVING_REMARK_PATTERN.test(unit.text)) && !DELIVERABLE_CONTEXT_PATTERN.test(unit.text)) continue;
    const kindHints = [
      DISCUSSION_DECISION_PATTERN.test(unit.text) ? 'decision' : '',
      DISCUSSION_QUESTION_PATTERN.test(unit.text) ? 'open_question' : '',
      DISCUSSION_NEGATIVE_POSITION_PATTERN.test(unit.text) ? 'negative_position' : '',
      DISCUSSION_UNRESOLVED_POSITION_PATTERN.test(unit.text) ? 'unresolved_position' : '',
      salientIds.has(unit.id) ? 'important_detail' : '',
      TECHNICAL_BEHAVIOUR_PATTERN.test(unit.text) ? 'technical_behaviour' : '',
      actionIds.has(unit.id) ? 'action_context' : '',
      MATERIAL_DISCUSSION_CONTEXT_PATTERN.test(unit.text) ? 'material_context' : '',
      'discussion_fact'
    ].filter(Boolean);
    const window = rows.slice(Math.max(0, index - 1), Math.min(rows.length, index + 2));
    const context = window.map((item) => `${item.speaker}: ${item.text}`).join(' ');
    candidates.push({
      candidateId: stableId('discussion-candidate', unit.id),
      focusEvidenceId: unit.id,
      evidenceIds: window.map((item) => item.id),
      kindHints,
      priority: (kindHints.includes('decision') ? 4 : 0)
        + (kindHints.includes('open_question') ? 3 : 0)
        + (kindHints.includes('negative_position') || kindHints.includes('unresolved_position') ? 4 : 0)
        + (kindHints.includes('important_detail') ? 3 : 0)
        + (kindHints.includes('technical_behaviour') ? 4 : 0)
        + (kindHints.includes('action_context') ? 2 : 0)
        + (kindHints.includes('material_context') ? 2 : 0)
        + Math.min(2, Math.floor(words.length / 12)),
      sequence: unit.sequence,
      focusText: text(unit.text, 500),
      context: text(context, 900)
    });
  }
  return candidates;
}

function candidateRepresented(candidate, records = []) {
  const focus = candidate?.focusEvidenceId;
  const candidateIds = new Set(candidate?.evidenceIds || []);
  const candidateEvidence = candidate?.context || candidate?.focusText || '';
  const actionCandidate = ['action', 'action_chain', 'action_thread'].includes(candidate?.recordType)
    || Array.isArray(candidate?.cueKinds);
  return (Array.isArray(records) ? records : []).some((record) => {
    // A sentence may legitimately be both a decision and a future commitment.
    // Discussion coverage therefore cannot discharge an action candidate.
    if (actionCandidate && !record?.action) return false;
    const recordIds = Array.isArray(record?.evidenceIds) ? record.evidenceIds : [];
    const recordText = record?.action || record?.text || '';
    if (record?.action && candidate?.record?.action
      && !actionPredicatesCompatible(candidate.record.action, record.action)) return false;
    const candidateOwners = candidate?.record?.owners || [];
    const recordOwners = record?.owners || [];
    if (record?.action && candidateOwners.length && recordOwners.length
      && !candidateOwners.some((owner) => recordOwners.some((other) => String(other).toLowerCase() === String(owner).toLowerCase()))) return false;
    if (focus && recordIds.includes(focus)) {
      if (record?.action && !actionEvidenceFits(record.action, candidateEvidence)) return false;
      return evidenceSupportScore(recordText, candidateEvidence) >= 0.16;
    }
    const sharedIds = recordIds.filter((id) => candidateIds.has(id));
    const sharesEvidence = sharedIds.length > 0;
    if (!sharesEvidence) return false;
    // A neighbouring candidate window can overlap another action's evidence.
    // Unless the generated record cites this candidate's focus turn directly,
    // keep the comparison anchored to that focus so adjacent deliverables do
    // not incorrectly mark one another as covered.
    const comparisonEvidence = sharedIds.length >= 2 ? candidateEvidence : (candidate?.focusText || candidateEvidence);
    if (record?.action && !actionEvidenceFits(record.action, comparisonEvidence)) return false;
    return evidenceSupportScore(recordText, comparisonEvidence) >= 0.24;
  });
}

function uncoveredCandidateInventory(candidates = [], records = []) {
  return (Array.isArray(candidates) ? candidates : []).filter((candidate) => !candidateRepresented(candidate, records));
}

module.exports = {
  dedupeActionDiscoveryInventory,
  deterministicHybridLedger,
  discussionCandidateInventory,
  DISCUSSION_DECISION_PATTERN,
  DISCUSSION_NEGATIVE_POSITION_PATTERN,
  DISCUSSION_QUESTION_PATTERN,
  MATERIAL_DISCUSSION_CONTEXT_PATTERN,
  TECHNICAL_BEHAVIOUR_PATTERN,
  uncoveredCandidateInventory,
  candidateRepresented,
};
