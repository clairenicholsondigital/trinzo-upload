'use strict';

const { profileHintCatalogue } = require('./meetingPurpose');

// What kind of meeting the discussion says this is, offered as a suggestion.
//
// The type used to be inferred from the transcript body by single keywords, and seven
// meetings were told they were webinar rehearsals because somebody said "run through".
// The fix - read the title only - was right about those seven and wrong about the real
// rehearsal titled "Client M204 Larkfield MK Thursday Session", whose content is
// unmistakably a rehearsal and whose title says nothing. One keyword is not evidence;
// twenty-six turns about handovers, timings and screen-sharing are.
//
// So this classifies from recurrence and dominance, using the profiles' own hint
// patterns, and it only ever *suggests*: the dropdown arrives pre-selected with a visible
// note, and the reviewer's choice wins unconditionally. It is consulted only when the
// title names nothing (the title-only inference returned the default), so a title that
// names the meeting still decides it outright.
//
// Three gates, all required, each set from measurement:
//
//   breadth   >=3 distinct hints, each with >=2 supporting events. A single phrase cannot
//             support three independent patterns - this is the structural heir of the
//             false-positive fix. All five formerly misclassified fixtures score 0
//             supported webinar hints.
//   dominance total matched events >= 2x the runner-up: the winner must double the
//             field. Measured: the M204 rehearsal clears it at 3.89x. The T761 weekly -
//             a meeting whose reviewer explicitly preferred the general "Project review"
//             over the technically-arguable "Technical file review" - scores 1.5x, and a
//             margin a real contested meeting sits on is the wrong place for a boundary,
//             so the gate sits above it and the machine stays quiet there. The real
//             rehearsal fixture 003 ranks workshop over webinar at 1.44x - also quiet,
//             also correct, and its title names the webinar anyway so this path is never
//             consulted for it.
//   floor     >=12 matched events, so a near-empty transcript cannot clear the ratio on
//             noise.

const MIN_SUPPORTED_HINTS = 3;
const MIN_EVENTS_PER_HINT = 2;
const DOMINANCE_RATIO = 2;
const MIN_TOTAL_EVENTS = 12;

// The dropdown labels for the profile ids this can suggest. Kept here rather than in
// meetingPurpose.js so the grep-guarded profile slice stays untouched; pinned against the
// dropdown by tests/meeting-type-suggestion.test.js.
const PROFILE_LABEL = {
  webinar_rehearsal: 'Webinar rehearsal',
  case_study_interview: 'Case study interview',
  technical_file_review: 'Technical file review',
  importer_obligations_review: 'Importer obligations review',
  internal_follow_up: 'Internal follow-up',
  audit_planning: 'Audit kick-off / planning',
  workshop: 'Workshop',
  decision_meeting: 'Decision meeting',
  client_update: 'Client update'
  // project_review is deliberately absent: it is the default this replaces, so
  // "suggesting" it would be noise.
};

// Only types represented by the reviewed 13-transcript scorecard may be offered to a
// reviewer. Profiles outside that set still participate in scoring as competing
// explanations; removing them from the ranking made unrelated meetings look dominant.
const DROPDOWN_LABEL_BY_PROFILE = Object.fromEntries(Object.entries(PROFILE_LABEL).filter(([, label]) => ![
  'Case study interview', 'Client update', 'Workshop'
].includes(label)));

function scoreProfiles(events) {
  const scores = [];
  for (const profile of profileHintCatalogue()) {
    if (!PROFILE_LABEL[profile.id]) continue;
    const matchedEventIds = new Set();
    let supportedHints = 0;
    const supported = [];
    for (const hint of profile.topicHints) {
      const matching = events.filter((event) => hint.pattern.test(String(event && event.text || '')));
      if (matching.length >= MIN_EVENTS_PER_HINT) {
        supportedHints += 1;
        supported.push({ pattern: String(hint.pattern), eventCount: matching.length });
      }
      // Dedupe by event id so one chatty turn matching several patterns cannot count
      // itself once per pattern.
      for (const event of matching) matchedEventIds.add(event.id);
    }
    scores.push({ profileId: profile.id, supportedHints, supported, totalMatchedEvents: matchedEventIds.size });
  }
  return scores.sort((left, right) => right.totalMatchedEvents - left.totalMatchedEvents);
}

// The suggestion, with its evidence trail, or null. `accepted` says whether it clears the
// gates; a caller may still want the trail of a near-miss for telemetry.
function suggestMeetingTypeFromEvidence(evidence) {
  const events = (evidence && evidence.events) || [];
  if (!events.length) return null;
  const ranked = scoreProfiles(events);
  const [best, runnerUp] = ranked;
  if (!best || !best.totalMatchedEvents) return null;
  const marginRatio = runnerUp && runnerUp.totalMatchedEvents
    ? best.totalMatchedEvents / runnerUp.totalMatchedEvents
    : Infinity;
  const accepted = best.supportedHints >= MIN_SUPPORTED_HINTS
    && best.totalMatchedEvents >= MIN_TOTAL_EVENTS
    && marginRatio >= DOMINANCE_RATIO;
  return {
    type: PROFILE_LABEL[best.profileId],
    profileId: best.profileId,
    supportedHints: best.supported,
    totalMatchedEvents: best.totalMatchedEvents,
    runnerUp: runnerUp ? { profileId: runnerUp.profileId, totalMatchedEvents: runnerUp.totalMatchedEvents } : null,
    marginRatio: Number(marginRatio.toFixed(2)),
    accepted: accepted && Boolean(DROPDOWN_LABEL_BY_PROFILE[best.profileId])
  };
}

module.exports = {
  suggestMeetingTypeFromEvidence,
  DROPDOWN_LABEL_BY_PROFILE,
  MIN_SUPPORTED_HINTS,
  MIN_EVENTS_PER_HINT,
  DOMINANCE_RATIO,
  MIN_TOTAL_EVENTS
};
