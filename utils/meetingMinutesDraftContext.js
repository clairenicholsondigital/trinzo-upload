'use strict';

const { text } = require('./meetingMinutesText');
const { alwaysInternalAttendeeName, knownPersonName, knownPerson } = require('./entityNormalization');
const TimingIntegrity = require('./meetingMinutesTiming');

// Internal people come from the Settings page People list.
const isKnownInternalAttendee = (name) => Boolean(alwaysInternalAttendeeName(name));

const DEFAULT_MEETING_LOCATION = 'Microsoft Teams';

function sanitiseDetails(candidate = {}) {
  // Other spellings of the people on the Settings page People list are shown
  // under their proper name.
  const names = (value) => [...new Set((Array.isArray(value) ? value : [])
    .map((name) => text(name, 180)).filter(Boolean)
    .map((name) => knownPersonName(name) || name))].slice(0, 100);
  const attendeeKey = (name) => text(name, 180).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[’‘`]/g, "'").toLowerCase();
  const suppliedAll = names(candidate.allAttendees || candidate.participants);
  let internalAttendees = names(candidate.internalAttendees);
  let clientAttendees = names(candidate.clientAttendees);
  // Calling someone a client asserts a relationship. With no participant
  // recognised as internal, nobody in the meeting is known to be hosting a
  // client (a team's own rehearsal, a committee, a supplier call), so the
  // attendees are listed as the meeting's own rather than defaulting to Client.
  // Where an internal participant is recognised, unrecognised people are still
  // placed on the client side, for the reviewer to move.
  if (!internalAttendees.length && !clientAttendees.length) {
    internalAttendees = suppliedAll.filter(isKnownInternalAttendee);
    clientAttendees = internalAttendees.length
      ? suppliedAll.filter((name) => !isKnownInternalAttendee(name))
      : [];
    if (!internalAttendees.length) internalAttendees = [...suppliedAll];
  } else {
    const assigned = new Set([...internalAttendees, ...clientAttendees].map(attendeeKey));
    const unassigned = suppliedAll.filter((name) => !assigned.has(attendeeKey(name)));
    if (internalAttendees.length) clientAttendees.push(...unassigned);
    else if (!clientAttendees.length) internalAttendees.push(...unassigned);
    else clientAttendees.push(...unassigned);
  }
  // AI-020: the directory overrides either explicit list on every save and
  // re-generation. Correct a listed person's side in Settings, not per meeting.
  const listedInternal = clientAttendees.filter(name => knownPerson(name)?.side === 'internal');
  const listedClient = internalAttendees.filter(name => knownPerson(name)?.side === 'client');
  internalAttendees = names([...internalAttendees.filter(name => knownPerson(name)?.side !== 'client'), ...listedInternal]);
  clientAttendees = names([...clientAttendees.filter(name => knownPerson(name)?.side !== 'internal'), ...listedClient]);
  const internalKeys = new Set(internalAttendees.map(attendeeKey));
  clientAttendees = clientAttendees.filter((name) => !internalKeys.has(attendeeKey(name)));
  const allAttendees = names([...suppliedAll, ...internalAttendees, ...clientAttendees]);
  return {
    meetingTitle: text(candidate.meetingTitle, 300),
    meetingDate: TimingIntegrity.isValidCalendarDate(text(candidate.meetingDate, 20)) ? text(candidate.meetingDate, 20) : '',
    meetingLocation: text(candidate.meetingLocation, 200) || DEFAULT_MEETING_LOCATION,
    meetingType: text(candidate.meetingType, 200),
    clientAttendeeLabel: candidate.clientAttendeeLabel === 'External' ? 'External' : 'Client',
    internalAttendees,
    clientAttendees,
    allAttendees
  };
}

const sanitiseMeetingAgentDetails = sanitiseDetails;

function meetingAgentTimingAnchor(draft = {}) {
  const context = draft.qualityState?.preparation?.dateContext;
  if (context && context.source !== 'reviewer' && (context.conflict || context.invalid?.length)) return '';
  return sanitiseMeetingAgentDetails(draft.details).meetingDate;
}

function meetingAgentPromptDetails(draft = {}) {
  const context = draft.qualityState?.preparation?.dateContext;
  const details = sanitiseMeetingAgentDetails(draft.details);
  const anchor = meetingAgentTimingAnchor(draft);
  return { ...details, meetingDate: anchor, timingContext: {
    meetingDate: anchor,
    ...(details.meetingDate !== anchor ? { unconfirmedSelectedDate: details.meetingDate } : {}),
    dateSource: context?.source || 'provided_meeting_details',
    requiresConfirmation: Boolean(context && context.source !== 'reviewer' && (context.conflict || context.invalid?.length))
  } };
}

module.exports = { sanitiseDetails, meetingAgentTimingAnchor, meetingAgentPromptDetails };
