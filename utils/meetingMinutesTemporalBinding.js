'use strict';

// A model may identify a phase, but cannot make an arbitrary fragment an
// authority. All quotations below refer to the original, unmodified record.
const KEYS = new Set(['schemaVersion', 'claimText', 'sourceId', 'sourceQuote', 'workSourceQuote', 'workClaimQuote', 'qualificationQuotes']);
const normal = value => String(value || '').toLowerCase().replace(/[’]/g, "'").replace(/(?<=\p{L})[-–—](?=\p{L})/gu, ' ').replace(/[^\p{L}\p{N}:' +\-]+/gu, ' ').replace(/\s+/g, ' ').trim();
const words = value => normal(value).split(' ').filter(Boolean);
const articleless = value => normal(value).replace(/^(?:the|a|an)\s+/, '');
const qualificationMarker = /\b(?:if|unless|provided|providing|assuming|subject to|dependent on|depending on|pending|as long as|only after|only when|conditional on|contingent on|on condition|under an assumption|absent|approval (?:permitting|given|granted)|in (?:the|a) (?:draft|provisional|unapproved) plan)\b/gi;
const uncertainty = /\b(?:may|might|could|can|should|possibly|probably|presumably|perhaps|maybe|ideally|prefer|preferred|preferably|hope|hoping|hopefully|expected|planned|provisional|tentative|tentatively|uncertain|unconfirmed|approximate|approximately|roughly|around|about|estimate|estimated|try|trying|at least|at most|up to|no more than|no fewer than)\b/gi;
const assertion = /\b(?:proposal|proposed|suggestion|suggested|rejected|declined|disputed|incorrect|false|reported|reportedly|claim|claimed|says|said|asked|whether|cancelled|canceled)\b/i;
const season = /\b(?:spring|summer|autumn|fall|winter)\b/gi;
const negative = /\b(?:not|never|cannot|can't|won't|no longer|isn't|aren't|wasn't|weren't|hasn't|haven't|don't|doesn't|didn't|wouldn't|shouldn't|mustn't)\b/gi;
const actorPronoun = /^(?:i|we|you|he|she|it|they|this|that|these|those|there)\b/i;
const auxiliary = /\s+(will|shall|must|should|can|could|may|might|is|are|was|were|has|have|lasts|takes|begins|starts|ends|follows|runs|continues|resumes)\b/i;
const grammar = new Set('the a an and or is are was were be being been will shall must should can could may might has have had to of on in at for from between through during by as with it its their our your this that these those then also scheduled planned due lasts last takes take begins begin starts start ends end finishes finish follows follow runs run continues continue resumes resume occurs occur'.split(' '));
const temporalWords = new Set('today tomorrow yesterday tonight monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december next last previous this every each other day days week weeks month months quarter quarters year years hour hours minute minutes second seconds early late mid morning afternoon evening noon midday midnight night zero one two three four five six seven eight nine ten twenty thirty forty fifty sixty seventy eighty ninety hundred first second third fourth fifth'.split(' '));

function uniquePosition(haystack, needle) {
  if (typeof needle !== 'string' || !needle.trim()) return -1;
  const at = haystack.indexOf(needle);
  return at < 0 || haystack.indexOf(needle, at + 1) >= 0 ? -1 : at;
}

function removeQualification(value, quote) {
  const at = value.toLowerCase().indexOf(quote.toLowerCase());
  return at < 0 ? value : value.slice(0, at) + value.slice(at + quote.length);
}

function frame(value, qualifications = []) {
  let source = String(value).trim();
  for (const qualification of [...qualifications].sort((a, b) => b.length - a.length)) {
    if (source.toLowerCase().startsWith(qualification.toLowerCase())) source = source.slice(qualification.length).replace(/^\s*[,;:]?\s*/, '');
  }
  source = source.replace(/^(?:then|and then|and)\s+/i, '');
  const found = source.match(auxiliary);
  if (!found || found.index < 1 || found.index > 160) return null;
  const subject = source.slice(0, found.index).trim();
  if (actorPronoun.test(articleless(subject)) || /[,;:!?]/.test(subject) || /\b(?:if|unless|given|absent|upon|under|approval|permitting)\b/i.test(subject)) return null;
  return { subject, body: source.slice(found.index + found[0].length).trim(), auxiliary: found[1].toLowerCase(), source };
}

function boundarySafe(source, quote, start, qualificationQuotes) {
  const before = source.slice(0, start), after = source.slice(start + quote.length);
  const strip = value => qualificationQuotes.reduce((text, qualification) => text.replace(qualification, ''), value).replace(/[\s,.;:]+/g, '');
  // A selected source span must start at a whole main clause. An introductory
  // condition is permitted only when it is explicitly retained by the claim.
  const prefixSafe = !before.trim() || !strip(before)
    || /(?:[.;!?]\s*|\band\s+(?:then\s+)?|\bbut\s+)$/i.test(before);
  if (!prefixSafe) return false;
  if (!after.trim() || /^[.!?]\s*$/.test(after) || !strip(after)) return true;
  const following = after.match(/^\s*(?:[,;.]\s*|\band\s+(?:then\s+)?|\bbut\s+)([\s\S]+)$/i);
  // A bare second date or inherited predicate is part of the same phase.
  return Boolean(following && frame(following[1], qualificationQuotes));
}

function qualificationSegments(source) {
  const found = [];
  for (const match of source.matchAll(new RegExp(qualificationMarker.source, 'gi'))) {
    const tail = source.slice(match.index);
    const end = tail.search(/[,;.!?]/);
    const quote = tail.slice(0, end < 0 ? tail.length : end).trim();
    if (quote) found.push(quote);
  }
  return [...new Set(found)];
}

function exactQualifications(source, claim, quotes) {
  const expected = qualificationSegments(source);
  for (const expectedQuote of expected) {
    if (!quotes.some(quote => quote.includes(expectedQuote)) || !normal(claim).includes(normal(expectedQuote))) return false;
  }
  // Quotes are evidence rather than an invitation to invent extra qualifiers.
  for (const quote of quotes) {
    if (uniquePosition(source, quote) < 0 || !normal(claim).includes(normal(quote))
      || ![qualificationMarker, uncertainty, season, negative].some(pattern => new RegExp(pattern.source, 'i').test(quote))) return false;
  }
  return true;
}

function constraintContextRetained(source, claim, helpers) {
  for (const pattern of [uncertainty, negative]) {
    const required = [...source.matchAll(new RegExp(pattern.source, 'gi'))].map(match => normal(match[0]));
    if (required.some(value => !(` ${normal(claim)} `).includes(` ${value} `))) return false;
  }
  const seasons = typeof helpers.seasonProfile === 'function' ? helpers.seasonProfile : () => [];
  const retainedSeasons = seasons(claim);
  if (seasons(source).some(profile => !retainedSeasons.includes(profile))) return false;
  if (typeof helpers.phaseSubject === 'function' && typeof helpers.simpleTemporalPhase === 'function') {
    for (const phase of source.split(/\s+and\s+/i)) {
      if (!helpers.simpleTemporalPhase(phase)) continue;
      const subject = helpers.phaseSubject(phase);
      const ambiguous = [...subject.matchAll(new RegExp(season.source, 'gi'))];
      // A seasonal-looking event subject in an actual timing clause is
      // ambiguous. Keep it guarded; a non-timing component/name is not a date.
      if (ambiguous.some(match => !words(claim).includes(normal(match[0])))) return false;
    }
  }
  // Reported/rejected assertions and questions cannot become source facts.
  return source.trim() === claim.trim() || !assertion.test(source) && !source.includes('?');
}

function workNormal(value, operationGroups) {
  const forms = new Map();
  for (const [index, group] of operationGroups.entries()) for (const verb of group) {
    for (const form of [verb, `${verb}s`, `${verb}ed`, `${verb}ing`, ...(verb.endsWith('e') ? [`${verb}d`, `${verb.slice(0, -1)}ing`, `${verb.slice(0, -1)}ation`] : [])]) forms.set(form, `operation${index}`);
  }
  return words(value).map(word => forms.get(word) || word);
}

function propositionTokens(value, evidence, operationGroups, normaliseQuantities) {
  let body = evidence.qualificationQuotes.reduce((text, quote) => removeQualification(text, quote), String(value));
  if (typeof normaliseQuantities === 'function') body = normaliseQuantities(body);
  body = normal(body);
  const count = '(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten)';
  const duration = `${count}\\s+(?:(?:working|business)\\s+)?(?:days?|weeks?|months?|years?|hours?|minutes?|seconds?)`;
  // These are grammatical equivalents of an explicitly stated duration.
  // A start, finish, deadline or delay remains a different predicate.
  body = body.replace(new RegExp(`\\bscheduled\\s+for\\s+(?=${duration}\\b)`, 'g'), 'durationpredicate ')
    .replace(new RegExp(`\\b(?:last|lasts|take|takes)\\s+(?:for\\s+)?(?=${duration}\\b)`, 'g'), 'durationpredicate ')
    .replace(/\bon\s+(?:the\s+)?(?=(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d+(?:st|nd|rd|th)?\b))/g, '');
  const syntax = new Set('the a an is are be been will'.split(' '));
  return workNormal(body, operationGroups).filter(word => !syntax.has(word));
}

function independentQualifierPhase(source, selected, helpers) {
  if (source.length > 3000 || typeof helpers.phaseSubject !== 'function' || typeof helpers.simpleTemporalPhase !== 'function'
    || /[,;()[\]{}!?]/.test(source) || /\./.test(source.trim().replace(/\.$/, ''))
    || new RegExp(qualificationMarker.source, 'i').test(source) || new RegExp(negative.source, 'i').test(source)
    || assertion.test(source) || /\b(?:then|before|after|once|until|when|following|without|or|either|neither|otherwise|instead|except|but|although|however|both|these|those)\b/i.test(source)) return '';
  const phases = source.split(/\s+and\s+/i).map(text => text.trim());
  if (phases.length < 2 || phases.length > 4
    || !phases.some(text => text === selected || text.replace(/\.$/, '') === selected)) return '';
  const subjects = [];
  for (const phase of phases) {
    let clean = phase;
    const seasonTail = clean.match(/\s+(?:in|during)\s+(?:the\s+)?(?:(?:this|next|last|previous|early|mid|late)\s+)?(?:spring|summer|autumn|winter|fall)(?:\s+\d{4})?\.?$/i);
    if (seasonTail) clean = clean.slice(0, seasonTail.index).trim();
    // Prefix seasons can qualify the whole conjunction. Only a phase's own
    // explicit trailing seasonal phrase can be separated from its siblings.
    if (new RegExp(season.source, 'i').test(clean)) return '';
    const hedges = [...clean.matchAll(new RegExp(uncertainty.source, 'gi'))];
    if (hedges.length) {
      if (hedges.length !== 1 || !/^(?:may|might|could|can)$/i.test(hedges[0][0])) return '';
      clean = clean.slice(0, hedges[0].index) + 'will' + clean.slice(hedges[0].index + hedges[0][0].length);
    }
    const subject = helpers.phaseSubject(clean);
    if (!subject || !helpers.simpleTemporalPhase(clean)) return '';
    if (hedges.length && articleless(phase.slice(0, hedges[0].index)) !== normal(subject)) return '';
    const subjectWords = words(subject);
    if (subjectWords.slice(0, -1).some(word => /(?:ly|ing|ed)$/.test(word))) return '';
    const isSelected = phase === selected || phase.replace(/\.$/, '') === selected;
    if (!isSelected && subjectWords.length > 1 && !/^(?:the|a|an)\s+/i.test(phase)) return '';
    subjects.push(workNormal(subject, helpers.operationGroups || []).map(word => word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word));
  }
  // Related work, repeated actors and grammatical variants remain under the
  // full-record guard. A mere change of wording is not phase independence.
  if (subjects.some((left, at) => subjects.slice(at + 1).some(right => left.some(word => right.includes(word))))) return '';
  return selected;
}

function workBound(claim, source, evidence, operationGroups, normaliseQuantities) {
  const a = frame(claim, evidence.qualificationQuotes), b = frame(source, evidence.qualificationQuotes);
  if (!a || !b) return false;
  const past = value => /^(?:was|were|had)$/.test(value.auxiliary);
  if (past(a) !== past(b) || /^(?:has|have)$/.test(a.auxiliary) !== /^(?:has|have)$/.test(b.auxiliary)) return false;
  if (/\b(?:must|shall|required|mandatory|needs? to|has to|have to)\b/i.test(claim)
    && !/\b(?:must|shall|required|mandatory|needs? to|has to|have to)\b/i.test(source)) return false;
  const normalized = value => workNormal(value, operationGroups).filter(word => !grammar.has(word));
  const same = (left, right) => JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
  // A source name mentioned as a recipient or in a neighbouring phase is not
  // the actor of this phase. This first version intentionally leaves active /
  // passive role transformations unresolved rather than guessing the roles.
  if (!same(articleless(a.subject), articleless(b.subject))) return false;
  const wantedWork = normalized(evidence.workClaimQuote), sourceWork = normalized(evidence.workSourceQuote);
  if (!wantedWork.length || JSON.stringify(wantedWork) !== JSON.stringify(sourceWork)) return false;
  const substantial = value => normalized(value).filter(word => !temporalWords.has(word) && !/^\d/.test(word));
  if (JSON.stringify(propositionTokens(claim, evidence, operationGroups, normaliseQuantities)) !== JSON.stringify(propositionTokens(source, evidence, operationGroups, normaliseQuantities))) return false;
  // The declared work expression must identify this phase's complete event
  // subject or complete operation/object, never just a shared date or verb.
  const subject = normalized(a.subject);
  const bodyBeforeTiming = value => value.body.split(/\b(?:by|before|after|once|until|when|on|at|in|within|from|during|for)\b/i)[0].replace(/[.!?]+$/, '').trim();
  const wholeSubject = JSON.stringify(wantedWork) === JSON.stringify(subject)
    && JSON.stringify(sourceWork) === JSON.stringify(normalized(b.subject));
  const wholeOperation = JSON.stringify(substantial(evidence.workClaimQuote)) === JSON.stringify(substantial(bodyBeforeTiming(a)))
    && JSON.stringify(substantial(evidence.workSourceQuote)) === JSON.stringify(substantial(bodyBeforeTiming(b)));
  return wholeSubject || wholeOperation;
}

function validateTemporalEvidence(claim, records, evidence, options = {}, helpers = {}) {
  const no = reason => ({ supported: false, reason });
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) || Object.keys(evidence).some(key => !KEYS.has(key))
    || evidence.schemaVersion !== 1 || typeof claim !== 'string' || evidence.claimText !== claim
    || ['sourceId', 'sourceQuote', 'workSourceQuote', 'workClaimQuote'].some(key => typeof evidence[key] !== 'string' || !evidence[key].trim())
    || !Array.isArray(evidence.qualificationQuotes) || evidence.qualificationQuotes.length > 8
    || evidence.qualificationQuotes.some(quote => typeof quote !== 'string' || !quote.trim())
    || new Set(evidence.qualificationQuotes).size !== evidence.qualificationQuotes.length) return no('malformed_temporal_evidence');
  if (claim.length > 1600 || evidence.sourceQuote.length > 2000 || words(evidence.sourceQuote).length > 120) return no('temporal_evidence_limit_exceeded');
  const carrying = (Array.isArray(records) ? records : []).filter(record => record?.id === evidence.sourceId);
  if (carrying.length !== 1 || !['discussion', 'action'].includes(carrying[0].type) || typeof carrying[0].text !== 'string') return no('temporal_source_identity_not_proved');
  const record = carrying[0], source = record.text;
  const start = uniquePosition(source, evidence.sourceQuote);
  if (start < 0 || uniquePosition(evidence.sourceQuote, evidence.workSourceQuote) < 0 || uniquePosition(claim, evidence.workClaimQuote) < 0) return no('temporal_evidence_quote_not_unique');
  const qualificationSource = independentQualifierPhase(source, evidence.sourceQuote, helpers) || source;
  if (!exactQualifications(source, claim, evidence.qualificationQuotes) || !constraintContextRetained(qualificationSource, claim, helpers)) return no('temporal_source_qualification_not_retained');
  if (/\b(?:after|before|once|until|when|following)\s+(?:that|this|it|they|those|these|he|she)\b/i.test(claim)) return no('temporal_dependency_antecedent_unresolved');
  const workTokens = value => workNormal(value, helpers.operationGroups || []).filter(word => !grammar.has(word) && !temporalWords.has(word) && !/^\d/.test(word));
  const wholeRecord = normal(evidence.sourceQuote) === normal(source);
  const fullRecordProved = wholeRecord && (record.type === 'action' || claim.trim() === source.trim())
    && typeof helpers.legacySupportedByRecord === 'function'
    && helpers.legacySupportedByRecord(claim, record, options)
    && workTokens(evidence.workClaimQuote).length
    && JSON.stringify(workTokens(evidence.workClaimQuote)) === JSON.stringify(workTokens(evidence.workSourceQuote));
  if (record.type === 'action' && !fullRecordProved) return no('temporal_action_requires_complete_record');
  if (!boundarySafe(source, evidence.sourceQuote, start, evidence.qualificationQuotes)) return no('temporal_source_phase_not_complete');
  const outside = source.slice(0, start) + ' ' + source.slice(start + evidence.sourceQuote.length);
  if (normal(outside).includes(articleless(evidence.workSourceQuote))) return no('competing_temporal_source_phases');
  if (!fullRecordProved && !workBound(claim, evidence.sourceQuote, evidence, helpers.operationGroups || [], helpers.normaliseDurationQuantities)) return no('temporal_phase_work_not_proved');
  if (!fullRecordProved && (typeof helpers.temporalMeaningRetained !== 'function' || !helpers.temporalMeaningRetained(claim, evidence.sourceQuote, options))) return no('temporal_phase_meaning_not_retained');
  // Nearby evidence is context, not a source authority. A separate turn that
  // explicitly qualifies the same work or the shared plan must not disappear
  // merely because a model chose a shorter quoted phase.
  for (const other of options.contextRecords || []) {
    if (!other || other.id === record.id || typeof other.text !== 'string') continue;
    const shared = /\b(?:both phases|these dates|this plan|all phases|those dates|these timings)\b/i.test(other.text)
      || normal(other.text).includes(articleless(evidence.workSourceQuote));
    if (shared && (!constraintContextRetained(other.text, claim, helpers) || qualificationSegments(other.text).some(quote => !normal(claim).includes(normal(quote))))) return no('temporal_context_qualification_not_retained');
    if (normal(other.text).includes(articleless(evidence.workSourceQuote))
      && !helpers.temporalMeaningRetained(claim, other.text, options)) return no('competing_temporal_context');
  }
  return { supported: true, reason: 'source_bound_temporal_evidence', binding: { schemaVersion: 1, claimText: claim, sourceId: record.id,
    start, end: start + evidence.sourceQuote.length, sourceStart: start, sourceEnd: start + evidence.sourceQuote.length, sourceQuote: evidence.sourceQuote,
    workSourceQuote: evidence.workSourceQuote, workClaimQuote: evidence.workClaimQuote, qualificationQuotes: [...evidence.qualificationQuotes] } };
}

function temporalEvidencePromptInstructions() {
  return 'For a supported or corrected temporal sentence, also return temporalEvidence: {"schemaVersion":1,"claimText":"exact whole supported row or correctedText","sourceId":"one own cited sourceRecords id","sourceQuote":"one exact COMPLETE source phase, at most 120 words","workSourceQuote":"exact full work expression inside sourceQuote","workClaimQuote":"exact corresponding full work expression inside claimText","qualificationQuotes":[]}. Use original sourceRecords text, without the passage display labels. A phase means one complete independently stated actor/work and its own timing; exclude a separately subjected neighbouring phase. The work quotes contain ONLY the complete event subject or operation plus object: exclude dates, durations, auxiliaries and scheduling predicates. Example: sourceRecords [{"id":"T1","type":"discussion","text":"Report writing is scheduled for Tuesday and supplier training will begin Friday."}], row "Report preparation is scheduled for Tuesday." gives temporalEvidence {"schemaVersion":1,"claimText":"Report preparation is scheduled for Tuesday.","sourceId":"T1","sourceQuote":"Report writing is scheduled for Tuesday","workSourceQuote":"Report writing","workClaimQuote":"Report preparation","qualificationQuotes":[]}. For action authority records, quote the complete record; do not split its action, owners and timing labels into phases. Preserve the same actor, operation, recipient, date, duration, sequence, conditions, uncertainty and seasons; include exact source condition clauses in qualificationQuotes and retain them in claimText. Check the full source record and nearby context, including qualifications outside the chosen phase. Do not use a short quote to hide a condition or borrow timing from a neighbouring phase. A bare day does not establish its month. Do not invent an alignment if a noisy transcript is ambiguous: return uncertain. For uncertain, omit temporalEvidence. Existing evidenceQuote remains a separate contiguous quote of at most 25 words.';
}

module.exports = { validateTemporalEvidence, temporalEvidencePromptInstructions };
