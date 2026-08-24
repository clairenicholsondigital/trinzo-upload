'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runCanonicalLiveStage } = require('../utils/canonicalMinutes/liveStages');
const { isRawTranscriptDiscussionPoint } = require('../utils/stagedEditorial');

// The executive summary is written, so it is built from sentences we wrote.
//
// It used to be composed as purpose-plus-spine, and the spine is one representative turn
// per workstream with its leading "yeah" trimmed and a full stop added. That is the right
// raw material for an index into the evidence - it is what the polish reads to find
// detail - and it is not writing. So whenever the polish was rejected or unavailable, the
// reviewer opened the summary screen and read the meeting back at themselves:
//
//   "Client M204 Larkfield MK Thursday Session. Tom, you're presenting so you should have
//    the green thing at the bottom. The plan is I open it, I do the housekeeping bit,
//    welcome everyone in, tell them mics are off, tell them to drop questions in the chat
//    and I'll bring them in at the end."
//
//   "Residents Association Parking. Cost, and the visitor access thing. Three cars and a
//    caravan."
//
// Filtering that sentence by sentence is a losing game, and it was tried: first-person
// voice catches the first example and not the second, because "Three cars and a caravan"
// is not first person, not a speech opener, not malformed - and still not an executive
// summary. Every filter added is another rule shaped like one meeting.
//
// These tests run the deterministic path with no LLM at all, which is the worst case a
// reviewer can be shown, across meetings deliberately unlike each other: a client webinar
// rehearsal, a regulatory technical-file review, an allotment committee, a pantomime
// society and a meeting that reaches no decision at all.

const FIXTURES = [
  ['a client webinar rehearsal', 'scripts/meeting-minutes-final-golden/028_real_m204_webinar_rehearsal_transcript'],
  ['a technical file weekly', 'scripts/meeting-minutes-final-golden/029_real_t761_tech_file_weekly_transcript'],
  ['an audit kick-off', 'scripts/meeting-minutes-final-golden/027_real_abbott_audit_kickoff_transcript'],
  ['an allotment committee', 'scripts/transcript-tests/074_allotment_society_committee'],
  ['a pantomime society', 'scripts/transcript-tests/075_pantomime_society_planning'],
  ['a brewery production meeting', 'scripts/transcript-tests/076_brewery_production_numbers'],
  ['a meeting that decides nothing', 'scripts/transcript-tests/078_parking_no_decision_reached']
];

function summaryFor(fixture) {
  const text = fs.readFileSync(path.resolve(__dirname, '..', fixture, 'transcript.txt'), 'utf8');
  return runCanonicalLiveStage(text, { stage: 'summary', fileName: path.basename(fixture), confirmed: {} }).screens.summary || {};
}

function sentencesOf(value) {
  return String(value || '').split(/(?<=[.!?])\s+/).map((item) => item.trim()).filter(Boolean);
}

for (const [description, fixture] of FIXTURES) {
  test(`${description}: no sentence of the summary is lifted from the transcript`, { timeout: 300000 }, () => {
    const text = fs.readFileSync(path.resolve(__dirname, '..', fixture, 'transcript.txt'), 'utf8');
    const transcript = text.toLowerCase().replace(/\s+/g, ' ');
    const summary = summaryFor(fixture);
    // One deliberate exception, and only one. Where somebody said in the meeting why they
    // were meeting, buildPurpose quotes them and marks the purpose 'stated_in_meeting'
    // with a replacement policy of 'never' - the meeting's own answer, which no polish is
    // allowed to overwrite. That sentence opens the summary, so it is skipped here rather
    // than quietly breaking a decision made elsewhere on purpose.
    const stated = summary.initialUnderstanding?.meetingPurpose?.purposeSource === 'stated_in_meeting'
      ? String(summary.meetingPurpose || '')
      : '';
    for (const sentence of sentencesOf(summary.executiveSummary)) {
      if (stated && stated.includes(sentence)) continue;
      // Compared without the trimming the spine applies, so a quoted turn is recognised
      // however it was tidied on the way through.
      const body = sentence.toLowerCase().replace(/\s+/g, ' ').replace(/[.?!]+$/, '');
      if (body.split(' ').length < 5) continue;
      assert.ok(!transcript.includes(body), `this sentence is a quotation, not a summary: ${JSON.stringify(sentence)}`);
    }
  });

  test(`${description}: the summary reads as minutes, not as speech`, { timeout: 300000 }, () => {
    const summary = summaryFor(fixture);
    for (const sentence of sentencesOf(summary.executiveSummary)) {
      assert.ok(!isRawTranscriptDiscussionPoint(sentence), `unconverted speech in the summary: ${JSON.stringify(sentence)}`);
    }
  });

  test(`${description}: the summary says more than the title`, { timeout: 300000 }, () => {
    // The floor exists because a summary of purpose-and-nothing tells the reviewer
    // nothing the field two rows above does not. Dropping quoted turns costs the informal
    // meetings their only spine sentences, so there has to be something composed behind
    // them.
    const summary = summaryFor(fixture);
    assert.ok(sentencesOf(summary.executiveSummary).length >= 2,
      `the summary is one sentence long: ${JSON.stringify(summary.executiveSummary)}`);
  });
}

test('an allotment committee is not given a medical-device workstream', { timeout: 300000 }, () => {
  // A cross-profile concept is admitted on three matching events, which a shed with a
  // solar alarm clears without difficulty: this meeting - about a water butt, plot fees
  // and some marrows - was headed "Alarm-code and clinical confirmation", and that label
  // then wrote the purpose, an objective and a sentence of the summary. A borrowed
  // concept now has to be carried by more than one of its own words.
  const summary = summaryFor('scripts/transcript-tests/074_allotment_society_committee');
  const everything = JSON.stringify(summary).toLowerCase();
  for (const foreign of ['clinical', 'iec 60601', 'eudamed', 'importer', 'declarations of conformity']) {
    assert.ok(!everything.includes(foreign), `foreign domain vocabulary "${foreign}" reached an allotment meeting`);
  }
});

test('a chat fragment does not become a workstream, and therefore not an objective', { timeout: 300000 }, () => {
  // "Lovely, that's one sorted" and "Sylvia, Nadeem, Fiona, Tom" were workstream labels,
  // which made them objectives the reviewer was asked to keep: "Review lovely, that's one
  // sorted." One bad label is the same bad line on four screens.
  for (const fixture of ['scripts/transcript-tests/074_allotment_society_committee', 'scripts/transcript-tests/075_pantomime_society_planning']) {
    const summary = summaryFor(fixture);
    const labels = (summary.initialUnderstanding?.primaryWorkstreams || []).map((item) => String(item.label));
    for (const label of [...labels, ...(summary.objectives || [])]) {
      assert.ok(!/\b(?:that['’]s|it['’]s|lovely|goodness)\b/i.test(label), `a chat fragment is being used as a subject: ${JSON.stringify(label)}`);
    }
  }
});
