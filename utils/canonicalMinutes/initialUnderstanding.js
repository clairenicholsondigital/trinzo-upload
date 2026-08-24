'use strict';

const { clean } = require('./evidence');
const { purposePlan, objectiveIntentForText } = require('./meetingPurpose');
const { statedPurposeFromOpening, purposeFromTitle, namesARecurringSubject } = require('./statedPurpose');
const { purposeFromTitleShape } = require('./titlePurpose');
const { canHeadlineTopic, canSupportPurposeDimension, canStandAloneAsMinutesEvidence } = require('./publishability');
const { minutesEnglishFaults } = require('../minutesEnglish');
const { editorialTopicLabel, isPublishableTopicLabel, labelIsTurnDerived, labelNamesAWorkstream, CONCEPTS } = require('./topicEditorial');
const { stagedFinalActionQualityIssue } = require('../stagedEditorial');

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
  { label: 'Goods flow and storage', homeOnly: true, profiles: ['importer_obligations_review'], pattern: /\b(?:goods?|supplier|suppliers?|japan|netherlands|fiscal|clearance|warehouse|warehousing|stored?|storage|dublin|park west|dispatch|shipp(?:ed|ing)|country of origin|final destination)\b/i },
  // homeOnly: "process", "workflow", "operations" recur in any meeting whatever, and the
  // label asserts a domain - an AI status check-in was told to review importer-obligation
  // QMS procedure design.
  { label: 'Importer-obligation QMS procedure design', profiles: ['importer_obligations_review'], homeOnly: true, pattern: /\b(?:importer|obligation|procedure|procedures|qms|quality manual|operational|operations?|process(?:es)?|workflow|netsuite|erp|order flow|warehouse checks?|warehouse verification|scanner|scanners|barcode|document control|manual process(?:es)?)\b/i },
  { label: 'MDR, PPE and declarations of conformity', profiles: ['importer_obligations_review'], pattern: /\b(?:ppe|sunglasses?|declarations? of conformity|doc\b|conformity|category\s*(?:one|1)|risk rationale|eumdr|eu mdr|mdr)\b/i },
  { label: 'EUDAMED, HPRA and registration evidence', profiles: ['importer_obligations_review'], pattern: /\b(?:eudamed|udamed|hpra|srn|registration|authori[sz]ed representative|authori[sz]ed rep|regulatory|bill|invoice)\b/i },
  // requiredEvidencePattern on the two broad concepts below: their main patterns fire on
  // words almost any meeting uses ("market", "standards"), which was harmless while they
  // were fenced to their home profiles and is not once concepts travel cross-profile.
  { label: 'Language and country requirements', profiles: ['importer_obligations_review', 'technical_file_review'], pattern: /\b(?:language|languages?|country|countries|translation|translations?|locali[sz]ation|ifu|ifus|labels?|labelling|labeling|manufacturer information|market(?:s)?)\b/i, requiredEvidencePattern: /\b(?:language|languages|translation|translations|locali[sz]ation|ifu|labelling|labeling)\b/i },
  { label: 'MedEnvoy and Cody alignment', profiles: ['importer_obligations_review'], pattern: /\b(?:med\s*envoy|medenvoy|cody|alignment|scope|project plan|task list|side meetings?|consult Cody)\b/i },
  // homeOnly: the pattern is meeting-furniture vocabulary ("follow-up", "schedule",
  // "go through") that recurs in any meeting whatever. Inside its own profile that is
  // fine - the profile match already established the context - but travelling
  // cross-profile it manufactures a workstream out of politeness.
  { label: 'Further process discovery and working sessions', profiles: ['importer_obligations_review'], homeOnly: true, pattern: /\b(?:further|future|discovery|working sessions?|workshop|follow[- ]?up|next call|another call|go through|walk through|arrange|schedule)\b/i },
  { label: 'Audit scope, timing and logistics', homeOnly: true, profiles: ['audit_planning'], pattern: /\b(?:audit scope|surveillance|audit plan|audit planning|sylmar|site|hotel|travel|hire car|logistics|key dates?|on site|report writing|timing|schedule)\b/i },
  { label: 'Software deep-dive role and responsibilities', profiles: ['audit_planning'], pattern: /\b(?:software deep[- ]?dive|software audit|separate track|audit team|lead auditor|co[- ]?auditor|responsibilit(?:y|ies)|role|coverage)\b/i },
  { label: 'Preparation, confidentiality and document access', homeOnly: true, profiles: ['audit_planning'], pattern: /\b(?:code of conduct|confidentiality|training attestation|sharepoint|external access|document access|securely transmitting|tracker|preparation)\b/i },
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
  { label: 'Standards and risk-management work', profiles: ['technical_file_review'], pattern: /\b(?:standards?|risk management|risk matrix|fmea|hazards?|mitigation)\b/i, requiredEvidencePattern: /\b(?:risk management|risk matrix|fmea|hazards?|mitigation)\b/i },
  // Webinar-domain concepts, labels written here and patterns lifted from the webinar
  // profile's hints - the same evidence-gated-label idiom as every entry above. These are
  // what let a rehearsal confirmed under a generic type still surface what it rehearsed.
  { label: 'Presenter handovers and roles', profiles: ['webinar_rehearsal'], pattern: /\b(?:hand(?:ing)? over|handover|pass back|host|present(?:er|ing)?|facilitat(?:e|or)|safety net)\b/i },
  { label: 'Audience questions and Q&A handling', profiles: ['webinar_rehearsal'], pattern: /\b(?:questions?|q\s*&\s*a|chat|audience|attendee|speech bubble|qr code|call to action)\b/i, requiredEvidencePattern: /\b(?:q\s*&\s*a|audience|attendee|chat)\b/i },
  { label: 'Timing and running order', profiles: ['webinar_rehearsal'], pattern: /\b(?:timings?|hard stop|overrun|dead air|run(?:ning)? order|pace|agenda order|minutes? each)\b/i },
  { label: 'Technical setup and contingencies', profiles: ['webinar_rehearsal'], pattern: /\b(?:screen shar(?:e|ing)|record(?:ing)?|red dot|connection|wi-?fi|broadband|animation|microphone|camera|contingenc|fallback|back[- ]?up plan)\b/i, requiredEvidencePattern: /\b(?:screen shar|record|microphone|camera|connection|contingenc)\b/i }
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

// A concept that belongs to another profile can still name what THIS meeting worked on.
// The Eakin weekly, confirmed as a general project review, is genuinely about alarm
// changes, change control, languages, electrical compliance and cybersecurity - all
// technical-file concepts. Gating them on the selected profile made the meeting's
// richness depend on a dropdown, when the reviewer's own steer was the opposite: the
// dropdown names the meeting's shape, the evidence names its subjects.
//
// Cross-profile admission is stricter than home-profile admission - three supporting
// events rather than any - because a foreign concept firing on a stray mention is
// exactly the mislabelling the profile fence used to prevent.
const CROSS_PROFILE_MIN_EVIDENCE = 3;

// A borrowed concept has to arrive with company.
//
// Counting matching events was never the question the cross-profile gate meant to ask. An
// allotment society with a solar alarm on the shed says "alarm" three times and clears a
// count of three, so its minutes were headed "Alarm-code and clinical confirmation" - a
// medical-device workstream, in a meeting about a water butt and some marrows - and that
// label went on to write the purpose, an objective and a sentence of the summary. A
// webinar rehearsal picked up "EUDAMED, HPRA and registration evidence" the same way.
//
// The signal that separates those from the case this admission exists for is not how many
// times one concept fired, it is whether the meeting looks like the profile the concept
// came from. The Eakin weekly borrows technical-file concepts because it genuinely is one:
// alarm behaviour, debug evidence, change control, electrical compliance and cybersecurity
// all fire together. The allotment borrows one, on one word. So a foreign profile has to
// place at least two concepts before any of them is admitted.
//
// Counting the concept's own vocabulary was tried first and was worse: it dropped "Debug
// and test-script evidence" and "Electrical compliance evidence" from three real technical
// file meetings, which say "testing" a great deal and "verification" not at all. Those are
// their own subjects and the reviewer should see them.
const CROSS_PROFILE_MIN_CONCEPTS = 2;

function inferredWorkstreamsFromEvidence(evidence, topics = [], profileId = '') {
  const byLabel = new Map();
  const admissible = [];
  for (const concept of WORKSTREAM_CONCEPTS) {
    const homeProfile = !Array.isArray(concept.profiles) || !concept.profiles.length || concept.profiles.includes(profileId);
    if (!homeProfile && concept.homeOnly) continue;
    const evidenceIds = strongestEvidenceIdsForPattern(evidence, concept.pattern, 8);
    if (!evidenceIds.length) continue;
    if (!homeProfile && evidenceIds.length < CROSS_PROFILE_MIN_EVIDENCE) continue;
    if (concept.requiredEvidencePattern) {
      const byId = eventByIdMap(evidence);
      const hasRequiredEvidence = evidenceIds.some((id) => concept.requiredEvidencePattern.test(byId.get(id)?.text || ''));
      if (!hasRequiredEvidence) continue;
    }
    admissible.push({ concept, evidenceIds, homeProfile });
  }
  const conceptsPlacedByProfile = new Map();
  for (const { concept, homeProfile } of admissible) {
    if (homeProfile) continue;
    for (const profile of concept.profiles || []) {
      conceptsPlacedByProfile.set(profile, (conceptsPlacedByProfile.get(profile) || 0) + 1);
    }
  }
  for (const { concept, evidenceIds, homeProfile } of admissible) {
    const profileIsRepresented = homeProfile
      || (concept.profiles || []).some((profile) => (conceptsPlacedByProfile.get(profile) || 0) >= CROSS_PROFILE_MIN_CONCEPTS);
    if (!profileIsRepresented) continue;
    byLabel.set(concept.label.toLowerCase(), { label: concept.label, evidenceIds, provenance: 'model_inferred', homeProfile });
  }
  for (const topic of topics) {
    const label = clean(topic.text || topic.editorialText || topic.topic || editorialTopicLabel(topic, evidence));
    // canHeadlineTopic judges whether a sentence could head a topic; this also
    // requires the result to read as a subject rather than as something said,
    // so the summary screen holds to the same bar as the discussion screen.
    if (!label || !canHeadlineTopic(label) || !isPublishableTopicLabel(label) || !labelNamesAWorkstream(label)) continue;
    // A heading is a claim that somebody wrote this. A turn-derived label is a stopword
    // filter's output, and publishing it as a workstream is how "The carpet lives fight
    // another year" became a topic, an objective and a line of a summary. The cluster
    // itself stays available to the discussion planner; it just doesn't get to head the
    // summary screen on the strength of a quotation.
    if (labelIsTurnDerived(label, topic, evidence)) continue;
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
  // Keyed by the EXACT workstream label each sentence was written for. These were loose
  // substring regexes - /timing/, /preparation/, /responsibilities/ - and every new
  // label was a collision waiting: "Timing and running order" on a webinar rehearsal
  // matched /audit scope|timing|logistics/ and put "Audit planning covered scope, timing,
  // site logistics..." into the rehearsal's summary. A canned sentence written for one
  // concept must be reachable from that concept alone.
  const rules = new Map([
    ['Goods flow and storage', 'The goods-flow evidence covered supplier origin, fiscal clearance, warehousing and final storage arrangements.'],
    ['Importer-obligation QMS procedure design', 'Procedure design depends on understanding the client\'s operational workflows, checks, document control and manual processes.'],
    ['MDR, PPE and declarations of conformity', 'The regulatory evidence covered MDR/PPE treatment, product rationale and declarations-of-conformity requirements.'],
    ['EUDAMED, HPRA and registration evidence', 'Registration evidence and authorised-representative follow-up were material to the importer-obligation work.'],
    ['Language and country requirements', 'Country and language evidence was needed to assess translation, label and market requirements.'],
    ['MedEnvoy and Cody alignment', 'MedEnvoy/Cody alignment remained relevant to scope, existing activity and follow-up planning.'],
    ['Further process discovery and working sessions', 'Further process-discovery work was needed to complete the operational understanding.'],
    ['Audit scope, timing and logistics', 'Audit planning covered scope, timing, site logistics and the practical preparation timetable.'],
    ['Software deep-dive role and responsibilities', 'The audit team needed to align the specialist software coverage and related responsibilities.'],
    ['Preparation, confidentiality and document access', 'Preparation depended on confidentiality, training and document-access steps being in place.'],
    ['Risk analysis and audit-planning evidence', 'Risk-analysis and audit-planning material shaped the preparation required before the audit.'],
    ['Alarm-code and clinical confirmation', 'Alarm-code and clinical-confirmation evidence was material to the software-change package.'],
    ['Debug and test-script evidence', 'Debug and test-script evidence was needed to support the software-change record.'],
    ['Change control and version traceability', 'Change-control and version-traceability evidence was central to closing the software-change package.'],
    ['Electrical compliance evidence', 'Electrical compliance evidence remained a material technical-file workstream.'],
    ['Cybersecurity, USB and GUI controls', 'Cybersecurity, USB and GUI-control evidence remained relevant to the technical-file review.'],
    ['Standards and risk-management work', 'Standards and risk-management evidence remained part of the technical-file closure work.']
  ]);
  return rules.get(clean(label)) || '';
}

function sentenceFromWorkstream(workstream, evidence) {
  // The canned concept sentences are written for their home profile's subject matter -
  // "The goods-flow evidence covered supplier origin, fiscal clearance..." is about
  // importer meetings and nothing else. When cross-profile concepts were opened up, this
  // table became reachable from any meeting, and a webinar rehearsal got that sentence in
  // its summary: another domain's canned prose, the leakage class every guarantee in
  // meetingPurpose.js exists to prevent. A workstream that travelled speaks only through
  // this meeting's own evidence below.
  const conceptSentence = workstream.homeProfile === false ? '' : conceptSentenceForWorkstream(workstream.label);
  if (conceptSentence) return { text: conceptSentence, composed: true };
  const events = materialEvents(evidence, workstream.evidenceIds);
  const consequential = events.find((event) => MATERIAL_CUES.test(event.text)) || events[0];
  if (!consequential) return '';
  let text = clean(consequential.text)
    .replace(/^(?:yeah|yes|okay|ok|right|so|well|like)[,;:\s]+/i, '')
    .replace(/\s+/g, ' ')
    .replace(/[.?!]+$/, '');
  if (text.length > 190) text = `${text.slice(0, 187).replace(/\s+\S*$/, '')}...`;
  // Quoted, not composed. This is a turn from the meeting with its leading "yeah" removed
  // and a full stop added, which is the right raw material for an index into the evidence
  // and is not prose. Marked as such so the summary can tell the difference.
  return text ? { text: `${text.charAt(0).toUpperCase()}${text.slice(1)}.`, composed: false } : null;
}

function buildMeetingSpineItems(evidence, workstreams) {
  return (workstreams || [])
    .map((workstream, index) => {
      const sentence = sentenceFromWorkstream(workstream, evidence);
      const text = sentence?.text || '';
      if (!text) return null;
      return {
        id: `initial_spine_${index + 1}`,
        text,
        composed: Boolean(sentence.composed),
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


// What a meeting was about, for a title that does not say - "Project Check In", "Status
// Review". The object has to come from the meeting itself, and there are two places to
// look, in this order:
//
//   the meeting's own actions, which are already screened for presentation and are the
//   most concrete thing it produced; then
//   the nouns the meeting keeps returning to, which is the same evidence
//   namesARecurringSubject uses, read forwards instead of backwards.
//
// Deliberately NOT the curated concept buckets. Those are broad labels that produce
// nothing for most transcripts and only twenty-six distinct sentences across the rest, and
// a purpose built from them is the sentence commit 7c2d17aa deleted for being identical on
// every meeting that reached it.
function subjectFromMeeting(evidence, actions = []) {
  const events = (evidence && evidence.events) || [];
  const texts = (Array.isArray(actions) ? actions : [])
    .map((item) => clean(typeof item === 'string' ? item : item && item.action))
    .filter(Boolean);
  for (const action of texts) {
    if (objectivePresentationFault(action)) continue;
    if (!namesARecurringSubject(action, events, null)) continue;
    const subject = actionObjectPhrase(action);
    if (subject) return subject;
  }
  return '';
}

// The object of an imperative, by grammar rather than by a list of known verbs - which is
// why the dead actionSubject below never worked: its allowlist has no fix, call, update,
// draft or chase. A leading word followed by a determiner is a verb; anything else is
// declined rather than guessed at.
const IMPERATIVE_THEN_DETERMINER = /^(?:[A-Za-z][a-z']*\s+and\s+)?[A-Za-z][a-z']*\s+(?=(?:the|a|an|our|their|its|his|her|this|these|those)\b)/i;

function actionObjectPhrase(action) {
  let text = clean(action)
    // The deadline was cut off and left its preposition behind: "Draft and send the
    // release note by". Published actions still carry these; fixing it at source moves
    // every action in the corpus and belongs in its own change.
    .replace(/\s+\b(?:by|on|at|to|for|with|in|from)\s*$/i, '');
  if (!IMPERATIVE_THEN_DETERMINER.test(text)) return '';
  text = text.replace(IMPERATIVE_THEN_DETERMINER, '');
  text = text.split(/[;,]|\s+(?:once|after|before|until|when|unless|so that)\s+/i)[0];
  text = text.split(/\sand\s(?=[a-z]+\s(?:the|a|an|it)\b)/)[0];
  text = clean(text.split(/\s+(?:to|by|for|with|from|into|onto|about)\s+/i)[0]);
  // When the action was due is not what it was about. "Rerun the regression suite tomorrow
  // morning" is about the regression suite; the rest is a deadline that survived because
  // the object extractor stops at prepositions and this one has none.
  text = clean(text.replace(/\s+\b(?:today|tomorrow|tonight|yesterday|this|next|last)\b(?:\s+\b(?:morning|afternoon|evening|week|month|quarter|year|thing|monday|tuesday|wednesday|thursday|friday)\b)?\s*$/i, ''));
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 6) return '';
  if (/\b(?:I|we|our|my|your|you)\b/i.test(text)) return '';
  return text;
}

function buildPurpose(meeting, profileId, mode, spine, workstreams, evidence, actions = []) {
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
  // Somebody said why they were meeting. Nothing beats that: it is the meeting's own
  // answer, it is grounded in a turn we can cite, and it is the one purpose that is
  // certainly about this meeting rather than about meetings of this shape.
  const stated = statedPurposeFromOpening(evidence);
  if (stated) {
    // Somebody said why they were meeting, and that stays the best source there is. But
    // "the meeting's own answer" and "publishable as a sentence of minutes" are different
    // properties, and conflating them put "Land it tonight because the rights take weeks."
    // at the top of a pantomime society's minutes - an imperative with a bare "it" whose
    // referent is in the room, not on the page. So the quote keeps its protection only
    // when it reads as minutes: a stated purpose carrying a voice, reference or truncation
    // fault stays the fallback text but downgrades to 'evidence_grounded', which lets the
    // cited polish compose a purpose FROM the stated turn without ever losing it - the
    // turn is in the evidence pack, and the citation validators hold the composition to it.
    const statedFaults = minutesEnglishFaults(stated.text)
      .filter((fault) => ['voice', 'referential', 'truncation'].includes(fault.severity));
    return {
      text: stated.text,
      evidenceIds: stated.evidenceIds.length ? stated.evidenceIds : evidenceIds,
      provenance: 'transcript_emergent',
      confidence: 0.9,
      purposeSource: 'stated_in_meeting',
      statedBy: stated.speaker,
      purposeReplacementPolicy: statedFaults.length ? 'evidence_grounded' : 'never'
    };
  }

  let text = config?.purpose ? config.purpose(context) : '';
  // A profile purpose is identical for every meeting of that type, so on its
  // own it tells the reader nothing about the meeting in front of them. Keep
  // the framing — the profile does know this was a rehearsal, an audit plan and
  // so on — and add one sentence of what this meeting actually covered.
  if (text) {
    // Action subjects are the right length for an objective and too long for a
    // purpose sentence — clipping them to fit breaks the phrase mid-noun. The
    // concept description is always well-formed, so it carries the second
    // sentence while the objectives carry the detail.
    const covered = describeDiscussedConcepts(evidence);
    // Flagged like every other purpose nobody stated. This sentence is keyed to the
    // meeting type, so it is the same words for every meeting of that type and it is not
    // drawn from this meeting at all - and until now it was the ONE purpose category that
    // shipped without a flag, which meant the purposes we are least sure of were the only
    // ones we asserted.
    return { text: covered ? `${text} ${covered}` : text, evidenceIds, provenance: 'model_inferred', confidence: 0.76, inferred: true, purposeSource: 'meeting_type_profile' };
  }

  // No profile either, so fall back to what the meeting was called. The title is the
  // reviewer's own words - they confirm it on the first screen - and it is very often the
  // best short statement of why people met that exists anywhere. It reached profile
  // matching, organisation extraction and topic ordering, and never the purpose itself,
  // which is why choosing a good title changed nothing about the sentence at the top.
  //
  // Read first, quoted second. "Northbridge Release Planning" is a label; "Plan the
  // Northbridge release" is a purpose, and the difference is only that the shape word at
  // the end has been turned into a verb. Where the title names nothing of its own
  // ("Project Check In") the object comes from the meeting instead.
  const shaped = purposeFromTitleShape(meeting, evidence, () => subjectFromMeeting(evidence, actions));
  if (shaped) {
    return {
      text: shaped.text,
      evidenceIds,
      provenance: 'inferred_from_discussion',
      confidence: shaped.source === 'title_transform_enriched' ? 0.55 : 0.6,
      inferred: true,
      purposeSource: shaped.source,
      // The title read as a purpose is a stand-in for a purpose nobody stated. It is not
      // ours to copy-edit (purposeIsAuthoredElsewhere), but it IS replaceable by a
      // better-evidenced paragraph, provided that paragraph cites the meeting's own turns
      // and passes the citation validators - the reviewer asked for exactly this. The
      // policy is carried on the object because a list in routes/api.js describing
      // objects built here is how MODE_CONFIG escaped its own source check.
      purposeIsAuthoredElsewhere: true,
      purposeReplacementPolicy: 'evidence_grounded'
    };
  }
  const fromTitle = purposeFromTitle(meeting);
  if (fromTitle) {
    return {
      text: fromTitle.text,
      evidenceIds,
      provenance: 'inferred_from_discussion',
      confidence: 0.5,
      inferred: true,
      purposeSource: 'meeting_title',
      purposeIsAuthoredElsewhere: true,
      purposeReplacementPolicy: 'evidence_grounded'
    };
  }
  // No profile purpose, so nothing frames this meeting for us. What was left here said
  // "Coordinate the meeting's main workstreams, dependencies and next steps around X and
  // Y" - our own vocabulary, describing our pipeline rather than the client's meeting,
  // and the same sentence for every meeting that reached it. The commit that removed the
  // other pipeline-shaped purpose left this one because it exits before that check.
  //
  // The labels are broad concept buckets, so joining two of them with "and" produced
  // "around quality and risk management and customer and stakeholder feedback", which
  // cannot be parsed: the labels contain "and" themselves. joinConceptLabels, forty lines
  // above, exists precisely for that and was never called here.
  //
  // So it is removed rather than reworded, and an unprofiled meeting falls through to the
  // block below - which already says what was discussed, marks the purpose as inferred
  // rather than stated, and raises the flag that asks the reviewer for the real one. That
  // is the honest answer to "we do not know why this meeting was held", and it was
  // sitting one branch away the whole time.

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
    describedFromDiscussion: Boolean(described),
    purposeSource: described ? 'described_from_discussion' : 'none'
  };
}

// Leading verbs on an extracted action, stripped so the action's subject can
// follow the profile's own intent verb without reading as two verbs in a row.
const ACTION_LEAD_VERB = /^(?:building|build|restoring|restore|putting|put|starting|start|writing|write|keeping|keep|handling|handle|running|run|finding|find|grouping|group|covering|cover|monitoring|monitor|circulating|circulate|verifying|verify|taking|take|sending|send|sharing|share|reviewing|review|confirming|confirm|and)\s+/i;

function actionSubject(action) {
  let text = clean(action);
  for (let pass = 0; pass < 3 && ACTION_LEAD_VERB.test(text); pass += 1) text = text.replace(ACTION_LEAD_VERB, '');
  // Keep the first clause: an action often carries a second, unrelated half.
  text = text.split(/[;,]\s|\sand\s(?=[a-z]+\s(?:the|a|an)\b)/)[0];
  text = text.replace(/^(?:the|a|an)\s+/i, '').trim();
  if (!text) return '';
  return /^[A-Z]{2,}/.test(text) ? text : text.charAt(0).toLowerCase() + text.slice(1);
}

// The meeting-type profile knows the shape of the meeting and supplies the
// intent verb; the meeting's own actions supply the subject. Neither half is
// written here, so a profile still contributes no content of its own — which is
// the rule meetingPurpose.js states and MODE_CONFIG's fixed objectives broke.
// An objective is read by the client, so it is held to the same presentation bar as a
// published action. Drawing objectives from the meeting's own actions is what makes them
// specific, but it inherits whatever debris the extractor left in the phrase: on one
// weekly the first hinted action produced the objective "Follow follow up with Colm as
// well". stagedFinalActionQualityIssue already names those faults - adjacent duplicated
// words, a vague predicate, a conditional opening - so the objective builder asks it
// rather than growing its own opinion about wording.
function objectivePresentationFault(action) {
  return Boolean(stagedFinalActionQualityIssue({ owner: 'Not stated', action, deadline: 'Not stated' }));
}

// Actions arrive as {action, evidenceIds} pairs; bare strings are tolerated for old
// callers and tests, carrying no ids.
function normaliseActionSignals(actions) {
  return (Array.isArray(actions) ? actions : [])
    .map((item) => (typeof item === 'string'
      ? { action: clean(item), evidenceIds: [] }
      : { action: clean(item && item.action), evidenceIds: Array.isArray(item && item.evidenceIds) ? item.evidenceIds : [] }))
    .filter((item) => item.action);
}

function deriveObjectivesFromActions(actions, topicHints) {
  const available = normaliseActionSignals(actions);
  const used = new Set();
  const derived = [];
  for (const hint of Array.isArray(topicHints) ? topicHints : []) {
    const match = available.find((item) => hint.pattern.test(item.action) && !used.has(item.action) && !objectivePresentationFault(item.action));
    if (!match || match.action.split(/\s+/).length < 3) continue;
    used.add(match.action);
    // The action is already a well-formed phrase. Prefixing the hint's intent
    // verb produced "Confirm the continue reviewing the USB port controls";
    // the profile's job here is choosing and ordering which actions surface,
    // not supplying a second verb. A gerund opening is normalised so the list
    // reads as objectives rather than as a progress report.
    // Each objective carries ITS OWN action's evidence - the pooled-ids shortcut made
    // every objective cite the same generic set, which reads as citation and means
    // nothing, and citation-checked composition downstream needs the real trail.
    derived.push({ text: asObjectivePhrase(match.action), evidenceIds: match.evidenceIds });
    if (derived.length >= 8) break;
  }
  return derived;
}

// One objective per detected workstream, action-first. The target shape came from a
// reviewer's own exemplar for a multi-workstream weekly: eight lines, each "Review/
// Confirm {the thing}", each a real thread of the meeting. An action that shares
// evidence with the workstream states it best; where none does, the intent verb plus the
// workstream's own label is a true, editable line - template verb plus evidence-derived
// label, never profile prose.
function objectivesPerWorkstream(workstreams, actions, topicHints, alreadyUsedTexts) {
  const available = normaliseActionSignals(actions);
  const used = new Set(alreadyUsedTexts);
  const derived = [];
  for (const workstream of Array.isArray(workstreams) ? workstreams : []) {
    if (derived.length >= 8) break;
    const workstreamIds = new Set(workstream.evidenceIds || []);
    const match = available.find((item) => !used.has(item.action)
      && !objectivePresentationFault(item.action)
      && item.action.split(/\s+/).length >= 3
      && item.evidenceIds.some((id) => workstreamIds.has(id)));
    if (match) {
      used.add(match.action);
      derived.push({ text: asObjectivePhrase(match.action), evidenceIds: match.evidenceIds });
      continue;
    }
    const intent = objectiveIntentForText(topicHints, workstream.label);
    const text = `${intent} ${workstream.label.charAt(0).toLowerCase()}${workstream.label.slice(1)}.`;
    if (used.has(text)) continue;
    used.add(text);
    derived.push({ text, evidenceIds: unique(workstream.evidenceIds || []).slice(0, 6) });
  }
  return derived;
}

const GERUND_TO_IMPERATIVE = {
  building: 'Build', putting: 'Put', restoring: 'Restore', starting: 'Start', writing: 'Write',
  keeping: 'Keep', handling: 'Handle', running: 'Run', finding: 'Find', grouping: 'Group',
  covering: 'Cover', monitoring: 'Monitor', circulating: 'Circulate', verifying: 'Verify',
  taking: 'Take', sending: 'Send', sharing: 'Share', reviewing: 'Review', confirming: 'Confirm',
  completing: 'Complete', continuing: 'Continue', updating: 'Update', checking: 'Check'
};

function asObjectivePhrase(action) {
  const text = clean(action);
  const [first, ...rest] = text.split(/\s+/);
  const imperative = GERUND_TO_IMPERATIVE[first.toLowerCase()];
  const phrase = imperative ? [imperative, ...rest].join(' ') : text;
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

function buildObjectives(profileId, workstreams, purpose, actions = [], topicHints = []) {
  const pooledIds = unique(workstreams.slice(0, 4).flatMap((item) => item.evidenceIds || [])).slice(0, 10);
  // Objectives drawn from this meeting's own actions beat a fixed list every
  // time: the fixed list is identical for every meeting of the same type. Hint-selected
  // actions first (profile ordering), then one line per remaining workstream, to eight.
  const hinted = deriveObjectivesFromActions(actions, topicHints);
  const perWorkstream = objectivesPerWorkstream(workstreams, actions, topicHints, hinted.map((item) => item.text));
  const derived = [...hinted, ...perWorkstream].slice(0, 8);
  if (derived.length) {
    return derived.map((item, index) => ({
      text: item.text,
      evidenceIds: item.evidenceIds.length ? item.evidenceIds : (pooledIds.length ? pooledIds : purpose.evidenceIds),
      provenance: 'transcript_emergent',
      id: `initial_objective_${index + 1}`
    }));
  }
  const configObjectives = MODE_CONFIG[profileId]?.objectives || [];
  if (configObjectives.length) {
    return configObjectives.slice(0, 4).map((text, index) => ({
      text,
      evidenceIds: pooledIds.length ? pooledIds : purpose.evidenceIds,
      provenance: 'model_inferred',
      id: `initial_objective_${index + 1}`
    }));
  }
  return [];
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

function buildInitialUnderstanding({ evidence, meeting = {}, topics = [], meetingSpine = null, actions = [] } = {}) {
  const plan = purposePlan(meeting);
  const profileId = plan?.profileId || meetingSpine?.purposeProfile || '';
  const topicWorkstreams = (topics || []).map((topic) => ({
    label: clean(topic.text || topic.editorialText || topic.topic),
    evidenceIds: topic.evidenceIds || [],
    // Carried so labelIsTurnDerived can see where the label came from. This map used to
    // strip the topic down to {label, evidenceIds}, which quietly defeated any provenance
    // check downstream: with no representativeText the label could not be compared with
    // its own extraction, so a quotation-derived heading sailed through here while the
    // identical check caught it on the other admission path.
    representativeText: topic.representativeText,
    provenance: 'transcript_emergent'
  })).filter((item) => item.label && canHeadlineTopic(item.label) && isPublishableTopicLabel(item.label) && labelNamesAWorkstream(item.label) && !labelIsTurnDerived(item.label, item, evidence));
  const workstreams = inferredWorkstreamsFromEvidence(evidence, [...topicWorkstreams, ...(topics || [])], profileId);
  const selectedWorkstreams = (workstreams.length ? workstreams : topicWorkstreams).slice(0, 8);
  const mode = inferMeetingMode(meeting, profileId, evidence);
  const spine = buildMeetingSpineItems(evidence, selectedWorkstreams);
  const purpose = buildPurpose(meeting, profileId, mode, spine, selectedWorkstreams, evidence, actions);
  const objectives = buildObjectives(profileId, selectedWorkstreams, purpose, actions, plan?.topicHints || []);
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
  siteFromMeeting, subjectFromMeeting, actionObjectPhrase, joinConceptLabels };
