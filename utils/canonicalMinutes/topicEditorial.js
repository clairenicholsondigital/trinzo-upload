'use strict';

const { clean } = require('./evidence');
const { DOMAIN_TERMS, escapeRegExp } = require('../domainTerms');

// A small, meeting-agnostic vocabulary for turning extractive MiniLM clusters
// into readable agenda labels. These are concepts, not meeting templates: a
// label is only available when the current cluster contains matching evidence.
const CONCEPTS = [
  { label: 'Cybersecurity and access controls', pattern: /\b(?:cyber\s*security|usb port|port lock|password protect(?:ed|ion)?|unwarranted interference|unauthorised access|unauthorized access)\b/i },
  { label: 'Language support and localisation', pattern: /\b(?:languages?|translations?|translated|localisation|localization|language characters?|fonts?|arabic|vietnamese|greek)\b/i },
  { label: 'Electrical compliance testing', pattern: /\b(?:iec\s*60601|60601-1|electrical compliance)\b/i },
  { label: 'Software change traceability', pattern: /\b(?:17 changes|visibility within the code|device file history|software traceability|version traceability|retrospective test data)\b/i },
  { label: 'Software change control', pattern: /\b(?:change request|change control|software versions?|version\s*1\.0|non-significant change|non-substantial change)\b/i },
  { label: 'Alarm behaviour and controls', pattern: /\b(?:alarm|mute button|led flash|flashing|low priority|medium priority|high priority)\b/i },
  { label: 'Scope and requirements', pattern: /\b(?:scope|requirements?|specifications?|criteria|standards?|regulations?)\b/i },
  { label: 'Plans and timelines', pattern: /\b(?:plan(?:ning)?|schedule|timeline|milestones?|dates?|deadline|week|month|delivery)\b/i },
  { label: 'Roles and responsibilities', pattern: /\b(?:owner(?:ship)?|roles?|responsibilit(?:y|ies)|lead|support|handover)\b/i },
  { label: 'Risks and dependencies', pattern: /\b(?:risks?|issues?|blockers?|dependencies|dependent|constraints?|mitigat(?:e|ion)|outstanding)\b/i },
  { label: 'Software changes', pattern: /\b(?:software|code changes?|change request|version(?:ing)?|release|firmware|application)\b/i },
  { label: 'Testing and validation', pattern: /\b(?:testing|tests?|validation|verification|results?|qualification)\b/i },
  { label: 'Quality and risk management', pattern: /\b(?:quality|qms|risk management|risk matrix|fmea|capa)\b/i },
  { label: 'Regulatory and compliance', pattern: /\b(?:regulatory|compliance|mdr|mdsap|fda|hpra|notified body|audit)\b/i },
  { label: 'Documentation and evidence', pattern: /\b(?:documents?|documentation|technical file|report|records?|evidence|tracker|spreadsheet|procedure)\b/i },
  { label: 'Product behaviour and design', pattern: /\b(?:product|device|design|feature|behaviour|alarm|button|interface|usability)\b/i },
  { label: 'Operations and processes', pattern: /\b(?:operations?|process(?:es)?|workflow|production|manufacturing|warehouse|supplier)\b/i },
  { label: 'Customer and stakeholder feedback', pattern: /\b(?:customer|client|stakeholder|feedback|complaint|interview|testimonial)\b/i },
  { label: 'Budget and commercial matters', pattern: /\b(?:budget|costs?|pricing|commercial|contract|invoice|revenue|sales)\b/i },
  { label: 'Training and readiness', pattern: /\b(?:training|readiness|rehearsal|practice|preparation|attestation)\b/i },
  { label: 'Content and communications', pattern: /\b(?:content|slides?|presentation|webinar|questions?|communications?|message)\b/i },
  { label: 'Technical setup', pattern: /\b(?:technical setup|screen sharing|recording|connection|microphone|camera|access)\b/i }
];

const LEAD_IN = /^(?:(?:yeah|yes|okay|ok|right|so|well|no|like|ohh?|thanks?|thank you)[,;:\s]+|(?:and|but)\s+|(?:I|we|they|you|the team)\s+(?:think|know|guess|suppose|discussed|reviewed|covered|noted|said|have|has|had|were|are|will|would|can|could|need to)\s+(?:that\s+)?)/i;
const WEAK = new Set(['about', 'after', 'again', 'also', 'been', 'being', 'could', 'from', 'have', 'into', 'just', 'like', 'more', 'much', 'only', 'other', 'really', 'should', 'some', 'something', 'still', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'thing', 'this', 'those', 'very', 'want', 'were', 'what', 'when', 'where', 'which', 'with', 'would', 'your']);

function clusterText(topic, evidence) {
  const byId = new Map((evidence?.events || []).map((event) => [event.id, event.text]));
  return [topic?.representativeText, ...(topic?.evidenceIds || []).map((id) => byId.get(id) || '')]
    .map(clean).filter(Boolean).join(' ');
}

function conceptLabel(text) {
  return CONCEPTS.find((concept) => concept.pattern.test(text))?.label || '';
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
  let text = clean(value).replace(/[.?!]+$/, '');
  for (let count = 0; count < 3 && LEAD_IN.test(text); count += 1) text = text.replace(LEAD_IN, '');
  text = text.replace(/^(?:in relation to|in terms of|on the subject of)\s+/i, '');
  const words = text.split(/\s+/).filter(Boolean);
  const content = words.filter((word) => {
    const token = word.toLowerCase().replace(/[^a-z0-9-]/g, '');
    return token.length > 2 && !WEAK.has(token);
  });
  const selected = (content.length >= 2 ? content : words).slice(0, 7).join(' ')
    .replace(/^[,;:\s]+|[,;:\s]+$/g, '');
  if (!selected || selected.split(/\s+/).length < 3) return '';
  if (/^(?:you|was|were|is|are|it['’]?s|those|these|there|that['’]?s|takes?|say|aim|doesn|don|didn|hasn|hadn|couldn|wouldn|shouldn)\b/i.test(selected)) return '';
  if (/\b(?:don['’]?t|doesn['’]?t|didn['’]?t|you know|kind of|sort of)\b/i.test(selected)) return '';
  if (/^[A-Z][a-z]+\s+and\s+I\b/.test(clean(value))) return '';
  return selected.charAt(0).toUpperCase() + selected.slice(1);
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
    && !/\b(?:yeah|okay|problem importer|going because|you know)\b/i.test(text);
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

module.exports = { CONCEPTS, clusterText, editorialTopicLabel, editorialTopics, extractiveLabel };
