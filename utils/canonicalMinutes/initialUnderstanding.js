'use strict';

const { clean } = require('./evidence');
const { purposePlan } = require('./meetingPurpose');
const { canHeadlineTopic, canSupportPurposeDimension, canStandAloneAsMinutesEvidence } = require('./publishability');
const { editorialTopicLabel, isPublishableTopicLabel, CONCEPTS } = require('./topicEditorial');

// A concept counts as discussed only when several turns support it, so a single
// stray word cannot put a subject into the meeting's purpose. Three is as many
// as a purpose sentence carries before it stops being a summary.
const MIN_EVENTS_PER_CONCEPT = 2;
const MAX_PURPOSE_CONCEPTS = 3;

// Labels frequently contain "and" ("Documentation and evidence"), so a plain
// "X, Y and Z" is genuinely ambiguous. The serial comma is doing real work.
function joinConceptLabels(labels) {
  if (labels.length <= 1) return labels[0] || '';
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

// What the meeting actually covered, in the curated concept vocabulary, ranked
// by how much of the discussion supports each one. Grounded by construction: a
// concept is only available when the transcript contains matching evidence, and
// the labels are client-safe because they are written rather than extracted.
function describeDiscussedConcepts(evidence) {
  const events = (evidence && evidence.events) || [];
  if (!events.length) return '';
  const ranked = CONCEPTS
    .map((concept) => ({ label: concept.label, support: events.filter((event) => concept.pattern.test(event.text || '')).length }))
    .filter((item) => item.support >= MIN_EVENTS_PER_CONCEPT)
    .sort((left, right) => right.support - left.support)
    .slice(0, MAX_PURPOSE_CONCEPTS);
  if (!ranked.length) return '';
  return `The meeting covered ${joinConceptLabels(ranked.map((item) => item.label.toLowerCase()))}.`;
}

const STOPWORDS = new Set([
  'about', 'after', 'again', 'also', 'been', 'being', 'client', 'confirm', 'could',
  'document', 'evidence', 'from', 'have', 'into', 'meeting', 'minutes', 'need',
  'needs', 'other', 'review', 'reviewed', 'should', 'that', 'their', 'there',
  'these', 'this', 'those', 'topic', 'topics', 'what', 'when', 'where', 'which',
  'with', 'workstream', 'would'
]);

const MODE_CONFIG = {
  importer_obligations_review: {
    mode: 'process_discovery',
    label: 'Process discovery',
    purpose: ({ organisation }) => `Understand ${possessive(organisation || 'the client')} actual operational processes so importer-obligation procedures can be designed around how the business works.`,
    objectives: [
      'Establish how goods movement, storage and operational workflows work in practice.',
      'Align importer-obligation and QMS procedure design with the client\'s actual processes.',
      'Confirm regulatory documentation, labelling and follow-up evidence needed for importer compliance.'
    ]
  },
  audit_planning: {
    mode: 'audit_preparation',
    label: 'Audit preparation',
    purpose: ({ site }) => `Align the audit team on the ${site ? `${site} ` : ''}surveillance-audit plan, including specialist software coverage, preparation, access, timing, logistics and responsibilities.`,
    objectives: [
      'Align audit scope, timing, logistics and team responsibilities.',
      'Confirm specialist software-audit preparation, access and evidence needs.',
      'Resolve preparation dependencies such as confidentiality, document access, risk analysis and audit-planning material.'
    ]
  },
  technical_file_review: {
    mode: 'weekly_project_coordination',
    label: 'Weekly project/status coordination',
    purpose: () => 'Coordinate progress, evidence gaps, blockers and next steps for the software-change and technical-file programme so the change package can be closed properly.',
    objectives: [
      'Coordinate remaining software-change evidence, blockers and next steps needed to close the technical-file package.',
      'Confirm technical evidence for alarms, testing, cybersecurity, traceability and change-control workstreams.',
      'Identify unresolved documentation, standards and risk-management gaps before closure.'
    ]
  },
  webinar_rehearsal: {
    mode: 'rehearsal',
    label: 'Rehearsal',
    purpose: () => 'Rehearse the webinar flow, content, handovers and technical setup so the live session can run smoothly.',
    objectives: [
      'Confirm the webinar running order, handovers and presenter responsibilities.',
      'Review content, audience interaction points and technical setup before the live session.'
    ]
  },
  case_study_interview: {
    mode: 'case_study_discovery',
    label: 'Case-study discovery',
    purpose: () => 'Understand the client experience, operating context and evidence needed to shape the case-study material.',
    objectives: [
      'Capture the client experience, operating context and evidence needed for the case study.',
      'Identify follow-up material required before the case-study narrative can be finalised.'
    ]
  },
  internal_follow_up: {
    mode: 'internal_follow_up',
    label: 'Internal follow-up',
    purpose: () => 'Align internally on the client call, outstanding information gaps and next working sessions.',
    objectives: [
      'Review the client-call understanding and outstanding information gaps.',
      'Confirm next internal working sessions and scope questions.'
    ]
  }
};

const WORKSTREAM_CONCEPTS = [
  { label: 'Goods flow and storage', profiles: ['importer_obligations_review'], pattern: /\b(?:goods?|supplier|suppliers?|japan|netherlands|fiscal|clearance|warehouse|warehousing|stored?|storage|dublin|park west|dispatch|shipp(?:ed|ing)|country of origin|final destination)\b/i },
  { label: 'Importer-obligation QMS procedure design', profiles: ['importer_obligations_review'], pattern: /\b(?:importer|obligation|procedure|procedures|qms|quality manual|operational|operations?|process(?:es)?|workflow|netsuite|erp|order flow|warehouse checks?|warehouse verification|scanner|scanners|barcode|document control|manual process(?:es)?)\b/i },
  { label: 'MDR, PPE and declarations of conformity', profiles: ['importer_obligations_review'], pattern: /\b(?:ppe|sunglasses?|declarations? of conformity|doc\b|conformity|category\s*(?:one|1)|risk rationale|eumdr|eu mdr|mdr)\b/i },
  { label: 'EUDAMED, HPRA and registration evidence', profiles: ['importer_obligations_review'], pattern: /\b(?:eudamed|udamed|hpra|srn|registration|authori[sz]ed representative|authori[sz]ed rep|regulatory|bill|invoice)\b/i },
  { label: 'Language and country requirements', profiles: ['importer_obligations_review', 'technical_file_review'], pattern: /\b(?:language|languages?|country|countries|translation|translations?|locali[sz]ation|ifu|ifus|labels?|labelling|labeling|manufacturer information|market(?:s)?)\b/i },
  { label: 'MedEnvoy and Cody alignment', profiles: ['importer_obligations_review'], pattern: /\b(?:med\s*envoy|medenvoy|cody|alignment|scope|project plan|task list|side meetings?|consult Cody)\b/i },
  { label: 'Further process discovery and working sessions', profiles: ['importer_obligations_review'], pattern: /\b(?:further|future|discovery|working sessions?|workshop|follow[- ]?up|next call|another call|go through|walk through|arrange|schedule)\b/i },
  { label: 'Audit scope, timing and logistics', profiles: ['audit_planning'], pattern: /\b(?:audit scope|surveillance|audit plan|audit planning|sylmar|site|hotel|travel|hire car|logistics|key dates?|on site|report writing|timing|schedule)\b/i },
  { label: 'Software deep-dive role and responsibilities', profiles: ['audit_planning'], pattern: /\b(?:software deep[- ]?dive|software audit|separate track|audit team|lead auditor|co[- ]?auditor|responsibilit(?:y|ies)|role|coverage)\b/i },
  { label: 'Preparation, confidentiality and document access', profiles: ['audit_planning'], pattern: /\b(?:code of conduct|confidentiality|training attestation|sharepoint|external access|document access|securely transmitting|tracker|preparation)\b/i },
  { label: 'Risk analysis and audit-planning evidence', profiles: ['audit_planning'], pattern: /\b(?:risk analysis|risk management|audit plan|s-bom|sbom|threat model|cves?|cybersecurity|software development|software validation)\b/i },
  { label: 'Alarm-code and clinical confirmation', profiles: ['technical_file_review'], pattern: /\b(?:alarm|mute button|clinical|flash|flashing|low priority|medium priority|high priority|code change)\b/i },
  { label: 'Debug and test-script evidence', profiles: ['technical_file_review'], pattern: /\b(?:debug|test script|testing|test results?|verification|validation|retrospective test data)\b/i },
  { label: 'Change control and version traceability', profiles: ['technical_file_review'], pattern: /\b(?:change request|change control|version\s*1\.0|version\s*1\.01|version\s*1\.02|software versions?|software traceability|version traceability|device file history|17 changes)\b/i },
  { label: 'Electrical compliance evidence', profiles: ['technical_file_review'], pattern: /\b(?:iec\s*60601|60601-1|electrical compliance|electrical testing)\b/i },
  {
    label: 'Cybersecurity, USB and GUI controls',
    profiles: ['technical_file_review'],
    pattern: /\b(?:cyber\s*security|usb port|port lock|gui|password protect(?:ed|ion)?|unauthorised access|unauthorized access|unwarranted interference)\b/i,
    requiredEvidencePattern: /\b(?:usb|port lock|gui|password protect(?:ed|ion)?|unauthorised access|unauthorized access|unwarranted interference)\b/i
  },
  { label: 'Standards and risk-management work', profiles: ['technical_file_review'], pattern: /\b(?:standards?|risk management|risk matrix|fmea|hazards?|mitigation)\b/i }
];

const CLARIFICATION_CUES = /\b(?:actually|rather than|instead of|only|not substantive|the difference is|what I mean|I meant|no[, ]+it|no[, ]+that|correction|to clarify)\b/i;
const UNRESOLVED_CUES = /\b(?:still need|still needs|outstanding|pending|blocked|blocker|dependency|before we can|need to confirm|needs confirmation|missing|not finali[sz]ed|follow[- ]?up|next step|required before)\b/i;
const MATERIAL_CUES = /\b(?:need to|needs? to|must|confirm|agree|align|prepare|complete|finali[sz]e|close|blocker|dependency|outstanding|risk|decision|action|follow[- ]?up|next step|evidence|access|procedure|audit|technical file|change package)\b/i;

function tokens(value) {
  return (clean(value).toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [])
    .filter((token) => !STOPWORDS.has(token));
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function possessive(value) {
  const text = clean(value);
  if (!text) return 'the client\'s';
  return /s$/i.test(text) ? `${text}'` : `${text}'s`;
}

function titleWords(value) {
  return clean(value).split(/\s+/).filter(Boolean);
}

function organisationFromMeeting(meeting = {}) {
  const title = clean(meeting.title || meeting.meetingTitle);
  const clientMatch = title.match(/\bClient\s+([A-Z][A-Za-z0-9&.-]+)/);
  if (clientMatch && !/^(?:Audit|Eakin|T\d+)/i.test(clientMatch[1])) return clientMatch[1];
  const words = titleWords(title).filter((word) => /^[A-Z][A-Za-z&.-]{2,}$/.test(word) && !/^(?:Client|Audit|Kick|Off|Review|Weekly|Meeting|Importer|Obligations|Tech|File|Project)$/i.test(word));
  return words[0] || '';
}

function siteFromMeeting(meeting = {}) {
  const title = clean(meeting.title || meeting.meetingTitle);
  const match = title.match(/\b(?:kick[ -]?off|audit(?:\s+kick[ -]?off)?)\s+([A-Z][A-Za-z0-9&.-]+)\b/i);
  if (match && !/^(?:meeting|review|planning|scope)$/i.test(match[1])) return match[1];
  const sylmar = title.match(/\bSylmar\b/i);
  return sylmar ? 'Sylmar' : '';
}

function eventByIdMap(evidence) {
  return new Map((evidence?.events || []).map((event) => [event.id, event]));
}

function admissibleEvent(event) {
  return event && canSupportPurposeDimension(event.text) && canStandAloneAsMinutesEvidence(event.text, { allowConditional: true });
}

function strongestEvidenceIdsForPattern(evidence, pattern, limit = 6) {
  return (evidence.events || [])
    .filter((event) => admissibleEvent(event) && pattern.test(event.text))
    .sort((left, right) => {
      const leftMaterial = MATERIAL_CUES.test(left.text) ? 1 : 0;
      const rightMaterial = MATERIAL_CUES.test(right.text) ? 1 : 0;
      return rightMaterial - leftMaterial || Number(left.turnIndex || 0) - Number(right.turnIndex || 0);
    })
    .slice(0, limit)
    .map((event) => event.id);
}

function inferredWorkstreamsFromEvidence(evidence, topics = [], profileId = '') {
  const byLabel = new Map();
  for (const concept of WORKSTREAM_CONCEPTS) {
    if (Array.isArray(concept.profiles) && concept.profiles.length && !concept.profiles.includes(profileId)) continue;
    const evidenceIds = strongestEvidenceIdsForPattern(evidence, concept.pattern, 8);
    if (evidenceIds.length && concept.requiredEvidencePattern) {
      const byId = eventByIdMap(evidence);
      const hasRequiredEvidence = evidenceIds.some((id) => concept.requiredEvidencePattern.test(byId.get(id)?.text || ''));
      if (!hasRequiredEvidence) continue;
    }
    if (evidenceIds.length) byLabel.set(concept.label.toLowerCase(), { label: concept.label, evidenceIds, provenance: 'model_inferred' });
  }
  for (const topic of topics) {
    const label = clean(topic.text || topic.editorialText || topic.topic || editorialTopicLabel(topic, evidence));
    // canHeadlineTopic judges whether a sentence could head a topic; this also
    // requires the result to read as a subject rather than as something said,
    // so the summary screen holds to the same bar as the discussion screen.
    if (!label || !canHeadlineTopic(label) || !isPublishableTopicLabel(label)) continue;
    const key = label.toLowerCase();
    if (byLabel.has(key)) continue;
    const labelTokens = new Set(tokens(label));
    const duplicateOfConcept = [...byLabel.values()].some((item) => {
      const existing = new Set(tokens(item.label));
      if (!labelTokens.size || !existing.size) return false;
      const overlap = [...labelTokens].filter((token) => existing.has(token)).length / Math.min(labelTokens.size, existing.size);
      return overlap >= 0.5;
    });
    if (duplicateOfConcept) continue;
    const ids = unique(topic.evidenceIds || []).filter((id) => evidence.events.some((event) => event.id === id && admissibleEvent(event)));
    if (ids.length) byLabel.set(key, { label, evidenceIds: ids, provenance: 'transcript_emergent' });
  }
  return [...byLabel.values()].slice(0, 10);
}

function inferMeetingMode(meeting, profileId, evidence) {
  const config = MODE_CONFIG[profileId];
  if (config) {
    return {
      id: config.mode,
      label: config.label,
      confidence: 0.78,
      evidenceIds: unique((evidence.events || []).filter(admissibleEvent).slice(0, 4).map((event) => event.id))
    };
  }
  const joined = (evidence.events || []).map((event) => event.text).join(' ');
  if (/\baudit\b/i.test(joined)) return { id: 'audit_preparation', label: 'Audit preparation', confidence: 0.55, evidenceIds: [] };
  if (/\b(?:weekly|status|check[- ]?in|progress)\b/i.test(joined)) return { id: 'weekly_project_coordination', label: 'Weekly project/status coordination', confidence: 0.5, evidenceIds: [] };
  if (/\b(?:decision|agree|approval|go[- ]?no[- ]?go)\b/i.test(joined)) return { id: 'decision_review', label: 'Decision/review', confidence: 0.45, evidenceIds: [] };
  return { id: 'general_review', label: 'General review', confidence: 0.35, evidenceIds: [] };
}

function materialEvents(evidence, ids = []) {
  const byId = eventByIdMap(evidence);
  return unique(ids).map((id) => byId.get(id)).filter(admissibleEvent);
}

function conceptSentenceForWorkstream(label) {
  const text = clean(label);
  const rules = [
    { re: /goods flow|storage/i, text: 'The goods-flow evidence covered supplier origin, fiscal clearance, warehousing and final storage arrangements.' },
    { re: /importer-obligation|QMS|procedure/i, text: 'Procedure design depends on understanding the client\'s operational workflows, checks, document control and manual processes.' },
    { re: /MDR|PPE|declarations? of conformity/i, text: 'The regulatory evidence covered MDR/PPE treatment, product rationale and declarations-of-conformity requirements.' },
    { re: /EUDAMED|HPRA|registration/i, text: 'Registration evidence and authorised-representative follow-up were material to the importer-obligation work.' },
    { re: /language|country/i, text: 'Country and language evidence was needed to assess translation, label and market requirements.' },
    { re: /MedEnvoy|Cody/i, text: 'MedEnvoy/Cody alignment remained relevant to scope, existing activity and follow-up planning.' },
    { re: /further process discovery|working sessions/i, text: 'Further process-discovery work was needed to complete the operational understanding.' },
    { re: /audit scope|timing|logistics/i, text: 'Audit planning covered scope, timing, site logistics and the practical preparation timetable.' },
    { re: /software deep-dive|responsibilities/i, text: 'The audit team needed to align the specialist software coverage and related responsibilities.' },
    { re: /preparation|confidentiality|access/i, text: 'Preparation depended on confidentiality, training and document-access steps being in place.' },
    { re: /risk analysis|audit-planning/i, text: 'Risk-analysis and audit-planning material shaped the preparation required before the audit.' },
    { re: /alarm/i, text: 'Alarm-code and clinical-confirmation evidence was material to the software-change package.' },
    { re: /debug|test-script/i, text: 'Debug and test-script evidence was needed to support the software-change record.' },
    { re: /change control|version traceability/i, text: 'Change-control and version-traceability evidence was central to closing the software-change package.' },
    { re: /electrical compliance/i, text: 'Electrical compliance evidence remained a material technical-file workstream.' },
    { re: /cybersecurity|USB|GUI/i, text: 'Cybersecurity, USB and GUI-control evidence remained relevant to the technical-file review.' },
    { re: /standards|risk-management/i, text: 'Standards and risk-management evidence remained part of the technical-file closure work.' }
  ];
  return rules.find((rule) => rule.re.test(text))?.text || '';
}

function sentenceFromWorkstream(workstream, evidence) {
  const conceptSentence = conceptSentenceForWorkstream(workstream.label);
  if (conceptSentence) return conceptSentence;
  const events = materialEvents(evidence, workstream.evidenceIds);
  const consequential = events.find((event) => MATERIAL_CUES.test(event.text)) || events[0];
  if (!consequential) return '';
  let text = clean(consequential.text)
    .replace(/^(?:yeah|yes|okay|ok|right|so|well|like)[,;:\s]+/i, '')
    .replace(/\s+/g, ' ')
    .replace(/[.?!]+$/, '');
  if (text.length > 190) text = `${text.slice(0, 187).replace(/\s+\S*$/, '')}...`;
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}.` : '';
}

function buildMeetingSpineItems(evidence, workstreams) {
  return (workstreams || [])
    .map((workstream, index) => {
      const text = sentenceFromWorkstream(workstream, evidence);
      if (!text) return null;
      return {
        id: `initial_spine_${index + 1}`,
        text,
        role: UNRESOLVED_CUES.test(text) ? 'unresolved_need'
          : CLARIFICATION_CUES.test(text) ? 'material_clarification'
            : 'material_development',
        evidenceIds: unique(workstream.evidenceIds).slice(0, 6),
        sourceWorkstream: workstream.label,
        provenance: 'model_inferred'
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function buildPurpose(meeting, profileId, mode, spine, workstreams, evidence) {
  const config = MODE_CONFIG[profileId];
  const evidenceIds = unique([
    ...(mode.evidenceIds || []),
    ...spine.flatMap((item) => item.evidenceIds || []),
    ...workstreams.slice(0, 3).flatMap((item) => item.evidenceIds || [])
  ]).slice(0, 10);
  const context = {
    organisation: organisationFromMeeting(meeting),
    site: siteFromMeeting(meeting)
  };
  let text = config?.purpose ? config.purpose(context) : '';
  if (!text) {
    const labels = workstreams.slice(0, 2).map((item) => item.label.toLowerCase());
    text = labels.length
      ? `Coordinate the meeting's main workstreams, dependencies and next steps around ${labels.join(' and ')}.`
      : '';
  }
  // A semicolon-spliced or report-shaped purpose is not usable prose either.
  const unusable = !text || /;\s/.test(text) || /^The meeting reviewed\b/i.test(text);
  if (!unusable) return { text, evidenceIds, provenance: 'model_inferred', confidence: config ? 0.76 : 0.45 };

  // Nothing in the meeting's own structure named a purpose. Say what was
  // actually discussed rather than emitting a sentence about "the transcript
  // evidence", which describes our pipeline rather than the client's meeting
  // and reads, to the person holding the minutes, as though the meeting had
  // been about transcripts. Where even that is unavailable, say so plainly
  // and let the flag ask the reviewer for it.
  const described = describeDiscussedConcepts(evidence);
  return {
    text: described || 'A clear purpose for this meeting was not stated in the discussion.',
    evidenceIds,
    provenance: 'inferred_from_discussion',
    confidence: described ? 0.35 : 0.2,
    inferred: true,
    describedFromDiscussion: Boolean(described)
  };
}

function buildObjectives(profileId, workstreams, purpose) {
  const configObjectives = MODE_CONFIG[profileId]?.objectives || [];
  const evidenceIds = unique(workstreams.slice(0, 4).flatMap((item) => item.evidenceIds || [])).slice(0, 10);
  if (configObjectives.length) {
    return configObjectives.slice(0, 4).map((text, index) => ({
      text,
      evidenceIds: evidenceIds.length ? evidenceIds : purpose.evidenceIds,
      provenance: 'model_inferred',
      id: `initial_objective_${index + 1}`
    }));
  }
  return workstreams.slice(0, 4).map((workstream, index) => ({
    text: `Clarify ${workstream.label.charAt(0).toLowerCase()}${workstream.label.slice(1)} and related next steps.`,
    evidenceIds: unique(workstream.evidenceIds).slice(0, 6),
    provenance: 'model_inferred',
    id: `initial_objective_${index + 1}`
  }));
}

function buildClarifications(evidence) {
  return (evidence.events || [])
    .filter((event) => admissibleEvent(event) && CLARIFICATION_CUES.test(event.text))
    .slice(0, 5)
    .map((event, index) => ({
      id: `initial_clarification_${index + 1}`,
      text: clean(event.text).replace(/[.?!]+$/, ''),
      evidenceIds: [event.id],
      provenance: 'model_inferred'
    }));
}

function buildUnresolvedNeeds(evidence) {
  return (evidence.events || [])
    .filter((event) => admissibleEvent(event) && UNRESOLVED_CUES.test(event.text))
    .slice(0, 6)
    .map((event, index) => ({
      id: `initial_unresolved_${index + 1}`,
      text: clean(event.text).replace(/[.?!]+$/, ''),
      evidenceIds: [event.id],
      provenance: 'model_inferred'
    }));
}

function genericTopicRatio(workstreams) {
  if (!workstreams.length) return 0;
  const generic = workstreams.filter((item) => /^(?:risks and dependencies|scope and requirements|plans and timelines|roles and responsibilities|documentation and evidence|operations and processes|product behaviour and design|regulatory and compliance)$/i.test(item.label)).length;
  return Number((generic / workstreams.length).toFixed(3));
}

function buildInitialUnderstanding({ evidence, meeting = {}, topics = [], meetingSpine = null } = {}) {
  const plan = purposePlan(meeting);
  const profileId = plan?.profileId || meetingSpine?.purposeProfile || '';
  const topicWorkstreams = (topics || []).map((topic) => ({
    label: clean(topic.text || topic.editorialText || topic.topic),
    evidenceIds: topic.evidenceIds || [],
    provenance: 'transcript_emergent'
  })).filter((item) => item.label && canHeadlineTopic(item.label) && isPublishableTopicLabel(item.label));
  const workstreams = inferredWorkstreamsFromEvidence(evidence, [...topicWorkstreams, ...(topics || [])], profileId);
  const selectedWorkstreams = (workstreams.length ? workstreams : topicWorkstreams).slice(0, 8);
  const mode = inferMeetingMode(meeting, profileId, evidence);
  const spine = buildMeetingSpineItems(evidence, selectedWorkstreams);
  const purpose = buildPurpose(meeting, profileId, mode, spine, selectedWorkstreams, evidence);
  const objectives = buildObjectives(profileId, selectedWorkstreams, purpose);
  const clarifications = buildClarifications(evidence);
  const unresolvedNeeds = buildUnresolvedNeeds(evidence);
  return {
    provenance: 'model_inferred',
    meetingMode: mode,
    meetingPurpose: purpose,
    meetingSpine: spine,
    primaryWorkstreams: selectedWorkstreams.map((item, index) => ({
      id: `initial_workstream_${index + 1}`,
      label: item.label,
      evidenceIds: unique(item.evidenceIds).slice(0, 8),
      provenance: item.provenance || 'model_inferred',
      planningPriority: 100 - index
    })),
    materialClarifications: clarifications,
    unresolvedNeeds,
    objectives,
    diagnostics: {
      profileId,
      spineCount: spine.length,
      primaryWorkstreamCount: selectedWorkstreams.length,
      materialClarificationCount: clarifications.length,
      unresolvedNeedCount: unresolvedNeeds.length,
      genericTopicRatio: genericTopicRatio(selectedWorkstreams),
      rejectedFragmentExamples: (topics || [])
        .map((topic) => clean(topic.text || topic.editorialText || topic.representativeText))
        .filter((text) => text && !canHeadlineTopic(text))
        .slice(0, 5)
    }
  };
}

module.exports = {
  buildInitialUnderstanding,
  describeDiscussedConcepts,
  organisationFromMeeting,
  siteFromMeeting
};
