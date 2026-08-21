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
// It reads as speech, so it is recovered rather than lost — see the Phase 3
// case at the foot of this file.
const UNLABELLED_OPENING = `${[
  'So the way I see it we need to close out the billing portal decision this week,',
  'because support are already carrying the load and the legacy system is still running',
  'in parallel which is costing us. We talked about the phased option last time and',
  'nobody objected, and the regional rollout gives us a way to watch the error rates',
  'before we commit everyone. There is also the question of the read-only window.'
].join(' ')}\n${WELL_FORMED}`;

// A structured minutes header ahead of the transcript proper: label-and-value
// lines with no sentence punctuation. This is genuinely unread, and rightly so —
// segmenting it into discussion would put "Meeting Title" into the minutes as
// something a person said.
const DOCUMENT_PREAMBLE = `${[
  'Meeting Overview',
  'Meeting Title T761 Eakin Healthcare Tech File SW review',
  'Meeting Date 15th June 2026',
  'Location MS Teams',
  'Objectives of the meeting',
  'Alarm changes',
  'Language changes',
  'SW versioning changes',
  'Electrical Safety testing - Timeframe Dependency',
  'Cybersecurity and Document Tracking',
  'Participants Trinzo:',
  'Jacqui Fox',
  'David Didsbury',
  'Client:',
  'Rebecca Ward'
].join('\n')}\n${WELL_FORMED}`;

test('a fully read transcript reports complete coverage and nothing unread', () => {
  const coverage = measure(WELL_FORMED);
  assert.equal(coverage.coverage, 1);
  assert.equal(coverage.unreadChars, 0);
  assert.deepEqual(coverage.unreadRegions, []);
});

test('coverage counts what the parser read, not what it produced', () => {
  const coverage = measure(DOCUMENT_PREAMBLE);
  assert.ok(coverage.coverage < 0.85, `expected partial coverage, got ${coverage.coverage}`);
  assert.ok(coverage.unreadChars >= 200);
  assert.equal(coverage.unreadRegions[0].kind, 'before_first_speaker');
  assert.match(coverage.unreadRegions[0].sample, /^Meeting Overview/);
});

// Phase 4: a turn past the length limit used to be discarded in full — one
// speaker's entire contribution gone, with nothing said about it.
test('a monologue too long for one turn is split rather than dropped', () => {
  const monologue = 'The board update covers revenue, risk and hiring. '.repeat(130);
  const text = `Claire Nicholson 00:12\n${monologue}\nMark Kelleher 40:00\nNoted, thanks.`;
  const evidence = prepareEvidence(text);
  const claire = evidence.turns.filter((turn) => turn.speaker === 'Claire Nicholson');

  assert.ok(claire.length > 1, 'the monologue is broken into several turns');
  assert.ok(claire.every((turn) => turn.text.length <= 5000), 'and each one fits the limit');
  const preserved = claire.reduce((total, turn) => total + turn.text.length, 0);
  assert.ok(preserved > monologue.length - 10, `expected the speech to survive, kept ${preserved} of ${monologue.length}`);
  assert.ok(claire.every((turn) => !('attributionConfidence' in turn)),
    'splitting a turn does not make its speaker any less certain');
});

test('splitting a monologue leaves nothing reported as unread', () => {
  const text = `Claire Nicholson 00:12\n${'The board update covers revenue, risk and hiring. '.repeat(130)}\nMark Kelleher 40:00\nNoted, thanks.`;
  const coverage = measure(text);
  assert.equal(coverage.coverage, 1);
  assert.deepEqual(coverage.unreadRegions, []);
});

test('a monologue with no sentence punctuation is still split, not lost', () => {
  const text = `Claire Nicholson 00:12\n${'revenue risk hiring headcount budget '.repeat(200)}`;
  const evidence = prepareEvidence(text);
  assert.ok(evidence.turns.length > 1);
  assert.ok(evidence.turns.every((turn) => turn.text.length <= 5000));
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
  const health = assessStagedTranscriptHealth(DOCUMENT_PREAMBLE);
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
  // A long meeting behind a long structured header: the header is a small
  // share of the file but a substantial quantity of text left unread.
  const preamble = Array.from({ length: 40 }, (unused, index) =>
    `Document Reference ${index} T761 Eakin Healthcare Tech File SW review record`).join('\n');
  const body = Array.from({ length: 300 }, (unused, index) =>
    `Alex Morgan ${String(index % 60).padStart(2, '0')}:12\nWe reviewed the rollout plan and agreed the regional launch sequence for region ${index}.`).join('\n');
  const text = `${preamble}\n${body}`;
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

// Phase 3: segmentation no longer depends on speaker attribution. Sentences
// exist in the text whether or not anyone is named, so a recording with no
// diarisation still yields discussion — attributed to nobody, which is honest.
test('unlabelled speech is recovered rather than left unread', () => {
  const coverage = measure(UNLABELLED_OPENING);
  assert.equal(coverage.coverage, 1, 'the unlabelled opening is read, not lost');
  assert.ok(coverage.unattributedTurnCount > 0, 'and it is marked as belonging to nobody');
});

test('document furniture is left unread rather than minuted as discussion', () => {
  const evidence = prepareEvidence(DOCUMENT_PREAMBLE);
  const recovered = evidence.turns.filter((turn) => turn.attributionConfidence === 0);
  assert.deepEqual(recovered, [], 'a label-and-value header is not speech');
  assert.ok(!evidence.events.some((event) => /Meeting Title|Meeting Date/i.test(event.text)),
    'form fields must never reach the minutes as things people said');
});

test('a wholly undiarised recording becomes usable instead of blocking', () => {
  const text = [
    'So the main thing from today is the billing portal rollout and how we phase it.',
    'We went through the regional sequence and everyone was comfortable starting in the north.',
    'The security audit found three critical findings that we must remediate before launch.',
    'I will own the remediation work and report back on Thursday with a full plan.',
    'The regulator deadline is the fifteenth and slipping it triggers a financial penalty.',
    'We also need to keep the legacy portal read-only for four weeks after the launch date.'
  ].join('\n');
  const evidence = prepareEvidence(text);
  assert.equal(evidence.turns.length, 6);
  assert.ok(evidence.turns.every((turn) => turn.speaker === 'Not stated' && turn.attributionConfidence === 0));
  assert.deepEqual(evidence.participants, [], 'nobody was named, so nobody is claimed');

  const health = assessStagedTranscriptHealth(text);
  assert.equal(health.state, 'sparse_but_usable');
  const flag = stagedTranscriptHealthFlag(health);
  assert.equal(flag.blocking, false, 'the meeting is readable; it just has no speakers');
  assert.match(flag.message, /no speaker labels/);
});

test('recovered speech still classifies as evidence', () => {
  const evidence = prepareEvidence([
    'So the main thing from today is the billing portal rollout and how we phase it.',
    'I will own the remediation work and report back on Thursday with a full plan.',
    'There is a risk that the electrical testing slips beyond the regulator deadline.'
  ].join('\n'));
  const roles = evidence.events.flatMap((event) => event.roles);
  assert.ok(roles.includes('action_candidate'), 'a commitment is still a commitment with no name on it');
  assert.ok(roles.includes('risk_candidate'), 'and a risk is still a risk');
});

test('recovery never engages on a transcript the parser already reads', () => {
  const evidence = prepareEvidence(WELL_FORMED);
  assert.ok(!evidence.turns.some((turn) => turn.attributionConfidence === 0));
  assert.deepEqual(evidence.participants, ['Alex Morgan', 'Priya Raman']);
});

test('a short unlabelled aside is too little to recover from', () => {
  const evidence = prepareEvidence(`Right, quick one before we start.\n${WELL_FORMED}`);
  assert.ok(!evidence.turns.some((turn) => turn.attributionConfidence === 0),
    'below the recovery floor the parser stays out of it');
});
