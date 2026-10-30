'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitiseDetails } = require('../utils/meetingMinutesDraftContext');

test('legacy attendee lists classify known Trinzo people as internal and retain an editable external label', () => {
  assert.deepEqual(sanitiseDetails({
    allAttendees: ['Jacqui Fox', 'Stuart Smith', 'Niamh Lynch'], clientAttendeeLabel: 'External'
  }), {
    meetingTitle: '', meetingDate: '', meetingLocation: 'Microsoft Teams', meetingType: '', clientAttendeeLabel: 'External',
    internalAttendees: ['Jacqui Fox', 'Stuart Smith'], clientAttendees: ['Niamh Lynch'],
    allAttendees: ['Jacqui Fox', 'Stuart Smith', 'Niamh Lynch']
  });
});
