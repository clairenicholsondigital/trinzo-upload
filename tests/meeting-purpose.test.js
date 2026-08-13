'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { purposePlan } = require('../utils/canonicalMinutes/meetingPurpose');

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
