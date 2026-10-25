'use strict';

const crypto = require('crypto');
const { validOccurrenceId, actionProvenanceSignature, findActionOccurrenceIndex, preserveActionIdentity, assignGeneratedActionIdentities } = require('./meetingMinutesActionIdentity');
const TimingIntegrity = require('./meetingMinutesTiming');
const { normaliseSystemTimingIssue, actionTimingIssueFlag } = require('./meetingMinutesTimingFlags');
const { indexReviewResults, finishReviewAccounting } = require('./meetingMinutesReviewAccounting');
const { ALWAYS_INTERNAL_PEOPLE, alwaysInternalAttendeeName, normaliseFixedPersonAliases } = require('./entityNormalization');
const { normaliseDomainTerms } = require('./domainTerms');
const { convertSpokenNumbers } = require('./spokenNumbers');
const { alignEllipticalDateRangesWithEvidence } = require('./spokenForms');
const {
  isRoutineMeetingAdministrationText,
  removeRoutineMeetingAdministrationSentences
} = require('./meetingAdministration');
const { isActionCategoryTopicCard } = require('./canonicalMinutes/topicEditorial');
const { isReviewerAuthored } = require('./canonicalMinutes/state');
const { actionIsSafelyCovered } = require('./canonicalMinutes/actionDuplicateCoverage');
const { commitmentCanBeRepresented } = require('./canonicalMinutes/commitmentDuplicates');
const { correctionMeaningIssue } = require('./meetingMinutesFidelityMeaning');

// The response contract asked of the agent. It is interpolated into the prompt
// ("Return schemaVersion N ..."), so changing it changes what Power Automate is
// told to return - do NOT bump it to describe a change in what we store on disk.
const SCHEMA_VERSION = 4;

// What is stored in the draft payload. Separate from SCHEMA_VERSION on purpose.
const PAYLOAD_VERSION = 5;
// Application-derived timing in cached action candidates is versioned separately
// from the shared source assessment policy and the Microsoft response schema.
const TIMING_INFERENCE_POLICY_VERSION = 1;

// Step indices changed meaning when the workflow gained a steer screen (1) and a
// summary screen (4): what was saved as "actions" (2) is now 3, and "final review"
// (3) is now 5. Remap anything below the current payload version so a draft opens
// where its owner left it - and so the client's furthest-step gate does not lock
// them out of every tab beyond it.
const STEP_V2_TO_V3 = Object.freeze({ 0: 0, 1: 2, 2: 3, 3: 5 });

function migrateDraftPayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return payload;
  // `Number(undefined) >= 3` is false, but be explicit: an absent version is 0.
  if ((Number(payload.payloadVersion) || 0) >= PAYLOAD_VERSION) return payload;
  const priorVersion = Number(payload.payloadVersion) || 0;
  const stored = Math.max(0, Math.min(3, Number(payload.currentStep) || 0));
  const discussion = (Array.isArray(payload.discussion) ? payload.discussion : []).map((topic) => ({
    ...topic,
    ...Object.fromEntries(['points', 'decisions', 'openQuestions'].map((key) => [key,
      (Array.isArray(topic?.[key]) ? topic[key] : []).map((record) => typeof record === 'string'
        ? record
        : { ...record, supportingDetails: Array.isArray(record?.supportingDetails) ? record.supportingDetails : [] })
    ]))
  }));
  return {
    ...payload,
    payloadVersion: PAYLOAD_VERSION,
    discussion,
    ...(priorVersion < 3 ? { currentStep: STEP_V2_TO_V3[stored] } : {})
  };
}
const FLAG_KINDS = new Set([
  'uncertain_fact', 'unclear_reference', 'ownership', 'attribution', 'timing',
  'unresolved_decision', 'missing_evidence', 'possible_missed_follow_up'
]);
const FLAG_KIND_ALIASES = Object.freeze({
  ownership_uncertain: 'ownership',
  timing_uncertain: 'timing',
  unresolved_question: 'unresolved_decision',
  uncertain_reference: 'unclear_reference'
});
const COVERAGE_FLAG_MESSAGE = 'Check whether this important transcript detail should appear in the minutes:';
const MATERIAL_UNCERTAINTY_PATTERN = /\b(?:ambiguous|ambiguity|unclear wording|conflict(?:ing)?|inconsisten|inaudible|cannot (?:determine|identify|verify)|could not (?:determine|identify|verify)|uncertain (?:wording|reference|identity|value)|multiple (?:possible|plausible)|not (?:clear|clarified) (?:which|whether|who|what))\b/i;
const KNOWN_INTERNAL_ATTENDEE_KEYS = new Set([
  'colm o’rourke', 'jacqui fox', 'david didsbury', 'conor flynn', 'claire nicholson',
  'mark kelleher', 'john-paul hughes', 'jenny gough', 'stuart smith', 'orla skally',
  ...ALWAYS_INTERNAL_PEOPLE.map((person) => person.name)
].map((name) => name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[’‘`]/g, "'").toLowerCase()));
const MDSAP_SPOKEN_FORM = /\b(?:medsap|meds[\s-]*app)\b/i;
const HALF_HOUR_SPOKEN_FORM = /\bhalf(?:[\s-]+past)?[\s-]+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,2})\b/i;
const HOUR_VALUES = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12
});

function normaliseColloquialTimes(value) {
  return String(value == null ? '' : value).replace(new RegExp(HALF_HOUR_SPOKEN_FORM.source, 'gi'), (match, spokenHour) => {
    const hour = HOUR_VALUES[String(spokenHour).toLowerCase()] || Number(spokenHour);
    return hour >= 1 && hour <= 12 ? `${hour}:30` : match;
  });
}

function normaliseKnownTerms(value) {
  // Deterministic domain correction: this transcription variant must never reach a
  // reviewer-facing field, flag, export or persisted minutes payload.
  return normaliseDomainTerms(normaliseFixedPersonAliases(normaliseColloquialTimes(value)))
    .replace(/\bmeds[\s-]*app\b/gi, 'MDSAP');
}

function normaliseKnownTermsDeep(value) {
  if (typeof value === 'string') return normaliseKnownTerms(value);
  if (Array.isArray(value)) return value.map(normaliseKnownTermsDeep);
  if (value && typeof value === 'object') {
    if (value instanceof Date) return value;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    // Filing origins are historical records, never presentation prose.
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      key === 'occurrenceId' || key === 'keptActionOccurrenceIds' || key === 'filingOrigins' ? item : normaliseKnownTermsDeep(item)]));
  }
  return value;
}

function isAutomaticTerminologyFlag(flag = {}) {
  const message = String(flag.message || flag.text || '');
  const resolvedColloquialTime = HALF_HOUR_SPOKEN_FORM.test(message)
    && /\b(?:without (?:a )?(?:fully |completely )?specified timestamp|time (?:was|is) (?:not fully specified|unclear)|confirm (?:the )?time)\b/i.test(message);
  return MDSAP_SPOKEN_FORM.test(message) || resolvedColloquialTime;
}

function text(value, max = 2000) {
  return normaliseKnownTerms(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function stableId(prefix, value, index = 0) {
  return `${prefix}-${crypto.createHash('sha1').update(`${index}|${text(value, 4000)}`).digest('hex').slice(0, 10)}`;
}

const DEFAULT_MEETING_LOCATION = 'Microsoft Teams';

function sanitiseDetails(candidate = {}) {
  // Spelling variants of the always-internal people are shown under their proper name.
  const names = (value) => [...new Set((Array.isArray(value) ? value : [])
    .map((name) => text(name, 180)).filter(Boolean)
    .map((name) => alwaysInternalAttendeeName(name) || name))].slice(0, 100);
  const attendeeKey = (name) => text(name, 180).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[’‘`]/g, "'").toLowerCase();
  const suppliedAll = names(candidate.allAttendees || candidate.participants);
  let internalAttendees = names(candidate.internalAttendees);
  let clientAttendees = names(candidate.clientAttendees);
  // Calling someone a client asserts a relationship. With no participant
  // recognised as internal, nobody in the meeting is known to be hosting a
  // client (a team's own rehearsal, a committee, a supplier call), so the
  // attendees are listed as the meeting's own rather than defaulting to Client.
  // Where an internal participant is recognised, unrecognised people are still
  // placed on the client side, for the reviewer to move.
  if (!internalAttendees.length && !clientAttendees.length) {
    internalAttendees = suppliedAll.filter((name) => KNOWN_INTERNAL_ATTENDEE_KEYS.has(attendeeKey(name)));
    clientAttendees = internalAttendees.length
      ? suppliedAll.filter((name) => !KNOWN_INTERNAL_ATTENDEE_KEYS.has(attendeeKey(name)))
      : [];
    if (!internalAttendees.length) internalAttendees = [...suppliedAll];
  } else {
    const assigned = new Set([...internalAttendees, ...clientAttendees].map(attendeeKey));
    const unassigned = suppliedAll.filter((name) => !assigned.has(attendeeKey(name)));
    if (internalAttendees.length) clientAttendees.push(...unassigned);
    else if (!clientAttendees.length) internalAttendees.push(...unassigned);
    else clientAttendees.push(...unassigned);
  }
  // Some people are always internal, whichever list the transcript, a model or an
  // earlier save put them in.
  const alwaysInternal = clientAttendees.filter((name) => alwaysInternalAttendeeName(name));
  if (alwaysInternal.length) internalAttendees = names([...internalAttendees, ...alwaysInternal]);
  const internalKeys = new Set(internalAttendees.map(attendeeKey));
  clientAttendees = clientAttendees.filter((name) => !internalKeys.has(attendeeKey(name)));
  const allAttendees = names([...suppliedAll, ...internalAttendees, ...clientAttendees]);
  return {
    meetingTitle: text(candidate.meetingTitle, 300),
    meetingDate: TimingIntegrity.isValidCalendarDate(text(candidate.meetingDate, 20)) ? text(candidate.meetingDate, 20) : '',
    meetingLocation: text(candidate.meetingLocation, 200) || DEFAULT_MEETING_LOCATION,
    meetingType: text(candidate.meetingType, 200),
    clientAttendeeLabel: candidate.clientAttendeeLabel === 'External' ? 'External' : 'Client',
    internalAttendees,
    clientAttendees,
    allAttendees
  };
}

function normaliseSourceUnits(units = []) {
  return (Array.isArray(units) ? units : []).slice(0, 10000).map((unit, index) => ({
    id: /^T\d{4,}$/.test(text(unit?.id, 30)) ? text(unit.id, 30) : `T${String(index + 1).padStart(4, '0')}`,
    sequence: index + 1,
    speaker: text(unit?.speaker, 180) || 'Speaker',
    timestamp: /^\d{1,2}:\d{2}(?::\d{2})?$/.test(text(unit?.timestamp, 20)) ? text(unit.timestamp, 20) : '',
    text: text(unit?.text || unit?.cleanedText, 5000),
    classification: unit?.classification === 'remove' ? 'remove' : (unit?.classification === 'uncertain' ? 'uncertain' : 'keep'),
    confidence: Math.max(0, Math.min(1, Number(unit?.confidence || 0))),
    restored: unit?.restored === true
  })).filter((unit) => unit.text);
}

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

function contentTokens(value) {
  const stop = new Set(['about', 'after', 'again', 'also', 'been', 'being', 'could', 'from', 'have', 'into', 'just', 'more', 'only', 'over', 'said', 'that', 'their', 'there', 'they', 'this', 'with', 'would']);
  return [...new Set(text(value, 10000).toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || [])].filter((token) => !stop.has(token));
}

function tokenOverlap(left, right) {
  const a = contentTokens(left);
  const b = new Set(contentTokens(right));
  if (!a.length || !b.size) return 0;
  return a.filter((token) => b.has(token)).length / Math.min(a.length, b.size);
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

const ACTION_VERB_GROUPS = [
  ['send', 'share', 'provide', 'forward', 'circulate', 'email', 'issue', 'deliver', 'submit'],
  ['review', 'check', 'assess', 'inspect', 'evaluate', 'analyse', 'audit'],
  ['create', 'produce', 'prepare', 'draft', 'develop', 'build', 'write', 'compile'],
  ['update', 'revise', 'amend', 'change', 'edit', 'correct'],
  ['complete', 'finish', 'finalise', 'close'],
  ['confirm', 'clarify', 'determine', 'decide', 'agree', 'resolve', 'figure'],
  ['test', 'verify', 'validate', 'run', 'rerun'],
  ['contact', 'call', 'message', 'speak', 'follow', 'chase'],
  ['schedule', 'arrange', 'book', 'organise', 'coordinate'],
  ['sign', 'attest', 'acknowledge', 'accept'],
  ['trace', 'find', 'identify', 'investigate', 'source'],
  ['fix', 'repair', 'remediate'],
  ['split', 'separate', 'divide', 'classify', 'categorise', 'categorize'],
  ['automate', 'script']
];

function actionPredicateGroupIndexes(value = '') {
  const words = contentTokens(value).slice(0, 10);
  return new Set(ACTION_VERB_GROUPS.map((group, index) => words.some((word) => group.includes(word)) ? index : -1)
    .filter((index) => index >= 0));
}

function actionPredicatesCompatible(left = '', right = '') {
  const a = actionPredicateGroupIndexes(left);
  const b = actionPredicateGroupIndexes(right);
  if (!a.size || !b.size) return true;
  return [...a].some((index) => b.has(index));
}

function actionPredicateSupported(action, evidence) {
  const actionTokens = contentTokens(action);
  const first = actionTokens[0];
  if (!first) return false;
  // Formal minutes often replace a conversational execution verb with a
  // grammatical lead such as "conduct" or "perform": "manually do it ...
  // then test it" becomes "Conduct a manual test". Resolve the predicate from
  // the concrete operation named later in the action before comparing it with
  // the evidence. Treating every execution verb as universally equivalent
  // would be unsafe ("conduct a review" is not "send a review"), so this only
  // selects the specific verb family also present in the action itself.
  const genericExecution = new Set(['conduct', 'perform', 'execute', 'undertake', 'carry', 'do']);
  const source = String(evidence || '').toLowerCase();
  const groupSupported = (candidates) => candidates.some((verb) => {
    const irregular = { send: 'send|sends|sent|sending', write: 'write|writes|wrote|written|writing', speak: 'speak|speaks|spoke|spoken|speaking' }[verb];
    const forms = irregular || (verb.endsWith('e')
      ? `${verb}|${verb}s|${verb}d|${verb.slice(0, -1)}ing`
      : `${verb}|${verb}s|${verb}ed|${verb}ing`);
    return new RegExp(`\\b(?:${forms})\\b`, 'i').test(source);
  });
  const firstGroup = ACTION_VERB_GROUPS.find((values) => values.includes(first));
  if (firstGroup && groupSupported(firstGroup)) return true;
  // Conversational commitments to resolve a decision commonly use "work
  // out" or "work through" where formal minutes use determine, decide or
  // resolve. Treat that as a predicate match only when the evidence also
  // passes the commitment/status classifier; a bare speculative discussion
  // about working something out must not ground an action.
  const decisionVerbs = new Set(['confirm', 'clarify', 'determine', 'decide', 'agree', 'resolve', 'figure']);
  if (decisionVerbs.has(first) && ACTION_DECISION_RESOLUTION_PATTERN.test(source)
    && ['committed', 'accepted_request', 'conditional_commitment'].includes(actionEvidenceDisposition(action, evidence))) return true;

  // Some formalised records use "complete" as a wrapper around the actual
  // evidenced operation (for example, "complete and sign the forms"). In that
  // construction, validate the concrete conjunct as well. This is deliberately
  // limited to recognised action verbs in the opening phrase, so a matching
  // noun later in an unrelated generated sentence cannot launder the action.
  if (genericExecution.has(first) || first === 'complete') {
    const concreteGroups = ACTION_VERB_GROUPS.filter((values) => actionTokens.slice(1, 7).some((token) => values.includes(token)));
    if (concreteGroups.some(groupSupported)) return true;
  }
  return groupSupported([first]);
}

function actionEvidenceFits(action, evidence) {
  if (actionPredicateSupported(action, evidence)) return true;
  const objectTokens = materialTokens(action).slice(1);
  if (objectTokens.length < 3) return false;
  const evidenceWords = new Set(contentTokens(evidence));
  const coverage = objectTokens.filter((token) => evidenceWords.has(token)).length / objectTokens.length;
  return coverage >= 0.5 && ['committed', 'accepted_request', 'conditional_commitment'].includes(actionEvidenceDisposition(action, evidence));
}

function resolveEvidence(value, units = [], supplied = [], options = {}) {
  const context = evidenceContextFor(units);
  const { rows, known, indexById } = context;
  const claimTokens = resolutionTokens(value);
  const claimProfile = evidenceScoreProfile(value);
  const claimedCalendarDate = TimingIntegrity.explicitCalendarDate(value, options.meetingDate);
  const maximumDistinctiveFrequency = Math.max(3, Math.ceil(rows.length * 0.04));
  const distinctiveClaimTokens = claimTokens.filter((token) => {
    const frequency = context.documentFrequency.get(token) || 0;
    return frequency > 0 && frequency <= maximumDistinctiveFrequency;
  });
  const resolutionScore = (windowProfile) => {
    // Distinctive-word overlap must not bypass the value check performed by
    // the base scorer. Otherwise a fee/count claim can acquire unrelated
    // supplier citations even though none contains its numbers.
    const supportedYear = claimedCalendarDate && TimingIntegrity.isValidCalendarDate(options.meetingDate)
      && TimingIntegrity.explicitCalendarDates(windowProfile.value, options.meetingDate, { requireYearContext: true }).includes(claimedCalendarDate)
      ? claimedCalendarDate.slice(0, 4) : '';
    const scoreProfile = supportedYear ? { ...claimProfile, values: claimProfile.values.filter(value => String(value) !== supportedYear) } : claimProfile;
    if (scoreProfile.values.some((value) => !explicitValuePresent(value, windowProfile.lower))) return 0;
    const base = evidenceSupportScoreFromProfiles(scoreProfile, windowProfile);
    if (distinctiveClaimTokens.length < 2) return base;
    const distinctiveCoverage = distinctiveClaimTokens.filter((token) => windowProfile.resolutionTokenSet.has(token)).length / distinctiveClaimTokens.length;
    return (base * 0.25) + (distinctiveCoverage * 0.75);
  };
  const windowProfileFor = (ids) => {
    const indexes = [...new Set((ids || []).map((id) => indexById.get(id)).filter((index) => Number.isInteger(index))
      .flatMap((index) => [index - 1, index, index + 1]).filter((index) => index >= 0 && index < rows.length))].sort((a, b) => a - b);
    if (indexes.length === 3 && indexes[1] === indexes[0] + 1 && indexes[2] === indexes[1] + 1) {
      const centre = indexes[1];
      if (context.windowProfiles[centre]?.value === indexes.map((index) => context.directTexts[index]).join(' ')) return context.windowProfiles[centre];
    }
    return evidenceScoreProfile(indexes.map((index) => context.directTexts[index]).join(' '));
  };
  const suppliedIds = [...new Set((Array.isArray(supplied) ? supplied : []).map((id) => text(id, 30)).filter(Boolean))];
  const cacheKey = `${TimingIntegrity.TIMING_POLICY_VERSION}|${options.meetingDate || ''}|${options.action ? 'a' : 'p'}|${options.preserveDiscussionEvidence === true ? '12' : '8'}|${text(value, 5000)}|${suppliedIds.join(',')}`;
  const cached = context.resolutionCache.get(cacheKey);
  if (cached) return { ...cached, evidenceIds: [...cached.evidenceIds], invalidIds: [...cached.invalidIds], weakIds: [...cached.weakIds] };
  const finish = (result) => {
    if (context.resolutionCache.size >= 2000) context.resolutionCache.clear();
    context.resolutionCache.set(cacheKey, result);
    return { ...result, evidenceIds: [...result.evidenceIds], invalidIds: [...result.invalidIds], weakIds: [...result.weakIds] };
  };
  const invalidIds = suppliedIds.filter((id) => !known.has(id));
  const validIds = suppliedIds.filter((id) => known.has(id));
  const selectedSuppliedIds = () => {
    if (!claimedCalendarDate) return validIds.slice(0, options.preserveDiscussionEvidence === true ? 12 : 8);
    const defining = validIds.filter(id => TimingIntegrity.explicitCalendarDates(rows[indexById.get(id)]?.text, options.meetingDate).includes(claimedCalendarDate));
    const qualifications = validIds.filter(id => /\b(?:prefer(?:red|ably)?|ideally|fallback|contingency|hard stop|instead)\b/i.test(rows[indexById.get(id)]?.text || '')
      && defining.some(anchor => Math.abs(indexById.get(id) - indexById.get(anchor)) <= 16));
    return [...new Set([...defining, ...qualifications, ...validIds])].slice(0, 8);
  };
  const claimWordSet = claimProfile.tokenSet;
  const speakersSupported = (profile) => context.speakerTokens.every((speakerWords) => {
    const mentioned = speakerWords.length === 1
      ? claimWordSet.has(speakerWords[0])
      : speakerWords.every((word) => claimWordSet.has(word));
    return !mentioned || speakerWords.some((word) => profile.tokenSet.has(word));
  });
  const scoreWindow = (profile) => {
    if (!speakersSupported(profile)) return 0;
    const lexicalScore = resolutionScore(profile);
    // The action classifier contains deliberately broad conversational
    // patterns. Running it over every unrelated transcript window is both
    // wasteful and susceptible to pathological regex work. A window with no
    // plausible lexical support cannot become evidence regardless.
    if (lexicalScore < 0.12) return 0;
    if (options.action && !actionEvidenceFits(value, profile.value)) return 0;
    return lexicalScore;
  };
  const suppliedWindow = windowProfileFor(validIds);
  const suppliedScore = scoreWindow(suppliedWindow);
  // Score each supplied anchor independently as well as their combined window.
  // Concatenating several adjacent but generic passages can inflate token
  // overlap and conceal a clearly better workstream elsewhere.
  const suppliedAnchorScore = validIds.reduce((best, id) => Math.max(best, scoreWindow(windowProfileFor([id]))), 0);
  const ranked = rows.map((unit, index) => {
    const window = context.windowProfiles[index];
    return {
      id: unit.id,
      index: indexById.get(unit.id),
      score: scoreWindow(window)
    };
  }).filter((item) => item.score >= 0.24).sort((a, b) => b.score - a.score);
  const bestScore = ranked[0]?.score || 0;
  const supportingRanked = options.action ? rows.map((unit, index) => {
    const window = context.windowProfiles[index];
    return {
      id: unit.id,
      index: indexById.get(unit.id),
      score: speakersSupported(window) ? resolutionScore(window) : 0
    };
  }).filter((item) => item.score >= 0.24).sort((a, b) => b.score - a.score) : ranked;
  // A valid ID is not necessarily the right evidence. Long transcripts often
  // contain an earlier passage with the same generic verbs and participant
  // names as a later deliverable. Previously any supplied window scoring 0.20
  // was accepted immediately, so an early "determine the calendar" passage
  // could remain attached to a later decision about a different workstream.
  // Keep a plausible supplied citation unless the transcript contains a
  // materially stronger passage; this preserves exact Agent citations while
  // allowing the server to repair clear workstream drift.
  const strongerAlternative = bestScore >= 0.28 && bestScore > suppliedAnchorScore + 0.08;
  if (validIds.length && suppliedScore >= 0.2 && !strongerAlternative) {
    return finish({ evidenceIds: selectedSuppliedIds(), invalidIds, weakIds: [], supportScore: suppliedScore });
  }

  // When remapping, do not return the three highest-scoring anchors from
  // unrelated parts of the meeting. Retain only anchors close to the best
  // score, then cite the most directly supportive turn inside each anchor's
  // context window. This keeps multi-part evidence (for example a constraint
  // followed by the commitment that resolves it) without pulling in a weaker
  // lookalike workstream elsewhere in the transcript.
  const remapBestScore = Math.max(bestScore, supportingRanked[0]?.score || 0);
  const remapFloor = Math.max(0.24, remapBestScore - 0.15);
  const remapAnchors = [...new Map([...ranked, ...supportingRanked]
    .filter((item) => item.score >= remapFloor)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((item) => [item.id, item])).values()].slice(0, 6);
  const remappedEvidence = remapAnchors.map((anchor) => {
    const nearby = [anchor.index - 1, anchor.index, anchor.index + 1]
      .filter((index) => index >= 0 && index < rows.length)
      .map((index) => {
        const unit = rows[index];
        return {
          id: unit.id,
          index,
          // The surrounding anchor has already established named speakers.
          // Score the direct turn on its content here so a commitment using
          // "you" is not discarded merely because the addressee's full name
          // appears in the immediately preceding turn rather than this one.
          score: resolutionScore(context.directProfiles[index])
        };
      }).sort((left, right) => right.score - left.score || left.index - right.index);
    return nearby[0] || { id: anchor.id, index: anchor.index, score: anchor.score };
  });
  const strongestById = new Map();
  for (const item of remappedEvidence) {
    const prior = strongestById.get(item.id);
    if (!prior || item.score > prior.score) strongestById.set(item.id, item);
  }
  // Select by evidence strength before restoring transcript order. Slicing
  // after an order-only sort previously discarded a later, stronger turn in
  // favour of an earlier contextual question.
  const remappedIds = [...strongestById.values()]
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 3)
    .sort((left, right) => left.index - right.index)
    .map((item) => item.id);
  return finish({
    evidenceIds: remappedIds,
    invalidIds,
    weakIds: suppliedScore >= 0.2 || (remappedIds.length && remapBestScore >= 0.28) ? [] : validIds,
    supportScore: bestScore
  });
}

// How the meeting was run, not what it decided. These lines are real speech and
// often survive denoising, but they are not minutes content, so they must never
// be inventoried as an important detail and surfaced as something to check.
// "I've got a delivery arriving, I need to shoot" is someone leaving the call,
// not a commitment, even though "need to" is a commitment cue. Leaving verbs
// are only treated as leaving when nothing is being shot/sent *to* anyone.
const LEAVING_REMARK_PATTERN = /\b(?:(?:need|needs|have|got|going|about|time) to (?:shoot|dash|go|run|head (?:off|out)|get off|leave|be off)\b(?!\s+(?:you|it|that|this|the|a|an|over|across|through|them))|i(?:'ll| will) (?:shoot|dash|head off|be off)\b(?!\s+(?:you|it|that|this|the|a|an|over|across|through|them))|let you go|gotta go|got to go|delivery(?:'s| is)? (?:here|arriving|at the door)|someone(?:'s| is)? at the door|catch you later|see you (?:later|then|soon|all)|speak (?:later|soon))\b/i;
const MEETING_ADMIN_PATTERN = /\b(?:hard stop|drop(?:ping)? off|another (?:call|meeting)|running late|can you hear|breaking up|share (?:my|the) screen|screen[- ]?shar|recording (?:has )?(?:started|stopped)|stop(?:ped)? recording|on mute|un\s?mute|you'?re muted|bear with me|lost (?:you|connection)|connection (?:is )?(?:bad|poor)|back in a (?:sec|second|minute)|meeting (?:started|opened|began) with (?:attendee )?introductions?|attendees? introduced themselves|presence of .{0,80}(?:was|were) noted)\b/i;
const DELIVERABLE_CONTEXT_PATTERN = /\b(?:action|approval|audit|assessment|CAPA|change|compliance|decision|document|file|finding|plan|procedure|report|review|risk|scope|software|standard|submission|test|tracker|training|translation|validation|version)\b/i;
// Declarative technical behaviour is discussion evidence even when it contains no
// decision, owner or future action. Giving it an explicit candidate kind protects
// statements such as "the device does not..." from being crowded out by commitments.
const TECHNICAL_BEHAVIOUR_PATTERN = /\b(?:the|a|an)\s+(?:device|system|software|application|platform|interface|firmware|product|feature|module|component|test|procedure|process)\b[^.!?]{0,140}\b(?:is|are|was|were|does|do|did|doesn['’]t|do not|did not|can|cannot|will|supports?|allows?|prevents?|requires?)\b/i;
// Preserve generic responsibility boundaries, provisional workstream
// allocation and operational coordination for later classification.
const MATERIAL_DISCUSSION_CONTEXT_PATTERN = /\b(?:corporate|head office|site[- ]level|top[- ]level|handled (?:at|by)|fed down|responsibil(?:ity|ities)|separate track|workstream|in parallel|coordinate|coordination|handover|debrief|end of day|after (?:the )?site|on the way back|return journey)\b/i;

function salientExcerpt(value, pattern) {
  const source = text(value, 5000);
  const sentences = source.split(/(?<=[.!?])\s+/).filter(Boolean);
  const sentence = sentences.find((part) => pattern.test(part)) || source;
  if (sentence.length <= 360) return sentence;
  const match = sentence.search(pattern);
  if (match < 0) return sentence.slice(0, 360);
  let start = Math.max(0, match - 140);
  if (start) {
    const nextBoundary = sentence.indexOf(' ', start);
    if (nextBoundary > start && nextBoundary < match) start = nextBoundary + 1;
  }
  const end = Math.min(sentence.length, match + 220);
  return `${start ? '…' : ''}${sentence.slice(start, end).trim()}${end < sentence.length ? '…' : ''}`;
}

function salientDetailInventory(units = []) {
  const patterns = [
    ['quantity', /\b(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:(?:additional|extra|more|not[- ]started|outstanding|remaining|completed?)\s+)?(?:languages?|alarms?|bands?|levels?|categories|devices?|products?|tests?|documents?|weeks?|days?|items?|versions?|samples?|units?|batches|sites?)\b/i],
    ['progress_change', /\b(?:mov(?:e|ed|ing)|progress(?:ed|ion)?|reduc(?:e|ed|tion)|increas(?:e|ed)|fell|rose|down|up|from)\b[^.!?]{0,100}\b(?:to|by|from)\s+(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\b/i],
    // A number is a standards reference because something says so in front of it.
    // The prefix used to be optional, which made this "any bare 3-5 digit number"
    // and turned "a hard stop at 1130" into a reference for the reviewer to check.
    ['standard_reference', /\b(?:BS\s+EN|EN|IEC|ISO|ASTM|standards?)\s+\d{3,5}(?:[-–]\d+)*(?::\d{4})?\b/i],
    ['alarm_behaviour', /\b(?:alarm|audible|mute|silenc|beep)\b/i],
    ['approval_status', /\b(?:approved?|accepted?|signed?\s*off|pending approval|not approved|rejected?)\b/i],
    ['blocker_dependency', /\b(?:block(?:ed|er|ing)?|depend(?:s|ent|ency)?|waiting for|held up|holding (?:it|this|that|them) up|stalled|delayed by|subject to|before .* can|once .* (?:is|has been)|cannot .* until|pending)\b/i]
  ];
  const result = [];
  for (const unit of normaliseSourceUnits(units).filter(includedUnit)) {
    if (MEETING_ADMIN_PATTERN.test(unit.text) || LEAVING_REMARK_PATTERN.test(unit.text)) continue;
    for (const [kind, pattern] of patterns) {
      if (!pattern.test(unit.text)) continue;
      if (kind === 'alarm_behaviour' && /\bno alarm bells?\b/i.test(unit.text)) continue;
      if (kind === 'blocker_dependency' && !DELIVERABLE_CONTEXT_PATTERN.test(unit.text)) continue;
      if (kind === 'progress_change' && !DELIVERABLE_CONTEXT_PATTERN.test(unit.text)) continue;
      if (kind === 'quantity' && /\b(?:weeks?|days?|sites?)\b/i.test(unit.text) && !DELIVERABLE_CONTEXT_PATTERN.test(unit.text)) continue;
      result.push({ id: stableId('detail', `${kind}|${unit.id}`), kind, text: salientExcerpt(unit.text, pattern), evidenceIds: [unit.id] });
    }
  }
  // Avoid allowing a long run of quantities near the beginning to crowd every
  // standard, dependency or approval out of the prompt. Round-robin by kind,
  // retaining transcript order inside each category.
  const byKind = new Map(patterns.map(([kind]) => [kind, result.filter((item) => item.kind === kind)]));
  const balanced = [];
  while (balanced.length < 80 && [...byKind.values()].some((items) => items.length)) {
    for (const [kind] of patterns) {
      const item = byKind.get(kind).shift();
      if (item) balanced.push(item);
      if (balanced.length >= 80) break;
    }
  }
  return balanced;
}

function normaliseFlag(flag = {}, index = 0) {
  const suppliedKind = text(flag.kind || flag.type, 80).toLowerCase();
  const aliasedKind = FLAG_KIND_ALIASES[suppliedKind] || suppliedKind;
  const kind = FLAG_KINDS.has(aliasedKind) ? aliasedKind : 'uncertain_fact';
  const message = text(flag.message || flag.text || 'Review this item against the transcript.', 500);
  const systemTimingIssue = normaliseSystemTimingIssue(flag.systemTimingIssue);
  return rememberFlag({
    id: text(flag.id, 80) || (systemTimingIssue ? stableId('flag-timing', JSON.stringify(systemTimingIssue), 0) : stableId('flag', `${kind}|${message}`, index)),
    kind,
    message,
    evidenceIds: [...new Set((Array.isArray(flag.evidenceIds) ? flag.evidenceIds : []).map((id) => text(id, 30)).filter(Boolean))].slice(0, 8),
    status: ['open', 'confirmed', 'corrected', 'dismissed'].includes(flag.status) ? flag.status : 'open',
    correctionNote: text(flag.correctionNote, 500),
    ...(isReviewerAuthored(flag) ? { reviewerAuthored: true } : {}),
    ...(systemTimingIssue ? { systemTimingIssue } : {}),
    ...(['executiveSummary', 'meetingObjectives', 'timedStepCoverage'].includes(flag.temporalField)
      ? { temporalField: flag.temporalField } : {})
  });
}

// Many pipeline steps re-normalise records and keep only the records, so a
// flag created on the way (and referenced by the record's reviewFlagIds) was
// dropped while the reference survived. Every flag is remembered here by id so
// a stage can recover what its records point at. Bounded; oldest go first.
const FLAG_REGISTRY = new Map();
const FLAG_REGISTRY_LIMIT = 20000;
function rememberFlag(flag) {
  FLAG_REGISTRY.delete(flag.id);
  FLAG_REGISTRY.set(flag.id, flag);
  if (FLAG_REGISTRY.size > FLAG_REGISTRY_LIMIT) FLAG_REGISTRY.delete(FLAG_REGISTRY.keys().next().value);
  return flag;
}

function flagRecordsIn(value, out = []) {
  if (Array.isArray(value)) { for (const item of value) flagRecordsIn(item, out); return out; }
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value.reviewFlagIds)) out.push(value);
  for (const key of ['points', 'decisions', 'openQuestions', 'supportingDetails', 'actions', 'discussion']) {
    if (Array.isArray(value[key])) flagRecordsIn(value[key], out);
  }
  return out;
}

// Returns the flags the records point at (recovered where they were dropped)
// and strips references that cannot be resolved. Mutates only copies.
// Owners a removal/change warning says were taken off. Later merges can put an
// owner back, which left "…so it was removed" beside the very name it named.
function ownersNamedAsRemoved(message = '') {
  const text = String(message || '');
  const match = text.match(/does not show (.+?) taking this on, so it was removed/i)
    || text.match(/\bnot (.+?)\. Confirm the owner\./i)
    || text.match(/^Owner removed: (.+?) only asked/i);
  return match ? match[1].split(/\s+or\s+/).map((name) => name.trim().toLowerCase()).filter(Boolean) : [];
}

function reconcileRecordFlags(content = {}, flags = [], isUseful = () => true) {
  const copy = JSON.parse(JSON.stringify(content || {}));
  const byId = new Map((Array.isArray(flags) ? flags : []).map((flag) => [flag.id, flag]));
  const recovered = [];
  const contradicted = new Set();
  for (const record of flagRecordsIn(copy)) {
    const owners = (Array.isArray(record.owners) ? record.owners : []).map((owner) => String(owner).trim().toLowerCase());
    if (!owners.length || !Array.isArray(record.reviewFlagIds)) continue;
    record.reviewFlagIds = record.reviewFlagIds.filter((id) => {
      const flag = byId.get(id) || FLAG_REGISTRY.get(id);
      const named = flag && flag.kind === 'ownership' ? ownersNamedAsRemoved(flag.message) : [];
      if (named.length && named.every((name) => owners.includes(name))) { contradicted.add(id); return false; }
      return true;
    });
  }
  for (const id of contradicted) {
    const stillUsed = flagRecordsIn(copy).some((record) => (record.reviewFlagIds || []).includes(id));
    if (!stillUsed) byId.delete(id);
  }
  flags = (Array.isArray(flags) ? flags : []).filter((flag) => byId.has(flag.id));
  for (const record of flagRecordsIn(copy)) {
    record.reviewFlagIds = [...new Set(record.reviewFlagIds)].filter((id) => {
      if (byId.has(id)) return true;
      const remembered = FLAG_REGISTRY.get(id);
      if (!remembered || !isUseful(remembered)) return false;
      byId.set(id, remembered);
      recovered.push(remembered);
      return true;
    });
  }
  return { content: copy, flags: [...(Array.isArray(flags) ? flags : []), ...recovered], recovered: recovered.length };
}

function isSalientCoverageFlag(flag = {}) {
  return /^coverage-detail-/i.test(String(flag.id || ''))
    || String(flag.message || flag.text || '').startsWith(COVERAGE_FLAG_MESSAGE);
}

// A supported statement can itself say that something is pending, conditional or
// undecided. That is meeting content, not uncertainty about the extraction. Keep
// `uncertain_fact` for genuinely ambiguous/conflicting source wording; the other
// flag kinds already cover owners, timing, references and missing evidence.
function isUsefulReviewFlag(flag = {}) {
  if (isAutomaticTerminologyFlag(flag)) return false;
  const normalised = normaliseFlag(flag);
  if (isSalientCoverageFlag(flag)) {
    return /^coverage-detail-/i.test(String(flag.id || ''))
      || normalised.status !== 'open' || Boolean(normalised.correctionNote);
  }
  // Unsupported owner/timing fields are removed before the draft reaches the
  // reviewer. Asking somebody to confirm a value which is no longer present is
  // duplicate work, not a useful warning. Genuine ambiguity/conflict flags use
  // different wording and remain visible.
  if (['ownership', 'timing'].includes(normalised.kind)
    && /^(?:confirm or correct unsupported action|the exact date .+ was not supported .+ and has been removed)/i.test(normalised.message)
    && normalised.status === 'open' && !normalised.correctionNote) return false;
  if (normalised.kind !== 'uncertain_fact') return true;
  if (normalised.status !== 'open' || normalised.correctionNote) return true;
  // The quantified-claim gate creates these only when the source does not bind
  // a stated location/duration to the named work. Its typed uncertainty must
  // survive save/publication regardless of the warning's prose wording.
  if (/^flag-quantity-binding-/.test(String(normalised.id || ''))) return true;
  // A fidelity checker could not establish a safe replacement. Its typed
  // warning must survive independently of the provider's choice of prose.
  if (/^flag-fidelity-meaning-/.test(String(normalised.id || ''))) return true;
  return MATERIAL_UNCERTAINTY_PATTERN.test(normalised.message);
}

function reviewerProvenance(value, options = {}) {
  // Only a reviewer-save boundary may carry authorship into persisted rows.
  // Generated JSON cannot grant itself an exemption from publication checks.
  if (options.preserveReviewerEdits !== true) return {};
  return {
    ...(value?.reviewerAuthored === true ? { reviewerAuthored: true } : {}),
    ...(value?.confirmedTopic === true ? { confirmedTopic: true } : {})
  };
}

// Merge history describes deleted predecessor records; it is not evidence or
// reviewer authorship. Only the editor-save boundary carries this metadata,
// without requiring its historical IDs to exist in the current register.
// Historical topic writers allowed 220-character IDs: reject longer values
// rather than truncating them into a different record's identity.
function reviewerFilingProvenance(value, options = {}) {
  return options.preserveReviewerEdits === true
    ? require('./meetingMinutesFilingProvenance').filingProvenance(value) : {};
}

function reviewerMergeHistory(value, field, survivorId, options = {}) {
  if (options.preserveReviewerEdits !== true || !Array.isArray(value?.[field])) return {};
  const ids = [...new Set(value[field].slice(0, 1000)
    .filter(id => typeof id === 'string' && id.length <= 220)
    .map(id => id.trim())
    .filter(id => id && id !== survivorId && !/[\u0000-\u001f\u007f]/.test(id)))];
  return ids.length ? { [field]: ids } : {};
}

function normalisePoint(value, units, prefix, index, options = {}) {
  const candidate = typeof value === 'string' ? { text: value } : (value || {});
  // A reviewer may promote complete retained context into the minutes. Keep
  // their full wording at the save boundary, as for filed supporting details.
  const pointText = options.preserveReviewerEdits === true && candidate.reviewerAuthored === true
    ? String(candidate.text || candidate.point || candidate.value || '').trim()
    : text(candidate.text || candidate.point || candidate.value, 1600);
  if (!pointText) return null;
  const pointId = text(candidate.id, 80) || stableId(prefix, pointText, index);
  const suppliedIds = (Array.isArray(candidate.evidenceIds) ? candidate.evidenceIds : []).map((id) => text(id, 30)).filter(Boolean);
  const resolved = resolveEvidence(pointText, units, candidate.evidenceIds, { meetingDate: options.meetingDate, preserveDiscussionEvidence: true });
  if (options.preserveReviewerEdits === true && candidate.reviewerAuthored === true && candidate.filingOrigins?.length) {
    const validSuppliedIds = [...new Set(suppliedIds.filter(id => evidenceContextFor(units).known.has(id)))];
    if (validSuppliedIds.length) resolved.evidenceIds = validSuppliedIds;
  }
  if (correctnessChecksEnabled() && !suppliedIds.some((id) => evidenceContextFor(units).known.has(id))
    && resolved.evidenceIds.length && !uncitedClaimSupported(pointText, resolved, units)) {
    resolved.evidenceIds = [];
  }
  const supportingDetails = (Array.isArray(candidate.supportingDetails) ? candidate.supportingDetails : [])
    .map((detail, detailIndex) => {
      const source = typeof detail === 'string' ? { text: detail } : (detail || {});
      // Filing retained context is a reviewer operation. Do not truncate a
      // complete review-only detail when it is moved under a chosen point.
      const detailText = options.preserveReviewerEdits === true && source.reviewerAuthored === true
        ? String(source.text || source.point || source.value || '').trim()
        : text(source.text || source.point || source.value, 1600);
      if (!detailText) return null;
      const detailEvidence = resolveEvidence(detailText, units, source.evidenceIds, { meetingDate: options.meetingDate });
      if (options.preserveReviewerEdits === true && source.reviewerAuthored === true) {
        const validSuppliedIds = [...new Set((Array.isArray(source.evidenceIds) ? source.evidenceIds : [])
          .map(id => text(id, 30)).filter(id => evidenceContextFor(units).known.has(id)))];
        if (validSuppliedIds.length) detailEvidence.evidenceIds = validSuppliedIds;
      }
      const detailFlags = [...new Set((Array.isArray(source.reviewFlagIds) ? source.reviewFlagIds : []).map((id) => text(id, 80)).filter(Boolean))];
      const detailId = text(source.id, 80) || stableId(`${prefix}-supporting`, detailText, detailIndex);
      return {
        id: detailId,
        ...reviewerProvenance(source, options),
        ...reviewerMergeHistory(source, 'mergedFromIds', detailId, options),
        ...reviewerFilingProvenance(source, options),
        ...(typeof source.originalTopic === 'string' && text(source.originalTopic, 220)
          ? { originalTopic: text(source.originalTopic, 220) } : {}),
        ...(source.placementStatus === 'unresolved' ? {
          placementStatus: 'unresolved', placementReason: text(source.placementReason, 100)
        } : {}),
        text: detailText,
        evidenceIds: detailEvidence.evidenceIds,
        // A context line keeps its flag, so the flag can point at it.
        ...(detailFlags.length ? { reviewFlagIds: detailFlags } : {})
      };
    }).filter(Boolean).slice(0, options.preserveReviewerEdits === true ? undefined : 50);
  return {
    id: pointId,
    ...reviewerProvenance(candidate, options),
    ...reviewerMergeHistory(candidate, 'mergedFromIds', pointId, options),
    ...reviewerFilingProvenance(candidate, options),
    ...(typeof candidate.originalTopic === 'string' && text(candidate.originalTopic, 220)
      ? { originalTopic: text(candidate.originalTopic, 220) } : {}),
    text: pointText,
    ...(['core', 'supporting', 'reject'].includes(candidate.discoveryDisposition)
      ? { discoveryDisposition: candidate.discoveryDisposition } : {}),
    evidenceIds: resolved.evidenceIds,
    ...(Array.isArray(candidate.primaryEvidenceIds) ? {
      primaryEvidenceIds: [...new Set(candidate.primaryEvidenceIds)]
        .filter((id) => evidenceContextFor(units).known.has(id)).slice(0, 12)
    } : {}),
    supportingDetails,
    reviewFlagIds: [...new Set((Array.isArray(candidate.reviewFlagIds) ? candidate.reviewFlagIds : []).map((id) => text(id, 80)).filter(Boolean))],
    _unsupportedEvidenceIds: resolved.invalidIds,
    _weakEvidenceIds: resolved.weakIds
  };
}

function normalisePointList(values, units, prefix, options = {}) {
  return (Array.isArray(values) ? values : []).map((value, index) => normalisePoint(value, units, prefix, index, options))
    .filter(Boolean).slice(0, options.preserveReviewerEdits === true ? undefined : 50);
}

function recordSimilarity(left, right) {
  const numbers = (value) => new Set(String(value || '').match(/\b\d+(?:[.,]\d+)?%?\b/g) || []);
  const leftNumbers = numbers(left?.text); const rightNumbers = numbers(right?.text);
  if (leftNumbers.size && rightNumbers.size
    && ![...leftNumbers].some((value) => rightNumbers.has(value))) return 0;
  const lexical = tokenOverlap(comparisonText(left?.text || ''), comparisonText(right?.text || ''));
  const leftEvidence = new Set(left?.evidenceIds || []);
  const sharedEvidence = (right?.evidenceIds || []).some((id) => leftEvidence.has(id));
  return lexical + (sharedEvidence ? 0.12 : 0);
}

// Merging generated wording must not discard the other row's source anchors or
// review links. Primary anchors count only when that row's evidence resolution
// retained them. Preserve the original first-eight citation order because the
// subsequent similarity checks also use citation overlap. Reprioritising that
// budget here would change later merge decisions. Selection/ranking stays with
// the original winner, including its wording, id and discovery disposition.
function mergeDiscussionSourceMetadata(winner, other) {
  const evidenceIds = [...new Set([...(winner.evidenceIds || []), ...(other.evidenceIds || [])])];
  const primaryIds = [...new Set([winner, other].flatMap(row =>
    (row.primaryEvidenceIds || []).filter(id => (row.evidenceIds || []).includes(id))))];
  winner.evidenceIds = evidenceIds.slice(0, 8);
  if (Array.isArray(winner.primaryEvidenceIds) || Array.isArray(other.primaryEvidenceIds)) {
    winner.primaryEvidenceIds = primaryIds.filter(id => winner.evidenceIds.includes(id));
  }
  for (const field of ['reviewFlagIds', '_unsupportedEvidenceIds', '_weakEvidenceIds']) {
    if (Array.isArray(winner[field]) || Array.isArray(other[field])) {
      winner[field] = [...new Set([...(winner[field] || []), ...(other[field] || [])])];
    }
  }
}

function dedupePointList(values = []) {
  const kept = [];
  for (const value of values) {
    const duplicate = kept.find((existing) => recordSimilarity(existing, value) >= 0.86);
    if (!duplicate) kept.push(value);
    else {
      mergeDiscussionSourceMetadata(duplicate, value);
      const details = [...(duplicate.supportingDetails || []), ...(value.supportingDetails || [])];
      const keptDetails = [];
      for (const detail of details) {
        const existing = keptDetails.find(other => comparisonText(other.text) === comparisonText(detail.text));
        if (existing) mergeDiscussionSourceMetadata(existing, detail);
        else keptDetails.push(detail);
      }
      duplicate.supportingDetails = keptDetails.slice(0, 50);
    }
  }
  return kept;
}

function discussionTopicItems(candidate = {}) {
  return (Array.isArray(candidate.discussion) ? candidate.discussion : []).map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const hasTopicArrays = ['points', 'decisions', 'openQuestions'].some((key) => Array.isArray(item[key]));
    if (hasTopicArrays) return item;

    // Some Copilot topic versions have returned valid, grounded records in a
    // flat discussion array even though the schema asks for topic containers.
    // Preserve that evidence rather than turning a shape error into an empty
    // draft. Only explicit record labels/text prefixes affect the record type;
    // otherwise the safe default is an ordinary discussion point.
    const recordText = text(item.text || item.point || item.value, 1600);
    if (!recordText) return item;
    const suppliedType = text(item.recordType || item.type || item.kind, 80).toLowerCase().replace(/[\s-]+/g, '_');
    const isDecision = suppliedType === 'decision' || /^decision\s*[:—-]/i.test(recordText);
    const isQuestion = ['open_question', 'openquestion', 'question'].includes(suppliedType)
      || /^open\s+question\s*[:—-]/i.test(recordText);
    const cleanedText = recordText.replace(isDecision
      ? /^decision\s*[:—-]\s*/i
      : isQuestion ? /^open\s+question\s*[:—-]\s*/i : /$^/, '');
    const record = { ...item, text: cleanedText };
    return {
      id: item.topicId,
      topic: text(item.topic || item.category || item.subject, 220) || 'Discussion',
      points: isDecision || isQuestion ? [] : [record],
      decisions: isDecision ? [record] : [],
      openQuestions: isQuestion ? [record] : []
    };
  });
}

function normaliseDiscussion(candidate = {}, units = [], options = {}) {
  const reviewerSave = options.preserveReviewerEdits === true;
  const normaliseRows = (rows, prefix) => {
    const normalised = normalisePointList(rows, units, prefix, options);
    return reviewerSave ? normalised : dedupePointList(normalised);
  };
  const topics = discussionTopicItems(candidate).slice(0, reviewerSave ? undefined : 80).map((item, index) => {
    const topic = text(item?.topic, 220) || 'Discussion';
    const topicId = text(item?.id, 80) || stableId('topic', topic, index);
    return {
      id: topicId,
      ...reviewerProvenance(item, options),
      ...reviewerMergeHistory(item, 'mergedTopicIds', topicId, options),
      topic,
      // The reviewer's choice to leave this title out of the minutes.
      ...(item?.hideHeading === true ? { hideHeading: true } : {}),
      points: normaliseRows(item?.points, `point-${index}`),
      decisions: normaliseRows(item?.decisions, `decision-${index}`),
      openQuestions: normaliseRows(item?.openQuestions, `question-${index}`)
    };
  }).filter((item) => item.points.length || item.decisions.length || item.openQuestions.length);
  // Saving the editor is not a fresh selection pass. Preserve the reviewer's
  // rows and classifications, even when two rows resemble one another or a
  // heading uses an output category. Generated content still uses the gates below.
  if (reviewerSave) return topics;
  const merged = [];
  for (const topic of topics) {
    // A reviewer's save keeps their topics as they arranged them: two cards
    // both still called "New topic", or "Project" beside "Project timeline",
    // are separate topics until the reviewer merges them.
    const existing = options.mergeTopics === false ? null
      : merged.find((item) => tokenOverlap(comparisonText(item.topic), comparisonText(topic.topic)) >= 0.82);
    if (!existing) { merged.push(topic); continue; }
    existing.points = dedupePointList([...existing.points, ...topic.points]);
    existing.decisions = dedupePointList([...existing.decisions, ...topic.decisions]);
    existing.openQuestions = dedupePointList([...existing.openQuestions, ...topic.openQuestions]);
  }
  // A high-confidence decision should not also be shown as an unresolved
  // question or ordinary point. Prefer the more useful record type.
  for (const topic of merged) {
    topic.points = topic.points.filter((point) => !topic.decisions.some((decision) => recordSimilarity(point, decision) >= 0.92));
    topic.openQuestions = topic.openQuestions.filter((question) => !topic.decisions.some((decision) => recordSimilarity(question, decision) >= 0.92));
  }
  // Action buckets are output categories, not discussion subjects. Remove a generated
  // action-only bucket at the normalisation boundary so it cannot leak into the saved
  // draft or exported minutes. Mixed cards remain intact: factual discussion is more
  // important than a coarse heading and must not be thrown away with the actions.
  return merged.filter((topic) => !isActionCategoryTopicCard(topic));
}

function splitOwners(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(/\s*(?:,|&|\band\b)\s*/i);
  return [...new Set(source.map((owner) => text(owner, 180)).filter((owner) => owner && !/^not stated$/i.test(owner)))].slice(0, 12);
}

function ownerIdentityTokens(value) {
  const titles = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'professor']);
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .match(/[a-z0-9]+/g)?.filter((token) => token.length > 1 && !titles.has(token)) || [];
}

function ownerIdentityKey(value) {
  return [...new Set(ownerIdentityTokens(value))].sort().join('|');
}

function canonicalSpeakerDisplayName(value) {
  const raw = text(value, 180);
  const comma = raw.indexOf(',');
  if (comma < 0) return raw;
  const family = raw.slice(0, comma).trim();
  const given = raw.slice(comma + 1).trim().split(/\s+/).filter((part) => {
    return part.replace(/[^A-Za-z0-9]/g, '').length > 1;
  }).join(' ');
  return text(`${given} ${family}`, 180) || raw;
}

function normaliseOwnerIdentity(owner, units = []) {
  const raw = text(owner, 180);
  const ownerWords = ownerIdentityTokens(raw);
  if (!ownerWords.length) return raw;
  const speakers = evidenceContextFor(units).speakers;
  const exactKey = ownerIdentityKey(raw);
  let matches = speakers.filter((speaker) => ownerIdentityKey(speaker) === exactKey);
  if (!matches.length && ownerWords.length === 1) {
    matches = speakers.filter((speaker) => ownerIdentityTokens(speaker).includes(ownerWords[0]));
  }
  // Teams may alternate between "Surname, Given Initial" and "Given Surname"
  // for the same participant. Count canonical identities rather than raw labels,
  // while still refusing to expand an ambiguous first name.
  const identities = new Map();
  for (const speaker of matches) {
    const key = ownerIdentityKey(speaker);
    if (!identities.has(key)) identities.set(key, []);
    identities.get(key).push(speaker);
  }
  if (identities.size !== 1) return raw;
  const aliases = [...identities.values()][0];
  const displays = aliases.map(canonicalSpeakerDisplayName);
  // Prefer an already human-readable source label, then the deterministic
  // inversion of Teams' comma form. Either way every pass gets one spelling.
  return displays.find((name, index) => !aliases[index].includes(',')) || displays[0] || raw;
}

function relativeExactDate(wording, meetingDate) {
  return TimingIntegrity.resolveExactDate(wording, meetingDate);
}

// Parse an explicit calendar day without choosing a future month/year merely
// because the stated date precedes the meeting.
function statedCalendarDate(wording = '', meetingDate = '') {
  return TimingIntegrity.explicitCalendarDate(wording, meetingDate);
}

function timingFrom(item = {}, options = {}) {
  const supplied = item.timing && typeof item.timing === 'object' ? item.timing : {};
  if (options.preserveReviewerEdits === true) return TimingIntegrity.normaliseTimingValue(supplied, { mode: 'preserve', reviewerAuthored: true });
  let wording = text(supplied.wording || item.deadline || item.target, 220);
  let kind = ['deadline', 'target', 'dependency', 'not_stated'].includes(supplied.kind) ? supplied.kind : 'not_stated';
  // "As soon as Christina is back" is a condition, not a date: whatever kind
  // was supplied, a purely conditional wording with no day or date in it is a
  // dependency.
  const conditional = /^(?:as soon as|once|after|when|following|upon|subject to|dependent on|depends on|pending)\b/i.test(wording.trim())
    && !/\b(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month|january|february|march|april|may|june|july|august|september|october|november|december|\d)\b/i.test(wording);
  const urgent = /\b(?:as soon as possible|asap|as soon as you can|as soon as we can)\b/i.test(wording);
  if (conditional && !urgent && (kind === 'deadline' || kind === 'target')) kind = 'dependency';
  // "By the end of the week, hopefully" is a hope, not a deadline.
  if (kind === 'deadline' && /\b(?:hopefully|ideally|aim(?:ing)? (?:for|to)|try(?:ing)? to|should be|expected|expect(?:ing)?|possibly|maybe|all being well|fingers crossed|if (?:we|all) can)\b/i.test(wording)) kind = 'target';
  if (kind === 'not_stated' && wording) {
    kind = !urgent && /\b(?:as soon as|once|after|when|following|subject to|dependent on|depends on)\b/i.test(wording)
      ? 'dependency'
      : (/\b(?:target|aim|ideally|provisional|expected|this week|next week)\b/i.test(wording) ? 'target' : 'deadline');
  }
  wording = wording.replace(/^(?:target|deadline)\s*:\s*/i, '');
  return TimingIntegrity.normaliseTimingValue({ ...supplied, kind, wording }, {
    meetingDate: options.meetingDate,
    mode: options.timingMode === 'derive' ? 'derive' : 'preserve',
    reviewerAuthored: options.preserveReviewerEdits === true
  });
}

// A timing column must contain timing. Models occasionally copy a nearby
// status clause into it ("there are some further updates that need to happen")
// simply because the clause appeared beside a commitment. Evidence support is
// not enough in that case: the words are in the transcript, but they do not say
// when the work is due or what it depends on.
const CALENDAR_TIMING = /\b(?:today|tonight|tomorrow|morning|afternoon|evening|day|days|week|weeks|month|months|quarter|quarters|year|years|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth|asap|immediately|shortly|soon|later|next|this|end of|by|before|within|no later than|due|deadline|target|\d{1,4})\b/i;
const DEPENDENCY_TIMING = /\b(?:if|after|before|once|when|whenever|following|upon|subject to|dependent on|depends on|pending|until|unless|provided that|based on|contingent on|as soon as|where .* (?:identified|found)|on completion|on approval|on receipt)\b/i;
const DEPENDENCY_LEAD_IN = /^(?:(?:and\s+)?(?:in parallel|then|separately|at the same time|in tandem)[,;:]?\s+)+(?=(?:if|after|before|once|when|whenever|following|upon|subject to|dependent on|pending|until|unless|provided that|based on|contingent on|as soon as|on completion|on approval|on receipt)\b)/i;
const DURATION_TASK_NOUN = /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[ -](?:business[ -])?(?:day|week|month|quarter|year)s?[ -](?:pilot|trial|test|review|programme|program|project|phase|study|workshop|exercise|engagement|contract|period|cycle|sprint)\b/i;
const EXPLICIT_DUE_CUE = /\b(?:by|before|within|no later than|due|deadline|target|today|tonight|tomorrow|this\s+(?:week|month|quarter|year)|next\s+(?:week|month|quarter|year)|end of|on\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2})|at\s+\d{1,2})\b/i;
// The pronoun may be contracted: "I'll draft that." (draft 1055) came through
// the space-separated form untouched and was published as a deadline.
const RAW_TIMING_CLAUSE_START = /^(?:(?:i|we|you|he|she|they|it|there|here)(?:\s+(?:['’]?ll|will|shall|can|could|would|should|do|does|did|am|is|are|was|were|have|has|had|need|needs|want|wants|plan|plans|start|starts)|['’](?:ll|ve|re|d|m)\b)|(?:the|a|an|this|that)\s+[\p{L}\p{N}'’-]+\s+(?:will|shall|can|could|would|should|is|are|was|were|has|had|needs|starts)|[\p{Lu}][\p{L}'’-]+\s+(?:will|shall|can|could|would|should|is|was|has|needs|starts))\b/iu;
// Time words the two lists above do not carry but real timings use: "in a
// fortnight", "straight away", "during the live webinar", "by close of play".
const TIMING_SIGNAL_EXTRA = /\b(?:fortnight|now|straight away|right away|at once|first thing|close of play|end of play|end of the day|eod|cop|eom|eoy|lunchtime|noon|midday|midnight|o['’]clock|half past|quarter (?:past|to)|hours?|minutes?|[ap]\.?m\.?|q[1-4]|h[12]|sprint|release|launch|go-live|christmas|easter|new year|summer|autumn|winter|spring|during|throughout|while|whilst|ahead of|prior to|in time|ready for|depending on|dependent|depends|decision|outcome|start of|beginning of|middle of|mid-\w+|fortnightly|weekly|monthly|daily)\b/i;
function hasTimingSignal(wording = '') {
  const value = String(wording || '');
  return CALENDAR_TIMING.test(value) || DEPENDENCY_TIMING.test(value) || TIMING_SIGNAL_EXTRA.test(value)
    || /\b\d{1,2}(?:st|nd|rd|th)\b/i.test(value);
}

function normaliseTimingWording(timing = {}) {
  const kind = text(timing?.kind, 30);
  let wording = text(timing?.wording, 220);
  // Timing fields are labels rather than transcript quotations. Remove only
  // hedges immediately before an unmistakable time expression; a wider
  // removal could change substantive phrases such as "a kind of review".
  wording = wording.replace(/\b(?:kind|sort)\s+of\s+(?=(?:next|this|coming|following|today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|by|before|after|within|until|on)\b)/gi, '');
  // Targets are labels, not sentence fragments. "from now till race day"
  // carries the same target as "race day", but the latter is what belongs in
  // a compact timing field and is what the reviewer can scan quickly.
  if (kind === 'target') {
    wording = wording.replace(/^from\s+now\s+(?:until|till|to|through)\s+/i, '');
    wording = wording.replace(/^(?:until|till|through)\s+/i, '');
  }
  if (kind === 'dependency') {
    const trimmed = wording.replace(DEPENDENCY_LEAD_IN, '');
    if (trimmed !== wording) wording = trimmed.replace(/^([a-z])/, (letter) => letter.toUpperCase());
  }
  return { ...timing, kind, wording };
}

// A timing field must remain useful when it is read outside the conversation. Relative
// wording with an unresolved speaker perspective is not a date or a dependable
// dependency: "before you arrive" leaves the reader asking who "you" is and where they
// are arriving. Keep named-person references such as "before she arrives" for now; those
// can be resolved from the cited evidence, whereas second-person/collective deixis cannot
// safely be guessed at publication time.
const UNRESOLVED_DEICTIC_TIMING = /\b(?:before|after|when|once|until|by)\s+(?:(?:you|we|they)\b[^,.!?;]*\b(?:arrive|arrival|return|leave|get there|go there)\b|(?:your|our|their)\s+(?:arrival|return|visit)\b)/i;

// Timing is a compact date/target/dependency field, not a second copy of the action.
// Fail closed when a generated value is shaped like spoken action prose or when its only
// apparent calendar signal is the duration of the work itself ("four-week pilot").
function timingPublicationIssue(timing = {}) {
  const cleanTiming = normaliseTimingWording(timing);
  const wording = cleanTiming.wording;
  if (cleanTiming.kind === 'not_stated' || !wording) return '';
  if (RAW_TIMING_CLAUSE_START.test(wording)) return 'sentence_shaped_timing';
  if (UNRESOLVED_DEICTIC_TIMING.test(wording)) return 'unresolved_deictic_timing';
  if (cleanTiming.kind !== 'dependency' && DURATION_TASK_NOUN.test(wording) && !EXPLICIT_DUE_CUE.test(wording)) {
    return 'task_duration_not_due_date';
  }
  // Fail closed on wording with no time in it at all. "create those two
  // language characterization situations" was published as a deadline; it is
  // a copied clause, not a time. Of 1,554 stored timings only the copied
  // clauses lack every signal word above.
  if (!hasTimingSignal(wording)) return 'no_timing_signal';
  return '';
}

function timingForPublication(timing = {}) {
  const cleanTiming = normaliseTimingWording(timing);
  if (cleanTiming.exactDate && !TimingIntegrity.isValidCalendarDate(cleanTiming.exactDate)) cleanTiming.exactDate = '';
  if (!timingPublicationIssue(cleanTiming)) return cleanTiming;
  if (TimingIntegrity.isValidCalendarDate(cleanTiming.exactDate)) return { ...cleanTiming, wording: '' };
  return { kind: 'not_stated', wording: '', exactDate: '' };
}

function timingWordingHasMeaning(timing = {}) {
  const cleanTiming = normaliseTimingWording(timing);
  const kind = cleanTiming.kind;
  const wording = cleanTiming.wording;
  if (kind === 'not_stated') return !wording;
  if (!wording && TimingIntegrity.isValidCalendarDate(timing?.exactDate)) return true;
  if (!wording) return false;
  if (timingPublicationIssue(cleanTiming)) return false;
  // "if gaps are found during traceability review" arrived labelled a
  // deadline; the label is wrong, the timing is real. Any time signal counts,
  // whichever kind the model chose.
  return hasTimingSignal(wording);
}

function isIdeaOnlyContemplation(value) {
  const action = text(value, 2000).toLowerCase();
  const exploratory = /\b(?:think|thinking|consider|considering)\s+(?:about|through|of)\b/.test(action)
    || /\b(?:come back|return|bring)\b[^.]{0,90}\b(?:idea|ideas|thought|thoughts)\b/.test(action);
  if (!exploratory) return false;
  if (!/\b(?:idea|ideas|thought|thoughts|possibilit(?:y|ies)|options?)\b/.test(action)) return false;
  return !/\b(?:analysis|assessment|decision|document|draft|plan|recommendation|report|specification|test results?|written proposal)\b/.test(action);
}

function cleanActionWording(value = '') {
  let source = convertSpokenNumbers(text(value, 1600)).text;
  // Ownership is stored separately from the action. When a named owner says they will
  // "determine/work out a way to" perform a concrete deliverable, retain the deliverable
  // as the reviewer-facing action rather than publishing the planning wrapper and owner
  // twice. Do not simplify "determine the scope" or "determine whether...": those are
  // genuine resolution tasks, not wrappers around an already named deliverable.
  const concreteVerb = '(?:provide|share|send|arrange|prepare|review|update|complete|confirm|create|draft|submit|deliver|secure|obtain|compile|circulate|schedule|book|check|resolve|clarify|coordinate|discuss|organise|organize)';
  const ownedWrapper = new RegExp(`^(?:(?:I|we|you|he|she|they)\\b|(?:[A-Z][\\p{L}'’.-]+(?:\\s+[A-Z][\\p{L}'’.-]+){0,3}))\\s+(?:will|shall)\\s+(?:determine|work out|figure out|find)\\s+(?:a|the)\\s+(?:way|method|approach|route)\\s+to\\s+(${concreteVerb}\\b.+)$`, 'iu');
  const wrapped = source.match(ownedWrapper);
  if (wrapped) source = wrapped[1].charAt(0).toUpperCase() + wrapped[1].slice(1);
  else {
    const bareWrapper = new RegExp(`^(?:determine|work out|figure out|find)\\s+(?:a|the)\\s+(?:way|method|approach|route)\\s+to\\s+(${concreteVerb}\\b.+)$`, 'i');
    const bare = source.match(bareWrapper);
    if (bare) source = bare[1].charAt(0).toUpperCase() + bare[1].slice(1);
  }
  // Remove tautological scaffolding while retaining every deliverable:
  // "Implement a system to implement X and add Y" ->
  // "Implement a system for X and add Y".
  return source.replace(/^(Implement\s+(?:an?|the)\s+[^.;]{1,100}?)\s+to implement\s+(.+)$/i, '$1 for $2');
}

const ACTION_COMMITMENT_PATTERN = /\b(?:i|we)\s*(?:'ll|will|shall|can do|am going to|are going to)|\b(?:he|she|they)\s+(?:will|shall)|\b(?:agreed|committed|assigned|action(?:\s+for)?|need(?:s)? to|must|shall|is to|are to|due to)\b/i;
const ACTION_CONCRETE_INTENTION_PATTERN = /\b(?:(?:i|we)\s+(?:want|intend|plan|expect)\s+to|what\s+(?:i|we)\s+want\s+to\s+do\s+is(?:\s+to)?)\s+(?:arrange|assess|book|build|check|clarify|complete|confirm|contact|create|decide|define|determine|document|draft|email|establish|finalise|finalize|fix|forward|investigate|issue|message|prepare|provide|record|resolve|review|run|schedule|send|share|submit|take|test|track|update|validate|verify|write)\b/i;
const ACTION_JOINT_INTENTION_PATTERN = /\b(?:[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]{2,}\s+and\s+I|I\s+and\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]{2,})\s+(?:am\s+|are\s+)?going\s+to\s+(?:arrange|assess|book|build|check|clarify|complete|confirm|contact|create|decide|define|determine|document|draft|email|establish|finalise|finalize|fix|forward|investigate|issue|message|prepare|provide|record|resolve|review|run|schedule|send|share|submit|take|test|track|update|validate|verify|write)\b/i;
const ACTION_SCHEDULED_DELIVERABLE_PATTERN = /\b(?:assessment|audit|call|check|follow[- ]?up|inspection|review|session|test|testing|validation|workshop)\s+(?:is|are|has been|have been|was|were)\s+(?:agreed|booked|planned|scheduled)\s+(?:for|to|on)\b/i;
const NAMED_WILL_PATTERN = /\b[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]{2,}\s+will\b/;
const ACTION_REQUEST_PATTERN = /\b(?:please|can (?:you|somebody|someone)|could (?:you|somebody|someone)|would (?:you|somebody|someone)|will (?:you|somebody|someone))\b/i;
const ACTION_ACCEPTANCE_PATTERN = /\b(?:yes|yeah|yep|okay|ok|sure|happy to|will do|can do|i can|we can|that's fine|that works)\b/i;
const ACTION_SUGGESTION_PATTERN = /\b(?:perhaps|maybe|might|may|could|should|consider|considering|possible|potentially|it would be good|worth thinking)\b/i;
const ACTION_COMPLETED_PATTERN = /\b(?:already|previously|last (?:week|month)|has been|have been|was|were)\b[^.]{0,100}\b(?:completed|finished|sent|shared|issued|approved|closed|done|delivered|submitted)\b/i;
const ACTION_STATUS_PATTERN = /\b(?:currently|ongoing|in progress|remains|status is|has been|have been|was|were)\b/i;
// Minute preparation/delivery belongs to the recoverable minute-instruction
// check below. A prefix such as "send minutes" also names genuine later work.
const ACTION_ADMIN_PATTERN = /\b(?:attend (?:the )?(?:call|meeting)|join (?:the )?(?:call|meeting)|meeting invite|(?:for|in|into|update|take|record|write)\s+(?:the\s+|these\s+|this\s+|that\s+)?(?:new\s+)?set\s+of\s+minutes|(?:for|in|into)\s+(?:the|these|this)\s+minutes|share\s+(?:your|my|his|her|their|the)?\s*screen|screen\s*share|put\s+away\s+(?:the\s+|this\s+|that\s+)?(?:on[- ]screen\s+)?(?:pdf|pdf\s+copy|document\s+copy)|close\s+(?:the\s+|this\s+|that\s+)?(?:browser\s+)?(?:tab|window)\s*(?:now|for\s+now)?)\b/i;
// A short first-person "quickly/briefly/just share" line is often the chair
// moving the meeting along, rather than work that remains after the call. Keep
// this separate from ACTION_ADMIN_PATTERN: a normal "share the report" remains
// a possible deliverable, and explicit recipients, deliverables or timing keep
// the line eligible as a real action.
const MEETING_ADMIN_SHARE_PATTERN = /\b(?:i|we)\s+(?:'ll|will|shall|am going to|are going to)\s+(?:just|quickly|briefly)\s+share\b/i;
const SHARE_DELIVERABLE_CONTEXT = /\b(?:by|before|until|tomorrow|today|next\s+(?:week|month)|deadline|due|client|customer|supplier|stakeholder|external|team|colleagues?|board|committee|report|document|proposal|draft|result|results|data|link|file|presentation|deck|slides?|agenda|minutes|action\s+points?|findings?|quote|invoice|contract|formal\s+record)\b/i;
// ---- Running the call itself --------------------------------------------------
// "I'll give it thirty seconds for Dermot and then we'll just crack on, because
// I know Ffion has to drop at half past." (draft 1055, the chair's first line)
// became the published action "give it thirty seconds for Dermot and then".
// This is someone running the call: waiting for a latecomer, getting started,
// someone leaving early, audio and screen trouble, a parcel at the door. What
// separates it from planned work that mentions the same equipment ("Start the
// recording when Priya begins speaking" is a real task for next week's
// webinar) is that each of these is a spoken idiom of call management with no
// deliverable in it, said about this meeting as it happens.
const LIVE_CALL_CONDUCT = new RegExp([
  // waiting for people to arrive
  String.raw`\b(?:give|allow)\s+(?:it|him|her|them|[\p{Lu}][\p{L}'’-]+)\s+(?:a\s+)?(?:few\s+(?:more\s+)?|couple\s+(?:more\s+)?(?:of\s+)?|another\s+|(?:thirty|twenty|fifteen|ten|five|two|one|\d+)\s+(?:more\s+)?)?(?:seconds?|secs?|minutes?|mins?|moments?|tick)\b`,
  String.raw`\bwait(?:ing)?\s+(?:a\s+(?:few|couple)\s+(?:more\s+)?(?:seconds|secs|minutes|mins)|another\s+(?:minute|couple)|for\s+(?:[\p{Lu}][\p{L}'’-]+|everyone|everybody|the\s+others|others)\s+to\s+(?:join|arrive|dial\s+in|come\s+on|log\s+on|get\s+on|turn\s+up))\b`,
  // getting started, moving on, wrapping up this call
  String.raw`\b(?:just\s+)?(?:crack\s+on|make\s+a\s+start|get\s+(?:started|going|cracking|underway)|kick\s+(?:things\s+)?off|press\s+on|get\s+(?:through|round)\s+(?:the\s+)?agenda|step\s+(?:down\s+)?through\s+the\s+(?:core\s+areas|agenda|tracker|list)|wrap\s+(?:it\s+|this\s+)?up|call\s+it\s+(?:a\s+day|there)|leave\s+it\s+there)\b`,
  // leaving early, time pressure on this call
  String.raw`\b(?:has|have|had|need|needs|got|going)\s+to\s+(?:drop|leave|go|shoot|dash|jump|hop)(?:\s+off|\s+out)?\s+(?:at|by|in|for|before|around|about)\b`,
  String.raw`\b(?:hard\s+stop|drop(?:ping)?\s+off|be\s+done|finish(?:ed|ing)?\s+up|wrap(?:ped)?\s+up)\s+(?:well\s+)?(?:at|by|before)\s+(?:that|then|half\s+past|quarter|\d{1,2}(?::\d{2})?|the\s+hour|the\s+(?:half|quarter))\b`,
  String.raw`\b(?:it(?:'s| is)\s+getting\s+late|(?:mindful|conscious)\s+of\s+(?:the\s+)?time|time\s+check|(?:we(?:'ve| have)\s+got|there(?:'s| is))\s+(?:about\s+|only\s+|just\s+)?(?:\d+|five|ten|fifteen|twenty)\s+minutes\s+(?:left|to\s+go))\b`,
  // audio, video, screen
  String.raw`\b(?:you(?:'re| are)|i(?:'m| am)|(?:he|she)(?:'s| is)|we(?:'re| are))\s+(?:a\s+bit\s+|still\s+|all\s+)?(?:on\s+mute|muted|frozen|breaking\s+up|cutting\s+out|echoing|lagging)\b`,
  String.raw`\bcan\s+(?:you|everyone|everybody|anyone|people)\s+(?:all\s+)?(?:hear|see)\s+(?:me|us|my\s+screen|that|this|the\s+screen)\b`,
  String.raw`\b(?:let\s+me|i(?:'ll| will| am going to|'m going to)|i(?:'m| am)\s+just\s+going\s+to)\s+(?:just\s+)?(?:share|stop\s+sharing|put\s+up|bring\s+up)\s+(?:my|the)\s+screen\b`,
  String.raw`\b(?:my|the|your)\s+(?:internet|connection|wifi|wi-fi|bandwidth|camera|mic|microphone|audio|sound|video)\s+(?:is|was|keeps|has|went|has\s+gone|is\s+going)\b`,
  // interruptions at home
  String.raw`\b(?:someone(?:'s| is)\s+at\s+(?:my|the)\s+door|(?:sorry|hang\s+on)[,.]?\s+(?:parcel|delivery|doorbell|the\s+dog|my\s+dog|the\s+kids|one\s+sec|two\s+secs|back\s+in\s+a\s+(?:sec|second|minute|tick)))\b`
].join('|'), 'iu');
// One turn can run the call and still promise something: "Sorry, you're on
// mute. Right, so I'll send the deck tomorrow." Judge the pieces, not the
// whole: it is conduct only when nothing with work in it is left over.
const CONDUCT_PIECE_SPLIT = /(?<=[.!?;])\s+|,\s*(?=(?:and\s+then|then|but|so|because|and)\b)|\s+(?=(?:and\s+then|and|but|so|because)\s+(?:i|we|you|he|she|they)\b)|(?=\b(?:i|we)\s*(?:['’]ll|will|shall|am going to|are going to)\s+)/iu;
function isLiveCallConduct(value = '') {
  const source = text(value, 1200);
  if (!source || !LIVE_CALL_CONDUCT.test(source)) return false;
  const rest = source.split(CONDUCT_PIECE_SPLIT).map((piece) => String(piece || '').trim()).filter(Boolean)
    .filter((piece) => !LIVE_CALL_CONDUCT.test(piece));
  return !rest.some((piece) => contentTokens(piece).length >= 3);
}
function isMeetingAdminShare(value = '', context = '') {
  const source = `${text(value, 1200)} ${text(context, 15000)}`;
  return MEETING_ADMIN_SHARE_PATTERN.test(source) && !SHARE_DELIVERABLE_CONTEXT.test(source);
}
const ACTION_PASSIVE_OBLIGATION_PATTERN =/\b(?:(?:is|are|was|were|will be)\s+)?(?:required|needed|expected|planned|scheduled|assigned)\s+to\b|\b(?:needs?|requires?)\s+(?:approval|assessment|completion|confirmation|documentation|follow[- ]?up|investigation|review|testing|updat(?:e|ing)|validation)\b/i;
const ACTION_FOLLOW_UP_PATTERN = /\b(?:action point|next step|take[- ]?away|follow[- ]?up|circle back|come back (?:to|with)|pick (?:this|that|it) up|look into|find out|make sure|ensure|sort (?:this|that|it) out|leave (?:this|that|it) with)\b/i;
const ACTION_IMPERATIVE_PATTERN = /^\s*(?:[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]{2,}\s*,\s*)?(?:(?:and|then|also)\s+)?(?:(?:when|once|after|before)\b.{0,100}?,\s*)?(?:please\s+)?(?:send|share|provide|forward|review|check|assess|create|produce|prepare|draft|update|revise|complete|finish|confirm|clarify|determine|test|verify|contact|call|message|schedule|arrange|document)\b/i;
const ACTION_CONCRETE_OFFER_PATTERN = /\b(?:I|we)\s+(?:can|could|would be able to|am available to|are available to)\s+(?:have a look at|attend|check|collect|contact|deliver|go|handle|prepare|provide|review|send|speak|test|visit)\b/i;
const ACTION_DECISION_RESOLUTION_PATTERN = /\b(?:try(?:ing)? to work out|(?:have|has|got|need(?:s)?) to (?:work (?:out|through)|decide|determine|resolve|plan through)|need(?:s)? to (?:confirm|clarify)|figure out)\b/i;
const DISCUSSION_DECISION_PATTERN = /\b(?:agreed|decided|confirmed|approved|accepted|selected|settled|concluded|signed off|will proceed|going ahead|the decision)\b/i;
const DISCUSSION_QUESTION_PATTERN = /\?|\b(?:open question|outstanding|to be confirmed|to be decided|not (?:yet )?(?:decided|confirmed|clear|resolved)|need to (?:confirm|clarify|determine|decide)|whether|which option|who will)\b/i;
const DISCUSSION_NEGATIVE_POSITION_PATTERN = /\b(?:(?:i|we)\s+(?:will not|won['’]?t|am not going to|are not going to|do not agree|don['’]?t agree|cannot accept|can['’]?t accept|refuse|decline)|i['’](?:ll not|m not going to)|we['’](?:ll not|re not going to))\b/i;
const DISCUSSION_UNRESOLVED_POSITION_PATTERN = /\b(?:i|we)\s+(?:do not|don['’]?t)\s+know\b|\b(?:no clear|no obvious)\s+answer\b|\bnot (?:yet )?(?:known|clear|decided|resolved)\b/i;
const ACTION_EXPLICIT_RESOLUTION_AFTER_UNCERTAINTY = /\b(?:i|we)\s*(?:['’]ll|will|am going to|are going to)\s+(?:ask|check|clarify|confirm|contact|find out|investigate|review|verify)\b/i;
const LOW_INFORMATION_UTTERANCE = /^(?:yes|yeah|yep|no|nope|okay|ok|right|fine|great|thanks|thank you|sure|agreed|exactly|correct|perfect|lovely|brilliant|understood|makes sense|i see|mm+|uh+|hello|hi|bye)[.!? ]*$/i;

function isDecisionResolutionCommitment(value) {
  const source = text(value, 2000);
  if (!ACTION_DECISION_RESOLUTION_PATTERN.test(source)) return false;
  // Questions about whether clarification is needed are not themselves an
  // accepted task. The surrounding acceptance machinery can still promote a
  // request when a later turn genuinely accepts it.
  return !/\?\s*$/.test(source) && !/^\s*(?:who|what|when|where|why|how|do|does|did|is|are|can|could|would|will|anything)\b/i.test(source);
}

function actionNegatedByEvidence(action, evidence) {
  const source = text(evidence, 15000);
  if (!source) return false;
  const actionTokens = contentTokens(action).slice(0, 12);
  const predicateGroups = ACTION_VERB_GROUPS.filter((group) => actionTokens.some((token) => group.includes(token)));
  const predicateWords = [...new Set(predicateGroups.flat())];
  const actionObjectWords = new Set(actionTokens.filter((token) => !ACTION_VERB_GROUPS.flat().includes(token)));
  return source.split(/(?<=[.!?;])\s+|\n+/).some((clause) => {
    const hasSharedObject = contentTokens(clause).some((token) => actionObjectWords.has(token));
    if (!hasSharedObject) return false;
    return predicateWords.some((verb) => new RegExp(
      `\\b(?:will not|won't|shall not|do not|don't|must not|should not|cannot|can't|(?:is|are|was|were|we're|they're)\\s+not|neither\\b[^.;]{0,60}\\b(?:is|are|was|were)?\\s*(?:authorised|authorized)|not\\s+(?:authorised|authorized)\\s+to)\\b(?:\\s+[A-Za-zÀ-ÖØ-öø-ÿ'’.-]+){0,8}\\s+${verb}(?:s|ed|ing)?\\b`, 'i'
    ).test(clause) || (predicateGroups.some((group) => group.includes('confirm'))
      && /\bleave\b[^.;]{0,60}\bunconfirmed\b/i.test(clause)));
  });
}

function actionEvidenceDisposition(action, evidence) {
  const source = text(evidence, 15000);
  // A leaving remark grounds no work. Guard on the action too so a genuine
  // "shoot the report over" survives.
  if (LEAVING_REMARK_PATTERN.test(source) && !DELIVERABLE_CONTEXT_PATTERN.test(action)
    && !/\b(?:send|email|order|book|confirm|ring|call|contact|arrange|prepare|review|update|write|share|forward|submit)\b/i.test(action)) return 'meeting_admin';
  if (!source) return 'unclear';
  if (isMeetingAdminShare(action, source)) return 'meeting_admin';
  const directlyNegatedPredicate = actionNegatedByEvidence(action, source);
  // Negation belongs to its clause. An availability constraint such as “I
  // won't be around” can be the reason another person must plan or reschedule;
  // it must not reject every action in the surrounding evidence window.
  if (/\b(?:no action|do not need to|does not need to)\b/i.test(source) || directlyNegatedPredicate) return 'rejected';
  const accepted = ACTION_ACCEPTANCE_PATTERN.test(source);
  const requested = ACTION_REQUEST_PATTERN.test(source);
  const hasCommitment = ACTION_COMMITMENT_PATTERN.test(source) || ACTION_CONCRETE_INTENTION_PATTERN.test(source) || NAMED_WILL_PATTERN.test(source)
    || ACTION_JOINT_INTENTION_PATTERN.test(source) || ACTION_SCHEDULED_DELIVERABLE_PATTERN.test(source)
    || isDecisionResolutionCommitment(source) || accepted;
  if (isMeetingAdminAction(action) && !/\b(?:client deliverable|contract|required|formal record)\b/i.test(source)) return 'meeting_admin';
  if (ACTION_COMPLETED_PATTERN.test(source) && !hasCommitment) return 'completed';
  if (requested && !accepted
    && !ACTION_COMMITMENT_PATTERN.test(source.replace(ACTION_REQUEST_PATTERN, ''))
    && !ACTION_CONCRETE_INTENTION_PATTERN.test(source.replace(ACTION_REQUEST_PATTERN, ''))
    && !NAMED_WILL_PATTERN.test(source)) return 'unaccepted_request';
  if (ACTION_SUGGESTION_PATTERN.test(source) && !hasCommitment) return 'suggestion';
  if (ACTION_STATUS_PATTERN.test(source) && !hasCommitment) return 'status_only';
  if (/\b(?:if|once|after|when|subject to|dependent on|depends on|cannot .* until)\b/i.test(source) && hasCommitment) return 'conditional_commitment';
  if (hasCommitment) return accepted ? 'accepted_request' : 'committed';
  return 'unclear';
}

// A published Discussion row often states work nobody turned into an action
// ("Ciaran Ryan will focus on TFO3 this week"). Those rows are offered to the
// Actions stage as candidates so the usual evidence checks can judge them;
// they are never published from here.
const DISCUSSION_FUTURE_TASK = /\b(?:will|to be|is to|are to|plans? to|planning to|planning|scheduled to|due to|expected to|going to|needs? to|must)\b/i;
// People named in the meeting who never spoke and are not listed as attendees
// (work is often assigned to them). Capitalised names in person-like positions,
// mentioned more than once.
const NOT_A_PERSON = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'teams', 'excel', 'word', 'sharepoint', 'trinzo', 'udimed', 'udamed', 'eudamed', 'mdr', 'qms', 'sop', 'ppe', 'usb', 'gui',
  'the', 'this', 'that', 'yeah', 'okay', 'sorry', 'thanks', 'hello', 'right', 'well', 'and', 'but', 'once', 'because']);
function mentionedPeople(units = []) {
  const counts = new Map();
  for (const unit of evidenceContextFor(units).rows) {
    const value = String(unit.text || '');
    const patterns = [/\b(?:with|to|for|from|ask|asked|tell|told|and|by)\s+([A-Z][a-z]{2,15})\b/g, /\b([A-Z][a-z]{2,15})\s+(?:will|is|has|can|should|to)\b/g];
    for (const pattern of patterns) {
      for (const match of value.matchAll(pattern)) {
        const name = match[1];
        if (NOT_A_PERSON.has(name.toLowerCase())) continue;
        counts.set(name, (counts.get(name) || 0) + 1);
      }
    }
  }
  return [...counts.entries()].filter(([, count]) => count >= 2).map(([name]) => name);
}

function discussionActionCandidates(discussion = [], units = [], people = []) {
  const context = evidenceContextFor(units);
  // Named people include those who never spoke (work is often assigned to them).
  const speakers = [...new Set([
    ...context.rows.map((unit) => text(unit.speaker, 180)),
    ...(Array.isArray(people) ? people : []).map((person) => text(person, 180)),
    ...mentionedPeople(units)
  ].filter(Boolean))];
  const candidates = [];
  for (const topic of Array.isArray(discussion) ? discussion : []) {
    for (const kind of ['points', 'decisions']) {
      for (const record of topic?.[kind] || []) {
        const value = text(record?.text, 800);
        if (!value || !DISCUSSION_FUTURE_TASK.test(value)) continue;
        const owner = speakers.find((speaker) => new RegExp(`\\b${speaker.split(/\s+/)[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(value));
        if (!owner) continue;
        const ids = [...new Set(record.evidenceIds || [])].slice(0, 8);
        if (!ids.length) continue;
        const sequence = Math.min(...ids.map((id) => context.indexById.get(id)).filter(Number.isInteger), Infinity);
        candidates.push({
          candidateId: stableId('candidate-discussion', `${owner}|${value}`),
          focusEvidenceId: ids[0],
          evidenceIds: ids,
          dispositionHint: 'committed',
          cueKinds: ['commitment'],
          priority: 4,
          sequence: Number.isFinite(sequence) ? sequence : 0,
          focusText: value,
          context: text(evidenceWindowText(units, ids, 1), 900),
          sourcePass: 'discussion_row',
          ownerHints: [owner]
        });
      }
    }
  }
  return candidates.slice(0, 24);
}

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

/**
 * Build stable, contiguous evidence anchors for the structured Discussion
 * Discovery Prompt. Every retained source unit belongs to exactly one anchor.
 *
 * Earlier versions selected only cue-bearing discussion candidates. That made
 * the pass look comprehensive while silently excluding ordinary-but-material
 * factual passages (for example product scope or an agreed role described
 * without decision language). Partitioning the complete prepared transcript
 * removes that blind spot without adding meeting-specific vocabulary.
 */
function discussionAnchorInventory(units = [], options = {}) {
  const rows = normaliseSourceUnits(units).filter(includedUnit);
  const maxAnchors = Math.max(1, Number(options.maxAnchors || 24));
  const maxChars = Math.max(4000, Number(options.maxChars || 48000));
  if (!rows.length) return [];
  const anchorCount = Math.min(maxAnchors, rows.length);
  const candidateByFocusId = new Map(discussionCandidateInventory(rows)
    .map((candidate) => [candidate.focusEvidenceId, candidate]));
  const perAnchorBudget = Math.max(240, Math.floor(maxChars / anchorCount));
  const anchors = [];
  for (let index = 0; index < anchorCount; index += 1) {
    const start = Math.floor((index * rows.length) / anchorCount);
    const end = Math.floor(((index + 1) * rows.length) / anchorCount);
    const group = rows.slice(start, Math.max(start + 1, end));
    const perUnitBudget = Math.max(70, Math.floor(perAnchorBudget / group.length));
    const window = group.map((unit) => {
      const prefix = `[${unit.id}] ${unit.speaker}${unit.timestamp ? ` ${unit.timestamp}` : ''}: `;
      return `${prefix}${text(unit.text, Math.max(40, perUnitBudget - prefix.length))}`;
    }).join('\n');
    const cueCandidates = group.map((unit) => candidateByFocusId.get(unit.id)).filter(Boolean);
    const first = group[0];
    const last = group[group.length - 1];
    anchors.push({
      // Keep IDs comfortably below AI Builder's occasionally enforced scalar
      // length so it cannot truncate the final character and break accounting.
      anchorId: stableId('DA', `${first.id}:${last.id}`),
      evidenceIds: group.map((unit) => unit.id),
      window: text(window, perAnchorBudget),
      cues: [...new Set(cueCandidates.flatMap((candidate) => candidate.kindHints || []))].join(','),
      priority: Math.max(0, ...cueCandidates.map((candidate) => Number(candidate.priority || 0))),
      sequence: Number(first.sequence || start + 1)
    });
  }
  return anchors.map((anchor) => {
    return {
      ...anchor,
      // Keep the request bounded even when one transcript unit is unusually
      // long. Evidence IDs remain complete and authoritative; only display
      // text in the duplicated anchor packet is compacted.
      window: text(anchor.window, perAnchorBudget)
    };
  });
}

function candidatePromptPack(candidates = [], options = {}) {
  const source = (Array.isArray(candidates) ? candidates : []).filter((candidate) => candidate?.context);
  const rows = options.compact === true ? source.map((candidate) => ({
    candidateId: candidate.candidateId,
    focusEvidenceId: candidate.focusEvidenceId,
    evidenceIds: candidate.evidenceIds,
    ...(candidate.kindHints ? { kindHints: candidate.kindHints } : {}),
    ...(candidate.cueKinds ? { cueKinds: candidate.cueKinds } : {}),
    ...(candidate.dispositionHint ? { dispositionHint: candidate.dispositionHint } : {}),
    priority: candidate.priority,
    sequence: candidate.sequence,
    focusText: candidate.focusText
  })) : source;
  const maxCandidates = Math.max(1, Number(options.maxCandidates || 160));
  const maxChars = Math.max(1000, Number(options.maxChars || 60000));
  if (!rows.length) return [];
  const selected = [];
  const selectedIds = new Set();
  let chars = 2;
  const add = (candidate) => {
    if (!candidate || selectedIds.has(candidate.candidateId) || selected.length >= maxCandidates) return false;
    const size = JSON.stringify(candidate).length + 1;
    if (chars + size > maxChars) return false;
    selected.push(candidate);
    selectedIds.add(candidate.candidateId);
    chars += size;
    return true;
  };

  // First retain the strongest decision/acceptance/detail anchors. Then fill the
  // remaining budget evenly across the whole transcript, preventing a long
  // opening discussion from crowding out late workstreams.
  const highPriority = rows.filter((candidate) => Number(candidate.priority || 0) >= 5)
    .sort((left, right) => (left.sequence || 0) - (right.sequence || 0));
  const prioritySlots = Math.min(highPriority.length, Math.max(1, Math.floor(maxCandidates / 2)));
  for (let index = 0; index < prioritySlots; index += 1) {
    add(highPriority[Math.floor(index * highPriority.length / prioritySlots)]);
  }
  const remaining = rows.filter((candidate) => !selectedIds.has(candidate.candidateId));
  const slots = Math.max(0, maxCandidates - selected.length);
  if (slots && remaining.length) {
    const ordered = [];
    for (let index = 0; index < Math.min(slots, remaining.length); index += 1) {
      ordered.push(remaining[Math.floor(index * remaining.length / Math.min(slots, remaining.length))]);
    }
    ordered.forEach(add);
  }
  return selected.sort((left, right) => (left.sequence || 0) - (right.sequence || 0));
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

function discussionRecoveryNeeded(candidates = [], records = []) {
  const source = Array.isArray(candidates) ? candidates : [];
  const uncovered = uncoveredCandidateInventory(source, records);
  const substantive = source.filter((candidate) =>
    ['decision', 'open_question', 'objective'].includes(candidate?.recordType)
      || Number(candidate?.priority || 0) >= 5);
  const substantiveUncovered = uncovered.filter((candidate) => substantive.includes(candidate));
  const highPriority = substantiveUncovered.filter((candidate) =>
    ['decision', 'open_question'].includes(candidate?.recordType)
      || Number(candidate?.priority || 0) >= 7);
  return {
    needed: highPriority.length > 0
      || (substantive.length > 0 && substantiveUncovered.length / substantive.length > 0.1),
    uncovered,
    highPriorityCount: highPriority.length,
    substantiveCount: substantive.length,
    substantiveUncoveredCount: substantiveUncovered.length
  };
}

function actionRecoveryNeeded(candidates = [], records = []) {
  const uncovered = uncoveredCandidateInventory(candidates, records);
  const explicit = uncovered.filter((candidate) => ['committed', 'accepted_request'].includes(candidate?.dispositionHint));
  const medium = uncovered.filter((candidate) => Number(candidate?.priority || 0) >= 4);
  return {
    needed: explicit.length > 0 || medium.length >= 2,
    uncovered,
    explicitCount: explicit.length,
    mediumCount: medium.length
  };
}

function actionSimilarity(left, right) {
  return tokenOverlap(comparisonText(left.action), comparisonText(right.action));
}

function ownersCompatible(left, right) {
  if (!left.owners.length || !right.owners.length) return true;
  const a = new Set(left.owners.map((owner) => owner.toLowerCase()));
  const b = new Set(right.owners.map((owner) => owner.toLowerCase()));
  return [...a].some((owner) => b.has(owner)) && ([...a].every((owner) => b.has(owner)) || [...b].every((owner) => a.has(owner)));
}

function ownerSupportedByEvidence(owner, evidenceText, units = []) {
  const ownerWords = contentTokens(owner);
  const evidenceWords = contentTokens(evidenceText);
  if (!ownerWords.length) return false;
  if (ownerWords.every((word) => evidenceWords.includes(word))) return true;
  // Meeting speech commonly assigns work using a first name while the agent
  // returns the person's full speaker name. Accept that expansion only when the
  // complete identity is independently present in a transcript speaker label.
  // This does not let an invented surname pass: every owner token must belong to
  // the same known speaker, and the cited evidence must still name that person.
  const knownSpeaker = evidenceContextFor(units).speakerTokens.some((speakerWords) => {
    return ownerWords.every((word) => speakerWords.includes(word));
  });
  return knownSpeaker && ownerWords.some((word) => evidenceWords.includes(word));
}

// Timing is otherwise entirely model-supplied, so when the model returned
// nothing for "let me order six sacks today" the same-day wording was lost for
// good. Recover only plain relative-day phrases, only from the cited units
// themselves (never a neighbouring turn), and only where that unit reads as a
// commitment rather than narration ("we discussed today").
const CITED_TIMING_PHRASE = /\b(?:today|tonight|tomorrow(?:\s+(?:morning|afternoon))?|this\s+(?:morning|afternoon|evening|week)|next\s+week|end\s+of\s+(?:this\s+|next\s+)?week|(?:this\s+|next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(?:morning|afternoon|evening))?)\b(?!['’]s)/i;
const CITED_TIMING_COMMITMENT_CUE = /\blet\s+(?:me|us)\b|\blet's\b/i;
// "How long is it?" asks for a duration, not a due date, and is deliberately
// not a when-question: "about two days of test time" is not a deadline.
// "Who traces it?" "That'd be me." "By when?" "Two weeks." The answer to a
// when-question sits in its own short turn, outside the cited commitment. When
// an action has no timing, a when-question inside its exchange whose reply
// (within the next two rows) names a time supplies it.
const WHEN_QUESTION = /\b(?:by when|when by|when (?:can|will|could|would|do|does|did|should|might) (?:you|that|it|we|he|she|they)|when do you (?:think|reckon|expect)|what(?:'s| is) the (?:date|deadline|timescale|timeline|timing)|what sort of time(?:scale|frame|line)|(?:any idea|roughly) when|how soon|when for|when(?:'s| is| would| will) (?:that|it|this) (?:be|due|going to|likely|for)|(?:timeline|timescale|timeframe|time frame|eta) (?:on|for) (?:that|this|it|those|these))\b/i;
// The asker can be the one who settles it: "And when do you think, Dermot?"
// ... "Okay so that's the fifteenth. I'll put it in as the fifteenth." A row
// from the asker counts only when it reads as settling the date, never when
// it is another question.
const SETTLES_TIMING = /\b(?:so that(?:'s| is)|let(?:'s| us) (?:say|call it|put|go with)|put (?:it|that) (?:in|down) (?:as|for)|call it|we(?:'ll| will) say|pencil(?:led)? (?:it |that )?in|go with|make it)\b/i;
const ANSWER_TIMING = /\b(?:today|tonight|tomorrow(?: morning| afternoon)?|this week|next week|end of (?:the |this |next )?week|(?:the )?(?:rest|remainder) of (?:the |this )?week|(?:this |next )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|a fortnight|(?:in |within )?(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,2}) (?:days?|weeks?|months?)|(?:by |on )?the (?:\d{1,2}(?:st|nd|rd|th)?|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|twenty-?\w+|thirtieth|thirty-?first)|\d{1,2}(?:st|nd|rd|th)? (?:of )?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*)\b/i;
// Does the answer name what it is about before the time? "The three new DIs,
// this week" does; "Okay so that's the fifteenth" and "It'll be Friday though"
// do not - what is left once the fillers go is nothing.
const ANSWER_LEAD_FILLER = /\b(?:okay|ok|yeah|yes|yep|right|well|so|actually|probably|maybe|hopefully|ideally|erm|um|that(?:'s|’s| is| would be| will be| should be)?|it(?:'s|’s|'ll|’ll| is| will| would| should| could)?(?: be)?|i(?:'ll|’ll| will| would| can| think| reckon| would say)?|we(?:'ll|’ll| will| would| can| could)?|let(?:'s|’s| us)|put (?:it|that) (?:in|down) (?:as|for)|call it|say|go with|make it|by|on|for|the|a|an|at|in|then|about|around|roughly|be|is|was|and|of|to)\b/gi;
function answerNamesSubject(lead = '') {
  return contentTokens(String(lead || '').replace(ANSWER_LEAD_FILLER, ' ')).length > 0;
}
const UNKNOWN_TIMING_ANSWER = /\b(?:don['’]t know|do not know|no idea|not sure|couldn['’]t say|can['’]t say|hard to say|it depends|could be [^.,;]{1,40} or (?:it )?could be)\b/i;
function timingRecoveryBlocked(decision = {}) {
  return ['rejected', 'needs_rebind'].includes(decision?.status)
    || Boolean(decision?.rejectedWordings?.length || decision?.rejectedExactDates?.length);
}

function sourceRecoveredTiming(wording, options = {}) {
  return TimingIntegrity.normaliseTimingValue(timingFrom({ timing: { wording } }, options), {
    meetingDate: options.meetingDate, mode: 'derive'
  });
}

// Adding a timing is stricter than retaining a model/reviewer value for review.
// Shared citations and an owner name do not establish which work a date belongs
// to. Every inferred value needs its own source-bound work/actor proof.
function timingRecoveryIssue(options, ambiguous = false) {
  if (!Array.isArray(options.timingRecoveryIssues)) return;
  const code = ambiguous ? 'timing_inference_ambiguous' : 'timing_inference_unresolved';
  if (options.timingRecoveryIssues.some(issue => issue.code === code)) return;
  options.timingRecoveryIssues.push({ code, preserveValue: true,
    message: ambiguous
      ? 'Several source timings remain possible for this action; no single timing was added. Confirm the agreed timing.'
      : 'A source timing was not added because its link to this action and owner could not be established. Confirm this action’s own timing.' });
}
function timingRecoveryContext(options = {}) {
  return Boolean(text(options.action) && Array.isArray(options.owners) && options.owners.length);
}
function timingSourceClauses(value = '') {
  return String(value).split(/[,;]|(?<=[.!?])\s+|\b(?:and|but|then)\s+(?=(?:I['’]ll|I will|we will|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+(?:will|shall|to))\b)/)
    .map(value => value.trim()).filter(Boolean);
}
function qualifiedTimingPhrase(phrase, clause) {
  const at = String(clause).toLowerCase().indexOf(String(phrase).toLowerCase());
  if (at < 0) return '';
  const prefix = clause.slice(0, at).match(/(?:(?:\b(?:by|before|after|within|until|from|probably|presumably|possibly|maybe|perhaps|hopefully|ideally|preferably|approximately|roughly|around|about|early|late)|\b(?:no earlier than|not before|no later than|not later than|at least|at the earliest))\s+)+$/i)?.[0] || '';
  const suffix = clause.slice(at + phrase.length).match(/^\s*(?:,?\s*(?:all being well|if possible|at least|at the latest))\b/i)?.[0] || '';
  return `${prefix}${phrase}${suffix}`.toLowerCase().replace(/\s+/g, ' ').trim();
}
function sourceBoundRecoveredTiming(phrase, units, evidenceIds, carrier, options = {}, structuralProof = false) {
  if (!timingRecoveryContext(options)) { timingRecoveryIssue(options); return null; }
  const clauses = timingSourceClauses(carrier?.text);
  for (const [clauseIndex, clause] of clauses.entries()) {
    const followingQualifier = /^(?:all being well|if possible|at least|at the latest)[.!?]*$/i.test(clauses[clauseIndex + 1] || '') ? clauses[clauseIndex + 1] : '';
    const timingClause = followingQualifier ? `${clause} ${followingQualifier}` : clause;
    const wording = qualifiedTimingPhrase(phrase, timingClause);
    if (!wording) continue;
    const timing = sourceRecoveredTiming(wording, options);
    const actorNamed = options.owners.some(owner => {
      const first = nameParts(owner)[0];
      return first && new RegExp(`\\b${first}\\s+(?:will|shall|must|is to|is going to)\\b`, 'i').test(clause);
    });
    const temporalOnly = !clause.toLowerCase().replace(phrase.toLowerCase(), ' ').replace(ANSWER_LEAD_FILLER, ' ').replace(/[^\p{L}\p{N}]+/gu, '');
    const ownPromise = speakerIsOwner(carrier.speaker, options.owners)
      && (/^\s*(?:(?:yeah|yes|okay|ok|right|well|so|sure|no problem)\s+)*(?:I(?:['’]ll| will| shall| can| must| need to| have to| am going to)\b|let me\b|leave (?:it|that|this) with me\b)/i.test(clause)
        || temporalOnly);
    if (!structuralProof && !ownPromise && !actorNamed) continue;
    // Check the actual carrying clause. A second operation/date in the same
    // source row must not satisfy the calendar check for this one. A purely
    // temporal comma continuation retains only its nearest preceding clause.
    const proofText = temporalOnly && clauseIndex > 0 ? `${clauses[clauseIndex - 1]}, ${clause}` : clause;
    const proofUnits = units.map(unit => unit.id === carrier.id ? { ...unit, text: proofText } : unit);
    const row = { action: options.action, owners: options.owners, timing, evidenceIds };
    const binding = TimingIntegrity.assessTimingSourceBinding(row, proofUnits, { meetingDate: options.meetingDate });
    if (!structuralProof && (binding.status !== 'supported' || !binding.matchedSourceIds.includes(carrier.id))) continue;
    // A date can be correctly linked yet overstate "probably Friday", omit a
    // bound/dependency, or lose a second date. Keep only a lossless expression.
    // Loaded lazily because the summary review module also consumes V2 helpers.
    const { temporalMeaningRetained } = require('./meetingMinutesTemporalReview');
    if (!temporalMeaningRetained(wording, timingClause, { meetingDate: options.meetingDate })) continue;
    const workAnchors = evidenceWindowUnits(units, evidenceIds, 0)
      .filter(unit => predicateSupportsAction(options.action, unit.text)
        && (speakerIsOwner(unit.speaker, options.owners) || options.owners.some(owner => nameParts(owner).some(name => new RegExp(`\\b${name}\\b`, 'i').test(unit.text)))))
      .sort((left, right) => evidenceSupportScore(options.action, right.text) - evidenceSupportScore(options.action, left.text))
      .slice(0, 2).map(unit => unit.id);
    return { timing, evidenceIds: [...new Set([...evidenceIds, carrier.id, ...(binding.matchedSourceIds || [])])],
      requiredEvidenceIds: [...new Set([carrier.id, ...(binding.matchedSourceIds || []), ...workAnchors])] };
  }
  timingRecoveryIssue(options);
  return null;
}
function recoveredTimingEvidence(ids, recovered) {
  if (!recovered.length) return ids;
  const merged = [...new Set([...ids, ...recovered])];
  if (merged.length <= 8) return merged;
  const selected = new Set([...new Set([...recovered, ...ids])].slice(0, 8));
  return merged.filter(id => selected.has(id));
}
function chooseRecoveredTiming(candidates, original, options = {}) {
  const byTiming = new Map();
  for (const candidate of candidates.filter(Boolean)) {
    const key = JSON.stringify(candidate.timing);
    if (!byTiming.has(key)) byTiming.set(key, candidate);
  }
  const unique = [...byTiming.values()];
  if (unique.length !== 1) {
    if (unique.length > 1) timingRecoveryIssue(options, true);
    return original;
  }
  if (Array.isArray(options.recoveredTimingEvidenceIds)) options.recoveredTimingEvidenceIds.push(...(unique[0].requiredEvidenceIds || unique[0].evidenceIds));
  return unique[0].timing;
}
function inferenceSubjectWords(value) {
  return resolutionTokens(value).filter(word => !['the', 'and', 'new', 'can', 'you', 'do', 'think', 'reckon', 'expect', 'will', 'shall', 'draft', 'write', 'written', 'create', 'prepare', 'produce', 'generate', 'send', 'hold', 'arrange', 'schedule', 'review', 'check', 'place', 'order'].includes(word));
}
function timingQuestionBound(question, rows, options) {
  if (!timingRecoveryContext(options)) return false;
  const known = evidenceContextFor(rows).speakers.filter(name => new RegExp(`\\b${nameParts(name)[0]}\\b`, 'i').test(question.text));
  const vocatives = [...String(question.text).matchAll(/(?:,\s*|^\s*(?:And\s+)?)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s*(?=,|[?!]?$)/g)].map(match => match[1]);
  if ([...known, ...vocatives].some(name => !speakerIsOwner(name, options.owners))) return false;
  let remaining = String(question.text).replace(WHEN_QUESTION, ' ');
  for (const owner of options.owners) for (const name of nameParts(owner)) remaining = remaining.replace(new RegExp(`\\b${name}\\b`, 'gi'), ' ');
  const actionWords = new Set(inferenceSubjectWords(options.action));
  const subjects = inferenceSubjectWords(remaining).filter(word => !['date', 'deadline', 'time', 'timing', 'timescale', 'timeline', 'timeframe', 'eta', 'sort', 'soon', 'roughly', 'idea', 'finish', 'complete'].includes(word));
  if (subjects.some(word => !actionWords.has(word))) return false;
  const operation = String(question.text).match(/\bwhen\s+(?:can|will|could|would|do|does|should|might)\s+(?:you|we|he|she|they)\s+([a-z]+)/i)?.[1];
  if (operation && !/^(?:do|be|think|reckon|expect|finish|complete)$/.test(operation)
    && !predicateSupportsAction(options.action, question.text)
    && operation.toLowerCase() !== String(options.action).toLowerCase().split(/\s+/)[0]) return false;
  return true;
}
function askedTimingStructureBound(options, rows, questionAt, replyAt, evidenceIds, phrase) {
  if (!timingRecoveryContext(options)) return false;
  const question = rows[questionAt], reply = rows[replyAt], wanted = new Set(evidenceIds);
  const owners = options.owners, action = options.action;
  if (!timingQuestionBound(question, rows, options)) return false;
  const lead = String(reply.text).slice(0, String(reply.text).toLowerCase().indexOf(phrase.toLowerCase()));
  const actionWords = new Set(inferenceSubjectWords(action));
  if (answerNamesSubject(lead)) {
    // An output named by the owner can answer its own when-question without
    // repeating "create". Every named object/quantity must match, and an
    // earlier obligation must explicitly require that new output.
    if (!speakerIsOwner(reply.speaker, owners) || !/^(?:create|prepare|produce|generate|draft|write)\b/i.test(action)
      || !/\bnew\b/i.test(lead)) return false;
    const tail = String(reply.text).slice(String(reply.text).toLowerCase().indexOf(phrase.toLowerCase()) + phrase.length)
      .replace(/\b(?:all being well|if possible|at least|at the latest)\b/gi, ' ').replace(/[^\p{L}\p{N}]+/gu, '');
    if (tail) return false;
    const objects = inferenceSubjectWords(lead);
    if (!objects.length || objects.some(word => !actionWords.has(word))) return false;
    return rows.slice(Math.max(0, questionAt - 8), questionAt).some(unit => speakerIsOwner(unit.speaker, owners)
      && /\bneeds?\s+new\b/i.test(unit.text)
      && objects.filter(word => !/^\d+$|^(?:one|two|three|four|five|six|seven|eight|nine|ten)$/.test(word))
        .every(word => inferenceSubjectWords(unit.text).includes(word)));
  }
  // A requester may read a date back after an owner's explicit "I'll draft
  // that". Only this bounded, purely temporal settlement has that exception;
  // the original cited deliverable and the owner's operation are both needed.
  if (reply.speaker !== question.speaker || !SETTLES_TIMING.test(reply.text)) return false;
  const remainder = String(reply.text).replace(phrase, ' ').replace(ANSWER_LEAD_FILLER, ' ').replace(/[^\p{L}\p{N}]+/gu, '');
  if (remainder) return false;
  const ownAt = rows.slice(Math.max(0, questionAt - 3), questionAt).map((unit, offset) => ({ unit, at: Math.max(0, questionAt - 3) + offset }))
    .filter(({ unit }) => wanted.has(unit.id) && speakerIsOwner(unit.speaker, owners)
      && /\bI(?:['’]ll| will| shall)\b/i.test(unit.text) && predicateSupportsAction(action, unit.text)
      && /\b(?:write|draft|prepare|review|check|assess|send|email|share|forward|circulate|contact|call|ring|message)\s+(?:it|that|this)[.!?]*$/i.test(unit.text)).pop();
  if (!ownAt) return false;
  const anchor = rows.slice(Math.max(0, ownAt.at - 3), ownAt.at + 1).some(unit => wanted.has(unit.id)
    && commitmentQuoteAboutAction(unit.text, action, `${unit.speaker}: ${unit.text}`));
  if (!anchor) return false;
  return !rows.slice(ownAt.at + 1, replyAt).some(unit => {
    if (unit === question) return false;
    if (OWNER_FIRST_PERSON.test(unit.text) || ACTION_COMMITMENT_PATTERN.test(unit.text)
      || /\b[A-Z][a-z]+\s+(?:will|shall|must|can|is going to|is responsible for)\b/.test(unit.text)) return true;
    if (/\b(?:I|we)\s+(?:want|need|expect|ask(?:ed)?)\b/i.test(unit.text)) {
      // Reviewing "it" can remain a bridge about the same draft. A named
      // person receiving new concrete work (or an unbound reference) cannot.
      const review = String(unit.text).match(/\b(?:I|we)\s+(?:want|need|expect|ask(?:ed)?)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+to\s+(.+)$/i)?.[1];
      return !review || !/^(?:look over|review|check|read)\s+(?:it|that|this)[.!?]*$/i.test(review.trim());
    }
    return false;
  });
}
function backfillAskedTiming(timing, units = [], evidenceIds = [], options = {}) {
  if (timingRecoveryBlocked(options.timingDecision) || timing.kind !== 'not_stated') return timing;
  const window = evidenceWindowUnits(units, evidenceIds, 3);
  const all = evidenceContextFor(units).rows, candidates = [];
  for (const question of window) {
    if (!WHEN_QUESTION.test(String(question?.text || ''))) continue;
    if (!timingQuestionBound(question, all, options)) { timingRecoveryIssue(options); continue; }
    const at = all.indexOf(question);
    for (const reply of all.slice(at + 1, at + 4)) {
      const spoken = String(reply?.text || '');
      if (reply?.speaker === question?.speaker && (/\?/.test(spoken) || !SETTLES_TIMING.test(spoken))) continue;
      const phrase = spoken.match(ANSWER_TIMING);
      if (!phrase || UNKNOWN_TIMING_ANSWER.test(spoken)) continue;
      const lead = spoken.slice(0, phrase.index);
      if (options.action && answerNamesSubject(lead) && !sharesSubjectWord(options.action, spoken)) continue;
      const replyAt = all.indexOf(reply);
      const contextIds = [...new Set([...evidenceIds, ...all.slice(Math.max(0, at - 3), replyAt + 1).map(unit => unit.id)])];
      const structuralProof = askedTimingStructureBound(options, all, at, replyAt, contextIds, phrase[0]);
      candidates.push(sourceBoundRecoveredTiming(phrase[0], units, contextIds, reply, options, structuralProof));
    }
  }
  return chooseRecoveredTiming(candidates, timing, options);
}

// ---- Acceptance that lives in the turn structure, not the cited words ------
// The keyword reading of an action's cited lines answers "unclear" for three
// exchanges a person reads as accepted work (draft 1055, all three stuck in
// the suggestions queue):
//   "David, is that something you can write up as comments?" / "It'll be
//   Friday though, I'm on site Wednesday and Thursday."     - a timing is
//   the yes;
//   "Can you find out what they'd need to do it" said by the chair straight
//   after Ffion raised the problem, and nobody objects   - the addressee is
//   the previous speaker;
//   "So those need new DIs" ... "And Sanjay, timeline on that?" / "The three
//   new DIs, this week."                                   - the owner
//   answers a when-question about the same work with a date.
// Each rule needs speakers and order, so it reads the transcript rows rather
// than the flattened evidence string. It only ever upgrades "unclear" or
// "unaccepted_request"; suggestions, status and completed work stay as they are.
const ASKS_FOR_WORK = /\b(?:please|can (?:you|somebody|someone)|could (?:you|somebody|someone)|would (?:you|somebody|someone)|will (?:you|somebody|someone)|(?:is|are) (?:that|this|it|they) something (?:you|we) (?:can|could)|(?:are|would) you (?:able|happy|ok|okay) to|you (?:can|could) (?:write|send|draft|check|find|look|do|put|pull|get|sort|chase|update|prepare|review)\b|(?:do|can) you (?:want|mind) to)\b/i;
const ASKS_WHEN = new RegExp(`${WHEN_QUESTION.source}|\\b(?:timeline|timescale|timeframe|time frame|eta|when)\\b[^.?!]{0,40}\\?`, 'i');
const DECLINES_WORK = /\b(?:can't|cannot|couldn't|won't|not me|not (?:my|mine)|i don't think i can|i'm not (?:able|sure i can)|no,? (?:i|we) (?:can't|won't|don't))\b/i;
function speakerIsOwnerName(speaker = '', owners = []) {
  const names = (Array.isArray(owners) ? owners : []).map((owner) => String(owner || '').trim().toLowerCase()).filter(Boolean);
  if (!names.length) return true;
  return speakerIsOwner(speaker, owners);
}
function sharesSubjectWord(action = '', spoken = '') {
  const words = (value) => new Set(String(value || '').toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) || []);
  const stop = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'from', 'into', 'then', 'them', 'they', 'those', 'these', 'there', 'their', 'have', 'has', 'will', 'week', 'day', 'days', 'new', 'one', 'two', 'three', 'four', 'five', 'all', 'any', 'are', 'was', 'were', 'been', 'being', 'just', 'also', 'not', 'but', 'yes', 'yeah', 'okay', 'well', 'need', 'needs', 'get', 'got', 'its', 'our', 'your', 'you', 'out', 'about', 'what', 'which', 'when', 'where', 'who', 'how', 'can', 'could', 'should', 'would']);
  const target = [...words(action)].filter((word) => !stop.has(word));
  const source = words(spoken);
  return target.some((word) => source.has(word) || source.has(`${word}s`) || (word.endsWith('s') && source.has(word.slice(0, -1))));
}
function acceptanceAroundEvidenceDetail(action = {}, units = []) {
  const none = { disposition: '', evidenceIds: [] };
  const rows = evidenceContextFor(units).rows;
  const wanted = new Set((Array.isArray(action?.evidenceIds) ? action.evidenceIds : []).map((id) => text(id, 30)));
  const cited = rows.map((unit, index) => (wanted.has(unit.id) ? index : -1)).filter((index) => index >= 0);
  if (!cited.length) return none;
  const owners = Array.isArray(action?.owners) ? action.owners : [];
  // Accepted by whom? Without a named owner there is nobody for the reply
  // to tie the work to, and an ownerless "accepted" row was being restored to
  // the published list and then absorbing the suggestion it came from.
  if (!owners.length) return none;
  const first = Math.min(...cited);
  const last = Math.max(...cited);
  const declinedAfter = (index) => rows.slice(index + 1, index + 3).some((row) => DECLINES_WORK.test(String(row?.text || '')));
  // Rule 1: a request or when-question answered, within two rows, by someone
  // else with a time or a yes. The answerer must be the owner when one is named.
  for (const index of new Set([...cited, ...cited.map((value) => value + 1)])) {
    const row = rows[index];
    if (!row) continue;
    const spoken = String(row.text || '');
    if (!ASKS_FOR_WORK.test(spoken) && !ASKS_WHEN.test(spoken)) continue;
    for (const reply of rows.slice(index + 1, index + 3)) {
      if (!reply || reply.speaker === row.speaker) continue;
      const answer = String(reply.text || '');
      if (DECLINES_WORK.test(answer) || UNKNOWN_TIMING_ANSWER.test(answer)) break;
      if (!hasTimingSignal(answer) && !ACTION_ACCEPTANCE_PATTERN.test(answer)) continue;
      if (!speakerIsOwnerName(reply.speaker, owners)) continue;
      // "The three new DIs, this week" answers for the DIs, not for whatever
      // else was asked about nearby; a bare "Friday" or "yes" answers for it.
      const timed = answer.match(ANSWER_TIMING);
      const lead = timed ? answer.slice(0, timed.index) : '';
      if (timed && answerNamesSubject(lead) && !sharesSubjectWord(action.action, answer)) continue;
      return { disposition: 'accepted_request', evidenceIds: [row.id, reply.id] };
    }
  }
  // Rule 2: the chair hands the work to the person who just raised it. The
  // request comes from someone else within three rows of the owner's cited
  // line, nobody but the requester speaks in between, and nobody declines.
  if (owners.length) {
    for (let index = first; index <= Math.min(rows.length - 1, last + 3); index += 1) {
      const row = rows[index];
      if (!row || !ASKS_FOR_WORK.test(String(row.text || '')) || speakerIsOwner(row.speaker, owners)) continue;
      const ownerBefore = rows.slice(Math.max(0, index - 3), index).map((unit, offset) => ({ unit, at: Math.max(0, index - 3) + offset }))
        .filter(({ unit }) => speakerIsOwner(unit.speaker, owners)).pop();
      if (!ownerBefore) continue;
      const between = rows.slice(ownerBefore.at + 1, index);
      if (between.some((unit) => unit.speaker !== row.speaker)) continue;
      if (declinedAfter(index)) continue;
      return { disposition: 'accepted_request', evidenceIds: [rows[ownerBefore.at].id, row.id] };
    }
  }
  // Rule 3: later on, the owner answers a when-question about the same work
  // with a time. "And Sanjay, timeline on that?" "The three new DIs, this week."
  if (owners.length) {
    for (let index = last + 1; index <= Math.min(rows.length - 1, last + 12); index += 1) {
      const row = rows[index];
      if (!row || !speakerIsOwner(row.speaker, owners)) continue;
      const spoken = String(row.text || '');
      if (!hasTimingSignal(spoken) || !sharesSubjectWord(action.action, spoken)) continue;
      const asked = rows.slice(Math.max(0, index - 2), index).some((unit) => unit.speaker !== row.speaker && ASKS_WHEN.test(String(unit.text || '')));
      if (asked) return { disposition: 'committed', evidenceIds: [rows[index - 1].id, row.id] };
    }
  }
  return none;
}
function acceptanceAroundEvidence(action = {}, units = []) {
  return acceptanceAroundEvidenceDetail(action, units).disposition;
}

// "Let's put the follow-up in for the ninth or the tenth." "The tenth suits
// better." "Tenth." An offered choice of dates is not the timing; the one the
// meeting settled on is. When a later turn in the same exchange names exactly
// one of the offered days, that day becomes the wording.
const OFFERED_DAY_CHOICE = /\b(?:the\s+)?(\d{1,2}(?:st|nd|rd|th)?|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|twenty-?\w+|thirtieth|thirty-?first)\s+or\s+(?:the\s+)?(\d{1,2}(?:st|nd|rd|th)?|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|twenty-?\w+|thirtieth|thirty-?first)\b/i;
function resolveOfferedDateChoice(timing, units = [], evidenceIds = [], options = {}) {
  const wording = String(timing?.wording || ''), offered = wording.match(OFFERED_DAY_CHOICE);
  if (!offered || timingRecoveryBlocked(options.timingDecision)) return timing;
  if (!timingRecoveryContext(options)) { timingRecoveryIssue(options); return timing; }
  const [first, second] = [offered[1], offered[2]].map(day => day.toLowerCase());
  const rows = evidenceWindowUnits(units, evidenceIds, 3);
  const sourceOffer = rows.find(row => evidenceIds.includes(row.id) && OFFERED_DAY_CHOICE.test(row.text));
  const sourceSpan = String(sourceOffer?.text || '').match(OFFERED_DAY_CHOICE)?.[0];
  const sourceTiming = sourceSpan ? { ...timing, wording: wording.replace(OFFERED_DAY_CHOICE, sourceSpan) } : timing;
  const offerBinding = TimingIntegrity.assessTimingSourceBinding({ action: options.action, owners: options.owners, timing: sourceTiming, evidenceIds }, units, { meetingDate: options.meetingDate });
  if (offerBinding.status !== 'supported') { timingRecoveryIssue(options); return timing; }
  const says = (value, day) => new RegExp(`\\b(?:the\\s+)?${day}\\b`, 'i').test(value);
  const offerAt = rows.findIndex(row => evidenceIds.includes(row.id) && OFFERED_DAY_CHOICE.test(row.text));
  if (offerAt < 0) return timing;
  for (const row of rows.slice(offerAt + 1)) {
    const value = String(row.text || ''), picksFirst = says(value, first), picksSecond = says(value, second);
    if (picksFirst === picksSecond) {
      if (!NON_SUBSTANTIVE_TIMING_BRIDGE.test(value)) break;
      continue;
    }
    const chosen = picksFirst ? first : second;
    const remainder = value.replace(new RegExp(`\\b(?:the\\s+)?${chosen}(?:\\s+of\\s+[A-Za-z]+)?\\b`, 'i'), ' ')
      .replace(/\b(?:suits? better|works? better|works?|it is|is better|then|yes|okay|ok|yeah|yep|for me)\b/gi, ' ')
      .replace(/[^\p{L}\p{N}]+/gu, '');
    if (remainder || !speakerIsOwner(row.speaker, options.owners)) { timingRecoveryIssue(options); break; }
    const candidate = timingFrom({ timing: { wording: wording.replace(OFFERED_DAY_CHOICE, chosen) } }, options);
    if (Array.isArray(options.recoveredTimingEvidenceIds)) options.recoveredTimingEvidenceIds.push(row.id, ...offerBinding.matchedSourceIds);
    return candidate;
  }
  return timing;
}

function backfillCitedTiming(timing, units = [], evidenceIds = [], options = {}) {
  if (timingRecoveryBlocked(options.timingDecision) || timing.kind !== 'not_stated') return timing;
  const candidates = [];
  for (const unit of evidenceWindowUnits(units, evidenceIds, 0)) {
    const source = String(unit.text || '');
    if (!ACTION_COMMITMENT_PATTERN.test(source) && !ACTION_CONCRETE_INTENTION_PATTERN.test(source)
      && !NAMED_WILL_PATTERN.test(source) && !CITED_TIMING_COMMITMENT_CUE.test(source)) continue;
    for (const match of source.matchAll(new RegExp(CITED_TIMING_PHRASE.source, 'gi'))) {
      candidates.push(sourceBoundRecoveredTiming(match[0], units, evidenceIds, unit, options));
    }
  }
  return chooseRecoveredTiming(candidates, timing, options);
}

// Teams occasionally puts the timing in its own tiny turn after the commitment:
// "I'll review the manual." / "Thank you." / "This week."  The ordinary timing
// backfill intentionally never reads neighbouring turns, so recover this one narrow
// continuation shape here.  A different substantive turn closes the continuation.
const TIMING_FRAGMENT_FILLER = /\b(?:yeah|yes|yep|okay|ok|right|so|well|actually|definitely|certainly)\b/gi;
const NON_SUBSTANTIVE_TIMING_BRIDGE = /^(?:thank(?:s| you)|okay|ok|yeah|yes|yep|right|perfect|great|fine|mhm|mm)[.!?, ]*$/i;
function timingOnlyFragment(value = '') {
  const source = String(value || '').trim();
  const match = source.match(CITED_TIMING_PHRASE);
  if (!match) return '';
  const remainder = source
    .replace(match[0], ' ')
    .replace(TIMING_FRAGMENT_FILLER, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
  return remainder ? '' : match[0].toLowerCase().replace(/\s+/g, ' ');
}

function adjacentOwnerTiming(action = {}, units = [], evidenceIds = [], options = {}) {
  if (isReviewerAuthored(action) || timingRecoveryBlocked(action.timingDecision)
    && TimingIntegrity.assessmentMatches(action, units, options.meetingDate, action.timingDecision)) return null;
  if (!Array.isArray(action.owners) || !action.owners.length || !evidenceIds.length) return null;
  const context = evidenceContextFor(units);
  const citedIndexes = evidenceIds.map((id) => context.indexById.get(id)).filter(Number.isInteger);
  if (!citedIndexes.length) return null;
  const start = Math.max(...citedIndexes);
  for (let index = start + 1; index <= Math.min(start + 3, context.rows.length - 1); index += 1) {
    const unit = context.rows[index];
    const phrase = speakerIsOwner(unit.speaker, action.owners) ? timingOnlyFragment(unit.text) : '';
    if (phrase) {
      return sourceBoundRecoveredTiming(phrase, units, [...new Set([...evidenceIds, unit.id])], unit,
        { ...options, action: action.action, owners: action.owners });
    }
    if (!NON_SUBSTANTIVE_TIMING_BRIDGE.test(String(unit.text || '').trim())) break;
  }
  return null;
}

// Lexical evidence resolution favours the turn that names the deliverable
// ("Six sacks of Maris Otter, thirty-two pounds a sack") over the turn where
// the owner takes the job on ("leave that with me, I'll order six sacks
// today"). The reviewer needs the second one: it carries the ownership, the
// timing and the commitment itself. When such a turn sits within a few turns
// of the cited passage, add it to the citation. Additive only.
const COMMITMENT_ANCHOR_RADIUS = 18;
const ACTION_PREDICATE_ALIASES = [
  [/(?:^|\s)(?:review|investigate|check|assess)(?:\s|$)/i, /\b(?:review|investigate|check|assess|have a look|look into)\b/i],
  [/(?:^|\s)(?:send|email|share|forward|circulate)(?:\s|$)/i, /\b(?:send|email|share|forward|circulate)\b/i],
  [/(?:^|\s)(?:contact|call|ring|message)(?:\s|$)/i, /\b(?:contact|call|ring|message|reach out)\b/i],
  [/(?:^|\s)(?:prepare|create|draft|write|build)(?:\s|$)/i, /\b(?:prepare|create|draft|write|build|put together)\b/i]
];
function predicateSupportsAction(action, source) {
  return ACTION_PREDICATE_ALIASES.some(([actionPattern, sourcePattern]) =>
    actionPattern.test(String(action || '')) && sourcePattern.test(String(source || '')));
}
function speakerIsOwner(speaker, owners = []) {
  const words = (value) => String(value || '').toLowerCase().replace(/[^\p{L}\p{N}\s'’-]/gu, ' ').split(/\s+/).filter(Boolean);
  const speakerWords = words(speaker);
  if (!speakerWords.length) return false;
  return owners.some((owner) => {
    const ownerWords = words(owner);
    if (!ownerWords.length) return false;
    if (ownerWords.join(' ') === speakerWords.join(' ')) return true;
    // "Dan" for "Dan Threlfall", either way round, but never a surname alone.
    return (ownerWords.length === 1 && ownerWords[0] === speakerWords[0])
      || (speakerWords.length === 1 && speakerWords[0] === ownerWords[0]);
  });
}
function anchorOwnerCommitment(action, owners = [], units = [], evidenceIds = []) {
  if (!owners.length || !evidenceIds.length) return evidenceIds;
  const cited = new Set(evidenceIds);
  const actionTokens = materialTokens(action);
  if (actionTokens.length < 2) return evidenceIds;
  const evidenceContext = evidenceContextFor(units);
  const citedIndexes = evidenceIds.map((id) => evidenceContext.indexById.get(id)).filter(Number.isInteger);
  const nearby = evidenceWindowUnits(units, evidenceIds, COMMITMENT_ANCHOR_RADIUS)
    .filter((unit) => !cited.has(unit.id) && speakerIsOwner(unit.speaker, owners));
  let best = null;
  for (const unit of nearby) {
    const unitTokens = new Set(contentTokens(unit.text));
    const shared = actionTokens.filter((token) => unitTokens.has(token)).length;
    const predicateMatch = predicateSupportsAction(action, unit.text);
    if (shared < 2 && !predicateMatch) continue;
    const disposition = actionEvidenceDisposition(action, `${unit.speaker}: ${unit.text}`);
    if (!['committed', 'accepted_request', 'conditional_commitment'].includes(disposition)) continue;
    const at = evidenceContext.indexById.get(unit.id);
    const distance = citedIndexes.length && Number.isInteger(at)
      ? Math.min(...citedIndexes.map((index) => Math.abs(index - at))) : COMMITMENT_ANCHOR_RADIUS;
    const score = shared * 10 + Number(predicateMatch) * 8 - distance;
    if (!best || score > best.score) best = { id: unit.id, score };
  }
  if (!best) return evidenceIds;
  return [...evidenceIds, best.id].slice(0, 8);
}

// Noun-heavy turns are useful evidence for the work; short answers often carry
// its owner, acceptance and timing. Keep those supplied field anchors when
// lexical remapping prefers a different description of the same work. A timing
// answer needs a connected owner commitment/when-question exchange, rather than
// merely being a nearby date belonging to another task.
function retainSuppliedActionFieldEvidence(action, owners, units, suppliedIds, resolvedIds, timing = {}, options = {}) {
  const context = evidenceContextFor(units);
  const subjects = new Set(actionSubjectWords(action));
  const hasSubject = (value) => [...new Set(contentTokens(value))].filter((word) => subjects.has(word)).length >= 2;
  const citationText = value => comparisonText(value).replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
  const timingWording = citationText(timing?.wording || '');
  const timingWords = timingWording.split(' ').filter(Boolean);
  const orderedTimingWords = value => {
    const words = citationText(value).split(' ').filter(Boolean);
    let at = 0;
    for (const word of timingWords) {
      at = words.indexOf(word, at);
      if (at < 0) return false;
      at += 1;
    }
    return timingWords.length > 0;
  };
  const timingRelations = value => [...String(value).toLowerCase().matchAll(/\b(?:not before|no earlier than|no later than|not later than|on or before|by|before|after|within|until|once|when|subject to|at least|at most)\b/g)].map(match => match[0]).sort();
  const timingQualifications = value => [...String(value).toLowerCase().matchAll(/\b(?:hopefully|probably|presumably|possibly|maybe|perhaps|ideally|preferably|roughly|approximately|around|about)\b/g)].map(match => match[0]).sort();
  const timingFacets = value => [...new Set(citationText(value).split(' ').filter(word => /^(?:\d+|today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|early|late|mid|morning|afternoon|evening|noon|midnight|this|next|every|each|daily|weekly|monthly|yearly|hours?|days?|weeks?|months?|quarters?|years?|am|pm|utc|gmt|bst|cet|cest)$/i.test(word)))].sort();
  const contradictsNamedOwner = unit => {
    if (!owners.length) return false;
    const value = String(unit.text || '');
    const vocative = value.match(/^\s*(?:And\s+)?([A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+){0,2})\s*,/u)?.[1];
    const named = [...value.matchAll(/\b([A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+){0,2})\s+(?:will|shall|must|to)\s+/gu)].map(match => match[1]);
    if (vocative && !/^(?:Hopefully|Probably|Presumably|Possibly|Maybe|Perhaps|Ideally|Preferably|Well|Right|Okay|Thanks)$/i.test(vocative)) named.push(vocative);
    return named.some(name => !/^(?:I|We|They)$/i.test(name) && !speakerIsOwner(name, owners))
      || /\b(?:I['’]ll|I will|I shall|I am going to)\b/i.test(value) && !speakerIsOwner(unit.speaker, owners);
  };
  // A chair's recap can carry the actual timing while earlier turns describe
  // the work more fully. Retain a supplied direct quotation of that field
  // before the citation cap; its presence remains provenance, not a verdict
  // that the date/owner/operation is correct (the timing checks still decide).
  const directTimingIds = hasTimingSignal(timing?.wording || '') ? [...new Set(suppliedIds || [])].filter(id => {
    const unit = context.rows[context.indexById.get(id)];
    if (!unit || !timingWording) return false;
    if (citationText(unit.text).includes(timingWording)
      && actionPredicateSupported(action, unit.text)
      && contentTokens(unit.text).some(word => subjects.has(word))) return true;
    // The generated timing may omit intervening work words without changing
    // its date, qualification or bound. Keep this supplied field source when
    // all timing words occur in order in one clause naming this operation and
    // an object of this action. This only retains provenance: the shared
    // source-binding policy must still verify it or flag it as unresolved.
    if (contradictsNamedOwner(unit)
      || /\b(?:not|never|cannot|can't|won't|was|were|had|previously|yesterday|ago|last\s+(?:week|month|year))\b/i.test(unit.text)) return false;
    const carryingClause = String(unit.text || '').split(/[,;]|(?<=[.!?])\s+/).some(clause => {
      const timedWork = clause.match(/\bto\s+([^.;!?]+)[.!?]*$/i)?.[1];
      const workSubjects = actionSubjectWords(timedWork || '').filter(word => !timingWords.includes(word)
        && !['least', 'most', 'the', 'that', 'this', 'it', 'them', 'those', 'these'].includes(word));
      return timedWork && workSubjects.length && workSubjects.every(word => subjects.has(word))
        && orderedTimingWords(clause) && actionPredicateSupported(action, timedWork)
        && JSON.stringify(timingRelations(clause)) === JSON.stringify(timingRelations(timing.wording))
        && JSON.stringify(timingQualifications(clause)) === JSON.stringify(timingQualifications(timing.wording))
        && JSON.stringify(timingFacets(clause)) === JSON.stringify(timingFacets(timing.wording));
    });
    if (!carryingClause) return false;
    return TimingIntegrity.assessTimingSourceBinding({ action, owners, evidenceIds: [id], timing }, units, options).status !== 'unsupported';
  }) : [];
  const commitmentObjects = (value) => {
    const generic = new Set(['the', 'and', 'i\'ll', 'will', 'shall', 'can', 'could', 'myself', 'new', 'replacement', 'unit', 'one', 'this', 'that', 'them', 'these', 'those', 'let', 'leave', 'handle', 'take', 'fit', 'pop', 'put']);
    const operations = new Set(ACTION_VERB_GROUPS.flat());
    // Timing and its spoken qualification are not another object. Keep any
    // concrete object named before the time, so a financial-report promise
    // cannot borrow the valve subject just because it is nearby.
    const timingAt = String(value).search(CALENDAR_TIMING);
    const instruction = timingAt >= 0 ? String(value).slice(0, timingAt) : value;
    return actionSubjectWords(instruction)
      .filter((word) => !generic.has(word) && !operations.has(word) && !COMMON_SPEECH_WORDS.has(word));
  };
  const connectedCommitment = (index) => {
    const unit = context.rows[index];
    if (!unit || !speakerIsOwner(unit.speaker, owners)
      || !OWNER_FIRST_PERSON.test(unit.text) || isHabitualPromise(unit.text)) return false;
    if (hasSubject(unit.text)) return true;
    const objects = commitmentObjects(unit.text);
    // A nearby promise explicitly naming a different object starts another
    // task; the earlier subject in the surrounding window cannot lend its
    // identity backwards to that promise or its subsequent timing answer.
    if (objects.some((word) => !subjects.has(word))) return false;
    if (objects.length && objects.some((word) => subjects.has(word))) return true;
    return hasSubject(evidenceWindowText(units, [unit.id], 4));
  };
  const timingOnlyAnswer = (unit) => {
    if (!unit || !hasTimingSignal(unit.text)) return false;
    const remainder = String(unit.text).replace(new RegExp(CALENDAR_TIMING.source, 'gi'), ' ')
      .replace(/\b(?:probably|possibly|ideally|around|about|roughly|the|of|at|and|or|yes|yeah|okay|ok)\b/gi, ' ')
      .replace(/[^a-z]+/gi, '').trim();
    return !remainder;
  };
  const timingAnswer = (index) => {
    const unit = context.rows[index];
    const referentialTimedPromise = unit && hasTimingSignal(unit.text)
      && OWNER_FIRST_PERSON.test(unit.text) && !commitmentObjects(unit.text).length;
    if (!unit || !speakerIsOwner(unit.speaker, owners) || (!timingOnlyAnswer(unit) && !referentialTimedPromise)) return false;
    for (let before = index - 1; before >= Math.max(0, index - 3); before -= 1) {
      const prior = context.rows[before];
      if (NON_SUBSTANTIVE_TIMING_BRIDGE.test(prior.text)) continue;
      if (connectedCommitment(before)) return true;
      if (!ASKS_WHEN.test(prior.text)) return false;
      for (let at = before - 1; at >= Math.max(0, before - 3); at -= 1) {
        if (connectedCommitment(at)) return true;
        if (!NON_SUBSTANTIVE_TIMING_BRIDGE.test(context.rows[at].text)) break;
      }
      return false;
    }
    return false;
  };
  const retained = [...new Set(suppliedIds || [])].filter((id) => {
    const index = context.indexById.get(id);
    if (!Number.isInteger(index)) return false;
    return connectedCommitment(index) || timingAnswer(index);
  });
  const unrelatedAnswers = new Set((suppliedIds || []).filter((id) => {
    const index = context.indexById.get(id);
    return owners.length && Number.isInteger(index) && timingOnlyAnswer(context.rows[index]) && !timingAnswer(index);
  }));
  return [...new Set([...directTimingIds, ...retained, ...(resolvedIds || []).filter((id) => !unrelatedAnswers.has(id))])].slice(0, 8);
}

function backfillActionCommitmentEvidence(actions = [], units = [], options = {}) {
  return (Array.isArray(actions) ? actions : []).map((action) => {
    if (isReviewerAuthored(action) || timingRecoveryBlocked(action.timingDecision)
      && TimingIntegrity.assessmentMatches(action, units, options.meetingDate, action.timingDecision)) return action;
    let evidenceIds = anchorOwnerCommitment(action?.action, action?.owners || [], units, action?.evidenceIds || []);
    // The rows where the work was accepted (a timing given as the yes, the
    // chair handing it over, the owner answering a when-question) belong in
    // the citation: they are what a reviewer checks, and the timing backfills
    // read the cited rows.
    const accepted = acceptanceAroundEvidenceDetail(action, units);
    if (accepted.disposition) evidenceIds = [...new Set([...evidenceIds, ...accepted.evidenceIds])].slice(0, 8);
    const timingRecoveryIssues = [], recoveredTimingEvidenceIds = [];
    const recoveryOptions = { ...options, action: action?.action, owners: action?.owners,
      timingRecoveryIssues, recoveredTimingEvidenceIds,
      timingDecision: TimingIntegrity.assessmentMatches(action, units, options.meetingDate, action.timingDecision) ? action.timingDecision : null };
    let timing = resolveOfferedDateChoice(backfillAskedTiming(backfillCitedTiming(timingFrom(action, options), units, evidenceIds, recoveryOptions), units, evidenceIds, recoveryOptions), units, evidenceIds, recoveryOptions);
    if (timing.kind === 'not_stated') {
      const adjacent = adjacentOwnerTiming(action, units, evidenceIds, recoveryOptions);
      if (adjacent) ({ evidenceIds, timing } = adjacent);
    }
    evidenceIds = recoveredTimingEvidence(evidenceIds, recoveredTimingEvidenceIds);
    return { ...action, evidenceIds, timing,
      ...(timing.kind === 'not_stated' && timingRecoveryIssues.length
        ? { _timingRecoveryIssues: timingRecoveryIssues } : {}) };
  });
}

// A condition can be extracted as a weak ownerless follow-up even though the
// transcript states it as the guard on a nearby review/approval action (for
// example, review something before it is paid).  Attach only compact conditional
// follow-ups to a single, named, review-shaped action in the same evidence window.
// Ambiguous matches and already-timed target actions are left untouched.
const CONDITION_RECEIVER_ACTION = /^(?:review|check|assess|approve|authorise|authorize|verify|validate|decide|determine|seek\b.*\bguidance)\b/i;
const WEAK_CONDITIONAL_FOLLOW_UP = /^(?:follow[- ]?up|check|confirm|clarify|resolve)\b/i;
function attachNearbyDependencyConditions(actions = [], units = []) {
  const list = (Array.isArray(actions) ? actions : []).map((action) => ({ ...action }));
  const context = evidenceContextFor(units);
  const removed = new Set();
  const indexesFor = (action) => (action.evidenceIds || [])
    .map((id) => context.indexById.get(id)).filter(Number.isInteger);
  const untimed = { kind: 'not_stated', wording: '', exactDate: '' };
  const workWithoutCondition = (action) => {
    const work = replaceEmbeddedTiming(action.action, action.timing?.wording, '', action.timing?.exactDate);
    // A shortened timing field may leave only its passive ending behind:
    // "before payment is made" minus "before payment" is not extra work.
    return work === action.action ? work
      : work.replace(/\s+\b(?:is|are|was|were|be|been)\s+(?:made|done|[a-z]+(?:ed|en))[.!?]*$/i, '.');
  };
  const sourceProvesAttachment = (orphan, target, orphanIndexes) => {
    const sources = orphanIndexes.map(index => context.rows[index]);
    if (!sources.length || sources.some(unit => !includedUnit(unit))) return false;
    // Mixed citations are not exclusive ownership proof. One matching quote
    // must not hide another speaker taking on the same apparent instruction.
    if (sources.some(unit => (OWNER_FIRST_PERSON.test(unit.text)
      || /\bwe\s+(?:will|shall|can|must)\b/i.test(unit.text))
        && !speakerIsOwner(unit.speaker, target.owners || [])
      || [...String(unit.text).matchAll(/\b([A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+){0,2})\s+(?:will|shall|must|can|is going to)\b/gu)]
        .some(match => !/^(?:I|We|They)$/i.test(match[1])
          && !speakerIsOwner(match[1], target.owners || [])))) return false;
    const dated = { ...target, timing: orphan.timing, evidenceIds: orphan.evidenceIds || [] };
    const sameWork = commitmentCanBeRepresented({ ...orphan, action: workWithoutCondition(orphan),
      owners: target.owners, timing: untimed }, { ...target, timing: untimed });
    // A valid timing for the receiver cannot justify deleting a different
    // instruction, even when both instructions have the same condition.
    const binding = TimingIntegrity.assessTimingSourceBinding(dated, units);
    if (sameWork && binding.status === 'supported'
      && binding.qualifiers.every(qualifier => comparisonText(orphan.timing?.wording).includes(comparisonText(qualifier)))
      && timingBoundToActionSteps(dated, units)) return true;

    // A short "yes, before we ... it" continuation can be extracted as a
    // spurious follow-up. Bind it to its immediately preceding owned work,
    // rather than pooling the nouns from an arbitrary neighbouring window.
    const fragment = /^(?:(?:yes|yeah|okay|ok|right|sure|just|only|ideally|probably|possibly|maybe)\b[\s,]*)*(before|after|once|until|when|if|unless)\b/i;
    const conditionWords = (value) => String(value || '').toLowerCase()
      .match(/[a-z0-9]+/g)?.filter(word => !new Set(['yes', 'yeah', 'okay', 'ok', 'right', 'sure',
        'just', 'we', 'i', 'it', 'that', 'this', 'them', 'those', 'these', 'the', 'a', 'an']).has(word))
      .map(word => word.replace(/ments?$/, '')) || [];
    const expected = conditionWords(orphan.timing?.wording).join('|');
    if (!expected || sources.some(unit => !fragment.test(unit.text)
      || conditionWords(unit.text).join('|') !== expected)) return false;
    const orphanWords = contentTokens(workWithoutCondition(orphan)).filter(word =>
      !['follow', 'follow-up', 'status', 'the', 'for', 'and', 'on', 'of'].includes(word));
    if (!sameWork && (!/^follow[- ]?up\b/i.test(orphan.action) || !orphanWords.length
      || orphanWords.some(word => !contentTokens(target.action).includes(word)))) return false;
    const first = Math.min(...orphanIndexes);
    let previous = first - 1;
    while (previous >= 0 && NON_SUBSTANTIVE_TIMING_BRIDGE.test(context.rows[previous].text)) previous -= 1;
    const antecedent = context.rows[previous];
    if (!antecedent || !includedUnit(antecedent) || !(target.evidenceIds || []).includes(antecedent.id)) return false;
    const assignment = String(antecedent.text).match(/^\s*(I|we|[A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+){0,2})\s+(?:will|shall|can|am going to|'ll)\s+(.+)$/iu);
    if (!assignment) return false;
    const ownerSupported = /^(?:I|we)$/i.test(assignment[1])
      ? speakerIsOwner(antecedent.speaker, target.owners || [])
      : (target.owners || []).some(owner => comparisonText(owner) === comparisonText(assignment[1]));
    return ownerSupported && commitmentCanBeRepresented({ ...target, action: assignment[2], timing: untimed },
      { ...target, timing: untimed });
  };
  list.forEach((orphan, orphanIndex) => {
    if (removed.has(orphanIndex) || isReviewerAuthored(orphan)
      || orphan?.timing?.kind !== 'dependency' || (orphan.owners || []).length
      || !WEAK_CONDITIONAL_FOLLOW_UP.test(text(orphan.action))) return;
    const orphanIndexes = indexesFor(orphan);
    if (!orphanIndexes.length) return;
    const conditionContext = evidenceWindowText(units, orphan.evidenceIds || [], 3);
    const candidates = list.map((action, index) => {
      if (index === orphanIndex || isReviewerAuthored(action) || !(action.owners || []).length
        || !CONDITION_RECEIVER_ACTION.test(text(action.action))
        || (action.timing?.kind && action.timing.kind !== 'not_stated')) return null;
      const targetIndexes = indexesFor(action);
      if (!targetIndexes.length) return null;
      const distance = Math.min(...orphanIndexes.flatMap((left) => targetIndexes.map((right) => Math.abs(left - right))));
      if (distance > 10) return null;
      const contextWords = new Set(materialTokens(conditionContext));
      const shared = materialTokens(action.action).filter((word) => contextWords.has(word)).length;
      if (shared < 2) return null;
      if (!sourceProvesAttachment(orphan, action, orphanIndexes)) return null;
      return { index, distance, shared };
    }).filter(Boolean).sort((left, right) => right.shared - left.shared || left.distance - right.distance);
    if (!candidates.length || (candidates[1] && candidates[0].shared === candidates[1].shared)) return;
    const target = list[candidates[0].index];
    list[candidates[0].index] = {
      ...target,
      timing: orphan.timing,
      evidenceIds: [...new Set([...(target.evidenceIds || []), ...(orphan.evidenceIds || [])])]
    };
    removed.add(orphanIndex);
  });
  return list.filter((_, index) => !removed.has(index));
}

// ---------------------------------------------------------------------------
// Correctness checks (MEETING_MINUTES_AGENT_CORRECTNESS_V1)
//
// Each check is deterministic and transcript-agnostic. They either correct a
// value the evidence contradicts (agent output only) or surface it to the
// reviewer as a flag; none invents content.
// ---------------------------------------------------------------------------
function correctnessChecksEnabled() {
  return /^(?:1|true|yes|on)$/i.test(String(process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1 || '0'));
}

// The timing-ownership rule is kept separate and off. It corrects the
// evaluation's example sentences, but on 131 timed actions from live meetings
// it produced no clearly correct change and several wrong ones.
function timingClauseChecksEnabled() {
  return /^(?:1|true|yes|on)$/i.test(String(process.env.MEETING_MINUTES_AGENT_TIMING_CLAUSE_V1 || '0'));
}

// Sentences and "and then"/"then" steps of the cited passage. Transcripts
// often lose the space after a full stop ("successfully.Across").
function evidenceClauses(value) {
  return String(value || '')
    .replace(/([.!?;])(?=[A-Za-z])/g, '$1 ')
    .split(/(?<=[.!?;])\s+/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 3);
}

const TIMING_TOKEN = /^(?:today|tonight|tomorrow|week|weeks|end|next|morning|afternoon|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday|month|day|days|hopefully|before|this)$/;

// A timing phrase belongs to the step it was spoken with. "Bottomed out by
// the end of the week ... the two code changes completed by the end of next
// week": the code-change action takes the second phrase, not the first. When
// the clause holding the action's timing barely mentions the action while
// another cited clause clearly describes it, the timing is reassigned to that
// clause's own phrase, or removed when that clause states none.
function timingClauseIssue(action, timing = {}, units = [], evidenceIds = []) {
  const wording = text(timing.wording, 220).toLowerCase().replace(/\s+/g, ' ');
  // Conditions ("once I get finished", "when Christina is back") are spoken in
  // their own clause by nature; only dates and deadlines are checked.
  if (!wording || !['deadline', 'target'].includes(timing.kind) || !evidenceIds.length) return null;
  const actionTokens = [...new Set(materialTokens(comparisonText(action)))]
    .filter((token) => !TIMING_TOKEN.test(token) && !NOVELTY_STOP_WORDS.has(token));
  if (actionTokens.length < 3) return null;
  const scored = evidenceClauses(evidenceWindowText(units, evidenceIds, 1)).map((clause) => {
    const words = new Set(contentTokens(comparisonText(clause)));
    return { clause, lower: clause.toLowerCase().replace(/\s+/g, ' '), score: actionTokens.filter((token) => words.has(token)).length };
  });
  const own = scored.filter((item) => item.lower.includes(wording));
  if (!own.length) return null;
  // "Should be able to get that done next week": the clause names the work
  // only by pronoun, so the sentences just before it are part of its subject.
  const ANAPHORA = /\b(?:that|this|it|those|them|these)\b/i;
  const ownScore = Math.max(...own.map((item) => {
    if (item.score > 0 || !ANAPHORA.test(item.clause)) return item.score;
    const at = scored.indexOf(item);
    const context = scored.slice(Math.max(0, at - 2), at + 1).map((entry) => entry.clause).join(' ');
    const words = new Set(contentTokens(comparisonText(context)));
    return actionTokens.filter((token) => words.has(token)).length;
  }));
  if (ownScore > 1) return null;
  const best = scored.filter((item) => !item.lower.includes(wording)).sort((left, right) => right.score - left.score)[0];
  if (!best || best.score < 2 || best.score <= ownScore) return null;
  const phrases = [...best.clause.matchAll(new RegExp(CITED_TIMING_PHRASE.source, 'gi'))]
    .map((match) => match[0].toLowerCase().replace(/\s+/g, ' '))
    .sort((left, right) => right.length - left.length);
  const replacement = phrases[0];
  // Only a clear reassignment is acted on: another cited clause states its
  // own timing and plainly describes this action. When that clause states no
  // timing, the original is left alone; on live meetings removal guessed wrong
  // more often than right ("get that done for Wednesday", "a call with Cody
  // this evening" were the action's own timing).
  if (replacement && replacement !== wording) return { type: 'reassign', from: timing.wording, to: replacement };
  return null;
}

const NOVELTY_STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'will', 'can', 'its', 'our', 'not', 'but', 'all', 'any', 'each', 'which',
  'what', 'when', 'where', 'who', 'whom', 'whose', 'than', 'then', 'them', 'these', 'those', 'some', 'such', 'very',
  'well', 'should', 'must', 'may', 'might', 'shall', 'has', 'had', 'did', 'does', 'done', 'upon', 'per', 'via',
  'within', 'without', 'across', 'between', 'through', 'during', 'before', 'under', 'above', 'below', 'further',
  'once', 'here', 'both', 'few', 'most', 'other', 'same', 'own', 'too', 'how', 'why', 'because', 'while', 'until',
  'against', 'among', 'onto', 'off', 'out', 'his', 'her', 'him', 'she', 'you', 'your', 'about', 'after', 'again',
  'also', 'been', 'being', 'could', 'from', 'have', 'into', 'just', 'more', 'only', 'over', 'said', 'that',
  'their', 'there', 'they', 'this', 'with', 'would',
  'next', 'last', 'week', 'month', 'update', 'plan', 'ensure', 'provide', 'confirm', 'confirmed', 'check',
  'discuss', 'discussed', 'decision', 'decided', 'status', 'ongoing', 'progres', 'point', 'item', 'noted', 'note',
  'issue', 'required', 'require', 'including', 'include', 'regarding', 'related', 'relation', 'current',
  'currently', 'additional', 'new', 'first', 'second', 'potential', 'possible', 'expected', 'appropriate',
  'relevant', 'specific', 'overall', 'key', 'main', 'agreed', 'agreement'
]);

function transcriptVocabulary(units = []) {
  const context = evidenceContextFor(units);
  if (!context.vocabulary) {
    context.vocabulary = new Set(context.rows.flatMap((unit) => contentTokens(comparisonText(`${unit.speaker} ${unit.text}`))));
  }
  return context.vocabulary;
}

// Share of a claim's distinctive words the meeting never used. A reviewer's
// sentence about relocating the factory to Mars borrows "team" and "agreed"
// from every meeting, so lexical scoring alone found it three citations; its
// distinctive words ("relocate", "Mars", "quarter") appear nowhere at all.
function claimNovelty(value, units = []) {
  const vocabulary = transcriptVocabulary(units);
  const tokens = [...new Set(materialTokens(comparisonText(value)))].filter((token) => !NOVELTY_STOP_WORDS.has(token));
  if (!tokens.length) return 0;
  return tokens.filter((token) => !vocabulary.has(token)).length / tokens.length;
}

// Applies only to text that arrived without citations of its own, which in
// practice is what a reviewer typed. Unsupported text gets no decorative
// citations; the missing-evidence flag then asks for it to be checked.
function uncitedClaimSupported(value, resolved = {}, units = []) {
  return claimNovelty(value, units) < 0.6 && Number(resolved.supportScore || 0) >= 0.3;
}

const COMMON_SPEECH_WORDS = new Set([
  'get', 'got', 'let', 'say', 'one', 'make', 'made', 'take', 'put', 'going', 'think', 'know', 'want', 'like',
  'yeah', 'yes', 'sure', 'okay', 'well', 'right', 'thing', 'things', 'bit', 'kind', 'sort', 'really',
  'actually', 'maybe', 'now', 'see', 'look', 'come', 'back', 'way', 'lot', 'time', 'good', 'fine', 'sorry',
  'hang', 'yep', 'probably', 'still', 'even', 'much', 'many', 'thank', 'thanks'
]);

const STRONG_REVISION_CUE = /(?:^|[.!?]\s*)(?:sorry\b|actually\b|correction\b|scratch that\b)|\b(?:(?:has|have|had)\s+(?:since\s+)?(?:slightly\s+)?changed|slightly\s+changed|since\s+changed|no\s+longer|i\s+was\s+wrong|i\s+got\s+that\s+wrong|not\s+any\s*more)\b/i;
const WEAK_REVISION_CUE = /^\s*but\b/i;
const PRESUMPTION_CUE = /\b(?:i\s+presumed|i\s+assumed|i\s+thought|we\s+thought|originally|initially|in\s+an\s+earlier\s+call|i\s+had\s+it\s+(?:as|that))\b/i;

// "I presumed the formative would be ready for submission ... But I think
// maybe that slightly changed": a record citing the first sentence states
// something its own speaker went on to revise. Surface the revision and cite
// it alongside; the reviewer decides which statement is current.
// The row cites both the assumption and its correction ("I presumed ... But I
// think maybe that slightly changed"): the model often fuses the two, so the
// reviewer is pointed at the correction. Strong correction wording only.
function citedRevisionUnit(units = [], evidenceIds = [], rowText = null) {
  const context = evidenceContextFor(units);
  const cited = [...new Set(evidenceIds)].map((id) => context.indexById.get(id)).filter(Number.isInteger).sort((a, b) => a - b);
  const rows = context.rows;
  const presumption = cited.find((index) => PRESUMPTION_CUE.test(String(rows[index]?.text || '')));
  if (presumption === undefined) return null;
  // Citations are sometimes enriched with lines from elsewhere in the meeting.
  // The row must be about what was presumed, or the correction is not its own.
  if (rowText !== null) {
    const presumed = aboutWords(rows[presumption]?.text || '');
    const shared = [...aboutWords(rowText)].filter((word) => presumed.has(word)).length;
    if (shared < 2) return null;
  }
  const correction = cited.find((index) => index > presumption && STRONG_REVISION_CUE.test(String(rows[index]?.text || '')));
  return correction === undefined ? null : rows[correction];
}

function laterRevisionUnit(units = [], evidenceIds = []) {
  const context = evidenceContextFor(units);
  const cited = new Set(evidenceIds);
  const indexes = evidenceIds.map((id) => context.indexById.get(id)).filter(Number.isInteger).sort((a, b) => a - b);
  for (const index of indexes) {
    const unit = context.rows[index];
    const unitTokens = [...new Set(materialTokens(comparisonText(unit.text)))]
      .filter((token) => !NOVELTY_STOP_WORDS.has(token) && !COMMON_SPEECH_WORDS.has(token));
    if (!unitTokens.length) continue;
    for (let next = index + 1; next <= index + 3 && next < context.rows.length; next += 1) {
      const later = context.rows[next];
      if (cited.has(later.id) || later.speaker !== unit.speaker) continue;
      const strong = STRONG_REVISION_CUE.test(later.text);
      const weak = WEAK_REVISION_CUE.test(later.text) && PRESUMPTION_CUE.test(unit.text);
      if (!strong && !weak) continue;
      const laterWords = new Set(contentTokens(comparisonText(later.text)));
      if (unitTokens.some((token) => laterWords.has(token))) return later;
    }
  }
  return null;
}

// Correct the published actions' timing in one pass and return a flag for each
// change, so nothing is altered without the reviewer seeing why.
function applyTimingClauseChecks(actions = [], units = [], options = {}) {
  const flags = [];
  const checked = (Array.isArray(actions) ? actions : []).map((action) => {
    if (isReviewerAuthored(action)) return action;
    const issue = timingClauseIssue(action.action, action.timing || {}, units, action.evidenceIds || []);
    if (!issue) return action;
    const timing = issue.type === 'reassign'
      ? timingFrom({ timing: { kind: action.timing.kind, wording: issue.to } }, options)
      : { kind: 'not_stated', wording: '', exactDate: '' };
    const flag = normaliseFlag({
      kind: 'timing',
      message: issue.type === 'reassign'
        ? `Timing changed from "${issue.from}" to "${issue.to}": the cited passage gives "${issue.from}" for a different step. Confirm the timing.`
        : `Timing "${issue.from}" removed: in the cited passage it belongs to a different step. Confirm whether this action has its own timing.`,
      evidenceIds: action.evidenceIds
    }, flags.length);
    flags.push(flag);
    const rejected = TimingIntegrity.rejectActionTiming(action, units, {
      meetingDate: options.meetingDate, field: 'all', reason: 'source_step_mismatch'
    });
    return { ...rejected, timing, reviewFlagIds: [...new Set([...(action.reviewFlagIds || []), flag.id])] };
  });
  return { actions: checked, flags };
}

// ---------------------------------------------------------------------------
// Timing check (MEETING_MINUTES_AGENT_TIMING_CHECK_V1)
//
// The model judges which step each timing was spoken for and must quote the
// passage word for word; the code verifies every quote before anything
// changes, and every change carries a flag showing the quote. Measured on
// 163 hand-labelled timings from six real meetings: 92% of changes correct,
// the remainder judgement calls; 59% of wrong timings corrected.
// ---------------------------------------------------------------------------
function timingCheckEnabled() {
  return /^(?:1|true|yes|on)$/i.test(String(process.env.MEETING_MINUTES_AGENT_TIMING_CHECK_V1 || '0'));
}

const TIMING_NO_VALUE = /^(?:not stated|not specified|unspecified|none|n\/a|na|tbc|tbd|unknown|no (?:date|deadline|timing))\.?$/i;
const TIMING_CHECK_STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'you', 'your', 'will', 'need',
  'next', 'first', 'week', 'before', 'after', 'any', 'all', 'can', 'get', 'have', 'was', 'are', 'from', 'into', 'our',
  'them', 'they', 'what', 'when', 'then', 'just', 'also', 'out', 'sort', 'anything', 'thing']);

function timingCheckWords(value) {
  return new Set((comparisonText(value).match(/[a-z0-9][a-z0-9-]{2,}/g) || []).filter((word) => !TIMING_CHECK_STOP_WORDS.has(word)));
}

function quoteText(value) {
  return String(value || '').toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
}

function quotedVerbatimValidation(quote, passage, maxWords = 120) {
  const needle = quoteText(quote);
  const words = needle ? needle.split(' ').length : 0;
  if (needle.length < 3) return { valid: false, reason: 'quote_too_short', words };
  if (words > maxWords) return { valid: false, reason: 'quote_too_long', words };
  const valid = quoteText(passage).includes(needle);
  return { valid, reason: valid ? '' : 'quote_not_found', words };
}

function quotedVerbatim(quote, passage) {
  return quotedVerbatimValidation(quote, passage).valid;
}

function dateWordingVariants(exactDate = '') {
  const match = String(exactDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return [];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const day = Number(match[3]);
  const suffix = day % 10 === 1 && day % 100 !== 11 ? 'st' : day % 10 === 2 && day % 100 !== 12 ? 'nd' : day % 10 === 3 && day % 100 !== 13 ? 'rd' : 'th';
  const month = months[Number(match[2]) - 1];
  if (!month) return [];
  return [
    `${day}${suffix} ${month}`,
    `${day}${suffix} of ${month}`,
    `${day} ${month}`,
    `${month} ${day}${suffix}`,
    `${month} ${day}`
  ];
}

function replaceEmbeddedTiming(actionText = '', previousTiming = '', replacementTiming = '', exactDate = '') {
  const source = String(actionText || '').trim();
  const previous = String(previousTiming || '').trim();
  if (!source || !previous) return source;
  const candidates = [...new Set([previous, ...dateWordingVariants(exactDate)])]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}'’])(?:\\b(?:by|on|before|after|during|in|within|from|until|no later than)\\s+)?(?:the\\s+)?(?:${candidates.join('|')})(?![\\p{L}\\p{N}'’])`, 'iu');
  if (!pattern.test(source)) return source;
  const replacement = String(replacementTiming || '').trim();
  let revised = source.replace(pattern, replacement);
  revised = revised
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/,\s*(and|then)\b/gi, ' $1')
    .replace(/\b(and|then)\s+(?:and|then)\b/gi, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^\s*[,;:]\s*/, '')
    .replace(/\s+([.?!])$/, '$1')
    .trim();
  return revised || source;
}

// One item per timed action: the action, its timing and the passage it cites.
function timingCheckItems(actions = [], units = [], options = {}) {
  return (Array.isArray(actions) ? actions : []).map((action, index) => {
    if (isReviewerAuthored(action) || !action?.timing || action.timing.kind === 'not_stated'
      || (!text(action.timing.wording, 220) && !action.timing.exactDate)) return null;
    if (TIMING_NO_VALUE.test(text(action.timing.wording, 220))) return null;
    const packet = boundedReviewEvidence(action, units, options);
    const passageUnits = packet.units;
    return {
      id: `a${index + 1}`, index, action: text(action.action, 1600), owners: action.owners || [],
      timing: { kind: text(action.timing.kind, 30), wording: text(action.timing.wording, 220), exactDate: text(action.timing.exactDate, 20) },
      timingDecision: action.timingDecision || null,
      evidenceIds: [...(action.evidenceIds || [])],
      meetingDate: options.meetingDate || '',
      contextCoverage: packet.coverage,
      passage: passageUnits.map((unit) => `[${unit.id}] ${unit.speaker}: ${unit.text}`).join('\n'),
      passageUnits: passageUnits.map((unit) => ({ id: unit.id, speaker: unit.speaker, text: unit.text }))
    };
  }).filter(Boolean);
}

function timingCheckPrompt(items = [], meetingDate = '') {
  return [
    'ACTION_CRITIC_TIMING',
    require('./meetingMinutesTimingInstructions'),
    "You check whether each action's timing belongs to that action. Each item gives an action, the timing attached to it, and the transcript passage it was drawn from. The passage is the only authority.",
    `The meeting took place on ${meetingDate || 'an unstated date'}. Do not calculate dates.`,
    'For each item decide one verdict:',
    `- "correct": the timing was said about this action's own work, with the same deadline/target/dependency meaning and qualifications. For a compound, quote the particular timed step in stepQuote; a date for one step must never be asserted as applying to every step.`,
    `- "qualified": a LATER statement about this same action changes an earlier firm date into a preference, target, contingency or fallback. Use this only when the passage explicitly connects the timings; merely mentioning another date is not enough.`,
    `- "belongs_to_other_step": the timing was said about a different piece of work: another step in a sequence, another person's task, a related meeting, an approval, a regulatory deadline or a schedule of other events.`,
    '- "past_event": the timing refers to something that has already happened.',
    '- "misread": the timing states a day or date the passage does not support as said (for example a wrong month, or an arrival time used as a meeting time).',
    `For every verdict give timingQuote: the exact words in the passage where the timing was said. For "belongs_to_other_step" also give stepQuote: the exact words naming the other piece of work the timing applies to (that work must not be one of the steps the action names). For any verdict other than "correct" give correctTiming: the exact words in the passage that give THIS action's own timing, or an empty string if the passage gives none.`,
    `For "qualified", also give qualificationQuote: the exact later words that explicitly qualify or replace the earlier timing; preferredTiming: the exact preferred/ideal timing words; and fallbackTiming: the exact contingency or hard-stop timing words, or empty when there is no separate fallback. Do not use "qualified" unless preferredTiming is present verbatim and every non-empty timing field is a contiguous transcript quote.`,
    'Check the complete timing object, including exactDate-only proposals. Do not calculate or invent an ISO date. A broad week, month, range, bound, preference or fallback must not become a single agreed day. The app verifies calendar derivation independently.',
    'For "correct", also quote timingQuote and stepQuote from the passage. Keep hedges such as probably, presumably, ideally and hopefully; they are meaningful qualifications, not firm deadlines. An unrelated later date is not a fallback.',
    'Never quote the timing object or another item as passage evidence. If the proposed timing is absent and no source-supported alternative exists, return uncertain with empty quotes rather than inventing a quote. Every quote must be copied verbatim from the passage as one contiguous span of at most 25 words. Never paraphrase a quote. If source-to-step binding is uncertain, return verdict "uncertain" rather than asserting "correct".',
    'Return only this JSON object: {"schemaVersion":1,"results":[{"id":"","verdict":"","timingQuote":"","stepQuote":"","correctTiming":"","qualificationQuote":"","preferredTiming":"","fallbackTiming":"","reason":""}]}',
    `ITEMS:\n${JSON.stringify(items.map((item) => ({ id: item.id, action: item.action, owners: item.owners, timing: item.timing, timingDecision: item.timingDecision, passage: item.passage })))}`
  ].join('\n\n');
}

// Apply verified verdicts. A quote-verified replacement is independently safe
// even when the critic copied the old timing imprecisely: retaining a timing
// the critic has identified as belonging elsewhere is the more dangerous
// failure in that case.
function timingItemSourceUnits(item = {}) {
  if (Array.isArray(item.passageUnits)) return item.passageUnits;
  return String(item.passage || '').split('\n').flatMap(line => {
    const found = line.match(/^\[([^\]]+)\]\s*([^:]+):\s*(.+)$/);
    return found ? [{ id: found[1], speaker: found[2], text: found[3] }] : [];
  });
}

function timingDecisionAfterChange(action, timing, item, options = {}, reason = 'source_timing_review') {
  const units = timingItemSourceUnits(item);
  const changed = TimingIntegrity.rejectActionTiming(action, units, {
    meetingDate: options.meetingDate || item.meetingDate, field: 'all', reason
  });
  const next = { ...changed, timing };
  if (timing?.kind && timing.kind !== 'not_stated') next.timingDecision = {
    ...changed.timingDecision,
    ...TimingIntegrity.timingAssessmentKey(next, units, options.meetingDate || item.meetingDate),
    status: reason === 'source_qualified_timing' ? 'qualified' : 'verified'
  };
  return next;
}

function correctTimingStepBound(action, item, row, options = {}) {
  if (options.verifiedBindingFor?.(action)?.status === 'supported') return true;
  if (actionPredicateSupported(action.action, row.stepQuote)
    && commitmentIsAboutAction(row.stepQuote, action.action)) return true;
  // A complete source turn can answer "when?" with "I'll do it Friday".
  // Accept that reference only when the independent source binder has already
  // proved this action/owner's timing on this very turn. Two real quotations
  // from different work, or a fragment hiding the rest of a turn, are not proof.
  const units = timingItemSourceUnits(item);
  const binding = TimingIntegrity.assessTimingSourceBinding(action, units, {
    meetingDate: options.meetingDate || item.meetingDate
  });
  if (binding.status !== 'supported') return false;
  const wording = quoteText(action.timing?.wording), timingQuote = quoteText(row.timingQuote);
  if (!wording || !timingQuote || !(wording.includes(timingQuote) || timingQuote.includes(wording))) return false;
  const fullTurn = value => quoteText(value).replace(/[.!?]+$/, '');
  return units.some(unit => binding.matchedSourceIds.includes(unit.id)
    && speakerIsOwner(unit.speaker, action.owners || [])
    && fullTurn(unit.text) === fullTurn(row.stepQuote)
    && quoteText(row.stepQuote).includes(timingQuote)
    && /^(?:i['’]ll|i will|i can|i['’]m going to|we['’]ll|we will|we can|we['’]re going to)\s+\p{L}+\s+(?:it|that|this|one|them|those|these|the lot)\b/iu.test(String(row.stepQuote).trim()));
}

function linkedQualificationTiming(action, item, row, preferred, fallback) {
  if (!row.stepQuote || !quotedVerbatim(row.stepQuote, item.passage)
    || sharedSubjectWords(row.stepQuote, action.action) < 2) return false;
  const units = normaliseSourceUnits(timingItemSourceUnits(item));
  const contains = (source, value) => quoteText(source).includes(quoteText(value));
  const dates = [...String(action.timing?.wording || '').matchAll(/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|\d{1,2}(?:st|nd|rd|th))\b/gi)].map(match => match[0]);
  const repeatsOldDate = value => dates.some(date => new RegExp(`\\b${date}\\b`, 'i').test(value));
  const temporalOnly = value => !String(value)
    .replace(/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|january|february|march|april|may|june|july|august|september|october|november|december|\d+(?:st|nd|rd|th)?)\b/gi, ' ')
    .replace(/\b(?:ideally|preferably|preferred|hopefully|probably|presumably|maybe|possibly|around|approximately|roughly|before|after|by|on|until|within|no|later|than|at|the|end|of|this|next|first|second|week|weeks|month|year|day|days|hard|stop|deadline|target|fallback|contingency|if|not|needed|necessary|possible|but|and|or|then|is|would|be|it|that|should|could|can|will|we|i|need|to|have|as|a|an|for|instead|think|thinking|might|worth|going|rather|do|does|up|just|in|case|about)\b/gi, ' ')
    .replace(/[^\p{L}]+/gu, '').trim();
  const switchesWork = unit => /\b(?:i|we|[A-Z][a-z]+)\s+(?:will|shall|must|to)\s+/i.test(unit.text)
    && contentTokens(unit.text).some(word => ACTION_VERBS.has(word))
    && sharedSubjectWords(unit.text, action.action) < 2;
  const differentAssignee = unit => [...String(unit.text).matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(?:will|shall|must|to)\s+\w+/g)]
    .some(match => !/^(?:I|We|They)$/.test(match[1]) && !(action.owners || [])
      .some(owner => nameParts(match[1]).every(part => nameParts(owner).includes(part))));
  return units.some((unit, index) => {
    if (!contains(unit.text, row.qualificationQuote) || !contains(row.qualificationQuote, preferred)
      || !repeatsOldDate(row.qualificationQuote)) return false;
    // A temporal prefix cannot hide a different instruction or assignee in
    // the remainder of the very same turn.
    if (switchesWork(unit) || differentAssignee(unit)
      || /\bi\s+(?:will|shall|am going to)\s+/i.test(unit.text)
        && contentTokens(unit.text).some(word => ACTION_VERBS.has(word))
        && !speakerIsOwner(unit.speaker, action.owners)) return false;
    const source = quoteText(unit.text), quote = quoteText(row.qualificationQuote);
    const prefix = source.slice(0, source.indexOf(quote));
    // An owner can explicitly name the preceding work by a shortened
    // reference: "For that report review, ideally Thursday ...". Require
    // its operation, a concrete shared subject, no new object/modifier, and
    // a wholly temporal remainder of the turn; a quoted prefix alone must
    // never hide another instruction later in the same turn.
    const referencedWork = prefix.match(/^\s*(?:for|regarding|as for)\s+(?:that|this|same)\s+(.+?)\s*[,;:]?\s*$/i);
    const actionWords = new Set(contentTokens(action.action));
    const ownWorkReference = Boolean(referencedWork && speakerIsOwner(unit.speaker, action.owners)
      && sharedSubjectWords(referencedWork[1], action.action) >= 1
      && actionPredicateSupported(action.action, referencedWork[1])
      && contentTokens(referencedWork[1]).every(word => actionWords.has(word) || ['the', 'same'].includes(word))
      && temporalOnly(source.slice(prefix.length)));
    if (!temporalOnly(prefix + quote) && !ownWorkReference) return false;
    const anchors = units.slice(Math.max(0, index - 3), index);
    const anchor = [...anchors].reverse().find(prior => sharedSubjectWords(prior.text, action.action) >= 2
      && repeatsOldDate(prior.text) && !differentAssignee(prior));
    if (!anchor || ownWorkReference && !speakerIsOwner(anchor.speaker, action.owners)
      || units.slice(units.indexOf(anchor) + 1, index).some(switchesWork)) return false;
    if (!fallback || contains(row.qualificationQuote, fallback)) return true;
    return units.slice(index + 1, index + 9).some((later, offset) =>
      later.speaker === unit.speaker && contains(later.text, fallback)
        && /\b(?:if not|otherwise|fallback|contingency|if need be)\b/i.test(later.text)
        && temporalOnly(later.text)
        && !units.slice(index + 1, index + 1 + offset).some(switchesWork));
  });
}

// Verbatim dates can occur beside unrelated work in the same review window.
// A qualification must either restate this owned instruction, or be a purely
// temporal follow-up by its owner which explicitly refers to its prior date.
function qualificationBindsTimingToAction(action, item, row, preferred, fallback, options = {}) {
  if (linkedQualificationTiming(action, item, row, preferred, fallback)) return true;
  const units = normaliseSourceUnits(timingItemSourceUnits(item));
  const contains = (source, quote) => quoteText(source).includes(quoteText(quote));
  const original = units.filter(unit => contains(unit.text, row.timingQuote)
    && timingBoundToActionSteps({ ...action, evidenceIds: [unit.id],
      timing: { kind: action.timing.kind, wording: row.timingQuote, exactDate: '' } }, [unit], options));
  if (!original.length) return false;
  // All replacement components must belong to the quoted clarification,
  // rather than being borrowed independently from elsewhere in the window.
  if (!contains(row.qualificationQuote, preferred)
    || fallback && !contains(row.qualificationQuote, fallback)) return false;
  const qualifiers = units.filter(unit => contains(unit.text, row.qualificationQuote));
  if (row.stepQuote && (!quotedVerbatim(row.stepQuote, item.passage)
    || !commitmentIsAboutAction(row.stepQuote, action.action))) return false;
  const referenceDates = [...String(row.timingQuote).matchAll(/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|yesterday|\d{1,4}(?:st|nd|rd|th)?|january|february|march|april|may|june|july|august|september|october|november|december)\b/gi)]
    .map(match => match[0].toLowerCase());
  return qualifiers.some(unit => {
    // A single speaker turn may contain two separate instructions. Do not
    // borrow the operation from before a comma and the date from another
    // instruction after it.
    if (String(unit.text).split(/[,;]|(?<=[.!?])\s+/).some(clause => contains(clause, preferred)
      && timingBoundToActionSteps({ ...action, evidenceIds: [unit.id],
        timing: { kind: 'target', wording: preferred, exactDate: '' } }, [{ ...unit, text: clause }], options))) return true;
    if (!speakerIsOwner(unit.speaker, action.owners)
      || !original.some(prior => units.indexOf(prior) < units.indexOf(unit)
        && speakerIsOwner(prior.speaker, action.owners)
        && !units.slice(units.indexOf(prior) + 1, units.indexOf(unit)).some(between =>
          speakerIsOwner(between.speaker, action.owners)
            && contentTokens(between.text).some(word => ACTION_VERBS.has(word))
            && !commitmentIsAboutAction(between.text, action.action)))) return false;
    if (row.stepQuote && (!quotedVerbatim(row.stepQuote, unit.text)
      || !commitmentIsAboutAction(row.stepQuote, action.action))) return false;
    if (!referenceDates.some(value => new RegExp(`\\b${value}\\b`, 'i').test(row.qualificationQuote))) return false;
    const remainder = String(unit.text)
      .replace(/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|yesterday|january|february|march|april|may|june|july|august|september|october|november|december|\d+(?:st|nd|rd|th)?)\b/gi, ' ')
      .replace(/\b(?:ideally|preferably|preferred|hopefully|probably|presumably|maybe|possibly|around|approximately|roughly|before|after|by|on|until|within|no|later|than|at|the|end|of|this|next|week|month|year|day|days|hard|stop|deadline|target|fallback|if|needed|necessary|possible|but|and|or|then|is|would|be|it|that|should|could|can|will|we|i|need|to|have|as|a|an|for|instead)\b/gi, ' ')
      .replace(/[^\p{L}]+/gu, '').trim();
    return !remainder;
  });
}

function replacementTimingSourceIds(action, item, replacement, options = {}) {
  const sources = normaliseSourceUnits(timingItemSourceUnits(item));
  const wanted = quoteText(replacement);
  const subject = new Set(materialTokens(action.action).filter(word => !ACTION_VERBS.has(word)));
  const clausesWithQualifications = value => String(value).split(/[,;]|(?<=[.!?])\s+/).reduce((clauses, clause) => {
    const qualification = clause.trim().replace(/[.!?]+$/, '');
    if (clauses.length && /^(?:hopefully|ideally|probably|presumably|possibly|if possible|if needed|all being well)$/i.test(qualification)) {
      clauses[clauses.length - 1] += `, ${qualification}`;
    } else if (clause.trim()) clauses.push(clause.trim());
    return clauses;
  }, []);
  return sources.filter(unit => clausesWithQualifications(unit.text).some(clause => {
    if (!quoteText(clause).includes(wanted)) return false;
    if (timingBoundToActionSteps({ ...action, evidenceIds: [unit.id],
      timing: { kind: 'target', wording: replacement, exactDate: '' } }, [{ ...unit, text: clause }], options)) return true;
    if (!speakerIsOwner(unit.speaker, action.owners)) return false;
    const words = new Set(materialTokens(clause));
    const shared = [...subject].filter(word => words.has(word)).length;
    const predicate = actionPredicateSupported(action.action, clause);
    if (subject.size && shared >= Math.min(2, subject.size) && shared / subject.size >= 0.6
      && (predicate || !contentTokens(clause).some(word => ACTION_VERBS.has(word)))) return true;
    // An already cited, owned "I'll send that now" can name its deliverable
    // by reference. An explicit different object is never such a reference.
    if (!(action.evidenceIds || []).includes(unit.id) || !predicate
      || !/\b(?:it|that|this|them|those|these)\b/i.test(clause)) return false;
    const withoutTiming = quoteText(clause).replace(wanted, ' ');
    return contentTokens(withoutTiming).every(word => ACTION_VERBS.has(word)
      || ['will', 'shall', 'can', 'should', 'going', 'out', 'then', 'them', 'those', 'these'].includes(word));
  })).map(unit => unit.id);
}

function sameTimingWork(left = {}, right = {}) {
  const owners = row => [...new Set((row.owners || []).map(owner => comparisonText(owner)))].sort().join('|');
  if (!owners(left) || owners(left) !== owners(right)) return false;
  const shared = new Set(left.evidenceIds || []);
  if (!(right.evidenceIds || []).some(id => shared.has(id))) return false;
  const wording = row => comparisonText(row.action).replace(/[.!;]+$/, '')
    .replace(/^(?:complete|finish)\s+(?:the\s+)?updates?\s+to\s+/, 'update ')
    .replace(/^(?:update|revise|amend|edit)\s+(?:the\s+)?/, 'update ');
  const a = wording(left), b = wording(right);
  if (a === b) return true;
  // Mutual retention is much narrower than related work. Do not use a
  // one-way contained step or overlapping transcript window to erase timing
  // for a different operation or a larger workflow.
  const untimed = row => ({ ...row, timing: { kind: 'not_stated', wording: '', exactDate: '' } });
  return commitmentCanBeRepresented(untimed(left), untimed(right))
    && commitmentCanBeRepresented(untimed(right), untimed(left));
}

function reconcileSiblingTimingDecisions(actions = [], units = [], options = {}) {
  const list = Array.isArray(actions) ? actions : [];
  const flags = [];
  const actionsAfter = list.map(action => {
    if (isReviewerAuthored(action)) return action;
    const wording = comparisonText(action.timing?.wording || '');
    const date = action.timing?.exactDate || '';
    const rejectedSibling = list.find(other => other !== action && !isReviewerAuthored(other)
      && TimingIntegrity.assessmentMatches(other, units, options.meetingDate, other.timingDecision)
      && sameTimingWork(action, other)
      // A shared context line is not the source of a rejected deadline. An
      // equivalent task may be restated with genuinely new timing evidence.
      && (other.timingDecision.sourceEvidenceIds || []).length > 0
      && other.timingDecision.sourceEvidenceIds.every(id => (action.evidenceIds || []).includes(id))
      && !timingBoundToActionSteps(action, units.filter(unit => (action.evidenceIds || []).includes(unit.id)
        && !other.timingDecision.sourceEvidenceIds.includes(unit.id)), options)
      && (date && (other.timingDecision.rejectedExactDates || []).includes(date)
        || wording && (other.timingDecision.rejectedWordings || []).some(value => comparisonText(value) === wording)));
    if (!rejectedSibling) return action;
    const rejectWording = wording && (rejectedSibling.timingDecision.rejectedWordings || [])
      .some(value => comparisonText(value) === wording);
    const next = TimingIntegrity.rejectActionTiming(action, units, {
      meetingDate: options.meetingDate, field: rejectWording ? 'all' : 'exactDate', reason: 'equivalent_work_source_rejection'
    });
    const flag = normaliseFlag({ kind: 'timing',
      message: `The timing for "${text(action.action, 200)}" conflicts with a source-reviewed equivalent instruction; the rejected ${rejectWording ? 'timing' : 'exact date'} is not repeated. Confirm the source timing.`,
      evidenceIds: [...new Set([...(action.evidenceIds || []), ...(rejectedSibling.evidenceIds || [])])] }, flags.length);
    flags.push(flag);
    next.reviewFlagIds = [...new Set([...(next.reviewFlagIds || []), flag.id])];
    return next;
  });
  return { actions: actionsAfter, flags };
}

function applySourceTimingCheckResults(actions = [], items = [], results = [], options = {}) {
  const flags = [];
  const rejected = [];
  const byIndex = new Map(items.map((item) => [item.index, item]));
  const verdicts = new Map((Array.isArray(results) ? results : []).map((row) => [text(row?.id, 20), row || {}]));
  const checked = (Array.isArray(actions) ? actions : []).map((action, index) => {
    if (isReviewerAuthored(action)) return action;
    const wording = text(action?.timing?.wording, 220);
    if (action?.timing && action.timing.kind !== 'not_stated' && TIMING_NO_VALUE.test(wording)) {
      return { ...action, timing: { kind: 'not_stated', wording: '', exactDate: '' } };
    }
    const item = byIndex.get(index);
    const row = item ? verdicts.get(item.id) : null;
    if (item && (text(action.action, 1600) !== item.action
      || JSON.stringify([...(action.owners || [])].sort()) !== JSON.stringify([...(item.owners || [])].sort())
      || typeof item.timing === 'object' && JSON.stringify(item.timing) !== JSON.stringify({
        kind: text(action.timing?.kind, 30), wording: text(action.timing?.wording, 220), exactDate: text(action.timing?.exactDate, 20)
      }))) {
      rejected.push({ id: item.id, reason: 'stale_action_snapshot' });
      return action;
    }
    if (row?.verdict === 'correct' && row.timingQuote && row.stepQuote
      && quotedVerbatim(row.timingQuote, item.passage) && quotedVerbatim(row.stepQuote, item.passage)
      && correctTimingStepBound(action, item, row, options)) {
      const assessed = TimingIntegrity.assessActionTiming(action, timingItemSourceUnits(item), {
        meetingDate: options.meetingDate || item.meetingDate, verifiedBindingFor: options.verifiedBindingFor
      });
      for (const issue of assessed.issues) {
        const flag = normaliseFlag({ kind: 'timing', message: issue.message,
          evidenceIds: action.evidenceIds || [] }, flags.length);
        flags.push(flag);
        assessed.action.reviewFlagIds = [...new Set([...(assessed.action.reviewFlagIds || []), flag.id])];
      }
      return assessed.action;
    }
    if (!row || !['qualified', 'belongs_to_other_step', 'past_event', 'misread'].includes(row.verdict)) return action;
    if (row.verdict === 'qualified') {
      const timingQuote = quotedVerbatimValidation(row.timingQuote, item.passage);
      const qualificationQuote = quotedVerbatimValidation(row.qualificationQuote, item.passage, 40);
      const preferred = text(row.preferredTiming, 120);
      const fallback = text(row.fallbackTiming, 120);
      const preferredValid = preferred && quotedVerbatim(preferred, item.passage)
        && hasTimingSignal(preferred);
      const fallbackValid = !fallback || (quotedVerbatim(fallback, item.passage)
        && hasTimingSignal(fallback) && quoteText(fallback) !== quoteText(preferred));
      // This pass is deliberately fail-closed. A model judgement alone cannot
      // soften a deadline: every component and the words connecting them must
      // be copied from the supplied passage.
      if (!timingQuote.valid || !qualificationQuote.valid || !preferredValid || !fallbackValid) {
        rejected.push({ id: item.id, verdict: row.verdict, reason: 'qualification_not_verbatim_or_complete' });
        return action;
      }
      if (!qualificationBindsTimingToAction(action, item, row, preferred, fallback, options)) {
        rejected.push({ id: item.id, verdict: row.verdict, reason: 'qualification_not_bound_to_action' });
        return action;
      }
      const qualifiedWording = fallback
        ? `Preferred: ${preferred}; fallback: ${fallback}`
        : preferred;
      const timing = { kind: 'target', wording: qualifiedWording, exactDate: '' };
      if (timingPublicationIssue(timing)) {
        rejected.push({ id: item.id, verdict: row.verdict, reason: 'qualified_timing_not_publishable' });
        return action;
      }
      const quoteNeedles = [row.qualificationQuote, preferred, fallback].filter(Boolean).map(quoteText);
      const addedEvidence = (item.passageUnits || []).filter((unit) => {
        const value = quoteText(unit.text);
        return quoteNeedles.some((needle) => value.includes(needle) || needle.includes(value));
      }).map((unit) => unit.id);
      return {
        ...timingDecisionAfterChange({ ...action, action: replaceEmbeddedTiming(action.action, wording, '', action.timing?.exactDate) }, timing, item, options, 'source_qualified_timing'),
        evidenceIds: [...new Set([...(action.evidenceIds || []), ...addedEvidence])].slice(0, 12)
      };
    }
    const replacement = text(row.correctTiming, 120);
    // Verbatim is necessary, not sufficient: "I'll draft that." is in the
    // passage word for word and is not a timing. A replacement must pass the
    // same shape check as any published timing.
    const replacementIsVerbatim = replacement && quotedVerbatim(replacement, item.passage)
      && quoteText(replacement) !== quoteText(wording)
      && !timingPublicationIssue(timingFrom({ timing: { wording: replacement } }, options));
    const replacementSourceIds = replacementIsVerbatim ? replacementTimingSourceIds(action, item, replacement, options) : [];
    if (replacementIsVerbatim && !replacementSourceIds.length) {
      rejected.push({ id: item.id, verdict: row.verdict, reason: 'replacement_not_bound_to_action' });
      return action;
    }
    const timingQuoteCheck = quotedVerbatimValidation(row.timingQuote, item.passage);
    if (!timingQuoteCheck.valid && !replacementIsVerbatim) {
      rejected.push({ id: item.id, verdict: row.verdict, reason: `timing_${timingQuoteCheck.reason}` });
      return action;
    }
    // "Misread" means the passage does not say it. If the timing's own words
    // are right there, the verdict contradicts the transcript.
    if (row.verdict === 'misread' && quotedVerbatim(wording, item.passage) && !replacementIsVerbatim) {
      // The wording can be verbatim while the separate ISO field invents
      // precision (for example one occurrence of recurring work). Only accept
      // that narrower correction when the independent source check proves it;
      // the critic cannot use this branch to erase supported source wording.
      if (action.timing?.exactDate) {
        const assessment = TimingIntegrity.assessActionTiming(action, timingItemSourceUnits(item), {
          meetingDate: options.meetingDate || item.meetingDate
        });
        const invalidDate = assessment.issues.filter(issue => !issue.preserveValue);
        if (invalidDate.length && invalidDate.every(issue => issue.field === 'exactDate')
          && assessment.action.timing.wording === wording && !assessment.action.timing.exactDate) {
          const flag = normaliseFlag({ kind: 'timing',
            message: `The exact date ${action.timing.exactDate} was removed because it is not established by the source timing "${wording}". The source wording is retained.`,
            evidenceIds: action.evidenceIds || [] }, flags.length);
          flags.push(flag);
          return { ...assessment.action, reviewFlagIds: [...new Set([...(action.reviewFlagIds || []), flag.id])] };
        }
      }
      rejected.push({ id: item.id, verdict: row.verdict, reason: 'timing_is_verbatim_in_passage' });
      return action;
    }
    if (row.verdict === 'belongs_to_other_step') {
      const stepQuoteCheck = quotedVerbatimValidation(row.stepQuote, item.passage);
      if (!stepQuoteCheck.valid) {
        rejected.push({ id: item.id, verdict: row.verdict, reason: `step_${stepQuoteCheck.reason}` });
        return action;
      }
      const actionWords = timingCheckWords(action.action);
      const timingWords = timingCheckWords(row.timingQuote);
      const shared = [...timingCheckWords(row.stepQuote)]
        .filter((word) => !timingWords.has(word) && actionWords.has(word)).length;
      // The "other step" must not be a step the action itself names.
      if (shared >= 2) {
        rejected.push({ id: item.id, verdict: row.verdict, reason: 'other_step_is_named_by_action' });
        return action;
      }
    }
    // A source-bound hedge changes certainty even when the underlying period
    // is unchanged. Preserve it without borrowing the critic's other step.
    const sameTiming = (left, right) => quoteText(left).replace(/\b(?:hopefully|ideally|roughly|about|approximately|around|maybe|possibly)\b/g, '')
      .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
      === quoteText(right).replace(/\b(?:hopefully|ideally|roughly|about|approximately|around|maybe|possibly)\b/g, '')
        .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (replacement && sameTiming(replacement, wording)) {
      if (!replacementIsVerbatim || quoteText(replacement) === quoteText(wording)) return action;
      const hedges = value => quoteText(value).match(/\b(?:hopefully|ideally|roughly|about|approximately|around|maybe|possibly)\b/g) || [];
      if (hedges(wording).some(hedge => !hedges(replacement).includes(hedge))) {
        rejected.push({ id: item.id, verdict: row.verdict, reason: 'replacement_removes_timing_qualification' });
        return action;
      }
      const timing = { ...timingFrom({ timing: { wording: replacement } }, options), kind: 'target' };
      return { ...timingDecisionAfterChange({ ...action,
        action: replaceEmbeddedTiming(action.action, wording, replacement, action.timing?.exactDate),
        evidenceIds: [...new Set([...(action.evidenceIds || []), ...replacementSourceIds])].slice(0, 12) },
      timing, item, options, 'source_qualified_timing') };
    }
    const usable = replacementIsVerbatim;
    const timing = usable ? timingFrom({ timing: { wording: replacement } }, options) : { kind: 'not_stated', wording: '', exactDate: '' };
    const actionText = replaceEmbeddedTiming(action.action, wording, usable ? replacement : '', action.timing?.exactDate);
    const said = !timingQuoteCheck.valid
      ? 'the replacement is directly supported by the cited passage'
      : row.verdict === 'belongs_to_other_step'
        ? `in the transcript it was said about "${text(row.stepQuote, 160)}"`
        : row.verdict === 'past_event'
        ? `it refers to something that has already happened ("${text(row.timingQuote, 160)}")`
        : `the transcript does not say this ("${text(row.timingQuote, 160)}")`;
    const message = usable
      ? `Timing changed from "${wording}" to "${replacement}": ${said}. Confirm the timing.`
      : `Timing "${wording}" removed: ${said}. Confirm whether this action has its own timing.`;
    const flag = normaliseFlag(actionTimingIssueFlag({ code: usable ? 'timing_value_changed' : 'timing_value_removed' }, action, message), flags.length);
    flags.push(flag);
    return { ...timingDecisionAfterChange({ ...action, action: actionText,
      evidenceIds: [...new Set([...(action.evidenceIds || []), ...replacementSourceIds])].slice(0, 12) }, timing, item, options),
      reviewFlagIds: [...new Set([...(action.reviewFlagIds || []), flag.id])] };
  });
  return { actions: checked, flags, rejected };
}

function applyTimingCheckResults(actions = [], items = [], results = [], options = {}) {
  const indexed = indexReviewResults(items, results,
    ['correct', 'qualified', 'belongs_to_other_step', 'past_event', 'misread', 'uncertain']);
  const accepted = [];
  for (const item of items) {
    const row = indexed.byId.get(item.id);
    if (!row) continue;
    let reason = '';
    const quote = key => typeof row[key] === 'string'
      && quotedVerbatimValidation(row[key], item.passage, key === 'qualificationQuote' ? 40 : 25).valid;
    if (item.contextCoverage?.omittedAnchorIds?.length) reason = 'context_omitted_required_anchor';
    else if (['timingQuote', 'stepQuote', 'correctTiming', 'qualificationQuote', 'preferredTiming', 'fallbackTiming', 'reason']
      .some(key => row[key] !== undefined && typeof row[key] !== 'string')) reason = 'malformed_timing_result';
    else if (row.verdict === 'uncertain') {
      indexed.states.set(item.id, { id: item.id, status: 'uncertain', reason: text(row.reason, 300) || 'checker_uncertain' });
      continue;
    } else if (row.verdict === 'correct' && (!quote('timingQuote') || !quote('stepQuote'))) reason = 'correct_quotes_not_verbatim_or_complete';
    else if (row.verdict === 'correct' && !correctTimingStepBound({ action: item.action,
      owners: item.owners, evidenceIds: item.evidenceIds, timing: item.timing }, item, row, options)) reason = 'correct_step_not_bound_to_action';
    else if (row.verdict === 'qualified' && (!quote('timingQuote') || !quote('qualificationQuote')
      || !quote('preferredTiming') || row.fallbackTiming && !quote('fallbackTiming'))) reason = 'qualification_not_verbatim_or_complete';
    else if (!['correct', 'qualified'].includes(row.verdict)
      && (!quote('timingQuote') && !quote('correctTiming')
        || row.verdict === 'belongs_to_other_step' && !quote('stepQuote'))) reason = 'timing_quotes_not_verbatim_or_complete';
    if (reason) indexed.states.set(item.id, { id: item.id, status: 'rejected', reason });
    else accepted.push(row);
  }
  const applied = applySourceTimingCheckResults(actions, items, accepted, options);
  for (const rejected of applied.rejected) indexed.states.set(rejected.id, { ...rejected, status: rejected.reason === 'stale_action_snapshot' ? 'stale' : 'rejected' });
  const flags = [...applied.flags];
  const checked = applied.actions.map((action, index) => {
    const item = items.find(value => value.index === index);
    if (!item || isReviewerAuthored(action)) return action;
    let state = indexed.states.get(item.id);
    if (state.status === 'stale') return action;
    if (state.status === 'pending' && indexed.byId.get(item.id)?.verdict === 'correct'
      && action.timingDecision?.status === 'unresolved') {
      state = { id: item.id, status: 'uncertain', reason: 'source_timing_binding_unresolved' };
      indexed.states.set(item.id, state);
    }
    if (state.status === 'pending') {
      state = { id: item.id, status: JSON.stringify(action.timing) === JSON.stringify(item.timing) ? 'supported' : 'corrected', reason: '' };
      indexed.states.set(item.id, state);
      return action;
    }
    if (['supported', 'corrected'].includes(state.status)) return action;
    // A failed/incomplete checker must not certify a timing by omission. Keep
    // the work, use the independent source check, and expose the unresolved
    // review instead of silently treating it as a successful verdict.
    const sourceUnits = timingItemSourceUnits(item);
    const assessment = TimingIntegrity.assessActionTiming(action, sourceUnits, { meetingDate: options.meetingDate || item.meetingDate });
    let next = assessment.action;
    const binding = typeof TimingIntegrity.assessTimingSourceBinding === 'function'
      ? TimingIntegrity.assessTimingSourceBinding(action, sourceUnits, { meetingDate: options.meetingDate || item.meetingDate }) : null;
    if (binding?.status === 'unsupported' && next.timing?.kind !== 'not_stated') {
      next = TimingIntegrity.rejectActionTiming(next, sourceUnits, { meetingDate: options.meetingDate || item.meetingDate,
        field: 'all', reason: binding.reason || 'unsupported_timing_binding' });
    }
    const removed = binding?.status === 'unsupported' && action.timing?.wording && !next.timing?.wording
      && (next.timingDecision?.rejectedWordings || []).includes(action.timing.wording);
    const message = removed
      ? `Timing "${text(action.timing.wording, 220)}" was removed because its source binding does not support this work and owner. The work is retained; confirm its own timing against the source.`
      : `Cannot verify the timing for "${text(action.action, 200)}": ${text(state.reason, 180).replace(/_/g, ' ')}. The work is retained; confirm its timing against the source.`;
    const flag = normaliseFlag({ ...actionTimingIssueFlag({ code: removed ? 'timing_value_removed' : 'timing_check_unresolved' }, action, message),
      evidenceIds: [...new Set([...(action.evidenceIds || []), ...(binding?.sourceEvidenceIds || [])])] }, flags.length);
    flags.push(flag);
    next = { ...next, reviewFlagIds: [...new Set([...(next.reviewFlagIds || []), flag.id])],
      timingDecision: { ...(next.timingDecision || {}),
        status: next.timingDecision?.status === 'rejected' ? 'rejected' : 'unresolved',
        checkerStatus: state.status, checkerReason: state.reason } };
    if (binding?.status === 'unsupported' && action.timing?.wording) next.action = replaceEmbeddedTiming(action.action, action.timing.wording, '', action.timing.exactDate);
    return next;
  });
  return { actions: checked, flags, rejected: [...applied.rejected,
    ...[...indexed.states.values()].filter(state => !['pending', 'supported', 'corrected', 'stale'].includes(state.status))],
    accounting: finishReviewAccounting(indexed) };
}

// ---- Commitment check -----------------------------------------------------
// Model-extracted actions that the keyword reading vetoed get one second look.
// An action comes back only when the model quotes the words where someone
// commits to it, is assigned it or agrees to it, and the quote is in the
// passage. Owners the model cannot tie to those words are removed.
function isMeetingAdminAction(value = '') {
  return ACTION_ADMIN_PATTERN.test(String(value || '')) || isLiveCallConduct(value);
}

function commitmentCheckEnabled() {
  return /^(?:1|true|yes|on)$/i.test(String(process.env.MEETING_MINUTES_AGENT_COMMITMENT_CHECK_V1 || '0'));
}

function commitmentCheckItems(actions = [], units = []) {
  return (Array.isArray(actions) ? actions : []).slice(0, 24).map((action, index) => {
    // The words that hand work over come AFTER the description of it: run 10's
    // clinical review cited only T0036, so the passage stopped at T0038 and the
    // line that assigns it - "So Janine, and I think Adil, you're involved in
    // that as well next week" - was never shown to the model, which then
    // answered not_commitment about a sentence this prompt uses as its own
    // example. The window runs further forward than back for that reason.
    const passage = evidenceWindowUnits(units, action?.evidenceIds || [], 2, 6).slice(0, 24).map((unit) => `${unit.speaker}: ${unit.text}`);
    if (!passage.length || !text(action?.action)) return null;
    return { id: `c${index + 1}`, index, action: text(action.action, 600), owners: action.owners || [], passage: passage.join('\n') };
  }).filter(Boolean);
}

function commitmentCheckPrompt(items = []) {
  return [
    'ACTION_CRITIC_COMMITMENT',
    'Each item is a possible action from a meeting, with the transcript passage it came from. The passage is the only authority.',
    'Decide whether, in the passage, someone committed to this work, was assigned it, or agreed to do it, as work still to be done after the meeting.',
    `- "commitment": yes. Examples: "I'm gonna focus on TFO3 this week", "Janine and Adil, you're involved in that next week", "leave that with me", "can you send it over? Yes, will do".`,
    '- "not_commitment": a suggestion or idea nobody took on, a status update, work already done, a description of how something works, a question, meeting housekeeping such as taking these minutes, something done during this meeting itself (for example sharing a screen or playing a sound now), or something an outside organisation will do.',
    'For "commitment" give commitmentQuote: the exact words where the person commits, is assigned or agrees, copied verbatim as one contiguous span of at most 25 words (it may run across adjacent lines; leave out speaker names). Also give ownerSupported: true if the passage ties the listed owners to the work, false otherwise.',
    'Never paraphrase a quote. If you are unsure, choose "not_commitment".',
    'Return only this JSON object: {"schemaVersion":1,"results":[{"id":"","verdict":"","commitmentQuote":"","ownerSupported":true,"reason":""}]}',
    `ITEMS:\n${JSON.stringify(items.map((item) => ({ id: item.id, action: item.action, owners: item.owners, passage: item.passage })))}`
  ].join('\n\n');
}

// The verified words tie the work to an owner when they name the owner
// ("Janine, and I think Adil, you're involved") or are the owner committing in
// the first person ("I'm gonna focus on TFO3").
const FIRST_PERSON_COMMITMENT = /\b(?:i|we)(?:'ll| will| shall| can| am going to|'m going to|'m gonna| am gonna|'re going to| are going to)\b|\bleave (?:it|that|this) with me\b|\bwill do\b|\bi'll\b|\bokay\b|\byes\b|\bsure\b/i;
function commitmentQuoteTiesOwner(quote = '', owners = [], passage = '') {
  const said = quoteText(quote);
  const names = (Array.isArray(owners) ? owners : []).map((owner) => String(owner || '').trim()).filter(Boolean);
  if (!names.length) return false;
  const firstNames = names.map((owner) => owner.split(/\s+/)[0].toLowerCase());
  const lines = String(passage || '').split('\n');
  // The line(s) carrying the quote: a quote may run across adjacent lines.
  const inLine = (index) => index >= 0 && index < lines.length
    && (decisionQuoteFound(quote, lines[index]) || quoteText(lines[index]).includes(said.slice(0, 40)));
  // A line carries the quote when the quote is in it, or starts in it and runs
  // into the next line (but not when it sits wholly in the next line).
  const carryingIndexes = lines.map((line, index) => (inLine(index)
    || (!inLine(index + 1) && decisionQuoteFound(quote, `${line}\n${lines[index + 1] || ''}`)) ? index : -1))
    .filter((index) => index >= 0);
  const carrying = carryingIndexes.map((index) => lines[index]);
  const spoken = (line) => quoteText(String(line || '').slice(String(line || '').indexOf(':') + 1));
  // "he's just looking into that" refers back to "there's Andrew who ..." a
  // few lines earlier, so the owner may be named up to three lines before.
  const nearby = [...new Set(carryingIndexes.flatMap((index) => [index - 3, index - 2, index - 1, index]).filter((index) => index >= 0))].map((index) => lines[index]);
  if (firstNames.some((name) => said.includes(name) || nearby.some((line) => new RegExp(`\\b${name}\\b`).test(spoken(line))))) return true;
  const speakers = carrying.map((line) => line.split(':')[0].trim().toLowerCase());
  const ownerSpoke = speakers.some((speaker) => names.some((owner) => speaker === owner.toLowerCase() || speaker.split(/\s+/)[0] === owner.toLowerCase().split(/\s+/)[0]));
  return ownerSpoke && FIRST_PERSON_COMMITMENT.test(quote);
}

const ABOUT_STOP = new Set(['with', 'that', 'this', 'then', 'from', 'into', 'their', 'about', 'will', 'have', 'been', 'just', 'kind', 'look', 'make', 'sure', 'what', 'when', 'where', 'which', 'also', 'there', 'they', 'your', 'need', 'needs', 'able', 'going', 'gonna', 'okay', 'yeah', 'week', 'next']);
function aboutWords(value) {
  return new Set((String(value || '').toLowerCase().match(/[a-z0-9][a-z0-9'-]{3,}/g) || [])
    .filter((word) => !ABOUT_STOP.has(word))
    .map((word) => word.replace(/'s$/, '').replace(/(?:ing|ed|es|s)$/, '').replace(/e$/, ''))
    .filter((word) => word.length >= 4));
}
function commitmentQuoteAboutAction(quote = '', action = '', passage = '') {
  const lines = String(passage || '').split('\n');
  const said = quoteText(quote);
  const carrying = lines.filter((line) => decisionQuoteFound(quote, line) || quoteText(line).includes(said.slice(0, 40)));
  const source = aboutWords([quote, ...carrying].join(' '));
  const target = aboutWords(action);
  let shared = 0;
  for (const word of target) if (source.has(word)) shared += 1;
  return shared >= 2;
}

function applyCommitmentCheckResults(actions = [], items = [], results = [], options = {}) {
  const verdicts = new Map((Array.isArray(results) ? results : []).map((row) => [text(row?.id, 20), row || {}]));
  const rescued = [];
  for (const item of items) {
    const row = verdicts.get(item.id);
    if (!row || row.verdict !== 'commitment' || !decisionQuoteFound(row.commitmentQuote, item.passage)) continue;
    const action = actions[item.index];
    if (options.requireOwnerTie && !commitmentQuoteTiesOwner(row.commitmentQuote, action.owners, item.passage)) continue;
    // The quoted commitment must be about this work: "I'll update that table
    // for the new set of minutes" does not commit anyone to a cybersecurity
    // update. Checked on the quote's line(s), which carry the subject.
    if (options.requireOwnerTie && !commitmentQuoteAboutAction(row.commitmentQuote, action.action, item.passage)) continue;
    // This check establishes a commitment only. It cannot resolve independent
    // field/source warnings or an unknown linked concern. Keep those decisions
    // for their own checker/reviewer and do not alias the caller's flag list.
    rescued.push({ ...action, owners: row.ownerSupported === false ? [] : (action.owners || []),
      reviewFlagIds: Array.isArray(action.reviewFlagIds) ? [...action.reviewFlagIds] : [] });
  }
  return rescued;
}

// Every action that survives the extraction and recovery branches gets one
// final lifecycle decision. This is deliberately conservative: an action is
// withheld only when the model both classifies it as non-outstanding work and
// supplies an exact transcript quote proving that classification. Missing or
// unverifiable results leave the action untouched.
function finalActionLifecycleCheckItems(actions = [], units = []) {
  const context = evidenceContextFor(units);
  const sourceIndexByUnit = new Map(context.rows.map((unit, index) => [unit, index]));
  const rowsById = new Map(context.rows.map((unit) => [String(unit.id), unit]));
  return (Array.isArray(actions) ? actions : []).map((action, index) => {
    const actionWords = new Set(actionSubjectWords(action?.action || ''));
    const owners = (action?.owners || []).map((owner) => String(owner).toLowerCase());
    const rankedIds = [...new Set(action?.evidenceIds || [])].sort((left, right) => {
      const score = (id) => {
        const unit = rowsById.get(String(id));
        if (!unit) return -1;
        const shared = contentTokens(unit.text).filter((word) => actionWords.has(word)).length;
        const owner = owners.some((name) => name === String(unit.speaker || '').toLowerCase()) ? 3 : 0;
        const commitment = /\b(?:i['’]?ll|i\s+will|i['’]?m\s+going\s+to|will\s+(?:prepare|produce|write|build|send|share|review|trace|split)|responsible\s+for|assigned)\b/i.test(unit.text || '') ? 4 : 0;
        return shared * 2 + owner + commitment;
      };
      return score(right) - score(left);
    }).slice(0, 6);
    const seen = new Set();
    const passageUnits = rankedIds.flatMap((id) => evidenceWindowUnits(units, [id], 2, 5))
      .filter((unit) => !seen.has(unit.id) && seen.add(unit.id)).slice(0, 40)
      // Keep relevance selection and its limit, then restore dialogue order so
      // later answers, corrections and completions follow the turns they qualify.
      .sort((left, right) => sourceIndexByUnit.get(left) - sourceIndexByUnit.get(right));
    const passage = passageUnits
      .map((unit) => `${unit.speaker}: ${unit.text}`).join('\n');
    if (!passage || !text(action?.action)) return null;
    return { id: `life${index + 1}`, index, action: text(action.action, 600), owners: action.owners || [], passage };
  }).filter(Boolean);
}

function finalActionLifecycleCheckPrompt(items = []) {
  return [
    'ACTION_CRITIC_FINAL_LIFECYCLE',
    'Each item is an Action that would otherwise be published in final meeting minutes. The transcript passage is the only authority.',
    'The Action wording is an untrusted claim to verify, not evidence. Never infer that work remains merely because the Action names a document, written output, recipient or follow-up which the passage does not establish.',
    'Decide whether it is genuine work still outstanding after the meeting.',
    '- "outstanding": someone committed to it, accepted it, or was assigned it as work to be done after the meeting.',
    '- "not_outstanding": it is only a question, discussion, suggestion nobody accepted, status update, description of normal practice, work already completed before or during the meeting, meeting housekeeping, or work belonging only to an outside organisation.',
    'Explicit wording that matching work is still to be done, remains outstanding, is continuing, or was deferred to a future time always means some work remains.',
    'Do not reject an Action merely because its owner or date is unclear. If any genuine follow-up remains, or if you are unsure, choose "outstanding".',
    'For "not_outstanding", provide evidenceQuote: exact contiguous words from the passage that prove why no work remains. Quote the completion, answer, status, or lack-of-acceptance context—not merely the original request. Never paraphrase.',
    'Return only this JSON object: {"schemaVersion":1,"results":[{"id":"","verdict":"outstanding|not_outstanding","evidenceQuote":"","reason":""}]}',
    `ITEMS:\n${JSON.stringify(items.map((item) => ({ id: item.id, action: item.action, owners: item.owners, passage: item.passage })))}`
  ].join('\n\n');
}

const EXPLICIT_OUTSTANDING_LIFECYCLE = /\b(?:still (?:needs? to be done|to be done|needs? (?:doing|reviewing|updating|completing)|outstanding|pending)|remain(?:s|ed|ing)? (?:to be done|outstanding|open|pending)|(?:has|have) (?:not yet|yet to)|not yet (?:done|complete|completed|reviewed|sent|shared|updated)|(?:(?:has|have|had|was|were) (?:been )?)?(?:pushed (?:out|back)|postponed|deferred) (?:until|to)|continue(?:s|d|ing)? (?:to |with )?(?:review|reviewing|update|updating|test|testing|complete|completing|prepare|preparing|develop|developing|document|documenting|resolve|resolving|progress|progressing)|work in progress|in progress)\b/i;

// "I'll get that over to you today" is work that has not happened yet, however
// confidently a lifecycle verdict reads the surrounding lines as done. A
// first-person future commitment with a time or trigger for it counts as
// explicit outstanding wording, under the same two-subject-word scope.
const FIRST_PERSON_FUTURE_COMMITMENT = /\b(?:i'll|i’ll|i will|i'm going to|i’m going to|i am going to|i'm gonna|let me|i can)\b/i;
const FUTURE_MARKER = /\b(?:today|tonight|tomorrow|this (?:morning|afternoon|evening|week)|next (?:week|month)|by (?:monday|tuesday|wednesday|thursday|friday|the end|end of|close of)|before|after|once|when|as soon as|later|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

function itemHasExplicitOutstandingEvidence(item = {}) {
  const subject = aboutWords(item.action || '');
  if (!subject.size) return false;
  const clauses = String(item.passage || '').split(/\n|(?<=[.!?;])\s+/).map((value) => value.trim()).filter(Boolean);
  return clauses.some((clause) => {
    const outstanding = EXPLICIT_OUTSTANDING_LIFECYCLE.test(clause)
      || (FIRST_PERSON_FUTURE_COMMITMENT.test(clause) && FUTURE_MARKER.test(clause));
    if (!outstanding) return false;
    const shared = [...aboutWords(clause)].filter((word) => subject.has(word)).length;
    return shared >= 2;
  });
}

const PROMISE_QUOTE = /\b(?:i['’]ll|i\s+will|i['’]m\s+going\s+to|i\s+am\s+going\s+to|i['’]m\s+gonna|let\s+me|i\s+can)\b/i;
const COMPLETION_QUOTE = /\b(?:done|sent|finished|completed|already|just\s+(?:did|sent|done|booked|added|put)|have\s+(?:sent|done|booked|added|put)|i['’]ve|it['’]s\s+in|that['’]s\s+(?:in|done|sent|booked))\b/i;
const HABITUAL_PROMISE = /\bi(?:['’]ll\s+(?:always|usually|normally|routinely|generally)|\s+(?:will\s+(?:always|usually|normally|routinely|generally)|(?:always|usually|normally|routinely|generally)\s+will))\b/i;
function isHabitualPromise(value = '') {
  return HABITUAL_PROMISE.test(String(value)) && !FUTURE_MARKER.test(String(value));
}
function quoteIsOnlyAPromise(quote = '') {
  const value = String(quote || '');
  return PROMISE_QUOTE.test(value) && !COMPLETION_QUOTE.test(value) && !isHabitualPromise(value);
}

function applyFinalActionLifecycleResults(actions = [], items = [], results = []) {
  const verdicts = new Map((Array.isArray(results) ? results : []).map((row) => [text(row?.id, 20), row || {}]));
  const withheld = new Map();
  const rejected = [];
  for (const item of items) {
    const row = verdicts.get(item.id);
    if (!row || row.verdict !== 'not_outstanding') continue;
    // A probabilistic lifecycle verdict cannot reverse explicit source wording
    // that this same deliverable remains open. This is deliberately scoped to
    // clauses sharing at least two subject words with the action, so an open
    // neighbouring task cannot keep an unrelated completed action alive.
    if (itemHasExplicitOutstandingEvidence(item)) {
      rejected.push({ id: item.id, verdict: row.verdict, reason: 'explicit_outstanding_evidence' });
      continue;
    }
    const quoteCheck = decisionQuoteValidation(row.evidenceQuote, item.passage);
    if (!quoteCheck.valid) {
      rejected.push({ id: item.id, verdict: row.verdict, reason: quoteCheck.reason });
      continue;
    }
    // "I'll do it now while I'm thinking about it" is a promise, not a record
    // that the work was done. A verdict whose own quote is a first-person
    // future commitment, with nothing saying it was completed, is not proof
    // the action is closed.
    if (quoteIsOnlyAPromise(row.evidenceQuote)) {
      rejected.push({ id: item.id, verdict: row.verdict, reason: 'quote_is_a_promise' });
      continue;
    }
    withheld.set(item.index, { evidenceQuote: text(row.evidenceQuote, 500), reason: text(row.reason, 500) });
  }
  const list = Array.isArray(actions) ? actions : [];
  return {
    actions: list.filter((_, index) => !withheld.has(index)),
    withheld: list.map((action, index) => withheld.has(index)
      ? { action, ...withheld.get(index) } : null).filter(Boolean),
    rejected
  };
}

// ---- Answered check -------------------------------------------------------
// "Clarify the formative dates" published as outstanding work, when the date
// was clarified and accepted two lines later. Only clarify/confirm/decide-type
// actions are checked. An action is taken off the published list only when the
// model quotes both the answer and its acceptance and both are in the passage;
// the caller offers it back as a proposal, so nothing is lost.
// Measured and rejected (20 Sep 2026): matching an answerable verb at the start
// of any clause rather than of the whole action, so that run 8's "Fill gaps in
// documentation ... and follow up on the dates for formative studies" would be
// checked. Two findings against the 40 stored drafts. First, retiring a
// composite retires the genuine half with it - that action's gap-filling clause
// is real work. Second, splitting on "and" to avoid that is not viable: 180 of
// 277 actions are "and"-joined, and almost all are single actions ("Review the
// outputs and update the documents", "Review the mute-button change ... and
// determine whether it is acceptable"). Splitting would damage 180 actions to
// correct one. The clauses are only separable by their evidence, which is held
// per action, not per clause. Left anchored at the start of the action.
// "Follow up on the dates for the formative studies ..." is the series' most
// persistent unsupported claim - the meeting settled those dates ("Okay, so
// that's fine", "So, I'm happy with that") - and run 9 published it twice.
// It is answerable work like the rest, so it is checked like the rest. Still
// anchored at the start of the action: a clause buried mid-sentence must not
// drag a composite's genuine half off the list with it.
const ANSWERABLE_ACTION = /^(?:clarify|confirm|determine|decide|finali[sz]e|check|verify|establish|find out|follow[- ]up|agree)\b/i;
function answeredCheckEnabled() {
  return /^(?:1|true|yes|on)$/i.test(String(process.env.MEETING_MINUTES_AGENT_ANSWERED_CHECK_V1 || '0'));
}

function answeredCheckItems(actions = [], units = []) {
  const context = evidenceContextFor(units);
  return (Array.isArray(actions) ? actions : []).map((action, index) => {
    if (!ANSWERABLE_ACTION.test(text(action?.action))) return null;
    const cited = (action.evidenceIds || []).map((id) => context.indexById.get(id)).filter(Number.isInteger);
    if (!cited.length) return null;
    const from = Math.max(0, Math.min(...cited) - 1);
    const to = Math.min(context.rows.length - 1, Math.max(...cited) + 8);
    const passage = context.rows.slice(from, to + 1).map((unit) => `${unit.speaker}: ${unit.text}`).join('\n');
    return { id: `q${index + 1}`, index, action: text(action.action, 600), passage };
  }).filter(Boolean).slice(0, 24);
}

function answeredCheckPrompt(items = []) {
  return [
    'ACTION_CRITIC_ANSWERED',
    'Each item is an action from meeting minutes asking someone to clarify, confirm, determine or decide something, with the transcript passage around it. The passage is the only authority.',
    'Decide whether the question was already answered and accepted DURING the meeting, later in the passage, so nothing is left to do.',
    `- "answered": someone gave the answer in the passage AND the person who raised it accepted it (for example "Okay, so that's fine", "that answers it"). Give answerQuote (the exact words giving the answer) and acceptanceQuote (the exact words accepting it).`,
    '- "open": the answer was not given, was only partly given, depends on someone outside the meeting, or needs checking or documenting afterwards.',
    'Quotes must be verbatim, one contiguous span of at most 25 words each (may run across adjacent lines; leave out speaker names). If you are unsure, choose "open".',
    'Return only this JSON object: {"schemaVersion":1,"results":[{"id":"","verdict":"","answerQuote":"","acceptanceQuote":"","reason":""}]}',
    `ITEMS:\n${JSON.stringify(items.map((item) => ({ id: item.id, action: item.action, passage: item.passage })))}`
  ].join('\n\n');
}

// Returns the actions to keep and those answered in the meeting, each with
// the verified quotes.
function applyAnsweredCheckResults(actions = [], items = [], results = []) {
  const verdicts = new Map((Array.isArray(results) ? results : []).map((row) => [text(row?.id, 20), row || {}]));
  const answered = new Map();
  for (const item of items) {
    const row = verdicts.get(item.id);
    if (!row || row.verdict !== 'answered') continue;
    const answer = decisionQuoteValidation(row.answerQuote, item.passage, 45, { includePositions: true });
    const acceptance = decisionQuoteValidation(row.acceptanceQuote, item.passage, 45, { includePositions: true });
    // Both quotes must occur in answer-then-acceptance order. Repeated words
    // can have several occurrences; an earlier acknowledgement or overlapping
    // span alone cannot prove that this answer was accepted.
    if (!answer.valid || !acceptance.valid
      || !answer.positions.some(reply => acceptance.positions.some(ack => ack.start >= reply.end))) continue;
    answered.set(item.index, { answerQuote: text(row.answerQuote, 300), acceptanceQuote: text(row.acceptanceQuote, 200) });
  }
  const list = Array.isArray(actions) ? actions : [];
  return {
    actions: list.filter((_, index) => !answered.has(index)),
    answered: list.map((action, index) => (answered.has(index) ? { action, ...answered.get(index) } : null)).filter(Boolean)
  };
}

// ---- Resolved open-question check -----------------------------------------
// Discovery often cites only the lines which ask a question. The answer is in
// the next few turns, so a citation-only heuristic leaves answered questions
// labelled as open. This critic sees a bounded forward window. It may retype a
// question only when it quotes the answer verbatim and supplies a grounded,
// client-ready sentence that states the answer rather than merely saying a
// question was discussed.
function openQuestionCheckItems(discussion = [], units = []) {
  const items = [];
  (Array.isArray(discussion) ? discussion : []).forEach((topic, topicIndex) => {
    (topic?.openQuestions || []).forEach((record, rowIndex) => {
      const passageUnits = evidenceWindowUnits(units, record?.evidenceIds || [], 1, 12).slice(0, 28);
      if (!passageUnits.length || !text(record?.text)) return;
      items.push({
        id: `oq${items.length + 1}`, topicIndex, rowIndex,
        question: text(record.text, 800),
        passage: passageUnits.map((unit) => `[${unit.id}] ${unit.speaker}: ${unit.text}`).join('\n')
      });
    });
  });
  return items.slice(0, 24);
}

function openQuestionCheckPrompt(items = []) {
  return [
    'DISCUSSION_CRITIC_OPEN_QUESTION',
    'Each item is labelled as an open question in meeting minutes, followed by the nearby transcript passage. The passage is the only authority.',
    'Decide whether the meeting actually leaves it open or answers it in the supplied passage.',
    '- "answered": the passage directly answers or explains the question. This includes a speaker asking a rhetorical process question and immediately explaining what happens next.',
    '- "open": the passage does not answer it, answers only part of it, or says that checking or a decision is still needed after the meeting.',
    'For "answered", give answerQuote: the exact words that answer it, copied verbatim as one contiguous span of at most 25 words, and resolvedText: one complete factual minutes sentence stating the answer. Do not say merely that the question was discussed or answered. Do not introduce a fact outside the passage.',
    'If you are unsure, choose "open". Return only this JSON object: {"schemaVersion":1,"results":[{"id":"","verdict":"","answerQuote":"","resolvedText":"","reason":""}]}',
    `ITEMS:\n${JSON.stringify(items.map((item) => ({ id: item.id, question: item.question, passage: item.passage })))}`
  ].join('\n\n');
}

function applyOpenQuestionCheckResults(discussion = [], items = [], results = []) {
  const verdicts = new Map((Array.isArray(results) ? results : []).map((row) => [text(row?.id, 20), row || {}]));
  const replacements = new Map();
  for (const item of items) {
    const row = verdicts.get(item.id);
    const resolvedText = text(row?.resolvedText, 800);
    if (!row || row.verdict !== 'answered' || !decisionQuoteFound(row.answerQuote, item.passage)) continue;
    if (!resolvedText || /\?|\b(?:open question|remains? (?:open|unresolved)|to be confirmed|not yet (?:known|decided|confirmed))\b/i.test(resolvedText)) continue;
    // A fluent but invented summary must not replace the question. The answer
    // quote is mandatory, and the complete passage must substantially support
    // the proposed sentence.
    if (evidenceSupportScore(resolvedText, item.passage) < 0.42) continue;
    const quotedUnitIds = String(item.passage).split('\n').filter((line) => decisionQuoteFound(row.answerQuote, line))
      .map((line) => line.match(/^\[([^\]]+)\]/)?.[1]).filter(Boolean);
    replacements.set(`${item.topicIndex}|${item.rowIndex}`, { resolvedText, quotedUnitIds });
  }
  let resolved = 0;
  const checked = (Array.isArray(discussion) ? discussion : []).map((topic, topicIndex) => {
    const points = [...(topic?.points || [])];
    const openQuestions = [];
    (topic?.openQuestions || []).forEach((record, rowIndex) => {
      const replacement = replacements.get(`${topicIndex}|${rowIndex}`);
      if (!replacement) { openQuestions.push(record); return; }
      points.push({
        ...record,
        text: replacement.resolvedText,
        evidenceIds: [...new Set([...(record.evidenceIds || []), ...replacement.quotedUnitIds])]
      });
      resolved += 1;
    });
    return { ...topic, points, openQuestions };
  });
  return { discussion: checked, checked: items.length, resolved };
}

// ---- Work completed during the meeting -----------------------------------
// A request to explain, demonstrate or walk through something now can look
// exactly like an action until the next speaker actually does it. Only these
// presentation-shaped actions are checked, and they leave the published list
// only with a verbatim completion quote. The caller retains them as an optional
// proposal, matching the answered-action safety pattern above.
const LIVE_DELIVERY_ACTION = /^(?:explain|demonstrate|show|present|outline|describe|play|share (?:the )?(?:screen|presentation|slides)|walk (?:us|the team|everyone) through|take (?:us|the team|everyone) through|provide (?:an? )?(?:overview|walkthrough|explanation|demonstration))\b/i;
const LIVE_DELIVERY_REQUEST = /\b(?:(?:could|can|would)\s+you|(?:if\s+)?you\s+(?:could|can|would)|please)\b[^.?!]{0,120}\b(?:explain|demonstrate|show|present|outline|describe|play|share\s+(?:the\s+)?(?:screen|presentation|slides)|walk\b[^.?!]{0,24}\bthrough|take\b[^.?!]{0,24}\bthrough|provide\b[^.?!]{0,24}\b(?:overview|walkthrough|explanation|demonstration))\b/i;
const ARTEFACT_FORMATS = [
  [/\b(?:write|written)\b/i, /\b(?:write|written|write[- ]?up)\b/i],
  [/\bsummary\b/i, /\bsummary\b/i],
  [/\breport\b/i, /\breport\b/i],
  [/\b(?:document|documentation)\b/i, /\b(?:document|documentation)\b/i],
  [/\bemail\b/i, /\bemail\b/i],
  [/\b(?:memo|paper|spreadsheet|slide deck|presentation)\b/i, /\b(?:memo|paper|spreadsheet|slide deck|presentation)\b/i]
];
function unsupportedArtefactFormat(action = '', passage = '') {
  const asserted = ARTEFACT_FORMATS.filter(([actionPattern]) => actionPattern.test(action));
  return asserted.length > 0 && asserted.some(([, evidencePattern]) => !evidencePattern.test(passage));
}
function completedInMeetingCheckItems(actions = [], units = []) {
  return (Array.isArray(actions) ? actions : []).map((action, index) => {
    const passage = evidenceWindowUnits(units, action?.evidenceIds || [], 2, 18).slice(0, 36)
      .map((unit) => `[${unit.id}] ${unit.speaker}: ${unit.text}`).join('\n');
    const actionText = text(action?.action);
    const actionLooksLive = LIVE_DELIVERY_ACTION.test(actionText);
    const evidenceRequestsLive = LIVE_DELIVERY_REQUEST.test(passage);
    if (!passage || (!actionLooksLive && !evidenceRequestsLive)) return null;
    return {
      id: `done${index + 1}`, index, action: text(action.action, 600), passage,
      evidenceTriggered: !actionLooksLive && evidenceRequestsLive,
      unsupportedWrittenFormat: unsupportedArtefactFormat(actionText, passage)
    };
  }).filter(Boolean).slice(0, 16);
}

function completedInMeetingCheckPrompt(items = []) {
  return [
    'ACTION_CRITIC_COMPLETED_IN_MEETING',
    'Each item is a possible outstanding action and its transcript passage. The passage is the only authority.',
    'The Action wording is an untrusted restatement, not evidence. It may incorrectly turn a live verbal request into a future written deliverable.',
    'Decide whether the requested explanation, demonstration, presentation or walkthrough was actually delivered during this meeting.',
    '- "completed": the passage shows the requested information being explained, demonstrated or walked through in the meeting, so it is not outstanding work.',
    '- "outstanding": it was deferred, only partly delivered, or still needs to happen after the meeting.',
    'When unsupportedWrittenFormat is true, do not treat the absence of that invented written artefact as remaining work. Judge the underlying live request. A separate written deliverable remains outstanding only when the passage explicitly commits to writing, sending or providing it after the live delivery.',
    'For "completed", give completionQuote: an exact contiguous quote of at most 25 words showing the delivery itself, not merely the request. If unsure, choose "outstanding".',
    'Return only this JSON object: {"schemaVersion":1,"results":[{"id":"","verdict":"","completionQuote":"","reason":""}]}',
    `ITEMS:\n${JSON.stringify(items.map((item) => ({ id: item.id, action: item.action, evidenceTriggered: item.evidenceTriggered, unsupportedWrittenFormat: item.unsupportedWrittenFormat, passage: item.passage })))}`
  ].join('\n\n');
}

function applyCompletedInMeetingCheckResults(actions = [], items = [], results = []) {
  const verdicts = new Map((Array.isArray(results) ? results : []).map((row) => [text(row?.id, 20), row || {}]));
  const completed = new Map();
  const rejected = [];
  for (const item of items) {
    const row = verdicts.get(item.id);
    if (!row || row.verdict !== 'completed') continue;
    const quoteCheck = decisionQuoteValidation(row.completionQuote, item.passage);
    if (!quoteCheck.valid) {
      rejected.push({ id: item.id, verdict: row.verdict, reason: quoteCheck.reason });
      continue;
    }
    // The same promise-only evidence is insufficient at both lifecycle gates.
    // Future delivery is not proof that the explanation has already happened.
    if (quoteIsOnlyAPromise(row.completionQuote)) {
      rejected.push({ id: item.id, verdict: row.verdict, reason: 'quote_is_a_promise' });
      continue;
    }
    completed.set(item.index, text(row.completionQuote, 300));
  }
  const list = Array.isArray(actions) ? actions : [];
  return {
    actions: list.filter((_, index) => !completed.has(index)),
    completed: list.map((action, index) => completed.has(index)
      ? { action, completionQuote: completed.get(index) } : null).filter(Boolean),
    rejected
  };
}

// ---- Chained first-step timing --------------------------------------------
// "Conduct a call today ..., load the documents for Grace ..., then download
// them and point the auditor": "today" is the call's, not the chain's. When
// the timing's words sit in the first step of a chained action, the words stay
// in the action text and the deadline column is cleared, with a flag.
const CHAIN_STEP_MARKER = /,?\s*\b(?:and then|then|after that|afterwards|once (?:that|this|it|they|approved|done|complete)|followed by)\b/i;
// The transcript form of the same pattern, for when the action's wording does
// not repeat the timing: the timing is spoken in the earlier cited lines (it
// may be asked and answered across two), and the later cited lines - the later
// steps of the chain - carry none.
function timingOnlyInFirstCitedLine(action, units = []) {
  const wording = text(action?.timing?.wording, 220).toLowerCase();
  if (!wording || !Array.isArray(units) || !units.length) return '';
  const context = evidenceContextFor(units);
  const cited = [...new Set(action.evidenceIds || [])].map((id) => context.indexById.get(id))
    .filter(Number.isInteger).sort((a, b) => a - b).map((index) => String(context.rows[index]?.text || ''));
  if (cited.length < 2) return '';
  const said = (line) => line.toLowerCase().includes(wording);
  const lastSaid = cited.reduce((last, line, index) => (said(line) ? index : last), -1);
  // Said in an early step, with at least one later step that does not mention
  // it. Returns the line where it was said, for the reviewer's flag.
  return lastSaid >= 0 && lastSaid < cited.length - 1 && !cited.slice(lastSaid + 1).some(said) ? cited[lastSaid] : '';
}

function timingAttachedToEarlierStep(action = {}, units = []) {
  const wording = text(action?.timing?.wording, 220).toLowerCase();
  if (!wording || !/^(?:on\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/.test(wording)) return '';
  const context = evidenceContextFor(units);
  const cited = [...new Set(action.evidenceIds || [])].map((id) => context.indexById.get(id)).filter(Number.isInteger);
  for (const index of cited) {
    const line = String(context.rows[index]?.text || '');
    const lower = line.toLowerCase();
    const at = lower.indexOf(wording.replace(/^on\s+/, ''));
    if (at < 0) continue;
    const before = line.slice(0, at);
    const after = line.slice(at + wording.replace(/^on\s+/, '').length);
    const priorStep = /\b(?:had|was|were|did|made|review(?:ed)?|met|discussed|spoke|call)\b/i.test(before);
    const laterWork = /\b(?:and|but|then)\b[\s\S]{0,180}\b(?:need(?:s)? to|must|will|remain(?:s|ing)?|further|additional|outstanding|update(?:s|d|ing)?)\b/i.test(after);
    if (priorStep && laterWork && tokenOverlap(action.action, after) >= 0.25) return line;
  }
  return '';
}

function timingReportedForDifferentActor(action = {}, units = []) {
  const wording = text(action?.timing?.wording, 220).toLowerCase();
  const spokenWording = wording.replace(/^(?:within|in|by)\s+/, '');
  const owners = (action?.owners || []).map((owner) => nameParts(owner));
  if (!wording || !owners.length) return '';
  const ownerIsSpeaker = (speaker) => {
    const speakerParts = nameParts(speaker);
    return owners.some((parts) => parts.some((part) => speakerParts.includes(part)));
  };
  for (const row of evidenceWindowUnits(units, action.evidenceIds || [], 1, 2)) {
    const line = String(row?.text || '');
    if (!(line.toLowerCase().includes(wording) || line.toLowerCase().includes(spokenWording))
      || !ownerIsSpeaker(row?.speaker)) continue;
    // If the supposed owner explicitly attributes the estimate to he/she/they,
    // it cannot establish that owner's deadline. Keep the work, clear only the
    // timing, and send the attribution to review.
    if (/\b(?:he|she|they)\s+(?:said|says|thought|thinks|expect(?:s|ed)?|estimate(?:s|d)?|reckon(?:s|ed)?)\b/i.test(line)) return line;
  }
  return '';
}

function applyChainedTimingRule(actions = [], units = [], options = {}) {
  const flags = [];
  const clearTiming = action => TimingIntegrity.rejectActionTiming(action, units, {
    meetingDate: options.meetingDate, field: 'all', reason: 'source_step_mismatch'
  });
  const checked = (Array.isArray(actions) ? actions : []).map((action) => {
    if (isReviewerAuthored(action)) return action;
    const wording = text(action?.timing?.wording, 220).toLowerCase();
    if (!action?.timing || action.timing.kind === 'not_stated' || !wording) return action;
    const earlierStep = timingAttachedToEarlierStep(action, units);
    if (earlierStep) {
      const flag = normaliseFlag({
        kind: 'timing',
        message: `"${text(action.timing.wording, 120)}" described an earlier step in the cited sentence, not this follow-up, so it is not shown as the deadline.`,
        evidenceIds: action.evidenceIds || []
      }, flags.length);
      flags.push(flag);
      return { ...clearTiming(action), reviewFlagIds: [...new Set([...(action.reviewFlagIds || []), flag.id])] };
    }
    const reportedForAnother = timingReportedForDifferentActor(action, units);
    if (reportedForAnother) {
      const flag = normaliseFlag({
        kind: 'timing',
        message: `"${text(action.timing.wording, 120)}" was reported by the proposed owner as another person's estimate, so it is not shown as this owner's deadline.`,
        evidenceIds: action.evidenceIds || []
      }, flags.length);
      flags.push(flag);
      return { ...clearTiming(action), reviewFlagIds: [...new Set([...(action.reviewFlagIds || []), flag.id])] };
    }
    const statement = text(action.action, 1600);
    const marker = statement.match(CHAIN_STEP_MARKER) || statement.match(/,\s+(?:load|download|upload|send|share|submit|return|insert|point|forward)\b/i);
    if (!marker || marker.index < 8) return action;
    const firstStep = statement.slice(0, marker.index).toLowerCase();
    if (!firstStep.includes(wording)) {
      const firstLine = action.timing.kind === 'deadline' ? timingOnlyInFirstCitedLine(action, units) : '';
      if (!firstLine) return action;
      const flag = normaliseFlag({
        kind: 'timing',
        message: `"${text(action.timing.wording, 120)}" was said about an earlier step ("${text(firstLine, 200)}"), not the whole action, so it is not shown as this action's deadline. Add one if the later steps have a date.`,
        evidenceIds: action.evidenceIds || []
      }, flags.length);
      flags.push(flag);
      return { ...clearTiming(action), reviewFlagIds: [...new Set([...(action.reviewFlagIds || []), flag.id])] };
    }
    const flag = normaliseFlag({
      kind: 'timing',
      message: `"${text(action.timing.wording, 120)}" applies to the first step only ("${text(statement.slice(0, marker.index), 160)}"), so it is not shown as the deadline for the whole action. Add a deadline if the later steps have one.`,
      evidenceIds: action.evidenceIds || []
    }, flags.length);
    flags.push(flag);
    return { ...clearTiming(action), reviewFlagIds: [...new Set([...(action.reviewFlagIds || []), flag.id])] };
  });
  return { actions: checked, flags };
}

// ---- Same-commitment duplicates -------------------------------------------
// These existing relation rules nominate possible duplicates. A separate
// directional retention check below must still protect each obligation.
const DUPLICATE_STOP = new Set(['with', 'that', 'this', 'then', 'from', 'into', 'their', 'about', 'review', 'ensure', 'complete']);
function duplicateWords(value) {
  return new Set((String(value || '').toLowerCase().match(/[a-z][a-z'-]{3,}/g) || []).filter((word) => !DUPLICATE_STOP.has(word)));
}
function schedulingCommitment(value = '') {
  return /\b(?:schedule|scheduling|arrange|arranging|book|booking|set up|put)\b[^.]{0,100}\b(?:call|meeting|session|catch[- ]?up|review)\b/i.test(String(value || ''));
}
function sameCommitment(left = {}, right = {}) {
  const owners = (record) => (record.owners || []).map((owner) => String(owner).toLowerCase().trim()).sort().join('|');
  if ((owners(left) || owners(right)) && owners(left) && owners(right) && owners(left) !== owners(right)) return false;
  if (!owners(left) && !owners(right)) return false;
  const leftIds = new Set(left.evidenceIds || []);
  const rightIds = [...new Set(right.evidenceIds || [])];
  const shared = rightIds.filter((id) => leftIds.has(id)).length;
  const timing = (record) => comparisonText(record?.timing?.wording || '').replace(/[^a-z0-9 ]/g, '').trim();
  if (shared >= 1 && schedulingCommitment(left.action) && schedulingCommitment(right.action)
    && timing(left) && timing(left) === timing(right)) return true;
  if (shared < 2 || shared / Math.min(leftIds.size, rightIds.length) < 0.66) return false;
  const a = duplicateWords(left.action); const b = duplicateWords(right.action);
  let common = 0; for (const word of a) if (b.has(word)) common += 1;
  return common / Math.max(1, Math.min(a.size, b.size)) >= 0.3;
}

function coveringActionPair(left, right, related) {
  let leftCovered = actionIsSafelyCovered(left, right);
  let rightCovered = actionIsSafelyCovered(right, left);
  if (!leftCovered && !rightCovered && related) {
    leftCovered = commitmentCanBeRepresented(left, right);
    rightCovered = commitmentCanBeRepresented(right, left);
  }
  if (!leftCovered && !rightCovered) return null;
  // Fuller wording breaks a tie only after both directions preserve the work.
  // It cannot make a longer fragment displace a complete compound or date.
  return leftCovered && (!rightCovered || text(right.action).length > text(left.action).length)
    ? [right, left] : [left, right];
}

function mergeCoveredActionRecords(winner, loser) {
  const result = {
    ...winner,
    evidenceIds: [...new Set([...(winner.evidenceIds || []), ...(loser.evidenceIds || [])])],
    reviewFlagIds: [...new Set([...(winner.reviewFlagIds || []), ...(loser.reviewFlagIds || [])])]
  };
  for (const field of ['_unsupportedEvidenceIds', '_weakEvidenceIds', '_timingConflicts']) {
    if (Array.isArray(winner[field]) || Array.isArray(loser[field])) {
      result[field] = [...new Set([...(winner[field] || []), ...(loser[field] || [])])];
    }
  }
  for (const field of ['_timingPublicationIssue', '_timingClauseNote']) {
    if (!result[field] && loser[field]) result[field] = loser[field];
  }
  return result;
}
function mergeDuplicateCommitments(actions = []) {
  const kept = [];
  let merged = 0;
  for (const action of Array.isArray(actions) ? actions : []) {
    let pair;
    const index = kept.findIndex((existing) => {
      pair = coveringActionPair(existing, action, sameCommitment(existing, action));
      return Boolean(pair);
    });
    if (index < 0) { kept.push(action); continue; }
    merged += 1;
    kept[index] = mergeCoveredActionRecords(...pair);
  }
  return { actions: kept, merged };
}

// ---- Explicit multi-owner compound commitments -----------------------------
// Split only when the cited source maps each recognised verb clause uniquely
// to a different named owner. Ambiguous compounds are left untouched.
const ACTION_VERBS = new Set(ACTION_VERB_GROUPS.flat());

function compoundActionClauses(value = '') {
  const source = text(value, 1200).replace(/\s+/g, ' ').trim();
  if (!source) return [];
  const verbPattern = [...ACTION_VERBS].sort((left, right) => right.length - left.length)
    .map((verb) => verb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const clauses = source.split(new RegExp(`\\s+(?:and|then)\\s+(?=(?:${verbPattern})\\b)`, 'ig'))
    .map((clause) => clause.trim().replace(/[.;]+$/, '')).filter(Boolean);
  return clauses.length > 1 && clauses.every((clause) => ACTION_VERBS.has(contentTokens(clause)[0])) ? clauses : [];
}

function explicitOwnerAssignments(action = {}, units = []) {
  const ownerRows = (action.owners || []).map((owner) => ({ owner, parts: nameParts(owner) }));
  const cited = new Set((action.evidenceIds || []).map(String));
  const assignments = [];
  for (const unit of normaliseSourceUnits(units)) {
    if (!cited.has(String(unit.id))) continue;
    const parts = String(unit.text || '').split(/\s*[,;]\s*|\s+and\s+(?=(?:me|i|[A-Z][\p{L}'’.-]+)\s+(?:to|will|shall|can|am going to|'ll)\b)/iu);
    for (const part of parts) {
      const match = part.match(/^\s*(me|i|[A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+){0,2})\s+(?:to|will|shall|can|am going to|'ll)\s+(.+?)\s*$/iu);
      if (!match) continue;
      const assignee = /^(?:me|i)$/i.test(match[1])
        ? ownerRows.find((candidate) => nameParts(unit.speaker).some((partName) => candidate.parts.includes(partName)))
        : ownerRows.find((candidate) => nameParts(match[1]).some((partName) => candidate.parts.includes(partName)));
      if (!assignee || !text(match[2])) continue;
      assignments.push({ owner: assignee.owner, wording: match[2], evidenceId: unit.id });
    }
  }
  return assignments;
}

function sourceInstructionClauses(value = '') {
  const verbs = [...new Set(ACTION_VERB_GROUPS.flat())].sort((a, b) => b.length - a.length)
    .map(verb => verb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return String(value).split(new RegExp(`[.;!?]+|[,;]\\s*(?:and\\s+|then\\s+|but\\s+)?(?=(?:${verbs})\\b)|\\s+(?:and|then|but)\\s+(?=(?:(?:I|we)\\s+(?:will|'ll)\\s+)?(?:${verbs})\\b)`, 'i'))
    .map(clause => clause.trim()).filter(Boolean);
}

function sourceBindsTimingToStep(step, source, timing, options = {}) {
  const canonical = value => comparisonText(value).replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
  const sourceTiming = clause => {
    if (timing.wording && canonical(clause).includes(canonical(timing.wording))) return true;
    if (!timing.exactDate) return false;
    return TimingIntegrity.resolveExactDate(clause, options.meetingDate) === timing.exactDate
      || dateWordingVariants(timing.exactDate).some(phrase => canonical(clause).includes(canonical(phrase)));
  };
  const stepWords = new Set(materialTokens(step).filter(word => !ACTION_VERBS.has(word)));
  const about = clause => {
    if (!actionPredicateSupported(step, clause)) return false;
    const words = new Set(materialTokens(clause));
    const shared = [...stepWords].filter(word => words.has(word)).length;
    return stepWords.size > 0 && shared >= Math.min(2, stepWords.size)
      && shared / stepWords.size >= 0.6;
  };
  return sourceInstructionClauses(source).some(clause =>
    !/\b(?:not|never|cannot|can't|won't|instead|except|excluding|unless)\b/i.test(clause)
      && sourceTiming(clause) && about(clause));
}

// Rewrites and both splitters use a source-to-operation proof. A date naming
// one child cannot become the date of a wider instruction or another owner.
function timingBoundToActionSteps(action = {}, units = [], options = {}) {
  if (!action.timing || action.timing.kind === 'not_stated') return true;
  const cited = new Set(action.evidenceIds || []);
  const source = normaliseSourceUnits(units).filter(unit => cited.has(unit.id));
  const steps = compoundActionClauses(action.action);
  const required = steps.length ? steps : [action.action];
  const owned = unit => {
    if (!(action.owners || []).length) return false;
    const lower = comparisonText(unit.text);
    const otherFutureSubject = [...String(unit.text || '').matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(?:will|shall|must|is\s+going\s+to)\b/g)]
      .some(match => !/^(?:We|They|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/.test(match[1])
        && !(action.owners || []).some(owner => nameParts(match[1]).every(part => nameParts(owner).includes(part))));
    if (otherFutureSubject) return false;
    return speakerIsOwner(unit.speaker, action.owners)
      || (action.owners || []).some(owner => {
        const name = comparisonText(owner).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\b${name}\\s+(?:will|shall|must|is\\s+to|to)\\b`).test(lower);
      });
  };
  return required.every(step => source.some(unit => owned(unit) && sourceBindsTimingToStep(step, unit.text, action.timing, options)));
}

function splitExplicitMultiOwnerActions(actions = [], units = [], options = {}) {
  let split = 0;
  const flags = [];
  const output = [];
  for (const action of Array.isArray(actions) ? actions : []) {
    if (isReviewerAuthored(action)) { output.push(action); continue; }
    const owners = [...new Set((action?.owners || []).filter(Boolean))];
    if (owners.length < 2) { output.push(action); continue; }
    const clauses = owners.length > 1 ? compoundActionClauses(action?.action) : [];
    if (clauses.length !== owners.length) { output.push(action); continue; }
    const assignments = explicitOwnerAssignments(action, units);
    const matches = clauses.map((clause) => assignments.filter((assignment) =>
      actionPredicateSupported(clause, assignment.wording)
      && commitmentIsAboutAction(assignment.wording, clause)));
    if (matches.some((items) => items.length !== 1)
      || new Set(matches.map((items) => items[0].owner)).size !== clauses.length) {
      output.push(action); continue;
    }
    split += 1;
    clauses.forEach((clause, index) => {
      let child = { ...action,
        id: action.id ? `${action.id}-part-${index + 1}` : action.id,
        action: `${clause.charAt(0).toUpperCase()}${clause.slice(1)}.`,
        owners: [matches[index][0].owner]
      };
      const parentTimingScopeChanged = Boolean(action.timingDecision)
        && !TimingIntegrity.assessmentMatches(child, units, options.meetingDate, action.timingDecision);
      if (parentTimingScopeChanged) {
        delete child.timingDecision;
        child.timing = { kind: 'not_stated', wording: '', exactDate: '' };
      }
      const inheritedTimingMismatch = action.timing?.kind && action.timing.kind !== 'not_stated'
        && !sourceBindsTimingToStep(clause, matches[index][0].wording, action.timing, options);
      if (inheritedTimingMismatch) {
        child = TimingIntegrity.rejectActionTiming(child, units, {
          meetingDate: options.meetingDate, field: 'all', reason: 'split_step_timing_not_bound'
        });
      }
      if (inheritedTimingMismatch || parentTimingScopeChanged || !action.timing || action.timing.kind === 'not_stated') {
        const ownPhrases = [...matches[index][0].wording.matchAll(new RegExp(CITED_TIMING_PHRASE.source, 'gi'))]
          .map(match => match[0]).sort((left, right) => right.length - left.length);
        const ownTiming = ownPhrases.map(phrase => sourceRecoveredTiming(phrase, options))
          .find(timing => sourceBindsTimingToStep(clause, matches[index][0].wording, timing, options));
        if (ownTiming) {
          const boundPrior = TimingIntegrity.assessmentMatches(child, units, options.meetingDate, child.timingDecision)
            ? child.timingDecision : {};
          child.timing = ownTiming;
          child.timingDecision = { ...boundPrior,
            ...TimingIntegrity.timingAssessmentKey(child, units, options.meetingDate), status: 'verified',
            ...(action.timingDecision && !boundPrior.version ? { parentTimingDecision: action.timingDecision } : {}),
            sourceQuote: matches[index][0].wording, stepQuote: clause };
        }
        if (!inheritedTimingMismatch && !ownTiming) { output.push(child); return; }
        const flag = normaliseFlag({ kind: 'timing',
          message: !inheritedTimingMismatch
            ? `The source states "${ownTiming.wording}" for "${child.action}" after the combined instruction was separated. Confirm the timing.`
            : ownTiming
            ? `The original timing "${action.timing.wording || action.timing.exactDate}" belongs to a different step; "${ownTiming.wording}" is stated for "${child.action}". Confirm the timing.`
            : `The original timing "${action.timing.wording || action.timing.exactDate}" was not established for "${child.action}". Confirm this step's timing.`,
          evidenceIds: child.evidenceIds || [] }, flags.length);
        flags.push(flag);
        child.reviewFlagIds = [...new Set([...(child.reviewFlagIds || []), flag.id])];
      }
      output.push(child);
    });
  }
  return { actions: output, split, flags };
}

// ---- Requester is not the owner ---------------------------------------------
// "So if you're talking to Cody, could you just maybe mention it to him?" makes
// the listener the owner, not the chair who asked. When every line the named
// owner speaks in the passage is addressed to someone else ("could you...",
// "you'd need to...") and they never commit themselves, and nobody else names
// them, the owner is removed and flagged. The right owner is not guessed.
// Collective "we" describes the group and cannot, by itself, prove that one
// named individual owns the work. Individual ownership needs singular speech,
// acceptance of an addressed request, or an explicit assignment by somebody
// else.
// Work already under way is owned by the person narrating it: "I've added five
// of those languages", "I've just been simulating real faults", "I'm trying to
// get access to that", "I'm reviewing or rewriting the documents". Four traced
// runs on 2026-09-27 lost owners exactly here - the speaker was mid-task and
// never used a future tense, so nothing below matched and the name was removed.
const OWNER_ONGOING_WORK = /\bi(?:'m|’m|\s+am)\s+(?:currently\s+|still\s+|just\s+|now\s+|also\s+)?(?:trying|working|looking|going\s+through|doing|chasing|sorting|reviewing|rewriting|drafting|writing|preparing|checking|testing|simulating|updating|pulling|putting\s+together|waiting\s+on|in\s+the\s+middle\s+of)\b|\bi(?:'ve|’ve|\s+have)\s+(?:just\s+|also\s+|only\s+|actually\s+)?been\s+\w+ing\b|\bi(?:'ve|’ve|\s+have)\s+(?:already\s+|just\s+|now\s+)?(?:added|started|begun|drafted|made\s+a\s+start)\b/i;
const OWNER_FIRST_PERSON = new RegExp(`${/\bi\b(?:\s+\w+){0,2}\s+(?:will|shall|can|could|need to|needs to|have to|going to|gonna|intend to|plan to|aim to)\b|\b(?:i'll|i'd|i'm going to|i'm gonna)\b|\bshould i\s+(?:just\s+)?(?:add|check|email|forward|place|pop|put|review|send|share|upload)\b|\bleave (?:it|that|this) with me\b|\bwill do\b|\blet me\b|\bi can take that\b/.source}|${OWNER_ONGOING_WORK.source}`, 'i');
const OWNER_ACCEPTS = /^\s*(?:yes|yeah|yep|okay|ok|sure|will do|absolutely|of course|perfect|no problem)\b/i;
const OWNER_SELF_ASSIGNMENT = /\bme\s+to\s+[a-z]|\bthat(?:'d| would)\s+be\s+me\b/i;
function nameParts(value) {
  return String(value || '').toLowerCase().split(/[^a-zà-öø-ÿ']+/).filter((word) => word.length >= 3);
}

// An owner is supported when somebody else names them in the cited lines (or
// one either side), or when they speak there and commit or accept ("I'll ...",
// "we need to ...", "Okay."). A chair who merely asks or comments is not an
// owner: run 8 published two actions owned by the chair, and one owned by a
// person who was not at the meeting.
// Words for the act of meeting-work rather than its subject. Sharing one of
// these says nothing about *which* work a commitment is about.
const MEETING_WORK_WORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'not', 'but', 'all', 'any', 'out', 'its', 'our', 'you', 'who',
  'how', 'why', 'one', 'two', 'new', 'update', 'updates', 'updated', 'table', 'tables', 'minutes',
  'meeting', 'set', 'core', 'area', 'areas', 'thing', 'things', 'work', 'working', 'list', 'item',
  'items', 'document', 'documents', 'file', 'files', 'call', 'calls', 'date', 'dates', 'time',
  'week', 'weeks', 'month', 'next', 'some', 'need', 'needs', 'make', 'take', 'look', 'send',
  'give', 'kind', 'step', 'down', 'through', 'each', 'then', 'here', 'has', 'had', 'will',
  'should', 'well', 'back', 'good', 'okay', 'yeah', 'know', 'think', 'going', 'gonna', 'want',
  'done', 'doing', 'start', 'first', 'second', 'review', 'reviewing', 'confirm', 'confirming',
  'ensure', 'ensuring'
]);

function actionSubjectWords(value) {
  return contentTokens(value).filter((word) => !MEETING_WORK_WORDS.has(word));
}

function sharedSubjectWords(line, actionText) {
  const subject = new Set(actionSubjectWords(actionText));
  return new Set(contentTokens(line).filter((word) => subject.has(word))).size;
}

// Run 9 published "Update the risk table ... USB ports ..." under Jacqui Fox on
// the strength of "I'll update that table for the new set of minutes" - a
// different table, one line before "So Rebecca is kind of managing that through
// with Andrew." The only words shared were "update" and "table". So a
// first-person commitment counts only when it also shares the subject.
function commitmentIsAboutAction(line, actionText) {
  const subject = new Set(actionSubjectWords(actionText));
  if (!subject.size) return true;
  return contentTokens(line).some((word) => subject.has(word));
}

// Ways one speaker hands work to a named person, beyond "X to ..." and
// "X will ...": the present tense of a plan being read back ("Jenny writes the
// list, Bernard sends it"), work described as someone's ("his priority action",
// "Sam's job") and ongoing ownership ("Sam is doing that", "Sam has been working
// through it").
// Someone else describing work as already in a named person's hands: "Sam is
// doing that", "Rebecca is kind of managing that through with Andrew", "Sam has
// been working through it". Used both to support a named owner and, spoken
// about somebody else inside the cited exchange, as the positive evidence that
// the named owner is narrating another person's work.
function narratesOwnership(name, value) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b(?:\\s+\\w+){0,2}\\s+(?:is|'s|’s|has\\s+been)\\s+(?:kind\\s+of\\s+|sort\\s+of\\s+|just\\s+|currently\\s+|still\\s+|now\\s+)?(?:doing|handling|managing|running|progressing|driving|coordinating|working\\s+(?:on|through)|looking\\s+(?:at|after|into)|dealing\\s+with|taking\\s+care\\s+of|sorting|picking\\s+(?:that|this|it)\\s+up|on\\s+(?:it|that|this)|tracing|reviewing|writing|drafting|preparing|chasing|leading)\\b`, 'i').test(String(value || ''));
}

function assignsWorkTo(name, value) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const text = String(value || '');
  // "David and Colm can review the standard again": a modal handed to one or
  // two named people, with the verb that follows. "can't" does not match.
  const modalVerb = String.raw`(?:can|could|should|would|will|to|need\s+to|needs\s+to)\s+(?:just\s+|then\s+|also\s+|maybe\s+|both\s+)?(?:review|check|look|send|share|update|confirm|write|draft|prepare|book|chase|circulate|trace|order|arrange|cover|run|upload|sort|resolve|complete|finish|go|put|pull|follow|take|do|have|make|get|speak|talk|reach|test|set|add|create|document|schedule|contact|email|liaise|feed)\b`;
  return new RegExp(`\\b${escaped}\\b(?:\\s+\\w+){0,3}\\s+(?:to|will|shall|is\\s+(?:responsible\\s+)?to|is\\s+responsible\\s+for|owns?|leads?|takes?)\\b`, 'i').test(text)
    || new RegExp(String.raw`\b${escaped}\b(?:\s*(?:,|and|&)\s*[A-Za-zÀ-ÿ']+(?:\s+[A-Za-zÀ-ÿ']+)?){0,2}\s+${modalVerb}`, 'i').test(text)
    || narratesOwnership(name, text)
    || new RegExp(`\\b(?:assign(?:ed)?|leave|give|hand)\\b.{0,45}\\b${escaped}\\b`, 'i').test(text)
    || new RegExp(`\\b${escaped}(?:\\s+\\w+){0,2}\\s+(?:sends|writes|does|handles|drafts|prepares|books|checks|reviews|runs|updates|traces|orders|arranges|covers|chases|circulates|confirms|leads|owns)\\b`, 'i').test(text)
    || new RegExp(`\\b${escaped}(?:'s|’s)\\s+(?:\\w+\\s+){0,2}(?:priority|job|action|task|responsibility|area)\\b`, 'i').test(text)
    || new RegExp(`\\b${escaped}\\b\\s*,\\s*(?:\\w+\\s+){0,2}your\\s+(?:\\w+\\s+){0,2}(?:focus|priority|job|action|task|responsibility)\\b`, 'i').test(text)
    || new RegExp(`\\b${escaped}\\b.{0,50}?\\byou(?:'re|’re|\\s+are)\\s+(?:(?:just\\s+)?going\\s+to|involved|responsible|leading|doing|handling|on\\s+(?:it|that|this))\\b`, 'i').test(text)
    || new RegExp(`\\b${escaped}\\b(?:\\s+\\w+){0,2}\\s+(?:is|'s|’s|has\\s+been)\\s+(?:doing|handling|working\\s+(?:on|through)|looking\\s+(?:at|after)|on\\s+(?:it|that|this)|tracing|reviewing|writing|drafting|preparing|sorting|chasing|leading)\\b`, 'i').test(text);
}

// A turn addressed to someone by name that asks them to do something:
// "Sam, can you ...", "could you, Sam ...", "Sam, you're doing ...".
function addressedRequestTo(name, value) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const text = String(value || '');
  const asks = String.raw`(?:(?:can|could|would|will)\s+you|you\s+(?:can|could)|you(?:'re|’re|\s+are)\s+(?:doing|on|taking|handling)|your\s+(?:job|action|task))`;
  return new RegExp(String.raw`\b${escaped}\b.{0,60}?\b${asks}\b`, 'i').test(text)
    || new RegExp(String.raw`\b${asks}\b.{0,40}?\b${escaped}\b`, 'i').test(text);
}

// Transcript rows arrive split into sentences, so a +-1 row window is usually
// one side of an exchange. Evidence for ownership is read over whole speaker
// turns instead: the cited turns plus `span` turns either side.
function turnWindowRows(rows = [], citedIndexes = [], span = 2) {
  const turnOf = [];
  let turn = 0;
  rows.forEach((row, index) => {
    if (index && row?.speaker !== rows[index - 1]?.speaker) turn += 1;
    turnOf[index] = turn;
  });
  const wanted = new Set();
  for (const index of citedIndexes) {
    const centre = turnOf[index];
    if (centre == null) continue;
    for (let t = centre - span; t <= centre + span; t += 1) wanted.add(t);
  }
  return rows.filter((row, index) => wanted.has(turnOf[index]));
}

// Anywhere in the meeting: a line that hands this work to this person, or the
// person's own commitment to it, sharing at least two subject words with the
// action. This finds recaps ("David's priority action for the rest of this week
// is tracing the 17 changes") outside the cited passage.
function ownerAssignedInMeeting(owner, actionText = '', units = []) {
  const names = nameParts(owner);
  const subject = new Set(actionSubjectWords(actionText));
  if (!names.length || subject.size < 2) return false;
  // Only a person who exists in this meeting, in full: "Stuart will ..." must
  // not validate an invented "Stuart Jones".
  const identities = [...speakerIdentities(units).map((person) => person.parts), ...mentionedPeople(units).map((name) => nameParts(name))];
  const knownIdentity = identities.some((parts) => names.every((part) => parts.includes(part)))
    // A single name ("Robin") only needs to be someone the meeting talks about.
    || (names.length === 1 && evidenceContextFor(units).rows.some((row) => new RegExp(`\\b${names[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(`${row?.speaker || ''} ${row?.text || ''}`)));
  if (!knownIdentity) return false;
  const rows = evidenceContextFor(units).rows;
  const shared = (value) => contentTokens(value).filter((word) => subject.has(word)).length;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const value = String(row?.text || '');
    const continuation = [value, rows[index + 1]?.text || ''];
    // A transcript can split an assignment around a short interjection:
    // "Morgan, your focus is to resolve those" / "Yes" / "create the pages".
    // Only bridge an unfinished assignment through acknowledgement-only turns
    // back to the same speaker. A substantive intervening reply ends the link.
    if (/\b(?:those|these|that|this|to|the|your|is|are|will|can|should|must)\s*[.!?]*$/i.test(value)) {
      const acknowledgement = /^(?:(?:yes|yeah|yep|okay|ok|right|sure|understood|mhm|mm)[\s.,!]+)*(?:yes|yeah|yep|okay|ok|right|sure|understood|mhm|mm)[\s.,!]*$/i;
      for (let next = index + 1; next <= index + 3 && next < rows.length; next += 1) {
        if (rows[next].speaker === row.speaker) {
          continuation.push(rows[next].text);
          break;
        }
        if (!acknowledgement.test(String(rows[next].text || '').trim())) break;
      }
    }
    const context = continuation.join(' ');
    const speaksAsOwner = nameParts(row?.speaker).some((part) => names.includes(part));
    if (speaksAsOwner && (OWNER_FIRST_PERSON.test(value) || OWNER_SELF_ASSIGNMENT.test(value))
      && shared([rows[index - 1]?.text || '', context].join(' ')) >= 2) return true;
    if (!speaksAsOwner && names.some((name) => assignsWorkTo(name, value)) && shared(context) >= 2) return true;
    if (!speaksAsOwner && names.some((name) => addressedRequestTo(name, value)) && shared(context) >= 2) {
      const reply = rows.slice(index + 1, index + 4).find((next) => nameParts(next?.speaker).some((part) => names.includes(part)));
      if (reply && (OWNER_ACCEPTS.test(String(reply.text || '')) || OWNER_FIRST_PERSON.test(String(reply.text || '')))) return true;
    }
  }
  return false;
}

// Inside the passage the action cites, a request addressed to someone by name
// ("David, is that something you can write up?") answered by that person
// without refusing ("It'll be Friday though") is an accepted request. The
// citation already ties the request to this action, so no subject match is
// needed; the preparer can also drop the bare "I can." between the two.
const OWNER_REFUSES = /\b(?:no|nope|can't|cannot|can not|won't|not me|not able|unable|don't think i can|i couldn't)\b/i;
function addressedRequestAccepted(owner, lines = []) {
  const names = nameParts(owner);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (nameParts(line?.speaker).some((part) => names.includes(part))) continue;
    if (!names.some((name) => addressedRequestTo(name, line?.text))) continue;
    const reply = lines.slice(index + 1, index + 3).find((next) => nameParts(next?.speaker).some((part) => names.includes(part)));
    if (reply && !OWNER_REFUSES.test(String(reply.text || ''))) return true;
  }
  return false;
}

// The chair asking someone else ("could you mention it to him?") is not the
// chair taking the work on. True when the named person speaks in the passage
// only to ask others, never committing themselves.
const OWNER_REQUESTS_OTHERS = /\b(?:can|could|would|will)\s+you\b|\byou(?:'d|’d|\s+would|\s+need|\s+should|'re|’re|\s+are)\b/i;
// Needing a completed document is still receiving work, not undertaking it.
// Keep "need to complete" distinct from "need the completed ...".
const OWNER_NEEDS_OBJECT = /\bi(?:['’]ll|['’]m\s+going\s+to|\s+(?:will|shall|can|could|would|might|may|am\s+going\s+to))?\s+(?:(?:also|just|really|still)\s+){0,2}(?:need|want|require)\s+(?!\s*to\b)/i;
function ownerOnlyAsksOthers(owner, lines = []) {
  const names = nameParts(owner);
  const own = lines.filter((line) => nameParts(line?.speaker).some((part) => names.includes(part)));
  if (!own.length) return false;
  return own.every((line) => OWNER_REQUESTS_OTHERS.test(String(line.text || ''))
    && !OWNER_FIRST_PERSON.test(String(line.text || '')) && !OWNER_SELF_ASSIGNMENT.test(String(line.text || '')));
}

// The named owner asks somebody else in the exchange ("could you just maybe
// mention it to him?") and that person accepts or commits within the next two
// lines: the work went to the person who answered. Returns that person.
function handedOffTo(owner, lines = [], people = []) {
  const names = nameParts(owner);
  const isOwner = (speaker) => nameParts(speaker).some((part) => names.includes(part));
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const value = String(line?.text || '');
    if (!isOwner(line?.speaker) || !OWNER_REQUESTS_OTHERS.test(value)) continue;
    if (OWNER_FIRST_PERSON.test(value) || OWNER_SELF_ASSIGNMENT.test(value)) continue;
    const reply = lines.slice(index + 1, index + 3).find((next) => next?.speaker && !isOwner(next.speaker)
      && (OWNER_ACCEPTS.test(String(next.text || '')) || OWNER_FIRST_PERSON.test(String(next.text || ''))));
    if (!reply || OWNER_REFUSES.test(String(reply.text || ''))) continue;
    const person = people.find((candidate) => nameParts(reply.speaker).some((part) => candidate.parts.includes(part)));
    if (person) return person;
  }
  return null;
}

function ownerTakesItOn(owner, lines = [], actionText = '', people = []) {
  const names = nameParts(owner);
  if (!names.length) return true;
  // Whether anyone else is in the frame. The subject test exists to stop a
  // commitment about other work ("I'll update that table for the new set of
  // minutes") claiming an action someone else was just given - in run 9's case
  // one line after "So Rebecca is kind of managing that through with Andrew."
  // Where no one else is named, there is no rival claim to guard against, and
  // demanding a subject match strips a plain commitment: run 10 removed Ciaran
  // Ryan from TFO3 work evidenced by three consecutive lines of his own.
  const contested = people.some((person) => !person.parts.some((part) => names.includes(part))
    && lines.some((line) => personIsNamedIn(person, line?.text)));
  const mentions = (value) => names.some((name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(value));
  const assigned = (value) => names.some((name) => assignsWorkTo(name, value));
  const isOwner = (speaker) => nameParts(speaker).some((word) => names.includes(word));
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const value = String(line?.text || '');
    if (!isOwner(line?.speaker) && mentions(value) && assigned(value)) return true;
    if (!isOwner(line?.speaker)) continue;
    const firstPerson = OWNER_FIRST_PERSON.test(value) || OWNER_SELF_ASSIGNMENT.test(value);
    const accepts = OWNER_ACCEPTS.test(value);
    if (!firstPerson && !accepts) continue;
    // The preparer splits speech into sentences, so "That document, but I'm
    // gonna..." and "focus on TFO3 this week." arrive as two lines and the
    // subject sits in the second. Only an unfinished line runs on into the next
    // one: a line closing on a full stop is its own sentence, and borrowing the
    // subject from it let run 9's "I'll update that table for the new set of
    // minutes." take its subject from "The focus still remains on risk...".
    const runsOn = (row) => Boolean(row) && /(?:\.\.\.|[^.!?])\s*$/.test(String(row.text || ''));
    const sameSpeaker = (row) => Boolean(row) && isOwner(row.speaker);
    const utterance = [line];
    if (runsOn(line) && sameSpeaker(lines[index + 1])) utterance.push(lines[index + 1]);
    if (sameSpeaker(lines[index - 1]) && runsOn(lines[index - 1])) utterance.unshift(lines[index - 1]);
    // A bare "yes/okay" proves ownership only when it answers a nearby request
    // about this work. Previously any acknowledgement in a disconnected cited
    // line could make that speaker the owner of an unrelated action.
    if (accepts && !firstPerson) {
      const requestContext = [lines[index - 2], lines[index - 1]].filter(Boolean)
        .map((row) => String(row.text || '')).join(' ');
      if (!names.some((name) => addressedRequestTo(name, requestContext))
        || !commitmentIsAboutAction(requestContext, actionText)) continue;
      return true;
    }
    if (!contested) return true;
    if (commitmentIsAboutAction(utterance.map((row) => String(row.text || '')).join(' '), actionText)) return true;
  }
  return false;
}

function applyRequesterOwnerRule(actions = [], units = []) {
  const context = evidenceContextFor(units);
  // A rival claimant need not be someone who spoke: work is regularly given to
  // a Louise or a Kevin who is only talked about.
  const people = [...speakerIdentities(units),
    ...mentionedPeople(units).map((name) => ({ label: name, parts: nameParts(name) }))]
    .filter((person, index, all) => person.parts.length
      && all.findIndex((other) => other.parts.join(' ') === person.parts.join(' ')) === index);
  const rows = context.rows;
  const flags = [];
  const checked = (Array.isArray(actions) ? actions : []).map((action) => {
    if (isReviewerAuthored(action)) return action;
    const owners = Array.isArray(action?.owners) ? action.owners : [];
    if (!owners.length) return action;
    const cited = [...new Set(action.evidenceIds || [])].map((id) => context.indexById.get(id)).filter(Number.isInteger);
    if (!cited.length) return action;
    const window = turnWindowRows(rows, cited, 2);
    const unsupported = owners.filter((owner) => !ownerTakesItOn(owner, window, action?.action, people)
      && !addressedRequestAccepted(owner, window)
      && !ownerAssignedInMeeting(owner, action?.action, units));
    if (!unsupported.length) return action;
    // Only positive evidence removes a named owner: somebody else is shown
    // taking this work on, or the named person only asked others to do it.
    // Absence of proof is not proof of absence - a plain "I'd rather ask
    // them" or a chair's read-back can sit outside any window we choose.
    // Counter-evidence must come from the same exchange: someone committing to
    // other work elsewhere in the meeting says nothing about this action.
    // Only the rival's own first-person commitment counts, in a line that is
    // itself about this work. A chair reading the actions back ("Rebecca,
    // you're going to update the risk files") or asking someone to do it is
    // describing the work, not taking it on.
    const rival = people.find((person) => !owners.some((owner) => nameParts(owner).some((part) => person.parts.includes(part)))
      && window.some((line) => {
        const value = String(line?.text || '');
        // "I'll circulate it with you, Andrew, to review" hands the next step
        // to the named owner; it is not the speaker taking that step over.
        const namesOwner = owners.some((owner) => personIsNamedIn({ parts: nameParts(owner) }, value));
        return nameParts(line?.speaker).some((part) => person.parts.includes(part))
          && (OWNER_FIRST_PERSON.test(value) || OWNER_SELF_ASSIGNMENT.test(value))
          && !OWNER_REQUESTS_OTHERS.test(value)
          && !OWNER_NEEDS_OBJECT.test(value)
          && !namesOwner
          && actionPredicateSupported(action?.action, value)
          && sharedSubjectWords(value, action?.action) >= 2;
      }));
    // Two more positive signs that the work sits with somebody else, both from
    // the cited exchange itself: a line placing it in another person's hands
    // ("So Rebecca is kind of managing that through with Andrew"), or the named
    // owner asking someone who then accepts ("could you just maybe mention it
    // to him?" / "Yes, I can do that.").
    // Read within two rows of a cited line, not across a whole long turn: a
    // chair's round-up names many people's work in one breath, and "Andrew is
    // working on that as well" fifteen rows on says nothing about this action.
    const nearCited = [...new Set(cited.flatMap((index) => [index - 2, index - 1, index, index + 1, index + 2]))]
      .map((index) => rows[index]).filter(Boolean);
    const narratedRival = rival ? null : people.find((person) => !owners.some((owner) => nameParts(owner).some((part) => person.parts.includes(part)))
      && nearCited.some((line) => narratesOwnership(person.label, line?.text)
        || person.parts.some((part) => part.length >= 4 && narratesOwnership(part, line?.text))));
    const handedOff = rival || narratedRival ? null : owners.map((owner) => handedOffTo(owner, window, people)).find(Boolean);
    const shownElsewhere = rival || narratedRival || handedOff || null;
    // Being in the cited exchange without a parsed commitment is not evidence
    // against a named owner. Four traced runs on 2026-09-27 removed ten owners
    // on that ground and every one was wrong: people mid-task ("I've added five
    // of those languages"), a plan spoken as "we'll schedule a call", a
    // chair's "David and Colm can review the standard again". Without positive
    // counter-evidence the name stays and the reviewer is asked to confirm it.
    const removed = unsupported.filter((owner) => shownElsewhere || ownerOnlyAsksOthers(owner, window));
    const unverified = unsupported.filter((owner) => !removed.includes(owner));
    const actionFlags = [];
    if (removed.length) {
      actionFlags.push(normaliseFlag({
        kind: 'ownership',
        message: shownElsewhere
          ? `Owner changed for review: the transcript shows ${shownElsewhere.label} taking this on, not ${removed.join(' or ')}. Confirm the owner.`
          : `Owner unclear: the cited evidence does not show ${removed.join(' or ')} taking this on, so it was removed. Add the person who is doing it.`,
        evidenceIds: action.evidenceIds || []
      }, flags.length + actionFlags.length));
    }
    if (unverified.length) {
      actionFlags.push(normaliseFlag({
        kind: 'ownership',
        message: `Owner to confirm: the cited lines do not clearly show ${unverified.join(' or ')} taking this on. Check the name.`,
        evidenceIds: action.evidenceIds || []
      }, flags.length + actionFlags.length));
    }
    flags.push(...actionFlags);
    return {
      ...action,
      owners: owners.filter((owner) => !removed.includes(owner)),
      reviewFlagIds: [...new Set([...(action.reviewFlagIds || []), ...actionFlags.map((flag) => flag.id)])]
    };
  });
  return { actions: checked, flags };
}

// ---- Superseded statements ---------------------------------------------------
// A primary row whose own citations hold an assumption and then the speaker's
// correction ("I presumed X ... but I think that slightly changed") is most
// often the superseded X restated (T733's formative line, identical in every
// run because a deterministic extractor writes it). It is not published as a
// primary statement: it moves, flag and all, into the supporting context of
// the nearest primary row, where the reviewer still sees it.
// Candidate rows (rare) with their passage, for the model's judgement.
function supersededItemFor(record, units, context) {
  const correction = citedRevisionUnit(units, record?.evidenceIds || [], record?.text || '');
  if (!correction) return null;
  const at = context.indexById.get(correction.id);
  const cited = (record.evidenceIds || []).map((id) => context.indexById.get(id)).filter(Number.isInteger).sort((a, b) => a - b);
  const earlier = cited.filter((index) => index < at && PRESUMPTION_CUE.test(String(context.rows[index]?.text || '')));
  const line = (index) => `${context.rows[index].speaker}: ${context.rows[index].text}`;
  const correctionLines = [at, at + 1, at + 2].filter((index) => index < context.rows.length).map(line);
  return {
    row: text(record.text, 800),
    earlier: earlier.map(line).join('\n'),
    correction: correctionLines.join('\n'),
    passage: [...earlier.map(line), ...correctionLines].join('\n'),
    correctionUnit: correction
  };
}

function supersededCheckItems(discussion = [], units = []) {
  const context = evidenceContextFor(units);
  const items = [];
  (Array.isArray(discussion) ? discussion : []).forEach((topic, topicIndex) => {
    for (const kind of ['points', 'decisions']) {
      (topic?.[kind] || []).forEach((record, rowIndex) => {
        const item = supersededItemFor(record, units, context);
        if (item) items.push({ id: `s${items.length + 1}`, topicIndex, kind, rowIndex, ...item });
      });
    }
  });
  return items.slice(0, 12);
}

// The superseded statement often arrives already in supporting context (the
// referee put it there), where the demotion rule never sees it. Label it there
// too, with the same flag, so it cannot read as the current position.
const SUPERSEDED_LABEL = 'Earlier position, revised later in the meeting: ';
function labelSupersededContext(discussion = [], units = []) {
  const context = evidenceContextFor(units);
  const flags = [];
  let labelled = 0;
  const checked = (Array.isArray(discussion) ? discussion : []).map((topic) => {
    const next = { ...topic };
    for (const kind of ['points', 'decisions', 'openQuestions']) {
      if (!Array.isArray(topic?.[kind])) continue;
      next[kind] = topic[kind].map((record) => {
        const details = Array.isArray(record?.supportingDetails) ? record.supportingDetails : [];
        if (!details.length) return record;
        let changed = false;
        const updated = details.map((detail) => {
          if (String(detail?.text || '').startsWith(SUPERSEDED_LABEL)) return detail;
          const item = supersededItemFor(detail, units, context);
          if (!item || rowReflectsCorrection(item)) return detail;
          const flag = normaliseFlag({
            kind: 'uncertain_fact',
            message: `Conflicting passage: the speaker revised this later ("${salientExcerpt(item.correctionUnit.text, /./).slice(0, 200)}"). This line states the earlier position.`,
            evidenceIds: detail.evidenceIds || []
          }, flags.length);
          flags.push(flag);
          changed = true;
          labelled += 1;
          return {
            ...detail,
            text: `${SUPERSEDED_LABEL}${detail.text}`,
            reviewFlagIds: [...new Set([...(detail.reviewFlagIds || []), flag.id])]
          };
        });
        return changed ? { ...record, supportingDetails: updated } : record;
      });
    }
    return next;
  });
  return { discussion: checked, flags, labelled };
}

// A row citing a self-correction must carry what the correction says. Rows
// using fewer than three words found in the correction (and not in the
// earlier statement) restate the earlier position; the model could not be
// used to judge this, as it read a misheard "protect file being lifted" as the
// earlier "summative submission".
function rowReflectsCorrection(item) {
  const earlier = aboutWords(item.earlier);
  const correctionOnly = [...aboutWords(item.correction)].filter((word) => !earlier.has(word));
  const row = aboutWords(item.row);
  return correctionOnly.filter((word) => row.has(word)).length >= 3;
}

function supersededVerdicts(items = []) {
  return new Set(items.filter((item) => !rowReflectsCorrection(item))
    .map((item) => `${item.topicIndex}|${item.kind}|${item.rowIndex}`));
}

function demoteSupersededRows(discussion = [], units = [], outdated = null) {
  const context = evidenceContextFor(units);
  const position = (record) => Math.min(...(record?.evidenceIds || []).map((id) => context.indexById.get(id)).filter(Number.isInteger), Infinity);
  const topics = (Array.isArray(discussion) ? discussion : []).map((topic) => ({
    ...topic,
    points: [...(topic.points || [])],
    decisions: [...(topic.decisions || [])]
  }));
  const moved = [];
  topics.forEach((topic, topicIndex) => {
    for (const kind of ['points', 'decisions']) {
      topic[kind] = topic[kind].filter((record, rowIndex) => {
        if (!citedRevisionUnit(units, record?.evidenceIds || [], record?.text || '')) return true;
        // Only rows judged outdated move; a row stating the corrected position stays.
        if (outdated && !outdated.has(`${topicIndex}|${kind}|${rowIndex}`)) return true;
        moved.push({ record, topicIndex });
        return false;
      });
    }
  });
  let demoted = 0;
  for (const { record, topicIndex } of moved) {
    const own = topics[topicIndex];
    const sameTopic = [...own.points, ...own.decisions];
    const everywhere = topics.flatMap((topic) => [...topic.points, ...topic.decisions]);
    const pool = sameTopic.length ? sameTopic : everywhere;
    const target = position(record);
    const parent = pool.slice().sort((a, b) => Math.abs(position(a) - target) - Math.abs(position(b) - target))[0];
    if (!parent) {
      // Nowhere to attach it: keep it where it was rather than lose it.
      own.points.push(record);
      continue;
    }
    const { supportingDetails, ...detail } = record;
    // Labelled so that, in context, it cannot read as the current position.
    parent.supportingDetails = [...(parent.supportingDetails || []),
      { ...detail, text: `${SUPERSEDED_LABEL}${detail.text}` }];
    demoted += 1;
  }
  const kept = topics.filter((topic) => topic.points.length || topic.decisions.length || (topic.openQuestions || []).length);
  return { discussion: kept, demoted };
}

// ---- Not an action at all -----------------------------------------------------
// Two shapes seen in real client meetings. "Maybe I'll have some questions on
// that also." became the published action "Possibly have some questions on the
// reviewed document." - nobody is doing anything, and the speaker hedged. A
// hedged opener and a "have questions/thoughts" object both describe a state of
// mind rather than work, so neither is a task.
const NOT_A_DELIVERABLE = /^\s*(?:possibly\s+|maybe\s+|perhaps\s+|potentially\s+)?(?:have|raise)\s+(?:some\s+|any\s+)?(?:questions|queries|thoughts|concerns|a look)\b/i;
const SPECULATIVE_ACTION = /^\s*(?:possibly|maybe|perhaps|potentially)\b/i;
// "Always ask about dietary requirements", "Never share the tracker": a
// standing rule for how things are done, with nobody doing anything by a
// date. It belongs in the minutes, not the action list.
const STANDING_POLICY_ACTION = /^\s*(?:always|never)\b/i;
// "give it thirty seconds for Dermot and then" - a clause cut off at its
// joint. Whatever it was going to say, a sentence ending on a conjunction is
// not an instruction anyone can act on. "so" is kept where it is the object
// ("if she is comfortable doing so").
const DANGLING_TAIL = /(?:\s*(?:,|;|\b(?:and|then|but|or|because|although|whereas|whilst)\b|(?<!\b(?:do|doing|done|did|does)\s)\bso\b))+\s*[.]?\s*$/i;
function trimDanglingTail(value = '') {
  return String(value || '').replace(DANGLING_TAIL, '').trim();
}
const DANGLING_TAIL_WORD = /(?:\b(?:and|then|but|or|because|although|whereas|whilst)\b|(?<!\b(?:do|doing|done|did|does)\s)\bso\b)\s*[.,;]?\s*$/i;
function endsOnDanglingTail(value = '') {
  return DANGLING_TAIL_WORD.test(String(value || '').trim());
}
function isNotAnAction(value = '') {
  const wording = text(value, 600);
  return NOT_A_DELIVERABLE.test(wording) || SPECULATIVE_ACTION.test(wording)
    || STANDING_POLICY_ACTION.test(wording) || endsOnDanglingTail(wording);
}

// ---- Instructions to whoever writes the minutes ------------------------------
// "Write down that the end of July release date is at risk so that nobody is
// surprised in a fortnight." (Calderhaven, draft 1037) is a speaker telling the
// note-taker what to record. The tool is the note-taker; the fact belongs in
// the discussion, not in the action list under somebody's name. Likewise a
// bare "Send the meeting minutes." is the minute-taker's own routine, but
// "Send the minutes to the client by Friday" names a recipient and stays.
const MINUTE_INSTRUCTION = /^\s*(?:please\s+|just\s+)?(?:write|note|jot|put|record|capture|log|minute|mark|make\s+a\s+note)\s+(?:it\s+|that\s+|this\s+)?(?:down\s+)?(?:that\b|this\b|in\s+the\s+(?:minutes|notes)\b|as\s+(?:a\s+)?(?:note|risk)\b)/i;
const MINUTES_ROUTINE = /^\s*(?:send|circulate|distribute|share|issue|produce|type\s+up|write\s+up|prepare|finalise|finalize|draft)\s+(?:out\s+|round\s+|around\s+)?(?:the\s+|these\s+|this\s+|today's\s+|this\s+week's\s+)?(?:meeting\s+)?(?:minutes|notes|meeting\s+notes)\s*(?:out|round|around)?\s*\.?\s*$/i;
// Require the whole action to describe note-taking for this call. A recipient,
// future event, technical qualifier or second task prevents this routine match.
const CURRENT_MEETING_NOTES = /^\s*(?:please\s+|just\s+)?(?:take|keep|make|write)\s+(?:the\s+)?(?:notes|minutes)\s+(?:during|for|at|in)\s+(?:the|this|our|current)\s+(?:meeting|call|session)\s*\.?\s*$/i;
const MINUTE_SOURCE_DELIVERABLE = /\b(?:client|customer|contract(?:ual)?|formal\s+record|technical\s+file|required\s+record|board\s+(?:review|approval))\b|\b(?:before|after|once|until|tomorrow|next|upcoming|following|deadline|due)\b|\b(?:send|circulate|distribute|share|issue)\b[^.;]{0,100}\bto\s+\S/i;
function isMinuteInstruction(value = '', { action = {}, sourceUnits = [] } = {}) {
  const wording = text(value, 600);
  if (isReviewerAuthored(action)) return false;
  if (MINUTE_INSTRUCTION.test(wording)) return true;
  if (!MINUTES_ROUTINE.test(wording) && !CURRENT_MEETING_NOTES.test(wording)) return false;
  // A shortened candidate can omit a real deadline or delivery requirement.
  // Consult its own fields and directly cited clauses, never nearby turns.
  if (text(action?.timing?.wording, 220) || text(action?.timing?.exactDate, 20)) return false;
  const cited = new Set(Array.isArray(action?.evidenceIds) ? action.evidenceIds : []);
  const clauses = evidenceContextFor(sourceUnits).rows.filter(unit => cited.has(unit.id))
    .flatMap(unit => String(unit.text || '').split(/(?<=[.!?;])\s+|\n+/))
    .filter(clause => /\b(?:minutes|notes)\b/i.test(clause));
  return !clauses.some(clause => MINUTE_SOURCE_DELIVERABLE.test(clause)
    // Exclude the deictic "this", authorship "by", and modal/sequencing
    // "may/first take notes". The remaining weekday, month, relative-date and
    // numeric signals preserve later work without inferring a date.
    || CALENDAR_TIMING.test(clause.replace(/\b(?:this|by)\b/gi, '')
      .replace(/\b(?:may|first)(?=\s+(?:(?:just|also)\s+)?(?:take|keep|make|write|prepare|send|circulate|produce)\b)/gi, ''))
    || DEPENDENCY_TIMING.test(clause));
}

// ---- Social asides in the goodbyes --------------------------------------------
// "I'm gonna, yeah, I need to book a holiday." - said at unit 365 of 374,
// between "They definitely love you anyway" and "Just another form of tax" -
// was published as the action "Book a holiday." It reads as a commitment
// because grammatically it is one. What marks it out is that the meeting never
// discusses it: every subject word appears in exactly one line, and that line
// is in the closing moments. Real business gets talked about more than once.
// The signal is statistical, so such a row is offered, never simply deleted.
const ASIDE_TAIL_FRACTION = 0.9;
function isSocialAside(action = {}, units = []) {
  const context = evidenceContextFor(units);
  const rows = context.rows;
  if (rows.length < 40) return false;
  const cited = [...new Set(action?.evidenceIds || [])].map((id) => context.indexById.get(id)).filter(Number.isInteger);
  if (!cited.length) return false;
  if (Math.min(...cited) / rows.length < ASIDE_TAIL_FRACTION) return false;
  const subject = actionSubjectWords(action?.action);
  if (!subject.length) return false;
  const frequency = new Map();
  for (const row of rows) for (const word of new Set(contentTokens(row.text))) frequency.set(word, (frequency.get(word) || 0) + 1);
  return subject.every((word) => (frequency.get(word) || 0) <= 1);
}

// A personal aside can occur under an explicit AOB heading rather than in the
// goodbye tail. Keep this narrower than a general AOB filter: real operational
// work is often assigned there. Only a vague promise to bring/show something,
// immediately after a personal-status question, is treated as an aside.
function isAobPersonalAside(action = {}, units = []) {
  if (!/^\s*(?:bring|take|show)\b[^.]{0,180}\b(?:show|bring|take)\b/i.test(text(action?.action, 600))) return false;
  const context = evidenceContextFor(units);
  const cited = [...new Set(action?.evidenceIds || [])].map((id) => context.indexById.get(id)).filter(Number.isInteger);
  if (!cited.length) return false;
  return cited.some((index) => {
    const preceding = context.rows.slice(Math.max(0, index - 4), index);
    const afterAob = preceding.some((row) => /\bany other business\b/i.test(row.text));
    const personalQuestion = preceding.slice(-2).some((row) =>
      /\b(?:how (?:is|are) your|have you got|did you bring|since we're here)\b/i.test(row.text));
    const commitment = String(context.rows[index]?.text || '');
    return afterAob && personalQuestion
      && /\bi(?:'ll| will| can)\s+(?:bring|take|show)\s+(?:it|one|them|something)\b/i.test(commitment);
  });
}

// A contact-only sentence in the closing pleasantries ("speak to you next
// week", "see you soon") is a farewell, not a follow-up. The rule requires all
// three signals: a short/vague contact action, evidence in the final portion of
// the meeting, and nearby thanks/goodbye language. A substantive contact task
// ("speak to Alex about the risk register") is deliberately excluded.
const FAREWELL_CONTACT_ACTION = /^(?:speak|talk|catch up|connect|meet|see)\s+(?:(?:to|with)\s+)?(?:[A-Z][\p{L}'’.-]*(?:\s+[A-Z][\p{L}'’.-]*)?|you|everyone|the team)(?:\s+(?:again|next week|later|soon|tomorrow|this week))?\.?$/iu;
const CLOSING_PLEASANTRY = /\b(?:thank(?:s| you)|bye|goodbye|good night|brilliant stuff|appreciate your help|talk to you|speak to you|see you|have a good|take care)\b/i;
function isFarewellAction(action = {}, units = []) {
  const wording = text(action?.action, 600);
  if (!FAREWELL_CONTACT_ACTION.test(wording) || /\b(?:about|regarding|concerning|to (?:review|send|confirm|decide|resolve|check|prepare|update))\b/i.test(wording)) return false;
  const context = evidenceContextFor(units);
  if (context.rows.length < 12) return false;
  const cited = [...new Set(action?.evidenceIds || [])].map((id) => context.indexById.get(id)).filter(Number.isInteger);
  if (!cited.length || Math.min(...cited) / context.rows.length < 0.85) return false;
  const nearby = [...new Set(cited.flatMap((index) => [index - 2, index - 1, index, index + 1, index + 2]))]
    .filter((index) => index >= 0 && index < context.rows.length).map((index) => context.rows[index].text).join(' ');
  return CLOSING_PLEASANTRY.test(nearby);
}

// "I'll try to get as much as I can done" supports progress, not a promise to
// complete. Preserve the task and its target, but soften a completion verb when
// all cited commitment language is explicitly best-efforts and no cited line
// commits to finishing it.
const BEST_EFFORT_PROGRESS = /\b(?:try(?:ing)? to|get as much as (?:i|we) can|as much as (?:is )?possible|make as much progress|progress as far as|see how (?:i|we) get on)\b/i;
const EXPLICIT_COMPLETION = /\b(?:(?:i|we)(?:'ll| will| shall| must| need to| have to)\s+(?:complete|finish|finali[sz]e)|(?:complete|finish|finali[sz]e)(?:d)?\s+by)\b/i;
function softenBestEffortCompletion(actions = [], units = []) {
  const flags = [];
  const checked = (Array.isArray(actions) ? actions : []).map((action) => {
    if (isReviewerAuthored(action)) return action;
    if (!/^(?:complete|finish|finali[sz]e)\b/i.test(text(action?.action, 1600))) return action;
    const passageUnits = evidenceWindowUnits(units, action.evidenceIds || [], 1, 2);
    const passage = passageUnits.map((unit) => unit.text).join(' ');
    const citedIds = new Set(action.evidenceIds || []);
    const relevantBestEffort = passageUnits.some((unit) => citedIds.has(unit.id)
      && BEST_EFFORT_PROGRESS.test(unit.text));
    if (!relevantBestEffort || EXPLICIT_COMPLETION.test(passage)) return action;
    const original = text(action.action, 1600);
    const softened = original.replace(/^(?:complete|finish|finali[sz]e)\b/i, 'Progress');
    let timing = action.timing;
    const timingText = String(timing?.wording || '').trim().replace(/[.!?]+$/, '');
    if (timingText && timing?.kind !== 'not_stated') {
      const quotedTiming = timingText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const qualifiedPhrase = new RegExp(`\\b(?:try(?:ing)? to|aim(?:ing)? to|hop(?:e|ing) to)\\s+${quotedTiming}(?![\\p{L}\\p{N}])`, 'iu');
      const context = evidenceContextFor(units);
      const statusWords = new Set(['part', 'way', 'halfway', 'currently', 'still', 'progress', 'working', 'am', 'are']);
      const subject = new Set(actionSubjectWords(original));
      const carrying = passageUnits.find(unit => {
        if (!citedIds.has(unit.id) || !speakerIsOwner(unit.speaker, action.owners || [])) return false;
        const phrase = String(unit.text).match(qualifiedPhrase);
        if (!phrase) return false;
        // The remaining turn must not introduce another object, assignee or
        // period around a matching generic completion phrase.
        const remainder = String(unit.text).replace(phrase[0], ' ');
        if (contentTokens(remainder).some(word => !MEETING_WORK_WORDS.has(word)
          && !statusWords.has(word) && !subject.has(word) && !ACTION_VERBS.has(word))) return false;
        if (sharedSubjectWords(unit.text, original) >= 2) return true;
        const at = context.indexById.get(unit.id), prior = context.rows[at - 1];
        return Boolean(prior && citedIds.has(prior.id) && /\b(?:it|that|this)\b/i.test(remainder)
          && sharedSubjectWords(prior.text, original) >= 2 && actionPredicateSupported(original, prior.text));
      });
      if (carrying) timing = { ...timing, kind: 'target', wording: String(carrying.text).match(qualifiedPhrase)[0] };
    }
    const flag = normaliseFlag({
      kind: 'uncertain_fact',
      message: `Action wording changed from "${original}" to "${softened}" because the cited commitment promises best-efforts progress, not completion.`,
      evidenceIds: action.evidenceIds || []
    }, flags.length);
    flags.push(flag);
    return { ...action, action: softened, timing, reviewFlagIds: [...new Set([...(action.reviewFlagIds || []), flag.id])] };
  });
  return { actions: checked, flags };
}

// ---- Usual practice is not an action ------------------------------------------
// In a case-study conversation ("First thing I go in, are there posters on the
// wall...", "In most cases the education comes from...") the model turns a
// description of how someone usually works into an action. When every cited
// line is habitual description and none takes on future work, the action is
// offered as a proposal instead of being published.
const HABITUAL_DESCRIPTION = /\b(?:usually|typically|normally|in most cases|generally|every time|whenever|what (?:we|i) (?:do|typically do|normally do) is|first thing (?:i|we)|when (?:i|we|you) (?:go|come) in|we (?:go|come) in|we ask them|we look at|we give them|we frame it|you know, you)\b/i;
const FUTURE_COMMITMENT = /\b(?:i|we)(?:'ll| will| am going to|'m going to|'m gonna)\b|\bnext (?:week|month|call)\b|\btomorrow\b|\bby (?:monday|tuesday|wednesday|thursday|friday|the end)\b|\bleave (?:it|that) with me\b/i;
function describesUsualPractice(action = {}, units = []) {
  const context = evidenceContextFor(units);
  const lines = [...new Set(action.evidenceIds || [])].map((id) => context.indexById.get(id)).filter(Number.isInteger)
    .map((index) => String(context.rows[index]?.text || ''));
  return lines.length > 0 && lines.every((line) => HABITUAL_DESCRIPTION.test(line)) && !lines.some((line) => FUTURE_COMMITMENT.test(line));
}

// ---- A named person must be in the row's own evidence -----------------------
// The minutes are read a row at a time, so a row reading "Rebecca has reviewed
// David's feedback" while citing only the line in which *David* does the
// reviewing tells the reader the opposite of what was said. Where a
// neighbouring line supplies the person the model cited one line short, so that
// line joins the citation. Where nothing supplies them, the wording is left
// alone and the row carries a flag: which name is right is the reviewer's call,
// not ours to guess.
const ATTRIBUTION_WINDOW = 2;
const ATTRIBUTION_SHARED_WORDS = 2;

function speakerIdentities(units = []) {
  return [...new Set(evidenceContextFor(units).rows.map((row) => row.speaker).filter(Boolean))]
    .map((label) => ({ label, parts: nameParts(label) }))
    .filter((person) => person.parts.length);
}

function personIsNamedIn(person, ...values) {
  const words = new Set(values.flatMap((value) => nameParts(value)));
  return person.parts.some((part) => words.has(part));
}

function groundRowAttributions(discussion = [], units = []) {
  const context = evidenceContextFor(units);
  const rows = context.rows;
  const people = speakerIdentities(units);
  const flags = [];
  let widened = 0;
  if (!people.length || !rows.length) return { discussion, widened, flags };

  const unsupported = (named, indexes) => {
    const words = new Set(indexes.flatMap((index) => [
      ...nameParts(rows[index]?.speaker), ...nameParts(rows[index]?.text)
    ]));
    return named.filter((person) => !person.parts.some((part) => words.has(part)));
  };

  const check = (record) => {
    const cited = [...new Set(record?.evidenceIds || [])]
      .map((id) => context.indexById.get(id)).filter(Number.isInteger);
    if (!cited.length) return record;
    const named = people.filter((person) => personIsNamedIn(person, record?.text));
    if (!named.length) return record;
    let missing = unsupported(named, cited);
    if (!missing.length) return record;

    // The line that names them usually sits a turn or two from what was cited.
    const rowWords = new Set(contentTokens(record?.text));
    const neighbours = [...new Set(cited.flatMap((index) => Array.from(
      { length: ATTRIBUTION_WINDOW * 2 + 1 }, (ignored, step) => index - ATTRIBUTION_WINDOW + step)))]
      .filter((index) => index >= 0 && index < rows.length && !cited.includes(index))
      .sort((a, b) => a - b);
    const added = [];
    for (const person of missing) {
      const source = neighbours.find((index) => personIsNamedIn(person, rows[index]?.text, rows[index]?.speaker)
        && contentTokens(rows[index]?.text).filter((word) => rowWords.has(word)).length >= ATTRIBUTION_SHARED_WORDS);
      if (Number.isInteger(source)) added.push(source);
    }
    let evidenceIds = [...new Set(record.evidenceIds || [])];
    if (added.length) {
      evidenceIds = [...new Set([...evidenceIds, ...added.map((index) => rows[index].id)])];
      widened += 1;
      missing = unsupported(named, [...new Set([...cited, ...added])]);
    }
    if (!missing.length) return { ...record, evidenceIds };
    const flag = normaliseFlag({
      kind: 'attribution',
      message: `Check who did this: the quoted evidence does not mention ${missing.map((person) => person.label).join(' or ')}. Confirm the name or reword the line.`,
      evidenceIds
    }, flags.length);
    flags.push(flag);
    return { ...record, evidenceIds, reviewFlagIds: [...new Set([...(record.reviewFlagIds || []), flag.id])] };
  };

  const checked = (Array.isArray(discussion) ? discussion : []).map((topic) => ({
    ...topic,
    points: (topic.points || []).map(check),
    decisions: (topic.decisions || []).map(check)
  }));
  return { discussion: checked, widened, flags };
}

// ---- Conflicting exclusive role assignments -------------------------------
// Discovery passes can each produce a locally plausible role statement while
// disagreeing about its holder. "A is the lead" and "B is the lead" are
// contradictory facts, not duplicates. Detect only explicit, singular role
// assignments in the same finished topic. ASR punctuation can make the source
// genuinely ambiguous, so this guard warns the reviewer and never guesses a
// winner or rewrites their wording.
const EXCLUSIVE_ROLE_QUALIFIER = '(?:audit|project|technical|software|design|workstream|meeting|team)';
const EXCLUSIVE_ROLE_NOUN = '(?:lead(?:\\s+auditor)?|chair(?:person)?|primary\\s+owner|overall\\s+owner|coordinator)';
const EXCLUSIVE_ROLE_PATTERN = new RegExp(`\\b(?:(?<qualifier>${EXCLUSIVE_ROLE_QUALIFIER})\\s+)?(?<role>${EXCLUSIVE_ROLE_NOUN})\\b`, 'i');
const NON_EXCLUSIVE_ROLE_PATTERN = /\b(?:co|joint|deputy|assistant)[ -](?:lead|chair|owner|coordinator)\b/i;
const HISTORICAL_ROLE_TRANSITION = /\b(?:previously|formerly|prior|last\s+(?:week|month|year|phase)|first\s+phase|until|before\s+the\s+handover|replaced\s+by|handed\s+over\s+to)\b/i;
const TOPIC_ROLE_QUALIFIER = /\b(audit|project|technical|software|design|workstream|meeting|team)\b/i;

function exclusiveRoleKey(roleMatch, topic = '') {
  const rawRole = String(roleMatch?.groups?.role || '').toLowerCase().replace(/\s+/g, ' ');
  const role = /chair/.test(rawRole) ? 'chair'
    : /owner/.test(rawRole) ? 'owner'
      : /coordinator/.test(rawRole) ? 'coordinator' : 'lead';
  let qualifier = String(roleMatch?.groups?.qualifier || '').toLowerCase();
  if (!qualifier && /lead auditor/.test(rawRole)) qualifier = 'audit';
  if (!qualifier) qualifier = String(topic).match(TOPIC_ROLE_QUALIFIER)?.[1]?.toLowerCase() || 'general';
  return `${qualifier}:${role}`;
}

function explicitExclusiveRoleAssignments(record = {}, topic = {}, people = []) {
  if (record?.reviewerAuthored === true || topic?.reviewerAuthored === true) return [];
  const value = text(record?.text, 1600);
  if (!value) return [];
  const clauses = value.split(/[.;!?]+|\s*,\s*(?=(?:with|while|whereas|and|but|working)\b)/i)
    .map((clause) => clause.trim()).filter(Boolean);
  const assignments = [];
  for (const clause of clauses) {
    if (NON_EXCLUSIVE_ROLE_PATTERN.test(clause) || HISTORICAL_ROLE_TRANSITION.test(clause)) continue;
    const roleMatch = clause.match(EXCLUSIVE_ROLE_PATTERN);
    if (!roleMatch) continue;
    // "a lead" is not exclusive. A qualified role or "the lead" is.
    const roleText = roleMatch[0];
    const nearbyRole = clause.slice(Math.max(0, roleMatch.index - 8), roleMatch.index + roleText.length);
    const definite = /\bthe\s+/i.test(nearbyRole) || Boolean(roleMatch.groups?.qualifier)
      || /lead\s+auditor|primary\s+owner|overall\s+owner/i.test(roleText);
    if (!definite) continue;
    const named = people.filter((person) => personIsNamedIn(person, clause));
    if (named.length !== 1) continue;
    const roleBeforePerson = new RegExp(`${EXCLUSIVE_ROLE_NOUN}[^,.]{0,60}\\b(?:is|was|will\\s+be|has\\s+been|identified\\s+as|named\\s+as|appointed\\s+as)\\b`, 'i').test(clause);
    const personBeforeRole = new RegExp(`\\b(?:is|was|will\\s+be|has\\s+been|serves?\\s+as|acts?\\s+as|identified\\s+as|named\\s+as|appointed\\s+as)\\b[^,.]{0,60}${EXCLUSIVE_ROLE_NOUN}`, 'i').test(clause);
    const leading = /\bleading\b(?!\s+to\b)/i.test(clause);
    if (!roleBeforePerson && !personBeforeRole && !leading) continue;
    assignments.push({
      roleKey: exclusiveRoleKey(roleMatch, topic?.topic),
      personKey: named[0].parts.join('|'),
      personLabel: canonicalSpeakerDisplayName(named[0].label),
      evidenceIds: [...new Set(record?.evidenceIds || [])]
    });
  }
  return assignments;
}

function flagConflictingDiscussionRoles(discussion = [], units = []) {
  const people = speakerIdentities(units);
  const cloned = (Array.isArray(discussion) ? discussion : []).map((topic) => ({
    ...topic,
    points: (topic?.points || []).map((record) => ({ ...record })),
    decisions: (topic?.decisions || []).map((record) => ({ ...record })),
    openQuestions: (topic?.openQuestions || []).map((record) => ({ ...record }))
  }));
  const flags = [];
  const conflicts = [];
  if (people.length < 2) return { discussion: cloned, flags, conflicts };

  cloned.forEach((topic, topicIndex) => {
    const assignments = [];
    for (const kind of ['points', 'decisions']) {
      (topic?.[kind] || []).forEach((record, rowIndex) => {
        for (const assignment of explicitExclusiveRoleAssignments(record, topic, people)) {
          assignments.push({ ...assignment, kind, rowIndex, record });
        }
      });
    }
    const byRole = new Map();
    for (const assignment of assignments) {
      if (!byRole.has(assignment.roleKey)) byRole.set(assignment.roleKey, []);
      byRole.get(assignment.roleKey).push(assignment);
    }
    for (const [roleKey, roleAssignments] of byRole) {
      const peopleByKey = new Map(roleAssignments.map((assignment) => [assignment.personKey, assignment.personLabel]));
      if (peopleByKey.size < 2) continue;
      const roleLabel = roleKey.split(':').join(' ');
      const personLabels = [...peopleByKey.values()].sort((left, right) => left.localeCompare(right));
      const evidenceIds = [...new Set(roleAssignments.flatMap((assignment) => assignment.evidenceIds))].slice(0, 8);
      const flag = normaliseFlag({
        kind: 'uncertain_fact',
        message: `Conflicting role assignment: this discussion assigns the same ${roleLabel} role to ${personLabels.join(' and ')}. Confirm the correct role holder against the linked transcript before publishing.`,
        evidenceIds
      }, topicIndex);
      flags.push(flag);
      for (const assignment of roleAssignments) {
        assignment.record.reviewFlagIds = [...new Set([...(assignment.record.reviewFlagIds || []), flag.id])];
      }
      conflicts.push({
        topicIndex, role: roleKey, people: personLabels,
        recordIds: [...new Set(roleAssignments.map((assignment) => text(assignment.record?.id, 80)).filter(Boolean))]
      });
    }
  });
  return { discussion: cloned, flags, conflicts };
}

// ---- Named facts belong in the minutes ------------------------------------
// The exported minutes contain the primary rows only, so a fact left in
// supporting context never reaches the reader. A context line naming a person
// or a date, which does not repeat a visible row, is promoted back - a few per
// meeting, so the Discussion does not fill up with secondary detail.
const FACT_DATE = /\b(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|next week|this week|end of (?:the )?(?:week|month)|\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?[A-Z][a-z]+|\d{4}-\d{2}-\d{2})\b/i;
// Counts and measurements are the facts readers look for and the first to be
// left behind in supporting context: "81%, up from 79%", "11 of 90 runs",
// "eighteen of twenty-two references", "thirty extra handouts".
const NUMBER_WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand';
const QUANTIFIED_FACT = new RegExp(String.raw`[£$€]\s?\d|\b\d[\d,.]*\s*(?:%|per\s?cent|k\b|kg\b|mg\b|ml\b|g\b|m\b)|\b\d[\d,.]*\s+(?:of\s+\d|[a-z]+s\b|(?:hours?|days?|weeks?|months?|years?|minutes?|seconds?|litres?|metres?|units?|people|staff|kg|tonnes?)\b)|\b(?:${NUMBER_WORDS})(?:[- ](?:${NUMBER_WORDS}))?\s+(?:of\s+(?:the\s+)?(?:${NUMBER_WORDS}|\d)|(?:[a-z]+\s+)?[a-z]{3,}s\b)`, 'i');
const NUMBER_WORD_VALUE = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90
};
// "four hundred pounds" and "£400" are the same figure, so a detail holding
// one must not count as new when the minutes already carry the other. Each
// run of number words contributes its composed value ("four hundred" -> 400,
// "twenty-two" -> 22) as well as its parts, so either spelling matches.
// `parts` controls whether the pieces of a spoken number count on their own.
// Matching what the minutes already say is generous (twenty-two matches 22,
// 20 and 2); deciding whether a detail is NEW uses composed values only, or
// "twenty-two" would look new beside "22" purely because 20 is not there.
function quantityTokens(value = '', parts = true) {
  const words = String(value || '').toLowerCase().replace(/[-–]/g, ' ');
  const found = new Set();
  const digits = words.match(/\d[\d,]*(?:\.\d+)?/g) || [];
  for (const digit of digits) {
    const number = Number(digit.replace(/,/g, ''));
    if (Number.isFinite(number)) found.add(String(number));
  }
  const tokens = words.match(/[a-z]+/g) || [];
  let current = 0;
  let running = 0;
  let open = false;
  const flush = () => {
    if (!open) return;
    const total = running + current;
    if (total) found.add(String(total));
    current = 0; running = 0; open = false;
  };
  for (const token of tokens) {
    if (NUMBER_WORD_VALUE[token] != null) {
      current += NUMBER_WORD_VALUE[token];
      if (parts && NUMBER_WORD_VALUE[token] !== 1) found.add(String(NUMBER_WORD_VALUE[token]));
      open = true;
    } else if (token === 'hundred') {
      // "a thousand pints" and "over a hundred" carry a figure of their own,
      // with no number word in front of them.
      current = (current || 1) * 100;
      open = true;
      found.add(String(running + current));
    } else if (token === 'thousand') {
      running += (current || 1) * 1000;
      current = 0;
      open = true;
      found.add(String(running));
    } else flush();
  }
  flush();
  found.delete('1');
  return found;
}

function promoteNamedFactDetails(discussion = [], units = [], people = [], limit = 4, quantityLimit = 6) {
  const names = [...new Set([...(Array.isArray(people) ? people : []), ...mentionedPeople(units)])]
    .map((person) => text(person, 180).split(/\s+/)[0]).filter((name) => name.length > 2);
  const visible = (Array.isArray(discussion) ? discussion : [])
    .flatMap((topic) => ['points', 'decisions', 'openQuestions'].flatMap((kind) => topic?.[kind] || []));
  const said = (value) => names.some((name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(value)) || FACT_DATE.test(value);
  const restates = (value) => visible.some((record) => {
    const left = contentTokens(comparisonText(value)); const right = contentTokens(comparisonText(record?.text || ''));
    if (!left.length || !right.length) return false;
    const shared = left.filter((token) => right.includes(token)).length;
    return shared / Math.min(left.length, right.length) >= 0.5;
  });
  // Raw speech and run-together transcription ("the.Bottomed out") are not
  // minutes: they stay in context whatever they mention.
  const context = evidenceContextFor(units);
  const readable = (value) => !/^\s*(?:so|yeah|yes|no|okay|ok|well|and|but|i|we|you|your)\b/i.test(value)
    && !/[a-z]\.[A-Z]/.test(value)
    && !(value.match(/\b(?:kind of|sort of|you know|i mean|i suppose)\b/gi) || []).length;
  const verbatim = (value, ids) => (ids || []).some((id) => {
    const unit = context.rows[context.indexById.get(id)];
    if (!unit) return false;
    const left = contentTokens(comparisonText(value)); const right = contentTokens(comparisonText(unit.text));
    if (!left.length || !right.length) return false;
    return left.filter((token) => right.includes(token)).length / Math.min(left.length, right.length) >= 0.8;
  });
  // A quantified detail is new unless a visible row already carries all of
  // its figures; a row that restates the topic without the numbers does not.
  const visibleQuantities = new Set(visible.flatMap((record) => [...quantityTokens(record?.text || '')]));
  const newQuantity = (value) => {
    if (!QUANTIFIED_FACT.test(value)) return false;
    const figures = [...quantityTokens(value, false)];
    return figures.length > 0 && figures.some((figure) => !visibleQuantities.has(figure));
  };
  // A visible row that already states these figures in substantially the same
  // words. Looser on wording than `restates` because the two versions differ
  // by notation ("forty kegs ... fifteen casks" against "40 kegs ... 15
  // casks"), and tightened by requiring a figure in common.
  const repeatsVisibleFigures = (value) => {
    const figures = quantityTokens(value, false);
    if (!figures.size) return false;
    const left = contentTokens(comparisonText(value));
    if (!left.length) return false;
    return visible.some((record) => {
      const rowFigures = quantityTokens(record?.text || '');
      if (![...figures].some((figure) => rowFigures.has(figure))) return false;
      const right = contentTokens(comparisonText(record?.text || ''));
      if (!right.length) return false;
      const shared = left.filter((token) => right.includes(token)).length;
      return shared / Math.min(left.length, right.length) >= 0.38;
    });
  };
  let promoted = 0;
  let quantitiesPromoted = 0;
  // The loose visible-row comparison deliberately stays unchanged. Applying
  // it to new promotions could hide a different fact such as approval versus
  // testing. Only an identical full-text/evidence identity may skip promotion.
  const promotedIdentities = new Set();
  const checked = (Array.isArray(discussion) ? discussion : []).map((topic) => {
    if (isReviewerAuthored(topic)) return topic;
    const next = { ...topic };
    const additions = [];
    for (const kind of ['points', 'decisions', 'openQuestions']) {
      if (!Array.isArray(topic?.[kind])) continue;
      next[kind] = topic[kind].map((record) => {
        if (isReviewerAuthored(record)) return record;
        const details = Array.isArray(record?.supportingDetails) ? record.supportingDetails : [];
        if (!details.length) return record;
        const kept = [];
        for (const detail of details) {
          const value = text(detail?.text, 800);
          const identity = JSON.stringify([String(detail?.text || ''), [...new Set(detail?.evidenceIds || [])].sort()]);
          const eligible = !isReviewerAuthored(detail) && !promotedIdentities.has(identity)
            && value && !value.startsWith(SUPERSEDED_LABEL) && (detail.evidenceIds || []).length
            && readable(value) && !verbatim(value, detail.evidenceIds);
          const named = eligible && promoted < limit && said(value) && !restates(value);
          // One new figure inside a line that otherwise repeats a visible row is
          // not worth a second row: "the initial request was for forty kegs,
          // reduced to fifteen casks (nine-gallon firkins)" beside "originally
          // requested 40 kegs; negotiated down to 15 casks". The named path has
          // always applied this test; the quantified path now does too.
          const quantified = eligible && !named && quantitiesPromoted < quantityLimit
            && newQuantity(value) && !repeatsVisibleFigures(value);
          if (named || quantified) {
            promotedIdentities.add(identity);
            additions.push({ id: detail.id || stableId('promoted', value, promoted + quantitiesPromoted), text: value,
              evidenceIds: [...(detail.evidenceIds || [])], reviewFlagIds: [...(detail.reviewFlagIds || [])], supportingDetails: [] });
            if (quantified) {
              quantitiesPromoted += 1;
              quantityTokens(value).forEach((figure) => visibleQuantities.add(figure));
            } else promoted += 1;
            continue;
          }
          kept.push(detail);
        }
        return kept.length === details.length ? record : { ...record, supportingDetails: kept };
      });
    }
    if (additions.length) next.points = [...(next.points || []), ...additions];
    return next;
  });
  return { discussion: checked, promoted: promoted + quantitiesPromoted, quantitiesPromoted };
}

// Refusals and objections materially change the meaning of a meeting record.
// They must not disappear merely because a publication pass classified them
// as supporting context. Promote only already-written, evidence-linked minute
// prose; never copy or manufacture transcript wording here.
const MATERIAL_OBJECTION = /\b(?:will not|won't|would not|wouldn't|not going to|refus(?:e|ed|al)|declin(?:e|ed)|object(?:ed|ion)?|oppos(?:e|ed|ition)|did not agree|does not agree|cannot agree|can't agree|not accept(?:ed)?|would not accept|not acted (?:on|upon)|already (?:said|tried|agreed|decided)|same (?:issue|plan|proposal|promise).{0,30}(?:last|previous))\b/i;
function promoteMaterialObjectionDetails(discussion = [], limit = 6) {
  const visible = (Array.isArray(discussion) ? discussion : [])
    .flatMap((topic) => ['points', 'decisions', 'openQuestions'].flatMap((kind) => topic?.[kind] || []));
  const repeatsVisible = (value) => visible.some((record) => tokenOverlap(value, record?.text || '') >= 0.78);
  const readable = (value) => !/^\s*(?:so|yeah|yes|okay|ok|well|and|but|i|we|you)\b/i.test(value)
    && !/[a-z]\.[A-Z]/.test(value);
  let promoted = 0;
  const checked = (Array.isArray(discussion) ? discussion : []).map((topic) => {
    const next = { ...topic };
    const additions = [];
    for (const kind of ['points', 'decisions', 'openQuestions']) {
      next[kind] = (topic?.[kind] || []).map((record) => {
        const details = Array.isArray(record?.supportingDetails) ? record.supportingDetails : [];
        const kept = [];
        for (const detail of details) {
          const value = text(detail?.text, 800);
          if (promoted < limit && value && MATERIAL_OBJECTION.test(value)
            && (detail.evidenceIds || []).length && readable(value) && !repeatsVisible(value)) {
            additions.push({ id: detail.id || stableId('objection', value, promoted), text: value,
              evidenceIds: [...detail.evidenceIds], reviewFlagIds: [...(detail.reviewFlagIds || [])], supportingDetails: [] });
            visible.push(additions[additions.length - 1]);
            promoted += 1;
          } else kept.push(detail);
        }
        return kept.length === details.length ? record : { ...record, supportingDetails: kept };
      });
    }
    if (additions.length) next.points = [...(next.points || []), ...additions];
    return next;
  });
  return { discussion: checked, promoted };
}

// ---- Decision check -------------------------------------------------------
// A Discussion row keeps the "decision" label only when the model quotes the
// words in its passage that make or accept the choice, and the quote is found
// there. Everything else becomes an ordinary point with its wording unchanged.
// The check only ever demotes: tested on real meetings, promoting points was
// too noisy to trust.
function decisionCheckEnabled() {
  return /^(?:1|true|yes|on)$/i.test(String(process.env.MEETING_MINUTES_AGENT_DECISION_CHECK_V1 || '0'));
}

function decisionCheckItems(discussion = [], units = []) {
  const items = [];
  (Array.isArray(discussion) ? discussion : []).forEach((topic, topicIndex) => {
    (Array.isArray(topic?.decisions) ? topic.decisions : []).forEach((record, rowIndex) => {
      const passage = evidenceWindowUnits(units, record?.evidenceIds || [], 2).slice(0, 24)
        .map((unit) => `${unit.speaker}: ${unit.text}`);
      if (!passage.length || !text(record?.text)) return;
      items.push({ id: `d${items.length + 1}`, topicIndex, rowIndex, row: text(record.text, 800), passage: passage.join('\n') });
    });
  });
  return items;
}

function decisionCheckPrompt(items = []) {
  return [
    'ACTION_CRITIC_DECISION',
    'You check which meeting-minutes rows record a decision. Each item gives a row and the transcript passage it was drawn from. The passage is the only authority.',
    `A decision is a choice the meeting settled: someone in the meeting chose a course of action, approved or rejected something, ruled something in or out, or the participants agreed what will be done. Examples: "I've made the decision we are covering it", "let's set up sessions on Wednesday, Thursday and Friday", "we'll go with option B", "that is approved".`,
    'These are NOT decisions: status or progress updates, lists of next steps in an update, work already done, descriptions of how a process, tool or regulation works, facts, explanations, opinions, goals described as probable, an idea people liked without settling what will happen, a suggestion or proposal nobody accepted, a question, a routine task someone will do, a matter parked or deferred for later thought, a hedged possibility, and anything decided, scheduled or to be approved outside this meeting that is only being reported. A refusal may be material, but it is a decision only when the row accurately records the rejection rather than reversing it into agreement.',
    `The decisionQuote must be the words that make or accept the choice (for example "let's", "we'll", "I've decided", "agreed", "go ahead"), not words that merely mention the topic.`,
    'For each item give verdict "decision" or "not_decision". For "decision" give decisionQuote: the exact words in the passage where the choice is made or agreed, copied verbatim as one contiguous span of at most 25 words. Never paraphrase a quote. If you are unsure, choose "not_decision".',
    'Return only this JSON object: {"schemaVersion":1,"results":[{"id":"","verdict":"","decisionQuote":"","reason":""}]}',
    `ITEMS:\n${JSON.stringify(items.map((item) => ({ id: item.id, row: item.row, passage: item.passage })))}`
  ].join('\n\n');
}

// A quote may run across adjacent lines; speaker labels are not spoken words.
// Prompts ask for short quotations, but a longer exact quotation is still
// stronger evidence than a truncated or paraphrased one. Keep the hard limit
// generous enough for a complete spoken sentence while still bounding input.
function decisionQuoteValidation(quote, passage, maxWords = 120, options = {}) {
  const flat = (value) => quoteText(value).replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  // Keep the existing normalization, but a substring must cover complete
  // tokens. A standalone apostrophe can be a quotation mark; an apostrophe
  // inside can't, O'Brien or Ann's cannot bound a shorter quoted word.
  const boundary = (value, index, direction) => index < 0 || index >= value.length
    || value[index] === ' ' || (value[index] === "'" && (index + direction < 0
      || index + direction >= value.length || value[index + direction] === ' '));
  const containsCompleteQuote = (value, quotedText, onMatch) => {
    if (!quotedText) return false;
    let found = false;
    for (let index = value.indexOf(quotedText); index >= 0; index = value.indexOf(quotedText, index + 1)) {
      if (boundary(value, index - 1, -1) && boundary(value, index + quotedText.length, 1)) {
        if (!onMatch) return true;
        onMatch({ start: index, end: index + quotedText.length });
        found = true;
      }
    }
    return found;
  };
  const stripSpeakerPrefix = value => String(value || '').replace(/^[^:]{2,40}:\s*/, (prefix, _offset, source) => {
    const colon = prefix.indexOf(':');
    // A clock inside a short sentence is spoken content, not a speaker label.
    const clock = /(?:^|[^\d])\d{1,2}$/.test(prefix.slice(0, colon))
      && /^\d{2}(?!\d)/.test(source.slice(colon + 1));
    return clock && options.allowClockPrefix ? prefix : '';
  });
  const quoted = stripSpeakerPrefix(quote);
  const needle = flat(quoted);
  const words = needle ? needle.split(' ').length : 0;
  // Punctuation must not turn one spoken clock (or its zone offset) into
  // several words and satisfy the minimum evidence length by itself.
  const minimumText = flat(quoted.replace(/\b(?:UTC|GMT)\s*[+-]\s*\d{1,2}(?::?\d{2})?\b/gi, 'zone')
    .replace(/(?<!\d)\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:am|pm)\b)?(?!\d)/gi, 'clock'));
  const minimumWords = minimumText ? minimumText.split(' ').length : 0;
  if (minimumWords < 3) return { valid: false, reason: 'quote_too_short', words: minimumWords };
  if (words > maxWords) return { valid: false, reason: 'quote_too_long', words };
  const spoken = String(passage || '').split('\n').map(stripSpeakerPrefix).join(' ');
  // Positions use this same normalized spoken passage for both quotations.
  // Existing consumers keep their boolean matching and result shape.
  const positions = [];
  const valid = containsCompleteQuote(flat(spoken), needle,
    options.includePositions === true ? match => positions.push(match) : undefined);
  // Only temporal consumers opt in to the corrected clock parsing. A newly
  // accepted quote must then prove the complete source proposition, or supply
  // a validated structured temporal witness; quotation alone is insufficient.
  const legacyStrip = value => String(value || '').replace(/^[^:]{2,40}:\s*/, '');
  const legacyNeedle = flat(legacyStrip(quote));
  const legacyWords = legacyNeedle ? legacyNeedle.split(' ').length : 0;
  const legacyValid = legacyWords >= 3 && legacyWords <= maxWords
    && containsCompleteQuote(flat(String(passage || '').split('\n').map(legacyStrip).join(' ')), legacyNeedle);
  return { valid, reason: valid ? '' : 'quote_not_found', words,
    ...(options.includePositions === true ? { positions } : {}),
    ...(valid && !legacyValid ? { requiresLiteralSource: true } : {}) };
}

function decisionQuoteFound(quote, passage, maxWords = 120) {
  return decisionQuoteValidation(quote, passage, maxWords).valid;
}

function decisionPolarityIssue(row = '', passage = '') {
  const wording = text(row, 1200);
  const evidence = text(passage, 6000);
  const explicitNegativeDecision = /^(?:decision\s+(?:is|to|that)\s+)?(?:do not|don['’]?t|not to|reject|decline|rule out|stop|cancel)\b/i.test(wording);
  if (/\b(?:possibly|maybe|perhaps|might|could potentially|not sure)\b/i.test(wording)) return 'hedged_outcome';
  if (/\b(?:park(?:ed|ing)?|defer(?:red|ring)?|revisit|reconvene|come back (?:to|on|next)|think about (?:it|this|the))\b/i.test(wording)) return 'deferred_outcome';
  const unresolvedEvidence = /\b(?:no clear|no obvious)\s+answer\b|\b(?:not|hasn['’]?t|haven['’]?t)\s+(?:yet\s+)?(?:decided|agreed|resolved|confirmed)\b/i.test(evidence);
  const settledEvidence = /\b(?:we|the (?:team|group|board|committee))\s+(?:decided|agreed|approved|accepted|selected|rejected|declined|ruled out)\b|\b(?:that|it)\s+(?:is|was)\s+(?:approved|agreed|decided|settled|rejected)\b/i.test(evidence);
  if (unresolvedEvidence && !settledEvidence) return 'unresolved_evidence';
  const refusal = /\b(?:will not|won['’]?t|not going to|do not agree|don['’]?t agree|cannot accept|can['’]?t accept|refus(?:e|ed)|declin(?:e|ed)|argu(?:e|ed) against)\b/i.test(evidence);
  if (refusal && !explicitNegativeDecision) return 'polarity_mismatch';
  return '';
}

function demotedDecisionRecord(record = {}) {
  const wording = text(record?.text, 1200)
    .replace(/^decision\s+(?:is\s+|to\s+|that\s+|:\s*)/i, '')
    .trim();
  return wording && wording !== record.text ? { ...record, text: wording.charAt(0).toUpperCase() + wording.slice(1) } : record;
}

// Items with no verdict (a failed call) keep their label.
function applyDecisionCheckResults(discussion = [], items = [], results = []) {
  const verdicts = new Map((Array.isArray(results) ? results : []).map((row) => [text(row?.id, 20), row || {}]));
  const demote = new Map();
  for (const item of items) {
    if (decisionPolarityIssue(item.row, item.passage)) {
      if (!demote.has(item.topicIndex)) demote.set(item.topicIndex, new Set());
      demote.get(item.topicIndex).add(item.rowIndex);
      continue;
    }
    const row = verdicts.get(item.id);
    if (!row || !['decision', 'not_decision'].includes(row.verdict)) continue;
    if (row.verdict === 'decision' && decisionQuoteFound(row.decisionQuote, item.passage)) continue;
    if (!demote.has(item.topicIndex)) demote.set(item.topicIndex, new Set());
    demote.get(item.topicIndex).add(item.rowIndex);
  }
  let demoted = 0;
  const checked = (Array.isArray(discussion) ? discussion : []).map((topic, topicIndex) => {
    const rows = demote.get(topicIndex);
    if (!rows || !Array.isArray(topic?.decisions)) return topic;
    const moved = topic.decisions.filter((_, rowIndex) => rows.has(rowIndex)).map(demotedDecisionRecord);
    demoted += moved.length;
    return {
      ...topic,
      decisions: topic.decisions.filter((_, rowIndex) => !rows.has(rowIndex)),
      points: [...(Array.isArray(topic.points) ? topic.points : []), ...moved]
    };
  });
  return { discussion: checked, demoted, checked: items.length };
}

// ---- Discussion evidence fidelity ----------------------------------------
// A row can cite the right passage while reversing a count, condition, cause,
// responsibility or milestone during compression. Check generated propositions
// within the bounded item budget, and accept a correction only when both the
// generated problem and correcting transcript words are quoted verbatim.
function discussionFidelityCheckItems(discussion = [], units = [], options = {}) {
  const items = [];
  const temporalPeople = [...new Set([
    ...(Array.isArray(units) ? units : []).map(unit => unit?.speaker),
    ...(Array.isArray(options.people) ? options.people : [])
  ].filter(person => typeof person === 'string' && person.trim()))];
  (Array.isArray(discussion) ? discussion : []).forEach((topic, topicIndex) => {
    if (isReviewerAuthored(topic)) return;
    const append = (record, path, kind, rowIndex) => {
      if (!record || isReviewerAuthored(record)) return;
      const row = text(record.text, 1600);
      if (row) {
        const packet = boundedReviewEvidence(record, units);
        items.push({
          id: `df${items.length + 1}`, topicIndex, kind, rowIndex, path, row,
          meetingDate: options.meetingDate || '',
          temporalPeople,
          evidenceIds: [...new Set(record.evidenceIds || [])],
          contextCoverage: packet.coverage,
          passage: packet.units.map(unit => `[${unit.id}] ${unit.speaker}: ${unit.text}`).join('\n'),
          passageUnits: packet.units.map(unit => ({ id: unit.id, speaker: unit.speaker, text: unit.text }))
        });
      }
      (record.supportingDetails || []).forEach((detail, detailIndex) => append(detail,
        [...path, 'supportingDetails', detailIndex], kind, rowIndex));
    };
    for (const kind of ['points', 'decisions', 'openQuestions']) {
      (topic?.[kind] || []).forEach((record, rowIndex) => {
        append(record, [topicIndex, kind, rowIndex], kind, rowIndex);
      });
    }
  });
  return items;
}

function discussionFidelityCheckPrompt(items = []) {
  const { temporalEvidencePromptInstructions } = require('./meetingMinutesTemporalReview');
  return [
    'DISCUSSION_CRITIC_EVIDENCE_FIDELITY',
    'Each item contains a proposed meeting-minutes sentence and its nearby transcript passage. The passage is the only authority. Check fidelity to what participants said; do not supply outside-domain knowledge.',
    'Look for changed counts, reversed cause/responsibility/direction, a condition rewritten as a requirement, a planning milestone rewritten as completion or rollout, hopes rewritten as commitments, past work rewritten as future work, unsupported certainty, unexplained transcript shorthand, and compressed note fragments that are not clear client-ready sentences.',
    'Also look for added specifics: a date, month, year, weekday, number, name, place, or someone\'s opinion, taste or attitude that no line of the passage states. A day spoken without its month does not tell you the month. An added specific is not a matter of doubt: remove it with "corrected", or choose "uncertain" with issue "added_detail" when the row cannot stand without it.',
    'Small talk, jokes and personal tastes that do not affect the work, its timing or its logistics are not minutes material: choose "uncertain" with issue "small_talk".',
    'When one row mixes a real operational constraint with a joke or an invented alternative activity, use a source-quoted correction that retains the real constraint and removes the joke. Do not turn humorous alternatives into a contingency plan, or discard genuine transport, access or cost information merely because the exchange was light-hearted.',
    'For enumerated behaviour, preserve every source pairing: do not collapse distinct states, priorities, quantities or outcomes into one generic description.',
    'When the row asserts a cost, resource or operational constraint, retain the concrete source amount or quantity that explains that same constraint. Do not replace a stated balance or capacity with vague insufficient resources. Add a quantity only when the passage explicitly binds it to that subject; do not borrow a number from a neighbouring topic, convert an estimate to an approved budget, or invent missing facts.',
    'When a later statement qualifies an earlier date for the same work, the later clarification controls. A preferred date and a fallback or hard stop must be preserved together; do not publish the earlier date alone as an unconditional deadline. Correct the row to one current account so a later deduplication pass can remove obsolete restatements.',
    'Do not infer that a current-period condition caused a previous-period result merely because the statements are adjacent. Preserve comparison wording and time direction exactly.',
    'Replace unresolved labels such as "the speaker" only when the passage identifies the person; otherwise choose "uncertain".',
    'Choose "supported", "corrected", or "uncertain". Use "corrected" only when one accurate, complete, client-ready replacement sentence can be written from the passage. Use "uncertain" when the row appears wrong but the passage does not support a safe replacement.',
    'For "corrected", provide problemQuote copied exactly from the proposed row, evidenceQuote copied exactly from the transcript passage, and correctedText. Preserve qualifications and sequence; never merge different people or workstreams. Set issue to "temporal_qualification" only when the evidenceQuote explicitly qualifies or replaces an earlier timing for the same work.',
    'For "supported" rows containing timing, dates, durations, recurrence or dependencies, also provide evidenceQuote: a contiguous source quote of at most 25 words that supports this same work and its temporal meaning. This applies equally to supporting details and open questions. Do not approve a target merely because a neighbouring call has that timetable.',
    temporalEvidencePromptInstructions(),
    'For "uncertain", provide problemQuote, and evidenceQuote where the passage has one; an added specific has nothing to quote, so leave evidenceQuote empty. Quotes must be contiguous and at most 25 words. For a temporal row, choose "uncertain" if its work, timing, qualifications or source alignment cannot be established; do not label an unresolved temporal claim supported. For a non-temporal row, if unsure whether meaning changed, choose "supported".',
    'Set issue to "added_detail", "small_talk" or "temporal_qualification" only for those cases and leave it empty otherwise.',
    'Return only this JSON object: {"schemaVersion":1,"results":[{"id":"","verdict":"","issue":"","problemQuote":"","evidenceQuote":"","correctedText":"","reason":""}]}',
    `ITEMS:\n${JSON.stringify(items.map((item) => ({ id: item.id, row: item.row, passage: item.passage,
      evidenceIds: item.evidenceIds || [], sourceRecords: (item.passageUnits || []).map(unit => ({
        id: unit.id, type: 'discussion', speaker: unit.speaker, text: unit.text
      })) })))}`
  ].join('\n\n');
}

function applySourceDiscussionFidelityResults(discussion = [], items = [], results = [], options = {}) {
  const verdicts = new Map((Array.isArray(results) ? results : []).map((row) => [text(row?.id, 20), row || {}]));
  const replacements = new Map();
  const warnings = new Map();
  const rejected = [];
  for (const item of items) {
    const row = verdicts.get(item.id);
    if (!row || !['corrected', 'uncertain'].includes(row.verdict)) continue;
    const Temporal = require('./meetingMinutesTemporalReview');
    const boundTemporal = options.temporalBindings?.has(item.id) === true;
    const quoteOptions = { allowClockPrefix: boundTemporal || Temporal.temporalClaim(row.correctedText || item.row) };
    const problemCheck = decisionQuoteValidation(row.problemQuote, item.row, 120, quoteOptions);
    // A claim the passage never makes (an added month, an attitude nobody
    // voiced) has no transcript words to quote. An "uncertain" verdict may
    // therefore stand on the quoted problem alone; a supplied evidence quote
    // must still be real, and a correction always needs one.
    const noEvidenceQuote = row.verdict === 'uncertain' && !text(row.evidenceQuote, 400);
    const evidenceCheck = noEvidenceQuote ? { valid: true } : decisionQuoteValidation(row.evidenceQuote, item.passage, 120, quoteOptions);
    if (!problemCheck.valid || !evidenceCheck.valid) {
      rejected.push({ id: item.id, verdict: row.verdict, reason: !problemCheck.valid ? `problem_${problemCheck.reason}` : `evidence_${evidenceCheck.reason}` });
      continue;
    }
    const key = `${item.topicIndex}|${item.kind}|${item.rowIndex}`;
    if (row.verdict === 'uncertain') { warnings.set(key, row); continue; }
    const correctedText = text(row.correctedText, 1000);
    if (!correctedText || /\.\.\.|\w\.[A-Z]/.test(correctedText)) {
      rejected.push({ id: item.id, verdict: row.verdict, reason: 'invalid_corrected_text' });
      continue;
    }
    if (!boundTemporal && (problemCheck.requiresLiteralSource || evidenceCheck.requiresLiteralSource)) {
      const ownIds = new Set(item.evidenceIds || []);
      const literalOwnSource = (item.passageUnits || []).some(unit => ownIds.has(unit.id)
        && decisionQuoteValidation(row.evidenceQuote, unit.text, 120, quoteOptions).valid
        && Temporal.literalTemporalPropositionMatch(correctedText, unit.text));
      if (!literalOwnSource) {
        rejected.push({ id: item.id, verdict: row.verdict, reason: 'temporal_source_binding_not_proved' });
        continue;
      }
    }
    if (evidenceSupportScore(correctedText, item.passage) < 0.42) {
      rejected.push({ id: item.id, verdict: row.verdict, reason: 'support_too_low' });
      continue;
    }
    const ownIds = new Set(item.evidenceIds || []);
    const sources = [...(item.passageUnits || [])].sort((a, b) => Number(ownIds.has(b.id)) - Number(ownIds.has(a.id)));
    // The existing temporal binding validates the complete corrected work,
    // phase, actor and qualifications before placing an item in this map. Do
    // not replace that stronger proof with a literal-only paraphrase veto.
    const meaning = boundTemporal ? { sourceIds: [] } : correctionMeaningIssue(item.row, correctedText, sources);
    if (meaning.reason) {
      rejected.push({ id: item.id, verdict: row.verdict, reason: meaning.reason });
      continue;
    }
    // Broader context can reveal a problem, but cannot donate a new assertion
    // without a complete citation reallocation. That separate repair remains
    // out of scope: require this assertion's witness in the row's own sources.
    if (meaning.sourceIds.some(id => !(item.evidenceIds || []).includes(id))) {
      rejected.push({ id: item.id, verdict: row.verdict, reason: 'correction_assertion_source_not_cited' });
      continue;
    }
    replacements.set(key, { ...row, correctedText });
  }
  const flags = [];
  const withheld = [];
  let corrected = 0;
  let uncertain = 0;
  const checked = (Array.isArray(discussion) ? discussion : []).map((topic, topicIndex) => {
    const next = { ...topic };
    for (const kind of ['points', 'decisions']) {
      next[kind] = (topic?.[kind] || []).map((record, rowIndex) => {
        if (isReviewerAuthored(topic) || isReviewerAuthored(record)) return record;
        const key = `${topicIndex}|${kind}|${rowIndex}`;
        const replacement = replacements.get(key);
        const warning = warnings.get(key);
        if (!replacement && !warning) return record;
        const result = replacement || warning;
        const issue = text(result.issue, 30);
        // A quote-verified later timing clarification is ordinary editorial
        // reconciliation, not another task for the reviewer. Apply it quietly
        // and cite the later source line; uncertain or general corrections keep
        // the established visible review flag.
        const automaticTemporalCorrection = Boolean(replacement)
          && issue === 'temporal_qualification'
          && /\b(?:instead of|rather than|not (?:the )?hard stop|ideally|preferred?|if needed|contingenc(?:y|ies)|fallback|hard stop)\b/i.test(result.evidenceQuote || '')
          && hasTimingSignal(replacement.correctedText);
        if (automaticTemporalCorrection) {
          const evidenceNeedle = quoteText(result.evidenceQuote);
          const laterEvidence = (items.find((item) => `${item.topicIndex}|${item.kind}|${item.rowIndex}` === key)?.passageUnits || [])
            .filter((unit) => quoteText(unit.text).includes(evidenceNeedle) || evidenceNeedle.includes(quoteText(unit.text)))
            .map((unit) => unit.id);
          corrected += 1;
          return {
            ...record,
            text: replacement.correctedText,
            evidenceIds: [...new Set([...(record.evidenceIds || []), ...laterEvidence])].slice(0, 12)
          };
        }
        // A general "check this" warning stays quiet unless its reason names a
        // material doubt. An added detail or small talk is always worth a look,
        // so those say so in words the reviewer-burden filter keeps.
        const warningMessage = issue === 'added_detail'
          ? `Cannot verify "${text(result.problemQuote, 180)}" in the cited passage; confirm it or remove it.`
          : issue === 'small_talk'
            ? `Not clear whether this belongs in the minutes: it reads as small talk. ${text(result.reason, 200)}`.trim()
            : `Check this sentence against the cited passage: ${text(result.reason, 260) || 'the wording may change the meaning.'}`;
        const flag = normaliseFlag({
          ...(!replacement && !['added_detail', 'small_talk'].includes(issue)
            ? { id: stableId('flag-fidelity-meaning', `${record.id}|${record.text}|${result.reason}`, 0) } : {}),
          kind: 'uncertain_fact',
          message: replacement
            ? `Wording corrected against the cited passage: "${text(result.problemQuote, 180)}" → "${replacement.correctedText}".`
            : warningMessage,
          evidenceIds: record.evidenceIds || []
        }, flags.length);
        flags.push(flag);
        if (replacement) corrected += 1; else uncertain += 1;
        const withholdSmallTalk = issue === 'small_talk' && text(result.evidenceQuote, 400)
          && !hasSupportedOperationalEffect(record.text, items.find((item) => `${item.topicIndex}|${item.kind}|${item.rowIndex}` === key));
        const withholdUnsupportedAssertion = issue === 'added_detail'
          && !isCautiousDiscussionClaim(record.text);
        if (!replacement && (withholdSmallTalk || withholdUnsupportedAssertion)
          && !hasReviewerAuthoredSupportingDetail(record)) {
          const description = withholdSmallTalk ? 'conversational aside' : 'unverified assertion';
          flag.message = `Cannot verify this ${description} as main-minutes content; withheld for source review: "${text(record.text, 700)}". ${text(result.reason, 200)}`;
          withheld.push({
            topicId: topic.id || '', topic: topic.topic || '', kind,
            record: { ...record, reviewFlagIds: [...new Set([...(record.reviewFlagIds || []), flag.id])] },
            issue, reason: text(result.reason, 500), evidenceIds: record.evidenceIds || [], reviewFlagId: flag.id
          });
          return null;
        }
        return replacement
          ? { ...record, text: replacement.correctedText, reviewFlagIds: [...new Set([...(record.reviewFlagIds || []), flag.id])] }
          : { ...record, reviewFlagIds: [...new Set([...(record.reviewFlagIds || []), flag.id])] };
      }).filter(Boolean);
    }
    return next;
  });
  return { discussion: checked, flags, withheld, checked: items.length, corrected, uncertain, rejected };
}

function applyDiscussionFidelityResults(discussion = [], items = [], results = []) {
  const indexed = indexReviewResults(items, results, ['supported', 'corrected', 'uncertain']);
  const atPath = path => path.reduce((value, key) => value?.[key], discussion);
  const temporalContext = (item, record) => {
    const ownIds = new Set(record?.evidenceIds || []);
    const sourceRecords = (item.passageUnits || []).filter(unit => ownIds.has(unit.id));
    return { people: item.temporalPeople,
      sourceRecords, sourceContextComplete: ownIds.size > 0 && [...ownIds].every(id =>
        sourceRecords.some(unit => unit.id === id && typeof unit.text === 'string' && unit.text.trim())) };
  };
  const synthetic = [], mappedItems = [], sourceBySynthetic = new Map();
  for (const item of items) {
    const path = item.path || [item.topicIndex, item.kind, item.rowIndex];
    const record = atPath(path), topic = discussion[item.topicIndex];
    if (!record || text(record.text, 1600) !== item.row) {
      indexed.states.set(item.id, { id: item.id, status: 'stale', reason: 'stale_discussion_snapshot' });
      continue;
    }
    if (isReviewerAuthored(topic) || isReviewerAuthored(record)) {
      indexed.states.set(item.id, { id: item.id, status: 'supported', reason: 'reviewer_wording_preserved' });
      continue;
    }
    const syntheticIndex = synthetic.length;
    synthetic.push({ id: `fidelity-row-${syntheticIndex}`, topic: topic?.topic || '', points: [record], decisions: [] });
    const mapped = { ...item, topicIndex: syntheticIndex, kind: 'points', rowIndex: 0,
      evidenceIds: [...new Set(record.evidenceIds || [])] };
    mappedItems.push(mapped);
    sourceBySynthetic.set(syntheticIndex, { item, path, record, topic });
    if (item.contextCoverage?.omittedAnchorIds?.length || !item.passage) {
      indexed.byId.delete(item.id);
      indexed.states.set(item.id, { id: item.id, status: 'rejected', reason: 'incomplete_evidence_context' });
    }
  }
  const accepted = [];
  const temporalBindings = new Map();
  for (const item of mappedItems) {
    const row = indexed.byId.get(item.id);
    if (!row) continue;
    if (['problemQuote', 'evidenceQuote', 'correctedText', 'issue', 'reason'].some(key => row[key] !== undefined && typeof row[key] !== 'string')) {
      indexed.states.set(item.id, { id: item.id, status: 'malformed', reason: 'malformed_fidelity_result' });
      continue;
    }
    const Temporal = require('./meetingMinutesTemporalReview');
    const hasTemporalEvidence = Object.prototype.hasOwnProperty.call(row, 'temporalEvidence');
    if (hasTemporalEvidence && ['supported', 'corrected'].includes(row.verdict)) {
      const target = row.verdict === 'corrected' ? text(row.correctedText, 1000) : item.row;
      const source = sourceBySynthetic.get(item.topicIndex);
      const ownAnchors = new Set(source?.record.evidenceIds || []);
      const records = (item.passageUnits || []).filter(unit => ownAnchors.has(unit.id))
        .map(unit => ({ id: unit.id, type: 'discussion', text: unit.text, speaker: unit.speaker }));
      const shortQuote = decisionQuoteValidation(row.evidenceQuote, item.passage, 25, { allowClockPrefix: true });
      const mappedSource = records.find(record => record.id === row.temporalEvidence?.sourceId);
      if (!shortQuote.valid || !mappedSource
        || !decisionQuoteValidation(row.evidenceQuote, mappedSource.text, 25, { allowClockPrefix: true }).valid) {
        indexed.states.set(item.id, { id: item.id, status: 'rejected', reason: 'temporal_evidence_quote_not_in_own_source' });
        continue;
      }
      const proof = Temporal.validateTemporalEvidence(target, records, row.temporalEvidence,
        { meetingDate: item.meetingDate, contextRecords: item.passageUnits || [] });
      if (!proof.supported) {
        // These failures occur after source identity and literal witness spans
        // have been checked. Preserve the established opportunity for an
        // independently source-bound child to remain visible WITH its timing
        // warning. Its existing strict retention checks still run below; this
        // does not turn an unresolved model judgment into verified timing.
        const temporalBindingUnresolved = ['temporal_source_qualification_not_retained',
          'temporal_phase_work_not_proved', 'temporal_phase_meaning_not_retained'].includes(proof.reason)
          && row.temporalEvidence.qualificationQuotes.every(quote => {
            const at = mappedSource.text.indexOf(quote);
            return at >= 0 && mappedSource.text.indexOf(quote, at + 1) < 0;
          });
        indexed.states.set(item.id, { id: item.id, status: 'rejected', reason: proof.reason || 'temporal_source_binding_not_proved',
          ...(temporalBindingUnresolved ? { temporalBindingUnresolved: true } : {}) });
        continue;
      }
      temporalBindings.set(item.id, proof.binding);
      if (row.verdict === 'supported') {
        indexed.states.set(item.id, { id: item.id, status: 'supported', reason: '', temporalBinding: proof.binding });
        continue;
      }
    }
    if (row.verdict === 'supported') {
      if (Temporal.temporalClaim(item.row, temporalContext(item, sourceBySynthetic.get(item.topicIndex)?.record))) {
        const quote = decisionQuoteValidation(row.evidenceQuote, item.passage, 25, { allowClockPrefix: true });
        const carrying = quote.valid ? (item.passageUnits || []).filter(unit => quoteText(unit.text).includes(quoteText(row.evidenceQuote))) : [];
        const ownIds = new Set(sourceBySynthetic.get(item.topicIndex)?.record.evidenceIds || []);
        const supported = carrying.some(unit => (!quote.requiresLiteralSource
          || (ownIds.has(unit.id) && Temporal.literalTemporalPropositionMatch(item.row, unit.text)))
          && Temporal.supportedByApprovedRecord(item.row,
            { type: 'discussion', text: `${unit.speaker || ''}: ${unit.text}` }, { meetingDate: item.meetingDate }));
        indexed.states.set(item.id, supported ? { id: item.id, status: 'supported', reason: '' }
          : { id: item.id, status: 'rejected', reason: 'temporal_source_binding_not_proved' });
      } else indexed.states.set(item.id, { id: item.id, status: 'supported', reason: '' });
    }
    else accepted.push(row);
  }
  const applied = applySourceDiscussionFidelityResults(synthetic, mappedItems, accepted, { temporalBindings });
  for (const rejected of applied.rejected) indexed.states.set(rejected.id, { ...rejected, status: 'rejected' });
  for (const row of accepted) if (indexed.states.get(row.id)?.status === 'pending') {
    indexed.states.set(row.id, { id: row.id, status: row.verdict === 'corrected' ? 'corrected' : 'uncertain', reason: text(row.reason, 300),
      ...(temporalBindings.has(row.id) ? { temporalBinding: temporalBindings.get(row.id) } : {}) });
  }
  const changes = new Map(), flags = [...applied.flags];
  for (const [syntheticIndex, source] of sourceBySynthetic) {
    let changed = applied.discussion[syntheticIndex]?.points?.[0] || null;
    const state = indexed.states.get(source.item.id);
    const Temporal = require('./meetingMinutesTemporalReview');
    const verdict = indexed.byId.get(source.item.id);
    const meaningRejected = ['correction_assertion_strength_not_proved', 'correction_assertion_source_not_cited'].includes(state.reason);
    if (changed && meaningRejected) {
      const flag = normaliseFlag({
        id: stableId('flag-fidelity-meaning', `${source.record.id}|${source.item.row}|${state.reason}`, 0),
        kind: 'uncertain_fact',
        message: `Could not safely correct this sentence without changing its follow-up or commitment status. The original wording was retained: "${text(source.item.row, 500)}". Check it against the source.`,
        evidenceIds: changed.evidenceIds || []
      }, flags.length);
      flags.push(flag);
      changed = { ...changed, reviewFlagIds: [...new Set([...(changed.reviewFlagIds || []), flag.id])] };
    }
    const suppliedTemporalEvidence = verdict && ['supported', 'corrected'].includes(verdict.verdict)
      && Object.prototype.hasOwnProperty.call(verdict, 'temporalEvidence');
    if (changed && !meaningRejected && !['supported', 'corrected', 'uncertain'].includes(state.status)
      && (suppliedTemporalEvidence || Temporal.temporalClaim(source.item.row, temporalContext(source.item, source.record)))) {
      const flag = normaliseFlag({ kind: 'timing',
        message: `Cannot verify the timing in "${text(source.item.row, 260)}": ${text(state.reason, 180).replace(/_/g, ' ')}. Confirm it against the cited source.`,
        evidenceIds: changed.evidenceIds || [] }, flags.length);
      flags.push(flag);
      changed = { ...changed, reviewFlagIds: [...new Set([...(changed.reviewFlagIds || []), flag.id])] };
    }
    changes.set(JSON.stringify(source.path), changed);
  }
  const sourceByPath = new Map([...sourceBySynthetic.values()].map(source => [JSON.stringify(source.path), source]));
  const childDispositions = [];
  const independentIssue = (record, path) => {
    const source = sourceByPath.get(JSON.stringify(path));
    if (!source) return 'child_not_independently_reviewed';
    const state = indexed.states.get(source.item.id), verdict = indexed.byId.get(source.item.id);
    const timingReview = state?.status === 'rejected' && (state.reason === 'temporal_source_binding_not_proved' || state.temporalBindingUnresolved === true)
      && verdict?.verdict === 'supported';
    if (!['supported', 'corrected'].includes(state?.status) && !timingReview) return state?.reason || 'child_fidelity_unresolved';
    if (record._unsupportedEvidenceIds?.length || record._weakEvidenceIds?.length) return 'child_evidence_diagnostics';
    const anchors = new Set(record.evidenceIds || []);
    const passageUnits = source.item.passageUnits || [];
    if (!anchors.size || [...anchors].some(id => !passageUnits.some(unit => unit.id === id))) return 'child_own_evidence_missing';
    const quote = text(verdict?.evidenceQuote, 1500);
    const carrying = passageUnits.filter(unit => anchors.has(unit.id)
      && decisionQuoteValidation(quote, unit.text, timingReview ? 25 : 120).valid);
    if (!carrying.length) return 'child_quote_not_in_own_evidence';
    const value = text(record.text, 1600);
    const editorial = require('./stagedEditorial');
    if (editorial.isRawTranscriptDiscussionPoint(value) || !editorial.finaliseDiscussionPointForMinutes(value)
      || /^(?:it|this|that|these|those|they|he|she|his|her|their|its|which|who|whose)\b|^the\s+(?:former|latter|same|above|following|other)\b/i.test(value)
      || /\b(?:with|for|after|before|once|until|without|on|to|of|about)\s+(?:it|this|that|them|those|these)\s*[.!?]?$/i.test(value)) return 'child_depends_on_parent_context';
    // A source-bound temporal paraphrase has already passed independent work,
    // phase and qualification checks. Revalidate its current wording and own
    // citations before allowing it to stand apart from a withheld parent.
    if (state.temporalBinding && ['supported', 'corrected'].includes(state.status)) {
      if (/\b(?:after|before|once|when|until|following|pending|subject to|dependent on)\s+(?:it|this|that|these|those|they|them)\b/i.test(value)) {
        return 'child_depends_on_parent_context';
      }
      const records = passageUnits.filter(unit => anchors.has(unit.id))
        .map(unit => ({ id: unit.id, type: 'discussion', text: unit.text, speaker: unit.speaker }));
      const proof = require('./meetingMinutesTemporalReview').validateTemporalEvidence(value, records,
        verdict?.temporalEvidence, { meetingDate: source.item.meetingDate, contextRecords: passageUnits });
      const quantityIssue = quantifiedClaimGroundingIssue(record, carrying);
      if (proof.supported && (!quantityIssue || quantityIssue.unresolved)) return '';
      return proof.reason || 'child_quantity_not_bound';
    }
    if (evidenceSupportScore(value, quote) < 0.42 || polarity(value) !== polarity(quote)) return 'child_quote_support_too_low';
    const canonical = input => convertSpokenNumbers(String(input).replace(/([a-z])([A-Z])/g, '$1 $2')).text
      .toLowerCase().replace(/\b(\d+)(?:st|nd|rd|th)\b/g, '$1').replace(/[-–—]/g, ' ');
    const literal = input => input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const claim = canonical(value), quoted = canonical(quote);
    const specifics = /\b\d+(?:[.,]\d+)?\b|\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b|\b(?:this|next|last|previous)\s+(?:week|month|year|day)\b/g;
    if ([...claim.matchAll(specifics)].some(match => !new RegExp(`\\b${literal(match[0])}\\b`).test(quoted))) return 'child_specificity_not_in_quote';
    const wording = input => canonical(input).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const qualifications = /\b(?:if|unless|once|until|before|after|subject to|provided that|providing that|pending|contingent|depending|dependent|awaiting|approval|approved|permission|permitted|as long as|on condition)\b/;
    // A verbatim quote may still omit a governing condition from its own
    // source turn. Do not infer that a nearby qualifier belongs elsewhere.
    const fullSource = canonical(carrying.map(unit => unit.text).join(' '));
    if (/[?？]/.test(value) !== /[?？]/.test(fullSource)) return 'child_source_question_modality';
    if (qualifications.test(fullSource) && wording(value) !== wording(fullSource)) return 'child_source_condition_not_preserved';
    const hedged = /\b(?:may|might|could|possibly|probably|presumably|perhaps|maybe|hopefully|ideally|expected|provisional|uncertain|unclear|unconfirmed|unsure|not sure|not known|not established)\b/;
    if (hedged.test(fullSource) && wording(value) !== wording(fullSource)) return 'child_source_uncertainty_omitted';
    if (polarity(value) !== polarity(fullSource)) return 'child_source_polarity_omitted';
    if ([...value.matchAll(/\b[A-Z][\p{L}'’-]+\b/gu)].some(match => match.index > 0
      && !new RegExp(`\\b${literal(canonical(match[0]))}\\b`).test(quoted))) return 'child_named_detail_not_in_quote';
    const completeOwnSource = carrying.some(unit => wording(value) === wording(unit.text));
    if (!timingReview && !completeOwnSource) return 'child_statement_not_complete_own_source';
    if (timingReview && !completeOwnSource) {
      const mainClause = carrying.some(unit => {
        const sourceWords = wording(unit.text), quoteAt = sourceWords.indexOf(wording(quote));
        if (quoteAt < 0) return false;
        const before = sourceWords.slice(0, quoteAt).trim();
        return !before || /^(?:(?:so|then|obviously|also|well|just)\s*){1,6}$/.test(before)
          || /\b(?:and|but)(?:\s+then)?(?:\s+(?:obviously|also|so|well|just))*$/.test(before);
      });
      if (!mainClause) return 'child_quote_not_independent_source_clause';
      if (/\b(?:proposal|proposed|suggestion|suggested|rejected|declined|disputed|incorrect|false|reported|reportedly|claim|claimed|says|said|asked|whether)\b/.test(fullSource)) return 'child_source_assertion_unresolved';
      // A date does not make an ownership or approval assertion a timing
      // phase. The warning-only exception can retain a source-bound schedule
      // or sequence; it cannot establish another factual predicate.
      if (!/\b(?:(?:is|are|will be)\s+(?:scheduled|planned|due)|will\s+(?:start|begin|end|finish|follow|continue|last|occur|run|take place))\b/.test(claim)) return 'child_not_independent_timing_phase';
    }
    if (wording(value) !== wording(quote)) {
      // Detaching a model-supported paraphrase creates a new independent
      // assertion. Keep that boundary literal, except for an already retained
      // temporal row whose own warning must remain open. That narrow exception
      // still needs the quote's subject and the claim's words in source order;
      // an actor mentioned as a recipient or in a sibling clause cannot bind it.
      if (!timingReview) return 'child_statement_not_literal_in_quote';
      const subject = quantifiedClaimSubject(value).filter(word => !['and', 'or'].includes(word));
      const quoteWords = (quoted.match(/[\p{L}\p{N}]+/gu) || []).filter((word, index) => index || !['the', 'a', 'an'].includes(word));
      const stem = word => word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word;
      const quoteRoot = contentTokens(quoted.replace(/^(?:(?:so|then|obviously|also|well|just)\s+){1,6}/, '')
        .replace(/^(?:the|a|an)\s+/, '')).map(stem);
      const subjectBound = subject.length && subject.every((word, index) => word === quoteRoot[index]);
      const presenceBound = quantifiedClaimSignatures(value).some(signature => locativePresenceDurationBound(value, quote, signature));
      const grammar = new Set(['the', 'a', 'an', 'and', 'or', 'is', 'are', 'was', 'were', 'will', 'be', 'to', 'of', 'on', 'in', 'at', 'for', 'from', 'between', 'through']);
      const claimWords = (claim.match(/[\p{L}\p{N}]+/gu) || []).filter(word => !grammar.has(word));
      let cursor = 0;
      const ordered = claimWords.every(word => {
        const next = quoteWords.indexOf(word, cursor);
        if (next < 0) return false;
        cursor = next + 1;
        return true;
      });
      if ((!subjectBound || !ordered) && !presenceBound) return 'child_proposition_not_bound_to_quote';
    }
    const quantityIssue = quantifiedClaimGroundingIssue(record, carrying);
    if (quantityIssue && !quantityIssue.unresolved) return 'child_quantity_not_bound';
    return '';
  };
  const visit = (record, path, independently = false) => {
    if (isReviewerAuthored(record)) return [{ record, path }];
    const next = changes.has(JSON.stringify(path)) ? changes.get(JSON.stringify(path)) : record;
    const issue = next && independently ? independentIssue(next, path) : '';
    // Resolve original child paths before reparenting. A rejected wrapper
    // cannot prevent independently reviewed grandchildren from being checked.
    const children = (record.supportingDetails || []).flatMap((detail, index) =>
      visit(detail, [...path, 'supportingDetails', index], independently || !next));
    if (independently) {
      const source = sourceByPath.get(JSON.stringify(path));
      const state = source && indexed.states.get(source.item.id);
      childDispositions.push({ recordId: record.id || '', recordPath: path,
        disposition: next && !issue ? 'retained' : 'withheld', reason: issue || (next ? '' : 'own_fidelity_withheld'),
        reviewStatus: state?.status || 'missing', reviewReason: state?.reason || '' });
    }
    if (!next || issue) return children;
    return [{ record: { ...next, ...(Array.isArray(record.supportingDetails) ? {
      supportingDetails: children.map(child => child.record)
    } : {}) }, path }];
  };
  const checked = (Array.isArray(discussion) ? discussion : []).map((topic, topicIndex) => {
    if (isReviewerAuthored(topic)) return topic;
    const next = { ...topic, points: [], decisions: [], openQuestions: [] };
    for (const kind of ['points', 'decisions', 'openQuestions']) {
      for (const [rowIndex, record] of (topic[kind] || []).entries()) {
        for (const child of visit(record, [topicIndex, kind, rowIndex])) {
          // Supporting context has no independent decision/question label.
          // Detaching it must not inherit a rejected parent's classification.
          next[child.path.length > 3 ? 'points' : kind].push(child.record);
        }
      }
    }
    return next;
  });
  const withheld = applied.withheld.map(row => {
    const index = Number(String(row.topicId).replace('fidelity-row-', ''));
    const source = sourceBySynthetic.get(index);
    return source ? { ...row, topicId: source.topic?.id || '', topic: source.topic?.topic || '',
      kind: source.path.length > 3 ? 'supportingDetails' : source.item.kind, recordPath: source.path } : row;
  });
  const accounting = finishReviewAccounting(indexed);
  if (childDispositions.length) accounting.parentWithheldChildren = childDispositions;
  return { discussion: checked, flags, withheld, accounting,
    checked: accounting.items.filter(item => ['supported', 'corrected', 'uncertain'].includes(item.status)).length,
    corrected: applied.corrected, uncertain: accounting.items.filter(item => !['supported', 'corrected'].includes(item.status)).length,
    rejected: [...applied.rejected, ...accounting.items.filter(item => ['missing', 'duplicate', 'malformed', 'rejected', 'stale'].includes(item.status))] };
}

function hasReviewerAuthoredSupportingDetail(record = {}) {
  return (record.supportingDetails || []).some((detail) => isReviewerAuthored(detail)
    || hasReviewerAuthoredSupportingDetail(detail));
}

function isCautiousDiscussionClaim(value = '') {
  return /\b(?:may|might|could|possibly|perhaps|reportedly|uncertain|unconfirmed|unclear|unknown|not (?:yet )?(?:confirmed|known|established)|to be (?:confirmed|clarified)|needs? (?:confirmation|clarification))\b/i.test(String(value));
}

function hasSupportedOperationalEffect(row = '', item = {}) {
  // A light-hearted exchange may still establish a real travel/access/cost
  // constraint. Preserve that row for review when both the row and its source
  // describe the same concrete operational effect; a generic reference to
  // planning or disruption is not itself such evidence.
  const effects = [
    /\b(?:transport(?:ation)?|travel|traffic|journey)\b/i,
    /\b(?:availability|available|unavailable|capacity)\b/i,
    /\b(?:costs?|funds|budget|balance|account)\b/i,
    /\b(?:delays?|delayed|closure|closed)\b/i,
    /\b(?:access|attendance|safety)\b/i
  ];
  const generic = new Set(['potential', 'possible', 'options', 'include', 'includes', 'group', 'team', 'general', 'planning', 'consider', 'regarding', 'because', 'during', 'event', 'local']);
  const subjects = (value) => new Set(resolutionTokens(value)
    .filter((word) => !generic.has(word) && !COMMON_SPEECH_WORDS.has(word) && !effects.some((pattern) => pattern.test(word))));
  const required = subjects(row);
  const sourceRows = Array.isArray(item?.passageUnits) ? item.passageUnits.map((unit) => unit.text)
    : String(item?.passage || '').split('\n').filter(Boolean);
  return sourceRows.some((source, index) => {
    const matchedEffects = effects.filter((pattern) => pattern.test(row) && pattern.test(source)).length;
    if (!matchedEffects) return false;
    // Read one short antecedent for a continuation such as "there may be less
    // transport available". Do not pool matching words from a 40-line passage
    // or let an unrelated equipment cost protect a sightseeing remark.
    const contextual = /^(?:so\b|and\b|but\b|that\b|there\b|it\b)/i.test(String(source).trim())
      ? sourceRows.slice(Math.max(0, index - 1), index + 1).join(' ') : source;
    const present = subjects(contextual);
    const matchedSubjects = [...required].filter((word) => present.has(word)).length;
    return matchedSubjects >= 2 || (matchedEffects >= 2 && (matchedSubjects >= 1 || !required.size));
  });
}

// A generated duration statement must bind its quantity to its subject in the
// source clause which carries that duration. A pronoun may inherit a subject
// from the preceding clause/turn, but a later coordinated clause must not lend
// its subject backwards.
const QUANTITY_WORD = '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)';
const QUANTITY_UNIT = '(?:%|percent|percentage|seconds?|minutes?|hours?|days?|weeks?|months?|years?|items?|documents?|files?|tests?|runs?|alarms?|devices?|products?|samples?|units?|batches?|sites?|languages?|pounds?|euros?|dollars?)';
const QUANTIFIED_CLAIM = new RegExp(`\\b(?:\\d+(?:[.,]\\d+)?|${QUANTITY_WORD})(?:[- ](?:${QUANTITY_WORD}))*\\s*${QUANTITY_UNIT}\\b`, 'gi');
const DURATION_CLAIM = new RegExp(`\\b(?:in|for|over)\\s+(?:\\d+(?:[.,]\\d+)?|${QUANTITY_WORD})(?:[- ](?:${QUANTITY_WORD}))*\\s+(?:days?|weeks?|months?|years?)\\b`, 'i');
const CLAIM_AUXILIARY = /\b(?:is|are|was|were|has|have|had|will|would|can|could|should|must|remains?|became|becomes?)\b/i;
const CLAIM_SUBJECT_STOP = new Set(['the', 'a', 'an', 'this', 'that', 'these', 'those', 'current', 'existing', 'annual', 'overall', 'approximately', 'about']);
const SIMPLE_NUMBER_WORDS = new Map('zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred'
  .split(' ').map((word, index) => [word, index <= 20 ? index : ({ thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100 })[word]]));

function quantifiedClaimSignatures(value = '') {
  return [...String(value || '').matchAll(new RegExp(QUANTIFIED_CLAIM.source, 'gi'))]
    .map((match) => match[0].toLowerCase().replace(/\b[a-z]+\b/g, (word) => SIMPLE_NUMBER_WORDS.has(word)
      ? String(SIMPLE_NUMBER_WORDS.get(word)) : word).replace(/\s+/g, ' ').trim());
}

function quantifiedSubjectText(value = '') {
  // A written compound and its spoken form name the same subject. Leave
  // numeric ranges intact; this normalization concerns word compounds only.
  return String(value || '').replace(/(?<=\p{L})[-–—](?=\p{L})/gu, ' ');
}

function quantifiedClaimSubject(value = '') {
  const source = text(value, 1200);
  const auxiliary = source.match(CLAIM_AUXILIARY);
  if (!auxiliary || auxiliary.index == null || auxiliary.index > 140) return [];
  return contentTokens(quantifiedSubjectText(source.slice(0, auxiliary.index)))
    .filter((token) => !CLAIM_SUBJECT_STOP.has(token))
    .map((token) => token.length > 4 && token.endsWith('s') ? token.slice(0, -1) : token)
    .slice(-5);
}

function locativePresenceDurationBound(value, clause, signature) {
  const source = text(value, 1200);
  const auxiliary = source.match(CLAIM_AUXILIARY);
  if (!auxiliary || auxiliary.index == null) return false;
  // "Presence" is a grammatical carrier in an otherwise anonymous location
  // statement. Do not discard an actor, equipment name or other identifying
  // noun just because the source also mentions that location and quantity.
  const subject = quantifiedSubjectText(source.slice(0, auxiliary.index)).trim();
  const location = subject.match(/^(?:the\s+)?((?:on|in|at)\s+(?:(?:the|a|an)\s+)?[\p{L}][\p{L}'’-]*(?:\s+[\p{L}][\p{L}'’-]*){0,2})\s+presence$/iu)?.[1];
  if (!location) return false;
  // This narrow equivalence does not decide negation, historical status or
  // whether a suggested stay became an agreed plan. Leave such cases to the
  // existing literal-subject/evidence checks instead of certifying by location.
  const unresolvedStatus = /\b(?:not|never|cannot|can't|won't|no longer|was|were|had|spent|previously|yesterday|last|may|might|could|maybe|possibly|probably|presumably|perhaps|hopefully|ideally|unless|if|proposed|suggested|considering)\b/i;
  if (unresolvedStatus.test(source) || unresolvedStatus.test(clause)) return false;
  const canonical = input => quantifiedSubjectText(input).toLowerCase()
    .replace(/\b(?:the|a|an)\b/g, ' ')
    .replace(/\b[a-z]+\b/g, word => SIMPLE_NUMBER_WORDS.has(word) ? String(SIMPLE_NUMBER_WORDS.get(word)) : word)
    .replace(/\s+/g, ' ').trim();
  const escape = input => input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const place = escape(canonical(location)), quantity = escape(canonical(signature));
  // Bind the location directly to this duration. Finding the location in a
  // later clause, or an unrelated duration somewhere in the turn, is unsafe.
  return new RegExp(`\\b(?:${quantity}\\s+(?:of\\s+)?${place}|${place}\\s+(?:for|over|during)\\s+${quantity})\\b`, 'iu')
    .test(canonical(clause));
}

function quantifiedClaimClauses(value = '') {
  return String(value || '').split(/(?<=[.!?;])\s+|,\s+(?=(?:and|but|while|whereas)\b)|\s+(?:and|but|while|whereas)\s+(?=(?:[\p{L}'’-]+\s+){1,6}(?:is|are|was|were|has|have|had|will|would|can|could|should|must|remains?|became|becomes?)\b)/iu);
}

function unresolvedLocativeDuration(claim, clause, signature) {
  const auxiliary = String(claim).match(CLAIM_AUXILIARY);
  if (!auxiliary || auxiliary.index == null) return false;
  const subject = quantifiedSubjectText(claim.slice(0, auxiliary.index)).trim();
  // A phase can name an otherwise anonymous visit/stay as an audit or another
  // work type. The location and duration can be proved without claiming that
  // this extra work identity is proved. Retain it for review, never certify it.
  const parts = subject.match(/^(?:the\s+)?((?:on|off|in|at)\s+(?:(?:the|a|an)\s+)?[\p{L}][\p{L}'’-]*)\s+([\p{L}][\p{L}'’-]*)$/iu);
  if (!parts) return false;
  const unsafeStatus = /\b(?:not|never|cannot|can't|won't|no longer|was|were|had|spent|previously|yesterday|last|may|might|could|maybe|possibly|probably|presumably|perhaps|hopefully|ideally|unless|if|proposed|suggested|considering)\b/i;
  if (unsafeStatus.test(claim) || unsafeStatus.test(clause)) return false;
  const canonical = input => quantifiedSubjectText(input).toLowerCase()
    .replace(/\b(?:the|a|an)\b/g, ' ')
    .replace(/\b[a-z]+\b/g, word => SIMPLE_NUMBER_WORDS.has(word) ? String(SIMPLE_NUMBER_WORDS.get(word)) : word)
    .replace(/\s+/g, ' ').trim();
  const escape = input => input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const source = canonical(clause), place = escape(canonical(parts[1])), quantity = escape(canonical(signature));
  const bound = source.match(new RegExp(`\\b(?:${quantity}\\s+(?:of\\s+)?${place}|${place}\\s+(?:for|over|during)\\s+${quantity})\\b`, 'iu'));
  if (!bound) return false;
  // Do not replace a named actor or another named activity with anonymous
  // location evidence. The source carrier before this quantity must itself be
  // grammatical/temporal, rather than a different work or person's duration.
  const prefix = source.slice(0, bound.index).replace(new RegExp(place, 'giu'), ' ')
    .replace(/\b\d+(?:st|nd|rd|th)?\b/g, ' ');
  const carrier = new Set(['we', 'our', 'us', 'so', 'then', 'obviously', 'just', 'being', 'be', 'been', 'are', 'is', 'will', 'shall', 'have', 'has', 'that', 'thats', "that's", 'and', 'to', 'on', 'in', 'at', 'for', 'of', 'it', 'its', "it's", 'spend', 'spending', 'scheduled', 'planned', 'expected', 'during', 'over']);
  if (!(prefix.match(/[\p{L}][\p{L}'’-]*/gu) || []).every(word => carrier.has(word))) return false;
  // The duration may be followed by another explicitly signalled phase. An
  // activity still inside this duration's own clause is identifying evidence,
  // even when it comes after the quantity rather than before it.
  const suffix = source.slice(bound.index + bound[0].length).split(/\b(?:and\s+then|then|followed\s+by)\b|[;.!?]/i)[0]
    .replace(/\b\d+(?:st|nd|rd|th)?\b/g, ' ');
  const temporalTail = new Set(['on', 'in', 'at', 'for', 'from', 'to', 'through', 'until', 'during', 'over', 'starting', 'start', 'beginning', 'ending', 'end', 'summer', 'winter', 'spring', 'autumn', 'fall',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'morning', 'afternoon', 'evening', 'night']);
  return (suffix.match(/[\p{L}][\p{L}'’-]*/gu) || []).every(word => temporalTail.has(word));
}

function quantifiedClaimGroundingIssue(record = {}, units = []) {
  if (!DURATION_CLAIM.test(String(record?.text || ''))) return null;
  const originalSubject = quantifiedClaimSubject(record?.text);
  const phases = quantifiedClaimClauses(record?.text).map(phase => ({
    text: phase, signatures: quantifiedClaimSignatures(phase), subject: quantifiedClaimSubject(phase)
  })).filter(phase => phase.signatures.length);
  if (!phases.length || !(record?.evidenceIds || []).length) return null;
  const rows = normaliseSourceUnits(units);
  const indexById = new Map(rows.map((unit, index) => [String(unit.id), index]));
  const citedIndexes = [...new Set((record.evidenceIds || []).map((id) => indexById.get(String(id)))
    .filter(Number.isInteger))];
  const clauses = [];
  for (const index of citedIndexes) {
    for (let rowIndex = Math.max(0, index - 1); rowIndex < Math.min(rows.length, index + 2); rowIndex += 1) {
      quantifiedClaimClauses(rows[rowIndex].text).forEach((clause, clauseIndex) => clauses.push({ rowIndex, clauseIndex, text: clause }));
    }
  }
  const uniqueClauses = [...new Map(clauses.map(clause => [`${clause.rowIndex}:${clause.clauseIndex}`, clause])).values()]
    .sort((left, right) => left.rowIndex - right.rowIndex || left.clauseIndex - right.clauseIndex);
  const normalisedWords = value => new Set(contentTokens(quantifiedSubjectText(value))
    .map(token => token.length > 4 && token.endsWith('s') ? token.slice(0, -1) : token));
  const unresolved = [];
  for (const phase of phases) {
    const subject = phase.subject.length >= 2 ? phase.subject : originalSubject;
    if (subject.length < 2) continue; // Preserve the established narrow gate.
    for (const signature of phase.signatures) {
      const carriers = uniqueClauses.filter(clause => quantifiedClaimSignatures(clause.text).includes(signature));
      const grounded = carriers.some(clause => {
        const direct = normalisedWords(clause.text);
        if (subject.every(token => direct.has(token))) return true;
        if (locativePresenceDurationBound(phase.text, clause.text, signature)) return true;
        const clauseIndex = uniqueClauses.indexOf(clause);
        if (!/\b(?:it|its|they|them|their|those|these)\b/i.test(clause.text) || clauseIndex < 1) return false;
        const preceding = normalisedWords(uniqueClauses[clauseIndex - 1].text);
        return subject.every(token => preceding.has(token));
      });
      if (grounded) continue;
      if (carriers.some(clause => unresolvedLocativeDuration(phase.text, clause.text, signature))) {
        unresolved.push({ signature, subject, text: phase.text });
        continue;
      }
      return { signatures: [signature], subject };
    }
  }
  return unresolved.length ? { unresolved: true, signatures: unresolved.map(item => item.signature),
    subject: unresolved[0].subject, phases: unresolved } : null;
}

function filterUnsupportedQuantifiedDiscussion(discussion = [], units = []) {
  const removed = [], flags = [];
  const check = record => {
    const issue = quantifiedClaimGroundingIssue(record, units);
    if (!issue) return record;
    if (!issue.unresolved) { removed.push({ id: record.id || '', text: record.text || '', ...issue }); return null; }
    const flag = normaliseFlag({
      id: stableId('flag-quantity-binding', record.id || record.text || '', 0),
      kind: 'uncertain_fact',
      message: 'The source states this location and duration, but their connection to the named work needs review. Confirm the work and its own duration against the source.',
      evidenceIds: record.evidenceIds || []
    });
    flags.push(flag);
    return { ...record, reviewFlagIds: [...new Set([...(record.reviewFlagIds || []), flag.id])] };
  };
  const topics = (Array.isArray(discussion) ? discussion : []).map(topic => {
    const next = { ...topic };
    for (const kind of ['points', 'decisions', 'openQuestions']) {
      next[kind] = (Array.isArray(topic?.[kind]) ? topic[kind] : []).flatMap(record => {
        const kept = check(record);
        if (!kept) return [];
        const supportingDetails = (Array.isArray(record?.supportingDetails) ? record.supportingDetails : []).map(check).filter(Boolean);
        return [{ ...kept, supportingDetails }];
      });
    }
    return next;
  }).filter(topic => ['points', 'decisions', 'openQuestions'].some(kind => (topic?.[kind] || []).length));
  return { discussion: topics, removed, flags };
}

// ---- Unstated months -------------------------------------------------------
// "I won't be around between the 14th and the 17th" was minuted as "14th-17th
// June": the model borrowed the meeting's month, and the meeting meant July.
// A month written beside a day must be heard near the cited lines ("next
// month" counts); otherwise it is replaced with a visible placeholder and the
// row is flagged, which is what a reviewer did by hand.
const UNSTATED_MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const UNSTATED_MONTH = String.raw`(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)`;
const UNSTATED_DAY = String.raw`\d{1,2}(?:st|nd|rd|th)?`;
const UNSTATED_DAY_SPAN = String.raw`${UNSTATED_DAY}(?:\s*(?:-|–|—|to|and|until|through|or)\s*(?:the\s+)?${UNSTATED_DAY})?`;
const DAY_THEN_MONTH = new RegExp(String.raw`\b(${UNSTATED_DAY_SPAN})\s+(?:of\s+)?${UNSTATED_MONTH}(?![a-z])(?!\s+[a-z])`, 'gi');
const DAY_THEN_MONTH_LOOSE = new RegExp(String.raw`\b(${UNSTATED_DAY_SPAN})\s+(?:of\s+)?${UNSTATED_MONTH}(?![a-z])`, 'gi');
const MONTH_THEN_DAY = new RegExp(String.raw`\b${UNSTATED_MONTH}\s+(${UNSTATED_DAY_SPAN})\b`, 'gi');

function monthNameFor(token = '') {
  const value = String(token || '').toLowerCase();
  return UNSTATED_MONTH_NAMES.find((name) => name === value || name.slice(0, 3) === value.slice(0, 3)) || '';
}

function monthHeardNear(month, units = [], evidenceIds = []) {
  const heard = evidenceWindowUnits(units, evidenceIds, 3, 3).map((unit) => String(unit.text || '').toLowerCase()).join(' ');
  if (/\b(?:this|next|last|following|previous|that) month\b/.test(heard)) return true;
  // "May" is also a verb; only the full word or a clear abbreviation counts.
  const short = month === 'may' ? 'may' : month.slice(0, 3);
  return new RegExp(String.raw`\b(?:${month}|${short}\.?)(?![a-z])`).test(heard);
}

// A combined minute can cite the later half of its evidence while omitting the
// earlier line which states its date. Before displaying "month to confirm",
// recover only an exact day-and-month which appears elsewhere in a strongly
// matching transcript window. This never derives a month from the meeting date
// and deliberately refuses weak/unrelated exact-date matches.
function exactStatedDateEvidence(value = '', day = '', month = '', units = []) {
  const dayNumber = String(day || '').match(/^\d{1,2}/)?.[0] || '';
  const namedMonth = monthNameFor(month);
  if (!dayNumber || !namedMonth || /(?:-|–|—|\bto\b|\band\b|\buntil\b|\bthrough\b|\bor\b)/i.test(String(day || ''))) return [];
  const escapedMonth = namedMonth.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exactDate = new RegExp(
    String.raw`\b(?:${dayNumber}(?:st|nd|rd|th)?\s+(?:of\s+)?${escapedMonth}|${escapedMonth}\s+(?:the\s+)?${dayNumber}(?:st|nd|rd|th)?)\b`,
    'i'
  );
  const context = evidenceContextFor(units);
  // A generated row can join an exact deadline to a later observation (for
  // example, "due 19 October; showing preparation is enough for an audit").
  // Search with the clause that owns the date, not the unrelated tail.  Also
  // ignore a four-digit year for this lookup: speakers commonly say "this
  // year", and this guard is deciding only whether the named *month* was
  // spoken.  Letting that derived year participate makes an otherwise exact
  // day-and-month match score zero.
  const dateClauses = String(value || '').split(/;|(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
  const dateClaim = (dateClauses.find((part) => {
    const lower = part.toLowerCase();
    return new RegExp(String.raw`\b${dayNumber}(?:st|nd|rd|th)?\b`, 'i').test(part)
      && new RegExp(String.raw`\b${namedMonth}\b`, 'i').test(lower);
  }) || String(value || '')).replace(/\b(?:19|20)\d{2}\b/g, ' ');
  const claimAnchors = resolutionTokens(dateClaim).filter((token) => token !== dayNumber && token !== namedMonth);
  if (claimAnchors.length < 2) return [];
  let best = null;
  for (let index = 0; index < context.rows.length; index += 1) {
    if (!exactDate.test(String(context.rows[index].text || ''))) continue;
    const start = Math.max(0, index - 3);
    const end = Math.min(context.rows.length, index + 4);
    const windowText = context.rows.slice(start, end).map((unit) => `${unit.speaker}: ${unit.text}`).join(' ');
    const windowTokens = new Set(resolutionTokens(windowText));
    const sharedAnchors = claimAnchors.filter((token) => windowTokens.has(token));
    const support = evidenceSupportScore(dateClaim, windowText);
    if (sharedAnchors.length < 2 || support < 0.38) continue;
    if (!best || support > best.support) best = { id: context.rows[index].id, support };
  }
  return best ? [best.id] : [];
}

function stripUnstatedMonths(value = '', units = [], evidenceIds = [], recoveredEvidenceIds = []) {
  const removed = [];
  const evidence = evidenceWindowUnits(units, evidenceIds, 3, 3)
    .map((unit) => String(unit.text || ''))
    .join(' ');
  const aligned = alignEllipticalDateRangesWithEvidence(value, evidence);
  // Protect only ranges derived by the shared formatter from the cited
  // evidence. Other unspoken months still pass through the conservative guard.
  const protectedRanges = [];
  let result = aligned.text;
  for (const range of aligned.applied) {
    const marker = `\uE000${protectedRanges.length}\uE001`;
    result = result.replace(range, marker);
    protectedRanges.push({ marker, range });
  }
  const replace = (pattern, dayIndex, monthIndex) => {
    result = result.replace(pattern, (...match) => {
      const whole = match[0];
      const month = monthNameFor(match[monthIndex]);
      // "the 14th may slip" is a verb, not May.
      if (!month || (month === 'may' && !/^may\b/i.test(match[monthIndex]))) return whole;
      if (monthHeardNear(month, units, evidenceIds)) return whole;
      const recovered = exactStatedDateEvidence(value, match[dayIndex], month, units);
      if (recovered.length) {
        recoveredEvidenceIds.push(...recovered);
        return whole;
      }
      removed.push({ day: match[dayIndex], month });
      return `${match[dayIndex]} [month to confirm]`;
    });
  };
  replace(DAY_THEN_MONTH, 1, 2);
  // Loose form: any month other than May may run straight into the next word.
  result = result.replace(DAY_THEN_MONTH_LOOSE, (whole, day, token) => {
    const month = monthNameFor(token);
    if (!month || month === 'may' || monthHeardNear(month, units, evidenceIds)) return whole;
    const recovered = exactStatedDateEvidence(value, day, month, units);
    if (recovered.length) {
      recoveredEvidenceIds.push(...recovered);
      return whole;
    }
    removed.push({ day, month });
    return `${day} [month to confirm]`;
  });
  replace(MONTH_THEN_DAY, 2, 1);
  for (const protectedRange of protectedRanges) {
    result = result.replace(protectedRange.marker, protectedRange.range);
  }
  return { text: result, removed };
}

function groundUnstatedDiscussionMonths(discussion = [], units = []) {
  const flags = [];
  const changed = [];
  const topics = (Array.isArray(discussion) ? discussion : []).map((topic) => {
    const next = { ...topic };
    for (const kind of ['points', 'decisions', 'openQuestions']) {
      next[kind] = (Array.isArray(topic?.[kind]) ? topic[kind] : []).map((record) => {
        const recoveredEvidenceIds = [];
        const own = stripUnstatedMonths(record?.text, units, record?.evidenceIds || [], recoveredEvidenceIds);
        const removed = [...own.removed];
        const supportingDetails = (Array.isArray(record?.supportingDetails) ? record.supportingDetails : []).map((detail) => {
          const recoveredDetailEvidenceIds = [];
          const checked = stripUnstatedMonths(
            detail?.text,
            units,
            detail?.evidenceIds || record?.evidenceIds || [],
            recoveredDetailEvidenceIds
          );
          removed.push(...checked.removed);
          return checked.removed.length || recoveredDetailEvidenceIds.length
            ? {
                ...detail,
                text: checked.text,
                evidenceIds: [...new Set([...(detail?.evidenceIds || record?.evidenceIds || []), ...recoveredDetailEvidenceIds])].slice(0, 12)
              }
            : detail;
        });
        if (!removed.length) {
          if (!recoveredEvidenceIds.length) return record;
          return {
            ...record,
            evidenceIds: [...new Set([...(record.evidenceIds || []), ...recoveredEvidenceIds])].slice(0, 12),
            ...(Array.isArray(record?.supportingDetails) ? { supportingDetails } : {})
          };
        }
        const months = [...new Set(removed.map((item) => item.month[0].toUpperCase() + item.month.slice(1)))];
        const flag = normaliseFlag({
          kind: 'timing',
          message: `Nobody named the month for ${removed.map((item) => `"${item.day}"`).join(', ')}; "${months.join('", "')}" was not said near the cited lines and has been replaced with [month to confirm]. Confirm the month.`,
          evidenceIds: record.evidenceIds || []
        }, flags.length);
        flags.push(flag);
        changed.push({ id: record.id || '', removed });
        return {
          ...record,
          text: own.text,
          evidenceIds: [...new Set([...(record.evidenceIds || []), ...recoveredEvidenceIds])].slice(0, 12),
          ...(Array.isArray(record?.supportingDetails) ? { supportingDetails } : {}),
          reviewFlagIds: [...new Set([...(record.reviewFlagIds || []), flag.id])]
        };
      });
    }
    return next;
  });
  return { discussion: topics, flags, changed };
}

// ---- Action completeness --------------------------------------------------
// A short administrative step can accidentally displace the outcome promised
// in the very next sentence ("ring the engineer" / "get the chiller serviced").
// Only ask the critic about rows whose named owner makes an additional nearby
// commitment containing material words absent from the published action.
function actionCompletenessCheckItems(actions = [], units = []) {
  const items = [];
  (Array.isArray(actions) ? actions : []).forEach((action, index) => {
    const owners = action.owners || [];
    if (!owners.length || !text(action.action)) return;
    const actionWords = new Set(materialTokens(action.action));
    const anchorIds = anchorOwnerCommitment(action.action, owners, units, action.evidenceIds || []);
    // Include the request/antecedent and the actual owner's commitment. A
    // remapped noun anchor alone can put the omitted outcome just outside the
    // old one-back/two-forward window and make a real correction unverifiable.
    const ownerLine = (unit) => owners.some((owner) => speakerIsOwner(unit.speaker, [owner]));
    const context = evidenceContextFor(units);
    const byId = new Map(context.rows.map((unit) => [unit.id, unit]));
    const rankedAnchors = [...anchorIds].sort((left, right) => {
      const rank = (id) => {
        const unit = byId.get(id);
        return unit ? Number(ownerLine(unit)) * 4
          + Number(ACTION_COMMITMENT_PATTERN.test(unit.text) || ACTION_CONCRETE_INTENTION_PATTERN.test(unit.text)) * 2
          + Math.min(3, materialTokens(unit.text).filter((word) => actionWords.has(word)).length) : 0;
      };
      return rank(right) - rank(left);
    });
    const wanted = new Set();
    for (const id of rankedAnchors) {
      for (const unit of evidenceWindowUnits(units, [id], 2, 5)) {
        if (wanted.size < 40) wanted.add(unit.id);
      }
    }
    const passageUnits = context.rows.filter((unit) => wanted.has(unit.id));
    const omitted = passageUnits.filter((unit) => ownerLine(unit)
      && (ACTION_COMMITMENT_PATTERN.test(unit.text) || ACTION_CONCRETE_INTENTION_PATTERN.test(unit.text))
      && materialTokens(unit.text).filter((word) => !actionWords.has(word)).length >= 2);
    if (!omitted.length) return;
    items.push({
      id: `ac${items.length + 1}`, index, action: text(action.action, 800), owners,
      timing: action.timing,
      passage: passageUnits.map((unit) => `[${unit.id}] ${unit.speaker}: ${unit.text}`).join('\n'),
      passageUnits: passageUnits.map(unit => ({ id: unit.id, speaker: unit.speaker, text: unit.text }))
    });
  });
  return items.slice(0, 24);
}

function actionCompletenessCheckPrompt(items = []) {
  return [
    'ACTION_CRITIC_COMPLETENESS',
    'Each item contains a proposed Action and its nearby transcript passage. The passage is the only authority.',
    'Choose "complete" unless the same named owner explicitly commits to an additional step or required outcome that is part of the same deliverable and is missing from the Action.',
    'Do not combine separate work, another person\'s work, discussion, hopes or suggestions. Do not put dates into the Action wording; timing is stored separately.',
    'For "corrected", copy problemQuote exactly from the proposed Action, copy evidenceQuote exactly from the owner\'s omitted commitment, and provide one concise imperative correctedAction containing the complete deliverable.',
    'Quotes must be contiguous. Return only: {"schemaVersion":1,"results":[{"id":"","verdict":"complete|corrected","problemQuote":"","evidenceQuote":"","correctedAction":"","reason":""}]}',
    `ITEMS:\n${JSON.stringify(items.map((item) => ({ id: item.id, action: item.action, owners: item.owners, passage: item.passage })))}`
  ].join('\n\n');
}

function completenessPreservesOriginalWork(action, corrected) {
  const first = value => contentTokens(value)[0] || '';
  const lead = first(action.action), nextLead = first(corrected);
  const family = ACTION_VERB_GROUPS.find(group => group.includes(lead));
  if (!lead || (family ? !family.includes(nextLead) : lead !== nextLead)) return false;
  const temporalScope = /\b(?:before|after|once|when|until|following|subject to|dependent on)\b/i;
  // Added outcomes may have their own timing. Ignore only that new trailing
  // scope for identity comparison; the finished compound is checked for timing
  // separately below. An existing scope must remain in the retained work.
  const whole = temporalScope.test(action.action) ? corrected : corrected.split(temporalScope)[0];
  const identity = value => ({ action: value, owners: action.owners || [],
    evidenceIds: action.evidenceIds || [], timing: { kind: 'not_stated', wording: '', exactDate: '' } });
  if (!commitmentCanBeRepresented(identity(action.action), identity(whole))) return false;
  const originalWords = new Set(contentTokens(action.action));
  const leadingInstruction = value => {
    for (const match of String(value).matchAll(/\b(?:and|then)\s+(?:then\s+)?([a-z-]+)\b/gi)) {
      if (ACTION_VERBS.has(match[1].toLowerCase()) || !originalWords.has(match[1].toLowerCase())) return value.slice(0, match.index);
    }
    return value;
  };
  const originalLead = leadingInstruction(action.action);
  const correctedLead = leadingInstruction(whole);
  // A contact's purpose can become an explicit same-owner outcome. The
  // contacted person remains in the first instruction; the full comparison
  // above still requires the original purpose/object elsewhere in the result.
  const directOriginal = ['contact', 'call', 'ring', 'phone', 'speak'].includes(lead)
    ? originalLead.split(/\babout\b/i)[0] : originalLead;
  if (!commitmentCanBeRepresented(identity(directOriginal), identity(correctedLead))) return false;
  const directed = value => [...String(value).matchAll(/\b(to|with|from|into|onto)\s+(.+?)(?=\s+\b(?:for|by|before|after|and|then|so)\b|[.;,]|$)/gi)]
    .map(match => comparisonText(`${match[1]} ${match[2]}`).replace(/\b(?:the|a|an)\b/g, '').replace(/\s+/g, ' ').trim());
  const present = directed(correctedLead);
  return directed(directOriginal).every(relation => present.includes(relation));
}

function completenessQuoteHasOriginalOwners(item, evidenceQuote) {
  const owners = item.owners || [];
  const units = timingItemSourceUnits(item).filter(unit => quotedVerbatim(evidenceQuote, unit.text)
    || quotedVerbatim(evidenceQuote, `${unit.speaker}: ${unit.text}`));
  if (!owners.length || !units.length) return false;
  const namedAssignees = [...String(evidenceQuote).matchAll(/\b([A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+){0,2})(?:\s+(?:will|shall|must|can|could|should|would|needs?\s+to|has\s+to|is\s+going\s+to|is\s+responsible\s+(?:to|for)|to)\s+|\s*,\s*(?:can|could|would|will)\s+you\s+)/gu)]
    .map(match => match[1]).filter(name => !/^(?:I|We|They)$/i.test(name));
  if (namedAssignees.some(name => !speakerIsOwner(name, owners))) return false;
  // A speaker label alone cannot make narrated work theirs. Require the
  // quoted clause itself to begin with that speaker taking it on, or an
  // explicit assignment to the named owner in those same quoted words.
  const firstPerson = /^(?:(?:and|then|so|well|okay|ok|yes|yeah)[\s,.-]+)*(?:I['’]ll|I\s+(?:will|shall|can|am\s+going\s+to)|let\s+me)\b/i.test(String(evidenceQuote).trim());
  return owners.every(owner => firstPerson && units.some(unit => speakerIsOwner(unit.speaker, [owner]))
    || nameParts(owner).some(name => assignsWorkTo(name, evidenceQuote)));
}

function applyActionCompletenessResults(actions = [], items = [], results = [], options = {}) {
  const verdicts = new Map((Array.isArray(results) ? results : []).map((row) => [text(row?.id, 20), row || {}]));
  const corrections = new Map();
  const rejected = [];
  const flags = [];
  const unchangedFlags = new Map();
  for (const item of items) {
    if (isReviewerAuthored(actions[item.index])) continue;
    const row = verdicts.get(item.id);
    if (!row || row.verdict !== 'corrected') continue;
    const problem = decisionQuoteValidation(row.problemQuote, item.action);
    const evidence = decisionQuoteValidation(row.evidenceQuote, item.passage);
    const corrected = cleanActionWording(row.correctedAction);
    if (!problem.valid || !evidence.valid) {
      rejected.push({ id: item.id, reason: !problem.valid ? `problem_${problem.reason}` : `evidence_${evidence.reason}` });
      continue;
    }
    if (!corrected || corrected.split(/\s+/).length < 3 || /\?|\.\.\.|\b(?:i|we|yeah|okay|the speaker)\b/i.test(corrected)
      || evidenceSupportScore(corrected, item.passage) < 0.38) {
      rejected.push({ id: item.id, reason: 'invalid_corrected_action' });
      continue;
    }
    const original = actions[item.index];
    if (!original || !completenessPreservesOriginalWork(original, corrected)
      || !completenessQuoteHasOriginalOwners(item, row.evidenceQuote)) {
      rejected.push({ id: item.id, reason: 'corrected_action_changes_original_work' });
      const flag = normaliseFlag({ kind: 'uncertain_fact',
        message: `A suggested action change was not applied because it did not preserve the original work, recipient or owner. Retained: "${text(item.action, 350)}". Check the proposed change against the source: "${text(corrected, 350)}".`,
        evidenceIds: original?.evidenceIds || [] }, flags.length);
      flags.push(flag);
      unchangedFlags.set(item.index, [...(unchangedFlags.get(item.index) || []), flag.id]);
      continue;
    }
    corrections.set(item.index, corrected);
  }
  let corrected = 0;
  const checked = (Array.isArray(actions) ? actions : []).map((action, index) => {
    if (!corrections.has(index)) return unchangedFlags.has(index)
      ? { ...action, reviewFlagIds: [...new Set([...(action.reviewFlagIds || []), ...unchangedFlags.get(index)])] } : action;
    corrected += 1;
    let next = { ...action, action: corrections.get(index) };
    const item = items.find(item => item.index === index);
    const units = timingItemSourceUnits(item);
    if (action.timing?.kind && action.timing.kind !== 'not_stated'
      && !timingBoundToActionSteps(next, units, options)) {
      next = TimingIntegrity.rejectActionTiming(next, units, {
        meetingDate: options.meetingDate, field: 'all', reason: 'rewritten_action_timing_not_bound'
      });
      const flag = normaliseFlag({ kind: 'timing',
        message: `The timing "${action.timing.wording || action.timing.exactDate}" belonged to the earlier instruction "${text(action.action, 200)}" and was not established for all of the expanded work. Confirm each step's timing.`,
        evidenceIds: action.evidenceIds || [] }, flags.length);
      flags.push(flag);
      next.reviewFlagIds = [...new Set([...(next.reviewFlagIds || []), flag.id])];
    }
    return next;
  });
  return { actions: checked, corrected, checked: items.length, rejected, flags };
}

const COMMITMENT_RECHECK_DISPOSITIONS = new Set(['suggestion', 'status_only', 'meeting_admin', 'unaccepted_request']);

function normaliseActions(candidate = {}, units = [], options = {}) {
  const rows = (Array.isArray(candidate.actions) ? candidate.actions : []).slice(0, 250).map((item, index) => {
    let action = options.preserveReviewerEdits === true ? text(item?.action, 1600) : cleanActionWording(item?.action);
    if (!action || (options.preserveReviewerEdits !== true && isIdeaOnlyContemplation(action))) return null;
    const suppliedIds = (Array.isArray(item?.evidenceIds) ? item.evidenceIds : []).map((id) => text(id, 30)).filter(Boolean);
    const resolved = resolveEvidence(action, units, item?.evidenceIds, { action: true, meetingDate: options.meetingDate });
    const checks = correctnessChecksEnabled();
    if (checks && options.enforceEvidence === false && !suppliedIds.some((id) => evidenceContextFor(units).known.has(id))
      && resolved.evidenceIds.length && !uncitedClaimSupported(action, resolved, units)) {
      resolved.evidenceIds = [];
    }
    const owners = splitOwners(item?.owners || item?.owner).map((owner) => normaliseOwnerIdentity(owner, units));
    const fieldEvidenceIds = retainSuppliedActionFieldEvidence(action, owners, units, suppliedIds, resolved.evidenceIds, item?.timing, options);
    let evidenceIds = anchorOwnerCommitment(action, owners, units, fieldEvidenceIds);
    const evidenceText = evidenceWindowText(units, evidenceIds, 1);
    const disposition = actionEvidenceDisposition(action, evidenceText);
    if (options.enforceEvidence !== false && !evidenceIds.length) return null;
    if (options.enforceEvidence !== false && ['completed', 'suggestion', 'status_only', 'meeting_admin', 'unaccepted_request', 'rejected'].includes(disposition)) {
      // The keyword reading can be wrong ("Janine and Adil, you're involved in
      // that next week" reads as no commitment). A caller may collect these
      // for a quote-verified second look; they are never published from here.
      if (Array.isArray(options.vetoed) && COMMITMENT_RECHECK_DISPOSITIONS.has(disposition) && !isMeetingAdminAction(action)) {
        options.vetoed.push({ id: text(item?.id, 80) || stableId('action', action, index), action, owners, timing: timingFrom(item, options), evidenceIds, reviewFlagIds: [], disposition });
      }
      return null;
    }
    // Recovery fills gaps in fresh agent output only. A save (enforceEvidence
    // false) carries timings a reviewer or a timing check has already settled,
    // so an empty timing there is deliberate and must stay empty.
    const activeTimingDecision = TimingIntegrity.assessmentMatches({ ...item, action, owners, evidenceIds }, units,
      options.meetingDate || item.timingDecision?.meetingDate, item.timingDecision) ? item.timingDecision : undefined;
    const timingRecoveryIssues = [], recoveredTimingEvidenceIds = [];
    const timingOptions = { ...options, action, owners, timingRecoveryIssues, recoveredTimingEvidenceIds,
      timingMode: options.timingMode || (options.enforceEvidence !== false ? 'derive' : 'preserve'),
      timingDecision: activeTimingDecision
    };
    let timing = timingFrom(item, timingOptions);
    let timingShapeIssue = '';
    if (options.enforceEvidence !== false) {
      // Shape is checked before the transcript backfills, not after: a copied
      // sentence in the timing column ("I'll draft that.") used to block the
      // backfills, which only fill an empty timing, so the real answer three
      // rows later ("Okay so that's the fifteenth") was never looked for.
      timing = normaliseTimingWording(timing);
      timingShapeIssue = timingPublicationIssue(timing);
      if (timingShapeIssue) timing = timingForPublication(timing);
      if (!['rejected', 'needs_rebind'].includes(activeTimingDecision?.status)) {
        timing = resolveOfferedDateChoice(backfillAskedTiming(backfillCitedTiming(timing, units, evidenceIds, timingOptions), units, evidenceIds, timingOptions), units, evidenceIds, timingOptions);
      }
      evidenceIds = recoveredTimingEvidence(evidenceIds, recoveredTimingEvidenceIds);
      // A generated action should name the work once. Its agreed deadline or
      // target belongs in the structured timing field, where it remains
      // searchable and can be checked independently of the action wording.
      if (timing.kind !== 'not_stated' && timing.wording) {
        action = replaceEmbeddedTiming(action, timing.wording, '', timing.exactDate);
      }
      // Replaced from the transcript rather than removed: nothing to report.
      if (timingShapeIssue && timing.kind !== 'not_stated' && timing.wording) timingShapeIssue = '';
    }
    // Agent output is corrected once, on the published actions, so every
    // change reaches the reviewer with its flag (see applyTimingClauseChecks).
    // Here only a reviewer's own entry is checked, and only flagged.
    const timingClauseNote = timingClauseChecksEnabled() && options.enforceEvidence === false
      ? timingClauseIssue(action, timing, units, evidenceIds) : null;
    const timingAssessment = TimingIntegrity.assessActionTiming({
      ...reviewerProvenance(item, options), id: item.id, action, owners, evidenceIds, timing,
      ...(item.timingDecision ? { timingDecision: item.timingDecision } : {})
    }, units, {
      meetingDate: options.meetingDate,
      reviewerAuthored: options.preserveReviewerEdits === true
    });
    timing = timingAssessment.action.timing;
    return {
      id: text(item?.id, 80) || stableId('action', action, index),
      ...(validOccurrenceId(item?.occurrenceId) ? { occurrenceId: item.occurrenceId } : {}),
      ...reviewerProvenance(item, options),
      action,
      owners,
      timing,
      ...(timingAssessment.assessment ? { timingDecision: timingAssessment.assessment } : {}),
      _timingDateIssues: [...timingAssessment.issues, ...(timing.kind === 'not_stated' ? timingRecoveryIssues : [])],
      _timingPublicationIssue: timingShapeIssue,
      _timingClauseNote: timingClauseNote,
      evidenceIds,
      reviewFlagIds: [...new Set((Array.isArray(item?.reviewFlagIds) ? item.reviewFlagIds : []).map((id) => text(id, 80)).filter(Boolean))],
      _unsupportedEvidenceIds: resolved.invalidIds,
      _weakEvidenceIds: resolved.weakIds,
      _evidenceDisposition: disposition,
      _timingConflicts: []
    };
  }).filter(Boolean);
  // A reviewer save is a persistence boundary, not another generation pass.
  // Preserve the exact visible register (including two similar rows) so an
  // autosave cannot silently remove an action or make a pending proposal's
  // indexes stale. Generated candidates still use the normal deduper.
  if (options.dedupeActions === false || options.preserveReviewerEdits === true) return rows;
  const merged = [];
  for (const row of rows) {
    let pair;
    const index = merged.findIndex((existing) => {
      pair = coveringActionPair(existing, row, actionSimilarity(existing, row) >= 0.78 && ownersCompatible(existing, row));
      return Boolean(pair);
    });
    if (index < 0) {
      merged.push(row);
      continue;
    }
    merged[index] = mergeCoveredActionRecords(...pair);
  }
  return merged;
}

function unresolvedReferenceFlags(units = []) {
  const standardLike = /\b(?:standard|IEC|ISO|EN|BS|ASTM|six(?:ty)?[- ]?oh[- ]?one|eight[- ]?ten[- ]?oh[- ]?one|twenty[- ]?seven)\b/i;
  const uncertainty = /\b(?:something|whatever|I think|maybe|roughly|approximately|or so|not sure|can't remember|cannot remember)\b/i;
  return evidenceContextFor(units).rows.filter((unit) => standardLike.test(unit.text) && uncertainty.test(unit.text)).map((unit, index) => normaliseFlag({
    kind: 'unclear_reference',
    message: `Confirm the standard reference exactly as spoken: “${unit.text.slice(0, 220)}”`,
    evidenceIds: [unit.id]
  }, index));
}

function normaliseExecutiveSummary(value) {
  return text(value, 3000);
}

// Last generation boundary: assess existing fields without deriving a date.
// The durable source-bound assessment also protects proposals/final survival
// from resurrecting an earlier rejected value.
function finaliseActionTimings(actions = [], units = [], options = {}) {
  const flags = [];
  const assessments = [];
  const checked = (Array.isArray(actions) ? actions : []).map((row) => {
    const result = TimingIntegrity.assessActionTiming(row, units, options);
    if (result.assessment) assessments.push(result.assessment);
    const issues = [...result.issues, ...(row.timing?.kind === 'not_stated' ? row._timingRecoveryIssues || [] : [])];
    const assessedAction = { ...result.action };
    delete assessedAction._timingRecoveryIssues;
    if (!issues.length) return assessedAction;
    const rowFlags = issues.map(issue => {
      const removed = row.timing?.wording && !assessedAction.timing?.wording
        && (assessedAction.timingDecision?.rejectedWordings || []).includes(row.timing.wording);
      const message = /^timing_inference_/.test(issue.code) ? issue.message
        : `${issue.message} ${isReviewerAuthored(row) ? 'Confirm the reviewer-entered timing.' : issue.preserveValue ? 'The stated date was retained for review.' : removed ? 'The unsupported timing was removed; confirm this work’s own timing.' : 'The exact date was removed; confirm the retained source wording.'}`;
      return normaliseFlag(actionTimingIssueFlag({ code: removed ? 'timing_value_removed' : issue.code }, row, message), flags.length);
    });
    flags.push(...rowFlags);
    return { ...assessedAction, reviewFlagIds: [...new Set([...(assessedAction.reviewFlagIds || []), ...rowFlags.map(flag => flag.id)])] };
  });
  return { actions: checked, flags, assessments };
}

function normaliseAgentResult(candidate = {}, units = [], stage = '', options = {}) {
  // enforceEvidence strips owners and timings the cited passages do not support.
  // That is right for agent output. It is wrong for a reviewer's own edits: the
  // reviewer is the human check on the agent, so their entry is flagged for
  // confirmation but never silently reverted.
  const enforceEvidence = options.enforceEvidence !== false;
  const discussion = normaliseDiscussion(candidate, units, options);
  const actions = normaliseActions(candidate, units, options);
  const objectives = normalisePointList(candidate.objectives, units, 'objective');
  const executiveSummary = normaliseExecutiveSummary(candidate.executiveSummary);
  // Objectives carry evidence links like any other record, but they are a
  // synthesis rather than a citable claim, so they are deliberately left out of
  // the missing-evidence sweep below - every save would otherwise re-flag them.
  for (const objective of objectives) delete objective._unsupportedEvidenceIds;
  const flags = (Array.isArray(candidate.reviewFlags) ? candidate.reviewFlags : []).filter((flag) => !isAutomaticTerminologyFlag(flag)).map(normaliseFlag);
  const suppliedFlagCount = flags.length;
  const flagRecords = flagRecordsIn([...discussion, ...actions]);
  const originalFlagReferences = new Map(flagRecords.map(record => [record, new Set(record.reviewFlagIds)]));
  const records = [
    ...discussion.flatMap((topic) => [...topic.points, ...topic.decisions, ...topic.openQuestions]),
    ...actions
  ];
  const unitById = new Map(evidenceContextFor(units).rows.map((unit) => [unit.id, unit]));
  for (const action of actions) {
    for (const issue of action._timingDateIssues || []) {
      const message = /^timing_inference_/.test(issue.code) ? issue.message
        : `${issue.message} ${issue.preserveValue ? 'The stated date was retained for review.' : enforceEvidence ? 'The exact date was removed; confirm the retained source wording.' : 'Confirm the timing.'}`;
      const flag = normaliseFlag(actionTimingIssueFlag(issue, action, message), flags.length);
      flags.push(flag);
      action.reviewFlagIds.push(flag.id);
    }
    delete action._timingDateIssues;
    const evidenceText = evidenceWindowText(units, action.evidenceIds, 1);
    const unsupportedOwners = action.owners.filter((owner) => !ownerSupportedByEvidence(owner, evidenceText, units)
      && !ownerAssignedInMeeting(owner, action.action, units));
    if (unsupportedOwners.length) {
      if (enforceEvidence) action.owners = action.owners.filter((owner) => !unsupportedOwners.includes(owner));
      const flag = normaliseFlag({
        kind: 'ownership',
        message: `Confirm or correct unsupported action ownership: ${unsupportedOwners.join(', ')}.`,
        evidenceIds: action.evidenceIds
      }, flags.length);
      flags.push(flag);
      action.reviewFlagIds.push(flag.id);
    }
    if (action._timingPublicationIssue) {
      const flag = normaliseFlag({
        kind: 'timing',
        message: action._timingPublicationIssue === 'task_duration_not_due_date'
          ? 'Timing was removed because it described how long the work lasts rather than when it is due.'
          : action._timingPublicationIssue === 'no_timing_signal'
            ? 'Timing was removed because it does not say when the work is due or what it depends on.'
            : 'Timing was removed because it was a copied action sentence rather than a date, target or dependency phrase.',
        evidenceIds: action.evidenceIds
      }, flags.length);
      flags.push(flag);
      action.reviewFlagIds.push(flag.id);
    }
    if (action.timing.kind !== 'not_stated') {
      if (correctnessChecksEnabled() && !timingWordingHasMeaning(action.timing)) {
        const meaninglessTiming = action.timing.wording || action.timing.exactDate;
        if (enforceEvidence) action.timing = { kind: 'not_stated', wording: '', exactDate: '' };
        const flag = normaliseFlag({
          kind: 'timing',
          message: `Timing ${enforceEvidence ? 'removed' : 'needs checking'} because "${meaninglessTiming}" does not state a date, target or dependency.`,
          evidenceIds: action.evidenceIds
        }, flags.length);
        flags.push(flag);
        action.reviewFlagIds.push(flag.id);
        if (enforceEvidence) continue;
      }
      const wordingSupported = action.timing.wording && (
        evidenceText.toLowerCase().includes(action.timing.wording.toLowerCase()) ||
        tokenOverlap(action.timing.wording, evidenceText) >= 0.5
      );
      // Exact-date validity and source-to-action binding were assessed above
      // by the shared policy. Do not re-derive the same date as its own proof,
      // or erase a genuine source-stated overdue date merely for being past.
      const exactDateSupported = Boolean(action.timing.exactDate && TimingIntegrity.isValidCalendarDate(action.timing.exactDate));
      if (!wordingSupported && !exactDateSupported) {
        const unsupportedTiming = action.timing.wording || action.timing.exactDate;
        if (enforceEvidence) action.timing = { kind: 'not_stated', wording: '', exactDate: '' };
        const flag = normaliseFlag({
          kind: 'timing',
          message: `Confirm or correct unsupported action timing: ${unsupportedTiming}.`,
          evidenceIds: action.evidenceIds
        }, flags.length);
        flags.push(flag);
        action.reviewFlagIds.push(flag.id);
      }
    }
    if (action._timingClauseNote) {
      const note = action._timingClauseNote;
      const flag = normaliseFlag({
        kind: 'timing',
        message: note.type === 'reassign'
          ? `The cited passage gives "${note.from}" for a different step and "${note.to}" for this one. Confirm the timing.`
          : '',
        evidenceIds: action.evidenceIds
      }, flags.length);
      flags.push(flag);
      action.reviewFlagIds.push(flag.id);
    }
    if (action._timingConflicts?.length) {
      const flag = normaliseFlag({
        kind: 'timing',
        message: 'Conflicting timing was returned for duplicate versions of this action; confirm the correct timing.',
        evidenceIds: action.evidenceIds
      }, flags.length);
      flags.push(flag);
      action.reviewFlagIds.push(flag.id);
    }
  }
  if (correctnessChecksEnabled()) {
    const discussionRecords = new Set(discussion.flatMap((topic) => [...topic.points, ...topic.decisions, ...topic.openQuestions]));
    for (const record of records) {
      if (!discussionRecords.has(record) || !record.evidenceIds.length) continue;
      const revision = laterRevisionUnit(units, record.evidenceIds) || citedRevisionUnit(units, record.evidenceIds, record.text || record.action || '');
      if (revision) {
        record.evidenceIds = [...new Set([...record.evidenceIds, revision.id])].slice(0, 8);
        const flag = normaliseFlag({
          kind: 'uncertain_fact',
          message: `Conflicting passage: the speaker appears to revise this shortly afterwards ("${salientExcerpt(revision.text, /./).slice(0, 200)}"). Confirm which statement is current.`,
          evidenceIds: record.evidenceIds
        }, flags.length);
        flags.push(flag);
        record.reviewFlagIds.push(flag.id);
      }
    }
  }
  for (const [index, record] of records.entries()) {
    if (record._unsupportedEvidenceIds?.length) {
      const flag = normaliseFlag({
        kind: 'missing_evidence',
        message: `"${recordLabel(record)}" pointed to transcript lines that do not exist (${record._unsupportedEvidenceIds.join(', ')}). Check it against the transcript.`,
        evidenceIds: record.evidenceIds
      }, flags.length + index);
      flags.push(flag);
      record.reviewFlagIds.push(flag.id);
    }
    const hadWeakEvidence = Boolean(record._weakEvidenceIds?.length);
    if (hadWeakEvidence) {
      const flag = normaliseFlag({
        kind: 'missing_evidence',
        message: `The linked transcript lines only partly support "${recordLabel(record)}". Check the wording against the transcript.`,
        evidenceIds: record.evidenceIds
      }, flags.length + index);
      flags.push(flag);
      record.reviewFlagIds.push(flag.id);
    }
    delete record._unsupportedEvidenceIds;
    delete record._weakEvidenceIds;
    delete record._evidenceDisposition;
    delete record._timingConflicts;
    delete record._timingClauseNote;
    delete record._timingPublicationIssue;
    if (hadWeakEvidence && !record.evidenceIds.length) continue;
    if (record.evidenceIds.length) continue;
    const flag = normaliseFlag({ kind: 'missing_evidence', message: `No transcript passage clearly supports "${recordLabel(record)}". Check it, or delete it if it was not said.` }, flags.length + index);
    flags.push(flag);
    record.reviewFlagIds.push(flag.id);
  }
  if (stage === 'discussion') flags.push(...unresolvedReferenceFlags(units));
  // A review decision belongs to its original warning and row. Only untouched
  // automatic duplicates, or a validation warning regenerated for that same
  // target, may share a flag. Build the kept list and aliases together so they
  // can never disagree about which reviewer decisions remain distinct.
  const { reviewFlags, alias } = uniqueFlags(flags, suppliedFlagCount, flagRecords, originalFlagReferences);
  if (alias.size) {
    const repoint = (record) => {
      if (Array.isArray(record?.reviewFlagIds)) record.reviewFlagIds = [...new Set(record.reviewFlagIds.map((id) => {
        const visited = new Set();
        while (alias.has(id) && !visited.has(id)) { visited.add(id); id = alias.get(id); }
        return id;
      }))];
      for (const detail of record?.supportingDetails || []) repoint(detail);
    };
    for (const topic of discussion) for (const record of [...(topic.points || []), ...(topic.decisions || []), ...(topic.openQuestions || [])]) repoint(record);
    for (const action of actions) repoint(action);
  }
  return { schemaVersion: SCHEMA_VERSION, discussion, actions, objectives, executiveSummary, reviewFlags };
}

// Evidence flags name their item, so flags for different items never merge (a
// new unsupported item always gets its own open flag, even when an earlier
// item with the same problem was resolved).
function recordLabel(record = {}) {
  const value = text(record.action || record.text, 400);
  return value.length > 90 ? `${value.slice(0, 87).replace(/\s+\S*$/, '')}…` : value;
}

function reviewFlagContentKey(flag) {
  return JSON.stringify([
    flag.kind.toLowerCase(), flag.message.toLowerCase(), flag.evidenceIds.map(id => id.toLowerCase()).sort(),
    flag.reviewerAuthored === true, flag.systemTimingIssue || null, flag.temporalField || ''
  ]);
}

function reviewFlagIdentityKey(flag) {
  // Handled or annotated warnings keep their own identities even if two
  // reviewers happened to choose the same status and note for separate rows.
  const untouched = flag.status === 'open' && !flag.correctionNote && !flag.reviewerAuthored;
  return JSON.stringify([reviewFlagContentKey(flag), flag.status, flag.correctionNote, untouched ? '' : flag.id]);
}

function uniqueFlags(flags = [], suppliedCount = flags.length, records = [], originalReferences = new Map()) {
  const supplied = flags.slice(0, suppliedCount);
  const suppliedIds = new Set(supplied.map(flag => flag.id));
  const alias = new Map();
  const retained = flags.filter((flag, index) => {
    if (index < suppliedCount) return true;
    const targets = records.filter(record => record.reviewFlagIds.includes(flag.id));
    const matching = supplied.filter(prior => reviewFlagContentKey(prior) === reviewFlagContentKey(flag)
      && (!suppliedIds.has(flag.id) || prior.id === flag.id)
      && targets.length && targets.every(record => originalReferences.get(record)?.has(prior.id)));
    // Content alone is insufficient: another incoming row may still need the
    // same warning. Reuse a decision only when its existing target is known.
    if (matching.length !== 1) return true;
    if (flag.id !== matching[0].id) alias.set(flag.id, matching[0].id);
    return false;
  });
  const kept = new Map();
  const reviewFlags = retained.filter(flag => {
    const key = reviewFlagIdentityKey(flag);
    if (kept.has(key)) {
      if (flag.id !== kept.get(key)) alias.set(flag.id, kept.get(key));
      return false;
    }
    kept.set(key, flag.id);
    return true;
  });
  // normaliseFlag remembers generated copies too; restore the persisted
  // review state if such a copy reused an existing warning's deterministic id.
  reviewFlags.forEach(rememberFlag);
  return { reviewFlags, alias };
}

function coverageFlags(inventory = [], result = {}) {
  const output = JSON.stringify({
    discussion: result.discussion || [],
    actions: result.actions || [],
    executiveSummary: result.executiveSummary || '',
    meetingObjectives: result.meetingObjectives || result.objectives || []
  });
  return inventory.filter((item) => Math.max(tokenOverlap(item.text, output), evidenceSupportScore(item.text, output)) < 0.28).slice(0, 12).map((item, index) => normaliseFlag({
    id: `coverage-${item.id}`,
    kind: item.kind === 'standard_reference' ? 'unclear_reference' : 'uncertain_fact',
    message: `${COVERAGE_FLAG_MESSAGE} “${item.text.slice(0, 220)}”`,
    evidenceIds: item.evidenceIds
  }, index));
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

function surroundingEvidence(units = [], ids = []) {
  const rows = normaliseSourceUnits(units);
  const wanted = new Set(ids);
  const indexes = rows.map((unit, index) => wanted.has(unit.id) ? index : -1).filter((index) => index >= 0);
  const include = new Set(indexes.flatMap((index) => [index - 1, index, index + 1]).filter((index) => index >= 0 && index < rows.length));
  return [...include].sort((a, b) => a - b).map((index) => ({ ...rows[index], cited: wanted.has(rows[index].id) }));
}

// Anchors on rows that are unchanged, so an insertion is ONE change rather than
// a modify of every row after it. Positional diffing made partial acceptance
// unsound: accepting a lone "add" duplicated a row, accepting a lone "modify"
// deleted one. Lists here are capped at 250 rows, so the DP table is cheap.
function unchangedRowPairs(before, after) {
  const a = before.map((row) => JSON.stringify(row));
  const b = after.map((row) => JSON.stringify(row));
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { pairs.push([i, j]); i += 1; j += 1; }
    else if (table[i + 1][j] >= table[i][j + 1]) i += 1;
    else j += 1;
  }
  return pairs;
}

function proposalRowText(row) {
  if (!row) return '';
  if (typeof row === 'string') return row;
  const parts = [row.action, row.topic, row.text].filter((value) => typeof value === 'string' && value);
  return parts.length ? parts.join(' ') : JSON.stringify(row);
}

// Inside a run of changed rows, decide which old row became which new row.
// Identity first (a stable id survives an edit), then content similarity.
// Pairing by position instead is what made a rewritten row read as "delete this
// one, add an unrelated one" and corrupted partial acceptance.
function pairGapRows(oldRows, newRows, removed, added) {
  const pairs = new Map();
  const takenNew = new Set();
  const rowId = (row) => (row && typeof row.id === 'string' ? row.id : '');
  for (const oldIndex of removed) {
    const id = rowId(oldRows[oldIndex]);
    if (!id) continue;
    const match = added.find((newIndex) => !takenNew.has(newIndex) && rowId(newRows[newIndex]) === id);
    if (match !== undefined) { pairs.set(oldIndex, match); takenNew.add(match); }
  }
  for (const oldIndex of removed) {
    if (pairs.has(oldIndex)) continue;
    let best = -1;
    let bestScore = 0;
    for (const newIndex of added) {
      if (takenNew.has(newIndex)) continue;
      const score = tokenOverlap(proposalRowText(oldRows[oldIndex]), proposalRowText(newRows[newIndex]));
      if (score > bestScore) { bestScore = score; best = newIndex; }
    }
    if (best >= 0 && bestScore >= 0.5) { pairs.set(oldIndex, best); takenNew.add(best); }
  }
  return pairs;
}

function proposalChange(stage, type, previous, next, beforeIndex, afterIndex) {
  return {
    id: stableId('change', `${stage}|${type}|${JSON.stringify(previous)}|${JSON.stringify(next)}`, afterIndex == null ? beforeIndex : afterIndex),
    type,
    before: previous,
    after: next,
    // Positions in the ORIGINAL list. An add carries the original index it is
    // inserted in front of, so accepting any subset lands in the right place.
    beforeIndex,
    afterIndex,
    index: afterIndex == null ? beforeIndex : afterIndex
  };
}

function buildProposal(stage, before = [], after = []) {
  const oldRows = Array.isArray(before) ? before : [];
  const newRows = Array.isArray(after) ? after : [];
  const changes = [];
  let oldCursor = 0;
  let newCursor = 0;
  const emitGap = (oldEnd, newEnd) => {
    const removed = [];
    for (let i = oldCursor; i < oldEnd; i += 1) removed.push(i);
    const added = [];
    for (let j = newCursor; j < newEnd; j += 1) added.push(j);
    if (!removed.length && !added.length) return;
    const pairs = pairGapRows(oldRows, newRows, removed, added);
    for (const oldIndex of removed) {
      if (pairs.has(oldIndex)) changes.push(proposalChange(stage, 'modify', oldRows[oldIndex], newRows[pairs.get(oldIndex)], oldIndex, pairs.get(oldIndex)));
      else changes.push(proposalChange(stage, 'remove', oldRows[oldIndex], null, oldIndex, null));
    }
    const pairedNew = new Set([...pairs.values()]);
    for (const newIndex of added) {
      if (pairedNew.has(newIndex)) continue;
      let insertAt = oldCursor;
      for (const [oldIndex, partner] of pairs) if (partner < newIndex) insertAt = Math.max(insertAt, oldIndex + 1);
      changes.push(proposalChange(stage, 'add', null, newRows[newIndex], insertAt, newIndex));
    }
  };
  for (const [oldIndex, newIndex] of unchangedRowPairs(oldRows, newRows)) {
    emitGap(oldIndex, newIndex);
    oldCursor = oldIndex + 1;
    newCursor = newIndex + 1;
  }
  emitGap(oldRows.length, newRows.length);
  return { id: stableId('proposal', `${stage}|${Date.now()}`), stage, createdAt: new Date().toISOString(), changes };
}

function applyProposal(before = [], proposal = {}, acceptedIds = [], options = {}) {
  const accepted = new Set(acceptedIds);
  const rows = Array.isArray(before) ? before : [];
  // IDs from independent model responses are ordinal labels, not globally
  // unique identities. Destructive changes require the same editable content;
  // evidence/flag updates do not make an otherwise unchanged row stale.
  const reviewShape = (row) => {
    if (!row || typeof row !== 'object') return row;
    if (row.action != null) return { action: row.action, owners: [...(row.owners || [])].sort(),
      timing: { kind: row.timing?.kind || 'not_stated', wording: row.timing?.wording || '', exactDate: row.timing?.exactDate || '' } };
    return { ...(row.topic != null ? { topic: row.topic, hideHeading: row.hideHeading === true } : { text: row.text }),
      ...Object.fromEntries(['points', 'decisions', 'openQuestions', 'supportingDetails']
        .filter(kind => Array.isArray(row[kind])).map(kind => [kind, row[kind].map(reviewShape)])) };
  };
  const signature = row => JSON.stringify(reviewShape(row));
  const targetKey = row => JSON.stringify([text(row?.id, 80), signature(row)]);
  const targetIdCounts = new Map();
  const legacyActionTargetCounts = new Map();
  const legacyActionKey = row => JSON.stringify([text(row?.id, 80), actionProvenanceSignature(row)]);
  for (const change of proposal.changes || []) {
    if (change.type === 'add') continue;
    const key = targetKey(change.before);
    targetIdCounts.set(key, (targetIdCounts.get(key) || 0) + 1);
    if (change.before?.action != null && !validOccurrenceId(change.before.occurrenceId)) {
      const legacyKey = legacyActionKey(change.before);
      const positions = legacyActionTargetCounts.get(legacyKey) || new Set();
      // Several suggestions can address the same original row. Count captured
      // occurrences, not alternative edits/removals of that one occurrence.
      positions.add(Number.isInteger(change.beforeIndex) ? change.beforeIndex
        : Number.isInteger(change.index) ? change.index : `unknown:${change.id}`);
      legacyActionTargetCounts.set(legacyKey, positions);
    }
  }
  const originalIndex = (change) => (Number.isInteger(change.beforeIndex) ? change.beforeIndex : Number(change.index) || 0);
  const currentIndex = (change) => {
    const beforeRecord = change?.before;
    if (!beforeRecord || typeof beforeRecord !== 'object') return -1;
    if (beforeRecord.action != null) {
      if (!validOccurrenceId(beforeRecord.occurrenceId)) {
        const key = legacyActionKey(beforeRecord);
        const captured = legacyActionTargetCounts.get(key)?.size || 0;
        const remaining = rows.filter(row => row?.action != null && legacyActionKey(row) === key).length;
        if (captured > 1 && remaining < captured && !rows.some(row => row === beforeRecord)) return -1;
      }
      return findActionOccurrenceIndex(rows, beforeRecord);
    }
    const id = text(beforeRecord.id, 80);
    if (id) {
      const candidates = rows.map((row, index) => text(row?.id, 80) === id
        && signature(row) === signature(beforeRecord) ? index : -1).filter((index) => index >= 0);
      if (targetIdCounts.get(targetKey(beforeRecord)) > 1 || candidates.length > 1) {
        // Generated lists have historically contained duplicate IDs. When a
        // proposal addressed two such rows and autosave has already removed
        // one, the surviving ID is not proof that the other target remains.
        // Only its original occurrence is safe to edit or remove.
        const expected = originalIndex(change);
        return candidates.includes(expected) ? expected : -1;
      }
      return candidates.length === 1 ? candidates[0] : -1;
    }
    const matches = rows.map((row, index) => signature(row) === signature(beforeRecord) ? index : -1).filter(index => index >= 0);
    return matches.length === 1 ? matches[0] : -1;
  };
  const modified = new Map();
  const removed = new Set();
  const inserted = new Map();
  const claimedTargets = new Set();
  for (const change of proposal.changes || []) {
    if (!accepted.has(change.id)) continue;
    if (change.type === 'add') {
      const afterId = text(change.after?.id, 80);
      let addition = change.after;
      if (proposal.stage === 'actions' && addition?.action != null) {
        const generationKey = `${proposal.id || ''}|${change.id || ''}`;
        const claimedOccurrence = validOccurrenceId(addition.occurrenceId);
        if (claimedOccurrence && rows.some(row => validOccurrenceId(row.occurrenceId) === claimedOccurrence
          && actionProvenanceSignature(row) !== actionProvenanceSignature(addition))) {
          addition = { ...addition };
          delete addition.occurrenceId;
        }
        const expected = assignGeneratedActionIdentities([addition], { generationKey }).actions[0];
        const occurrenceId = validOccurrenceId(addition.occurrenceId) || expected.occurrenceId;
        if (rows.some(row => validOccurrenceId(row.occurrenceId) === occurrenceId
          && actionProvenanceSignature(row) === actionProvenanceSignature(addition))) continue;
        if (!validOccurrenceId(addition.occurrenceId) && rows.some(row => text(row.id, 80) === afterId
          && actionProvenanceSignature(row) === actionProvenanceSignature(addition))) continue;
        addition = assignGeneratedActionIdentities([{ ...addition, occurrenceId }], { generationKey,
          reservedActions: [...rows, ...[...inserted.values()].flat(), ...(options.reservedActions || [])] }).actions[0];
      } else if (rows.some((row) => (!afterId || text(row?.id, 80) === afterId)
        && signature(row) === signature(addition))) continue;
      const at = Math.max(0, Math.min(rows.length, originalIndex(change)));
      inserted.set(at, [...(inserted.get(at) || []), addition]);
      if (typeof options.onAppliedChange === 'function') options.onAppliedChange(change);
      continue;
    }
    // Never use an old numeric position for a destructive change. Autosave,
    // regeneration or a prior accepted suggestion may have reordered or
    // removed the original row; applying that stale index deleted unrelated
    // actions in the finished minutes.
    const at = currentIndex(change);
    if (at < 0 || claimedTargets.has(at)) continue;
    claimedTargets.add(at);
    if (change.type === 'remove') {
      removed.add(at);
      if (typeof options.onAppliedChange === 'function') options.onAppliedChange(change);
    } else if (change.type === 'modify') {
      modified.set(at, rows[at]?.action != null
        ? preserveActionIdentity(rows[at], change.after) : change.after);
      if (typeof options.onAppliedChange === 'function') options.onAppliedChange(change);
    }
  }
  // Rebuild from the original rows rather than splicing, so each accepted change
  // is independent of which other changes were accepted.
  const result = [];
  for (let i = 0; i <= rows.length; i += 1) {
    for (const row of inserted.get(i) || []) result.push(row);
    if (i === rows.length) break;
    if (removed.has(i)) continue;
    result.push(modified.has(i) ? modified.get(i) : rows[i]);
  }
  return result;
}

module.exports = {
  SCHEMA_VERSION,
  TIMING_INFERENCE_POLICY_VERSION,
  PAYLOAD_VERSION,
  migrateDraftPayload,
  text,
  sanitiseDetails,
  normaliseSourceUnits,
  preparedTranscriptFromUnits,
  salientDetailInventory,
  normaliseAgentResult,
  explicitValuePresent,
  normaliseExecutiveSummary,
  normaliseFlag,
  coverageFlags,
  surroundingEvidence,
  buildProposal,
  applyProposal,
  isIdeaOnlyContemplation,
  cleanActionWording,
  normaliseKnownTerms,
  normaliseColloquialTimes,
  normaliseKnownTermsDeep,
  isAutomaticTerminologyFlag,
  isSalientCoverageFlag,
  isUsefulReviewFlag,
  evidenceWindowUnits,
  boundedReviewEvidence,
  evidenceSupportScore,
  evidenceContextFor,
  clearMeetingMinutesAgentV2MemoryCaches,
  resolveEvidence,
  normaliseActions,
  actionEvidenceDisposition,
  actionNegatedByEvidence,
  actionCandidateInventory,
  addressedRequestAcceptedAhead,
  actionCommitmentThreadInventory,
  actionCommitmentChainInventory,
  discussionCandidateInventory,
  discussionAnchorInventory,
  candidatePromptPack,
  uncoveredCandidateInventory,
  discussionRecoveryNeeded,
  actionRecoveryNeeded,
  groundedObjectives,
  groundedObjectiveRecords,
  mergeGroundedObjectiveRecords,
  groundedExecutiveSummary,
  relativeExactDate,
  timingWordingHasMeaning,
  normaliseTimingWording,
  timingPublicationIssue,
  timingForPublication,
  finaliseActionTimings,
  correctnessChecksEnabled,
  timingClauseIssue,
  applyTimingClauseChecks,
  backfillActionCommitmentEvidence,
  attachNearbyDependencyConditions,
  timingCheckEnabled,
  statedCalendarDate,
  reconcileRecordFlags,
  discussionActionCandidates,
  mentionedPeople,
  describesUsualPractice,
  isNotAnAction,
  isLiveCallConduct,
  isMeetingAdminShare,
  hasTimingSignal,
  trimDanglingTail,
  endsOnDanglingTail,
  isMinuteInstruction,
  isSocialAside,
  isAobPersonalAside,
  isFarewellAction,
  softenBestEffortCompletion,
  demoteSupersededRows,
  labelSupersededContext,
  promoteNamedFactDetails,
  quantityTokens,
  QUANTIFIED_FACT,
  promoteMaterialObjectionDetails,
  supersededCheckItems,
  supersededVerdicts,
  applyRequesterOwnerRule,
  backfillAskedTiming,
  acceptanceAroundEvidence,
  acceptanceAroundEvidenceDetail,
  resolveOfferedDateChoice,
  ownerTakesItOn,
  ownerAssignedInMeeting,
  assignsWorkTo,
  narratesOwnership,
  turnWindowRows,
  addressedRequestAccepted,
  groundRowAttributions,
  flagConflictingDiscussionRoles,
  mergeDuplicateCommitments,
  splitExplicitMultiOwnerActions,
  timingBoundToActionSteps,
  reconcileSiblingTimingDecisions,
  applyChainedTimingRule,
  timingAttachedToEarlierStep,
  timingReportedForDifferentActor,
  answeredCheckEnabled,
  answeredCheckItems,
  answeredCheckPrompt,
  applyAnsweredCheckResults,
  openQuestionCheckItems,
  openQuestionCheckPrompt,
  applyOpenQuestionCheckResults,
  completedInMeetingCheckItems,
  completedInMeetingCheckPrompt,
  applyCompletedInMeetingCheckResults,
  commitmentCheckEnabled,
  commitmentCheckItems,
  commitmentCheckPrompt,
  applyCommitmentCheckResults,
  finalActionLifecycleCheckItems,
  finalActionLifecycleCheckPrompt,
  applyFinalActionLifecycleResults,
  quoteIsOnlyAPromise,
  itemHasExplicitOutstandingEvidence,
  commitmentQuoteTiesOwner,
  commitmentQuoteAboutAction,
  isMeetingAdminAction,
  decisionCheckEnabled,
  decisionCheckItems,
  decisionCheckPrompt,
  decisionQuoteFound,
  decisionQuoteValidation,
  decisionPolarityIssue,
  applyDecisionCheckResults,
  discussionFidelityCheckItems,
  discussionFidelityCheckPrompt,
  applyDiscussionFidelityResults,
  quantifiedClaimGroundingIssue,
  filterUnsupportedQuantifiedDiscussion,
  groundUnstatedDiscussionMonths,
  stripUnstatedMonths,
  actionCompletenessCheckItems,
  actionCompletenessCheckPrompt,
  applyActionCompletenessResults,
  timingCheckItems,
  timingCheckPrompt,
  applyTimingCheckResults,
  claimNovelty,
  uncitedClaimSupported,
  timingClauseChecksEnabled,
  laterRevisionUnit,
  evidenceClauses,
  materialTokens,
  contentTokens,
  comparisonText,
  evidenceWindowText
};
