'use strict';

const { clean } = require('./evidence');

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function participantByFirstName(value, participants = []) {
  const matches = participants.filter((name) => clean(name).split(/\s+/)[0].toLowerCase() === clean(value).toLowerCase());
  return matches.length === 1 ? matches[0] : '';
}

function explicitOwner(event, evidence) {
  const text = clean(event?.text);
  if (!text) return '';
  if (/\bI\s*(?:['’]ll|will|shall|can|need to|must|have to|am going to)\b/i.test(text)) return event.speaker;
  const named = text.match(/(?:^|[.!?;]\s+)([A-Z][A-Za-z'’.-]+),\s*(?:can|could|will|would)\s+you\b/i)
    || text.match(/(?:^|[.!?;]\s+)([A-Z][A-Za-z'’.-]+),\s*please\b/i)
    || text.match(/(?:^|\bactions?[:,.]?\s*)([A-Z][A-Za-z'’.-]+)\s+to\s+[a-z]/i)
    || text.match(/\b(?:assigned to|owner is|action for)\s+([A-Z][A-Za-z'’.-]+)/i);
  return named ? participantByFirstName(named[1], evidence.participants) : '';
}

function looksLikeNewCommitment(event) {
  return /\bI\s*(?:['’]ll|will|shall|need to|must|have to|am going to)\b/i.test(clean(event?.text))
    || /\b[A-Z][A-Za-z'’.-]+,\s*(?:can|could|will|would)\s+you\b/.test(clean(event?.text));
}

function temporalCandidate(event, deadlineFrom) {
  const deadline = deadlineFrom(event?.text || '');
  return deadline === 'Not stated' ? null : { event, deadline };
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

function resolveDeadline(item, sourceEvents, followingEvents, deadlineFrom, profileLabel) {
  if (clean(item.deadline) && item.deadline !== 'Not stated') return { deadline: item.deadline, event: null };
  for (const event of sourceEvents) {
    const candidate = temporalCandidate(event, deadlineFrom);
    if (candidate) return candidate;
  }
  for (let index = 0; index < followingEvents.length; index += 1) {
    const event = followingEvents[index];
    if (looksLikeNewCommitment(event)) break;
    const candidate = temporalCandidate(event, deadlineFrom);
    if (!candidate) continue;
    const priorText = clean(followingEvents[index - 1]?.text);
    const shortTemporalAnswer = clean(event.text).split(/\s+/).length <= 14;
    const answersTimingQuestion = /\b(?:when|by when|how soon|what date|deadline)\b/i.test(priorText);
    const classifiedAttachment = profileLabel(event) === 'deadline_previous';
    const explicitAttachment = /^(?:by|before|after|once|when|following|ahead of|in advance of|this|next|today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|at\b|the end of)/i.test(clean(event.text));
    if (classifiedAttachment || answersTimingQuestion || (shortTemporalAnswer && explicitAttachment)) return candidate;
  }
  return { deadline: 'Not stated', event: null };
}

function resolveActionRecords(items, evidence, options = {}) {
  const deadlineFrom = options.deadlineFrom;
  const profileLabel = options.profileLabel || (() => '');
  if (typeof deadlineFrom !== 'function') throw new Error('resolveActionRecords requires deadlineFrom.');
  const eventIndex = new Map(evidence.events.map((event, index) => [event.id, index]));
  return items.map((item) => {
    const indices = (item.evidenceIds || []).map((id) => eventIndex.get(id)).filter(Number.isInteger);
    if (!indices.length) return item;
    const start = Math.min(...indices);
    const end = Math.max(...indices);
    const sourceEvents = unique((item.evidenceIds || []).map((id) => evidence.events[eventIndex.get(id)]));
    const contextEvents = evidence.events.slice(Math.max(0, start - 3), Math.min(evidence.events.length, end + 4));
    const followingEvents = evidence.events.slice(end + 1, Math.min(evidence.events.length, end + 5));
    const owner = resolveOwner(item, evidence, sourceEvents, contextEvents);
    const deadline = resolveDeadline(item, sourceEvents, followingEvents, deadlineFrom, profileLabel);
    return {
      ...item,
      owner: owner.owner,
      deadline: deadline.deadline,
      evidenceIds: unique([...(item.evidenceIds || []), owner.event?.id, deadline.event?.id]),
      slotResolution: {
        owner: owner.owner === 'Not stated' ? 'unresolved' : owner.event ? 'context_evidence' : 'existing',
        deadline: deadline.deadline === 'Not stated' ? 'unresolved' : deadline.event ? 'context_evidence' : 'existing'
      }
    };
  });
}

module.exports = { explicitOwner, resolveActionRecords };
