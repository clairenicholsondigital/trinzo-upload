'use strict';

const { indexReviewResults, finishReviewAccounting } = require('./meetingMinutesReviewAccounting');
const { formatTimingLabel, isValidCalendarDate } = require('./meetingMinutesTiming');
const V = require('./meetingMinutesAgentV2');
const Binding = require('./meetingMinutesTemporalBinding');

function temporalClaim(value) {
  if (seasonProfile(value).length) return true;
  return /\b(?:today|tomorrow|yesterday|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|daily|weekly|fortnightly|monthly|quarterly|annually|yearly|morning|afternoon|evening|noon|midday|midnight|night|(?:this|next|last|previous|every|each)\s+(?:day|week|month|quarter|year)|(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)(?:st|nd|rd|th)?\s+(?:days?|weeks?|months?|years?|hours?|minutes?|seconds?)|before|after|within|until|once|when|deadline|target|preferred|fallback|contingency|available|availability)\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*(?:am|pm)\b/i.test(String(value || ''));
}

function seasonProfile(value) {
  const body = String(value || '').toLowerCase();
  const found = new Map();
  // A bare season word may instead name a component or person ("spring
  // latch"). Require an explicit temporal preposition/modifier or year.
  for (const match of body.matchAll(/\b(?:(this|next|last|previous|early|mid|late)\s+|(?:in|during|by|before|after|until|for|through|over)(?:\s+the)?\s+(?:(this|next|last|previous|early|mid|late)\s+)?)(spring|summer|autumn|winter|fall)\b(?:\s+(\d{4}))?/g)) {
    const at = match.index + match[0].lastIndexOf(match[3]);
    found.set(at, `${match[1] || match[2] || ''}:${match[3] === 'fall' ? 'autumn' : match[3]}${match[4] ? ':' + match[4] : ''}`);
  }
  for (const match of body.matchAll(/\b(spring|summer|autumn|winter|fall)\s+(\d{4})\b/g)) {
    if (!found.has(match.index)) found.set(match.index, `:${match[1] === 'fall' ? 'autumn' : match[1]}:${match[2]}`);
  }
  return [...found].sort((a, b) => a[0] - b[0]).map(([, profile]) => profile);
}

const OP_GROUPS = [
  ['send', 'sent', 'share', 'shared', 'circulate', 'circulated', 'forward', 'forwarded'],
  ['write', 'written', 'draft', 'drafted', 'prepare', 'prepared'],
  ['review', 'reviewed', 'check', 'checked', 'assess', 'assessed'],
  ['approve', 'approved', 'authorise', 'authorized', 'authorize'],
  ['submit', 'submitted', 'file', 'filed'], ['complete', 'completed', 'finish', 'finished'],
  ['test', 'tested', 'validate', 'validated'], ['meet', 'meeting', 'call'], ['update', 'updated', 'revise', 'revised'],
  ['enter', 'entered', 'record', 'recorded', 'register', 'registered'], ['delete', 'deleted', 'remove', 'removed']
];
const TEMPORAL_WORDS = new Set('today tomorrow yesterday tonight monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december next last previous this every each day days week weeks month months quarter quarters year years hour hours minute minutes early late mid before after once when until by on at within from to due target deadline timing owners stated preferably preferred fallback contingency ideally probably possibly presumably hopefully perhaps maybe try trying hope hoping expected approximately roughly around about'.split(' '));
for (const word of 'daily weekly fortnightly monthly quarterly annually yearly morning afternoon evening noon midday midnight night middle'.split(' ')) TEMPORAL_WORDS.add(word);
const canon = value => String(value || '').toLowerCase().replace(/[’]/g, "'").replace(/[–—]/g, '-').replace(/[^\p{L}\p{N}:' +\-]+/gu, ' ').replace(/\s+/g, ' ').trim();
const WEEKDAY = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday';
const MONTH = 'january|february|march|april|may|june|july|august|september|october|november|december';
const COUNT = '\\d+|one|two|three|four|five|six|seven|eight|nine|ten';
const TEMPORAL_ANCHOR = `(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}:\\d{2}(?:\\s*(?:am|pm))?|\\d{1,2}\\s*(?:am|pm)|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTH})(?:\\s+\\d{4})?|(?:${COUNT})\\s+(?:(?:working|business)\\s+)?(?:days?|weeks?|months?|hours?|minutes?)|(?:(?:this|next|last|previous)\\s+)?(?:${WEEKDAY}|weekend|week|month|quarter|year)|${MONTH}|today|tomorrow|tonight|morning|afternoon|evening|noon|midday|midnight|night|(?:end|start|middle)\\s+of\\s+(?:(?:this|next|the)\\s+)?(?:week|month|year))`;
function temporalFacets(text) {
  const recurrence = [];
  const counts = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const frequencies = { daily: 'day:1', weekly: 'week:1', fortnightly: 'week:2', monthly: 'month:1', quarterly: 'quarter:1', annually: 'year:1', yearly: 'year:1' };
  const recurring = new RegExp(`\\b(?:every|each)\\s+(?:(other|${COUNT})\\s+)?(${WEEKDAY}|day|week|month|quarter|year)s?\\b(?:\\s+on\\s+(${WEEKDAY})\\b)?|\\b(daily|weekly|fortnightly|monthly|quarterly|annually|yearly)\\b(?:\\s+(?:on\\s+)?(${WEEKDAY})\\b)?|\\b(${WEEKDAY})s\\b`, 'g');
  let atomsText = text.replace(recurring, (_, count, unit, intervalDay, frequency, frequencyDay, pluralDay) => {
    const weekday = pluralDay || intervalDay || frequencyDay || (unit && new RegExp(`^(?:${WEEKDAY})$`).test(unit) ? unit : '');
    const interval = count === 'other' ? 2 : counts[count] || Number(count) || 1;
    const cadence = frequency ? frequencies[frequency] : `${pluralDay || new RegExp(`^(?:${WEEKDAY})$`).test(unit || '') ? 'week' : unit}:${interval}`;
    recurrence.push(`${cadence}${weekday ? ':' + weekday : ''}`);
    return weekday || '';
  });
  const nth = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
  const recurringOrdinals = [...text.matchAll(new RegExp(`\\b(first|second|third|fourth|fifth|last|\\d+(?:st|nd|rd|th))\\s+(${WEEKDAY})\\s+of\\s+(?:each|every)\\s+(month|quarter|year)\\b`, 'g'))]
    .map(match => `${nth[match[1]] || parseInt(match[1], 10) || match[1]}:${match[2]}:${match[3]}`);
  const ranges = [];
  atomsText = atomsText.replace(new RegExp(`\\b(?:(within|in|before|after)\\s+)?(${COUNT})\\s*(?:to|or|-)\\s*(${COUNT})\\s+((?:(?:working|business)\\s+)?(?:days?|weeks?|months?|hours?|minutes?))\\b`, 'g'), (_, relation, low, high, unit) => {
    ranges.push(`${relation || ''}:${counts[low] || Number(low)}:${counts[high] || Number(high)}:${unit.replace(/s$/, '')}`);
    return '';
  });
  const relations = value => [...value.matchAll(new RegExp(`\\b(no later than|not later than|on or before|by|before|after|within|until|from|on)\\s+(?:the\\s+)?(${TEMPORAL_ANCHOR})\\b`, 'g'))]
    .filter(match => match[1] !== 'on') // A bare Friday already denotes an occurrence on Friday.
    .map(match => `${/^(?:no later than|not later than|on or before)$/.test(match[1]) ? 'by' : match[1]}:${match[2]}`);
  const bounds = relations(atomsText);
  // Ordinary action publication carries timing semantics in its label. A
  // Deadline: Friday can support "by Friday"; Target: Friday cannot.
  const deadline = atomsText.match(/\bdeadline\s*:\s*(.+)$/)?.[1];
  if (deadline && !relations(deadline).length) {
    const anchor = deadline.match(new RegExp(`\\b(${TEMPORAL_ANCHOR})\\b`))?.[1];
    if (anchor) bounds.push(`by:${anchor}`);
  }
  const anchors = [...text.matchAll(new RegExp(`\\b(${TEMPORAL_ANCHOR})\\b`, 'g'))]
    .filter(match => !/^(?:morning|afternoon|evening|noon|midday|midnight|night)$/.test(match[0]));
  const dayparts = [...text.matchAll(/\b(?:morning|afternoon|evening|noon|midday|midnight|night)\b/g)].map(match => {
    const nearest = anchors.map(anchor => ({ text: anchor[0], distance: Math.min(Math.abs(anchor.index - match.index), Math.abs(anchor.index + anchor[0].length - match.index)) }))
      .sort((a, b) => a.distance - b.distance)[0];
    return `${nearest?.text || ''}:${match[0] === 'midday' ? 'noon' : match[0]}`;
  });
  const phases = [...text.matchAll(new RegExp(`\\b(early|mid|late|middle)\\s*[- ]\\s*(?:(?:in|of)\\s+)?(${TEMPORAL_ANCHOR})\\b`, 'g'))]
    .map(match => `${match[1] === 'middle' ? 'mid' : match[1]}:${match[2]}`);
  const quantityBounds = [...text.matchAll(new RegExp(`\\b(up to|at most|no more than|not more than|maximum(?: of)?|at least|no fewer than|not less than|minimum(?: of)?|more than|less than)\\s+(${COUNT})\\s+((?:(?:working|business)\\s+)?(?:days?|weeks?|months?|quarters?|years?|hours?|minutes?|seconds?))\\b`, 'g'))]
    .map(match => `${/^(?:up to|at most|no more than|not more than|maximum)/.test(match[1]) ? 'inclusive_upper'
      : /^(?:at least|no fewer than|not less than|minimum)/.test(match[1]) ? 'inclusive_lower'
        : match[1] === 'more than' ? 'exclusive_lower' : 'exclusive_upper'}:${counts[match[2]] || Number(match[2])}:${match[3].replace(/s$/, '')}`);
  return { atomsText, recurrence: [...new Set(recurrence)], recurringOrdinals, ranges, bounds, dayparts, phases,
    seasons: seasonProfile(text), quantityBounds };
}
function temporalProfile(value) {
  const labelled = canon(value).replace(/\b(?:on or before|no later than|not later than)\b/g, 'by'), facets = temporalFacets(labelled);
  const text = labelled.replace(/\b(?:owners|timing|target|deadline|dependent on)\s*:/g, ' ').replace(/\bnot stated\b/g, ' ');
  // A transcript may omit spaces around a clock or zone ("at10:30BST").
  // Keep these constraints independently of calendar-token matching.
  const clocks = (text.match(/(?<!\d)\d{1,2}:\d{2}(?:\s*(?:am|pm))?(?!\d)|(?<!\d)\d{1,2}\s*(?:am|pm)(?![a-z])/g) || [])
    .map(clock => clock.replace(/\s+/g, ''));
  const zones = (text.match(/(?<![a-z])(?:utc|gmt)(?:\s*[+-]\s*\d{1,2}(?::?\d{2})?)?(?![a-z])|(?<![a-z])(?:bst|cet|cest|est|edt|pst|pdt)(?![a-z])/g) || [])
    .map(zone => zone.replace(/\s+/g, ''));
  const atoms = facets.atomsText.match(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}(?:\s*(?:am|pm|gmt|bst|utc|cet|cest))?\b|\b\d{1,2}\s*(?:am|pm)\b|\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:(?:working|business)\s+)?(?:days?|weeks?|months?|quarters?|years?|hours?|minutes?|seconds?)\b|\b\d+(?:st|nd|rd|th)?\b|\b(?:today|tomorrow|yesterday|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b|\b(?:this|next|last|previous)\s+(?:day|week|month|quarter|year)\b|\b(?:preferred|fallback|contingency|hard stop)\b/g) || [];
  const dependencies = text.match(/\b(?:before|after|once|until|when|subject to|dependent on)\s+[^.;:]{1,100}/g) || [];
  return { text, atoms, dependencies, clocks, zones, ...Object.fromEntries(['recurrence', 'recurringOrdinals', 'ranges', 'bounds', 'dayparts', 'phases', 'seasons', 'quantityBounds'].map(field => [field, facets[field]])),
    historicalSchedule: /\b(?:(?:was|were|had been)\s+(?:not\s+)?(?:scheduled|planned|due)|(?:was|were)\s+to\s+(?:begin|start|end|finish|run|resume|occur)|took place)\b/.test(text),
    capability: /\b(?:can|could|able to|capable of)\b/.test(text),
    hedged: /\b(?:try|trying|may|might|could|possibly|probably|presumably|perhaps|maybe|ideally|prefer|preferred|preferably|hope|hoping|hopefully|expected|provisional)\b/.test(text),
    negative: /\b(?:not|never|cannot|can't|won't|no longer)\b/.test(text) };
}
function temporalMeaningRetained(claim, source, options = {}) {
  const anchoredYears = value => isValidCalendarDate(options.meetingDate)
    ? String(value).replace(/\b(this|next|last|previous) year\b/gi, (_, relative) => String(Number(options.meetingDate.slice(0, 4))
      + (/next/i.test(relative) ? 1 : /last|previous/i.test(relative) ? -1 : 0))) : value;
  const a = temporalProfile(anchoredYears(claim)), b = temporalProfile(anchoredYears(source));
  if (a.negative !== b.negative || b.hedged && !a.hedged) return false;
  if (a.historicalSchedule !== b.historicalSchedule || b.capability && !a.capability) return false;
  if (JSON.stringify(a.clocks) !== JSON.stringify(b.clocks) || JSON.stringify(a.zones) !== JSON.stringify(b.zones)) return false;
  if (['recurrence', 'recurringOrdinals', 'ranges', 'bounds', 'dayparts', 'phases', 'seasons', 'quantityBounds'].some(field => JSON.stringify(a[field]) !== JSON.stringify(b[field]))) return false;
  let at = 0;
  for (const atom of a.atoms) {
    at = b.atoms.indexOf(atom, at);
    if (at < 0) return false;
    at += 1;
  }
  if (b.atoms.some(atom => !a.atoms.includes(atom))) return false;
  // A dependency is part of the timing, not an expendable prose detail.
  if (b.dependencies.length && !a.dependencies.length) return false;
  for (const dependency of a.dependencies) {
    const words = dependency.split(' ').filter(word => !['the', 'a', 'an'].includes(word));
    if (!b.dependencies.some(other => words.every(word => other.split(' ').includes(word)))) return false;
  }
  return true;
}
function sameTemporalWork(claim, source) {
  const operationSet = value => new Set(OP_GROUPS.flatMap((group, index) => group.some(word => new RegExp(`\\b${word}\\b`, 'i').test(value)) ? [index] : []));
  const a = operationSet(claim), b = operationSet(source);
  if (b.size && (!a.size || [...a].some(key => !b.has(key)))) return false;
  // Unknown operations after a modal still carry meaning. Shared subject
  // nouns cannot prove "must be entered" against "must be deleted".
  const modalOperations = value => [...canon(value).matchAll(/\b(?:will|shall|must|should|needs? to|has to|have to)\s+(?:be\s+)?([a-z]+)\b/g)]
    .map(match => match[1]).filter(word => !['have', 'been', 'the', 'a', 'an', 'this', 'that', 'these', 'those'].includes(word));
  const sourceOperations = modalOperations(source);
  if (modalOperations(claim).some(word => !sourceOperations.includes(word)
    && !OP_GROUPS.some(group => group.includes(word) && (sourceOperations.length
      ? sourceOperations.some(other => group.includes(other))
      : group.some(other => new RegExp(`\\b${other}\\b`, 'i').test(source)))))) return false;
  const stop = new Set([...TEMPORAL_WORDS, ...OP_GROUPS.flat(), 'will', 'would', 'shall', 'can', 'could', 'must', 'should', 'been', 'being']);
  const objects = value => new Set(V.contentTokens(value).filter(word => !stop.has(word) && !/^\d/.test(word)));
  const wanted = objects(claim), present = objects(source);
  const shared = [...wanted].filter(word => present.has(word)).length;
  if (!wanted.size || shared < Math.min(2, wanted.size) || shared / wanted.size < 0.7) return false;
  const proper = String(claim).match(/\b[A-Z][a-z]+\b/g) || [];
  return proper.filter(word => !TEMPORAL_WORDS.has(word.toLowerCase()) && !['The', 'A', 'An', 'It', 'This', 'They', 'We', 'He', 'She'].includes(word)
    && !OP_GROUPS.flat().includes(word.toLowerCase())).every(word => new RegExp(`\\b${word}\\b`, 'i').test(source));
}

function phaseSubject(value) {
  const match = String(value).match(/^([\p{L}][\p{L}'’-]*(?:\s+[\p{L}][\p{L}'’-]*){0,2}?)\s+(?:will|shall|must|is|are|was|were|has|have|lasts|takes|begins|starts|ends|follows)\b/iu);
  if (!match || /\b(?:i|we|us|you|he|she|it|they|this|that|these|those|our|my|your|his|her|their|on|in|at|by|for|from|to|of|under|over|upon|with|as|per|during|within|given)\b/i.test(match[1])) return '';
  const subject = canon(match[1]).replace(/^(?:the|a|an)\s+/, '');
  if (subject.split(' ').length > 2) return '';
  // An unpunctuated participial prefix ("approval permitting report work")
  // is not an unambiguous subject. A final event noun ("training") is safe.
  if (subject.split(' ').slice(0, -1).some(word => /(?:ing|ed)$/.test(word))) return '';
  return subject.split(' ').some(word => !TEMPORAL_WORDS.has(word)) ? subject : '';
}

function simpleTemporalPhase(value) {
  // Accept only a complete timing predicate followed by its temporal tail.
  // An arbitrary suffix or intervening context could qualify both phases.
  const predicate = String(value).match(/^[\p{L}][\p{L}'’-]*(?:\s+[\p{L}][\p{L}'’-]*){0,5}?\s+(?:(?:is|are|was|were)\s+scheduled|(?:will|shall|must)\s+(?:last|take|begin|start|end|finish|follow|run|resume|occur)|lasts|takes|begins|starts|ends|follows)\s+(.+?)\.?$/iu);
  if (!predicate) return false;
  const clock = '\\d{1,2}:\\d{2}(?:\\s*(?:am|pm))?|\\d{1,2}\\s*(?:am|pm)';
  const zone = '(?:(?:utc|gmt)(?:\\s*[+-]\\s*\\d{1,2}(?::?\\d{2})?)?|bst|cet|cest|est|edt|pst|pdt)';
  const range = `(?:${COUNT})\\s+(?:to|-)\\s+(?:${COUNT})\\s+(?:(?:working|business)\\s+)?(?:days?|weeks?|months?|hours?|minutes?)`;
  const recurring = `(?:every|each)\\s+(?:(?:other|${COUNT})\\s+)?(?:${WEEKDAY}|days?|weeks?|months?|quarters?|years?)|daily|weekly|fortnightly|monthly|quarterly|annually|yearly`;
  const anchor = `(?:${range}|${recurring}|${TEMPORAL_ANCHOR})`;
  return new RegExp(`^(?:(?:for|during|in|on|at|by|within)\\s+)?(?:the\\s+)?${anchor}(?:\\s+(?:morning|afternoon|evening|night))?(?:\\s+at\\s+(?:${clock}))?(?:\\s+${zone})?$`, 'i').test(predicate[1]);
}

function independentSourcePhaseClips(value) {
  const source = String(value || '');
  // Scope can extend across a coordinator or even a sentence boundary. This
  // fallback does not guess which phase an external qualification governs.
  if (source.length > 3000 || /[,;()[\]{}!?]/.test(source) || /\b(?:if|unless|provided|providing|assuming|only|subject to|dependent on|depends|depending|conditional|contingent|pending|as long as|whether|once|when|until|after|before|and then|without|not|never|no|cannot|can't|won't|shan't|ain't|(?:is|are|was|were|has|have|do|does|did|would|should|must|need)n['’]t|may|might|could|can|should|possibly|probably|presumably|perhaps|maybe|ideally|prefer|preferred|preferably|hope|hoping|hopefully|expected|provisional|tentative|tentatively|uncertain|unconfirmed|approximate|approximately|roughly|around|about|estimate|estimates|estimated|try|trying|or|either|neither|otherwise|instead|except|but|although|however)\b/i.test(source)) return [];
  const sentences = source.split(/(?<=[.!?])\s+/).filter(Boolean);
  // Even a separate sentence can qualify every phase ("Both start Monday").
  // Keep the fallback limited to a single complete compound source sentence.
  if (sentences.length !== 1) return [];
  const clips = [];
  let cursor = 0;
  for (const sentence of sentences) {
    const sentenceStart = source.indexOf(sentence, cursor);
    cursor = sentenceStart + sentence.length;
    const boundaries = [...sentence.matchAll(/\s+and\s+/gi)]
      .filter(match => phaseSubject(sentence.slice(match.index + match[0].length)));
    if (!boundaries.length) continue;
    if (boundaries.length > 3) return [];
    const starts = [0, ...boundaries.map(match => match.index + match[0].length)];
    const ends = [...boundaries.map(match => match.index), sentence.length];
    const phases = starts.map((start, index) => {
      const raw = sentence.slice(start, ends[index]);
      const leading = raw.length - raw.trimStart().length;
      const label = raw.trimStart().match(/^[A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*){0,2}:\s+/u)?.[0] || '';
      const clipStart = sentenceStart + start + leading + label.length;
      const clipEnd = sentenceStart + ends[index] - (raw.length - raw.trimEnd().length);
      const text = source.slice(clipStart, clipEnd);
      return { text, start: clipStart, end: clipEnd, subject: phaseSubject(text) };
    });
    // An inherited subject, an unfinished clause or repeated work with multiple
    // timings is not independent phase evidence. Keep those cases unresolved.
    if (phases.some(phase => !phase.subject || !simpleTemporalPhase(phase.text)) || phases.some((left, index) => phases.slice(index + 1)
      .some(right => sameTemporalWork(left.text, right.text) || sameTemporalWork(right.text, left.text)))) return [];
    clips.push(...phases);
    if (clips.length > 4) return [];
  }
  return clips;
}

function supportedByApprovedRecord(claim, record, options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, 'temporalEvidence')) {
    return validateTemporalEvidence(claim, [record], options.temporalEvidence, options).supported;
  }
  return legacySupportedByApprovedRecord(claim, record, options);
}

function legacySupportedByApprovedRecord(claim, record, options = {}) {
  if (canon(claim) === canon(record.text)) return true;
  const candidates = record.type === 'action' ? [record.text] : record.text
    .split(/;|(?<=[.!?])\s+|\band\s+(?=[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+(?:will|shall|must|is to)\b)/).filter(Boolean);
  if (candidates.some(source => sameTemporalWork(claim, source) && temporalMeaningRetained(claim, source, options))) return true;
  if (record.type !== 'discussion') return false;
  const subject = phaseSubject(claim);
  // This narrow fallback verifies a whole source phase, not a paraphrase or
  // an arbitrary quoted fragment that may have dropped a local qualifier.
  return Boolean(subject) && independentSourcePhaseClips(record.text).some(clip => canon(claim) === canon(clip.text) && clip.subject === subject
    && sameTemporalWork(claim, clip.text) && temporalMeaningRetained(claim, clip.text, options));
}

function validateTemporalEvidence(claim, records, evidence, options = {}) {
  return Binding.validateTemporalEvidence(claim, records, evidence, options,
    { temporalMeaningRetained, operationGroups: OP_GROUPS, legacySupportedByRecord: legacySupportedByApprovedRecord,
      phaseSubject, simpleTemporalPhase, seasonProfile });
}

function approvedRecords(current = {}) {
  const rows = [];
  for (const topic of current.discussion || []) {
    for (const kind of ['points', 'decisions', 'openQuestions']) for (const record of topic[kind] || []) {
      const value = typeof record === 'string' ? record : record.text;
      if (value) rows.push({ id: `D${rows.length + 1}`, type: 'discussion', text: String(value), evidenceIds: record.evidenceIds || [] });
    }
  }
  for (const action of current.actions || []) if (action.action) {
    rows.push({ id: `A${rows.length + 1}`, type: 'action', text: `${action.action} Owners: ${(action.owners || []).join(', ') || 'Not stated'}. Timing: ${formatTimingLabel(action.timing)}.`, evidenceIds: action.evidenceIds || [] });
  }
  return rows;
}

function summaryTemporalCheckItems(values = {}, current = {}, _sourceUnits = [], options = {}) {
  const authority = approvedRecords(current);
  const words = value => new Set(V.contentTokens(value));
  const items = [];
  const append = (row, locator, reviewerAuthored = false) => {
    const target = words(row);
    const ranked = authority.map((record, index) => ({ record, index,
      score: [...words(record.text)].filter(word => target.has(word)).length }))
      .sort((a, b) => b.score - a.score || a.index - b.index);
    if (!temporalClaim(row) && !ranked.some(item => item.score >= 2
      && (temporalProfile(item.record.text).hedged || temporalProfile(item.record.text).dependencies.length)
      && sameTemporalWork(row, item.record.text))) return;
    const retained = ranked.filter(item => item.score > 0).slice(0, 12).sort((a, b) => a.index - b.index).map(item => item.record);
    items.push({ id: `st${items.length + 1}`, ...locator, row,
      reviewerAuthored,
      passage: retained.map(record => `[${record.id}] ${record.text}`).join('\n'),
      authorityRecords: retained, evidenceIds: [...new Set(retained.flatMap(record => record.evidenceIds))] });
  };
  const sentences = String(values.executiveSummary || '').split(/(?<=[.!?])\s+/).filter(Boolean);
  sentences.forEach((row, sentenceIndex) => append(row, { field: 'executiveSummary', sentenceIndex },
    options.reviewerAuthored === true || options.summaryReviewerAuthored === true));
  (values.meetingObjectives || []).forEach((objective, objectiveIndex) => {
    const row = typeof objective === 'string' ? objective : objective?.text;
    if (row) append(row, { field: 'meetingObjectives', objectiveIndex,
      objectiveId: typeof objective === 'object' ? objective.id : '' },
    objective?.reviewerAuthored === true || objective?.confirmedTopic === true);
  });
  return items;
}

function summaryTemporalCheckPrompt(items = []) {
  return [
    'DISCUSSION_CRITIC_EVIDENCE_FIDELITY',
    'Check temporal fidelity of each proposed summary/objective sentence against its CONFIRMED MINUTES passage. This passage of approved discussion/actions is the sole factual authority; do not introduce a fact from elsewhere in the transcript.',
    'Check that dates, periods, clock times, durations, recurrence, historical/future status, dependencies, task assignments, preferences, fallbacks and certainty remain attached to the same work. An approximate, preferred or possible timing must not become a guarantee. Do not calculate dates or infer a timezone.',
    'Return exactly one result for every supplied id, with no repeated or additional ids. Use supported only when the whole temporal claim is supported. Use corrected for one safe source-supported replacement, or uncertain when it cannot be established.',
    'For supported, copy evidenceQuote identifying the temporal claim and its work from the confirmed passage. For corrected, copy problemQuote from the proposed sentence and evidenceQuote from the confirmed passage, each one contiguous quote of at most 25 words, then provide correctedText. Prefer a complete approved sentence when a paraphrase could lose timing or qualifications. For uncertain provide reason and the problemQuote; leave evidenceQuote empty when there is nothing supporting it.',
    Binding.temporalEvidencePromptInstructions(),
    'Return only {"schemaVersion":1,"results":[{"id":"","verdict":"supported|corrected|uncertain","problemQuote":"","evidenceQuote":"","correctedText":"","reason":""}]}, adding the complete temporalEvidence object when applicable. Omit temporalEvidence for uncertain results.',
    `ITEMS:\n${JSON.stringify(items.map(item => ({ id: item.id, row: item.row, passage: item.passage,
      sourceRecords: item.authorityRecords.map(record => ({ id: record.id, type: record.type, text: record.text })) })))}`
  ].join('\n\n');
}

function applySummaryTemporalCheckResults(values = {}, items = [], results = [], options = {}) {
  const indexed = indexReviewResults(items, results, ['supported', 'corrected', 'uncertain']);
  const sentences = String(values.executiveSummary || '').split(/(?<=[.!?])\s+/).filter(Boolean);
  const objectives = [...(values.meetingObjectives || [])];
  let changedSummary = false;
  const flags = [], rejected = [];
  for (const item of items) {
    let state = indexed.states.get(item.id), row = indexed.byId.get(item.id);
    const current = item.field === 'executiveSummary' ? sentences[item.sentenceIndex]
      : typeof objectives[item.objectiveIndex] === 'string' ? objectives[item.objectiveIndex] : objectives[item.objectiveIndex]?.text;
    if (current !== item.row) state = { id: item.id, status: 'stale', reason: 'stale_summary_snapshot' };
    else if (row?.verdict === 'supported') {
      const evidence = V.decisionQuoteValidation(row.evidenceQuote, item.passage, 25);
      const carrying = evidence.valid ? item.authorityRecords.filter(record => canon(record.text).includes(canon(row.evidenceQuote))) : [];
      const structured = Object.prototype.hasOwnProperty.call(row, 'temporalEvidence');
      const binding = structured ? validateTemporalEvidence(item.row, carrying, row.temporalEvidence,
        { ...options, contextRecords: item.authorityRecords }) : null;
      state = (structured ? binding.supported : carrying.some(record => supportedByApprovedRecord(item.row, record, options)))
        ? { id: item.id, status: 'supported', reason: '', ...(binding ? { temporalBinding: binding.binding } : {}) }
        : { id: item.id, status: 'rejected', reason: binding?.reason || 'summary_temporal_binding_not_proved' };
    }
    else if (row?.verdict === 'uncertain') state = { id: item.id, status: 'uncertain', reason: String(row.reason || 'temporal_claim_uncertain').slice(0, 300) };
    else if (row?.verdict === 'corrected') {
      const problem = V.decisionQuoteValidation(row.problemQuote, item.row, 25);
      const evidence = V.decisionQuoteValidation(row.evidenceQuote, item.passage, 25);
      const corrected = V.text(row.correctedText, 1500);
      const carrying = item.authorityRecords.filter(record => canon(record.text).includes(canon(row.evidenceQuote)));
      const structured = Object.prototype.hasOwnProperty.call(row, 'temporalEvidence');
      const binding = structured ? validateTemporalEvidence(corrected, carrying, row.temporalEvidence,
        { ...options, contextRecords: item.authorityRecords }) : null;
      if (!problem.valid || !evidence.valid || !corrected || !carrying.length
        // A real quote for a different approved task cannot replace this
        // sentence. Temporal correction must retain its existing work and
        // assignment as well as prove the replacement timing independently.
        || !sameTemporalWork(item.row, corrected)
        || !(structured ? binding.supported : carrying.some(record => supportedByApprovedRecord(corrected, record, options)))) {
        state = { id: item.id, status: 'rejected', reason: binding?.reason || 'invalid_or_unsupported_temporal_correction' };
      } else if (item.reviewerAuthored) {
        state = { id: item.id, status: 'uncertain', reason: 'reviewer_temporal_wording_preserved' };
      } else {
        if (item.field === 'executiveSummary') { sentences[item.sentenceIndex] = corrected; changedSummary = true; }
        else objectives[item.objectiveIndex] = typeof objectives[item.objectiveIndex] === 'string' ? corrected : { ...objectives[item.objectiveIndex], text: corrected };
        state = { id: item.id, status: 'corrected', reason: '', ...(binding ? { temporalBinding: binding.binding } : {}) };
      }
    } else if (state.status === 'pending') state = { id: item.id, status: 'rejected', reason: 'empty_confirmed_context' };
    indexed.states.set(item.id, state);
    if (!['supported', 'corrected'].includes(state.status)) {
      rejected.push({ id: item.id, reason: state.reason });
      const flag = V.normaliseFlag({ kind: 'timing',
        message: `Cannot verify the timing in the ${item.field === 'executiveSummary' ? 'executive summary' : 'meeting objective'}: "${V.text(item.row, 260)}". ${state.reason.replace(/_/g, ' ')}. Confirm it against the approved minutes.`, evidenceIds: item.evidenceIds }, flags.length);
      flags.push({ ...flag, temporalField: item.field });
    }
  }
  return { values: { ...values, executiveSummary: changedSummary ? sentences.join(' ') : values.executiveSummary, meetingObjectives: objectives }, flags,
    accounting: finishReviewAccounting(indexed), rejected };
}

module.exports = { summaryTemporalCheckItems, summaryTemporalCheckPrompt, applySummaryTemporalCheckResults, temporalClaim,
  temporalMeaningRetained, supportedByApprovedRecord, independentSourcePhaseClips, validateTemporalEvidence,
  temporalEvidencePromptInstructions: Binding.temporalEvidencePromptInstructions };
