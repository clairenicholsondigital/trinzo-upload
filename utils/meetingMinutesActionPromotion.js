'use strict';

const { actionDispositionWithContext } = require('./meetingMinutesProposalSelection');
const { isVagueReconstructedAction } = require('./meetingMinutesDraftView');
const { hasMeetingAgentReviewerContent } = require('./meetingMinutesPublication');
const { NESTED_STOP, WAY_TO_ACTION, distinctActionDeliverables, hybridActionTypes, hybridCandidateMatchesRecord, isClientReadyActionWording, publishedActionNamesSameThing, strictActionDeliverableMatch } = require('./meetingMinutesActionDuplicatePolicy');
const { hybridTokenOverlap, hybridContentTokenOverlap } = require('./meetingMinutesRecordMatching');
const { normaliseFlag: normaliseMeetingAgentFlag } = require('./meetingMinutesReviewFlags');
const { evidenceSupportScore, surroundingEvidence } = require('./meetingMinutesEvidenceContext');
const { actionEvidenceDisposition, isMeetingAdminAction } = require('./meetingMinutesActionEvidence');
const { meetingMinutesAgentText } = require('./meetingMinutesPlainText');
const { normaliseSourceUnits } = require('./meetingMinutesSource');
const { gateEnabled: transcriptTextGateEnabled, transcriptTextIssue, partitionTranscriptText, rejectionSummary: transcriptTextRejectionSummary } = require('./actionTextGate');
const { commitmentCanBeRepresented } = require('./canonicalMinutes/commitmentDuplicates');
const { actionIsLosslesslyCovered, actionIsSafelyCovered } = require('./canonicalMinutes/actionDuplicateCoverage');
const actionDiagnostics = require('./meetingMinutesActionDiagnostics');
const { uncoveredCandidateInventory } = require('./meetingMinutesDiscoveryInventory');
const { isIdeaOnlyContemplation } = require('./meetingMinutesText');
const { normaliseAgentResult } = require('./meetingMinutesResultNormalization');
const { evidenceClauses } = require('./meetingMinutesActionTimingInference');
const { semanticReceiptCoversActionProposal } = require('./meetingMinutesFinalActionPreservation');
const { sourceSpeakerIdentityScope } = require('./meetingMinutesPromotionSourceIdentity');

// A fully accepted, strongly grounded action must not silently disappear between
// Referee acceptance and the editable Actions list. This is a reconciliation
// invariant, not another extractor: it can only restore a named-owner row which
// already passed the Referee and the existing high-confidence evidence gate.
function reconcileAcceptedRefereeActions(published = [], accepted = [], proposed = [], candidates = [], sourceUnits = []) {
  const actions = [...(Array.isArray(published) ? published : [])];
  const proposals = Array.isArray(proposed) ? proposed : [];
  const restored = [];
  let eligibleCount = 0;
  for (const record of Array.isArray(accepted) ? accepted : []) {
    if (!(record?.owners || []).length || isVagueReconstructedAction(record?.action)
      || !highConfidenceRefereedAction(record, candidates, sourceUnits)) continue;
    eligibleCount += 1;
    if (actions.some((existing) => strictActionDeliverableMatch(record, existing))
      || proposals.some((existing) => strictActionDeliverableMatch(record, existing))) continue;
    actions.push(record);
    restored.push(record);
    actionDiagnostics.transition('restored', [record], [record], { mechanism: 'approved_action_preservation', reason: 'not_proved_represented' });
  }
  const firstEvidence = (record) => Math.min(...(record.evidenceIds || [])
    .map((id) => Number(String(id).match(/\d+/)?.[0] || Infinity)));
  actions.sort((left, right) => firstEvidence(left) - firstEvidence(right)
    || String(left.action || '').localeCompare(String(right.action || '')));
  return { actions, restored, eligibleCount };
}

function isReviewableActionProposal(record = {}, sourceUnits = []) {
  if (!record?.action || !Array.isArray(record.evidenceIds) || !record.evidenceIds.length) return false;
  const evidence = surroundingEvidence(sourceUnits, record.evidenceIds).filter((unit) => unit.cited)
    .map((unit) => `${unit.speaker}: ${unit.text}`).join(' ');
  if (isIdeaOnlyContemplation(`${record.action} ${evidence}`)) return false;
  const disposition = actionDispositionWithContext(record, sourceUnits, evidence);
  // A proposal is still reviewer work. Suggestions, rejected or completed
  // work, status narration and unanswered requests are not uncertain actions;
  // they are non-actions and should not be presented for acceptance.
  return !['suggestion', 'rejected', 'completed', 'status_only', 'meeting_admin', 'unaccepted_request']
    .includes(disposition);
}

function publishedActionCoversProposal(published = {}, proposal = {}) {
  return hybridCandidateCoveredByRecord({
    recordType: 'action', text: proposal.action, evidenceIds: proposal.evidenceIds, record: proposal
  }, published);
}

function meetingAgentCommitmentRecheckNeeded(record = {}, published = []) {
  return isClientReadyActionWording(record.action) && !isMeetingAdminAction(record.action)
    // Similarity is not coverage: two reviews can share an owner, citations
    // and nearly all their words while naming different documents. Uncertain
    // paraphrases should reach the existing quote check instead of vanishing.
    && !published.some((existing) => actionIsLosslesslyCovered(record, existing));
}

function hybridCandidateCoveredByRecord(candidate, record) {
  if (record?._recordType && candidate?.recordType && record._recordType !== candidate.recordType) return false;
  if (candidate?.recordType !== 'action') return hybridCandidateMatchesRecord(candidate, record);
  const action = candidate.record || {};
  const required = {
    ...action,
    action: action.action || candidate.text,
    evidenceIds: action.evidenceIds || candidate.evidenceIds || []
  };
  return actionIsSafelyCovered(required, record)
    || (hybridCandidateMatchesRecord(candidate, record) && commitmentCanBeRepresented(required, record));
}

function hybridCandidateDispositions(candidates = [], published = [], proposed = [], supporting = []) {
  const publishedRows = Array.isArray(published) ? published : [];
  const proposedRows = Array.isArray(proposed) ? proposed : [];
  return (Array.isArray(candidates) ? candidates : []).map((candidate) => {
    const publishMatch = publishedRows.find((record) => hybridCandidateCoveredByRecord(candidate, record));
    const proposalMatch = proposedRows.find((record) => hybridCandidateCoveredByRecord(candidate, record));
    const supportingMatch = (Array.isArray(supporting) ? supporting : []).find((record) => hybridCandidateCoveredByRecord(candidate, record));
    const disposition = publishMatch ? 'publish' : proposalMatch ? 'proposal' : supportingMatch ? 'supporting' : 'reject';
    return {
      candidateId: candidate.candidateId,
      sourcePass: candidate.sourcePass,
      recordType: candidate.recordType,
      disposition,
      matchedRecordId: (publishMatch || proposalMatch)?.id || '',
      reason: publishMatch
        ? 'Represented by an evidence-grounded published record.'
        : proposalMatch
          ? 'Evidence-grounded but retained for reviewer acceptance.'
          : 'Not retained after deliverable-aware evidence adjudication.'
    };
  }).slice(0, 1200);
}

// "Restore the animation on the pricing slide, build the closing slide, and
// re-share the deck once it's done" is three pieces of work. Kept as one row,
// a later merge can keep a wording that drops the first clause, and the
// reader cannot tick off one part. A comma-separated series of instructions,
// each starting with its own verb, becomes one action per instruction; each
// keeps the owners and evidence, and the timing stays with the clause that
// states it. "Build X and send it to Y" (no comma list) is left whole.
const COMPOUND_ACTION_VERBS = 'add|agree|arrange|ask|book|brief|build|call|chase|check|circulate|clarify|collect|complete|confirm|contact|create|draft|email|ensure|find|finalise|finalize|fix|follow|forward|get|identify|investigate|let|message|monitor|move|order|organise|organize|prepare|print|produce|provide|put|raise|re-send|re-share|record|remove|replace|request|reschedule|resend|restore|review|revise|run|schedule|send|set|share|sort|speak|start|submit|talk|test|trace|update|upload|write';

const COMPOUND_SPLIT = new RegExp(String.raw`,\s*(?:and\s+|then\s+|and\s+then\s+)?(?=(?:${COMPOUND_ACTION_VERBS})\b)`, 'i');

function splitCompoundActionList(actions = [], journeyId = '', options = {}) {
  const out = [];
  const splits = [];
  for (const action of Array.isArray(actions) ? actions : []) {
    if (hasMeetingAgentReviewerContent(action)) { out.push(action); continue; }
    const wording = meetingMinutesAgentText(action?.action, 1600).replace(/[.]+$/, '');
    const firstVerb = new RegExp(String.raw`^(?:${COMPOUND_ACTION_VERBS})\b`, 'i').test(wording);
    const parts = firstVerb ? wording.split(COMPOUND_SPLIT).map((part) => part.trim()).filter(Boolean) : [wording];
    // A later clause that points back ("..., and send it to Jo") only makes
    // sense attached to the one before it.
    const pointsBack = parts.slice(1).some((part) => /^\S+\s+(?:it|them|this|that|these|those)\b/i.test(part));
    if (parts.length < 2 || pointsBack || parts.some((part) => part.split(/\s+/).length < 3)) {
      out.push(action);
      continue;
    }
    // A date on the original compound is not evidence that every step shares
    // it. Bind it to a unique explicit clause, or to source wording that names
    // that step. An unresolved binding remains visible as a review flag.
    const canonical = value => String(value || '').normalize('NFKC').toLowerCase()
      .replace(/[’]/g, "'").replace(/[^\p{L}\p{N}' ]/gu, ' ').replace(/\s+/g, ' ').trim();
    const timingWording = canonical(action.timing?.wording || action.timing?.exactDate);
    const timingNeedle = timingWording.replace(/^(?:by|on|at|during)\s+/, '');
    const hasTiming = Boolean(action.timing?.kind && action.timing.kind !== 'not_stated');
    const timedParts = new Set();
    if (hasTiming && timingNeedle) {
      const explicit = parts.map((part, index) => canonical(part).includes(timingNeedle) ? index : -1).filter(index => index >= 0);
      if (explicit.length === 1) timedParts.add(explicit[0]);
      const cited = new Set(action.evidenceIds || []);
      const source = normaliseSourceUnits(options.sourceUnits || []).filter(unit => cited.has(unit.id));
      const timingTokens = new Set(timingWording.split(' '));
      const owners = new Set((action.owners || []).flatMap(owner => canonical(owner).split(' ')));
      const stop = new Set([...NESTED_STOP, 'another', 'related', 'required', 'completed', 'tasks', 'task', 'items', 'steps', 'work']);
      const words = value => new Set((canonical(value).match(/[\p{L}\p{N}']{3,}/gu) || [])
        .filter(word => !stop.has(word) && !timingTokens.has(word) && !owners.has(word)));
      const objects = parts.map(part => words(part.replace(/^\s*\S+\s+/, '')));
      const distinctive = objects.map((tokens, at) => new Set([...tokens].filter(token =>
        objects.every((other, index) => index === at || !other.has(token)))));
      for (const unit of source) {
        const statement = canonical(unit.text);
        if (!statement.includes(timingNeedle)) continue;
        // A refusal, reassignment or later qualification cannot establish the
        // original compound's deadline for one of its newly separated steps.
        if (/\b(?:not|never|cannot|can't|won't|instead|except|excluding|unless|but|however|later|rather than)\b/.test(statement)) continue;
        const sourceWords = words(unit.text);
        const speakerWords = new Set(canonical(unit.speaker).split(' ').filter(word => word.length > 1));
        const otherFutureSubject = [...String(unit.text || '').matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(?:will|shall|must|is\s+going\s+to)\b/g)]
          .some(match => !/^(?:We|They|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/.test(match[1])
            && !canonical(match[1]).split(' ').every(word => owners.has(word)));
        const ownerNamed = (action.owners || []).some(owner => {
          const name = canonical(owner);
          const nameWords = name.split(' ').filter(word => word.length > 1);
          const ownsTurn = name === canonical(unit.speaker)
            || (nameWords.length >= 2 && nameWords.every(word => speakerWords.has(word)));
          const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const assignedDirectly = new RegExp(`\\b${escaped}\\s+(?:will|shall|must|is\\s+to)\\b`).test(statement);
          return !otherFutureSubject && (ownsTurn || assignedDirectly);
        });
        if (!ownerNamed) continue;
        const commonDeadline = /\b(?:both|all|each)(?:\s+(?:of\s+)?(?:these|those|the))?(?:\s+(?:tasks?|items?|steps?|actions?|jobs?|deliverables?))?\s+(?:are|is|will|must|need|needs|should|due|by|before)\b/.test(statement)
          && !/\b(?:not|never|except|excluding)\b/.test(statement)
          && objects.every(tokens => [...tokens].some(token => sourceWords.has(token)));
        if (commonDeadline) { parts.forEach((_, index) => timedParts.add(index)); break; }
        if (explicit.length) continue;
        const exactStep = parts.map((part, index) => canonical(part).split(' ').length >= 3
          && statement.includes(canonical(part)) ? index : -1).filter(index => index >= 0);
        if (exactStep.length === 1) { timedParts.add(exactStep[0]); continue; }
        const matches = distinctive.map((tokens, index) => tokens.size
          && [...tokens].filter(token => sourceWords.has(token)).length >= Math.min(2, tokens.size) ? index : -1)
          .filter(index => index >= 0);
        if (matches.length === 1) timedParts.add(matches[0]);
      }
    }
    let timingFlag = null;
    if (hasTiming && !timedParts.size) {
      timingFlag = normaliseMeetingAgentFlag({
        kind: 'timing',
        message: `The timing "${action.timing?.wording || action.timing?.exactDate}" could not be assigned safely to a step in "${wording}". Confirm which work it concerns.`,
        evidenceIds: action.evidenceIds || []
      });
      if (Array.isArray(options.flags)) options.flags.push(timingFlag);
    }
    parts.forEach((part, index) => {
      const sentence = `${part.charAt(0).toUpperCase()}${part.slice(1)}.`;
      const keepsTiming = hasTiming && timedParts.has(index);
      out.push({
        ...action,
        id: index === 0 ? action.id : `${action.id}-part${index + 1}`,
        action: sentence,
        timing: keepsTiming ? { ...action.timing } : { kind: 'not_stated', wording: '', exactDate: '' },
        ...(timingFlag ? { reviewFlagIds: [...new Set([...(action.reviewFlagIds || []), timingFlag.id])] } : {})
      });
    });
    splits.push({ from: meetingMinutesAgentText(action.action, 200), parts: parts.length });
  }
  if (splits.length) console.log(JSON.stringify({ event: 'meeting_agent_compound_action_split', journeyId, splits }));
  return out;
}

function hybridActionSourceInfo(action, candidates = []) {
  const matches = candidates.filter((candidate) => candidate.recordType === 'action' && hybridCandidateMatchesRecord(candidate, action));
  const discoverySources = [...new Set(matches.map((candidate) => candidate.sourcePass).filter((source) => ['staged', 'primary', 'primary-2', 'recovery', 'salvage'].includes(source)))];
  const explicitDeterministic = matches.some((candidate) => candidate.sourcePass === 'deterministic' && ['committed', 'accepted_request'].includes(candidate.dispositionHint));
  return { discoverySources, explicitDeterministic, candidateIds: matches.map((candidate) => candidate.candidateId) };
}

function highConfidenceRefereedAction(action, candidates = [], sourceUnits = []) {
  if (!action?.action || !Array.isArray(action.evidenceIds) || !action.evidenceIds.length) return false;
  if (Array.isArray(action.reviewFlagIds) && action.reviewFlagIds.length) return false;
  const sourceInfo = hybridActionSourceInfo(action, candidates);
  if (!sourceInfo.discoverySources.some((source) => source === 'primary' || source === 'recovery')) return false;
  const evidence = surroundingEvidence(sourceUnits, action.evidenceIds).filter((unit) => unit.cited)
    .map((unit) => `${unit.speaker}: ${unit.text}`).join(' ');
  if (evidenceSupportScore(action.action, evidence) < 0.3) return false;
  return ['committed', 'accepted_request', 'conditional_commitment']
    .includes(actionDispositionWithContext(action, sourceUnits, evidence));
}

function safeAgentProposalPromotion(action, candidates = [], sourceUnits = []) {
  if (!action?.action || !Array.isArray(action.evidenceIds) || !action.evidenceIds.length) return false;
  if (transcriptTextGateEnabled() && transcriptTextIssue(action.action, sourceUnits)) return false;
  // A documentation promise proves commitment, not every owner, timing,
  // quantity or source concern. Use the same review gate as other promotions;
  // the candidate remains available for explicit reviewer acceptance.
  if (Array.isArray(action.reviewFlagIds) && action.reviewFlagIds.length) return false;
  const explicitDocumentation = explicitFutureDocumentationCommitment(action, sourceUnits);
  const sourceInfo = hybridActionSourceInfo(action, candidates);
  const evidence = surroundingEvidence(sourceUnits, action.evidenceIds).filter((unit) => unit.cited)
    .map((unit) => `${unit.speaker}: ${unit.text}`).join(' ');
  if (isIdeaOnlyContemplation(`${action.action} ${evidence}`)) return false;
  if (explicitDocumentation) return true;
  // Nobody shown taking it on: it stays a suggestion ("no owner"), however
  // many passes found it. Adding an owner is the reviewer's call.
  if (!(action.owners || []).length) return false;
  const support = evidenceSupportScore(action.action, evidence);
  const disposition = actionDispositionWithContext(action, sourceUnits, evidence);
  if (!['committed', 'accepted_request', 'conditional_commitment'].includes(disposition)) return false;
  // Two independent Agent discovery passes are sufficient even when their
  // formal wording is slightly broader than one cited turn. A deterministic
  // accepted/committed chain may also supply the second independent signal.
  return repeatedOwnerCommitment(action, sourceUnits)
    || (sourceInfo.discoverySources.length >= 2 && support >= 0.24)
    || (sourceInfo.explicitDeterministic && support >= 0.3)
    || highConfidenceRefereedAction(action, candidates, sourceUnits);
}

// A concrete first-person promise to write the meeting record does not need a
// second model pass. Keep this narrow: one named owner must speak the cited
// future-tense words, and the public action must share their material subject.
function explicitFutureDocumentationCommitment(action = {}, sourceUnits = []) {
  const actionOpening = String(action.action || '').match(/^\s*(?:write(?: down)?|document|record|note)\b/i);
  if ((action.owners || []).length !== 1 || !actionOpening) return false;
  const identityScope = sourceSpeakerIdentityScope(sourceUnits);
  const ownerIdentity = identityScope.resolve(action.owners[0]);
  if (!ownerIdentity) return false;
  const actionSubject = String(action.action).slice(actionOpening[0].length);
  // Separate operations in either wording need ordinary proposal review.
  const hasCoordinatedOperation = (subject) => {
    const tail = subject.match(/\b(?:and(?:\s+then)?|then|but|while)\s+(.+)$/i)?.[1] || '';
    return hybridActionTypes(tail, { includeDocumentation: true }).size > 0
      || /\b(?:and|but|then|while)\s+(?:i|we|you|he|she|they|it|there)\b/i.test(subject);
  };
  if (hasCoordinatedOperation(actionSubject)) return false;
  const cited = new Set((action.evidenceIds || []).map(String));
  return normaliseSourceUnits(sourceUnits).some((unit) => {
    if (!cited.has(String(unit.id))) return false;
    if (identityScope.resolve(unit.speaker) !== ownerIdentity) return false;
    // Subject proof only narrows the original gate. Splitting a long turn
    // must not raise its overlap enough to create a newly eligible shortcut.
    if (hybridContentTokenOverlap(action.action, unit.text) < 0.24) return false;
    return evidenceClauses(unit.text).some((clause) => {
      const promise = clause.match(/\bi(?:'m| am)\s+going\s+to\s+(?:write(?: down)?|document|record|note)\b|\bi(?:'ll| will)\s+(?:write(?: down)?|document|record|note)\b/i);
      if (!promise) return false;
      const promisedSubject = clause.slice(promise.index + promise[0].length);
      if (hasCoordinatedOperation(promisedSubject)) return false;
      // Shared write/down/record words do not identify the promised work.
      // Reuse the material-subject guard with the same neutral lead verb,
      // and bind it to the promise's own clause rather than another sentence.
      if (distinctActionDeliverables({ action: `Record ${actionSubject}` },
        { action: `Record ${promisedSubject}` })) return false;
      return hybridContentTokenOverlap(action.action, clause) >= 0.24;
    });
  });
}

// A direct commitment which is repeated in the meeting's action recap is
// stronger than a single model classification. This is deliberately strict:
// the same named owner must speak both cited lines, both lines must describe
// the action, and the confirmations must be separated in the transcript.
function repeatedOwnerCommitment(action = {}, sourceUnits = []) {
  const identityScope = sourceSpeakerIdentityScope(sourceUnits);
  const ownerIdentities = new Set((action.owners || []).map(owner => identityScope.resolve(owner)).filter(Boolean));
  if (!ownerIdentities.size || !(action.evidenceIds || []).length) return false;
  const units = new Map(normaliseSourceUnits(sourceUnits).map((unit, index) => [unit.id, {
    ...unit,
    index: Number(String(unit.id || '').match(/\d+/)?.[0] || index)
  }]));
  const commitment = /\b(?:i(?:'ll| will| can| am going to|'m going to)|we(?:'ll| will| can| are going to)|leave (?:it|that|this) with me|will do)\b|^\s*me\s*[,;:-]/i;
  const supportedByOwner = new Map();
  for (const unit of (action.evidenceIds || []).map(id => units.get(id)).filter(Boolean)) {
    const identity = identityScope.resolve(unit.speaker);
    if (!ownerIdentities.has(identity) || !commitment.test(unit.text)
      || hybridContentTokenOverlap(action.action, unit.text) < 0.24) continue;
    if (!supportedByOwner.has(identity)) supportedByOwner.set(identity, []);
    supportedByOwner.get(identity).push(unit.index);
  }
  return [...supportedByOwner.values()].some(indices => indices.length >= 2
    && Math.max(...indices) - Math.min(...indices) >= 3);
}

// Reuse the existing final critic as the targeted promotion referee. An action
// remains a proposal after one discovery/referee result, but a materially
// matching result from the independent critic supplies the second judgement
// needed for safe automatic publication. Deterministic commitments may also be
// promoted when the critic independently reconstructs and validates them.
function criticConfirmedActionPromotions(criticActions = [], singleSource = [], candidates = [], sourceUnits = [], options = {}) {
  const promoted = [];
  for (const criticAction of Array.isArray(criticActions) ? criticActions : []) {
    if (!criticAction?.action || !criticAction.evidenceIds?.length || criticAction.reviewFlagIds?.length) continue;
    const evidence = surroundingEvidence(sourceUnits, criticAction.evidenceIds).filter((unit) => unit.cited)
      .map((unit) => `${unit.speaker}: ${unit.text}`).join(' ');
    if (evidenceSupportScore(criticAction.action, evidence) < 0.3) continue;
    if (!['committed', 'accepted_request', 'conditional_commitment'].includes(actionEvidenceDisposition(criticAction.action, evidence))) continue;
    const matchingReferee = (singleSource || []).find((record) => hybridCandidateMatchesRecord({
      recordType: 'action', text: record.action, evidenceIds: record.evidenceIds, record
    }, criticAction));
    const deterministic = hybridActionSourceInfo(criticAction, candidates).explicitDeterministic;
    if (!matchingReferee && !deterministic) continue;
    const preferred = matchingReferee || criticAction;
    promoted.push({
      ...preferred,
      evidenceIds: [...new Set([...(preferred.evidenceIds || []), ...(criticAction.evidenceIds || [])])].slice(0, 8)
    });
  }
  return normaliseAgentResult({ actions: promoted }, sourceUnits, 'actions', {
    meetingDate: options.meetingDate
  }).actions;
}

// Personal errands mentioned in passing ("I need to book a holiday") are not
// meeting actions and should never be offered as suggestions.
const PERSONAL_ERRAND_ACTION = /^\s*(?:book|plan|take|go on|arrange|sort(?: out)?)\s+(?:a |an |my |the |some )?(?:holiday|vacation|annual leave|day off|dentist|doctor(?:['’]s)?(?: appointment)?|haircut|hair appointment|gym|birthday|anniversary|wedding|vet)\b|^\s*(?:walk|feed)\s+the\s+(?:dog|cat)\b|\bschool run\b/i;

function isPersonalErrandAction(value = '') {
  return PERSONAL_ERRAND_ACTION.test(meetingMinutesAgentText(value, 400));
}

function removePublishedActionProposalDuplicates(proposal = {}, published = [], options = {}) {
  const publishedRows = Array.isArray(published) ? published : [];
  return {
    ...proposal,
    changes: (Array.isArray(proposal?.changes) ? proposal.changes : []).filter((change) => {
      if (change?.type !== 'add' || !change.after?.action) return true;
      if (isPersonalErrandAction(change.after.action)) return false;
      return !semanticReceiptCoversActionProposal(change.after, publishedRows, options)
        && !publishedRows.some((record) => publishedActionCoversProposal(record, change.after));
    })
  };
}

const MEETING_AGENT_UNCERTAINTY_WORDS = { unclear_reference: 'what it refers to', acceptance: 'whether it was accepted', ownership: 'who owns it' };

const MEETING_AGENT_SIGNAL_WORDS = { request: 'asked', offer: 'offered', acceptance: 'agreed', commitment: 'committed', completed: 'done', rejected: 'declined' };

function annotateActionProposalChains(proposal = {}, chains = []) {
  const chainRows = (Array.isArray(chains) ? chains : []).filter((candidate) => candidate?.recordType === 'action_chain');
  return {
    ...proposal,
    changes: (Array.isArray(proposal?.changes) ? proposal.changes : []).map((change) => {
      if (change?.type !== 'add' || !change.after?.action) return change;
      const evidence = new Set(change.after.evidenceIds || []);
      const ranked = chainRows.map((chain) => ({
        chain,
        shared: (chain.evidenceIds || []).filter((id) => evidence.has(id)).length,
        lexical: hybridTokenOverlap(change.after.action, chain.text || '')
      })).filter((item) => item.shared > 0)
        .sort((left, right) => (right.shared * 3 + right.lexical) - (left.shared * 3 + left.lexical));
      const match = ranked[0]?.chain;
      if (!match) return change;
      const signalOrder = ['request', 'offer', 'acceptance', 'commitment', 'completed', 'rejected'];
      const signals = signalOrder.filter((name) => match.signals?.[name]);
      const uncertainties = [...new Set((match.uncertainties || []).map((item) => item.kind).filter(Boolean))];
      const reason = uncertainties.length
        ? `The transcript suggests this task, but ${uncertainties.map((value) => MEETING_AGENT_UNCERTAINTY_WORDS[value] || value.replace(/_/g, ' ')).join(' and ')} still needs confirming.`
        : 'The transcript suggests someone took this on, but not clearly enough to add it automatically. Check the linked lines and add it if it is a real action.';
      return { ...change, reviewContext: {
        label: signals.length ? signals.map((name) => MEETING_AGENT_SIGNAL_WORDS[name] || name).join(', then ') : 'related transcript lines',
        reason, evidenceIds: [...new Set(match.evidenceIds || [])].slice(0, 12),
        actionConfidence: match.scores?.action
      } };
    })
  };
}

function strongUnresolvedActionCandidateFlags(candidates = [], records = []) {
  const strong = uncoveredCandidateInventory(candidates, records).filter((candidate) => {
    const cues = new Set(candidate?.cueKinds || []);
    return cues.has('decision_resolution') && ['committed', 'accepted_request', 'conditional_commitment'].includes(candidate?.dispositionHint);
  }).sort((left, right) => Number((right.cueKinds || []).includes('decision_resolution')) - Number((left.cueKinds || []).includes('decision_resolution'))
    || Number(right.priority || 0) - Number(left.priority || 0)
    || Number(left.sequence || 0) - Number(right.sequence || 0));
  const selected = [];
  for (const candidate of strong) {
    const ids = new Set(candidate.evidenceIds || []);
    const duplicatesExisting = selected.some((existing) => (existing.evidenceIds || []).filter((id) => ids.has(id)).length >= 2);
    if (!duplicatesExisting) selected.push(candidate);
    if (selected.length >= 8) break;
  }
  return selected.map((candidate, index) => normaliseMeetingAgentFlag({
    kind: 'possible_missed_follow_up',
    message: 'A strongly evidenced commitment to plan or resolve an open decision was not represented in the action register. Review the cited passage and add it if appropriate.',
    evidenceIds: candidate.evidenceIds || []
  }, index));
}

// An unowned action that repeats an owned one (same opening verb, at least 80%
// of its subject words) is folded into the owned version, keeping its evidence.
const FOLD_STOP = new Set(['with', 'that', 'this', 'from', 'into', 'their', 'there', 'about', 'which', 'where', 'when', 'before', 'after', 'once', 'what', 'will', 'would', 'should', 'could', 'have', 'been', 'being', 'including', 'required', 'needed', 'relevant', 'related', 'whether']);

function foldSubjectWords(text) {
  return new Set((String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9-]{3,}/g) || [])
    .filter((word) => !FOLD_STOP.has(word)).map((word) => word.replace(/(?:ing|ed|es|s)$/, '')));
}

function foldUnownedNearCopies(actions = [], journeyId = '') {
  const list = Array.isArray(actions) ? actions : [];
  const folded = [];
  const kept = list.filter((action) => {
    if ((action.owners || []).length) return true;
    const verb = String(action.action || '').trim().split(/\s+/)[0]?.toLowerCase();
    const words = foldSubjectWords(String(action.action || '').split(/\s+/).slice(1).join(' '));
    if (!verb || words.size < 3) return true;
    const partner = list.find((other) => other !== action && (other.owners || []).length
      && ((String(other.action || '').trim().split(/\s+/)[0]?.toLowerCase() === verb
        && [...words].filter((word) => foldSubjectWords(other.action).has(word)).length / words.size >= 0.8)
        // Or the same specific thing under a different verb.
        || publishedActionNamesSameThing(other, action)
        // An unowned row is the weakest kind of duplicate: nobody is shown
        // taking it on, and an owned action already describes the same work
        // in different words ("Figure out a way to give her access" beside
        // "Arrange secure SharePoint access"). Substantial word overlap is
        // enough here, without a shared phrase.
        || (!distinctActionDeliverables(other, action)
          && hybridContentTokenOverlap(other.action, action.action) >= 0.45)
        // "Figure out a way to get her access" beside "Work out secure
        // transmission ... and provide her with SharePoint access": a way-to
        // paraphrase of work somebody owns. The distinct-deliverable test is
        // deliberately not applied - such a row names no deliverable of its
        // own, which is what makes it a paraphrase.
        || (WAY_TO_ACTION.test(action.action || '')
          && hybridContentTokenOverlap(other.action, action.action) >= 0.25)));
    if (!partner) return true;
    partner.evidenceIds = [...new Set([...(partner.evidenceIds || []), ...(action.evidenceIds || [])])].slice(0, 12);
    folded.push({ removed: meetingMinutesAgentText(action.action, 160), into: meetingMinutesAgentText(partner.action, 160) });
    return false;
  });
  if (folded.length) console.log(JSON.stringify({ event: 'meeting_agent_unowned_copy_folded', journeyId, folded }));
  return kept;
}

function gateTranscriptShapedActions(records = [], sourceUnits = [], journeyId = '', stage = '') {
  const { kept, rejected } = partitionTranscriptText(records, sourceUnits);
  if (rejected.length) {
    console.log(JSON.stringify({
      event: 'meeting_agent_transcript_text_gate', journeyId, stage,
      removed: rejected.length, items: transcriptTextRejectionSummary(rejected)
    }));
  }
  return kept;
}

function gateTranscriptShapedActionChanges(changes = [], sourceUnits = [], journeyId = '', stage = '') {
  const rejected = [];
  const kept = (Array.isArray(changes) ? changes : []).filter((change) => {
    if (!['add', 'modify'].includes(change?.type) || !change.after) return true;
    const reason = transcriptTextGateEnabled() ? transcriptTextIssue(change.after.action, sourceUnits) : '';
    if (reason) rejected.push({ record: change.after, reason });
    return !reason;
  });
  if (rejected.length) {
    console.log(JSON.stringify({
      event: 'meeting_agent_transcript_text_gate', journeyId, stage,
      removed: rejected.length, items: transcriptTextRejectionSummary(rejected)
    }));
  }
  return kept;
}

module.exports = {
  annotateActionProposalChains,
  MEETING_AGENT_SIGNAL_WORDS,
  MEETING_AGENT_UNCERTAINTY_WORDS,
  criticConfirmedActionPromotions,
  hybridActionSourceInfo,
  foldUnownedNearCopies,
  foldSubjectWords,
  FOLD_STOP,
  gateTranscriptShapedActionChanges,
  gateTranscriptShapedActions,
  highConfidenceRefereedAction,
  hybridCandidateCoveredByRecord,
  hybridCandidateDispositions,
  isReviewableActionProposal,
  meetingAgentCommitmentRecheckNeeded,
  publishedActionCoversProposal,
  reconcileAcceptedRefereeActions,
  removePublishedActionProposalDuplicates,
  isPersonalErrandAction,
  PERSONAL_ERRAND_ACTION,
  safeAgentProposalPromotion,
  explicitFutureDocumentationCommitment,
  repeatedOwnerCommitment,
  splitCompoundActionList,
  COMPOUND_ACTION_VERBS,
  COMPOUND_SPLIT,
  strongUnresolvedActionCandidateFlags,
};
