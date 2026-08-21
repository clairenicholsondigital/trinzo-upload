'use strict';

// How much of a transcript the parser actually read.
//
// Coverage is the share of content characters — the source minus speaker
// headers — that survive into evidence turns. It answers a question the
// existing health check cannot: a transcript can produce plenty of well-formed
// turns and still have lost half the meeting, because everything the parser
// failed to recognise simply is not there to be counted.
//
// This runs on the same cut points parseTurns() uses, so it reports on the
// parser that actually ran rather than on a second copy of its rules.

const { clean, findSpeakerCuts, findUnreadRegions, buildSpeakerHeaderPattern } = require('./evidence');

// Below this share of content read, a reviewer is being shown minutes drawn
// from a minority of the meeting and should be told before they start editing.
const PARTIAL_COVERAGE_THRESHOLD = 0.85;

// The ratio alone is not a usable test. Measured across the 115 committed
// fixtures it puts 55 of them under the threshold, but 43 of those lose fewer
// than 50 characters — a title line or an attendee list — so a warning driven
// by the ratio would fire on roughly half of all meetings and be ignored by
// the third one. Requiring a real quantity of lost text as well takes it to
// exactly one fixture: the undiarised recording that genuinely fails.
const MIN_UNREAD_CHARS = 200;

// A long meeting can lose a great deal and still clear the ratio: 2,000 unread
// characters is several minutes of discussion whatever share of the file it
// represents. No committed fixture trips this arm, so it costs nothing today
// and covers the case the ratio cannot see.
const LARGE_UNREAD_CHARS = 2000;

function isPartiallyParsed(measurement) {
  if (!measurement) return false;
  const unread = measurement.unreadChars || 0;
  return (measurement.coverage < PARTIAL_COVERAGE_THRESHOLD && unread >= MIN_UNREAD_CHARS) || unread >= LARGE_UNREAD_CHARS;
}

const normalise = (value) => String(value || '').replace(/\s+/g, ' ').trim();

function summarise(text, limit = 120) {
  const value = normalise(text);
  return value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;
}

function describeRegions(regions) {
  return regions
    .map((region) => ({ kind: region.kind, chars: clean(region.text).length, speaker: region.speaker, sample: summarise(region.text) }))
    .sort((left, right) => right.chars - left.chars);
}

// Content is the meeting itself: the source minus every header the parser cut
// at — including handles it could not resolve to a name, since counting one as
// content would report a turn we read in full as partly missed — and minus the
// document labels the parser deliberately steps over ("Date:", "Attendees:"),
// which are metadata read by the details stage rather than discussion we lost.
function contentWithoutHeaders(source, cuts) {
  const segments = [];
  let position = 0;
  for (const cut of cuts) {
    segments.push(source.slice(position, cut.index));
    position = cut.index + cut.length;
  }
  segments.push(source.slice(position));
  return normalise(segments.map((segment) => segment.replace(buildSpeakerHeaderPattern(), ' ')).join(' '));
}

function measureParseCoverage(transcriptText, evidence) {
  const source = String(transcriptText || '').replace(/\r/g, '');
  const turns = (evidence && evidence.turns) || [];
  const cuts = findSpeakerCuts(source);
  const contentChars = contentWithoutHeaders(source, cuts).length;
  // Turns synthesised from a structured actions table are not present in the
  // prose and would inflate the figure.
  const parsedChars = normalise(turns.filter((turn) => !turn.structuredSource).map((turn) => turn.text).join(' ')).length;
  const coverage = contentChars ? Math.min(1, parsedChars / contentChars) : 1;
  const unattributedTurnCount = turns.filter((turn) => turn.attributionConfidence === 0).length;
  return {
    coverage: Number(coverage.toFixed(3)),
    contentChars,
    parsedChars,
    unreadChars: Math.max(0, contentChars - parsedChars),
    unattributedTurnCount,
    unreadRegions: describeRegions(findUnreadRegions(source))
  };
}

function describeUnreadRegion(region) {
  if (region.kind === 'no_speakers_recognised') return 'no speaker labels were recognised anywhere in the file';
  if (region.kind === 'before_first_speaker') return `${region.chars} characters before the first recognised speaker ("${region.sample}")`;
  return `a ${region.chars}-character passage from ${region.speaker} that was too long to keep ("${region.sample}")`;
}

module.exports = { measureParseCoverage, describeUnreadRegion, isPartiallyParsed, PARTIAL_COVERAGE_THRESHOLD, MIN_UNREAD_CHARS, LARGE_UNREAD_CHARS };
