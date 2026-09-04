'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { meetingProfile } = require('../utils/canonicalMinutes/meetingPurpose');

// What each meeting-type option resolves to.
//
// meetingProfile is first-wins over an ordered list and matches on type and title
// together, so adding a broad profile can silently shadow a specific one - a meeting
// titled "...Importer Obligations review plan" would stop resolving to the importer
// profile and start resolving to whatever generic matcher was placed above it. That is
// invisible in the output: the minutes stay plausible and quietly lose their ordering.
//
// So the mapping is pinned. Changing it means changing this table deliberately.

const DROPDOWN_OPTIONS = [
  'Project review',
  'Audit kick-off / planning',
  'Client update',
  'Decision meeting',
  'Workshop',
  'Webinar rehearsal',
  'Case study interview',
  'Technical file review',
  'Software weekly review',
  'Software and technical-file weekly review',
  'Process / pipeline planning',
  'Importer obligations review',
  'Internal follow-up'
];

const EXPECTED = {
  'Project review': 'project_review',
  'Audit kick-off / planning': 'audit_planning',
  'Client update': 'client_update',
  'Decision meeting': 'decision_meeting',
  'Workshop': 'workshop',
  'Webinar rehearsal': 'webinar_rehearsal',
  'Case study interview': 'case_study_interview',
  'Technical file review': 'technical_file_review',
  'Software weekly review': 'technical_file_review',
  'Software and technical-file weekly review': 'technical_file_review',
  'Process / pipeline planning': 'process_pipeline_planning',
  'Importer obligations review': 'importer_obligations_review',
  'Internal follow-up': 'internal_follow_up'
};

test('the meeting type dropdown offers exactly the options this table pins', () => {
  // A new option added to the page without a profile is how four of them came to select
  // nothing at all, including the one that is pre-selected.
  const page = fs.readFileSync(path.resolve(__dirname, '../views/staged-meeting-minutes.html'), 'utf8');
  const select = page.slice(page.indexOf('<select id="meetingType">'));
  const markup = select.slice(0, select.indexOf('</select>'));
  const options = [...markup.matchAll(/<option(?:\s+value="([^"]*)")?\s*>([^<]*)</g)]
    .map((match) => (match[1] || match[2]).trim())
    .map((value) => value.replace(/\s*\(general\)$/, ''));
  assert.deepEqual(options, DROPDOWN_OPTIONS);
});

test('every meeting type resolves to a profile', () => {
  const unmatched = DROPDOWN_OPTIONS.filter((type) => !meetingProfile({ type, title: '' }));
  assert.deepEqual(unmatched, [], 'a type that matches no profile contributes nothing: no ordering, no objective verb');
});

test('each meeting type resolves to the profile it is meant to', () => {
  for (const type of DROPDOWN_OPTIONS) {
    assert.equal(meetingProfile({ type, title: '' })?.id, EXPECTED[type], type);
  }
});

test('recurring software titles are classified separately from technical-file reviews', () => {
  const { inferStagedMeetingType } = require('../routes/api').stagedEvaluation;
  assert.equal(inferStagedMeetingType('', 'Client_T761_Eakin_SW_Weekly_Checkin.docx'), 'Software weekly review');
  assert.equal(inferStagedMeetingType('', 'Eakin software and technical file weekly check-in.docx'), 'Software and technical-file weekly review');
  assert.equal(inferStagedMeetingType('', 'Eakin T733 technical file weekly review.docx'), 'Technical file review');
});

test('a specific title still wins over a generic type', () => {
  // The case the ordering exists to protect: the reviewer leaves the pre-selected
  // "Project review" and the title names what the meeting actually was.
  const cases = [
    ['Project review', 'Client DITA T819 Importer Obligations review plan', 'importer_obligations_review'],
    ['Project review', 'Client T761 Eakin SW Weekly Checkin', 'technical_file_review'],
    ['Project review', 'Abbott audit kick-off', 'audit_planning'],
    ['Project review', 'Webinar rehearsal run-through', 'webinar_rehearsal'],
    ['Project review', 'Weekly status', 'project_review']
  ];
  for (const [type, title, expected] of cases) {
    assert.equal(meetingProfile({ type, title })?.id, expected, `${type} / ${title}`);
  }
});

test('a profile contributes ordering and an intent verb, never prose', () => {
  // The structural guarantee against one meeting's content reaching another's minutes.
  // A profile that carried text could leak it; one that carries only patterns cannot.
  const source = fs.readFileSync(path.resolve(__dirname, '../utils/canonicalMinutes/meetingPurpose.js'), 'utf8');
  const profiles = source.slice(source.indexOf('const MEETING_PROFILES'), source.indexOf('const OBJECTIVE_INTENTS'));
  assert.doesNotMatch(profiles, /purpose\s*:/, 'a profile must not carry purpose prose');
  assert.doesNotMatch(profiles, /objectives\s*:\s*\[/, 'a profile must not carry canned objectives');

  for (const type of DROPDOWN_OPTIONS) {
    const profile = meetingProfile({ type, title: '' });
    assert.ok(Array.isArray(profile.topicHints) && profile.topicHints.length, `${type} has no topic hints`);
    for (const hint of profile.topicHints) {
      assert.ok(['Confirm', 'Review', 'Agree', 'Identify'].includes(hint.intent), `${type}: ${hint.intent}`);
      assert.ok(hint.pattern instanceof RegExp, `${type}: hint must be a pattern`);
    }
  }
});

test('a body-derived meeting type must carry an evidence trail that clears the gates', { timeout: 120000 }, async () => {
  // The original invariant here was "the type must not change when the body is taken
  // away", written after seven meetings were told they were webinar rehearsals because
  // somebody said "run through". That fix was right about the seven and wrong about a
  // real rehearsal titled "Client M204 Larkfield MK Thursday Session", whose content is
  // unmistakable and whose title says nothing.
  //
  // The invariant is reworded, not weakened: a type may now differ from the title-only
  // answer ONLY when the evidence-gated suggestion accepted it - at least three of the
  // type's topic areas each recurring in two or more turns, twice the support of any
  // other type. A single phrase still cannot move the type, because a single phrase
  // cannot support three independent patterns.
  const { listTranscripts, readTranscript } = require('../scripts/evidence_parse_baseline');
  const { extractStagedDetailsFromTranscript, inferStagedMeetingType } = require('../routes/api').stagedEvaluation;
  const { MIN_SUPPORTED_HINTS, MIN_EVENTS_PER_HINT, DOMINANCE_RATIO } = require('../utils/canonicalMinutes/meetingTypeSuggestion');

  const unfenced = [];
  for (const file of listTranscripts()) {
    const text = String(await readTranscript(file));
    const fileName = path.basename(file);
    const details = extractStagedDetailsFromTranscript(text, fileName).screens?.details || {};
    const titleOnly = inferStagedMeetingType('', fileName, details.meetingTitle || '');
    if (details.meetingType === titleOnly) continue;
    const trail = details.meetingTypeSuggestion;
    const gated = trail && trail.accepted
      && trail.supportedHints.length >= MIN_SUPPORTED_HINTS
      && trail.supportedHints.every((hint) => hint.eventCount >= MIN_EVENTS_PER_HINT)
      && trail.marginRatio >= DOMINANCE_RATIO;
    if (!gated) unfenced.push(`${file}: "${details.meetingTitle}" -> ${details.meetingType} with no qualifying evidence trail`);
  }
  assert.deepEqual(unfenced, [], `body-derived types without a qualifying evidence trail:\n${unfenced.join('\n')}`);
});

test('the seven formerly misclassified meetings still resolve from their titles alone', { timeout: 120000 }, async () => {
  // These fixtures are the reason the title-only rule existed. Each was told it was a
  // webinar rehearsal or workshop off one stray phrase in the body. They are pinned by
  // name: whatever the suggestion machinery becomes, it must stay quiet on every one.
  const { extractStagedDetailsFromTranscript } = require('../routes/api').stagedEvaluation;
  const mammoth = require('mammoth');
  const cases = [
    ['scripts/transcript-tests/001_status_review/transcript.txt', 'Project review'],
    ['scripts/transcript-tests/002_validation_decision/transcript.txt', 'Project review'],
    ['scripts/transcript-tests/008_event_planning/transcript.txt', 'Project review'],
    ['scripts/transcript-tests/049_low_substance_noise/transcript.txt', 'Project review'],
    ['scripts/transcript-tests/050_partnership_mou_enablement/transcript.txt', 'Project review'],
    ['scripts/transcript-tests/064_analytics_review/transcript.txt', 'Project review'],
    ['scripts/meeting-minutes-core-golden/cases/02_scattered_actions/transcript.docx', 'Project review']
  ];
  for (const [file, expected] of cases) {
    const full = path.resolve(__dirname, '..', file);
    const text = file.endsWith('.docx') ? (await mammoth.extractRawText({ path: full })).value : fs.readFileSync(full, 'utf8');
    const details = extractStagedDetailsFromTranscript(String(text), path.basename(file)).screens?.details || {};
    assert.equal(details.meetingType, expected, `${file} must not be reclassified from its body`);
    assert.ok(!details.meetingTypeSuggestion?.accepted, `${file}: the suggestion must not fire`);
  }
});
