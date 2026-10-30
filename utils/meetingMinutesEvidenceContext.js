'use strict';

const { text } = require('./meetingMinutesText');
const { contentTokens, tokenOverlap } = require('./meetingMinutesRecordMatching');
const { normaliseSourceUnits } = require('./meetingMinutesSource');


function includedUnit(unit) {
  return unit.classification !== 'remove' || unit.restored === true;
}

// Evidence validation touches the same immutable source-unit array many times
// during one generation. Keep its derived indexes with that array so every
// action does not rebuild the transcript, speakers and token frequencies.
let evidenceContextCache = new WeakMap();

function clearMeetingMinutesAgentV2MemoryCaches() {
  // WeakMap deliberately has no clear(). Replacing it drops every memoized
  // transcript context while allowing any in-flight caller to finish with the
  // context object it already holds.
  evidenceContextCache = new WeakMap();
  return { evidenceContexts: 'reset' };
}
const RESOLUTION_STOP_WORDS = new Set([
  'action', 'after', 'again', 'also', 'and', 'are', 'before', 'been', 'being', 'but', 'can', 'complete',
  'completed', 'could', 'did', 'discussion', 'does', 'done', 'follow', 'for', 'from', 'had', 'has', 'have',
  'including', 'into', 'just', 'may', 'meeting', 'might', 'more', 'most', 'need', 'needed', 'only', 'our',
  'over', 'review', 'reviewed', 'said', 'send', 'sent', 'shall', 'should', 'that', 'the', 'their', 'them',
  'then', 'there', 'these', 'they', 'this', 'those', 'was', 'week', 'were', 'when', 'whether', 'will',
  'with', 'without', 'work', 'would', 'you', 'your'
]);

function resolutionTokens(source) {
  return [...new Set(comparisonText(String(source || '').replace(/[-–]/g, ' '))
    .match(/[a-z0-9][a-z0-9]{2,}/g) || [])].filter((token) => !RESOLUTION_STOP_WORDS.has(token));
}

function evidenceScoreProfile(source) {
  const value = text(source, 15000);
  const tokens = contentTokens(value);
  return {
    value,
    lower: value.toLowerCase(),
    tokens,
    tokenSet: new Set(tokens),
    material: materialTokens(value),
    values: explicitValues(value),
    polarity: polarity(value),
    resolutionTokenSet: new Set(resolutionTokens(value))
  };
}

function evidenceSupportScoreFromProfiles(claim, evidence) {
  if (!claim.value || !evidence.value) return 0;
  if (claim.values.some((value) => !explicitValuePresent(value, evidence.lower))) return 0;
  const materialCoverage = claim.material.length
    ? claim.material.filter((token) => evidence.tokenSet.has(token)).length / claim.material.length
    : 0;
  const lexical = claim.tokens.length && evidence.tokens.length
    ? claim.tokens.filter((token) => evidence.tokenSet.has(token)).length / Math.min(claim.tokens.length, evidence.tokens.length)
    : 0;
  const polarityPenalty = claim.polarity !== evidence.polarity
    && /\b(?:not|never|cannot|can't|won't|without)\b/i.test(claim.value) ? 0.35 : 0;
  return Math.max(0, (lexical * 0.55) + (materialCoverage * 0.45) - polarityPenalty);
}

function evidenceContextFor(units = []) {
  const key = Array.isArray(units) ? units : [];
  const cached = evidenceContextCache.get(key);
  if (cached) return cached;
  const rows = normaliseSourceUnits(key).filter(includedUnit);
  const indexById = new Map(rows.map((unit, index) => [unit.id, index]));
  const known = new Set(indexById.keys());
  const speakerTokens = [...new Set(rows.map((unit) => unit.speaker).filter(Boolean))]
    .map((speaker) => contentTokens(speaker)).filter((tokens) => tokens.length);
  const speakers = [...new Set(rows.map((unit) => unit.speaker).filter(Boolean))];
  const directTexts = rows.map((unit) => `${unit.speaker}: ${unit.text}`);
  const windowTexts = rows.map((unit, index) => [index - 1, index, index + 1]
    .filter((position) => position >= 0 && position < rows.length)
    .map((position) => directTexts[position]).join(' '));
  const directProfiles = directTexts.map(evidenceScoreProfile);
  const windowProfiles = windowTexts.map(evidenceScoreProfile);
  const documentFrequency = new Map();
  for (const unit of rows) {
    for (const token of resolutionTokens(unit.text)) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
  }
  const context = {
    rows, indexById, known, speakers, speakerTokens, directTexts, windowTexts, directProfiles, windowProfiles, documentFrequency,
    resolutionCache: new Map()
  };
  evidenceContextCache.set(key, context);
  return context;
}

function preparedTranscriptFromUnits(units = []) {
  return normaliseSourceUnits(units).filter(includedUnit).map((unit) => {
    const stamp = unit.timestamp ? ` ${unit.timestamp}` : '';
    return `[${unit.id}] ${unit.speaker}${stamp}: ${unit.text}`;
  }).join('\n');
}



function comparisonText(value) {
  return text(value, 10000).toLowerCase()
    .replace(/\b([a-z]{4,})ies\b/g, '$1y')
    .replace(/\b([a-z]{3,})(?<!s|u|i)s\b/g, '$1');
}

function evidenceWindowUnits(units = [], ids = [], radius = 1, forward = null) {
  const rows = evidenceContextFor(units).rows;
  const ahead = Number.isInteger(forward) ? forward : radius;
  const wanted = new Set((Array.isArray(ids) ? ids : []).map((id) => text(id, 30)));
  const indexes = rows.map((unit, index) => wanted.has(unit.id) ? index : -1).filter((index) => index >= 0);
  const included = new Set(indexes.flatMap((index) => {
    const values = [];
    for (let offset = -radius; offset <= ahead; offset += 1) values.push(index + offset);
    return values;
  }).filter((index) => index >= 0 && index < rows.length));
  return [...included].sort((a, b) => a - b).map((index) => rows[index]);
}

function evidenceWindowText(units = [], ids = [], radius = 1) {
  return evidenceWindowUnits(units, ids, radius)
    .map((unit) => `${unit.speaker}: ${unit.text}`)
    .join(' ');
}

function materialTokens(value) {
  const generic = new Set([
    'action', 'agreed', 'also', 'complete', 'completed', 'discussion', 'follow', 'meeting',
    'need', 'needed', 'review', 'reviewed', 'said', 'send', 'sent', 'team', 'will', 'work'
  ]);
  return contentTokens(value).filter((token) => !generic.has(token));
}

function explicitValues(value) {
  return [...new Set(String(value || '').toLowerCase().match(/\b\d+(?:\.\d+)?%?(?:[-–]\d+)*(?::\d{4})?\b/g) || [])];
}

// Transcripts spell numbers the way they were said: "Tuesday at two",
// "thirty seconds", "eighteen of twenty-two". A written figure is present in
// the evidence when either its digits or its spoken form are there; the
// minutes of a clock time ("2:00") are not a separate claim.
const SPOKEN_UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const SPOKEN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function spokenNumberForms(number) {
  if (!Number.isInteger(number) || number < 0 || number > 999) return [];
  if (number < 20) return [SPOKEN_UNITS[number]];
  if (number < 100) {
    const tens = SPOKEN_TENS[Math.floor(number / 10)];
    const unit = number % 10;
    return unit ? [`${tens}-${SPOKEN_UNITS[unit]}`, `${tens} ${SPOKEN_UNITS[unit]}`, `${tens}${SPOKEN_UNITS[unit]}`] : [tens];
  }
  const hundreds = `${SPOKEN_UNITS[Math.floor(number / 100)]} hundred`;
  const rest = number % 100;
  return rest ? spokenNumberForms(rest).flatMap((form) => [`${hundreds} and ${form}`, `${hundreds} ${form}`]) : [hundreds];
}
function explicitValuePresent(value, evidenceLower) {
  if (evidenceLower.includes(value)) return true;
  if (value === '00') return true;
  const plain = value.replace(/%$/, '');
  if (!/^\d{1,3}$/.test(plain)) return false;
  const forms = spokenNumberForms(Number(plain));
  const spoken = forms.some((form) => new RegExp(`\\b${form}\\b`).test(evidenceLower));
  return spoken && (!value.endsWith('%') || /\bper ?cent\b|%/.test(evidenceLower));
}

function polarity(value) {
  return /\b(?:no|not|never|cannot|can't|won't|isn't|aren't|wasn't|weren't|without)\b/i.test(String(value || '')) ? 'negative' : 'positive';
}

function evidenceSupportScore(claim, evidence) {
  const claimText = text(claim, 5000);
  const evidenceText = text(evidence, 15000);
  if (!claimText || !evidenceText) return 0;
  const values = explicitValues(claimText);
  if (values.some((value) => !explicitValuePresent(value, evidenceText.toLowerCase()))) return 0;
  const claimMaterial = materialTokens(claimText);
  const evidenceWords = new Set(contentTokens(evidenceText));
  const materialCoverage = claimMaterial.length
    ? claimMaterial.filter((token) => evidenceWords.has(token)).length / claimMaterial.length
    : 0;
  const lexical = tokenOverlap(claimText, evidenceText);
  const polarityPenalty = polarity(claimText) !== polarity(evidenceText) && /\b(?:not|never|cannot|can't|won't|without)\b/i.test(claimText) ? 0.35 : 0;
  return Math.max(0, (lexical * 0.55) + (materialCoverage * 0.45) - polarityPenalty);
}

module.exports = {
  includedUnit,
  clearMeetingMinutesAgentV2MemoryCaches,
  resolutionTokens,
  evidenceScoreProfile,
  evidenceSupportScoreFromProfiles,
  evidenceContextFor,
  preparedTranscriptFromUnits,
  comparisonText,
  evidenceWindowUnits,
  evidenceWindowText,
  materialTokens,
  explicitValues,
  explicitValuePresent,
  polarity,
  evidenceSupportScore
};
