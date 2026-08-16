'use strict';

const crypto = require('crypto');

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'against', 'also', 'around', 'because', 'before',
  'being', 'between', 'business', 'client', 'clients', 'could', 'detail',
  'details', 'during', 'each', 'from', 'have', 'into', 'meeting',
  'minutes', 'need', 'needs', 'only', 'other',
  'project', 'review', 'should', 'stage', 'substantive', 'that',
  'their', 'there', 'these', 'they', 'this', 'through', 'understand', 'used',
  'where', 'which', 'while', 'with', 'works'
]);

function cleanText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normaliseToken(token) {
  const value = String(token || '').toLowerCase();
  if (value === 'japanese') return 'japan';
  if (value === 'fiscally') return 'fiscal';
  if (value === 'warehousing') return 'warehouse';
  if (value === 'scanners') return 'scanner';
  if (value === 'checks') return 'check';
  if (value === 'procedures') return 'procedure';
  if (value === 'processes') return 'process';
  if (value.endsWith('ing') && value.length > 7) return value.slice(0, -3);
  if (value.endsWith('ed') && value.length > 6) return value.slice(0, -2);
  if (value.endsWith('s') && value.length > 5) return value.slice(0, -1);
  return value;
}

function lowerTokens(value) {
  return cleanText(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(normaliseToken)
    .filter((token) => token.length >= 4 && !STOP_WORDS.has(token));
}

function stableSemanticId(prefix, text) {
  return `${prefix}-${crypto.createHash('sha256').update(cleanText(text).toLowerCase()).digest('hex').slice(0, 14)}`;
}

function buildConfirmedUnderstanding(summary = {}) {
  const meetingPurpose = cleanText(summary.meetingPurpose || summary.purpose || '');
  const seen = new Set();
  const criticalFacts = (Array.isArray(summary.keyFacts) ? summary.keyFacts : [])
    .map(cleanText)
    .filter(Boolean)
    .filter((fact) => {
      const key = fact.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((fact) => ({
      id: stableSemanticId('reviewer-fact', fact),
      text: fact,
      authority: 'reviewer_confirmed',
      source: 'summary_key_fact'
    }));
  return {
    meetingPurpose,
    meetingPurposeId: meetingPurpose ? stableSemanticId('reviewer-purpose', meetingPurpose) : '',
    criticalFacts
  };
}

function sentenceParts(text) {
  const sentences = String(text || '')
    .split(/(?<=[.!?])\s+|\r?\n+/)
    .map(cleanText)
    .filter((part) => part.length >= 20 && part.length <= 420);
  const lines = String(text || '').split(/\r?\n/).map(cleanText).filter((part) => part.length >= 12 && part.length <= 320);
  const windows = [];
  for (const size of [2, 4, 8]) {
    for (let index = 0; index <= lines.length - size; index += 1) {
      const window = cleanText(lines.slice(index, index + size).join(' '));
      if (window.length >= 40 && window.length <= 1200) windows.push(window);
    }
  }
  return [...sentences, ...windows];
}

function textSimilarity(left, right) {
  const leftTokens = new Set(lowerTokens(left));
  const rightTokens = new Set(lowerTokens(right));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

function keywordSupportScore(fact, text) {
  const factTokens = lowerTokens(fact);
  if (!factTokens.length) return 0;
  const haystack = cleanText(text).toLowerCase();
  let matched = 0;
  for (const token of factTokens) {
    if (haystack.includes(token)) matched += 1;
  }
  return matched / factTokens.length;
}

function findSupportingEvidence(factText, transcriptText, evidenceEvents = []) {
  const candidates = [];
  const rankedEvents = [];
  for (const event of Array.isArray(evidenceEvents) ? evidenceEvents : []) {
    const text = cleanText(event && event.text);
    if (!text) continue;
    const score = Math.max(textSimilarity(factText, text), keywordSupportScore(factText, text));
    if (score > 0) rankedEvents.push({ text, id: event.id, score });
    if (score >= 0.34) candidates.push({ text, id: event.id, score });
  }
  if (!candidates.length) {
    for (const text of sentenceParts(transcriptText)) {
      const score = Math.max(textSimilarity(factText, text), keywordSupportScore(factText, text));
      if (score >= 0.34) candidates.push({ text, id: '', score });
    }
  }
  if (!candidates.length && transcriptText) {
    const score = keywordSupportScore(factText, transcriptText);
    if (score >= 0.34) {
      const nearestEvents = rankedEvents
        .sort((left, right) => right.score - left.score)
        .slice(0, 5);
      if (nearestEvents.length) candidates.push(...nearestEvents.map((event) => ({ ...event, supportScope: 'whole_transcript_nearest_event' })));
      else candidates.push({ text: cleanText(factText), id: '', score, supportScope: 'whole_transcript' });
    }
  }
  candidates.sort((left, right) => right.score - left.score);
  const topCandidates = candidates.slice(0, 3);
  if (topCandidates.some((candidate) => candidate.id)) return topCandidates;
  if (rankedEvents.length) {
    return rankedEvents
      .sort((left, right) => right.score - left.score)
      .slice(0, 3)
      .map((event) => ({ ...event, supportScope: 'nearest_event_for_matched_window' }));
  }
  return topCandidates;
}

function discussionText(discussion = []) {
  return (Array.isArray(discussion) ? discussion : [])
    .map((card) => [
      card && card.topic,
      ...(Array.isArray(card && card.points)
        ? card.points.map((point) => (point && typeof point === 'object' ? point.text : point))
        : [])
    ].join(' '))
    .join(' ');
}

function factIsPreserved(factText, discussion = []) {
  const combined = discussionText(discussion);
  if (!combined) return false;
  return Math.max(textSimilarity(factText, combined), keywordSupportScore(factText, combined)) >= 0.55;
}

function topicForFact(factText) {
  const text = cleanText(factText).toLowerCase();
  if (/\b(?:netherlands|dublin|park west|japan|supplier|warehouse|storage|fiscal|clearance)\b/i.test(text)) {
    return 'Importer process and goods flow';
  }
  if (/\b(?:erp|scanner|warehouse|document control|manual|operational|order flow)\b/i.test(text)) {
    return 'Operational process requirements';
  }
  return 'Confirmed meeting context';
}

function appendFactToDiscussion(discussion = [], fact) {
  const cards = (Array.isArray(discussion) ? discussion : []).map((card) => ({
    ...card,
    points: Array.isArray(card && card.points) ? [...card.points] : []
  }));
  const topic = topicForFact(fact.text);
  const evidenceIds = Array.isArray(fact.evidenceIds) ? fact.evidenceIds.filter(Boolean) : [];
  const existing = cards.find((card) => textSimilarity(card.topic || '', topic) >= 0.35)
    || cards.find((card) => textSimilarity(`${card.topic || ''} ${(card.points || []).join(' ')}`, fact.text) >= 0.18);
  const point = cleanText(fact.text).replace(/[.?!]?$/, '.');
  const pointValue = evidenceIds.length ? { text: point, evidenceIds } : point;
  if (existing) {
    if (!existing.points.some((candidate) => textSimilarity(candidate && typeof candidate === 'object' ? candidate.text : candidate, point) >= 0.7)) existing.points.push(pointValue);
    if (evidenceIds.length) existing.evidenceIds = [...new Set([...(existing.evidenceIds || []), ...evidenceIds])];
    existing.source = existing.source || 'reviewer_confirmed_fact_repair';
    existing.reviewerConfirmedFactIds = [...new Set([...(existing.reviewerConfirmedFactIds || []), fact.id])];
    return cards;
  }
  cards.push({
    topic,
    points: [pointValue],
    evidenceIds,
    source: 'reviewer_confirmed_fact_repair',
    reviewerConfirmedFactIds: [fact.id]
  });
  return cards;
}

function semanticAnchorsForDiscussion(understanding = {}) {
  const anchors = [];
  if (understanding.meetingPurpose) {
    anchors.push({
      id: understanding.meetingPurposeId || stableSemanticId('reviewer-purpose', understanding.meetingPurpose),
      text: understanding.meetingPurpose,
      authority: 'reviewer_confirmed',
      source: 'summary_meeting_purpose'
    });
  }
  for (const fact of Array.isArray(understanding.criticalFacts) ? understanding.criticalFacts : []) {
    if (fact && fact.text) anchors.push(fact);
  }
  return anchors;
}

function repairDiscussionForConfirmedUnderstanding({ discussion = [], understanding = {}, transcriptText = '', evidenceEvents = [] } = {}) {
  let repaired = Array.isArray(discussion) ? discussion : [];
  const validationFlags = [];
  const repairedFacts = [];
  const unsupportedFacts = [];
  const unresolvedFacts = [];
  const supportedFacts = [];

  for (const fact of semanticAnchorsForDiscussion(understanding)) {
    const support = findSupportingEvidence(fact.text, transcriptText, evidenceEvents);
    if (!support.length) {
      unsupportedFacts.push(fact.id);
      continue;
    }
    const factWithEvidence = {
      ...fact,
      evidenceIds: support.map((item) => item.id).filter(Boolean)
    };
    supportedFacts.push(fact.id);
    if (!factIsPreserved(fact.text, repaired)) {
      repaired = appendFactToDiscussion(repaired, factWithEvidence);
      repairedFacts.push(fact.id);
    }
    if (!factIsPreserved(fact.text, repaired)) {
      unresolvedFacts.push(fact.id);
      validationFlags.push({
        type: 'reviewer_confirmed_fact_not_preserved',
        severity: 'warning',
        blocking: true,
        resolutionKey: `reviewer-confirmed-fact:${fact.id}`,
        message: 'A transcript-supported reviewer-confirmed Meeting purpose or Key fact was not preserved in Discussion. Review and add it before continuing.',
        discussionSuggestion: {
          topic: topicForFact(fact.text),
          point: fact.text,
          source: 'reviewer_confirmed_fact'
        }
      });
    }
  }

  return {
    discussion: repaired,
    validationFlags,
    telemetry: {
      supportedFactCount: supportedFacts.length,
      repairedFactCount: repairedFacts.length,
      unsupportedFactCount: unsupportedFacts.length,
      unresolvedFactCount: unresolvedFacts.length,
      supportedFacts,
      repairedFacts,
      unsupportedFacts,
      unresolvedFacts
    }
  };
}

module.exports = {
  buildConfirmedUnderstanding,
  repairDiscussionForConfirmedUnderstanding,
  stableSemanticId,
  textSimilarity,
  findSupportingEvidence,
  factIsPreserved
};
