'use strict';

const { clean } = require('./evidence');

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function participantByFirstName(value, participants = []) {
  const matches = participants.filter((name) => clean(name).split(/\s+/)[0].toLowerCase() === clean(value).toLowerCase());
  return matches.length === 1 ? matches[0] : '';
}

// A turn that names the person being asked has said who owns the work, and that is
// stronger evidence than a first-person marker somewhere else in the same turn. The
// first-person test used to run first, over the WHOLE turn, so a chair saying "I'll pick
// that up - Niamh, can you send the invoice?" owned the invoice: the delegation branch
// was never reached. Measured on the ground-truth fixtures, that put one talkative
// chair's name on three actions belonging to three different people.
function explicitOwner(event, evidence) {
  const text = clean(event?.text);
  if (!text) return '';
  const named = text.match(/(?:^|[.!?;,]\s*|\s+[-–—]\s+)([A-Z][A-Za-z'’.-]+),\s*(?:can|could|will|would)\s+you\b/i)
    || text.match(/(?:^|[.!?;,]\s*|\s+[-–—]\s+)([A-Z][A-Za-z'’.-]+),\s*please\b/i)
    || text.match(/(?:^|\bactions?[:,.]?\s*)([A-Z][A-Za-z'’.-]+)\s+to\s+[a-z]/i)
    || text.match(/\b(?:assigned to|owner is|action for)\s+([A-Z][A-Za-z'’.-]+)/i);
  const addressee = named ? participantByFirstName(named[1], evidence.participants) : '';
  if (addressee) return addressee;
  if (/\bI\s*(?:['’]ll|will|shall|can|need to|must|have to|am going to)\b/i.test(text)) return event.speaker;
  return '';
}

function looksLikeNewCommitment(event) {
  return /\bI\s*(?:['’]ll|will|shall|need to|must|have to|am going to)\b/i.test(clean(event?.text))
    || /\b[A-Z][A-Za-z'’.-]+,\s*(?:can|could|will|would)\s+you\b/.test(clean(event?.text));
}

function temporalCandidate(event, deadlineFrom) {
  const deadline = deadlineFrom(event?.text || '');
  return deadline === 'Not stated' ? null : { event, deadline };
}

const TEMPORAL_STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'for', 'of', 'on', 'in', 'by', 'at',
  'it', 'that', 'this', 'we', 'i', 'you', 'will', 'shall', 'do', 'before',
  'after', 'once', 'when', 'next', 'today', 'tomorrow'
]);

function tokens(value) {
  return clean(value).toLowerCase().match(/[a-z0-9]+/g)
    ?.filter((token) => token.length > 2 && !TEMPORAL_STOP_WORDS.has(token)) || [];
}

function tokenOverlap(left, right) {
  const leftTokens = new Set(tokens(left));
  const rightTokens = new Set(tokens(right));
  if (!leftTokens.size || !rightTokens.size) return 0;
  return [...leftTokens].filter((token) => rightTokens.has(token)).length / Math.min(leftTokens.size, rightTokens.size);
}

function topLabel(probabilities = {}) {
  return Object.entries(probabilities)
    .sort((left, right) => Number(right[1] || 0) - Number(left[1] || 0))[0]?.[0] || '';
}

function historicalTemporalEvidence(event, semantic = {}) {
  const temporal = semantic.temporalRoleProbabilities || {};
  const lifecycle = semantic.lifecycleProbabilities || {};
  const deadline = Math.max(Number(temporal.deadline_current || 0), Number(temporal.deadline_previous || 0));
  if (event.roles?.includes('completed_history')) return true;
  if (Number(temporal.historical || 0) >= deadline + 0.08) return true;
  if (Number(lifecycle.completed || 0) >= Math.max(Number(lifecycle.active || 0), Number(lifecycle.tentative || 0)) + 0.12) return true;
  if (/\b(?:discussed|reviewed|happened|occurred|was|were)\b/i.test(event.text)
    && !/\b(?:deadline|due|must|needs? to|will)\b/i.test(event.text)) return true;
  return /\b(?:yesterday|last\s+(?:week|month|year)|previously|\d+\s+(?:days?|weeks?|months?|years?)\s+ago)\b/i.test(event.text)
    && /\b(?:discussed|reviewed|sent|shared|completed|finished|happened|occurred|was|were|had)\b/i.test(event.text);
}

function shortExplicitTemporalFragment(event) {
  const text = clean(event.text);
  const words = text.split(/\s+/).filter(Boolean);
  const finiteScheduleClause = /\b(?:is|are|was|were)\b/i.test(text);
  const relationshipPhrase = words.length <= 14
    && /^(?:by|before|after|once|when|following|within|ahead of|in advance of|at\b|the end of)\b/i.test(text);
  const bareTemporalAnswer = words.length <= 4
    && /^(?:this|next|today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(text);
  return relationshipPhrase || (!finiteScheduleClause && bareTemporalAnswer);
}

function timingAcceptance(events, temporalIndex, owner) {
  const expectedOwner = clean(owner).toLowerCase();
  return events.slice(temporalIndex + 1, temporalIndex + 3).some((event) => {
    const acceptance = /^(?:yes|yeah|yep|agreed|confirmed|okay|ok|that works|fine)[.!]?$/i.test(clean(event.text));
    return acceptance && (!expectedOwner || expectedOwner === 'not stated' || clean(event.speaker).toLowerCase() === expectedOwner);
  });
}

function timingQuestionBefore(events, temporalIndex, action) {
  const text = clean(events[temporalIndex - 1]?.text);
  return /\b(?:when|by when|how soon|what date|deadline)\b/i.test(text)
    && (tokenOverlap(action, text) >= 0.2 || /\b(?:it|that|this|them|those|deadline)\b/i.test(text));
}

function hasCompetingCommitment(events, sourceEnd, temporalIndex, sourceIds) {
  return events.slice(sourceEnd + 1, temporalIndex).some((event) => !sourceIds.has(event.id) && looksLikeNewCommitment(event));
}

function correctedDeadlineEvidence(event) {
  return /^(?:actually|instead|sorry|rather|make that)\b/i.test(clean(event.text))
    && /\b(?:by|before|after|once|within|today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next)\b/i.test(event.text);
}

function deadlineKey(value) {
  return clean(value).toLowerCase().replace(/^(?:by|on|at|the)\s+/i, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function resolveOwner(item, evidence, sourceEvents, contextEvents) {
  if (clean(item.owner) && item.owner !== 'Not stated') return { owner: item.owner, event: null };
  for (const event of sourceEvents) {
    const owner = explicitOwner(event, evidence);
    if (owner) return { owner, event };
  }
  // A short acceptance inherits only an explicitly named assignee from the request.
  for (let index = 1; index < contextEvents.length; index += 1) {
    const event = contextEvents[index];
    if (!/^(?:yes|yeah|yep|okay|ok|agreed|sure|I can|I will|I['’]ll)\b/i.test(clean(event.text))) continue;
    const priorOwner = explicitOwner(contextEvents[index - 1], evidence);
    if (priorOwner && (!event.speaker || event.speaker === priorOwner)) return { owner: priorOwner, event: contextEvents[index - 1] };
    if (/\b(?:I can|I will|I['’]ll)\b/i.test(event.text) && evidence.participants.includes(event.speaker)) return { owner: event.speaker, event };
  }
  return { owner: 'Not stated', event: null };
}

function resolveDeadlines(items, evidence, options = {}) {
  const deadlineFrom = options.deadlineFrom;
  const profileLabel = options.profileLabel || (() => '');
  const profileFor = options.profileFor || (() => ({}));
  const events = evidence.events || [];
  const eventIndex = new Map(events.map((event, index) => [event.id, index]));
  const results = items.map((item) => ({ deadline: item.deadline || 'Not stated', event: null }));
  const openActions = items.map((item, actionIndex) => {
    if (clean(item.deadline) && item.deadline !== 'Not stated') return null;
    // Consolidation may retain a whole commitment thread in evidenceIds. The
    // representative evidence is the authority for this particular action;
    // treating every supporting event as primary can leak a neighbouring
    // action's date onto this one.
    const primaryEvidenceIds = Array.isArray(item.representativeEvidenceIds) && item.representativeEvidenceIds.length
      ? item.representativeEvidenceIds
      : item.evidenceIds || [];
    const sourceIds = new Set(primaryEvidenceIds);
    const sourceIndices = [...sourceIds].map((id) => eventIndex.get(id)).filter(Number.isInteger);
    if (!sourceIndices.length) return null;
    return {
      actionIndex,
      item,
      sourceIds,
      sourceIndices,
      sourceEnd: Math.max(...sourceIndices)
    };
  }).filter(Boolean);
  const assignments = [];

  events.forEach((event, temporalIndex) => {
    const candidate = temporalCandidate(event, deadlineFrom);
    if (!candidate) return;
    const semantic = profileFor(event) || {};
    if (historicalTemporalEvidence(event, semantic)) return;
    const temporal = semantic.temporalRoleProbabilities || {};
    const discourse = semantic.discourseRoleProbabilities || {};
    const previousLabel = profileLabel(event) === 'deadline_previous' || topLabel(temporal) === 'deadline_previous';
    const previousProbability = Number(temporal.deadline_previous || 0);
    const temporalAttachment = Number(discourse.temporal_attachment || 0);

    const ranked = openActions.map((entry) => {
      const direct = entry.sourceIds.has(event.id);
      const follows = temporalIndex > entry.sourceEnd && temporalIndex - entry.sourceEnd <= 4;
      const nearest = Math.min(...entry.sourceIndices.map((index) => Math.abs(index - temporalIndex)));
      const accepted = follows && timingAcceptance(events, temporalIndex, entry.item.owner);
      const actionOverlap = tokenOverlap(entry.item.action, event.text);
      const contextOverlap = tokenOverlap(entry.item.action, event.previousText || events[temporalIndex - 1]?.text || '');
      const structuralAttachment = follows && (
        timingQuestionBefore(events, temporalIndex, entry.item.action)
        || (nearest === 1 && shortExplicitTemporalFragment(event))
        || correctedDeadlineEvidence(event)
      );
      const modelAttachment = follows && (
        previousLabel
        || (previousProbability >= 0.2 && previousProbability >= Number(temporal.historical || 0) + 0.04)
        || temporalAttachment >= 0.08
      );
      const explicitDueLanguage = /\b(?:deadline|due)\b/i.test(event.text);
      const finiteBackgroundClause = /\b(?:is|are|was|were|happens?|occurs?)\b/i.test(event.text);
      const explicitDeadlineLink = /\b(?:deadline|due|by|before|after|once|within|ahead of|in advance of)\b/i.test(event.text)
        && (actionOverlap >= 0.2 || (/\b(?:it|that|this|them|those)\b/i.test(event.text) && (!finiteBackgroundClause || explicitDueLanguage)));
      if (!direct && !structuralAttachment && !(modelAttachment && explicitDeadlineLink)) return null;
      if (!direct && (nearest > 4 || hasCompetingCommitment(events, entry.sourceEnd, temporalIndex, entry.sourceIds))) return null;

      const sourceEvents = entry.sourceIndices.map((index) => events[index]).filter(Boolean);
      const owner = clean(entry.item.owner).toLowerCase();
      const ownerMatches = owner && owner !== 'not stated' && sourceEvents.some((source) => clean(source.speaker).toLowerCase() === owner);
      const eventOwnerMatches = owner && owner !== 'not stated' && clean(event.speaker).toLowerCase() === owner;
      if (!direct && looksLikeNewCommitment(event) && actionOverlap < 0.25) return null;
      if (direct && looksLikeNewCommitment(event) && owner && owner !== 'not stated' && !eventOwnerMatches && actionOverlap < 0.2) return null;

      let score = direct ? 0.86 : ([0, 0.48, 0.31, 0.18, 0.08][nearest] || 0);
      score += actionOverlap * 0.62;
      score += contextOverlap * 0.34;
      if (direct && topLabel(temporal) === 'deadline_current') score += 0.28;
      if (!direct && previousLabel) score += 0.48;
      else if (!direct) score += Math.min(previousProbability, 0.5) * 0.7;
      if (!direct) score += Math.min(temporalAttachment, 0.5) * 0.6;
      if (!direct && structuralAttachment) score += 0.34;
      if (ownerMatches) score += 0.08;
      if (eventOwnerMatches) score += 0.14;
      if (accepted) score += 0.22;
      return { ...entry, event, deadline: candidate.deadline, score };
    }).filter(Boolean).sort((left, right) => right.score - left.score);

    if (!ranked.length) return;
    const best = ranked[0];
    const margin = ranked[1] ? best.score - ranked[1].score : Infinity;
    if (best.score < 0.72 || (best.score < 1.5 && margin < 0.16)) return;
    assignments.push({ ...best, margin });
  });

  const safeAssignments = [];
  const assignmentsByAction = new Map();
  for (const assignment of assignments) {
    const group = assignmentsByAction.get(assignment.actionIndex) || [];
    group.push(assignment);
    assignmentsByAction.set(assignment.actionIndex, group);
  }
  for (const group of assignmentsByAction.values()) {
    const distinctDeadlines = new Set(group.map((assignment) => deadlineKey(assignment.deadline)));
    if (distinctDeadlines.size <= 1) safeAssignments.push(...group);
    else {
      const corrected = group.filter((assignment) => correctedDeadlineEvidence(assignment.event))
        .sort((left, right) => right.temporalIndex - left.temporalIndex);
      if (corrected.length) safeAssignments.push(corrected[0]);
    }
  }

  const usedActions = new Set();
  const usedEvents = new Set();
  safeAssignments.sort((left, right) => right.score - left.score).forEach((assignment) => {
    if (usedActions.has(assignment.actionIndex) || usedEvents.has(assignment.event.id)) return;
    results[assignment.actionIndex] = { deadline: assignment.deadline, event: assignment.event };
    usedActions.add(assignment.actionIndex);
    usedEvents.add(assignment.event.id);
  });
  return results;
}

function resolveActionRecords(items, evidence, options = {}) {
  const deadlineFrom = options.deadlineFrom;
  if (typeof deadlineFrom !== 'function') throw new Error('resolveActionRecords requires deadlineFrom.');
  const eventIndex = new Map(evidence.events.map((event, index) => [event.id, index]));
  const ownerResolved = items.map((item) => {
    const indices = (item.evidenceIds || []).map((id) => eventIndex.get(id)).filter(Number.isInteger);
    if (!indices.length) return { ...item, slotResolution: { owner: clean(item.owner) && item.owner !== 'Not stated' ? 'existing' : 'unresolved', deadline: clean(item.deadline) && item.deadline !== 'Not stated' ? 'existing' : 'unresolved' } };
    const start = Math.min(...indices);
    const end = Math.max(...indices);
    const sourceEvents = unique((item.evidenceIds || []).map((id) => evidence.events[eventIndex.get(id)]));
    const contextEvents = evidence.events.slice(Math.max(0, start - 3), Math.min(evidence.events.length, end + 4));
    const owner = resolveOwner(item, evidence, sourceEvents, contextEvents);
    return {
      ...item,
      owner: owner.owner,
      evidenceIds: unique([...(item.evidenceIds || []), owner.event?.id]),
      slotResolution: {
        owner: owner.owner === 'Not stated' ? 'unresolved' : owner.event ? 'context_evidence' : 'existing',
        deadline: clean(item.deadline) && item.deadline !== 'Not stated' ? 'existing' : 'unresolved'
      }
    };
  });
  const deadlines = resolveDeadlines(ownerResolved, evidence, options);
  return ownerResolved.map((item, index) => ({
    ...item,
    deadline: deadlines[index].deadline,
    evidenceIds: unique([...(item.evidenceIds || []), deadlines[index].event?.id]),
    slotResolution: {
      ...item.slotResolution,
      deadline: deadlines[index].deadline === 'Not stated' ? 'unresolved' : deadlines[index].event ? 'context_evidence' : 'existing'
    }
  }));
}

module.exports = { explicitOwner, resolveActionRecords };
