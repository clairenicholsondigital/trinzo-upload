'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { purposePlan, meetingProfile, objectiveIntentForText, topicOrderRank } = require('../utils/canonicalMinutes/meetingPurpose');
const { capitaliseInitial, lowerInitialUnlessInitialism } = require('../utils/canonicalMinutes/liveStages');

// The meeting-purpose module is a THIN CLASSIFIER. It maps a confirmed meeting
// type/title to a profile id plus ordering/intent hints, and carries no canned
// prose and no transcript content. These tests assert that contract and, above
// all, that a profile can never contribute body text (the anti-leakage
// guarantee: all Discussion/Summary text is derived from the transcript itself,
// elsewhere in the pipeline).

const VALID_INTENTS = new Set(['Confirm', 'Review', 'Agree', 'Identify']);

test('purposePlan returns only a profile id and structural hints — never prose', () => {
  const plan = purposePlan({ type: 'Webinar rehearsal', title: 'Product webinar' });
  assert.equal(plan.profileId, 'webinar_rehearsal');
  // The only keys are the classifier id and the hint list.
  assert.deepEqual(Object.keys(plan).sort(), ['profileId', 'topicHints']);
  // Every hint is a { intent, pattern } pair — no free-text topic/objective/summary.
  for (const hint of plan.topicHints) {
    assert.deepEqual(Object.keys(hint).sort(), ['intent', 'pattern']);
    assert.ok(VALID_INTENTS.has(hint.intent));
    assert.ok(hint.pattern instanceof RegExp);
  }
});

test('no profile carries any canned topic/objective/summary string', () => {
  // Guard against a regression that reintroduces authored prose into the module,
  // by walking every profile the classifier can return.
  const types = [
    'Webinar rehearsal', 'QIP Assessment Tool Case Study', 'Software Weekly Review',
    'Importer Obligations Review', 'Internal Follow-up From Client Call', 'Audit Kick Off'
  ];
  for (const type of types) {
    const plan = purposePlan({ type, title: type });
    if (!plan) continue;
    for (const hint of plan.topicHints) {
      // A hint must be a matcher, not a sentence: intent is a single verb, the
      // pattern is a RegExp. Neither can render into the minutes.
      assert.equal(typeof hint.intent, 'string');
      assert.ok(hint.intent.split(/\s+/).length === 1);
    }
  }
});

test('meeting-type classification is driven by type/title only', () => {
  assert.equal(meetingProfile({ type: 'Webinar rehearsal' })?.id, 'webinar_rehearsal');
  assert.equal(meetingProfile({ type: 'Project review', title: 'QIP Assessment Tool Case Study Nov 2024' })?.id, 'case_study_interview');
  assert.equal(meetingProfile({ type: 'Project review', title: 'Client T733 Tech File Review Weekly' })?.id, 'technical_file_review');
  assert.equal(meetingProfile({ type: 'Project review', title: 'Importer Obligations Review Plan' })?.id, 'importer_obligations_review');
  assert.equal(meetingProfile({ type: 'Project review', title: 'Internal Follow-up and Review From Client Call' })?.id, 'internal_follow_up');
  assert.equal(meetingProfile({ type: 'Project review', title: 'Client Audit Kick Off' })?.id, 'audit_planning');
});

test('meeting-type policy abstains for unrelated meeting types', () => {
  assert.equal(purposePlan({ type: 'Project review' }), null);
  assert.equal(purposePlan({ type: 'Standup' }), null);
});

test('objective intent is drawn from the first matching hint, defaulting to Review', () => {
  const hints = purposePlan({ type: 'Audit Kick Off' }).topicHints;
  assert.equal(objectiveIntentForText(hints, 'Confirming the audit scope and applicable standards'), 'Confirm');
  assert.equal(objectiveIntentForText(hints, 'Agreeing key dates and preparation work'), 'Agree');
  assert.equal(objectiveIntentForText(hints, 'Software, cybersecurity and risk analysis focus'), 'Identify');
  // Unmatched text falls back to a neutral Review verb, never to canned prose.
  assert.equal(objectiveIntentForText(hints, 'A topic the profile has no hint for'), 'Review');
  assert.equal(objectiveIntentForText([], 'Anything at all'), 'Review');
});

test('topic order rank follows hint order and sends unmatched topics last', () => {
  const hints = purposePlan({ type: 'Audit Kick Off' }).topicHints;
  const scopeRank = topicOrderRank(hints, 'the audit scope and standards');
  const executionRank = topicOrderRank(hints, 'on-site gemba record sampling and findings tracker');
  assert.ok(scopeRank < executionRank);
  assert.equal(topicOrderRank(hints, 'a topic with no hint'), Number.MAX_SAFE_INTEGER);
});

test('a mis-classified audit still cannot inject foreign content — hints only reorder', () => {
  // If an audit kickoff were mislabelled as a technical-file review, the profile
  // it matches changes, but the plan still contains no text — so no alarm/mute/
  // notified-body prose can leak into the audit minutes. Only ordering differs.
  const mislabelled = purposePlan({ type: 'Software Weekly Review', title: 'Client Audit Kick Off' });
  assert.equal(mislabelled.profileId, 'technical_file_review');
  assert.ok(mislabelled.topicHints.every((hint) => hint.pattern instanceof RegExp && VALID_INTENTS.has(hint.intent)));
});

test('classification of the real golden transcripts resolves the expected frames', async () => {
  // Classification depends only on type/title, so these run without the model.
  const abbott = purposePlan({ type: 'Project review', title: 'Client Audit Kick Off' });
  assert.equal(abbott.profileId, 'audit_planning');
  const t761 = purposePlan({ type: 'Project review', title: 'Client T761 Eakin SW Weekly Checkin' });
  assert.equal(t761.profileId, 'technical_file_review');
  // Sanity: the fixtures still exist so downstream (model-run) evals can use them.
  await fs.access(path.join(__dirname, '..', 'scripts', 'meeting-minutes-final-golden', '027_real_abbott_audit_kickoff_transcript', 'transcript.txt'));
  await fs.access(path.join(__dirname, '..', 'scripts', 'meeting-minutes-final-golden', '025_real_t761_eakin_sw_weekly_transcript', 'transcript.txt'));
});

test('action grammar capitalises the first letter without changing the remaining wording', () => {
  assert.equal(capitaliseInitial('before the live session'), 'Before the live session');
  assert.equal(capitaliseInitial('09:30 thursday'), '09:30 Thursday');
  assert.equal(capitaliseInitial('build the QR code slide'), 'Build the QR code slide');
});

test('executive-summary grammar lowercases ordinary topics but preserves initialisms', () => {
  assert.equal(lowerInitialUnlessInitialism('Goods movement and distribution'), 'goods movement and distribution');
  assert.equal(lowerInitialUnlessInitialism('QMS and importer obligations'), 'QMS and importer obligations');
  assert.equal(lowerInitialUnlessInitialism('UDI, labelling and EUDAMED registration'), 'UDI, labelling and EUDAMED registration');
});
