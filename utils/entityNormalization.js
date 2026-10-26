'use strict';

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function key(value) {
  return clean(value).toLowerCase().normalize('NFKD').replace(/[^a-z0-9'’-]+/g, ' ').trim();
}

const settingsStore = require('./settingsStore');

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Confirmed person aliases that must never be shown as separate people. This is
// intentionally an exact, boundary-safe replacement. Every multi-word "other
// spelling" on the Settings page People list is one (Teams labels Rebecca Gill
// as "Rebecca Cuckoo"), and it is corrected consistently even when no attendee
// list is available yet.
const CODE_PERSON_ALIASES = Object.freeze([
  // Confirmed Teams ASR substitution. Word boundaries avoid partial changes
  // inside a different name while still correcting possessive/hyphenated use.
  { pattern: /\bColby\b/giu, replacement: 'Cody' }
]);

function spellingPattern(spelling, flags = 'giu') {
  const body = clean(spelling).split(/\s+/).map(escapeRegExp).join('\\s+').replace(/,\\s\+/g, ',\\s*');
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, flags);
}

let personAliasCache = { version: -1, aliases: [] };

// Multi-word other spellings from the People list, longest first, then the
// aliases kept in code.
function fixedPersonAliases() {
  const version = settingsStore.version();
  if (personAliasCache.version === version) return personAliasCache.aliases;
  const fromSettings = [];
  for (const person of settingsStore.getPeople()) {
    for (const spelling of person.spellings || []) {
      if (clean(spelling).split(/\s+/).length < 2 || key(spelling) === key(person.name)) continue;
      fromSettings.push({ spelling: clean(spelling), replacement: person.name });
    }
  }
  fromSettings.sort((left, right) => right.spelling.length - left.spelling.length);
  const aliases = [
    ...fromSettings.map((item) => ({ pattern: spellingPattern(item.spelling), replacement: item.replacement, spelling: item.spelling })),
    ...CODE_PERSON_ALIASES
  ];
  personAliasCache = { version, aliases };
  return aliases;
}

function normaliseFixedPersonAliases(value) {
  let output = String(value == null ? '' : value);
  for (const alias of fixedPersonAliases()) output = output.replace(alias.pattern, alias.replacement);
  return output;
}

// "Smith, Stuart M" is how some directories export names. Those spellings (the
// ones with a comma) are corrected in the transcript itself, before the models
// read it; other spellings are corrected in what the minutes print.
function normaliseDirectoryNameSpellings(value) {
  let output = String(value == null ? '' : value);
  for (const alias of fixedPersonAliases()) {
    if (alias.spelling && alias.spelling.includes(',')) output = output.replace(alias.pattern, alias.replacement);
  }
  return output;
}

function normaliseFixedPersonAliasesDeep(value) {
  if (typeof value === 'string') return normaliseFixedPersonAliases(value);
  if (Array.isArray(value)) return value.map(normaliseFixedPersonAliasesDeep);
  if (value && typeof value === 'object') {
    if (value instanceof Date) return value;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, normaliseFixedPersonAliasesDeep(item)]));
  }
  return value;
}

function damerauLevenshtein(left, right) {
  const a = key(left);
  const b = key(right);
  const matrix = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        matrix[i][j] = Math.min(matrix[i][j], matrix[i - 2][j - 2] + cost);
      }
    }
  }
  return matrix[a.length][b.length];
}

const PERSON_TITLE_TOKENS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'san']);

function personTokens(value) {
  let cleaned = clean(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  // "Dharmadhikari, Advait" is how some directories export names.
  const comma = cleaned.match(/^([^,]+),\s*([^,]+)$/);
  if (comma) cleaned = `${comma[2]} ${comma[1]}`;
  return cleaned.toLowerCase()
    .replace(/[-_.]+/g, ' ')
    .replace(/[^a-z\s]/g, '')
    .split(/\s+/)
    .filter((token) => token && !PERSON_TITLE_TOKENS.has(token));
}

function closeToAny(token, spellings, maxDistance) {
  return spellings.some((spelling) => token === spelling
    || (maxDistance > 0 && damerauLevenshtein(token, spelling) <= maxDistance));
}

// Short names get no fuzzy slack: one edit turns "Saki" into "Sami" or "Suki".
function firstNameMatches(token, person) {
  return closeToAny(token, person.firstNames, token.length >= 6 ? 1 : 0);
}

function surnameMatches(token, person) {
  return closeToAny(token, person.surnames, token.length >= 8 ? 2 : 1);
}

let peopleIndexCache = { version: -1, people: [], exact: new Map() };

// Each person on the Settings page People list, with the first names and
// surnames their name and other spellings allow.
function knownPeopleIndex() {
  const version = settingsStore.version();
  if (peopleIndexCache.version === version) return peopleIndexCache;
  const exact = new Map();
  const people = [];
  for (const person of settingsStore.getPeople()) {
    const firstNames = [];
    const surnames = [];
    for (const form of [person.name, ...(person.spellings || [])]) {
      const tokens = personTokens(form);
      exact.set(tokens.join(' '), exact.has(tokens.join(' ')) && exact.get(tokens.join(' ')) !== person ? null : person);
      if (tokens.length < 2) continue;
      if (!firstNames.includes(tokens[0])) firstNames.push(tokens[0]);
      const surname = tokens[tokens.length - 1];
      if (surname.length > 1 && !surnames.includes(surname)) surnames.push(surname);
    }
    if (firstNames.length && surnames.length) people.push({ person, firstNames, surnames });
  }
  peopleIndexCache = { version, people, exact };
  return peopleIndexCache;
}

function personMatches(tokens, entry) {
  const [first] = tokens;
  const last = tokens[tokens.length - 1];
  if (tokens.length === 1) {
    // A surname alone only counts when it is long enough not to be a common
    // word or first name ("Thomas", "Ryan", "Gill").
    return firstNameMatches(first, entry) || (first.length >= 7 && surnameMatches(first, entry));
  }
  const firstOk = firstNameMatches(first, entry);
  const surnameOk = surnameMatches(last, entry);
  const initialOk = last.length === 1 && last === entry.surnames[0][0];
  return firstOk && (surnameOk || initialOk);
}

// Returns the person on the People list this name refers to, or null. Accepts
// the name or an other spelling exactly, the first name alone, a long surname
// alone, a surname initial ("Advait D"), "Surname, First" and close
// misspellings of either part. A name that could be two people matches neither.
function knownPerson(value) {
  const tokens = personTokens(value);
  if (!tokens.length) return null;
  const index = knownPeopleIndex();
  const exact = index.exact.get(tokens.join(' '));
  if (exact) return exact;
  if (exact === null || tokens.length > 3) return null;
  const matches = index.people.filter((entry) => personMatches(tokens, entry));
  return matches.length === 1 ? matches[0].person : null;
}

function knownPersonName(value) {
  return knownPerson(value)?.name || '';
}

// Returns the proper name when the value is someone listed as Internal on the
// People list, otherwise ''. Internal people are always internal, never client,
// whatever the transcript or a model says.
function alwaysInternalAttendeeName(value) {
  const person = knownPerson(value);
  return person?.side === 'internal' ? person.name : '';
}

function isAlwaysInternalAttendee(value) {
  return Boolean(alwaysInternalAttendeeName(value));
}

function attendeeFirstNames(attendees = []) {
  const byFirst = new Map();
  for (const attendee of Array.isArray(attendees) ? attendees : []) {
    const fullName = clean(attendee);
    if (!fullName || /^(?:not stated|unknown|all)$/i.test(fullName)) continue;
    const firstName = fullName.split(/\s+/)[0];
    const firstKey = key(firstName);
    if (!firstKey) continue;
    if (!byFirst.has(firstKey)) byFirst.set(firstKey, []);
    byFirst.get(firstKey).push({ firstName, fullName });
  }
  return [...byFirst.values()].filter((matches) => matches.length === 1).map((matches) => matches[0]);
}

function personShapedContext(text, start, end) {
  const before = text.slice(Math.max(0, start - 80), start);
  const after = text.slice(end, Math.min(text.length, end + 45));
  return /(?:\b(?:participant|attendee|speaker)\s+|\b(?:call|meeting|session|check-in|catch-up)\b.{0,50}\b(?:with|for)\s+|\b(?:meet|speak|talk|check|follow[- ]?up)\s+(?:with|to)\s+|\b(?:ask|asked|tell|told|email|emailed|contact|contacted|phone|phoned|message|messaged|invite|invited)\s+|\b(?:send|share|provide|forward|circulate)\b.{0,35}\bto\s+)$/i.test(before)
    || /^\s*(?:said|asked|confirmed|noted|explained|will|can|could|needs?\s+to|has\s+to|is\s+going\s+to)\b/i.test(after);
}

function stripGenericRoleBeforeKnownPerson(value, attendees = []) {
  let output = String(value || '');
  const names = attendeeFirstNames(attendees)
    .flatMap((item) => [item.fullName, item.firstName])
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  for (const name of [...new Set(names)]) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    output = output.replace(new RegExp(`\\b(?:participant|attendee|speaker)\\s+(${escaped})\\b`, 'gi'), '$1');
  }
  return output;
}

function normalisePublishedParticipantReference(value, attendees = []) {
  const corrected = normaliseAttendeeReferences(value, attendees).text;
  return stripGenericRoleBeforeKnownPerson(corrected, attendees);
}

function extractMentionedPeople(text, confirmedAttendees = []) {
  const source = String(text || '');
  const confirmedFirstNames = new Set((Array.isArray(confirmedAttendees) ? confirmedAttendees : []).map((name) => key(clean(name).split(/\s+/)[0])).filter(Boolean));
  const mentions = new Map();
  const patterns = [
    /(?:^|[.!?]\s+)([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]{2,19}),\s+/g,
    /\b(?:with|from|to|ask|asked|tell|told|email|emailed|contact|contacted|call|called|invite|invited)\s+([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]{2,19})\b/g
  ];
  const excluded = /^(?:The|This|That|There|They|Then|When|Where|What|Which|Who|How|And|But|So|Yes|Yeah|Okay|Right|Meeting|Client|Trinzo|Action|Actions|Review|Follow|Next|Today|Tomorrow)$/i;
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const name = clean(match[1]);
      if (!name || excluded.test(name) || confirmedFirstNames.has(key(name))) continue;
      mentions.set(key(name), { firstName: name, fullName: name, count: (mentions.get(key(name))?.count || 0) + 1 });
    }
  }
  return [...mentions.values()].filter((item) => item.count >= 2).map((item) => item.firstName);
}

function findAttendeeTextCorrections(text, attendees = []) {
  const source = String(text || '');
  if (!source) return [];
  const candidates = attendeeFirstNames(attendees);
  if (!candidates.length) return [];
  const exactFirstNames = new Set(candidates.map((item) => key(item.firstName)));
  const corrections = [];
  const tokenPattern = /\b[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'’.-]{2,19}\b/g;
  for (const match of source.matchAll(tokenPattern)) {
    const token = match[0];
    const tokenKey = key(token);
    if (!tokenKey || exactFirstNames.has(tokenKey) || !personShapedContext(source, match.index, match.index + token.length)) continue;
    const ranked = candidates.map((candidate) => ({
      ...candidate,
      distance: damerauLevenshtein(token, candidate.firstName)
    })).sort((left, right) => left.distance - right.distance || left.firstName.localeCompare(right.firstName));
    const best = ranked[0];
    const second = ranked[1];
    const maximum = tokenKey.length <= 3 ? 0 : tokenKey.length <= 6 ? 1 : 2;
    if (!best || best.distance > maximum) continue;
    if (second && second.distance <= best.distance) continue;
    corrections.push({
      original: token,
      replacement: best.firstName,
      attendee: best.fullName,
      distance: best.distance,
      start: match.index,
      end: match.index + token.length,
      confidence: best.distance === 0 ? 1 : best.distance === 1 ? 0.985 : 0.94
    });
  }
  return corrections;
}

// A transcription that gets the first name right and the surname wrong.
//
// Teams wrote "Rebecca Cuckoo" 388 times across this corpus where the attendee is Rebecca
// Gill, and nothing corrected it: findAttendeeTextCorrections compares FIRST names by edit
// distance, and "Rebecca" is already right - it is the surname that is invented, and no
// edit distance connects "Cuckoo" to "Gill".
//
// So the first name is the anchor and the confirmed attendee list is the authority. This
// only fires when the first name matches exactly one attendee: attendeeFirstNames already
// drops first names shared by two people, which is what keeps a meeting with two Jos from
// having one silently renamed into the other.
function findAttendeeSurnameCorrections(text, attendees = []) {
  const source = String(text || '');
  if (!source) return [];
  const byFirst = new Map(attendeeFirstNames(attendees)
    .filter((candidate) => candidate.fullName.split(/\s+/).length >= 2)
    .map((candidate) => [key(candidate.firstName), candidate]));
  if (!byFirst.size) return [];
  const corrections = [];
  const pattern = /\b([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’-]{1,19})\s+([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’-]{1,19})\b/g;
  for (const match of source.matchAll(pattern)) {
    const candidate = byFirst.get(key(match[1]));
    if (!candidate) continue;
    // Already the attendee's own name - nothing to correct.
    if (key(match[0]) === key(candidate.fullName)) continue;
    corrections.push({
      original: match[0],
      replacement: candidate.fullName,
      attendee: candidate.fullName,
      distance: null,
      start: match.index,
      end: match.index + match[0].length,
      confidence: 0.9,
      kind: 'surname'
    });
  }
  return corrections;
}

function normaliseAttendeeReferences(text, attendees = []) {
  const source = normaliseFixedPersonAliases(text);
  const firstNameCorrections = findAttendeeTextCorrections(source, attendees);
  const surnameCorrections = findAttendeeSurnameCorrections(source, attendees);
  // A surname correction spans two tokens and can overlap a first-name one. The surname
  // fix carries more information, so it wins and the overlapping first-name fix is dropped
  // rather than both being applied to the same span.
  const corrections = [
    ...surnameCorrections,
    ...firstNameCorrections.filter((item) => !surnameCorrections.some((other) => item.start < other.end && other.start < item.end))
  ].sort((left, right) => left.start - right.start);
  if (!corrections.length) return { text: source, corrections: [] };
  let output = source;
  for (const correction of [...corrections].sort((left, right) => right.start - left.start)) {
    output = `${output.slice(0, correction.start)}${correction.replacement}${output.slice(correction.end)}`;
  }
  return { text: output, corrections };
}

module.exports = {
  alwaysInternalAttendeeName,
  knownPerson,
  knownPersonName,
  normaliseDirectoryNameSpellings,
  isAlwaysInternalAttendee,
  damerauLevenshtein,
  extractMentionedPeople,
  findAttendeeTextCorrections,
  findAttendeeSurnameCorrections,
  normaliseFixedPersonAliases,
  normaliseFixedPersonAliasesDeep,
  normaliseAttendeeReferences,
  stripGenericRoleBeforeKnownPerson,
  normalisePublishedParticipantReference
};
