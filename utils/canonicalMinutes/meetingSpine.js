'use strict';

const { clean } = require('./evidence');
const { canStandAloneAsMinutesEvidence, canHeadlineTopic } = require('./publishability');

const DAY_ONLY = /^(?:(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?[,/ &-]*)+$/i;
const GENERIC_TOPIC = /^(?:risks?|plans? and timelines?|scope and requirements?|roles? and responsibilities?|operations? and processes?|product behaviour and design|actions? and ownership)$/i;
const PRIMARY_CUES = /\b(?:purpose|aim|need to|needs? to|must|prepare|preparation|build|develop|agree|confirm|finalise|finalize|complete|audit|procedure|qms|technical file|submission|working session)\b/i;
const CONSEQUENCE_CUES = /\b(?:action|decision|agree|confirm|need to|must|follow[- ]?up|deadline|due|risk|block|dependency|outstanding)\b/i;

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function topicText(item) {
  return clean(item?.text || item?.topic || item?.representativeText);
}

function evidenceEvents(item, evidence) {
  const ids = new Set(item?.evidenceIds || []);
  return evidence.events.filter((event) => ids.has(event.id));
}

function workstreamSalience(item, evidence, meeting = {}) {
  const events = evidenceEvents(item, evidence).filter((event) => canStandAloneAsMinutesEvidence(event.text, { allowConditional: true }));
  if (!events.length) return 0;
  const speakers = new Set(events.map((event) => clean(event.speaker)).filter(Boolean));
  const turns = events.map((event) => Number(event.turnIndex || 0));
  const span = turns.length > 1 ? Math.max(...turns) - Math.min(...turns) : 0;
  const title = `${clean(meeting.title || meeting.meetingTitle)} ${clean(meeting.type || meeting.meetingType)}`.toLowerCase();
  const topic = topicText(item).toLowerCase();
  const topicTokens = new Set((topic.match(/[a-z][a-z0-9-]{3,}/g) || []).filter((token) => !['review', 'meeting', 'client', 'internal'].includes(token)));
  const titleMatch = [...topicTokens].filter((token) => title.includes(token)).length;
  const consequential = events.filter((event) => CONSEQUENCE_CUES.test(event.text) || (event.roles || []).some((role) => ['action_candidate', 'decision_candidate', 'risk_candidate'].includes(role))).length;
  const opening = events.some((event) => Number(event.turnIndex || 0) <= Math.max(8, Math.round(evidence.events.length * 0.12))) ? 1 : 0;
  const closing = events.some((event) => Number(event.turnIndex || 0) >= Math.round(evidence.events.length * 0.82)) ? 1 : 0;
  const purposeCue = events.some((event) => PRIMARY_CUES.test(event.text)) ? 1 : 0;
  const density = Math.min(events.length, 8) * 0.55;
  const breadth = Math.min(speakers.size, 4) * 0.35;
  const continuity = Math.min(span / Math.max(evidence.events.length, 1), 0.5) * 1.4;
  return Number((density + breadth + continuity + (consequential * 0.32) + (titleMatch * 0.45) + (opening * 0.45) + (closing * 0.25) + (purposeCue * 0.4)).toFixed(3));
}

function usableHeading(value) {
  const text = clean(value);
  if (!text || DAY_ONLY.test(text) || GENERIC_TOPIC.test(text)) return false;
  return canHeadlineTopic(text);
}

function buildMeetingSpine({ evidence, meeting = {}, workstreams = [], purposeProfile = '' } = {}) {
  const scored = (workstreams || []).map((item, index) => ({
    ...item,
    text: topicText(item),
    sourceIndex: index,
    salience: workstreamSalience(item, evidence, meeting)
  })).filter((item) => item.text && item.salience > 0);
  scored.sort((left, right) => right.salience - left.salience || left.sourceIndex - right.sourceIndex);
  const primary = scored.slice(0, Math.min(4, scored.length));
  const primaryIds = new Set(primary.map((item) => item.purposeDimension || item.topicId || item.id || item.text));
  const supporting = scored.filter((item) => !primaryIds.has(item.purposeDimension || item.topicId || item.id || item.text)).slice(0, 4);
  const incidental = scored.filter((item) => !primary.includes(item) && !supporting.includes(item));
  const primaryEvidence = primary.flatMap((item) => evidenceEvents(item, evidence));
  const purposeEvidence = primaryEvidence
    .filter((event) => canStandAloneAsMinutesEvidence(event.text, { allowConditional: true }))
    .sort((left, right) => Number(left.turnIndex || 0) - Number(right.turnIndex || 0));
  return {
    purposeProfile,
    primaryPurposeEvidenceIds: unique(purposeEvidence.slice(0, 8).map((event) => event.id)),
    primaryWorkstreams: primary,
    supportingWorkstreams: supporting,
    incidentalWorkstreams: incidental,
    publishableTopics: [...primary, ...supporting].filter((item) => usableHeading(item.text)),
    diagnostics: {
      scoredWorkstreams: scored.map((item) => ({ text: item.text, salience: item.salience })),
      rejectedHeadings: scored.filter((item) => !usableHeading(item.text)).map((item) => item.text)
    }
  };
}

module.exports = { buildMeetingSpine, workstreamSalience, usableHeading };
