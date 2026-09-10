'use strict';

const crypto = require('crypto');

// The response contract asked of the agent. It is interpolated into the prompt
// ("Return schemaVersion N ..."), so changing it changes what Power Automate is
// told to return - do NOT bump it to describe a change in what we store on disk.
const SCHEMA_VERSION = 4;

// What is stored in the draft payload. Separate from SCHEMA_VERSION on purpose.
const PAYLOAD_VERSION = 4;

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
  if ((Number(payload.payloadVersion) || 0) >= 3) return { ...payload, payloadVersion: PAYLOAD_VERSION };
  const stored = Math.max(0, Math.min(3, Number(payload.currentStep) || 0));
  return { ...payload, payloadVersion: PAYLOAD_VERSION, currentStep: STEP_V2_TO_V3[stored] };
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
    if (MEETING_ADMIN_PATTERN.test(unit.text)) continue;
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
  return {
    id: text(flag.id, 80) || stableId('flag', `${kind}|${message}`, index),
    kind,
    message,
    evidenceIds: [...new Set((Array.isArray(flag.evidenceIds) ? flag.evidenceIds : []).map((id) => text(id, 30)).filter(Boolean))].slice(0, 8),
    status: ['open', 'confirmed', 'corrected', 'dismissed'].includes(flag.status) ? flag.status : 'open',
    correctionNote: text(flag.correctionNote, 500)
  };
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
  return {
    id: text(candidate.id, 80) || stableId(prefix, pointText, index),
    text: pointText,
    evidenceIds: resolved.evidenceIds,
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
    else duplicate.evidenceIds = [...new Set([...(duplicate.evidenceIds || []), ...(value.evidenceIds || [])])].slice(0, 8);
  }
  return kept;
}

function normaliseDiscussion(candidate = {}, units = []) {
  const topics = (Array.isArray(candidate.discussion) ? candidate.discussion : []).slice(0, 80).map((item, index) => {
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

function normaliseOwnerIdentity(owner, units = []) {
  const raw = text(owner, 180);
  const ownerWords = contentTokens(raw);
  if (!ownerWords.length) return raw;
  const speakers = evidenceContextFor(units).speakers;
  const exact = speakers.find((speaker) => {
    const words = contentTokens(speaker);
    return words.length === ownerWords.length && words.every((word) => ownerWords.includes(word));
  });
  if (exact) return raw;
  if (ownerWords.length !== 1) return raw;
  const matches = speakers.filter((speaker) => contentTokens(speaker).includes(ownerWords[0]));
  return matches.length === 1 ? matches[0] : raw;
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
    else if (offset === 0 && !/\bthis\s+/.test(value)) offset = 7;
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
  if (!/\b(?:think|thinking|consider|considering)\s+(?:about|through|of)\b/.test(action)) return false;
  if (!/\b(?:idea|ideas|thought|thoughts|possibilit(?:y|ies)|options?)\b/.test(action)) return false;
  return !/\b(?:analysis|assessment|decision|document|draft|plan|recommendation|report|specification|test results?|written proposal)\b/.test(action);
}

const ACTION_COMMITMENT_PATTERN = /\b(?:i|we)\s*(?:'ll|will|shall|can do|am going to|are going to)|\b(?:he|she|they)\s+(?:will|shall)|\b(?:agreed|committed|assigned|action(?:\s+for)?|need(?:s)? to|must|shall|is to|are to|due to)\b/i;
const ACTION_CONCRETE_INTENTION_PATTERN = /\b(?:(?:i|we)\s+(?:want|intend|plan|expect)\s+to|what\s+(?:i|we)\s+want\s+to\s+do\s+is(?:\s+to)?)\s+(?:arrange|assess|book|build|check|clarify|complete|confirm|contact|create|decide|define|determine|document|draft|email|establish|finalise|finalize|fix|forward|investigate|issue|message|prepare|provide|record|resolve|review|run|schedule|send|share|submit|take|test|track|update|validate|verify|write)\b/i;
const NAMED_WILL_PATTERN = /\b[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]{2,}\s+will\b/;
const ACTION_REQUEST_PATTERN = /\b(?:please|can you|could you|would you|will you)\b/i;
const ACTION_ACCEPTANCE_PATTERN = /\b(?:yes|yeah|yep|okay|ok|sure|happy to|will do|can do|i can|we can|that's fine|that works)\b/i;
const ACTION_SUGGESTION_PATTERN = /\b(?:perhaps|maybe|might|may|could|should|consider|considering|possible|potentially|it would be good|worth thinking)\b/i;
const ACTION_COMPLETED_PATTERN = /\b(?:already|previously|last (?:week|month)|has been|have been|was|were)\b[^.]{0,100}\b(?:completed|finished|sent|shared|issued|approved|closed|done|delivered|submitted)\b/i;
const ACTION_STATUS_PATTERN = /\b(?:currently|ongoing|in progress|remains|status is|has been|have been|was|were)\b/i;
const ACTION_ADMIN_PATTERN = /\b(?:write up (?:the )?meeting|produce (?:the )?minutes|send (?:the )?minutes|circulate (?:the )?minutes|attend (?:the )?(?:call|meeting)|join (?:the )?(?:call|meeting)|meeting invite)\b/i;
const ACTION_PASSIVE_OBLIGATION_PATTERN = /\b(?:(?:is|are|was|were|will be)\s+)?(?:required|needed|expected|planned|scheduled|assigned)\s+to\b|\b(?:needs?|requires?)\s+(?:approval|assessment|completion|confirmation|documentation|follow[- ]?up|investigation|review|testing|updat(?:e|ing)|validation)\b/i;
const ACTION_FOLLOW_UP_PATTERN = /\b(?:action point|next step|take[- ]?away|follow[- ]?up|circle back|come back (?:to|with)|pick (?:this|that|it) up|look into|find out|make sure|ensure|sort (?:this|that|it) out|leave (?:this|that|it) with)\b/i;
const ACTION_IMPERATIVE_PATTERN = /^\s*(?:please\s+)?(?:send|share|provide|forward|review|check|assess|create|produce|prepare|draft|update|revise|complete|finish|confirm|clarify|determine|test|verify|contact|call|message|schedule|arrange|document)\b/i;
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
      || NAMED_WILL_PATTERN.test(unit.text)
      || ACTION_REQUEST_PATTERN.test(unit.text)
      || ACTION_PASSIVE_OBLIGATION_PATTERN.test(unit.text)
      || ACTION_FOLLOW_UP_PATTERN.test(unit.text)
      || isDecisionResolutionCommitment(unit.text)
      || ACTION_IMPERATIVE_PATTERN.test(unit.text);
    const contextualAcceptance = ACTION_ACCEPTANCE_PATTERN.test(unit.text)
      && (ACTION_REQUEST_PATTERN.test(previous) || ACTION_COMMITMENT_PATTERN.test(previous) || NAMED_WILL_PATTERN.test(previous)
        || ACTION_PASSIVE_OBLIGATION_PATTERN.test(previous) || ACTION_FOLLOW_UP_PATTERN.test(previous));
    const acceptedRequestAhead = ACTION_REQUEST_PATTERN.test(unit.text) && ACTION_ACCEPTANCE_PATTERN.test(following);
    if (!directCue && !contextualAcceptance) continue;
    const windowStart = Math.max(0, index - 2);
    const windowEnd = Math.min(rows.length, index + 3);
    const ids = rows.slice(windowStart, windowEnd).map((item) => item.id);
    const context = rows.slice(windowStart, windowEnd)
      .map((item) => `${item.speaker}: ${item.text}`).join(' ');
    const cueKinds = [
      ACTION_COMMITMENT_PATTERN.test(unit.text) || ACTION_CONCRETE_INTENTION_PATTERN.test(unit.text) || NAMED_WILL_PATTERN.test(unit.text) ? 'commitment' : '',
      ACTION_REQUEST_PATTERN.test(unit.text) ? 'request' : '',
      contextualAcceptance || acceptedRequestAhead ? 'acceptance' : '',
      ACTION_PASSIVE_OBLIGATION_PATTERN.test(unit.text) ? 'obligation' : '',
      ACTION_FOLLOW_UP_PATTERN.test(unit.text) ? 'follow_up' : '',
      isDecisionResolutionCommitment(unit.text) ? 'decision_resolution' : '',
      ACTION_IMPERATIVE_PATTERN.test(unit.text) ? 'imperative' : ''
    ].filter(Boolean);
    candidates.push({
      candidateId: stableId('candidate', unit.id),
      focusEvidenceId: unit.id,
      evidenceIds: ids,
      dispositionHint: actionEvidenceDisposition(unit.text, context),
      cueKinds,
      priority: (contextualAcceptance || acceptedRequestAhead ? 4 : 0)
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
  const firstPersonCommitment = /\bI\s+(?:will|'ll|can|shall|am going to|need to|have to|aim to)\b/i;
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
    if (MEETING_ADMIN_PATTERN.test(unit.text) && !DELIVERABLE_CONTEXT_PATTERN.test(unit.text)) continue;
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
  const highPriority = uncovered.filter((candidate) => Number(candidate?.priority || 0) >= 5);
  return {
    needed: highPriority.length > 0 || (source.length > 0 && uncovered.length / source.length > 0.1),
    uncovered,
    highPriorityCount: highPriority.length
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

function normaliseActions(candidate = {}, units = [], options = {}) {
  const rows = (Array.isArray(candidate.actions) ? candidate.actions : []).slice(0, 250).map((item, index) => {
    const action = text(item?.action, 1600);
    if (!action || isIdeaOnlyContemplation(action)) return null;
    const suppliedIds = (Array.isArray(item?.evidenceIds) ? item.evidenceIds : []).map((id) => text(id, 30)).filter(Boolean);
    const resolved = resolveEvidence(action, units, item?.evidenceIds, { action: true });
    const evidenceText = evidenceWindowText(units, resolved.evidenceIds, 1);
    const disposition = actionEvidenceDisposition(action, evidenceText);
    if (options.enforceEvidence !== false && !resolved.evidenceIds.length) return null;
    if (options.enforceEvidence !== false && ['completed', 'suggestion', 'status_only', 'meeting_admin', 'unaccepted_request', 'rejected'].includes(disposition)) return null;
    return {
      id: text(item?.id, 80) || stableId('action', action, index),
      action,
      owners: splitOwners(item?.owners || item?.owner).map((owner) => normaliseOwnerIdentity(owner, units)),
      timing: timingFrom(item, options),
      evidenceIds: resolved.evidenceIds,
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
  for (const [index, record] of records.entries()) {
    if (record._unsupportedEvidenceIds?.length) {
      const flag = normaliseFlag({
        kind: 'missing_evidence',
        message: `The agent cited unsupported source ${record._unsupportedEvidenceIds.join(', ')}; verify this record against the linked transcript evidence.`,
        evidenceIds: record.evidenceIds
      }, flags.length + index);
      flags.push(flag);
      record.reviewFlagIds.push(flag.id);
    }
    const hadWeakEvidence = Boolean(record._weakEvidenceIds?.length);
    if (hadWeakEvidence) {
      const flag = normaliseFlag({
        kind: 'missing_evidence',
        message: `The cited source does not sufficiently support this generated item; verify or correct it.`,
        evidenceIds: record.evidenceIds
      }, flags.length + index);
      flags.push(flag);
      record.reviewFlagIds.push(flag.id);
    }
    delete record._unsupportedEvidenceIds;
    delete record._weakEvidenceIds;
    delete record._evidenceDisposition;
    delete record._timingConflicts;
    if (hadWeakEvidence && !record.evidenceIds.length) continue;
    if (record.evidenceIds.length) continue;
    const flag = normaliseFlag({ kind: 'missing_evidence', message: 'No sufficiently close source passage was found for this generated item.' }, flags.length + index);
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
    const resolved = resolveEvidence(objective, source, supplied);
    if (!resolved.evidenceIds.length || evidenceSupportScore(objective, evidenceWindowText(rows, resolved.evidenceIds, 1)) < 0.16) return null;
    return {
      id: text(value?.id, 80) || stableId('objective', objective, index),
      text: objective,
      evidenceIds: resolved.evidenceIds
    };
  }).filter(Boolean).slice(0, 6);
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
  discussionCandidateInventory,
  candidatePromptPack,
  uncoveredCandidateInventory,
  discussionRecoveryNeeded,
  actionRecoveryNeeded,
  groundedObjectives,
  groundedObjectiveRecords,
  groundedExecutiveSummary,
  relativeExactDate
};
