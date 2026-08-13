'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { purposePlan } = require('../utils/canonicalMinutes/meetingPurpose');
const { capitaliseInitial } = require('../utils/canonicalMinutes/liveStages');

function evidence(lines) {
  return { events: lines.map((text, index) => ({ id: `evt_${index}`, text })) };
}

test('webinar rehearsal purpose produces grounded editorial objectives and topics', () => {
  const plan = purposePlan({ type: 'Webinar rehearsal' }, evidence([
    'We will rehearse the opening slides and then hand over to Sam.',
    'Leave twenty minutes for audience questions in the chat.',
    'Check screen sharing and start the recording.'
  ]));
  assert.equal(plan.profileId, 'webinar_rehearsal');
  assert.ok(plan.objectives.some((item) => /content, running order and delivery readiness/i.test(item.text)));
  assert.ok(plan.topics.some((item) => item.text === 'Presenter roles and handovers'));
  assert.ok(plan.discussion.every((card) => card.evidenceIds.length > 0 && card.points[0].evidenceIds.length > 0));
});

test('meeting-type policy abstains for unrelated meeting types', () => {
  assert.equal(purposePlan({ type: 'Project review' }, evidence(['Review the release plan.'])), null);
});

test('webinar dimensions are omitted when the transcript has no supporting evidence', () => {
  const plan = purposePlan({ type: 'Webinar rehearsal' }, evidence(['We reviewed the slide deck and opening section.']));
  assert.deepEqual(plan.topics.map((item) => item.text), ['Webinar content and running order']);
});

test('case-study title activates a grounded interview plan even with the default meeting type', () => {
  const plan = purposePlan({ type: 'Project review', title: 'QIP Assessment Tool Case Study Nov 2024' }, evidence([
    'It is a combination of an assessment tool and an improvement plan for a site.',
    'We run interviews, review procedures and show the final radar chart.',
    'Take a look at the assessment reports and send me the draft to review.'
  ]));
  assert.equal(plan.profileId, 'case_study_interview');
  assert.equal(plan.objectives[0].text, 'Explain the purpose, scope and structure of QIP Assessment Tool');
  assert.ok(plan.topics.some((item) => item.text === 'Source material and follow-up'));
  assert.ok(plan.discussion.every((card) => card.evidenceIds.length));
  assert.equal(plan.riskEvidence.test('The former client had validation problems.'), false);
  assert.equal(plan.riskEvidence.test('A missing testimonial could delay the case study.'), true);
});

test('action grammar capitalises the first letter without changing the remaining wording', () => {
  assert.equal(capitaliseInitial('before the live session'), 'Before the live session');
  assert.equal(capitaliseInitial('09:30 thursday'), '09:30 Thursday');
  assert.equal(capitaliseInitial('build the QR code slide'), 'Build the QR code slide');
});
