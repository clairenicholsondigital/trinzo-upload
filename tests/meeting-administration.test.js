'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isRoutineMeetingAdministrationText,
  removeRoutineMeetingAdministrationSentences
} = require('../utils/meetingAdministration');
const { groundedExecutiveSummary } = require('../utils/meetingMinutesAgentV2');
const { summaryScreen, discussionScreen } = require('../utils/canonicalMinutes/liveStages');

test('waiting briefly for an attendee is routine meeting administration', () => {
  assert.equal(isRoutineMeetingAdministrationText('Meeting started with a brief wait for Dermot.'), true);
  assert.equal(isRoutineMeetingAdministrationText('The group waited 30 seconds before continuing the meeting.'), true);
  assert.equal(isRoutineMeetingAdministrationText('Give her another minute before we resume the call.'), true);
});

test('operational dependencies and presentation cues are not meeting administration', () => {
  assert.equal(isRoutineMeetingAdministrationText('The release must wait for supplier approval before deployment.'), false);
  assert.equal(isRoutineMeetingAdministrationText("Tom should wait for Priya's handover cue before starting."), false);
  assert.equal(isRoutineMeetingAdministrationText('Testing paused for 30 seconds before restarting the device.'), false);
});

test('administrative opening sentences are removed without losing substantive summary content', () => {
  assert.equal(
    removeRoutineMeetingAdministrationSentences(
      'Meeting started with a brief wait for Dermot. The team approved the revised supplier plan.'
    ),
    'The team approved the revised supplier plan.'
  );
});

test('grounded summaries do not publish attendee-wait administration', () => {
  const discussion = [{
    topic: 'Supplier plan',
    points: [
      { text: 'Meeting started with a brief wait for Dermot.' },
      { text: 'The team approved the revised supplier plan.' }
    ],
    decisions: []
  }];
  assert.equal(
    groundedExecutiveSummary(
      'Meeting started with a brief wait for Dermot. The team approved the revised supplier plan.',
      discussion,
      []
    ),
    'The team approved the revised supplier plan.'
  );
});

test('canonical summary and discussion screens exclude generated meeting administration', () => {
  const summary = summaryScreen({
    objectives: [
      { text: 'Wait briefly for an attendee to join.' },
      { text: 'Review the revised supplier plan.' }
    ],
    topics: [{ text: 'Supplier plan', evidenceIds: ['evt_2'] }],
    initialUnderstanding: {
      meetingPurpose: { text: 'Meeting started with a brief wait for an attendee.' },
      meetingSpine: [
        { text: 'Meeting started with a brief wait for Dermot.', composed: true },
        { text: 'The revised supplier plan was approved.', composed: true }
      ],
      primaryWorkstreams: [], actionSignals: []
    },
    meeting: { participants: ['Amina Khan', 'Dermot Byrne'], type: 'Project review' }
  });
  assert.doesNotMatch(JSON.stringify(summary), /brief wait/i);
  assert.match(summary.executiveSummary, /supplier plan was approved/i);

  const discussion = discussionScreen({
    discussion: [{
      topic: 'Supplier plan', evidenceIds: ['evt_1', 'evt_2'],
      points: [
        { text: 'Meeting started with a brief wait for Dermot.', evidenceIds: ['evt_1'] },
        { text: 'The revised supplier plan was approved.', evidenceIds: ['evt_2'] }
      ]
    }],
    decisions: [], risks: [], summaryTopicsAuthoritative: false
  });
  assert.deepEqual(discussion[0].points, ['The revised supplier plan was approved.']);
  assert.deepEqual(discussion[0].pointRefs, [{ evidenceIds: ['evt_2'] }]);
});
