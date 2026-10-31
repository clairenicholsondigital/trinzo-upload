'use strict';

const { normaliseSourceUnits } = require('./meetingMinutesSource');
const { includedUnit, materialTokens } = require('./meetingMinutesEvidenceContext');
const { stableId, contentTokens } = require('./meetingMinutesRecordMatching');
const { text, isIdeaOnlyContemplation } = require('./meetingMinutesText');
const {
  ACTION_ACCEPTANCE_PATTERN, ACTION_COMMITMENT_PATTERN, ACTION_COMPLETED_PATTERN,
  ACTION_CONCRETE_INTENTION_PATTERN, ACTION_JOINT_INTENTION_PATTERN, ACTION_REQUEST_PATTERN,
  ACTION_SCHEDULED_DELIVERABLE_PATTERN, ACTION_VERB_GROUPS, NAMED_WILL_PATTERN,
  actionEvidenceDisposition, isDecisionResolutionCommitment, isLiveCallConduct
} = require('./meetingMinutesActionEvidence');

const ACTION_PASSIVE_OBLIGATION_PATTERN =/\b(?:(?:is|are|was|were|will be)\s+)?(?:required|needed|expected|planned|scheduled|assigned)\s+to\b|\b(?:needs?|requires?)\s+(?:approval|assessment|completion|confirmation|documentation|follow[- ]?up|investigation|review|testing|updat(?:e|ing)|validation)\b/i;

const ACTION_FOLLOW_UP_PATTERN = /\b(?:action point|next step|take[- ]?away|follow[- ]?up|circle back|come back (?:to|with)|pick (?:this|that|it) up|look into|find out|make sure|ensure|sort (?:this|that|it) out|leave (?:this|that|it) with)\b/i;

const ACTION_IMPERATIVE_PATTERN = /^\s*(?:[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]{2,}\s*,\s*)?(?:(?:and|then|also)\s+)?(?:(?:when|once|after|before)\b.{0,100}?,\s*)?(?:please\s+)?(?:send|share|provide|forward|review|check|assess|create|produce|prepare|draft|update|revise|complete|finish|confirm|clarify|determine|test|verify|contact|call|message|schedule|arrange|document)\b/i;

const ACTION_CONCRETE_OFFER_PATTERN = /\b(?:I|we)\s+(?:can|could|would be able to|am available to|are available to)\s+(?:have a look at|attend|check|collect|contact|deliver|go|handle|prepare|provide|review|send|speak|test|visit)\b/i;

const DISCUSSION_UNRESOLVED_POSITION_PATTERN = /\b(?:i|we)\s+(?:do not|don['’]?t)\s+know\b|\b(?:no clear|no obvious)\s+answer\b|\bnot (?:yet )?(?:known|clear|decided|resolved)\b/i;

const ACTION_EXPLICIT_RESOLUTION_AFTER_UNCERTAINTY = /\b(?:i|we)\s*(?:['’]ll|will|am going to|are going to)\s+(?:ask|check|clarify|confirm|contact|find out|investigate|review|verify)\b/i;

const LOW_INFORMATION_UTTERANCE = /^(?:yes|yeah|yep|no|nope|okay|ok|right|fine|great|thanks|thank you|sure|agreed|exactly|correct|perfect|lovely|brilliant|understood|makes sense|i see|mm+|uh+|hello|hi|bye)[.!? ]*$/i;

// "Hannah, will you get that in his diary?" "I'll do it now." A request put
// to a named person and answered by that person's own first-person commitment
// is accepted work, although the reply never says yes or okay. The reply must
// come from the person addressed, within the next two rows, without refusing.
const ADDRESSED_REQUEST_OPENING = /^\s*(?:(?:and|so|right|okay|ok|then|also)\s*,?\s+)?([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’-]{1,})\s*,\s*(?:(?:and|so|then|also|just)\s+)?(?:(?:can|could|would|will)\s+you\b|(?:please\s+)?(?:you(?:['’]re|\s+are)\s+(?:going\s+to|doing|on|taking))\b)/;

const REPLY_FIRST_PERSON_COMMITMENT = /\b(?:i['’]ll|i\s+will|i\s+can|i['’]m\s+going\s+to|i\s+am\s+going\s+to|let\s+me|will\s+do|can\s+do|on\s+it)\b/i;

const REPLY_REFUSAL = /\b(?:can['’]?t|cannot|won['’]?t|will\s+not|not\s+(?:able|going)\s+to|i['’]ll\s+not|no\s+(?:time|capacity))\b/i;

function addressedRequestAcceptedAhead(unit = {}, following = []) {
  const addressee = String(unit.text || '').match(ADDRESSED_REQUEST_OPENING)?.[1];
  if (!addressee) return false;
  const wanted = addressee.toLowerCase();
  const reply = following.find((row) => row && row.speaker !== unit.speaker);
  if (!reply) return false;
  const replier = String(reply.speaker || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (!replier.includes(wanted)) return false;
  const value = String(reply.text || '');
  return REPLY_FIRST_PERSON_COMMITMENT.test(value) && !REPLY_REFUSAL.test(value);
}

function actionCandidateInventory(units = []) {
  const rows = normaliseSourceUnits(units).filter(includedUnit);
  const candidates = [];
  for (let index = 0; index < rows.length; index += 1) {
    const unit = rows[index];
    const previous = rows.slice(Math.max(0, index - 2), index).map((row) => row.text).join(' ');
    const following = rows.slice(index + 1, Math.min(rows.length, index + 3)).map((row) => row.text).join(' ');
    const directCue = ACTION_COMMITMENT_PATTERN.test(unit.text)
      || ACTION_CONCRETE_INTENTION_PATTERN.test(unit.text)
      || ACTION_JOINT_INTENTION_PATTERN.test(unit.text)
      || NAMED_WILL_PATTERN.test(unit.text)
      || ACTION_REQUEST_PATTERN.test(unit.text)
      || ACTION_PASSIVE_OBLIGATION_PATTERN.test(unit.text)
      || ACTION_SCHEDULED_DELIVERABLE_PATTERN.test(unit.text)
      || ACTION_FOLLOW_UP_PATTERN.test(unit.text)
      || ACTION_CONCRETE_OFFER_PATTERN.test(unit.text)
      || isDecisionResolutionCommitment(unit.text)
      || ACTION_IMPERATIVE_PATTERN.test(unit.text);
    const contextualAcceptance = ACTION_ACCEPTANCE_PATTERN.test(unit.text)
      && (ACTION_REQUEST_PATTERN.test(previous) || ACTION_COMMITMENT_PATTERN.test(previous) || NAMED_WILL_PATTERN.test(previous)
        || ACTION_PASSIVE_OBLIGATION_PATTERN.test(previous) || ACTION_FOLLOW_UP_PATTERN.test(previous));
    const addressedAccepted = addressedRequestAcceptedAhead(unit, rows.slice(index + 1, index + 3));
    const acceptedRequestAhead = (ACTION_REQUEST_PATTERN.test(unit.text) && ACTION_ACCEPTANCE_PATTERN.test(following))
      || addressedAccepted;
    const acceptedOfferAhead = ACTION_CONCRETE_OFFER_PATTERN.test(unit.text)
      && (ACTION_REQUEST_PATTERN.test(following) || ACTION_IMPERATIVE_PATTERN.test(following));
    const explicitAcceptedCommitment = ACTION_ACCEPTANCE_PATTERN.test(unit.text)
      && (ACTION_COMMITMENT_PATTERN.test(unit.text) || ACTION_CONCRETE_INTENTION_PATTERN.test(unit.text));
    if (!directCue && !contextualAcceptance && !acceptedOfferAhead) continue;
    // Running the call is not a candidate for anything.
    if (isLiveCallConduct(unit.text)) continue;
    // An honest unknown is meeting content, not a promise. Keep an explicit
    // follow-up ("I don't know; I'll check tomorrow"), but do not manufacture
    // work from "I don't know" or "I'll know after the meeting".
    if (DISCUSSION_UNRESOLVED_POSITION_PATTERN.test(unit.text)
      && !ACTION_EXPLICIT_RESOLUTION_AFTER_UNCERTAINTY.test(unit.text)) continue;
    // Bare acknowledgements inherit the nearby request's context, but adding each
    // "Okay", "Yep" or "Will do" as a separate high-priority candidate crowds real
    // commitments out of bounded referee prompts. The request/offer candidate already
    // carries the acknowledgement in its evidence window.
    const bareContextualAcceptance = contextualAcceptance
      && !directCue
      && !explicitAcceptedCommitment
      && (/^(?:yes|yeah|yep|okay|ok|sure|agreed|fine|right|will do|can do|happy to)[.!? ]*$/i.test(unit.text));
    if (bareContextualAcceptance) continue;
    const windowStart = Math.max(0, index - 2);
    const windowEnd = Math.min(rows.length, index + 3);
    const ids = rows.slice(windowStart, windowEnd).map((item) => item.id);
    const context = rows.slice(windowStart, windowEnd)
      .map((item) => `${item.speaker}: ${item.text}`).join(' ');
    const cueKinds = [
      ACTION_COMMITMENT_PATTERN.test(unit.text) || ACTION_CONCRETE_INTENTION_PATTERN.test(unit.text)
        || ACTION_JOINT_INTENTION_PATTERN.test(unit.text) || NAMED_WILL_PATTERN.test(unit.text) ? 'commitment' : '',
      ACTION_REQUEST_PATTERN.test(unit.text) ? 'request' : '',
      ACTION_CONCRETE_OFFER_PATTERN.test(unit.text) ? 'offer' : '',
      contextualAcceptance || acceptedRequestAhead || explicitAcceptedCommitment ? 'acceptance' : '',
      acceptedOfferAhead ? 'acceptance' : '',
      ACTION_PASSIVE_OBLIGATION_PATTERN.test(unit.text) ? 'obligation' : '',
      ACTION_SCHEDULED_DELIVERABLE_PATTERN.test(unit.text) ? 'scheduled' : '',
      ACTION_FOLLOW_UP_PATTERN.test(unit.text) ? 'follow_up' : '',
      isDecisionResolutionCommitment(unit.text) ? 'decision_resolution' : '',
      ACTION_IMPERATIVE_PATTERN.test(unit.text) ? 'imperative' : ''
    ].filter(Boolean);
    const candidate = {
      candidateId: stableId('candidate', unit.id),
      focusEvidenceId: unit.id,
      evidenceIds: ids,
      // Keep the accountable speaker and operation available to the action
      // inventory deduper. A commitment chain is useful context, but a chain
      // containing different operations (for example send -> test) must not
      // hide the component deliverables from the referee.
      speaker: text(unit.speaker, 180),
      actionFamily: chainActionFamily(unit.text),
      dispositionHint: acceptedOfferAhead || addressedAccepted ? 'accepted_request' : actionEvidenceDisposition(unit.text, context),
      cueKinds: addressedAccepted ? [...cueKinds, 'addressed'] : cueKinds,
      priority: (contextualAcceptance || acceptedRequestAhead || acceptedOfferAhead ? 4 : 0)
        + (addressedAccepted ? 3 : 0)
        + (cueKinds.includes('commitment') ? 3 : 0)
        + (cueKinds.includes('decision_resolution') ? 3 : 0)
        + (cueKinds.includes('obligation') || cueKinds.includes('follow_up') ? 2 : 0)
        + ((cueKinds.includes('commitment') || cueKinds.includes('scheduled'))
          && /\b(?:today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\s+(?:week|month)|this\s+(?:week|month)|by|before|within|after)\b|\b\d+\s+(?:additional\s+|extra\s+|more\s+)?[a-z][\w-]*/i.test(unit.text) ? 3 : 0)
        + 1,
      sequence: unit.sequence,
      focusText: text(unit.text, 500),
      context: text(context, 900)
    };
    candidates.push(candidate);
    // One speaking turn can contain several separately accountable promises.
    // Keeping only the whole turn gives a bounded model one compound candidate
    // and makes it easy for the first or last deliverable to disappear. Add a
    // focused candidate for each repeated first-person future clause; later
    // deliverable-aware accounting still decides whether two clauses are the
    // same work. A single promise is left unchanged to avoid ledger inflation.
    const promiseMarker = /\b(?:I|we)\s*(?:['’]ll|will|shall|am going to|are going to)\s+/ig;
    const promiseStarts = [...String(unit.text || '').matchAll(promiseMarker)];
    if (promiseStarts.length > 1) {
      promiseStarts.forEach((match, clauseIndex) => {
        const start = Number(match.index || 0) + match[0].length;
        const end = clauseIndex + 1 < promiseStarts.length
          ? Number(promiseStarts[clauseIndex + 1].index) : String(unit.text || '').length;
        // The cut lands just before the next promise marker, so the clause
        // can end on the joint ("...for Dermot and then"). Trim the joint;
        // a clause that only ran the call is not a candidate either.
        const focusText = trimDanglingTail(text(String(unit.text || '').slice(start, end)
          .replace(/^\s*[,;:.–—-]+\s*/, ''), 500));
        if (contentTokens(focusText).length < 2 || isLiveCallConduct(focusText)) return;
        candidates.push({
          ...candidate,
          candidateId: stableId('candidate-clause', `${unit.id}|${clauseIndex + 1}|${focusText}`),
          focusText,
          cueKinds: [...new Set([...candidate.cueKinds, 'commitment'])],
          priority: candidate.priority + 1
        });
      });
    }
  }
  // This is the full server-side ledger. Prompt-size control happens separately
  // so a candidate omitted from the first request remains available to the
  // targeted completeness audit rather than disappearing at extraction time.
  return candidates;
}

const CHAIN_REFERENCE_PATTERN = /\b(?:it|that|this|these|those|there|the former|the latter|that one|this one)\b/i;

const CHAIN_REJECTION_PATTERN = /\b(?:(?:will not|won't|do not|don't|not going to)\s+(?:do|proceed|continue|send|share|review|update|complete|test|schedule|arrange|accept|approve|need|plan|intend|want)|no action|leave (?:it|that) for now|defer(?:red)?|park(?:ed|ing)?)\b/i;

const CHAIN_TIME_PATTERN = /\b(?:today|tomorrow|this (?:week|month)|next (?:week|month)|(?:next )?(?:monday|tuesday|wednesday|thursday|friday)|before [^.,;]{2,60}|after [^.,;]{2,60}|once [^.,;]{2,60}|until [^.,;]{2,60}|by (?:the )?\d{1,2}(?:st|nd|rd|th)?(?:\s+[A-Za-z]+)?|\d{1,2}\s+[A-Za-z]+(?:\s+\d{4})?)\b/i;

const CHAIN_GENERIC_TOKENS = new Set([
  'about', 'action', 'actually', 'after', 'again', 'also', 'another', 'before', 'could',
  'discussion', 'going', 'have', 'just', 'meeting', 'might', 'need', 'needed', 'please',
  'probably', 'really', 'should', 'something', 'that', 'their', 'them', 'then', 'there',
  'these', 'they', 'thing', 'things', 'this', 'those', 'want', 'will', 'with', 'would'
]);

function chainActionFamily(value = '') {
  const words = contentTokens(value);
  const group = ACTION_VERB_GROUPS.find((verbs) => words.some((word) => verbs.includes(word)));
  return group ? group[0] : '';
}

function chainAnchors(value = '', speakerNames = []) {
  const people = new Set(speakerNames.flatMap((name) => contentTokens(name)));
  const verbs = new Set(ACTION_VERB_GROUPS.flat());
  return [...new Set(materialTokens(value).filter((word) => word.length > 2
    && !CHAIN_GENERIC_TOKENS.has(word) && !people.has(word) && !verbs.has(word)))].slice(0, 18);
}

function chainMentionedSpeakers(value = '', speakers = []) {
  const sourceTokens = new Set(contentTokens(value));
  return speakers.filter((speaker) => {
    const parts = contentTokens(speaker);
    if (!parts.length) return false;
    return parts.every((part) => sourceTokens.has(part))
      || (parts[0].length >= 3 && sourceTokens.has(parts[0]));
  });
}

function chainEventKind(candidate, unit) {
  const cues = new Set(candidate.cueKinds || []);
  const source = unit?.text || candidate.focusText || '';
  if (CHAIN_REJECTION_PATTERN.test(source)) return 'rejection_or_deferral';
  if (ACTION_COMPLETED_PATTERN.test(source)) return 'completion_or_status';
  if (cues.has('acceptance') && LOW_INFORMATION_UTTERANCE.test(source)) return 'acceptance';
  if (cues.has('offer')) return 'offer';
  if (cues.has('request') || cues.has('imperative')) return 'request_or_assignment';
  if (cues.has('obligation')) return 'obligation';
  if (cues.has('scheduled')) return 'scheduled_work';
  if (cues.has('commitment') || cues.has('follow_up') || cues.has('decision_resolution')) return 'commitment';
  return 'candidate';
}

function chainSetOverlap(left = [], right = []) {
  const a = new Set(left);
  const b = new Set(right);
  if (!a.size || !b.size) return 0;
  const shared = [...a].filter((item) => b.has(item)).length;
  return shared / Math.min(a.size, b.size);
}

function chainLinkScore(event, chain) {
  const prior = chain.events.at(-1);
  const distance = Number(event.sequence || 0) - Number(prior?.sequence || 0);
  const totalSpan = Number(event.sequence || 0) - Number(chain.events[0]?.sequence || 0);
  if (distance < 0 || distance > 48 || totalSpan > 48) return { score: -1, reasons: [] };
  const reasons = [];
  let score = 0;
  const anchorOverlap = chainSetOverlap(event.anchors, chain.anchors);
  if (anchorOverlap >= 0.5) { score += 5; reasons.push('shared deliverable terms'); }
  else if (anchorOverlap > 0) { score += 3; reasons.push('shared topic term'); }
  const chainSpeakers = new Set(chain.speakers);
  const namedBridge = event.mentionedSpeakers.some((name) => chainSpeakers.has(name))
    || chain.events.some((item) => item.mentionedSpeakers.includes(event.speaker));
  if (namedBridge) { score += 3; reasons.push('named participant link'); }
  const sharedSpeaker = Boolean(event.speaker && chainSpeakers.has(event.speaker));
  if (sharedSpeaker && distance <= 12) { score += 1; reasons.push('same speaker'); }
  const lifecycle = new Set(chain.events.map((item) => item.kind));
  const completesRequest = ['acceptance', 'commitment', 'offer', 'scheduled_work'].includes(event.kind)
    && (lifecycle.has('request_or_assignment') || lifecycle.has('offer'));
  if (completesRequest) { score += 2; reasons.push('commitment lifecycle'); }
  if (event.actionFamily && event.actionFamily === chain.actionFamily) { score += 2; reasons.push('compatible action type'); }
  const sameTiming = event.timingText && chain.timingTexts.includes(event.timingText.toLowerCase());
  if (sameTiming) { score += 2; reasons.push('shared timing'); }
  if (event.referential && (namedBridge || distance <= 4)) { score += 2; reasons.push('referential continuation'); }
  if (distance <= 4) { score += 2; reasons.push('adjacent exchange'); }
  else if (distance > 24) score -= 1;
  const strongLongLink = (namedBridge && event.referential)
    || (sameTiming && event.actionFamily && event.actionFamily === chain.actionFamily)
    || (anchorOverlap >= 0.75 && event.actionFamily && event.actionFamily === chain.actionFamily);
  if (totalSpan > 20 && !strongLongLink) score = -1;
  // Distant same-speaker chatter is not a chain without a shared object,
  // participant, timing or compatible lifecycle.
  if (distance > 12 && !anchorOverlap && !namedBridge && !sameTiming) score = -1;
  return { score, reasons };
}

function summariseCommitmentChain(events, speakers = []) {
  const signalKinds = new Set(events.map((event) => event.kind));
  const signalCues = new Set(events.flatMap((event) => event.cueKinds || []));
  const combinedText = events.map((event) => event.text).join(' ');
  const evidenceIds = [...new Set(events.map((event) => event.unitId))].slice(0, 12);
  const ownerEvidence = events.filter((event) => {
    if (!event.speaker || /^we\b/i.test(event.text)) return false;
    return ['offer', 'commitment', 'acceptance', 'scheduled_work'].includes(event.kind)
      && /\bI\b|\bI['’](?:ll|m|ve)\b/i.test(event.text);
  });
  const ownerHints = [...new Set(ownerEvidence.map((event) => event.speaker))];
  const hasRequest = signalKinds.has('request_or_assignment') || signalCues.has('request') || signalCues.has('imperative');
  const hasAcceptance = signalKinds.has('acceptance') || signalCues.has('acceptance');
  const hasCommitment = signalKinds.has('commitment') || signalKinds.has('scheduled_work') || signalCues.has('commitment');
  const hasOffer = signalKinds.has('offer') || signalCues.has('offer');
  const offerEvents = events.filter((event) => event.kind === 'offer');
  const offerAccepted = !offerEvents.length || offerEvents.some((offer) => events.some((event) => {
    if (Number(event.sequence || 0) <= Number(offer.sequence || 0)) return false;
    const explicitAcceptance = (event.cueKinds || []).includes('acceptance')
      && ['acceptance', 'commitment'].includes(event.kind);
    const scopedAssignment = event.kind === 'request_or_assignment' && event.speaker !== offer.speaker
      && event.linkReasons.includes('referential continuation');
    return explicitAcceptance || scopedAssignment;
  }));
  const rejected = signalKinds.has('rejection_or_deferral');
  const completed = signalKinds.has('completion_or_status') && !hasCommitment;
  const ideaOnly = isIdeaOnlyContemplation(combinedText);
  const hasConcreteActionFamily = events.some((event) => event.actionFamily);
  const referentialEvents = events.filter((event) => event.referential);
  const unresolvedReferences = referentialEvents.filter((event) => {
    const hasObjectLink = event.linkReasons.some((reason) => ['shared deliverable terms', 'shared topic term'].includes(reason));
    const hasNamedContinuation = event.linkReasons.includes('named participant link')
      && event.linkReasons.includes('referential continuation');
    const acceptedShorthand = /^(?:yes|yeah|yep|okay|ok|sure)?[, ]*(?:I|we)\s+(?:will|'ll|can)\s+(?:do|handle|take)\s+(?:it|that)\b/i.test(event.text);
    const earlierObjectCount = new Set(events.filter((other) => Number(other.sequence || 0) < Number(event.sequence || 0))
      .flatMap((other) => other.anchors)).size;
    return !hasObjectLink && !hasNamedContinuation && !acceptedShorthand
      && (earlierObjectCount > 1 || !event.anchors.length);
  })
    .map((event) => event.unitId);
  let actionConfidence = hasCommitment ? 0.82 : hasRequest && hasAcceptance ? 0.84 : hasOffer && hasAcceptance ? 0.82
    : hasOffer ? 0.48 : hasRequest ? 0.42 : 0.55;
  if (rejected || completed) actionConfidence = 0.05;
  if (ideaOnly) actionConfidence = 0.1;
  if (hasCommitment && !hasConcreteActionFamily && !hasRequest && !hasOffer) actionConfidence = Math.min(actionConfidence, 0.25);
  if (hasOffer && !offerAccepted) actionConfidence = Math.min(actionConfidence, 0.68);
  if (unresolvedReferences.length) actionConfidence = Math.min(actionConfidence, 0.64);
  const ownerConfidence = ownerHints.length === 1 ? 0.9 : ownerHints.length > 1 ? 0.72 : 0;
  const timingEvents = events.filter((event) => event.timingText);
  const timingConfidence = timingEvents.length ? 0.85 : 0;
  const dispositionHint = rejected ? 'rejected' : completed ? 'completed' : ideaOnly ? 'suggestion'
    : actionConfidence >= 0.78 ? (hasRequest || hasAcceptance ? 'accepted_request' : 'committed')
      : (hasOffer || hasRequest ? 'proposal' : 'unclear');
  const focus = [...events].sort((left, right) => Number(right.priority || 0) - Number(left.priority || 0))[0];
  return {
    candidateId: stableId('commitment-chain', evidenceIds.join('|')),
    sourcePass: 'deterministic', recordType: 'action_chain',
    focusEvidenceId: focus?.unitId || evidenceIds[0],
    candidateIds: events.map((event) => event.candidateId), evidenceIds,
    cueKinds: [...new Set(events.flatMap((event) => event.cueKinds))],
    dispositionHint,
    priority: Math.round(actionConfidence * 10) + (hasRequest && (hasAcceptance || hasCommitment) ? 3 : 0),
    sequence: Math.min(...events.map((event) => Number(event.sequence || 0))),
    ownerHints, timingEvidenceIds: timingEvents.map((event) => event.unitId),
    dependencyEvidenceIds: events.filter((event) => /\b(?:if|once|after|before|until|subject to|depends? on)\b/i.test(event.text)).map((event) => event.unitId),
    signals: {
      request: hasRequest, offer: hasOffer, acceptance: hasAcceptance, offerAccepted,
      commitment: hasCommitment, completed, rejected
    },
    scores: { action: actionConfidence, owner: ownerConfidence, timing: timingConfidence },
    uncertainties: [
      ...(unresolvedReferences.length ? [{ kind: 'unclear_reference', evidenceIds: unresolvedReferences }] : []),
      ...(hasOffer && !offerAccepted ? [{ kind: 'acceptance', evidenceIds: offerEvents.map((event) => event.unitId) }] : []),
      ...(!ownerHints.length ? [{ kind: 'ownership', evidenceIds }] : [])
    ],
    eventUnits: events.map((event) => ({
      evidenceId: event.unitId, kind: event.kind, speaker: event.speaker, actionFamily: event.actionFamily,
      linkReasons: event.linkReasons
    })),
    topicAnchors: [...new Set(events.flatMap((event) => event.anchors))].slice(0, 18),
    text: combinedText,
    context: events.map((event) => `[${event.unitId}] ${event.speaker}: ${event.text}`).join('\n')
  };
}

// Build a second, bounded cross-turn graph alongside the deliberately local
// action-thread inventory. It can reconnect a request, later acceptance and
// recap across intervening conversation, but only through compatible topic,
// participant, timing or reference evidence.
function actionCommitmentChainInventory(units = [], suppliedCandidates) {
  const rows = normaliseSourceUnits(units).filter(includedUnit);
  const byId = new Map(rows.map((unit) => [unit.id, unit]));
  const speakers = [...new Set(rows.map((unit) => text(unit.speaker, 180)).filter(Boolean))];
  const candidates = (Array.isArray(suppliedCandidates) ? suppliedCandidates : actionCandidateInventory(rows))
    .filter((candidate) => byId.has(candidate.focusEvidenceId))
    .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
  const events = candidates.map((candidate) => {
    const unit = byId.get(candidate.focusEvidenceId);
    const timingText = text(String(unit.text || '').match(CHAIN_TIME_PATTERN)?.[0], 100);
    return {
      candidateId: candidate.candidateId, unitId: unit.id, sequence: unit.sequence,
      speaker: unit.speaker, text: text(unit.text, 700), priority: candidate.priority,
      cueKinds: candidate.cueKinds || [], kind: chainEventKind(candidate, unit),
      anchors: chainAnchors(unit.text, speakers), mentionedSpeakers: chainMentionedSpeakers(unit.text, speakers),
      actionFamily: chainActionFamily(unit.text), timingText,
      referential: CHAIN_REFERENCE_PATTERN.test(unit.text), linkReasons: []
    };
  });
  const chains = [];
  for (const event of events) {
    let best = null;
    for (const chain of chains) {
      const link = chainLinkScore(event, chain);
      if (link.score >= 4 && (!best || link.score > best.link.score)) best = { chain, link };
    }
    if (!best) {
      chains.push({
        events: [event], anchors: [...event.anchors], speakers: [event.speaker].filter(Boolean),
        actionFamily: event.actionFamily, timingTexts: event.timingText ? [event.timingText.toLowerCase()] : []
      });
      continue;
    }
    event.linkReasons = best.link.reasons;
    best.chain.events.push(event);
    best.chain.anchors = [...new Set([...best.chain.anchors, ...event.anchors])];
    best.chain.speakers = [...new Set([...best.chain.speakers, event.speaker].filter(Boolean))];
    if (!best.chain.actionFamily && event.actionFamily) best.chain.actionFamily = event.actionFamily;
    if (event.timingText) best.chain.timingTexts.push(event.timingText.toLowerCase());
  }
  return chains.map((chain) => summariseCommitmentChain(chain.events, speakers))
    .filter((chain) => chain.evidenceIds.length && chain.dispositionHint !== 'completed')
    .sort((left, right) => Number(right.priority || 0) - Number(left.priority || 0)
      || Number(left.sequence || 0) - Number(right.sequence || 0))
    .slice(0, 160);
}

function actionCommitmentThreadInventory(units = [], suppliedCandidates) {
  const rows = normaliseSourceUnits(units).filter(includedUnit);
  const byId = new Map(rows.map((unit) => [unit.id, unit]));
  const candidates = (Array.isArray(suppliedCandidates) ? suppliedCandidates : actionCandidateInventory(rows))
    .filter((candidate) => candidate?.focusEvidenceId && byId.has(candidate.focusEvidenceId))
    .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
  const groups = [];
  for (const candidate of candidates) {
    const previous = groups.at(-1);
    const sequence = Number(candidate.sequence || byId.get(candidate.focusEvidenceId)?.sequence || 0);
    const previousSequence = Number(previous?.at(-1)?.sequence || 0);
    const groupStart = Number(previous?.[0]?.sequence || sequence);
    const previousEvidence = new Set((previous || []).flatMap((item) => item.evidenceIds || []));
    const sharesEvidence = (candidate.evidenceIds || []).some((id) => previousEvidence.has(id));
    if (previous && sequence - previousSequence <= 4 && sequence - groupStart <= 14 && sharesEvidence) previous.push(candidate);
    else groups.push([candidate]);
  }
  const firstPersonCommitment = /\b(?:I\s+(?:will|'ll|can|could|shall|am going to|need to|have to|aim to)|(?:[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]{2,}\s+and\s+I|I\s+and\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]{2,})\s+(?:am\s+|are\s+)?going\s+to)\b/i;
  const personalStatus = /\bI\s+(?:will|'ll)\s+be\s+(?:physically\s+)?(?:in|at|away|unavailable)|\bI\s+won't\s+be\s+(?:available|around)\b/i;
  const acceptedWork = /\b(?:I|we)\b[\s\S]{0,80}\b(?:need to|will|can|aim|plan|do|take|handle|sort|review|check|prepare|front[ -]?end)\b/i;
  const timing = /\b(?:today|tomorrow|(?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday)|next\s+(?:week|month)|this\s+(?:week|month)|before|after|until|by\s+|\d{1,2}(?:st|nd|rd|th)?|first week|second week|contingency|unavailable|(?:not|won't) be (?:available|around))\b/i;
  const dependency = /\b(?:because|if|unless|until|once|after|before|subject to|depend(?:s|ent)? on|contingency|unavailable|(?:not|won't) be (?:available|around)|cannot|can't)\b/i;
  const threads = [];
  for (const group of groups) {
    if (group.length < 2) continue;
    const cues = [...new Set(group.flatMap((candidate) => candidate.cueKinds || []))];
    const focusUnits = group.map((candidate) => byId.get(candidate.focusEvidenceId)).filter(Boolean);
    const hasFirstPersonCommitment = focusUnits.some((unit) => firstPersonCommitment.test(unit.text || ''));
    const acceptedChain = cues.includes('acceptance') && (cues.includes('request') || cues.includes('commitment') || cues.includes('decision_resolution'));
    if (!hasFirstPersonCommitment && !acceptedChain) continue;
    const evidenceIds = [...new Set(group.flatMap((candidate) => candidate.evidenceIds || []))]
      .sort((left, right) => Number(byId.get(left)?.sequence || 0) - Number(byId.get(right)?.sequence || 0));
    const evidenceUnits = evidenceIds.map((id) => byId.get(id)).filter(Boolean);
    const ownerHints = [...new Set(focusUnits.filter((unit, index) => {
      const candidate = group[index];
      return (firstPersonCommitment.test(unit.text || '') && !personalStatus.test(unit.text || ''))
        || ((candidate.cueKinds || []).includes('acceptance') && acceptedWork.test(unit.text || ''));
    }).map((unit) => unit.speaker).filter(Boolean))];
    for (const unit of focusUnits.filter((item) => /\bwe\s+(?:probably\s+)?need to\b/i.test(item.text || ''))) {
      const prefix = String(unit.text || '').split(/\bwe\s+(?:probably\s+)?need to\b/i)[0];
      for (const speaker of [...new Set(rows.map((item) => item.speaker).filter(Boolean))]) {
        const first = String(speaker).split(/[\s,]+/)[0];
        if (first && new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*,`, 'i').test(prefix)) ownerHints.push(speaker);
      }
    }
    const uniqueOwnerHints = [...new Set(ownerHints)];
    const timingEvidenceIds = evidenceUnits.filter((unit) => timing.test(unit.text || '')).map((unit) => unit.id);
    const dependencyEvidenceIds = evidenceUnits.filter((unit) => dependency.test(unit.text || '')).map((unit) => unit.id);
    const context = evidenceUnits.map((unit) => `[${unit.id}] ${unit.speaker}: ${unit.text}`).join('\n');
    const sequence = Math.min(...focusUnits.map((unit) => Number(unit.sequence || 0)));
    threads.push({
      candidateId: stableId('action-thread', evidenceIds.join('|')),
      sourcePass: 'deterministic', recordType: 'action_thread',
      focusEvidenceId: group.find((candidate) => Number(candidate.priority || 0) === Math.max(...group.map((item) => Number(item.priority || 0))))?.focusEvidenceId,
      candidateIds: group.map((candidate) => candidate.candidateId), evidenceIds,
      cueKinds: cues, dispositionHint: acceptedChain ? 'accepted_request' : 'committed',
      priority: Math.max(...group.map((candidate) => Number(candidate.priority || 0)))
        + (acceptedChain ? 4 : 0) + Math.min(2, uniqueOwnerHints.length),
      sequence, ownerHints: uniqueOwnerHints, timingEvidenceIds, dependencyEvidenceIds,
      text: group.map((candidate) => candidate.focusText).filter(Boolean).join(' '),
      context: text(context, 5000)
    });
  }
  return threads.slice(0, 120);
}

const DANGLING_TAIL = /(?:\s*(?:,|;|\b(?:and|then|but|or|because|although|whereas|whilst)\b|(?<!\b(?:do|doing|done|did|does)\s)\bso\b))+\s*[.]?\s*$/i;

function trimDanglingTail(value = '') {
  return String(value || '').replace(DANGLING_TAIL, '').trim();
}

module.exports = {
  actionCandidateInventory,
  actionCommitmentChainInventory,
  actionCommitmentThreadInventory,
  addressedRequestAcceptedAhead,
  DISCUSSION_UNRESOLVED_POSITION_PATTERN,
  LOW_INFORMATION_UTTERANCE,
  trimDanglingTail
};
