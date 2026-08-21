'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareEvidence } = require('../utils/canonicalMinutes/evidence');
const { measureParseCoverage } = require('../utils/canonicalMinutes/parseCoverage');
const { assessStagedTranscriptHealth, stagedTranscriptHealthFlag } = require('../utils/stagedTranscriptHealth');

const measure = (text) => measureParseCoverage(text, prepareEvidence(text));

const WELL_FORMED = [
  'Alex Morgan 00:12',
  'Right, so we are agreed on the phased regional launch for the billing portal.',
  'Priya Raman 00:40',
  'Yes, and I will keep the legacy portal read-only for four weeks after launch.',
  'Alex Morgan 01:05',
  'Good, that gives customer success enough cover for the transition period.'
].join('\n');

// The opening two thirds of this meeting were exported without speaker labels.
const UNLABELLED_OPENING = `${[
  'So the way I see it we need to close out the billing portal decision this week,',
  'because support are already carrying the load and the legacy system is still running',
  'in parallel which is costing us. We talked about the phased option last time and',
  'nobody objected, and the regional rollout gives us a way to watch the error rates',
  'before we commit everyone. There is also the question of the read-only window.'
].join(' ')}\n${WELL_FORMED}`;

test('a fully read transcript reports complete coverage and nothing unread', () => {
  const coverage = measure(WELL_FORMED);
  assert.equal(coverage.coverage, 1);
  assert.equal(coverage.unreadChars, 0);
  assert.deepEqual(coverage.unreadRegions, []);
});

test('coverage counts what the parser read, not what it produced', () => {
  const coverage = measure(UNLABELLED_OPENING);
  assert.ok(coverage.coverage < 0.85, `expected partial coverage, got ${coverage.coverage}`);
  assert.ok(coverage.unreadChars > 300);
  assert.equal(coverage.unreadRegions[0].kind, 'before_first_speaker');
  assert.match(coverage.unreadRegions[0].sample, /^So the way I see it/);
});

test('a monologue dropped for length is named rather than silently lost', () => {
  const text = `Claire Nicholson 00:12\n${'The board update covers revenue, risk and hiring. '.repeat(130)}\nMark Kelleher 40:00\nNoted, thanks.`;
  const coverage = measure(text);
  const dropped = coverage.unreadRegions.find((region) => region.kind === 'turn_too_long');
  assert.ok(dropped, 'an over-long turn must be reported, not just discarded');
  assert.equal(dropped.speaker, 'Claire Nicholson');
  assert.ok(dropped.chars > 5000);
});

test('a transcript with no recognisable speakers says so explicitly', () => {
  const coverage = measure('A continuous block of speech with no diarisation of any kind anywhere in it.');
  assert.equal(coverage.coverage, 0);
  assert.equal(coverage.unreadRegions[0].kind, 'no_speakers_recognised');
});

test('unattributed turns are counted separately from unread text', () => {
  const coverage = measure(`${WELL_FORMED}\n00:14:00 tom_oneill: The regulator deadline is the fifteenth and slipping it triggers a penalty.`);
  assert.equal(coverage.unattributedTurnCount, 1);
  assert.equal(coverage.coverage, 1, 'an unattributed turn is read in full; only its speaker is unknown');
});

test('partial coverage is a visible, non-blocking warning naming what was missed', () => {
  const health = assessStagedTranscriptHealth(UNLABELLED_OPENING);
  assert.ok(health.reasons.includes('transcript_partially_parsed'));
  const flag = stagedTranscriptHealthFlag(health);
  assert.equal(flag.type, 'transcript_partially_parsed');
  assert.equal(flag.blocking, false);
  assert.match(flag.message, /Only \d+% of this transcript was read/);
  assert.match(flag.message, /before the first recognised speaker/);
});

// The ratio on its own puts 55 of the 115 committed fixtures under the
// threshold, 43 of them losing under 50 characters. A warning that fires on
// half of all meetings teaches reviewers to dismiss it, including the time it
// is right, so a trivial loss must stay silent however bad the ratio looks.
test('a short transcript missing only a title line stays silent', () => {
  const text = `Northbridge release planning\nAlex Morgan 00:12\nWe agreed the phased regional launch.`;
  const health = assessStagedTranscriptHealth(text);
  assert.ok(health.parseCoverage.coverage < 0.85, 'this transcript does look bad by ratio alone');
  assert.ok(health.parseCoverage.unreadChars < 200);
  assert.ok(!health.reasons.includes('transcript_partially_parsed'),
    'a lost title line is not a partly read meeting');
});

test('a large absolute loss warns even when the ratio looks acceptable', () => {
  // A long meeting that reads cleanly apart from an unlabelled opening: the
  // share lost is small, the quantity lost is several minutes of discussion.
  const opening = 'An unlabelled opening passage that the parser cannot attribute to anyone at all. '.repeat(30);
  const body = Array.from({ length: 250 }, (unused, index) =>
    `Alex Morgan ${String(index % 60).padStart(2, '0')}:12\nWe reviewed the rollout plan and agreed the regional launch sequence for region ${index}.`).join('\n');
  const text = `${opening}\n${body}`;
  const coverage = measure(text);
  assert.ok(coverage.coverage > 0.85, `expected an acceptable-looking ratio, got ${coverage.coverage}`);
  assert.ok(coverage.unreadChars >= 2000);
  assert.ok(assessStagedTranscriptHealth(text).reasons.includes('transcript_partially_parsed'),
    'several minutes of unread discussion matters however small a share of the file it is');
});

test('full coverage stays silent about coverage', () => {
  const health = assessStagedTranscriptHealth(WELL_FORMED);
  assert.ok(!health.reasons.includes('transcript_partially_parsed'));
  assert.equal(health.parseCoverage.coverage, 1);
});

test('an unreadable transcript still blocks, and now says what it could not read', () => {
  const health = assessStagedTranscriptHealth('A continuous block of speech with no diarisation of any kind anywhere in it.');
  assert.equal(health.state, 'structurally_unreliable');
  const flag = stagedTranscriptHealthFlag(health);
  assert.equal(flag.blocking, true, 'the existing blocking behaviour is unchanged');
  assert.match(flag.message, /no speaker labels were recognised/);
});

test('mixed speaker formats warn about ownership without blocking', () => {
  const health = assessStagedTranscriptHealth(`${WELL_FORMED}\n00:14:00 tom_oneill: The regulator deadline is the fifteenth and slipping it triggers a penalty for us.`);
  const flag = stagedTranscriptHealthFlag(health);
  assert.equal(flag.blocking, false);
  assert.match(flag.message, /no owner set/);
});
