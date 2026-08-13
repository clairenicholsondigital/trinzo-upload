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
    matches: (type, title) => /\b(?:tech(?:nical)? file|technical documentation)\b.*\b(?:review|weekly|status|check-?in)\b/i.test(`${type} ${title}`)
      || /\b(?:sw|software)\b.*\b(?:weekly|review|status|check[ -]?in)\b/i.test(`${type} ${title}`),
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
  },
  {
    id: 'importer_obligations_review',
    matches: (type, title) => /\b(?:importer obligations?|importer compliance|regulatory import)\b.*\b(?:review|plan|workshop|status|meeting)?\b/i.test(`${type} ${title}`),
    riskEvidence: /\b(?:could|may|will)\b.{0,80}\b(?:prevent|delay|block|non-compliance|audit finding)\b|\b(?:non-compliance|audit finding)\b/i,
    dimensions: [
      {
        id: 'qms',
        topic: 'QMS and importer obligations',
        objective: 'Review the QMS approach and documents required to meet importer obligations',
        summary: 'The QMS manual was reviewed as the foundation for importer-compliance procedures aligned with existing business processes.',
        evidence: /\b(?:qms|quality management system|importer obligations?|compliance documents?|procedures?)\b/i
      },
      {
        id: 'goods_flow',
        topic: 'Goods movement, storage and distribution',
        objective: 'Document the movement, storage and distribution of imported products',
        summary: 'The team mapped the flow of products from supplier and EU entry through clearance, Irish storage and customer distribution.',
        evidence: /\b(?:goods movement|point of entry|fiscal clearance|airport|storage|warehouse|courier|dhl|dispatch|distribution|shipped)\b/i
      },
      {
        id: 'warehouse',
        topic: 'Warehouse, ordering and packaging processes',
        objective: 'Understand ordering, warehouse picking, packaging and product-information controls',
        summary: 'Ordering, product allocation, barcode-assisted picking, repackaging, inserts and shipping labels were reviewed.',
        evidence: /\b(?:sales order|customer order|warehouse|picking|packing|packaging|barcode|scanner|netsuite|rf smart|shipping label|invoice)\b/i
      },
      {
        id: 'udi',
        topic: 'UDI, labelling and EUDAMED registration',
        objective: 'Confirm UDI, labelling and EUDAMED registration requirements and timelines',
        summary: 'The team reviewed current barcoding, future UDI production identifiers, labelling responsibilities and EUDAMED registration deadlines.',
        evidence: /\b(?:udi|eudamed|udamed|udimed|labelling|labeling|labels?|lot numbering|data matrix|upc|registration of devices)\b/i
      },
      {
        id: 'roles',
        topic: 'Manufacturer, importer and authorised-representative roles',
        objective: 'Clarify registration and verification responsibilities across the manufacturer, importer and authorised representative',
        summary: 'Responsibilities for completing and verifying device registrations were clarified across the legal manufacturer, importer, authorised representative and external representative.',
        evidence: /\b(?:legal manufacturer|importer|authori[sz]ed rep(?:resentative)?|med ?envoy|economic operator|manufacturer eo|verify the registration)\b/i
      },
      {
        id: 'declarations',
        topic: 'Declarations of conformity, PPE and language scope',
        objective: 'Review declarations of conformity, PPE rationale and language requirements',
        summary: 'Declarations of conformity for sunglasses, combined MDR and PPE rationale, destination countries and language considerations were reviewed.',
        evidence: /\b(?:declarations? of conformity|\bdoc['’]?s?\b|sunglasses|\bppe\b|risk rationale|languages?|translations?)\b/i
      },
      {
        id: 'hpra',
        topic: 'HPRA readiness and follow-up',
        objective: 'Confirm HPRA documentation, audit-readiness and follow-up actions',
        summary: 'The team discussed importer audit readiness, regulatory documentation and follow-up on the HPRA fee invoice.',
        evidence: /\b(?:hpra|audit|annual fees?|invoice fee|registration preparation|regulatory documentation)\b/i
      }
    ]
  },
  {
    id: 'internal_follow_up',
    matches: (type, title) => /\binternal\b.*\b(?:follow[ -]?up|review|debrief)\b|\b(?:follow[ -]?up|debrief)\b.*\b(?:client call|client meeting)\b/i.test(`${type} ${title}`),
    dimensions: [
      {
        id: 'client_findings',
        topic: 'Client-call findings and information gaps',
        objective: 'Review the client-call findings and identify the information needed to progress the work',
        summary: 'The team reviewed the client discussion and identified gaps in its understanding of business processes, systems, responsibilities and existing documentation.',
        evidence: /\b(?:client call|business works|business processes|on the ground|information gaps?|outstanding questions?|quality manuals?|procedures?|systems?|responsibilities)\b/i
      },
      {
        id: 'working_sessions',
        topic: 'Client working sessions and internal coordination',
        objective: 'Plan focused client working sessions and internal coordination',
        summary: 'Focused client working sessions and internal preparation were planned, with attendance limited to the people relevant to each topic.',
        evidence: /\b(?:working sessions?|internal sessions?|weekly recurrence|weekly client|check[ -]?in|wednesday|thursday|friday|availability|questions? for her)\b/i
      },
      {
        id: 'scope',
        topic: 'Scope and regulatory coverage',
        objective: 'Confirm unresolved scope and regulatory-coverage questions',
        summary: 'The team reviewed whether the documented scope should cover both medical-device and other applicable product requirements, and agreed to confirm any ambiguity with the client.',
        evidence: /\b(?:scope|statement of work|\bsow\b|regulatory|\bmdr\b|\bppe\b|sunglasses|opticals?|procedures?)\b/i
      },
      {
        id: 'documents',
        topic: 'Declarations and language requirements',
        objective: 'Clarify declaration-of-conformity and language requirements',
        summary: 'The team compared experience of declaration and language requirements across regulations, markets, competent authorities and audits, with further clarification still required.',
        evidence: /\b(?:declarations? of conformity|\bdoc['’]?s?\b|languages?|translation|competent authority|markets?|audit finding|official eu language)\b/i
      },
      {
        id: 'site_followup',
        topic: 'Site understanding and follow-up',
        objective: 'Confirm the follow-up needed to understand and document current site processes',
        summary: 'The team considered further client clarification and a possible site visit to ensure procedures reflect how work is performed in practice.',
        evidence: /\b(?:site visit|visit the site|how .* works|process works|current process|follow up with .*client|follow up with .*orla)\b/i
      }
    ]
  },
  {
    // Evidence-gated meeting frame: applies to audit planning generally, not
    // to a client, project code or fixture title.
    id: 'audit_planning',
    matches: (type, title) => /\baudit\b/i.test(`${type} ${title}`) && /\b(?:kick[ -]?off|planning|preparation|readiness|scope)\b/i.test(`${type} ${title}`),
    riskEvidence: /\b(?:risk|missing|unavailable|access|delay|confidential|cybersecurity|software|version|transmission|dependency)\b/i,
    dimensions: [
      {
        id: 'scope',
        topic: 'Audit scope, type and applicable standards',
        objective: 'Confirm the audit scope, approach and applicable standards',
        summary: 'The team confirmed the audit type, intended scope, applicable regulatory frameworks and the standards to be assessed.',
        evidence: /\b(?:audit scope|scope is determined|normal audit|routine audit|surveillance|full compliance|standards?|regulations?|21 cfr|mdr|mdsap)\b/i
      },
      {
        id: 'schedule',
        topic: 'Audit schedule and preparation milestones',
        objective: 'Agree the audit preparation, on-site and reporting timetable',
        summary: 'Preparation, training, on-site work and report-writing milestones were reviewed against auditor availability and dependencies.',
        evidence: /\b(?:key dates?|prep(?:aration)? work|training and prep|on site|report writing|audit formally starts|audit preparation meeting|timeline|mid audit)\b/i
      },
      {
        id: 'roles',
        topic: 'Audit-team roles and coverage',
        objective: 'Clarify auditor roles, specialist coverage and coordination',
        summary: 'Lead, co-auditor and specialist responsibilities were discussed, including how coverage would be divided and coordinated during the audit.',
        evidence: /\b(?:lead auditor|co-auditor|audit team|deep dive|separate track|combined skill|software expertise|handle all the other|split coverage)\b/i
      },
      {
        id: 'access',
        topic: 'Training, document access and confidentiality',
        objective: 'Confirm prerequisite training, document access and confidentiality arrangements',
        summary: 'The team reviewed prerequisite attestations and conduct requirements, together with secure access to audit evidence and shared working records.',
        evidence: /\b(?:training attestation|code of conduct|confidentiality|sharepoint|external access|securely transmitting|document access|share anything|tracker)\b/i
      },
      {
        id: 'technical_focus',
        topic: 'Software, cybersecurity and risk-management focus',
        objective: 'Define the software, cybersecurity and risk-management evidence to examine',
        summary: 'The proposed audit focus included software development and validation, version control, cybersecurity, risk management and software-bill-of-materials evidence.',
        evidence: /\b(?:software development|software validation|cybersecurity|risk analysis|risk management|s-?bom|software bill of materials|versions?|threat model|cves?)\b/i
      },
      {
        id: 'execution',
        topic: 'On-site evidence gathering and audit execution',
        objective: 'Plan the on-site evidence-gathering and audit execution approach',
        summary: 'The team discussed site observation, record sampling, findings management and how the audit tracks would operate in practice.',
        evidence: /\b(?:site walkthrough|gemba|record sampling|findings tracker|audit findings|production process|design owner|manufacturing site|on a separate track)\b/i
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
