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
  },
  {
    id: 'case_study_interview',
    matches: (type, title) => /\bcase study\b/i.test(`${type} ${title}`),
    riskEvidence: /^(?=.*\b(?:case study|draft|content|report|testimonial|publication|delivery)\b)(?=.*\b(?:risk|delay|block|missing|unavailable|cannot|can't|problem)\b)/i,
    dimensions: [
      {
        id: 'purpose',
        topic: 'Purpose and scope of the assessment',
        objective: (subject) => `Explain the purpose, scope and structure of ${subject}`,
        summary: (subject) => `${subject} was described as an assessment and improvement-planning approach for identifying priority areas.`,
        evidence: /\b(?:assessment tool|improvement plan|quality system|quality culture|maturity|operating)\b/i
      },
      {
        id: 'method',
        topic: 'Assessment method and evidence',
        objective: (subject) => `Document how ${subject} is conducted and scored`,
        summary: 'The assessment combines structured questions, scoring, document and data review, interviews and direct site observation.',
        evidence: /\b(?:questions?|score|rating|self-assess|interviews?|audit|procedures?|data|manufacturing floor|gemba|gumba|radar chart)\b/i
      },
      {
        id: 'benefits',
        topic: 'Benefits and improvement priorities',
        objective: (subject) => `Capture the benefits and improvement outcomes associated with ${subject}`,
        summary: 'The tool helps sites identify unknown gaps, prioritise improvement activity and build a practical improvement plan.',
        evidence: /\b(?:benefits?|prioriti[sz]e|areas? to improve|problems? they|gaps?|strategic plan|opportunities|raise the bar)\b/i
      },
      {
        id: 'examples',
        topic: 'Client examples and observed outcomes',
        objective: 'Capture representative client examples, findings and outcomes for the case study',
        summary: 'Client examples illustrated differences between quality-system maturity and quality culture, including gaps between written procedures and execution.',
        evidence: /\b(?:client|site|west|korza|corza|koza|case|example|procedures?|culture|operators?|management)\b/i
      },
      {
        id: 'follow_up',
        topic: 'Source material and follow-up',
        objective: 'Confirm the source material and follow-up needed to develop the case study',
        summary: 'Existing assessment reports, spreadsheets, radar charts and presentations were identified as source material, with draft review and a follow-up call offered.',
        evidence: /\b(?:reports?|spreadsheets?|sharepoint|presentation|source material|testimonial|draft|review it|another call|follow[ -]?up)\b/i
      }
    ]
  },
  {
    id: 'technical_file_review',
    matches: (type, title) => /\b(?:tech(?:nical)? file|technical documentation)\b.*\b(?:review|weekly|status|check-?in)\b/i.test(`${type} ${title}`),
    riskEvidence: /\b(?:outstanding (?:point|issue)|issue remains|incompatib|unresolved|missing|cannot|can't|delay|block|gap(?:s)? (?:that|which|remain)|high-risk area)\b/i,
    dimensions: [
      {
        id: 'status',
        topic: 'Technical-file status and priorities',
        objective: 'Review technical-file remediation status, priorities and outstanding deliverables',
        summary: 'The team reviewed technical-file progress, current priorities, document ownership and outstanding deliverables.',
        evidence: /\b(?:tech(?:nical)? file|tracker|status|progress|deliverables?|documents?|remediation|priorit(?:y|ies))\b/i
      },
      {
        id: 'risk',
        topic: 'Risk management and cybersecurity',
        objective: 'Confirm progress on risk-management and cybersecurity documentation',
        summary: 'Risk-management documentation, the risk matrix and cybersecurity hazards and mitigations were reviewed.',
        evidence: /\b(?:risk management|risk matrix|hazards?|cybersecurity|usb port|fmea|mitigation)\b/i
      },
      {
        id: 'software',
        topic: 'Software changes and review',
        objective: 'Review software changes, verification status and remaining approvals',
        summary: 'Software changes were reviewed, including alarm behaviour, language support, verification and clinical or usability approval.',
        evidence: /\b(?:software|alarms?|mute button|languages?|translations?|code changes?|change request|memory capacity)\b/i
      },
      {
        id: 'electrical',
        topic: 'Electrical compliance testing',
        objective: 'Confirm electrical-compliance testing, timing and downstream document updates',
        summary: 'The team reviewed in-house electrical-compliance testing, its planned completion and the resulting document updates.',
        evidence: /\b(?:electrical compliance|compliance testing|testing in house|test results?|electrical testing)\b/i
      },
      {
        id: 'submission',
        topic: 'Submission timing and dependencies',
        objective: 'Align remaining technical-file work with submission and review milestones',
        summary: 'Remaining work and dependencies were considered against the planned submission and notified-body review dates.',
        evidence: /\b(?:submission|mdr|notified body|\bNB\b|review date|end of august|nov(?:ember)?['’]?\d*)\b/i
      },
      {
        id: 'other_workstreams',
        topic: 'Other technical-file workstreams',
        objective: 'Review progress across supplier, usability, biocompatibility and post-market documentation',
        summary: 'Progress and dependencies across supplier documentation, usability, biocompatibility and post-market documentation were reviewed.',
        evidence: /\b(?:subcontractor|contract manufacturing|usability|formative stud|biocomp|biocompatibility|pms|post-market|process maps?)\b/i
      }
    ]
  }
];

function meetingProfile(meeting = {}) {
  const type = clean(meeting.type || meeting.meetingType);
  const title = clean(meeting.title || meeting.meetingTitle);
  return MEETING_PROFILES.find((profile) => profile.matches(type, title)) || null;
}

function meetingSubject(meeting = {}, profileId = '') {
  const title = clean(meeting.title || meeting.meetingTitle)
    .replace(/\bcase study\b.*$/i, '')
    .replace(/[_-]+$/g, '')
    .trim();
  if (title) return title;
  return profileId === 'case_study_interview' ? 'the case-study subject' : 'the meeting subject';
}

function evidenceForDimension(evidence, dimension) {
  return evidence.events.filter((event) => dimension.evidence.test(clean(event.text)));
}

function purposePlan(meeting, evidence) {
  const profile = meetingProfile(meeting);
  if (!profile) return null;
  const subject = meetingSubject(meeting, profile.id);
  const dimensions = profile.dimensions.map((dimension) => {
    const events = evidenceForDimension(evidence, dimension);
    return events.length ? {
      ...dimension,
      objective: typeof dimension.objective === 'function' ? dimension.objective(subject) : dimension.objective,
      summary: typeof dimension.summary === 'function' ? dimension.summary(subject) : dimension.summary,
      evidenceIds: events.map((event) => event.id)
    } : null;
  }).filter(Boolean);
  if (!dimensions.length) return null;
  return {
    profileId: profile.id,
    riskEvidence: profile.riskEvidence || null,
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
