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
