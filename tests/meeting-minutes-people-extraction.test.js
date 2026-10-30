'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const settingsStore = require('../utils/settingsStore');
const { DEFAULT_PEOPLE } = require('../utils/settingsDefaults');
const { sanitiseDetails } = require('../utils/meetingMinutesDraftContext');
const { extractStagedDetailsFromTranscript } = require('../routes/api').stagedEvaluation;

test.afterEach(() => settingsStore.resetToDefaults());

function withPeople(extra, { without = [] } = {}) {
  settingsStore.setSettings({
    people: [...DEFAULT_PEOPLE.filter((person) => !without.includes(person.name)), ...extra]
  });
}

test('Teams speakers are bucketed as internal from the transcript', () => {
  const transcript = [
    'Project review transcript',
    '',
    'Jacqui Fox   0:05',
    'Morning everyone.',
    '',
    'Advait Dharmadikari   0:12',
    'Morning, I have the test results.',
    '',
    'Sakki Arimotto   0:20',
    'I can share the schedule.',
    '',
    'Rebecca Gill   0:31',
    'Thanks, that works for us.'
  ].join('\n');
  const details = extractStagedDetailsFromTranscript(transcript, 'review.vtt').screens.details;
  const cleaned = sanitiseDetails(details);
  assert.ok(cleaned.internalAttendees.includes('Advait Dharmadhikari'), JSON.stringify(cleaned));
  assert.ok(cleaned.internalAttendees.includes('Saki Arimoto'), JSON.stringify(cleaned));
  assert.ok(!cleaned.clientAttendees.some((name) => /advait|saki/i.test(name)), JSON.stringify(cleaned));
});

test('Teams speakers are bucketed from the People list as it stands', () => {
  const transcript = [
    'Project review transcript', '',
    'Jacqui Fox   0:05', 'Morning everyone.', '',
    'Niamh Brennan   0:12', 'I have the test results.', '',
    'Rebecca Gill   0:31', 'Thanks, that works for us.'
  ].join('\n');
  const before = sanitiseDetails(extractStagedDetailsFromTranscript(transcript, 'review.vtt').screens.details);
  assert.ok(before.clientAttendees.includes('Niamh Brennan'), JSON.stringify(before));
  withPeople([{ name: 'Niamh Brennan', side: 'internal', spellings: [] }]);
  const after = sanitiseDetails(extractStagedDetailsFromTranscript(transcript, 'review.vtt').screens.details);
  assert.ok(after.internalAttendees.includes('Niamh Brennan'), JSON.stringify(after));
  assert.ok(!after.clientAttendees.includes('Niamh Brennan'), JSON.stringify(after));
});
