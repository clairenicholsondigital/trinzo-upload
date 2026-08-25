'use strict';

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function key(value) {
  return clean(value).toLowerCase().normalize('NFKD').replace(/[^a-z0-9'’-]+/g, ' ').trim();
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
  return /(?:\b(?:call|meeting|session|check-in|catch-up)\s+with\s+|\b(?:meet|speak|talk|check|follow[- ]?up)\s+(?:with|to)\s+|\b(?:ask|asked|tell|told|email|emailed|contact|contacted|phone|phoned|message|messaged|invite|invited)\s+|\b(?:send|share|provide|forward|circulate)\b.{0,35}\bto\s+)$/i.test(before)
    || /^\s*(?:said|asked|confirmed|noted|explained|will|can|could|needs?\s+to|has\s+to|is\s+going\s+to)\b/i.test(after);
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
  const firstNameCorrections = findAttendeeTextCorrections(text, attendees);
  const surnameCorrections = findAttendeeSurnameCorrections(text, attendees);
  // A surname correction spans two tokens and can overlap a first-name one. The surname
  // fix carries more information, so it wins and the overlapping first-name fix is dropped
  // rather than both being applied to the same span.
  const corrections = [
    ...surnameCorrections,
    ...firstNameCorrections.filter((item) => !surnameCorrections.some((other) => item.start < other.end && other.start < item.end))
  ].sort((left, right) => left.start - right.start);
  if (!corrections.length) return { text: String(text || ''), corrections: [] };
  let output = String(text || '');
  for (const correction of [...corrections].sort((left, right) => right.start - left.start)) {
    output = `${output.slice(0, correction.start)}${correction.replacement}${output.slice(correction.end)}`;
  }
  return { text: output, corrections };
}

module.exports = {
  damerauLevenshtein,
  extractMentionedPeople,
  findAttendeeTextCorrections,
  findAttendeeSurnameCorrections,
  normaliseAttendeeReferences
};
