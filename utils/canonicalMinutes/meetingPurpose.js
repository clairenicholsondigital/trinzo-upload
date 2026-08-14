'use strict';

const { clean } = require('./evidence');

// Thin meeting-type classifier.
//
// This module ONLY detects a meeting profile from the user-confirmed meeting
// type/title, and exposes ordered `topicHints` used to (a) order the
// transcript-derived topics and (b) choose an objective intent verb
// (Confirm / Review / Agree / Identify).
//
// It deliberately carries NO canned topic/objective/summary prose and NO
// client, product or attendee proper nouns. Every word of Discussion/Summary
// body text is derived from the CURRENT transcript's evidence elsewhere in the
// pipeline. Because a profile can never inject text, a mis-classification can
// only mis-order this transcript's own topics — it can never leak another
// meeting's content. That is the structural guarantee against
// transcript-to-transcript leakage.
//
// `topicHints` order encodes the preferred topic ordering; the first hint whose
// `pattern` matches a topic's representative text supplies that topic's
// objective intent verb.

const MEETING_PROFILES = [
  {
    id: 'webinar_rehearsal',
    matches: (type, title) => /\bwebinar\b.*\b(?:rehearsal|practice|run[ -]?through)\b|\b(?:rehearsal|practice|run[ -]?through)\b.*\bwebinar\b/i.test(`${type} ${title}`),
    topicHints: [
      { intent: 'Review', pattern: /\b(?:slides?|deck|content|opening|introduction|case study|closing|run(?:ning)? order|section)\b/i },
      { intent: 'Confirm', pattern: /\b(?:hand(?:ing)? over|handover|pass back|host|present(?:er|ing)?|facilitat(?:e|or)|safety net|support)\b/i },
      { intent: 'Review', pattern: /\b(?:questions?|q\s*&\s*a|chat|audience|attendee|speech bubble|qr code|call to action)\b/i },
      { intent: 'Review', pattern: /\b(?:timings?|minutes?|seconds?|hard stop|overrun|dead air|gap|pace|clock)\b/i },
      { intent: 'Review', pattern: /\b(?:screen shar(?:e|ing)|record(?:ing)?|red dot|connection|wi-?fi|broadband|animation|microphone|camera|technical|tech)\b/i }
    ]
  },
  {
    id: 'case_study_interview',
    matches: (type, title) => /\bcase study\b/i.test(`${type} ${title}`),
    topicHints: [
      { intent: 'Review', pattern: /\b(?:assessment tool|improvement plan|quality system|quality culture|maturity|operating)\b/i },
      { intent: 'Review', pattern: /\b(?:questions?|score|rating|self-assess|interviews?|audit|procedures?|data|manufacturing floor|gemba|radar chart)\b/i },
      { intent: 'Identify', pattern: /\b(?:benefits?|prioriti[sz]e|areas? to improve|gaps?|strategic plan|opportunities|raise the bar)\b/i },
      { intent: 'Identify', pattern: /\b(?:client|site|case|example|procedures?|culture|operators?|management)\b/i },
      { intent: 'Confirm', pattern: /\b(?:reports?|spreadsheets?|sharepoint|presentation|source material|testimonial|draft|review it|another call|follow[ -]?up)\b/i }
    ]
  },
  {
    id: 'technical_file_review',
    matches: (type, title) => /\b(?:tech(?:nical)? file|technical documentation)\b.*\b(?:review|weekly|status|check-?in)\b/i.test(`${type} ${title}`)
      || /\b(?:sw|software)\b.*\b(?:weekly|review|status|check[ -]?in)\b/i.test(`${type} ${title}`),
    topicHints: [
      { intent: 'Review', pattern: /\b(?:tech(?:nical)? file|tracker|status|progress|deliverables?|documents?|remediation|priorit(?:y|ies))\b/i },
      { intent: 'Confirm', pattern: /\b(?:risk management|risk matrix|hazards?|cybersecurity|usb port|fmea|mitigation)\b/i },
      { intent: 'Review', pattern: /\b(?:software|alarms?|mute button|languages?|translations?|code changes?|change request|memory capacity)\b/i },
      { intent: 'Confirm', pattern: /\b(?:electrical compliance|compliance testing|testing in house|test results?|electrical testing)\b/i },
      { intent: 'Confirm', pattern: /\b(?:submission|mdr|notified body|\bNB\b|review date)\b/i },
      { intent: 'Review', pattern: /\b(?:subcontractor|contract manufacturing|usability|formative stud|biocomp|biocompatibility|pms|post-market|process maps?)\b/i }
    ]
  },
  {
    id: 'importer_obligations_review',
    matches: (type, title) => /\b(?:importer obligations?|importer compliance|regulatory import)\b/i.test(`${type} ${title}`),
    topicHints: [
      { intent: 'Review', pattern: /\b(?:qms|quality management system|importer obligations?|compliance documents?|procedures?)\b/i },
      { intent: 'Review', pattern: /\b(?:goods movement|point of entry|fiscal clearance|airport|storage|warehouse|courier|dispatch|distribution|shipped)\b/i },
      { intent: 'Review', pattern: /\b(?:sales order|customer order|warehouse|picking|packing|packaging|barcode|scanner|shipping label|invoice)\b/i },
      { intent: 'Confirm', pattern: /\b(?:udi|eudamed|labelling|labeling|labels?|lot numbering|data matrix|upc|registration of devices)\b/i },
      { intent: 'Confirm', pattern: /\b(?:legal manufacturer|importer|authori[sz]ed rep(?:resentative)?|economic operator|verify the registration)\b/i },
      { intent: 'Review', pattern: /\b(?:declarations? of conformity|\bdoc['’]?s?\b|\bppe\b|risk rationale|languages?|translations?)\b/i },
      { intent: 'Confirm', pattern: /\b(?:hpra|audit|annual fees?|invoice fee|registration preparation|regulatory documentation)\b/i }
    ]
  },
  {
    id: 'internal_follow_up',
    matches: (type, title) => /\binternal\b.*\b(?:follow[ -]?up|review|debrief)\b|\b(?:follow[ -]?up|debrief)\b.*\b(?:client call|client meeting)\b/i.test(`${type} ${title}`),
    topicHints: [
      { intent: 'Review', pattern: /\b(?:client call|business processes|information gaps?|outstanding questions?|quality manuals?|procedures?|systems?|responsibilities)\b/i },
      { intent: 'Confirm', pattern: /\b(?:working sessions?|internal sessions?|weekly|check[ -]?in|availability)\b/i },
      { intent: 'Confirm', pattern: /\b(?:scope|statement of work|\bsow\b|regulatory|\bmdr\b|\bppe\b|procedures?)\b/i },
      { intent: 'Confirm', pattern: /\b(?:declarations? of conformity|\bdoc['’]?s?\b|languages?|translation|competent authority|markets?|audit finding)\b/i },
      { intent: 'Confirm', pattern: /\b(?:site visit|visit the site|process works|current process|follow up)\b/i }
    ]
  },
  {
    // Evidence-gated meeting frame: applies to audit planning generally, not to
    // a client, project code or fixture title.
    id: 'audit_planning',
    matches: (type, title) => /\baudit\b/i.test(`${type} ${title}`) && /\b(?:kick[ -]?off|planning|preparation|readiness|scope)\b/i.test(`${type} ${title}`),
    topicHints: [
      { intent: 'Confirm', pattern: /\b(?:audit scope|scope is determined|normal audit|routine audit|surveillance|full compliance|standards?|regulations?|21 cfr|mdr|mdsap)\b/i },
      { intent: 'Agree', pattern: /\b(?:key dates?|prep(?:aration)? work|training and prep|on site|report writing|timeline|mid audit)\b/i },
      { intent: 'Confirm', pattern: /\b(?:lead auditor|co-auditor|audit team|deep dive|separate track|combined skill|software expertise|split coverage)\b/i },
      { intent: 'Confirm', pattern: /\b(?:training attestation|code of conduct|confidentiality|sharepoint|external access|document access|tracker)\b/i },
      { intent: 'Identify', pattern: /\b(?:software development|software validation|cybersecurity|risk analysis|risk management|s-?bom|software bill of materials|versions?|threat model|cves?)\b/i },
      { intent: 'Review', pattern: /\b(?:site walkthrough|gemba|record sampling|findings tracker|audit findings|production process|design owner|manufacturing site)\b/i }
    ]
  }
];

const OBJECTIVE_INTENTS = new Set(['Confirm', 'Review', 'Agree', 'Identify']);

function meetingProfile(meeting = {}) {
  const type = clean(meeting.type || meeting.meetingType);
  const title = clean(meeting.title || meeting.meetingTitle);
  return MEETING_PROFILES.find((profile) => profile.matches(type, title)) || null;
}

// Returns a thin plan: the matched profile id plus its ordering/intent hints.
// No transcript content and no canned prose. Returns null when no profile matches.
function purposePlan(meeting = {}) {
  const profile = meetingProfile(meeting);
  if (!profile) return null;
  return { profileId: profile.id, topicHints: profile.topicHints || [] };
}

// The objective intent verb for a topic, from the first matching hint. Defaults
// to 'Review' when no profile matched or no hint applies.
function objectiveIntentForText(topicHints, text) {
  const value = clean(text);
  for (const hint of Array.isArray(topicHints) ? topicHints : []) {
    if (hint.pattern.test(value) && OBJECTIVE_INTENTS.has(hint.intent)) return hint.intent;
  }
  return 'Review';
}

// The order rank of a topic within a profile's hint sequence (lower = earlier).
// Topics that match no hint sort after all hinted topics, preserving their
// original order via the caller's stable sort tie-break.
function topicOrderRank(topicHints, text) {
  const value = clean(text);
  const hints = Array.isArray(topicHints) ? topicHints : [];
  for (let index = 0; index < hints.length; index += 1) {
    if (hints[index].pattern.test(value)) return index;
  }
  return Number.MAX_SAFE_INTEGER;
}

module.exports = { meetingProfile, purposePlan, objectiveIntentForText, topicOrderRank };
