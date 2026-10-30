'use strict';

const { contentTokens, COMMON_SPEECH_WORDS } = require('./meetingMinutesRecordMatching');
const { evidenceContextFor, materialTokens } = require('./meetingMinutesEvidenceContext');
const { hasTimingSignal } = require('./meetingMinutesTimingPublication');
const TimingIntegrity = require('./meetingMinutesTiming');
const { speakerIsOwner, OWNER_FIRST_PERSON } = require('./meetingMinutesPeopleEvidence');

// Keep the actual cited work, its assignment, and nearby temporal/defining
// statements before filling the bounded packet with background. Chronological
// first-N truncation can otherwise exclude the very anchor being checked.
function boundedReviewEvidence(record = {}, units = [], options = {}) {
  const context = evidenceContextFor(units);
  const maxUnits = Math.max(1, Math.min(80, Number(options.maxUnits || 40)));
  const maxChars = Math.max(1000, Number(options.maxChars || 18000));
  const binding = record.timing && typeof TimingIntegrity.assessTimingSourceBinding === 'function'
    ? TimingIntegrity.assessTimingSourceBinding(record, units, options) : null;
  const requested = [...new Set([...(record.primaryEvidenceIds || []), ...(record.evidenceIds || []),
    ...(binding?.sourceEvidenceIds || []), ...(binding?.matchedSourceIds || [])])]
    .filter(id => context.known.has(id));
  const anchors = requested.map(id => context.indexById.get(id));
  const target = new Set(materialTokens(record.action || record.text || '').filter(word => !COMMON_SPEECH_WORDS.has(word)));
  const distinctive = new Set([...target].filter(word => (context.documentFrequency.get(word) || 0) <= Math.max(3, context.rows.length * 0.08)));
  const required = new Set(requested);
  const distance = index => anchors.length ? Math.min(...anchors.map(anchor => Math.abs(anchor - index))) : 99;
  const candidates = context.rows.map((unit, index) => {
    const sourceWords = new Set(contentTokens(unit.text));
    const shared = [...target].filter(word => sourceWords.has(word)).length;
    const defining = [...distinctive].filter(word => sourceWords.has(word)).length;
    const near = anchors.some(anchor => index >= anchor - 8 && index <= anchor + 16);
    const timed = hasTimingSignal(unit.text) || /\b(?:ideally|preferred?|fallback|contingency|hard stop|instead|rather than|not until|before|after|once|when)\b/i.test(unit.text);
    const assigned = record.owners?.length && speakerIsOwner(unit.speaker, record.owners) && OWNER_FIRST_PERSON.test(unit.text);
    const priority = required.has(unit.id) ? 0 : near && (timed && (shared || defining) || assigned && shared) ? 1
      : near && defining ? 2 : distance(index) <= 2 ? 3 : near ? 4 : 5;
    return { unit, index, priority, shared, defining };
  }).filter(item => required.has(item.unit.id) || item.priority < 5 || !anchors.length && item.shared >= 2)
    .sort((a, b) => a.priority - b.priority || b.defining - a.defining || b.shared - a.shared || distance(a.index) - distance(b.index) || a.index - b.index);
  const retained = [];
  let chars = 0;
  for (const item of candidates) {
    const size = String(item.unit.text || '').length + String(item.unit.speaker || '').length + 24;
    if (retained.length >= maxUnits || chars + size > maxChars && retained.length) continue;
    retained.push(item); chars += size;
  }
  const retainedIds = new Set(retained.map(item => item.unit.id));
  return {
    units: retained.sort((a, b) => a.index - b.index).map(item => item.unit),
    coverage: { requestedAnchorIds: requested, omittedAnchorIds: requested.filter(id => !retainedIds.has(id)),
      retainedUnitCount: retained.length, candidateUnitCount: candidates.length, maxUnits, maxChars }
  };
}

module.exports = { boundedReviewEvidence };
