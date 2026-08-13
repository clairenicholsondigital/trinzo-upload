'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const mammoth = require('mammoth');
const { purposePlan } = require('../utils/canonicalMinutes/meetingPurpose');
const { capitaliseInitial } = require('../utils/canonicalMinutes/liveStages');
const { prepareEvidence } = require('../utils/canonicalMinutes/evidence');

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

test('technical-file title activates grounded workstream framing', () => {
  const plan = purposePlan({ type: 'Project review', title: 'Client T733 Tech File Review Weekly' }, evidence([
    'The focus remains on risk management and cybersecurity mitigations.',
    'The alarm software change and additional languages need clinical review.',
    'Electrical compliance testing will be completed in house before the MDR submission.'
  ]));
  assert.equal(plan.profileId, 'technical_file_review');
  assert.deepEqual(plan.topics.map((item) => item.text), [
    'Risk management and cybersecurity',
    'Software changes and review',
    'Electrical compliance testing',
    'Submission timing and dependencies'
  ]);
  assert.ok(plan.discussion.every((card) => card.points[0].evidenceIds.length));
  assert.equal(plan.riskEvidence.test('Risk and electrical compliance remain the main focus.'), false);
  assert.equal(plan.riskEvidence.test('One outstanding issue remains around the mute-button behaviour.'), true);
});

test('real T733 transcript is covered by the staged technical-file purpose policy', async () => {
  const documentPath = path.join(__dirname, '..', 'scripts', 'meeting-minutes-core-golden', 'human_benchmarks', 'T733_eakin_tech_file', 'transcript.docx');
  const buffer = await fs.readFile(documentPath);
  const extracted = await mammoth.extractRawText({ buffer });
  const evidence = prepareEvidence(extracted.value);
  const plan = purposePlan({ type: 'Project review', title: 'Client Eakin T733 Tech File Review Weekly' }, evidence);
  assert.equal(plan.profileId, 'technical_file_review');
  assert.ok(plan.topics.length >= 5);
  assert.ok(plan.topics.some((item) => item.text === 'Risk management and cybersecurity'));
  assert.ok(plan.topics.some((item) => item.text === 'Electrical compliance testing'));
  assert.ok(plan.objectives.every((item) => !/^(?:Review )?(?:That|And|No|Emma\b)/i.test(item.text)));
});
