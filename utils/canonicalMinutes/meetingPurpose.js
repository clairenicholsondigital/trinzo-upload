'use strict';

const { clean } = require('./evidence');

const MEETING_PROFILES = [
  {
    id: 'webinar_rehearsal',
    matches: (type) => /\bwebinar\b.*\b(?:rehearsal|practice|run[ -]?through)\b|\b(?:rehearsal|practice|run[ -]?through)\b.*\bwebinar\b/i.test(type),
    dimensions: [
      {
        id: 'format',
        topic: 'Webinar content and running order',
        objective: 'Review the webinar content, running order and delivery readiness',
        summary: 'The rehearsal reviewed the webinar content, running order and delivery readiness.',
        evidence: /\b(?:slides?|deck|content|opening|introduction|case study|closing|run(?:ning)? order|section)\b/i
      },
      {
        id: 'roles',
        topic: 'Presenter roles and handovers',
        objective: 'Confirm presenter roles, handovers and support responsibilities',
        summary: 'Presenter roles, handovers and support responsibilities were rehearsed.',
        evidence: /\b(?:hand(?:ing)? over|handover|pass back|host|present(?:er|ing)?|facilitat(?:e|or)|safety net|support)\b/i
      },
      {
        id: 'audience',
        topic: 'Audience questions and closing',
        objective: 'Rehearse audience questions, chat handling and the webinar close',
        summary: 'The team tested audience questions, chat handling and the webinar close.',
        evidence: /\b(?:questions?|q\s*&\s*a|chat|audience|attendee|speech bubble|qr code|call to action)\b/i
      },
      {
        id: 'timing',
        topic: 'Timing and session flow',
        objective: 'Validate the timing of the presentation, transitions and question period',
        summary: 'Presentation timing, transitions and the question period were checked against the planned session length.',
        evidence: /\b(?:timings?|minutes?|seconds?|hard stop|overrun|dead air|gap|pace|clock)\b/i
      },
      {
        id: 'technical',
        topic: 'Technical setup and contingencies',
        objective: 'Check screen sharing, recording and technical contingency arrangements',
        summary: 'Screen sharing, recording and technical contingency arrangements were checked.',
        evidence: /\b(?:screen shar(?:e|ing)|record(?:ing)?|red dot|connection|wi-?fi|broadband|animation|microphone|camera|technical|tech)\b/i
      }
    ]
  }
];

function meetingProfile(meeting = {}) {
  const type = clean(meeting.type || meeting.meetingType);
  return MEETING_PROFILES.find((profile) => profile.matches(type)) || null;
}

function evidenceForDimension(evidence, dimension) {
  return evidence.events.filter((event) => dimension.evidence.test(clean(event.text)));
}

function purposePlan(meeting, evidence) {
  const profile = meetingProfile(meeting);
  if (!profile) return null;
  const dimensions = profile.dimensions.map((dimension) => {
    const events = evidenceForDimension(evidence, dimension);
    return events.length ? { ...dimension, evidenceIds: events.map((event) => event.id) } : null;
  }).filter(Boolean);
  if (!dimensions.length) return null;
  return {
    profileId: profile.id,
    objectives: dimensions.slice(0, 4).map((item) => ({ text: item.objective, evidenceIds: item.evidenceIds, purposeDimension: item.id })),
    topics: dimensions.map((item) => ({ text: item.topic, evidenceIds: item.evidenceIds, purposeDimension: item.id })),
    discussion: dimensions.map((item) => ({
      topic: item.topic,
      points: [{ text: item.summary, evidenceIds: item.evidenceIds.slice(0, 8) }],
      evidenceIds: item.evidenceIds,
      topicId: `purpose_${profile.id}_${item.id}`,
      purposeDimension: item.id
    }))
  };
}

module.exports = { meetingProfile, purposePlan };
