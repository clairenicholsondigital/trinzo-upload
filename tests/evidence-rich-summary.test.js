'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runCanonicalLiveStage } = require('../utils/canonicalMinutes/liveStages');

// The two real meetings this work was built against, asserted at the deterministic layer
// (no LLM - these shapes must hold even when the polish is down, because the polish's
// failure path falls back to exactly these fields).
//
// The user's calibration: "not aiming for 1000% - human in the loop - but it needs to
// give the human SOMETHING with relatively little effort." Before this work, both
// meetings' summary screens collapsed to the bare title.

const FIXTURE = (name) => path.resolve(__dirname, `../scripts/meeting-minutes-final-golden/${name}/transcript.txt`);

test('the M204 rehearsal, correctly typed, gets a rehearsal summary with specific objectives', { timeout: 300000 }, () => {
  const text = fs.readFileSync(FIXTURE('028_real_m204_webinar_rehearsal_transcript'), 'utf8');
  const title = 'Client M204 Larkfield MK Thursday Session';
  const summary = runCanonicalLiveStage(text, {
    stage: 'summary',
    fileName: 'm204.txt',
    confirmed: { details: { meetingTitle: title, meetingType: 'Webinar rehearsal' } }
  }).screens.summary;

  assert.match(summary.meetingPurpose, /rehears/i, 'the purpose says what kind of meeting this was');
  assert.notEqual(summary.meetingPurpose.replace(/\.$/, ''), title, 'the purpose is not the title');
  assert.notEqual(String(summary.executiveSummary).replace(/\.$/, ''), title, 'the summary is not the title');
  assert.ok(String(summary.executiveSummary).split(/(?<=[.!?])\s+/).length >= 3, 'the summary has at least three sentences');

  const objectives = summary.objectives || [];
  assert.ok(objectives.length >= 6, `at least six objectives (${objectives.length})`);
  // At least some objectives are the meeting's own actions, not verb+bucket templates.
  const specific = objectives.filter((objective) => !/^(?:Review|Confirm|Agree|Identify)\s[a-z]/.test(objective));
  assert.ok(specific.length >= 3, `specific action-derived objectives present: ${JSON.stringify(objectives)}`);

  // The leakage fence: opening concepts cross-profile must never open another domain's
  // canned prose with them. A webinar rehearsal once got "The goods-flow evidence
  // covered supplier origin, fiscal clearance..." in its summary this way.
  const blob = JSON.stringify(summary);
  for (const foreign of ['goods-flow', 'fiscal clearance', 'importer', 'EUDAMED', 'warehousing']) {
    assert.ok(!blob.toLowerCase().includes(foreign.toLowerCase()), `foreign domain text "${foreign}" must not appear`);
  }
});

test('the T761 weekly, confirmed as a general review, still surfaces its real workstreams', { timeout: 300000 }, () => {
  // The user's own steer: they would pick "Project review (general)" for this meeting -
  // "it covers too many parallel workstreams" - and the richness must not depend on that
  // choice. The dropdown names the meeting's shape; the evidence names its subjects.
  const text = fs.readFileSync(FIXTURE('029_real_t761_tech_file_weekly_transcript'), 'utf8');
  const summary = runCanonicalLiveStage(text, {
    stage: 'summary',
    fileName: 't761.txt',
    confirmed: { details: { meetingTitle: 'Eakin software and technical file weekly check-in', meetingType: 'Project review' } }
  }).screens.summary;

  const objectives = summary.objectives || [];
  assert.ok(objectives.length >= 6, `at least six objectives (${objectives.length})`);

  const everything = [String(summary.executiveSummary), ...objectives].join(' ').toLowerCase();
  const workstreams = ['alarm', 'language', 'electrical', 'change control', 'debug', 'risk'];
  const named = workstreams.filter((workstream) => everything.includes(workstream));
  assert.ok(named.length >= 4, `the summary names the real workstreams (found ${JSON.stringify(named)})`);

  // Junk that once appeared here: an importer-obligations concept made of meeting
  // furniture ("follow-up", "schedule") manufactured a workstream out of politeness.
  assert.ok(!everything.includes('process discovery and working sessions'), 'furniture concepts do not travel');
});

test('each derived objective carries its own evidence, not a pooled set', { timeout: 300000 }, () => {
  // Citation-checked composition downstream is meaningless if every objective cites the
  // same generic ids. The pooled-ids shortcut read as citation and meant nothing.
  const text = fs.readFileSync(FIXTURE('029_real_t761_tech_file_weekly_transcript'), 'utf8');
  const summary = runCanonicalLiveStage(text, {
    stage: 'summary',
    fileName: 't761.txt',
    confirmed: { details: { meetingTitle: 'Eakin software and technical file weekly check-in', meetingType: 'Project review' } }
  }).screens.summary;
  const sets = (summary.initialUnderstanding?.diagnostics ? [] : [])
    .concat((summary.initialUnderstanding && summary.initialUnderstanding.meetingPurpose ? [] : []));
  const objectives = summary.initialUnderstanding && Array.isArray(summary.initialUnderstanding.primaryWorkstreams)
    ? summary.initialUnderstanding.primaryWorkstreams
    : [];
  assert.ok(objectives.length >= 4, 'workstreams are exposed for the evidence pack');
  const distinct = new Set(objectives.map((item) => JSON.stringify((item.evidenceIds || []).slice().sort())));
  assert.ok(distinct.size >= 3, 'workstreams cite distinct evidence sets');
});
