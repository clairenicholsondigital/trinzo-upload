'use strict';

const {
  meetingAgentPublicationContent, normaliseMeetingAgentMinuteNumbers
} = require('./meetingMinutesPublication');
const {
  normaliseKnownTerms: normaliseMeetingAgentKnownTerms, normaliseExecutiveSummary, text
} = require('./meetingMinutesText');
const { normaliseDatePhrasesDeep } = require('./spokenForms');
const { normalisePresentationCurrency } = require('./canonicalMinutes/textNormalisation');
const crypto = require('crypto');
const { normaliseSourceUnits } = require('./meetingMinutesSource');
const { includedUnit, evidenceSupportScore, evidenceWindowText } = require('./meetingMinutesEvidenceContext');
const { resolveEvidence } = require('./meetingMinutesEvidenceResolution');
const { stableId, tokenOverlap } = require('./meetingMinutesRecordMatching');
const {
  removeRoutineMeetingAdministrationSentences, isRoutineMeetingAdministrationText
} = require('./meetingAdministration');

function meetingAgentSummaryAuthority(draft) {
  const publication = meetingAgentPublicationContent(draft);
  return { discussion: publication.discussion, actions: publication.actions };
}

function meetingAgentReviewerSummaryHash(draft, value = draft.executiveSummary) {
  const saved = draft.qualityState?.summary?.reviewerSummaryHash || '';
  return saved && saved === meetingAgentSummaryTextHash(value) ? saved : '';
}

function meetingAgentSummaryTextHash(value) {
  const numbered = normaliseMeetingAgentMinuteNumbers({ executiveSummary: String(value || '') }).executiveSummary;
  const published = normaliseMeetingAgentKnownTerms(normaliseDatePhrasesDeep(normaliseExecutiveSummary(normalisePresentationCurrency(numbered))));
  return crypto.createHash('sha256').update(published).digest('hex');
}

function groundedObjectives(values = [], units = []) {
  const opening = normaliseSourceUnits(units).filter(includedUnit).slice(0, 30)
    .filter((unit) => /\b(?:agenda|aim|objective|purpose|focus|today|here to|want to|need to (?:cover|discuss|review)|going to (?:cover|discuss|review))\b/i.test(unit.text));
  const openingText = opening.map((unit) => unit.text).join(' ');
  if (!openingText) return [];
  return (Array.isArray(values) ? values : []).map((value) => text(typeof value === 'string' ? value : value?.text, 400)).filter(Boolean)
    .filter((value) => evidenceSupportScore(value, openingText) >= 0.16)
    .slice(0, 6);
}

function groundedObjectiveRecords(values = [], units = []) {
  const rows = normaliseSourceUnits(units).filter(includedUnit);
  const opening = rows.slice(0, 40).filter((unit) => /\b(?:agenda|aim|objective|purpose|focus|today|here to|want to|need to (?:cover|discuss|review)|going to (?:cover|discuss|review)|session|meeting)\b/i.test(unit.text));
  const source = opening.length ? opening : rows.slice(0, 20);
  return (Array.isArray(values) ? values : []).map((value, index) => {
    const objective = text(typeof value === 'string' ? value : value?.text, 400);
    if (!objective) return null;
    const supplied = Array.isArray(value?.evidenceIds) ? value.evidenceIds : [];
    // A meeting's aims are often clarified after the chair's opening remarks.
    // Honour valid evidence supplied by the Agent anywhere in the transcript;
    // retain the narrow opening/agenda search only when it supplied no citation.
    // This keeps objectives evidence-backed without collapsing a multi-purpose
    // meeting into whichever aim happened to be mentioned first.
    const resolved = supplied.length
      ? resolveEvidence(objective, rows, supplied)
      : resolveEvidence(objective, source, supplied);
    if (!resolved.evidenceIds.length || evidenceSupportScore(objective, evidenceWindowText(rows, resolved.evidenceIds, 1)) < 0.16) return null;
    return {
      id: text(value?.id, 80) || stableId('objective', objective, index),
      text: objective,
      evidenceIds: resolved.evidenceIds
    };
  }).filter(Boolean).slice(0, 4);
}

function mergeGroundedObjectiveRecords(groups = [], units = []) {
  const merged = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    for (const record of groundedObjectiveRecords(Array.isArray(group) ? group : [], units)) {
      const duplicate = merged.find((existing) => {
        const overlap = tokenOverlap(existing.text, record.text);
        const sharedEvidence = record.evidenceIds.some((id) => existing.evidenceIds.includes(id));
        return overlap >= 0.55 || (sharedEvidence && overlap >= 0.34);
      });
      if (!duplicate) {
        merged.push(record);
        continue;
      }
      duplicate.evidenceIds = [...new Set([...duplicate.evidenceIds, ...record.evidenceIds])].slice(0, 12);
      // Prefer the more descriptive evidence-grounded wording; never compose a
      // new objective from fragments of two Agent responses.
      if (record.text.length > duplicate.text.length) duplicate.text = record.text;
    }
  }
  return merged.slice(0, 4);
}

function groundedExecutiveSummary(value, discussion = [], actions = []) {
  const source = JSON.stringify({ discussion, actions });
  const supported = removeRoutineMeetingAdministrationSentences(text(value, 3000))
    .split(/(?<=[.!?])\s+/).filter(Boolean)
    .filter((sentence) => evidenceSupportScore(sentence, source) >= 0.14)
    .join(' ');
  if (supported) return supported;
  const facts = (Array.isArray(discussion) ? discussion : []).flatMap((topic) => [
    ...(topic?.decisions || []), ...(topic?.points || [])
  ]).map((item) => text(item?.text || item, 500))
    .filter((item) => item && !isRoutineMeetingAdministrationText(item)).slice(0, 3);
  const next = (Array.isArray(actions) ? actions : []).map((item) => text(item?.action, 500))
    .filter((item) => item && !isRoutineMeetingAdministrationText(item)).slice(0, 2);
  return text([...facts, ...next].join(' '), 1500);
}

module.exports = {
  groundedExecutiveSummary,
  groundedObjectiveRecords,
  groundedObjectives,
  meetingAgentReviewerSummaryHash,
  meetingAgentSummaryAuthority,
  meetingAgentSummaryTextHash,
  mergeGroundedObjectiveRecords
};
