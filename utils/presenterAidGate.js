'use strict';

// A rehearsal or run-through spends most of its time on how the session will be
// delivered, and the extraction reads some of that delivery advice as work.
// Measured over 23 runs of two transcripts, the most persistent surplus row on
// a rehearsal transcript was "Find and use the small clock at the top right
// while presenting" (5 runs in 11), alongside "Keep your phone next to you to
// monitor messages".
//
// What makes those different from real actions is not that they describe
// behaviour during the session: "Send Tom a private five-minute timing warning"
// and "Keep the personal introduction to about thirty seconds" are both
// behaviour during the session, and both belong in the minutes. The difference
// is that a presenter aid is only about having or looking at something of the
// presenter's own while they speak. Nothing is produced, nobody receives
// anything, and there is no limit anyone could check afterwards.
//
// The gate is therefore deliberately narrow, and runs only on rehearsal-type
// meetings.

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

// The stored meeting type for a rehearsal; the screens relabel it as
// "Presentation rehearsal" but the stored value is what reaches this code.
const REHEARSAL_MEETING_TYPE = /\b(?:webinar|presentation)\s+rehearsal\b|\b(?:rehearsal|dry run|run-through|run through)\b/i;

function isRehearsalMeetingType(meetingType) {
  return REHEARSAL_MEETING_TYPE.test(clean(meetingType));
}

// Something the presenter keeps to hand or glances at: their own device, a
// clock on the screen, notes, a second machine.
const AID_OBJECT = /\b(?:clock|timer|stopwatch|watch|phone|mobile|handset|laptop|machine|screen|monitor|display|tab|window|notes?|script|cue cards?|deck)\b/i;

// Wording that says the aid is merely available or being looked at, rather
// than produced, sent or changed.
const AVAILABILITY = /\b(?:next to|beside|to hand|near(?:by|\s+(?:you|them|him|her))|on hand|within reach|in front of|open and ready|open on|up on|top right|top left|on (?:the )?screen|visible|in view|handy)\b/i;

// The action's leading verb. Having, watching or positioning something is an
// aid; producing, sending or changing something is work.
const AID_VERB = /^(?:please\s+)?(?:find|use|keep|have|hold|place|put|position|bring|set up|watch|monitor|glance at|look at|check|refer to)\b/i;

// Anything that makes it real work, whoever it is addressed to: a recipient, a
// deliverable, or a deadline the row carries.
const REAL_WORK = /\b(?:send|share|email|circulate|forward|deliver|submit|upload|publish|print|order|book|write|draft|prepare|produce|create|build|restore|update|amend|revise|rebuild|re-?share|record|start recording|confirm with|report to|ask|tell|warn|remind|notify|message|chase|arrange|schedule|rehearse|practise|practice|test|review|approve|sign off)\b/i;

// A checkable constraint someone agreed to, such as "keep the introduction to
// thirty seconds". These read like advice but are real commitments, and the
// answer keys expect them, so they must survive the gate.
const AGREED_LIMIT = /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|forty-five|sixty|ninety)\s*(?:-|\s)?(?:second|sec|minute|min|hour)s?\b|\b(?:under|within|no (?:more|longer) than|at most|limit(?:ed)? to)\b/i;

function hasTiming(action = {}) {
  const kind = clean(action?.timing?.kind);
  if (kind && kind !== 'not_stated') return true;
  return Boolean(clean(action?.timing?.exactDate));
}

// True when the row's whole job is having or looking at something while
// presenting.
function isPresenterAidAction(action = {}) {
  const text = clean(action.action || action.text);
  if (!text) return false;
  // A commitment with a date or deadline is scheduled work, not an aid.
  if (hasTiming(action)) return false;
  // An agreed, checkable limit is a real commitment even though it reads as
  // delivery advice.
  if (AGREED_LIMIT.test(text)) return false;
  if (REAL_WORK.test(text)) return false;
  if (!AID_VERB.test(text)) return false;
  if (!AID_OBJECT.test(text)) return false;
  // Require the availability sense, so "Use the shorter opening" or "Check the
  // figures" are untouched: those name no aid being kept to hand.
  return AVAILABILITY.test(text);
}

// Returns { actions, dropped } without mutating the input. Only ever applied to
// a rehearsal-type meeting, and only to the finished list.
function applyPresenterAidGate(actions = [], meetingType = '') {
  const rows = Array.isArray(actions) ? actions : [];
  if (!isRehearsalMeetingType(meetingType)) return { actions: rows, dropped: [] };
  const dropped = [];
  const kept = rows.filter((action) => {
    if (!isPresenterAidAction(action)) return true;
    dropped.push({ id: action?.id || '', action: clean(action?.action), reason: 'presenter aid, no deliverable' });
    return false;
  });
  return { actions: kept, dropped };
}

module.exports = {
  isRehearsalMeetingType,
  isPresenterAidAction,
  applyPresenterAidGate,
  REHEARSAL_MEETING_TYPE
};
