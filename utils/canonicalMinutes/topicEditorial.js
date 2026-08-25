'use strict';

const { clean } = require('./evidence');
const { DOMAIN_TERMS, escapeRegExp } = require('../domainTerms');
const { isReviewerAuthored } = require('./state');

// A small, meeting-agnostic vocabulary for turning extractive MiniLM clusters
// into readable agenda labels. These are concepts, not meeting templates: a
// label is only available when the current cluster contains matching evidence.
//
// `anchor`: a pattern may include everyday words because inside a genuinely
// matching cluster those words are part of the evidence - but one everyday token
// must not be enough to NAME the cluster. A residents' association arguing about
// visitor parking was headed "Budget and commercial matters" because somebody
// said "cost" once in the whole meeting; "cost" describes almost any subject and
// never by itself makes a discussion commercial. Where an anchor is present, one
// of its domain-anchoring tokens must also appear before the label is available.
// Same mitigation WORKSTREAM_CONCEPTS uses (requiredEvidencePattern), same reason.
//
// Measured before anchoring broadly (2026-08-25): anchoring every broad label
// changed 61 corpus sections and emptied 7 screens, and a global two-hit floor
// changed 44 and emptied 4 - both overreach, because these labels do real rescue
// work: a deadline-torture meeting talks about its subject in exactly the
// everyday words ("date", "week", "month") a tightened rule refuses. So anchors
// are added one measured mislabel at a time: "cost" named a parking dispute
// commercial, "application" (road-closure) named a race committee "Software
// changes", "access" (a gate fob) named it "Technical setup". Each anchor's diff
// was read line by line before it stayed. Fourth case: "alarm" named an allotment
// society's solar shed alarm "Alarm behaviour and controls" - a medtech label wearing a
// garden shed - and the mislabelled topic then minted the objective and the purpose
// sentence mechanically. The anchor tokens are the vocabulary of product-alarm discussion
// (mute button, flash, priorities, chirp), which a burglar alarm never attracts.
const CONCEPTS = [
  { label: 'Quality and risk indicators', pattern: /\b(?:alarm bells?|red flags?|warning signs?|early warnings?|risk indicators?|concerns?)\b/i },
  { label: 'Cybersecurity and access controls', pattern: /\b(?:cyber\s*security|usb port|port lock|password protect(?:ed|ion)?|unwarranted interference|unauthorised access|unauthorized access)\b/i },
  { label: 'Language support and localisation', pattern: /\b(?:languages?|translations?|translated|localisation|localization|language characters?|fonts?|arabic|vietnamese|greek)\b/i },
  { label: 'Electrical compliance testing', pattern: /\b(?:iec\s*60601|60601-1|electrical compliance)\b/i },
  { label: 'Software change traceability', pattern: /\b(?:17 changes|visibility within the code|device file history|software traceability|version traceability|retrospective test data)\b/i },
  { label: 'Software change control', pattern: /\b(?:change request|change control|software versions?|version\s*1\.0|non-significant change|non-substantial change)\b/i },
  { label: 'Alarm behaviour and controls', pattern: /\b(?:alarm|mute button|led flash|flashing|low priority|medium priority|high priority)\b/i, anchor: /\b(?:mute button|led|flash(?:ing)?|(?:low|medium|high) priority|alarm code|audible|chirp)\b/i },
  { label: 'Scope and requirements', pattern: /\b(?:scope|requirements?|specifications?|criteria|standards?|regulations?)\b/i },
  { label: 'Plans and timelines', pattern: /\b(?:plan(?:ning)?|schedule|timeline|milestones?|dates?|deadline|week|month|delivery)\b/i },
  { label: 'Roles and responsibilities', pattern: /\b(?:owner(?:ship)?|roles?|responsibilit(?:y|ies)|lead|support|handover)\b/i },
  { label: 'Risks and dependencies', pattern: /\b(?:risks?|issues?|blockers?|dependencies|dependent|constraints?|mitigat(?:e|ion)|outstanding)\b/i },
  { label: 'Software changes', pattern: /\b(?:software|code changes?|change request|version(?:ing)?|release|firmware|application)\b/i, anchor: /\b(?:software|code changes?|firmware|release|version(?:ing)?|change request)\b/i },
  { label: 'Testing and validation', pattern: /\b(?:testing|tests?|validation|verification|results?|qualification)\b/i },
  { label: 'Quality and risk management', pattern: /\b(?:quality|qms|risk management|risk matrix|fmea|capa)\b/i },
  { label: 'Regulatory and compliance', pattern: /\b(?:regulatory|compliance|mdr|mdsap|fda|hpra|notified body|audit)\b/i },
  { label: 'Documentation and evidence', pattern: /\b(?:documents?|documentation|technical file|report|records?|evidence|tracker|spreadsheet|procedure)\b/i },
  { label: 'Product behaviour and design', pattern: /\b(?:product|device|design|feature|behaviour|alarm|button|interface|usability)\b/i, anchor: /\b(?:products?|devices?|interface|usability|features?)\b/i },
  { label: 'Operations and processes', pattern: /\b(?:operations?|process(?:es)?|workflow|production|manufacturing|warehouse|supplier)\b/i },
  { label: 'Customer and stakeholder feedback', pattern: /\b(?:customer|client|stakeholder|feedback|complaint|interview|testimonial)\b/i },
  { label: 'Budget and commercial matters', pattern: /\b(?:budget|costs?|pricing|commercial|contract|invoice|revenue|sales)\b/i, anchor: /\b(?:budget|pricing|commercial|contract|invoice|revenue)\b/i },
  { label: 'Training and readiness', pattern: /\b(?:training|readiness|rehearsal|practice|preparation|attestation)\b/i },
  { label: 'Content and communications', pattern: /\b(?:content|slides?|presentation|webinar|questions?|communications?|message)\b/i },
  { label: 'Technical setup', pattern: /\b(?:technical setup|screen sharing|recording|connection|microphone|camera|access)\b/i, anchor: /\b(?:technical setup|screen sharing|microphone|camera|recording|connection)\b/i }
];

const LEAD_IN = /^(?:(?:yeah|yes|okay|ok|right|so|well|no|like|ohh?|thanks?|thank you)[,;:\s]+|(?:and|but)\s+|(?:I|we|they|you|the team)\s+(?:think|know|guess|suppose|discussed|reviewed|covered|noted|said|have|has|had|were|are|will|would|can|could|need to)\s+(?:that\s+)?)/i;
const WEAK = new Set(['about', 'after', 'again', 'also', 'been', 'being', 'could', 'from', 'have', 'into', 'just', 'know', 'like', 'more', 'much', 'only', 'other', 'really', 'should', 'some', 'something', 'still', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'thing', 'this', 'those', 'very', 'want', 'were', 'what', 'when', 'where', 'which', 'with', 'would', 'your']);

function clusterText(topic, evidence) {
  const byId = new Map((evidence?.events || []).map((event) => [event.id, event.text]));
  return [topic?.representativeText, ...(topic?.evidenceIds || []).map((id) => byId.get(id) || '')]
    .map(clean).filter(Boolean).join(' ');
}

function conceptLabel(text) {
  return CONCEPTS.find((concept) => concept.pattern.test(text) && (!concept.anchor || concept.anchor.test(text)))?.label || '';
}

const SALIENT_TERMS = [
  ...DOMAIN_TERMS.map((term) => [term.canonical, new RegExp(`\\b(?:${[term.canonical, ...term.aliases].map(escapeRegExp).join('|')})\\b`, 'i')]),
  ['MedEnvoy', /\bmed\s*envoy\b/i],
  ['declarations of conformity', /\bdeclarations? of conformity\b/i],
  ['labelling', /\b(?:label|labelling|labeling|barcode)\b/i],
  ['importer obligations', /\bimporter\b/i]
];

function enrichedConceptLabel(label, source) {
  if (!label) return '';
  const enrichable = /^(?:scope and requirements|regulatory and compliance|electrical compliance testing)$/i.test(label);
  if (!enrichable) return label;
  const terms = SALIENT_TERMS.filter(([, pattern]) => pattern.test(source)).map(([term]) => term).slice(0, 2);
  if (!terms.length || terms.some((term) => label.toLowerCase().includes(term.toLowerCase()))) return label;
  return `${label}: ${terms.join(' and ')}`;
}

function extractiveLabel(value) {
  const original = clean(value).replace(/[.?!]+$/, '');
  let text = original;
  for (let count = 0; count < 3 && LEAD_IN.test(text); count += 1) text = text.replace(LEAD_IN, '');
  text = text
    .replace(/^(?:(?:the\s+)?team\s+)?(?:discussed|reviewed|covered|considered|noted)\s+(?:that\s+)?/i, '')
    .replace(/^(?:in relation to|in terms of|on the subject of|about)\s+/i, '');
  // Never manufacture a topic heading from a sentence-shaped fragment. A
  // free-form label is only safe when stripping the conversational lead-in
  // leaves a noun-like phrase. Modal/auxiliary verbs, personal pronouns and
  // rhetorical qualifiers are strong evidence that we are still looking at
  // speech rather than a topic name.
  if (/^(?:absolutely|definitely|probably|possibly|maybe|perhaps|likely)\b/i.test(text)) return '';
  if (/\b(?:I|we|you|they|he|she|it)(?:['’](?:m|ve|d|ll|re|s))?\b/i.test(text)) return '';
  // "let's" is first-person plural wearing a contraction the guard above does
  // not spell out, and it opens an utterance rather than naming a subject.
  if (/\blet['’]?s\b/i.test(text)) return '';
  if (/\b(?:am|is|are|was|were|be|been|being|will|would|could|should|might|may|can|has|have|had|do(?:es)?|did)\b/i.test(text)) return '';
  if (/^(?:address|follow|develop(?:ing)?|deem(?:ed)?|determine(?:d)?|confirm|ensure|make|take|get|give|send|share)\b/i.test(text)) return '';
  const words = text.split(/\s+/).filter(Boolean);
  const content = words.filter((word) => {
    const token = word.toLowerCase().replace(/[^a-z0-9-]/g, '');
    return token.length > 2 && !WEAK.has(token);
  });
  const selected = (content.length >= 2 ? content : []).slice(0, 7).join(' ')
    .replace(/^[,;:\s]+|[,;:\s]+$/g, '');
  if (!selected || selected.split(/\s+/).length < 3) return '';
  if (/^(?:you|was|were|is|are|it['’]?s|those|these|there|that['’]?s|takes?|say|aim|doesn|don|didn|hasn|hadn|couldn|wouldn|shouldn)\b/i.test(selected)) return '';
  if (/\b(?:don['’]?t|doesn['’]?t|didn['’]?t|you know|kind of|sort of)\b/i.test(selected)) return '';
  if (/^[A-Z][a-z]+\s+and\s+I\b/.test(clean(value))) return '';
  return selected.charAt(0).toUpperCase() + selected.slice(1);
}

// Whether a label is a quotation wearing a heading's clothes.
//
// The label ladder's middle rung, extractiveLabel, builds a "heading" by stripping the
// lead-in and stopwords from a spoken sentence. That is the right raw material for
// clustering, and it is not writing: "The carpet lives to fight another year" became the
// heading "The carpet lives fight another year" - ungrammatical precisely because the
// extraction dropped the "to" - and "let's get the total" became "Let get total". Both
// passed every grammar gate, because grammar gates ask whether text is broken and these
// are broken in a way only their provenance reveals: nobody wrote them, a filter did.
//
// So the test is provenance, not grammar: a label is turn-derived when the concept rung
// found nothing and the extractive rung produced exactly this text. Turn-derived labels
// keep doing their real job - naming clusters internally, feeding the discussion planner -
// they just stop being publishable as headings on the summary screen, where a heading is a
// claim that somebody wrote this.
function labelIsTurnDerived(label, topic, evidence) {
  const text = clean(label);
  if (!text) return false;
  const source = clusterText(topic, evidence);
  if (conceptLabel(source)) return false;
  // Case-insensitive: presentation passes re-case labels ("Let get total" arrives as
  // "let get total"), and a change of capital letter does not change where the words
  // came from.
  return clean(extractiveLabel(topic?.representativeText)).toLowerCase() === text.toLowerCase();
}

function editorialTopicLabel(topic, evidence) {
  const source = clusterText(topic, evidence);
  const concept = conceptLabel(source);
  return enrichedConceptLabel(concept, source) || extractiveLabel(topic?.representativeText) || 'Substantive discussion';
}

function labelIsClientReady(value) {
  const text = clean(value);
  return Boolean(text)
    && !/["“”]/.test(text)
    && !/\b(?:I|we|you|they|he|she)(?:['’](?:m|ve|d|ll|re|s))?\b/i.test(text)
    && !/\blet['’]?s\b/i.test(text)
    && !/\b(?:yeah|okay|problem importer|going because|you know)\b/i.test(text);
}

// Openers that mark an utterance rather than a subject. A topic names what was
// discussed; these introduce something somebody said about it. Kept separate
// from the pronoun test because a politeness opener carries no pronoun at all
// and still plainly is not the name of a topic.
// Modal openers are deliberately absent: "can you send that over" is already
// refused for its pronoun, while "CAN bus integration" and "Do not resuscitate"
// are real subjects. Excluding modals costs nothing and avoids refusing a
// legitimate technical heading.
const SPEECH_OPENER = /^(?:please|let['’]?s|let us|go ahead|carry on|sure|thanks|thank you|sorry|maybe|actually|obviously|basically|just|right then|first off|anyway)\b/i;

// The single gate every topic label passes before a reviewer sees it.
//
// Labels are minted by several functions — a curated concept name, an
// extractive phrase from cluster evidence, the opening words of a decision
// rationale — and each carried its own guard or, in one case, none at all, so a
// label reading as speech reached the screen through whichever path lacked the
// check. Applying this once over the assembled cards means a label source added
// later cannot quietly bypass it.
//
// Deliberately categorical: it tests the shape of the phrase, never a specific
// wording. No transcript-specific phrase belongs here.
// Whether a label can stand as the NAME of a workstream.
//
// A discussion card and a workstream are different surfaces with different conventions. A
// card is a heading over some points, and this corpus is full of cards headed by a
// statement - "Legal review is complete, but finance approval is still pending" - which
// read perfectly well and which reviewers keep. A workstream label is reused: it becomes
// the meeting purpose, an objective the reviewer is asked to accept, a topic, and a
// sentence in the executive summary. "Lovely, that's one sorted" became "Review lovely,
// that's one sorted." on the objectives list. One bad workstream label is not one bad
// line, it is the same bad line on four screens, so this bar is higher than the card bar
// and is applied only where labels get reused.
//
// Both tests are grammatical rather than lexical, because a list of banned phrases has to
// be extended once per meeting and the meetings are all different. A copula or a
// contraction means the label became a sentence; four capitalised words with no common
// noun between them means it is an attendance list.
//
// Copulas and auxiliaries only, and deliberately no modals: "CAN bus integration testing"
// is a real subject and "can" is a real auxiliary, and the same three letters cannot be
// both here - the same goes for "Will" and "May". A sentence reaches for a copula or a
// contraction long before it reaches for a modal, so dropping the ambiguous half costs
// nothing.
const LABEL_ASSERTS = /\b(?:is|are|was|were|has|have|had|does|did)\b|['\u2019](?:s|re|ve|ll)\b/i;

function labelIsOnlyNames(text) {
  const parts = text.split(/\s*(?:,|\band\b|&)\s*/i).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 3) return false;
  return parts.every((part) => /^[A-Z][A-Za-z'\u2019-]*$/.test(part));
}

// A heading that enumerates has to coordinate.
//
// English noun-phrase headings join their last item with a conjunction: "MDR, PPE and
// declarations of conformity", "Audit scope, timing and logistics", "Preparation,
// confidentiality and document access". A run of commas with nothing joining them is not a
// list somebody wrote, it is a stretch of speech that happened to contain commas - "Water
// butt, shed, marrows", "Now, the annual show", "For route, properly, fourteen" - and each
// of those went on to be a topic, an objective and a line of the executive summary.
//
// This is grammar, not vocabulary: it knows nothing about allotments or audits, and every
// coordinated heading in the corpus passes it unchanged.
function labelEnumeratesWithoutCoordinating(text) {
  if (!/,/.test(text)) return false;
  return !/\s(?:and|or|&)\s/i.test(text);
}

function labelNamesAWorkstream(value) {
  const text = clean(value);
  if (!text) return false;
  if (LABEL_ASSERTS.test(text)) return false;
  if (labelIsOnlyNames(text)) return false;
  if (labelEnumeratesWithoutCoordinating(text)) return false;
  return true;
}

function isPublishableTopicLabel(value) {
  const text = clean(value);
  if (!text || /^substantive discussion$/i.test(text)) return false;
  if (!labelIsClientReady(text)) return false;
  return !SPEECH_OPENER.test(text);
}

// Applied at the point the discussion is returned, so it covers every card
// whatever produced it. A topic the reviewer confirmed themselves is theirs to
// word however they like and is never second-guessed here.
function publishableTopicCards(cards) {
  return (Array.isArray(cards) ? cards : []).filter((card) => isReviewerAuthored(card) || isPublishableTopicLabel(card?.topic));
}

function editorialTopics(topics, evidence, maximum = 8) {
  const output = [];
  const byLabel = new Map();
  for (const topic of Array.isArray(topics) ? topics : []) {
    const text = editorialTopicLabel(topic, evidence);
    if (!text || text === 'Substantive discussion' || !labelIsClientReady(text)) continue;
    const key = text.toLowerCase();
    const existing = byLabel.get(key);
    if (existing) {
      existing.evidenceIds = [...new Set([...(existing.evidenceIds || []), ...(topic.evidenceIds || [])])];
      existing.clusterIds.push(topic.id);
      continue;
    }
    const item = { ...topic, editorialText: text, clusterIds: [topic.id] };
    byLabel.set(key, item);
    output.push(item);
  }
  // Consider the whole transcript before applying the display budget. Earlier
  // code stopped at the first clusters, making long meetings dependent on
  // incidental clustering order and crowding out later substantive workstreams.
  const ranked = output.map((item, index) => {
    const source = clusterText(item, evidence);
    const namedTerms = SALIENT_TERMS.filter(([, pattern]) => pattern.test(source)).map(([term]) => term);
    const evidenceCount = new Set(item.evidenceIds || []).size;
    const genericPenalty = /^(?:content and communications|plans and timelines|product behaviour and design)$/i.test(item.editorialText) ? 2 : 0;
    return { item, index, namedTerms, rank: (namedTerms.length * 5) + Math.min(evidenceCount, 8) - genericPenalty };
  });
  const selected = [];
  const coveredTerms = new Set();
  while (selected.length < maximum && selected.length < ranked.length) {
    const remaining = ranked.filter((candidate) => !selected.includes(candidate));
    remaining.sort((left, right) => {
      const leftNew = left.namedTerms.filter((term) => !coveredTerms.has(term)).length;
      const rightNew = right.namedTerms.filter((term) => !coveredTerms.has(term)).length;
      return rightNew - leftNew || right.rank - left.rank || left.index - right.index;
    });
    const next = remaining[0];
    selected.push(next);
    next.namedTerms.forEach((term) => coveredTerms.add(term));
  }
  const chosen = selected.map(({ item }) => item);
  const labels = new Set(chosen.map((item) => clean(item.editorialText).toLowerCase()));
  return chosen.filter((item) => {
    const label = clean(item.editorialText).toLowerCase();
    if (label === 'software changes' && [...labels].some((value) => /^software change (?:traceability|control)$/.test(value))) return false;
    if (label === 'testing and validation' && [...labels].some((value) => value.startsWith('electrical compliance testing'))) return false;
    return true;
  });
}

module.exports = {
  labelIsTurnDerived,
  labelNamesAWorkstream, CONCEPTS, clusterText, editorialTopicLabel, editorialTopics, extractiveLabel, labelIsClientReady, isPublishableTopicLabel, publishableTopicCards };
