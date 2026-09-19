'use strict';

const crypto = require('crypto');

// The response contract asked of the agent. It is interpolated into the prompt
// ("Return schemaVersion N ..."), so changing it changes what Power Automate is
// told to return - do NOT bump it to describe a change in what we store on disk.
const SCHEMA_VERSION = 4;

// What is stored in the draft payload. Separate from SCHEMA_VERSION on purpose.
const PAYLOAD_VERSION = 5;

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
  'uncertain_fact', 'unclear_reference', 'ownership', 'timing',
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
  'mark kelleher', 'john-paul hughes', 'jenny gough', 'stuart smith', 'orla skally'
].map((name) => name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[’‘`]/g, "'").toLowerCase()));
const MDSAP_SPOKEN_FORM = /\bmeds[\s-]*app\b/i;
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
  return normaliseColloquialTimes(value).replace(/\bmeds[\s-]*app\b/gi, 'MDSAP');
}

function normaliseKnownTermsDeep(value) {
  if (typeof value === 'string') return normaliseKnownTerms(value);
  if (Array.isArray(value)) return value.map(normaliseKnownTermsDeep);
  if (value && typeof value === 'object') {
    if (value instanceof Date) return value;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normaliseKnownTermsDeep(item)]));
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

function sanitiseDetails(candidate = {}) {
  const names = (value) => [...new Set((Array.isArray(value) ? value : [])
    .map((name) => text(name, 180)).filter(Boolean))].slice(0, 100);
  const attendeeKey = (name) => text(name, 180).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[’‘`]/g, "'").toLowerCase();
  const suppliedAll = names(candidate.allAttendees || candidate.participants);
  let internalAttendees = names(candidate.internalAttendees);
  let clientAttendees = names(candidate.clientAttendees);
  if (!internalAttendees.length && !clientAttendees.length) {
    internalAttendees = suppliedAll.filter((name) => KNOWN_INTERNAL_ATTENDEE_KEYS.has(attendeeKey(name)));
    clientAttendees = suppliedAll.filter((name) => !KNOWN_INTERNAL_ATTENDEE_KEYS.has(attendeeKey(name)));
  } else {
    const assigned = new Set([...internalAttendees, ...clientAttendees].map(attendeeKey));
    clientAttendees.push(...suppliedAll.filter((name) => !assigned.has(attendeeKey(name))));
  }
  const internalKeys = new Set(internalAttendees.map(attendeeKey));
  clientAttendees = clientAttendees.filter((name) => !internalKeys.has(attendeeKey(name)));
  const allAttendees = names([...suppliedAll, ...internalAttendees, ...clientAttendees]);
  return {
    meetingTitle: text(candidate.meetingTitle, 300),
    meetingDate: /^\d{4}-\d{2}-\d{2}$/.test(text(candidate.meetingDate, 20)) ? text(candidate.meetingDate, 20) : '',
    meetingLocation: text(candidate.meetingLocation, 200),
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
const evidenceContextCache = new WeakMap();
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
  if (claim.values.some((value) => !evidence.lower.includes(value))) return 0;
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

function evidenceWindowUnits(units = [], ids = [], radius = 1) {
  const rows = evidenceContextFor(units).rows;
  const wanted = new Set((Array.isArray(ids) ? ids : []).map((id) => text(id, 30)));
  const indexes = rows.map((unit, index) => wanted.has(unit.id) ? index : -1).filter((index) => index >= 0);
  const included = new Set(indexes.flatMap((index) => {
    const values = [];
    for (let offset = -radius; offset <= radius; offset += 1) values.push(index + offset);
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

function polarity(value) {
  return /\b(?:no|not|never|cannot|can't|won't|isn't|aren't|wasn't|weren't|without)\b/i.test(String(value || '')) ? 'negative' : 'positive';
}

function evidenceSupportScore(claim, evidence) {
  const claimText = text(claim, 5000);
  const evidenceText = text(evidence, 15000);
  if (!claimText || !evidenceText) return 0;
  const values = explicitValues(claimText);
  if (values.some((value) => !evidenceText.toLowerCase().includes(value))) return 0;
  const claimMaterial = materialTokens(claimText);
  const evidenceWords = new Set(contentTokens(evidenceText));
  const materialCoverage = claimMaterial.length
    ? claimMaterial.filter((token) => evidenceWords.has(token)).length / claimMaterial.length
    : 0;
  const lexical = tokenOverlap(claimText, evidenceText);
  const polarityPenalty = polarity(claimText) !== polarity(evidenceText) && /\b(?:not|never|cannot|can't|won't|without)\b/i.test(claimText) ? 0.35 : 0;
  return Math.max(0, (lexical * 0.55) + (materialCoverage * 0.45) - polarityPenalty);
}

function speakerMentionsSupported(claim, evidence, units = [], suppliedSpeakerTokens = null) {
  const claimWords = new Set(contentTokens(claim));
  const evidenceWords = new Set(contentTokens(evidence));
  const speakers = suppliedSpeakerTokens || [...new Set((Array.isArray(units) ? units : []).map((unit) => text(unit?.speaker, 180)).filter(Boolean))]
    .map((speaker) => contentTokens(speaker)).filter((tokens) => tokens.length);
  for (const speakerWords of speakers) {
    if (!speakerWords.length) continue;
    const mentioned = speakerWords.length === 1
      ? claimWords.has(speakerWords[0])
      : speakerWords.every((word) => claimWords.has(word));
    if (mentioned && !speakerWords.some((word) => evidenceWords.has(word))) return false;
  }
  return true;
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
  ['sign', 'attest', 'acknowledge', 'accept']
];

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
  const maximumDistinctiveFrequency = Math.max(3, Math.ceil(rows.length * 0.04));
  const distinctiveClaimTokens = claimTokens.filter((token) => {
    const frequency = context.documentFrequency.get(token) || 0;
    return frequency > 0 && frequency <= maximumDistinctiveFrequency;
  });
  const resolutionScore = (windowProfile) => {
    const base = evidenceSupportScoreFromProfiles(claimProfile, windowProfile);
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
  const cacheKey = `${options.action ? 'a' : 'p'}|${text(value, 5000)}|${suppliedIds.join(',')}`;
  const cached = context.resolutionCache.get(cacheKey);
  if (cached) return { ...cached, evidenceIds: [...cached.evidenceIds], invalidIds: [...cached.invalidIds], weakIds: [...cached.weakIds] };
  const finish = (result) => {
    if (context.resolutionCache.size >= 2000) context.resolutionCache.clear();
    context.resolutionCache.set(cacheKey, result);
    return { ...result, evidenceIds: [...result.evidenceIds], invalidIds: [...result.invalidIds], weakIds: [...result.weakIds] };
  };
  const invalidIds = suppliedIds.filter((id) => !known.has(id));
  const validIds = suppliedIds.filter((id) => known.has(id));
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
    return finish({ evidenceIds: validIds.slice(0, 8), invalidIds, weakIds: [], supportScore: suppliedScore });
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

function evidenceIdsFor(value, units = [], supplied = []) {
  return resolveEvidence(value, units, supplied).evidenceIds;
}

// How the meeting was run, not what it decided. These lines are real speech and
// often survive denoising, but they are not minutes content, so they must never
// be inventoried as an important detail and surfaced as something to check.
// "I've got a delivery arriving, I need to shoot" is someone leaving the call,
// not a commitment, even though "need to" is a commitment cue. Leaving verbs
// are only treated as leaving when nothing is being shot/sent *to* anyone.
const LEAVING_REMARK_PATTERN = /\b(?:(?:need|needs|have|got|going|about|time) to (?:shoot|dash|go|run|head (?:off|out)|get off|leave|be off)\b(?!\s+(?:you|it|that|this|the|a|an|over|across|through|them))|i(?:'ll| will) (?:shoot|dash|head off|be off)\b(?!\s+(?:you|it|that|this|the|a|an|over|across|through|them))|let you go|gotta go|got to go|delivery(?:'s| is)? (?:here|arriving|at the door)|someone(?:'s| is)? at the door|catch you later|see you (?:later|then|soon|all)|speak (?:later|soon))\b/i;
const MEETING_ADMIN_PATTERN = /\b(?:hard stop|drop(?:ping)? off|another (?:call|meeting)|running late|can you hear|breaking up|share (?:my|the) screen|screen[- ]?shar|recording (?:has )?(?:started|stopped)|stop(?:ped)? recording|on mute|un\s?mute|you'?re muted|bear with me|lost (?:you|connection)|connection (?:is )?(?:bad|poor)|back in a (?:sec|second|minute))\b/i;
const DELIVERABLE_CONTEXT_PATTERN = /\b(?:action|approval|audit|assessment|CAPA|change|compliance|decision|document|file|finding|plan|procedure|report|review|risk|scope|software|standard|submission|test|tracker|training|translation|validation|version)\b/i;

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
    ['quantity', /\b(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:languages?|alarms?|devices?|products?|tests?|documents?|weeks?|days?|items?|versions?|samples?|units?|batches|sites?)\b/i],
    // A number is a standards reference because something says so in front of it.
    // The prefix used to be optional, which made this "any bare 3-5 digit number"
    // and turned "a hard stop at 1130" into a reference for the reviewer to check.
    ['standard_reference', /\b(?:BS\s+EN|EN|IEC|ISO|ASTM|standards?)\s+\d{3,5}(?:[-–]\d+)*(?::\d{4})?\b/i],
    ['alarm_behaviour', /\b(?:alarm|audible|mute|silenc|beep)\b/i],
    ['approval_status', /\b(?:approved?|accepted?|signed?\s*off|pending approval|not approved|rejected?)\b/i],
    ['blocker_dependency', /\b(?:block(?:ed|er|ing)?|depend(?:s|ent|ency)?|waiting for|subject to|before .* can|once .* (?:is|has been)|cannot .* until|pending)\b/i]
  ];
  const result = [];
  for (const unit of normaliseSourceUnits(units).filter(includedUnit)) {
    if (MEETING_ADMIN_PATTERN.test(unit.text) || LEAVING_REMARK_PATTERN.test(unit.text)) continue;
    for (const [kind, pattern] of patterns) {
      if (!pattern.test(unit.text)) continue;
      if (kind === 'alarm_behaviour' && /\bno alarm bells?\b/i.test(unit.text)) continue;
      if (kind === 'blocker_dependency' && !DELIVERABLE_CONTEXT_PATTERN.test(unit.text)) continue;
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
  return rememberFlag({
    id: text(flag.id, 80) || stableId('flag', `${kind}|${message}`, index),
    kind,
    message,
    evidenceIds: [...new Set((Array.isArray(flag.evidenceIds) ? flag.evidenceIds : []).map((id) => text(id, 30)).filter(Boolean))].slice(0, 8),
    status: ['open', 'confirmed', 'corrected', 'dismissed'].includes(flag.status) ? flag.status : 'open',
    correctionNote: text(flag.correctionNote, 500)
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
function reconcileRecordFlags(content = {}, flags = [], isUseful = () => true) {
  const copy = JSON.parse(JSON.stringify(content || {}));
  const byId = new Map((Array.isArray(flags) ? flags : []).map((flag) => [flag.id, flag]));
  const recovered = [];
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
  return MATERIAL_UNCERTAINTY_PATTERN.test(normalised.message);
}

function normalisePoint(value, units, prefix, index) {
  const candidate = typeof value === 'string' ? { text: value } : (value || {});
  const pointText = text(candidate.text || candidate.point || candidate.value, 1600);
  if (!pointText) return null;
  const suppliedIds = (Array.isArray(candidate.evidenceIds) ? candidate.evidenceIds : []).map((id) => text(id, 30)).filter(Boolean);
  const resolved = resolveEvidence(pointText, units, candidate.evidenceIds);
  if (correctnessChecksEnabled() && !suppliedIds.some((id) => evidenceContextFor(units).known.has(id))
    && resolved.evidenceIds.length && !uncitedClaimSupported(pointText, resolved, units)) {
    resolved.evidenceIds = [];
  }
  const supportingDetails = (Array.isArray(candidate.supportingDetails) ? candidate.supportingDetails : [])
    .map((detail, detailIndex) => {
      const source = typeof detail === 'string' ? { text: detail } : (detail || {});
      const detailText = text(source.text || source.point || source.value, 1600);
      if (!detailText) return null;
      const detailEvidence = resolveEvidence(detailText, units, source.evidenceIds);
      return {
        id: text(source.id, 80) || stableId(`${prefix}-supporting`, detailText, detailIndex),
        text: detailText,
        evidenceIds: detailEvidence.evidenceIds
      };
    }).filter(Boolean).slice(0, 50);
  return {
    id: text(candidate.id, 80) || stableId(prefix, pointText, index),
    text: pointText,
    evidenceIds: resolved.evidenceIds,
    supportingDetails,
    reviewFlagIds: [...new Set((Array.isArray(candidate.reviewFlagIds) ? candidate.reviewFlagIds : []).map((id) => text(id, 80)).filter(Boolean))],
    _unsupportedEvidenceIds: resolved.invalidIds,
    _weakEvidenceIds: resolved.weakIds
  };
}

function normalisePointList(values, units, prefix) {
  return (Array.isArray(values) ? values : []).map((value, index) => normalisePoint(value, units, prefix, index)).filter(Boolean).slice(0, 50);
}

function recordSimilarity(left, right) {
  const lexical = tokenOverlap(comparisonText(left?.text || ''), comparisonText(right?.text || ''));
  const leftEvidence = new Set(left?.evidenceIds || []);
  const sharedEvidence = (right?.evidenceIds || []).some((id) => leftEvidence.has(id));
  return lexical + (sharedEvidence ? 0.12 : 0);
}

function dedupePointList(values = []) {
  const kept = [];
  for (const value of values) {
    const duplicate = kept.find((existing) => recordSimilarity(existing, value) >= 0.86);
    if (!duplicate) kept.push(value);
    else {
      duplicate.evidenceIds = [...new Set([...(duplicate.evidenceIds || []), ...(value.evidenceIds || [])])].slice(0, 8);
      const details = [...(duplicate.supportingDetails || []), ...(value.supportingDetails || [])];
      duplicate.supportingDetails = details.filter((detail, index) => details.findIndex((other) =>
        comparisonText(other.text) === comparisonText(detail.text)) === index).slice(0, 50);
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

function normaliseDiscussion(candidate = {}, units = []) {
  const topics = discussionTopicItems(candidate).slice(0, 80).map((item, index) => {
    const topic = text(item?.topic, 220) || 'Discussion';
    return {
      id: text(item?.id, 80) || stableId('topic', topic, index),
      topic,
      points: dedupePointList(normalisePointList(item?.points, units, `point-${index}`)),
      decisions: dedupePointList(normalisePointList(item?.decisions, units, `decision-${index}`)),
      openQuestions: dedupePointList(normalisePointList(item?.openQuestions, units, `question-${index}`))
    };
  }).filter((item) => item.points.length || item.decisions.length || item.openQuestions.length);
  const merged = [];
  for (const topic of topics) {
    const existing = merged.find((item) => tokenOverlap(comparisonText(item.topic), comparisonText(topic.topic)) >= 0.82);
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
  return merged;
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

function isoDateOffset(meetingDate, days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(meetingDate || ''))) return '';
  const date = new Date(`${meetingDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function relativeExactDate(wording, meetingDate) {
  const value = text(wording, 220).toLowerCase();
  if (!value || !meetingDate) return '';
  if (/\btoday\b/.test(value)) return meetingDate;
  if (/\btomorrow\b/.test(value)) return isoDateOffset(meetingDate, 1);
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  // A weekday nested inside a relational phrase is context, not necessarily
  // the event date. "The weekend before Monday" must remain useful wording; it
  // must not be silently converted into Monday's calendar date.
  const relationalWeekday = /\b(?:weekend|day|week)\s+(?:before|after|following|prior to)\s+(?:this |next )?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b|\b(?:before|after|following|prior to)\s+(?:the )?(?:this |next )?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.test(value);
  if (relationalWeekday) return '';
  const named = weekdays.findIndex((day) => new RegExp(`\\b(?:this |next )?${day}\\b`).test(value));
  if (named >= 0) {
    const current = new Date(`${meetingDate}T00:00:00Z`).getUTCDay();
    let offset = (named - current + 7) % 7;
    if (/\bnext\s+/.test(value)) offset = offset === 0 ? 7 : offset + 7;
    else if (offset === 0) {
      // The meeting's own weekday. "Monday morning" said on a Monday means
      // today far more often than a week hence; the old silent +7 invented a
      // date that contradicted "before the fifteenth" in the same sentence.
      // Keep a calendar date only when the wording carries a same-day cue; a
      // bare weekday stays as wording for the reviewer to resolve.
      const sameDayCue = /\b(?:this|morning|afternoon|evening|lunchtime|first thing|later|tonight|straight after)\b/.test(value);
      if (!sameDayCue) return '';
    }
    return isoDateOffset(meetingDate, offset);
  }
  if (/\bend of (?:this )?week\b/.test(value)) {
    const current = new Date(`${meetingDate}T00:00:00Z`).getUTCDay();
    return isoDateOffset(meetingDate, (5 - current + 7) % 7);
  }
  if (/\bend of next week\b/.test(value)) {
    const current = new Date(`${meetingDate}T00:00:00Z`).getUTCDay();
    return isoDateOffset(meetingDate, ((5 - current + 7) % 7) + 7);
  }
  return '';
}

const ORDINAL_DAY_WORDS = Object.freeze({
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20, 'twenty-first': 21, 'twenty-second': 22, 'twenty-third': 23,
  'twenty-fourth': 24, 'twenty-fifth': 25, 'twenty-sixth': 26, 'twenty-seventh': 27, 'twenty-eighth': 28,
  'twenty-ninth': 29, thirtieth: 30, 'thirty-first': 31
});
const MONTH_WORDS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const STATED_DAY_BOUND_PATTERN = new RegExp(
  '\\b(before|by|ahead of|no later than|prior to)\\s+(?:the\\s+)?'
  + '(\\d{1,2}(?=(?:st|nd|rd|th)\\b)|' + Object.keys(ORDINAL_DAY_WORDS).join('|').replace(/-/g, '[- ]') + ')'
  + '(?:st|nd|rd|th)?\\b(?:\\s+(?:of\\s+)?(' + MONTH_WORDS.join('|') + '))?'
  // An ordinal followed by a noun is a thing, not a date: "before the first batch".
  + '(?!\\s+(?:attempt|batch|brew|call|day|draft|half|hour|item|meeting|month|one|part|pass|phase|point|question|quarter|round|session|stage|step|thing|time|version|week|year)\\b)',
  'i'
);

// "Monday morning, so it's here before the fifteenth" carries its own outer
// bound. Returns that bound as an ISO date, whether the bound day itself is
// allowed ("by", "no later than") or excluded ("before"), and the phrase.
function statedDayBound(value, meetingDate) {
  const source = text(value, 4000);
  if (!source || !/^\d{4}-\d{2}-\d{2}$/.test(String(meetingDate || ''))) return null;
  const match = source.match(STATED_DAY_BOUND_PATTERN);
  if (!match) return null;
  const dayToken = match[2].toLowerCase().replace(/\s+/g, '-');
  const day = Number(dayToken) || ORDINAL_DAY_WORDS[dayToken];
  if (!day || day > 31) return null;
  const [meetingYear, meetingMonth, meetingDay] = meetingDate.split('-').map(Number);
  let year = meetingYear;
  let month = match[3] ? MONTH_WORDS.indexOf(match[3].toLowerCase()) + 1 : meetingMonth;
  // A bound day earlier than the meeting day with no month named means next month.
  if (!match[3] && day < meetingDay) month += 1;
  if (match[3] && month < meetingMonth) year += 1;
  if (month > 12) { month = 1; year += 1; }
  const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const inclusive = /^(?:by|no later than)$/i.test(match[1]);
  return { date, inclusive, phrase: match[0].trim() };
}

// A day and month written in the timing itself ("by 17th June"). Without a
// year, a date more than six months before the meeting is taken to mean next
// year ("by 10 January" in a December meeting).
const SHORT_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function statedCalendarDate(wording = '', meetingDate = '') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(meetingDate || ''))) return '';
  const value = String(wording || '').toLowerCase();
  const month = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const dayFirst = value.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${month}\\b(?:,?\\s+(\\d{4}))?`));
  const monthFirst = value.match(new RegExp(`\\b${month}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`));
  const found = dayFirst ? { day: dayFirst[1], month: dayFirst[2], year: dayFirst[3] } : monthFirst ? { day: monthFirst[2], month: monthFirst[1], year: monthFirst[3] } : null;
  if (!found) return '';
  const monthIndex = SHORT_MONTHS.indexOf(found.month.slice(0, 3)) + 1;
  const day = Number(found.day);
  if (!monthIndex || !day || day > 31) return '';
  const [meetingYear] = meetingDate.split('-').map(Number);
  let year = found.year ? Number(found.year) : meetingYear;
  const iso = (y) => `${y}-${String(monthIndex).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (!found.year && iso(year) < meetingDate) {
    const daysBefore = (Date.parse(`${meetingDate}T00:00:00Z`) - Date.parse(`${iso(year)}T00:00:00Z`)) / 86400000;
    if (daysBefore > 183) year += 1;
  }
  return iso(year);
}

function timingBoundBreach(timing = {}, source = '', meetingDate = '') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(timing.exactDate || ''))) return null;
  const bound = statedDayBound(source, meetingDate);
  if (!bound) return null;
  const breached = bound.inclusive ? timing.exactDate > bound.date : timing.exactDate >= bound.date;
  return breached ? bound : null;
}

function timingFrom(item = {}, options = {}) {
  const supplied = item.timing && typeof item.timing === 'object' ? item.timing : {};
  let wording = text(supplied.wording || item.deadline || item.target, 220);
  let kind = ['deadline', 'target', 'dependency', 'not_stated'].includes(supplied.kind) ? supplied.kind : 'not_stated';
  if (kind === 'not_stated' && wording) {
    kind = /\b(?:once|after|when|following|subject to|dependent on|depends on)\b/i.test(wording)
      ? 'dependency'
      : (/\b(?:target|aim|ideally|provisional|expected|this week|next week)\b/i.test(wording) ? 'target' : 'deadline');
  }
  wording = wording.replace(/^(?:target|deadline)\s*:\s*/i, '');
  const exactDate = /^\d{4}-\d{2}-\d{2}$/.test(text(supplied.exactDate, 20))
    ? text(supplied.exactDate, 20)
    : relativeExactDate(wording, options.meetingDate);
  return { kind: wording || exactDate ? kind : 'not_stated', wording, exactDate };
}

function isIdeaOnlyContemplation(value) {
  const action = text(value, 2000).toLowerCase();
  const exploratory = /\b(?:think|thinking|consider|considering)\s+(?:about|through|of)\b/.test(action)
    || /\b(?:come back|return|bring)\b[^.]{0,90}\b(?:idea|ideas|thought|thoughts)\b/.test(action);
  if (!exploratory) return false;
  if (!/\b(?:idea|ideas|thought|thoughts|possibilit(?:y|ies)|options?)\b/.test(action)) return false;
  return !/\b(?:analysis|assessment|decision|document|draft|plan|recommendation|report|specification|test results?|written proposal)\b/.test(action);
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
const ACTION_ADMIN_PATTERN = /\b(?:write up (?:the )?meeting|produce (?:the )?minutes|send (?:the )?minutes|circulate (?:the )?minutes|attend (?:the )?(?:call|meeting)|join (?:the )?(?:call|meeting)|meeting invite|(?:for|in|into|update|take|record|write)\s+(?:the\s+|these\s+|this\s+|that\s+)?(?:new\s+)?set\s+of\s+minutes|(?:for|in|into)\s+(?:the|these|this)\s+minutes)\b/i;
const ACTION_PASSIVE_OBLIGATION_PATTERN = /\b(?:(?:is|are|was|were|will be)\s+)?(?:required|needed|expected|planned|scheduled|assigned)\s+to\b|\b(?:needs?|requires?)\s+(?:approval|assessment|completion|confirmation|documentation|follow[- ]?up|investigation|review|testing|updat(?:e|ing)|validation)\b/i;
const ACTION_FOLLOW_UP_PATTERN = /\b(?:action point|next step|take[- ]?away|follow[- ]?up|circle back|come back (?:to|with)|pick (?:this|that|it) up|look into|find out|make sure|ensure|sort (?:this|that|it) out|leave (?:this|that|it) with)\b/i;
const ACTION_IMPERATIVE_PATTERN = /^\s*(?:[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]{2,}\s*,\s*)?(?:(?:and|then|also)\s+)?(?:(?:when|once|after|before)\b.{0,100}?,\s*)?(?:please\s+)?(?:send|share|provide|forward|review|check|assess|create|produce|prepare|draft|update|revise|complete|finish|confirm|clarify|determine|test|verify|contact|call|message|schedule|arrange|document)\b/i;
const ACTION_CONCRETE_OFFER_PATTERN = /\b(?:I|we)\s+(?:can|could|would be able to|am available to|are available to)\s+(?:have a look at|attend|check|collect|contact|deliver|go|handle|prepare|provide|review|send|speak|test|visit)\b/i;
const ACTION_DECISION_RESOLUTION_PATTERN = /\b(?:try(?:ing)? to work out|(?:have|has|got|need(?:s)?) to (?:work (?:out|through)|decide|determine|resolve|plan through)|need(?:s)? to (?:confirm|clarify)|figure out)\b/i;
const DISCUSSION_DECISION_PATTERN = /\b(?:agreed|decided|confirmed|approved|accepted|selected|settled|concluded|signed off|will proceed|going ahead|the decision)\b/i;
const DISCUSSION_QUESTION_PATTERN = /\?|\b(?:open question|outstanding|to be confirmed|to be decided|not (?:yet )?(?:decided|confirmed|clear|resolved)|need to (?:confirm|clarify|determine|decide)|whether|which option|who will)\b/i;
const LOW_INFORMATION_UTTERANCE = /^(?:yes|yeah|yep|no|nope|okay|ok|right|fine|great|thanks|thank you|sure|agreed|exactly|correct|perfect|lovely|brilliant|understood|makes sense|i see|mm+|uh+|hello|hi|bye)[.!? ]*$/i;

function isDecisionResolutionCommitment(value) {
  const source = text(value, 2000);
  if (!ACTION_DECISION_RESOLUTION_PATTERN.test(source)) return false;
  // Questions about whether clarification is needed are not themselves an
  // accepted task. The surrounding acceptance machinery can still promote a
  // request when a later turn genuinely accepts it.
  return !/\?\s*$/.test(source) && !/^\s*(?:who|what|when|where|why|how|do|does|did|is|are|can|could|would|will|anything)\b/i.test(source);
}

function actionEvidenceDisposition(action, evidence) {
  const source = text(evidence, 15000);
  // A leaving remark grounds no work. Guard on the action too so a genuine
  // "shoot the report over" survives.
  if (LEAVING_REMARK_PATTERN.test(source) && !DELIVERABLE_CONTEXT_PATTERN.test(action)
    && !/\b(?:send|email|order|book|confirm|ring|call|contact|arrange|prepare|review|update|write|share|forward|submit)\b/i.test(action)) return 'meeting_admin';
  if (!source) return 'unclear';
  const actionTokens = contentTokens(action).slice(0, 12);
  const predicateGroups = ACTION_VERB_GROUPS.filter((group) => actionTokens.some((token) => group.includes(token)));
  const predicateWords = [...new Set(predicateGroups.flat())];
  const directlyNegatedPredicate = predicateWords.some((verb) => new RegExp(
    `\\b(?:will not|won't|shall not|not going to)\\b(?:\\s+[A-Za-zÀ-ÖØ-öø-ÿ'’.-]+){0,6}\\s+${verb}(?:s|ed|ing)?\\b`, 'i'
  ).test(source));
  // Negation belongs to its clause. An availability constraint such as “I
  // won't be around” can be the reason another person must plan or reschedule;
  // it must not reject every action in the surrounding evidence window.
  if (/\b(?:no action|do not need to|does not need to)\b/i.test(source) || directlyNegatedPredicate) return 'rejected';
  const accepted = ACTION_ACCEPTANCE_PATTERN.test(source);
  const requested = ACTION_REQUEST_PATTERN.test(source);
  const hasCommitment = ACTION_COMMITMENT_PATTERN.test(source) || ACTION_CONCRETE_INTENTION_PATTERN.test(source) || NAMED_WILL_PATTERN.test(source)
    || ACTION_JOINT_INTENTION_PATTERN.test(source) || ACTION_SCHEDULED_DELIVERABLE_PATTERN.test(source)
    || isDecisionResolutionCommitment(source) || accepted;
  if (ACTION_ADMIN_PATTERN.test(action) && !/\b(?:client deliverable|contract|required|formal record)\b/i.test(source)) return 'meeting_admin';
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
    const acceptedRequestAhead = ACTION_REQUEST_PATTERN.test(unit.text) && ACTION_ACCEPTANCE_PATTERN.test(following);
    const acceptedOfferAhead = ACTION_CONCRETE_OFFER_PATTERN.test(unit.text)
      && (ACTION_REQUEST_PATTERN.test(following) || ACTION_IMPERATIVE_PATTERN.test(following));
    const explicitAcceptedCommitment = ACTION_ACCEPTANCE_PATTERN.test(unit.text)
      && (ACTION_COMMITMENT_PATTERN.test(unit.text) || ACTION_CONCRETE_INTENTION_PATTERN.test(unit.text));
    if (!directCue && !contextualAcceptance && !acceptedOfferAhead) continue;
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
    candidates.push({
      candidateId: stableId('candidate', unit.id),
      focusEvidenceId: unit.id,
      evidenceIds: ids,
      dispositionHint: acceptedOfferAhead ? 'accepted_request' : actionEvidenceDisposition(unit.text, context),
      cueKinds,
      priority: (contextualAcceptance || acceptedRequestAhead || acceptedOfferAhead ? 4 : 0)
        + (cueKinds.includes('commitment') ? 3 : 0)
        + (cueKinds.includes('decision_resolution') ? 3 : 0)
        + (cueKinds.includes('obligation') || cueKinds.includes('follow_up') ? 2 : 0)
        + 1,
      sequence: unit.sequence,
      focusText: text(unit.text, 500),
      context: text(context, 900)
    });
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
      salientIds.has(unit.id) ? 'important_detail' : '',
      actionIds.has(unit.id) ? 'action_context' : '',
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
        + (kindHints.includes('important_detail') ? 3 : 0)
        + (kindHints.includes('action_context') ? 2 : 0)
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
  return (Array.isArray(records) ? records : []).some((record) => {
    const recordIds = Array.isArray(record?.evidenceIds) ? record.evidenceIds : [];
    const recordText = record?.action || record?.text || '';
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
function backfillCitedTiming(timing, units = [], evidenceIds = [], options = {}) {
  if (timing.kind !== 'not_stated') return timing;
  for (const unit of evidenceWindowUnits(units, evidenceIds, 0)) {
    const source = String(unit.text || '');
    // "Monday, yep, I'll place it Monday morning": take the most specific
    // phrase in the unit, not the first.
    const phrases = [...source.matchAll(new RegExp(CITED_TIMING_PHRASE.source, 'gi'))].map((match) => match[0]);
    const phrase = phrases.sort((left, right) =>
      Number(/\b(?:morning|afternoon|evening|this|next|end of)\b/i.test(right)) - Number(/\b(?:morning|afternoon|evening|this|next|end of)\b/i.test(left))
      || right.length - left.length)[0];
    if (!phrase) continue;
    const committed = ACTION_COMMITMENT_PATTERN.test(source) || ACTION_CONCRETE_INTENTION_PATTERN.test(source)
      || NAMED_WILL_PATTERN.test(source) || CITED_TIMING_COMMITMENT_CUE.test(source);
    if (!committed) continue;
    return timingFrom({ timing: { wording: phrase.toLowerCase().replace(/\s+/g, ' ') } }, options);
  }
  return timing;
}

// Lexical evidence resolution favours the turn that names the deliverable
// ("Six sacks of Maris Otter, thirty-two pounds a sack") over the turn where
// the owner takes the job on ("leave that with me, I'll order six sacks
// today"). The reviewer needs the second one: it carries the ownership, the
// timing and the commitment itself. When such a turn sits within a few turns
// of the cited passage, add it to the citation. Additive only.
const COMMITMENT_ANCHOR_RADIUS = 8;
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
  const nearby = evidenceWindowUnits(units, evidenceIds, COMMITMENT_ANCHOR_RADIUS)
    .filter((unit) => !cited.has(unit.id) && speakerIsOwner(unit.speaker, owners));
  let best = null;
  for (const unit of nearby) {
    const unitTokens = new Set(contentTokens(unit.text));
    const shared = actionTokens.filter((token) => unitTokens.has(token)).length;
    if (shared < 2) continue;
    const disposition = actionEvidenceDisposition(action, `${unit.speaker}: ${unit.text}`);
    if (!['committed', 'accepted_request', 'conditional_commitment'].includes(disposition)) continue;
    if (!best || shared > best.shared) best = { id: unit.id, shared };
  }
  if (!best) return evidenceIds;
  return [...evidenceIds, best.id].slice(0, 8);
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
function citedRevisionUnit(units = [], evidenceIds = []) {
  const context = evidenceContextFor(units);
  const cited = [...new Set(evidenceIds)].map((id) => context.indexById.get(id)).filter(Number.isInteger).sort((a, b) => a - b);
  const rows = context.rows;
  const presumption = cited.find((index) => PRESUMPTION_CUE.test(String(rows[index]?.text || '')));
  if (presumption === undefined) return null;
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
    return { ...action, timing, reviewFlagIds: [...new Set([...(action.reviewFlagIds || []), flag.id])] };
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

function quotedVerbatim(quote, passage) {
  const needle = quoteText(quote);
  return needle.length >= 3 && needle.split(' ').length <= 30 && quoteText(passage).includes(needle);
}

// One item per timed action: the action, its timing and the passage it cites.
function timingCheckItems(actions = [], units = []) {
  return (Array.isArray(actions) ? actions : []).map((action, index) => {
    if (!action?.timing || action.timing.kind === 'not_stated' || !text(action.timing.wording, 220)) return null;
    if (TIMING_NO_VALUE.test(text(action.timing.wording, 220))) return null;
    const passage = evidenceWindowUnits(units, action.evidenceIds || [], 2).map((unit) => `[${unit.id}] ${unit.speaker}: ${unit.text}`);
    if (!passage.length) return null;
    return { id: `a${index + 1}`, index, action: text(action.action, 600), owners: action.owners || [], timing: text(action.timing.wording, 220), passage: passage.join('\n') };
  }).filter(Boolean);
}

function timingCheckPrompt(items = [], meetingDate = '') {
  return [
    'ACTION_CRITIC_TIMING',
    "You check whether each action's timing belongs to that action. Each item gives an action, the timing attached to it, and the transcript passage it was drawn from. The passage is the only authority.",
    `The meeting took place on ${meetingDate || 'an unstated date'}. Do not calculate dates.`,
    'For each item decide one verdict:',
    `- "correct": the timing was said about this action's own work. When an action names several steps or deliverables, the timing is correct if it was said about ANY of them. Judge only the steps the action names.`,
    `- "belongs_to_other_step": the timing was said about a different piece of work: another step in a sequence, another person's task, a related meeting, an approval, a regulatory deadline or a schedule of other events.`,
    '- "past_event": the timing refers to something that has already happened.',
    '- "misread": the timing states a day or date the passage does not support as said (for example a wrong month, or an arrival time used as a meeting time).',
    `For every verdict give timingQuote: the exact words in the passage where the timing was said. For "belongs_to_other_step" also give stepQuote: the exact words naming the other piece of work the timing applies to (that work must not be one of the steps the action names). For any verdict other than "correct" give correctTiming: the exact words in the passage that give THIS action's own timing, or an empty string if the passage gives none.`,
    'Every quote must be copied verbatim from the passage as one contiguous span of at most 25 words. Never paraphrase a quote. If you are unsure, choose "correct".',
    'Return only this JSON object: {"schemaVersion":1,"results":[{"id":"","verdict":"","timingQuote":"","stepQuote":"","correctTiming":"","reason":""}]}',
    `ITEMS:\n${JSON.stringify(items.map((item) => ({ id: item.id, action: item.action, owners: item.owners, timing: item.timing, passage: item.passage })))}`
  ].join('\n\n');
}

// Apply verified verdicts. Anything unverifiable leaves the timing as it is.
function applyTimingCheckResults(actions = [], items = [], results = [], options = {}) {
  const flags = [];
  const byIndex = new Map(items.map((item) => [item.index, item]));
  const verdicts = new Map((Array.isArray(results) ? results : []).map((row) => [text(row?.id, 20), row || {}]));
  const checked = (Array.isArray(actions) ? actions : []).map((action, index) => {
    const wording = text(action?.timing?.wording, 220);
    if (action?.timing && action.timing.kind !== 'not_stated' && TIMING_NO_VALUE.test(wording)) {
      return { ...action, timing: { kind: 'not_stated', wording: '', exactDate: '' } };
    }
    const item = byIndex.get(index);
    const row = item ? verdicts.get(item.id) : null;
    if (!row || !['belongs_to_other_step', 'past_event', 'misread'].includes(row.verdict)) return action;
    if (!quotedVerbatim(row.timingQuote, item.passage)) return action;
    // "Misread" means the passage does not say it. If the timing's own words
    // are right there, the verdict contradicts the transcript.
    if (row.verdict === 'misread' && quotedVerbatim(wording, item.passage)) return action;
    if (row.verdict === 'belongs_to_other_step') {
      if (!quotedVerbatim(row.stepQuote, item.passage)) return action;
      const actionWords = timingCheckWords(action.action);
      const shared = [...timingCheckWords(row.stepQuote)].filter((word) => actionWords.has(word)).length;
      // The "other step" must not be a step the action itself names.
      if (shared >= 2) return action;
    }
    const replacement = text(row.correctTiming, 120);
    const usable = replacement && quotedVerbatim(replacement, item.passage) && quoteText(replacement) !== quoteText(wording);
    const timing = usable ? timingFrom({ timing: { wording: replacement } }, options) : { kind: 'not_stated', wording: '', exactDate: '' };
    const said = row.verdict === 'belongs_to_other_step'
      ? `in the transcript it was said about "${text(row.stepQuote, 160)}"`
      : row.verdict === 'past_event'
        ? `it refers to something that has already happened ("${text(row.timingQuote, 160)}")`
        : `the transcript does not say this ("${text(row.timingQuote, 160)}")`;
    const flag = normaliseFlag({
      kind: 'timing',
      message: usable
        ? `Timing changed from "${wording}" to "${replacement}": ${said}. Confirm the timing.`
        : `Timing "${wording}" removed: ${said}. Confirm whether this action has its own timing.`,
      evidenceIds: action.evidenceIds
    }, flags.length);
    flags.push(flag);
    return { ...action, timing, reviewFlagIds: [...new Set([...(action.reviewFlagIds || []), flag.id])] };
  });
  return { actions: checked, flags };
}

// ---- Commitment check -----------------------------------------------------
// Model-extracted actions that the keyword reading vetoed get one second look.
// An action comes back only when the model quotes the words where someone
// commits to it, is assigned it or agrees to it, and the quote is in the
// passage. Owners the model cannot tie to those words are removed.
function commitmentCheckEnabled() {
  return /^(?:1|true|yes|on)$/i.test(String(process.env.MEETING_MINUTES_AGENT_COMMITMENT_CHECK_V1 || '0'));
}

function commitmentCheckItems(actions = [], units = []) {
  return (Array.isArray(actions) ? actions : []).slice(0, 24).map((action, index) => {
    const passage = evidenceWindowUnits(units, action?.evidenceIds || [], 2).slice(0, 24).map((unit) => `${unit.speaker}: ${unit.text}`);
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
    '- "not_commitment": a suggestion or idea nobody took on, a status update, work already done, a description of how something works, a question, meeting housekeeping such as taking these minutes, or something an outside organisation will do.',
    'For "commitment" give commitmentQuote: the exact words where the person commits, is assigned or agrees, copied verbatim as one contiguous span of at most 25 words (it may run across adjacent lines; leave out speaker names). Also give ownerSupported: true if the passage ties the listed owners to the work, false otherwise.',
    'Never paraphrase a quote. If you are unsure, choose "not_commitment".',
    'Return only this JSON object: {"schemaVersion":1,"results":[{"id":"","verdict":"","commitmentQuote":"","ownerSupported":true,"reason":""}]}',
    `ITEMS:\n${JSON.stringify(items.map((item) => ({ id: item.id, action: item.action, owners: item.owners, passage: item.passage })))}`
  ].join('\n\n');
}

function applyCommitmentCheckResults(actions = [], items = [], results = []) {
  const verdicts = new Map((Array.isArray(results) ? results : []).map((row) => [text(row?.id, 20), row || {}]));
  const rescued = [];
  for (const item of items) {
    const row = verdicts.get(item.id);
    if (!row || row.verdict !== 'commitment' || !decisionQuoteFound(row.commitmentQuote, item.passage)) continue;
    const action = actions[item.index];
    rescued.push({ ...action, owners: row.ownerSupported === false ? [] : (action.owners || []), reviewFlagIds: [] });
  }
  return rescued;
}

// ---- Answered check -------------------------------------------------------
// "Clarify the formative dates" published as outstanding work, when the date
// was clarified and accepted two lines later. Only clarify/confirm/decide-type
// actions are checked. An action is taken off the published list only when the
// model quotes both the answer and its acceptance and both are in the passage;
// the caller offers it back as a proposal, so nothing is lost.
const ANSWERABLE_ACTION = /^(?:clarify|confirm|determine|decide|finali[sz]e|check|verify|establish|find out|agree)\b/i;
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
    if (!decisionQuoteFound(row.answerQuote, item.passage, 45) || !decisionQuoteFound(row.acceptanceQuote, item.passage, 45)) continue;
    answered.set(item.index, { answerQuote: text(row.answerQuote, 300), acceptanceQuote: text(row.acceptanceQuote, 200) });
  }
  const list = Array.isArray(actions) ? actions : [];
  return {
    actions: list.filter((_, index) => !answered.has(index)),
    answered: list.map((action, index) => (answered.has(index) ? { action, ...answered.get(index) } : null)).filter(Boolean)
  };
}

// ---- Chained first-step timing --------------------------------------------
// "Conduct a call today ..., load the documents for Grace ..., then download
// them and point the auditor": "today" is the call's, not the chain's. When
// the timing's words sit in the first step of a chained action, the words stay
// in the action text and the deadline column is cleared, with a flag.
const CHAIN_STEP_MARKER = /,?\s*\b(?:and then|then|after that|afterwards|once (?:that|this|it|they|approved|done|complete)|followed by)\b/i;
function applyChainedTimingRule(actions = []) {
  const flags = [];
  const checked = (Array.isArray(actions) ? actions : []).map((action) => {
    const wording = text(action?.timing?.wording, 220).toLowerCase();
    if (!action?.timing || action.timing.kind === 'not_stated' || !wording) return action;
    const statement = text(action.action, 1600);
    const marker = statement.match(CHAIN_STEP_MARKER);
    if (!marker || marker.index < 8) return action;
    const firstStep = statement.slice(0, marker.index).toLowerCase();
    if (!firstStep.includes(wording)) return action;
    const flag = normaliseFlag({
      kind: 'timing',
      message: `"${text(action.timing.wording, 120)}" applies to the first step only ("${text(statement.slice(0, marker.index), 160)}"), so it is not shown as the deadline for the whole action. Add a deadline if the later steps have one.`,
      evidenceIds: action.evidenceIds || []
    }, flags.length);
    flags.push(flag);
    return { ...action, timing: { kind: 'not_stated', wording: '', exactDate: '' }, reviewFlagIds: [...new Set([...(action.reviewFlagIds || []), flag.id])] };
  });
  return { actions: checked, flags };
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
    'These are NOT decisions: status or progress updates, lists of next steps in an update, work already done, descriptions of how a process, tool or regulation works, facts, explanations, opinions, goals described as probable, an idea people liked without settling what will happen, a suggestion or proposal nobody accepted, a question, a routine task someone will do, and anything decided, scheduled or to be approved outside this meeting that is only being reported.',
    `The decisionQuote must be the words that make or accept the choice (for example "let's", "we'll", "I've decided", "agreed", "go ahead"), not words that merely mention the topic.`,
    'For each item give verdict "decision" or "not_decision". For "decision" give decisionQuote: the exact words in the passage where the choice is made or agreed, copied verbatim as one contiguous span of at most 25 words. Never paraphrase a quote. If you are unsure, choose "not_decision".',
    'Return only this JSON object: {"schemaVersion":1,"results":[{"id":"","verdict":"","decisionQuote":"","reason":""}]}',
    `ITEMS:\n${JSON.stringify(items.map((item) => ({ id: item.id, row: item.row, passage: item.passage })))}`
  ].join('\n\n');
}

// A quote may run across adjacent lines; speaker labels are not spoken words.
function decisionQuoteFound(quote, passage, maxWords = 30) {
  const flat = (value) => quoteText(value).replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const needle = flat(String(quote || '').replace(/^[^:]{2,40}:\s*/, ''));
  const words = needle ? needle.split(' ').length : 0;
  if (words < 3 || words > maxWords) return false;
  const spoken = String(passage || '').split('\n').map((line) => line.replace(/^[^:]{2,40}:\s*/, '')).join(' ');
  return flat(spoken).includes(needle);
}

// Items with no verdict (a failed call) keep their label.
function applyDecisionCheckResults(discussion = [], items = [], results = []) {
  const verdicts = new Map((Array.isArray(results) ? results : []).map((row) => [text(row?.id, 20), row || {}]));
  const demote = new Map();
  for (const item of items) {
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
    const moved = topic.decisions.filter((_, rowIndex) => rows.has(rowIndex));
    demoted += moved.length;
    return {
      ...topic,
      decisions: topic.decisions.filter((_, rowIndex) => !rows.has(rowIndex)),
      points: [...(Array.isArray(topic.points) ? topic.points : []), ...moved]
    };
  });
  return { discussion: checked, demoted, checked: items.length };
}

const COMMITMENT_RECHECK_DISPOSITIONS = new Set(['suggestion', 'status_only', 'meeting_admin', 'unaccepted_request']);

function normaliseActions(candidate = {}, units = [], options = {}) {
  const rows = (Array.isArray(candidate.actions) ? candidate.actions : []).slice(0, 250).map((item, index) => {
    const action = text(item?.action, 1600);
    if (!action || isIdeaOnlyContemplation(action)) return null;
    const suppliedIds = (Array.isArray(item?.evidenceIds) ? item.evidenceIds : []).map((id) => text(id, 30)).filter(Boolean);
    const resolved = resolveEvidence(action, units, item?.evidenceIds, { action: true });
    const checks = correctnessChecksEnabled();
    if (checks && options.enforceEvidence === false && !suppliedIds.some((id) => evidenceContextFor(units).known.has(id))
      && resolved.evidenceIds.length && !uncitedClaimSupported(action, resolved, units)) {
      resolved.evidenceIds = [];
    }
    const owners = splitOwners(item?.owners || item?.owner).map((owner) => normaliseOwnerIdentity(owner, units));
    const evidenceIds = anchorOwnerCommitment(action, owners, units, resolved.evidenceIds);
    const evidenceText = evidenceWindowText(units, evidenceIds, 1);
    const disposition = actionEvidenceDisposition(action, evidenceText);
    if (options.enforceEvidence !== false && !evidenceIds.length) return null;
    if (options.enforceEvidence !== false && ['completed', 'suggestion', 'status_only', 'meeting_admin', 'unaccepted_request', 'rejected'].includes(disposition)) {
      // The keyword reading can be wrong ("Janine and Adil, you're involved in
      // that next week" reads as no commitment). A caller may collect these
      // for a quote-verified second look; they are never published from here.
      if (Array.isArray(options.vetoed) && COMMITMENT_RECHECK_DISPOSITIONS.has(disposition) && !ACTION_ADMIN_PATTERN.test(action)) {
        options.vetoed.push({ id: text(item?.id, 80) || stableId('action', action, index), action, owners, timing: timingFrom(item, options), evidenceIds, reviewFlagIds: [], disposition });
      }
      return null;
    }
    // Recovery fills gaps in fresh agent output only. A save (enforceEvidence
    // false) carries timings a reviewer or a timing check has already settled,
    // so an empty timing there is deliberate and must stay empty.
    const timing = options.enforceEvidence === false
      ? timingFrom(item, options)
      : backfillCitedTiming(timingFrom(item, options), units, evidenceIds, options);
    // Agent output is corrected once, on the published actions, so every
    // change reaches the reviewer with its flag (see applyTimingClauseChecks).
    // Here only a reviewer's own entry is checked, and only flagged.
    const timingClauseNote = timingClauseChecksEnabled() && options.enforceEvidence === false
      ? timingClauseIssue(action, timing, units, evidenceIds) : null;
    return {
      id: text(item?.id, 80) || stableId('action', action, index),
      action,
      owners,
      timing,
      _timingClauseNote: timingClauseNote,
      evidenceIds,
      reviewFlagIds: [...new Set((Array.isArray(item?.reviewFlagIds) ? item.reviewFlagIds : []).map((id) => text(id, 80)).filter(Boolean))],
      _unsupportedEvidenceIds: resolved.invalidIds,
      _weakEvidenceIds: resolved.weakIds,
      _evidenceDisposition: disposition,
      _timingConflicts: []
    };
  }).filter(Boolean);
  const merged = [];
  for (const row of rows) {
    const duplicate = merged.find((existing) => actionSimilarity(existing, row) >= 0.78 && ownersCompatible(existing, row));
    if (!duplicate) {
      merged.push(row);
      continue;
    }
    duplicate.evidenceIds = [...new Set([...duplicate.evidenceIds, ...row.evidenceIds])].slice(0, 8);
    duplicate._unsupportedEvidenceIds = [...new Set([
      ...(duplicate._unsupportedEvidenceIds || []),
      ...(row._unsupportedEvidenceIds || [])
    ])];
    duplicate._weakEvidenceIds = [...new Set([...(duplicate._weakEvidenceIds || []), ...(row._weakEvidenceIds || [])])];
    duplicate.owners = [...new Set([...duplicate.owners, ...row.owners])].slice(0, 12);
    if (duplicate.timing.kind === 'not_stated' && row.timing.kind !== 'not_stated') duplicate.timing = row.timing;
    else if (duplicate.timing.kind !== 'not_stated' && row.timing.kind !== 'not_stated'
      && JSON.stringify(duplicate.timing) !== JSON.stringify(row.timing)) duplicate._timingConflicts.push(row.timing);
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

function normaliseAgentResult(candidate = {}, units = [], stage = '', options = {}) {
  // enforceEvidence strips owners and timings the cited passages do not support.
  // That is right for agent output. It is wrong for a reviewer's own edits: the
  // reviewer is the human check on the agent, so their entry is flagged for
  // confirmation but never silently reverted.
  const enforceEvidence = options.enforceEvidence !== false;
  const discussion = normaliseDiscussion(candidate, units);
  const actions = normaliseActions(candidate, units, options);
  const objectives = normalisePointList(candidate.objectives, units, 'objective');
  const executiveSummary = normaliseExecutiveSummary(candidate.executiveSummary);
  // Objectives carry evidence links like any other record, but they are a
  // synthesis rather than a citable claim, so they are deliberately left out of
  // the missing-evidence sweep below - every save would otherwise re-flag them.
  for (const objective of objectives) delete objective._unsupportedEvidenceIds;
  const flags = (Array.isArray(candidate.reviewFlags) ? candidate.reviewFlags : []).filter((flag) => !isAutomaticTerminologyFlag(flag)).map(normaliseFlag);
  const records = [
    ...discussion.flatMap((topic) => [...topic.points, ...topic.decisions, ...topic.openQuestions]),
    ...actions
  ];
  const unitById = new Map(evidenceContextFor(units).rows.map((unit) => [unit.id, unit]));
  for (const action of actions) {
    const evidenceText = evidenceWindowText(units, action.evidenceIds, 1);
    const unsupportedOwners = action.owners.filter((owner) => !ownerSupportedByEvidence(owner, evidenceText, units));
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
    if (action.timing.kind !== 'not_stated') {
      const wordingSupported = action.timing.wording && (
        evidenceText.toLowerCase().includes(action.timing.wording.toLowerCase()) ||
        tokenOverlap(action.timing.wording, evidenceText) >= 0.5
      );
      let exactDateSupported = false;
      // "by 17th June" in a meeting held on 22 June cannot be a future
      // deadline: the date was misheard or the month misread.
      const statedDate = correctnessChecksEnabled() ? statedCalendarDate(action.timing.wording, options.meetingDate) : '';
      if (statedDate && statedDate < options.meetingDate) {
        const pastWording = action.timing.wording;
        if (enforceEvidence) action.timing = { kind: 'not_stated', wording: '', exactDate: '' };
        const flag = normaliseFlag({
          kind: 'timing',
          message: `The date in "${pastWording}" is before the meeting (${options.meetingDate})${enforceEvidence ? ' and has been removed' : ''}; confirm the intended date.`,
          evidenceIds: action.evidenceIds
        }, flags.length);
        flags.push(flag);
        action.reviewFlagIds.push(flag.id);
      }
      if (action.timing.kind !== 'not_stated' && action.timing.exactDate && /^\d{4}-\d{2}-\d{2}$/.test(String(options.meetingDate || ''))
        && action.timing.exactDate < options.meetingDate) {
        const pastDate = action.timing.exactDate;
        if (enforceEvidence) action.timing.exactDate = '';
        const flag = normaliseFlag({
          kind: 'timing',
          message: `The exact date ${pastDate} is earlier than the meeting date and has been removed; confirm the intended timing.`,
          evidenceIds: action.evidenceIds
        }, flags.length);
        flags.push(flag);
        action.reviewFlagIds.push(flag.id);
      }
      // A derived date is only as good as the whole commitment. "Monday
      // morning" resolved a week out passed the support check while the same
      // sentence said "before the fifteenth"; that contradiction must surface
      // to the reviewer, not be published as a confident target.
      const breach = timingBoundBreach(action.timing, `${action.timing.wording} ${evidenceText}`, options.meetingDate);
      if (breach) {
        const breachedDate = action.timing.exactDate;
        if (enforceEvidence) action.timing.exactDate = '';
        const flag = normaliseFlag({
          kind: 'timing',
          message: `The exact date ${breachedDate} falls ${breach.inclusive ? 'after' : 'on or after'} the stated limit "${breach.phrase}" and has been removed; confirm the intended date.`,
          evidenceIds: action.evidenceIds
        }, flags.length);
        flags.push(flag);
        action.reviewFlagIds.push(flag.id);
      }
      if (action.timing.exactDate) {
        const [year, month, day] = action.timing.exactDate.split('-');
        const monthNames = ['', 'jan(?:uary)?', 'feb(?:ruary)?', 'mar(?:ch)?', 'apr(?:il)?', 'may', 'jun(?:e)?', 'jul(?:y)?', 'aug(?:ust)?', 'sep(?:tember)?', 'oct(?:ober)?', 'nov(?:ember)?', 'dec(?:ember)?'];
        exactDateSupported = new RegExp(`\\b0?${Number(day)}(?:st|nd|rd|th)?\\b[\\s\\S]{0,20}\\b${monthNames[Number(month)]}\\b[\\s\\S]{0,20}\\b${year}\\b`, 'i').test(evidenceText)
          || evidenceText.includes(action.timing.exactDate);
        const safelyDerivedDate = wordingSupported ? relativeExactDate(action.timing.wording, options.meetingDate) : '';
        exactDateSupported = exactDateSupported || safelyDerivedDate === action.timing.exactDate;
        if (!exactDateSupported) {
          const unsupportedExactDate = action.timing.exactDate;
          if (enforceEvidence) action.timing.exactDate = '';
          const flag = normaliseFlag({
            kind: 'timing',
            message: `The exact date ${unsupportedExactDate} was not supported by the cited wording and has been removed; confirm the retained timing wording if needed.`,
            evidenceIds: action.evidenceIds
          }, flags.length);
          flags.push(flag);
          action.reviewFlagIds.push(flag.id);
        }
      }
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
      const revision = laterRevisionUnit(units, record.evidenceIds) || citedRevisionUnit(units, record.evidenceIds);
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
        message: `This item pointed to transcript lines that do not exist (${record._unsupportedEvidenceIds.join(', ')}). Check it against the transcript.`,
        evidenceIds: record.evidenceIds
      }, flags.length + index);
      flags.push(flag);
      record.reviewFlagIds.push(flag.id);
    }
    const hadWeakEvidence = Boolean(record._weakEvidenceIds?.length);
    if (hadWeakEvidence) {
      const flag = normaliseFlag({
        kind: 'missing_evidence',
        message: `The linked transcript lines only partly support this item. Check the wording against the transcript.`,
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
    if (hadWeakEvidence && !record.evidenceIds.length) continue;
    if (record.evidenceIds.length) continue;
    const flag = normaliseFlag({ kind: 'missing_evidence', message: 'No transcript passage clearly supports this item. Check it, or delete it if it was not said.' }, flags.length + index);
    flags.push(flag);
    record.reviewFlagIds.push(flag.id);
  }
  if (stage === 'discussion') flags.push(...unresolvedReferenceFlags(units));
  return { schemaVersion: SCHEMA_VERSION, discussion, actions, objectives, executiveSummary, reviewFlags: uniqueFlags(flags) };
}

function uniqueFlags(flags = []) {
  const seen = new Set();
  return flags.filter((flag) => {
    const key = `${flag.kind}|${flag.message}|${flag.evidenceIds.join(',')}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  const supported = text(value, 3000).split(/(?<=[.!?])\s+/).filter(Boolean)
    .filter((sentence) => evidenceSupportScore(sentence, source) >= 0.14)
    .join(' ');
  if (supported) return supported;
  const facts = (Array.isArray(discussion) ? discussion : []).flatMap((topic) => [
    ...(topic?.decisions || []), ...(topic?.points || [])
  ]).map((item) => text(item?.text || item, 500)).filter(Boolean).slice(0, 3);
  const next = (Array.isArray(actions) ? actions : []).map((item) => text(item?.action, 500)).filter(Boolean).slice(0, 2);
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

function applyProposal(before = [], proposal = {}, acceptedIds = []) {
  const accepted = new Set(acceptedIds);
  const rows = Array.isArray(before) ? before : [];
  const originalIndex = (change) => (Number.isInteger(change.beforeIndex) ? change.beforeIndex : Number(change.index) || 0);
  const modified = new Map();
  const removed = new Set();
  const inserted = new Map();
  for (const change of proposal.changes || []) {
    if (!accepted.has(change.id)) continue;
    const at = originalIndex(change);
    if (change.type === 'remove') removed.add(at);
    else if (change.type === 'add') inserted.set(at, [...(inserted.get(at) || []), change.after]);
    else modified.set(at, change.after);
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
  PAYLOAD_VERSION,
  migrateDraftPayload,
  text,
  sanitiseDetails,
  normaliseSourceUnits,
  preparedTranscriptFromUnits,
  salientDetailInventory,
  normaliseAgentResult,
  normaliseExecutiveSummary,
  normaliseFlag,
  coverageFlags,
  surroundingEvidence,
  buildProposal,
  applyProposal,
  isIdeaOnlyContemplation,
  normaliseKnownTerms,
  normaliseColloquialTimes,
  normaliseKnownTermsDeep,
  isAutomaticTerminologyFlag,
  isSalientCoverageFlag,
  isUsefulReviewFlag,
  evidenceWindowUnits,
  evidenceSupportScore,
  evidenceContextFor,
  resolveEvidence,
  normaliseActions,
  actionEvidenceDisposition,
  actionCandidateInventory,
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
  correctnessChecksEnabled,
  timingClauseIssue,
  applyTimingClauseChecks,
  timingCheckEnabled,
  statedCalendarDate,
  reconcileRecordFlags,
  applyChainedTimingRule,
  answeredCheckEnabled,
  answeredCheckItems,
  answeredCheckPrompt,
  applyAnsweredCheckResults,
  commitmentCheckEnabled,
  commitmentCheckItems,
  commitmentCheckPrompt,
  applyCommitmentCheckResults,
  decisionCheckEnabled,
  decisionCheckItems,
  decisionCheckPrompt,
  decisionQuoteFound,
  applyDecisionCheckResults,
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
