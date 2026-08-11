'use strict';

// Dependency-free editorial helpers for the staged meeting-minutes flow.
//
// These run AFTER extraction/generation, inside the existing stage, so the
// reviewer is never handed obvious garbage to fix by hand. They split cleanly
// into two postures that match the "do one tiny step, show the human" model:
//
//   * MECHANICAL failures are fixed silently, because they are just noise:
//       - phantom duplicate discussion sections (the same workstream emitted
//         twice, e.g. a copied "Analytics and review confidence" card)
//       - malformed lines derived from transcription noise
//         (e.g. "Potential The discussion covered transportation availability")
//       - "decision/agreement" labels with no supporting evidence
//
//   * JUDGEMENT failures are only FLAGGED, never auto-fixed, so the human
//     decides (e.g. a workstream that drives an action or the summary but has
//     no discussion section). Auto-filling those would invite fabrication,
//     which is the opposite of abstaining when evidence is weak.

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'be', 'been', 'being', 'will', 'must',
  'should', 'before', 'after', 'first', 'then', 'both', 'required', 'requires',
  'requirement', 'of', 'for', 'with', 'that', 'this', 'from', 'into', 'on', 'in',
  'at', 'by', 'is', 'are', 'was', 'were', 'has', 'have', 'had', 'not', 'stated',
  'review', 'reviewed', 'discuss', 'discussed', 'discussion', 'meeting', 'team',
  'provide', 'provided', 'send', 'sent', 'share', 'shared', 'confirm', 'confirmed',
  'ahead', 'once', 'next', 'week', 'monday', 'tuesday', 'wednesday', 'thursday',
  'friday', 'today', 'tomorrow', 'weekend', 'arrival'
]);

function normaliseForSimilarity(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(?:the|a|an|and|or|to|be|been|being|will|must|should|before|after|first|then|both|required|requires|requirement)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(value, minLength = 4) {
  return new Set(
    normaliseForSimilarity(value)
      .split(/\s+/)
      .filter((word) => word.length >= minLength)
  );
}

// Token-overlap similarity over the smaller token set. Mirrors the
// stagedDiscussionPointSimilarity heuristic already used inside routes/api.js
// so behaviour is consistent, but stays self-contained for unit testing.
function pointSimilarity(left, right) {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return overlap / Math.min(leftTokens.size, rightTokens.size);
}

function cardPoints(card) {
  if (!card || typeof card !== 'object') return [];
  const explicit = Array.isArray(card.points) ? card.points : [];
  const fields = ['whatWasDiscussed', 'currentPosition', 'decisionOrAgreement', 'dependencyOrRisk', 'nextStep']
    .map((key) => card[key])
    .filter(Boolean);
  return [...explicit, ...fields]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function tidyTopicPhrase(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\b(?:overall|general|key|main)\s+(?:topics?|discussion|points?)\b/ig, '')
    .replace(/\b(?:discussion|overview|review)\b$/ig, '')
    .replace(/^\s*[-:;,\s]+|[-:;,\s]+\s*$/g, '')
    .trim();
}

function lowerInitialForObjective(value) {
  const text = tidyTopicPhrase(value);
  if (!text) return '';
  return text
    .split(/(\s+)/)
    .map((part) => {
      if (/^\s+$/.test(part)) return part;
      if (/[A-Z]{2,}|\d/.test(part)) return part;
      return part.toLowerCase();
    })
    .join('')
    .replace(/\bmedsap\b/g, 'MedSAP')
    .replace(/\bmdr\b/g, 'MDR')
    .replace(/\biso\b/g, 'ISO')
    .replace(/\bsbom\b/g, 'SBOM');
}

function objectiveIntentForTopic(topic) {
  const text = String(topic || '').toLowerCase();
  if (/\b(?:risk|dependency|dependencies|blocker|open point|gap|issue|constraint)\b/.test(text)) return 'Identify';
  if (/\b(?:access|sharing|arrangement|arrangements|logistics|handover|schedule|timeline|date|deadline|participant|hotel)\b/.test(text)) return 'Agree';
  if (/\b(?:scope|standard|standards|compliance|requirement|requirements|approval|decision)\b/.test(text)) return 'Confirm';
  return 'Review';
}

function joinObjectivePhrases(values) {
  const phrases = (Array.isArray(values) ? values : [])
    .map(lowerInitialForObjective)
    .filter(Boolean);
  if (!phrases.length) return '';
  if (phrases.length === 1) return phrases[0];
  if (phrases.length === 2) return `${phrases[0]} and ${phrases[1]}`;
  return `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}`;
}

const GENERIC_OBJECTIVE_PATTERNS = [
  /current project position/i,
  /what has changed since the last review/i,
  /agreed decisions, follow-ups, owners/i,
  /unresolved dependencies/i,
  /risks or blockers/i,
  /timeline or release readiness/i
];

function isGenericStagedObjective(value) {
  const text = String(value || '').trim();
  return !text || GENERIC_OBJECTIVE_PATTERNS.some((pattern) => pattern.test(text));
}

function buildTightStagedObjectives(input = {}) {
  const maxObjectives = Math.max(1, Math.min(8, Number(input.maxObjectives || 3)));
  const topics = (Array.isArray(input.topics) ? input.topics : [])
    .map(tidyTopicPhrase)
    .filter(Boolean);
  if (maxObjectives > 3 && topics.length > 3) {
    const objectives = topics
      .slice(0, maxObjectives)
      .map((topic) => `${objectiveIntentForTopic(topic)} ${lowerInitialForObjective(topic)}`)
      .filter(Boolean);
    if (objectives.length) {
      return {
        objectives,
        telemetry: {
          objectiveSource: 'workstream_objective_reducer',
          topicCount: topics.length,
          objectiveSpecificityScore: 100
        }
      };
    }
  }

  const grouped = new Map();
  for (const topic of topics) {
    const intent = objectiveIntentForTopic(topic);
    if (!grouped.has(intent)) grouped.set(intent, []);
    grouped.get(intent).push(topic);
  }

  const orderedIntents = ['Confirm', 'Review', 'Agree', 'Identify'];
  const objectives = [];
  for (const intent of orderedIntents) {
    const phrase = joinObjectivePhrases((grouped.get(intent) || []).slice(0, 2));
    if (!phrase) continue;
    objectives.push(`${intent} ${phrase}`);
    if (objectives.length >= maxObjectives) break;
  }

  if (!objectives.length) {
    const fallback = tidyTopicPhrase(input.meetingTitle || input.meetingType || '');
    if (fallback) objectives.push(`Review ${lowerInitialForObjective(fallback)}`);
  }

  return {
    objectives: objectives.slice(0, maxObjectives),
    telemetry: {
      objectiveSource: objectives.length ? 'topic_objective_reducer' : 'fallback_objective_reducer',
      topicCount: topics.length,
      objectiveSpecificityScore: objectives.length ? 100 : 0
    }
  };
}

// --- Malformed / transcription-noise line detection -----------------------

// Leading dangling qualifier glued to a determiner clause, e.g.
// "Potential The discussion covered ...", "Possible This is a risk ...".
const DANGLING_QUALIFIER = /^(?:potential|possible|likely|probable|ongoing|pending|regarding|concerning|various|overall|general)\s+(?:the|this|that|these|those|a|an|there|their|it|we|they)\b/i;

// A capitalised clause-starter appearing mid-sentence with no terminal
// punctuation before it. In clean minutes a new sentence carries its full
// stop, so an un-punctuated capitalised "The/This/There/We/They/It" is the
// signature of two clauses glued together by transcription noise.
const GLUED_CLAUSE = /[a-z,]\s+(?:The|This|That|These|Those|There|We|They|It)\s+[a-z]/;

function isMalformedStagedLine(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  if (DANGLING_QUALIFIER.test(text)) return true;
  if (GLUED_CLAUSE.test(text)) return true;
  return false;
}

// --- Unsupported "decision/agreement" evidence bar ------------------------

const DECISION_EVIDENCE = /\b(?:agreed|agreement|approv(?:e|ed|al)|sign(?:ed)?[- ]?off|confirm(?:ed)?|decid(?:e|ed)|decision|will proceed|go[- ]?ahead|finalis(?:e|ed)|resolved|concluded|ratified|accepted)\b/i;

function hasStagedDecisionEvidence(value) {
  return DECISION_EVIDENCE.test(String(value || ''));
}

// --- Cross-section (card-to-card) de-duplication --------------------------

// Two cards are duplicates when most of the smaller card's points have a near
// twin in the other card. This is what catches a phantom section that simply
// copies another workstream's evidence under a new heading.
function cardsAreDuplicates(a, b, options = {}) {
  const pointMatchThreshold = options.pointMatchThreshold ?? 0.72;
  const coverageThreshold = options.coverageThreshold ?? 0.6;
  const pointsA = cardPoints(a);
  const pointsB = cardPoints(b);
  if (!pointsA.length || !pointsB.length) return false;
  const [smaller, larger] = pointsA.length <= pointsB.length ? [pointsA, pointsB] : [pointsB, pointsA];
  let matched = 0;
  for (const point of smaller) {
    if (larger.some((other) => pointSimilarity(point, other) >= pointMatchThreshold)) matched += 1;
  }
  return matched / smaller.length >= coverageThreshold;
}

// Returns { cards, dropped } where dropped lists the discarded duplicate cards
// (with the heading kept for the advisory flag). The richer card wins.
function dedupeStagedDiscussionCards(cards, options = {}) {
  const kept = [];
  const dropped = [];
  for (const card of Array.isArray(cards) ? cards : []) {
    if (!card || typeof card !== 'object') continue;
    const duplicateIndex = kept.findIndex((existing) => cardsAreDuplicates(existing, card, options));
    if (duplicateIndex >= 0) {
      const existing = kept[duplicateIndex];
      if (cardPoints(card).length > cardPoints(existing).length) {
        dropped.push({ topic: existing.topic || 'Discussion', duplicateOf: card.topic || 'Discussion' });
        kept[duplicateIndex] = card;
      } else {
        dropped.push({ topic: card.topic || 'Discussion', duplicateOf: existing.topic || 'Discussion' });
      }
      continue;
    }
    kept.push(card);
  }
  return { cards: kept, dropped };
}

function normalisePointForCompact(value) {
  return normaliseForSimilarity(value)
    .replace(/\b(?:confirmed|noted|discussed|covered|involved|regarding|related|routine|prior|experience)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactPointSimilarity(left, right) {
  const leftTokens = new Set(normalisePointForCompact(left).split(/\s+/).filter((word) => word.length >= 4));
  const rightTokens = new Set(normalisePointForCompact(right).split(/\s+/).filter((word) => word.length >= 4));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return overlap / Math.min(leftTokens.size, rightTokens.size);
}

function stagedPointSpecificityScore(value) {
  const text = String(value || '');
  let score = 0;
  if (/\b(?:agreed|confirmed|approved|decided|will|must|before|by|deadline|action|owner|share|send|prepare|arrange)\b/i.test(text)) score += 4;
  if (/\b(?:risk|dependency|blocked|delay|required before|waiting for|open point|constraint|gap)\b/i.test(text)) score += 3;
  if (/\b(?:\d{1,2}(?:st|nd|rd|th)?|20\d{2}|v\d+(?:\.\d+)*|[A-Z]{2,}|SBOM|MDR|ISO|CFR|MDSAP|MedSAP|SharePoint)\b/.test(text)) score += 3;
  if (/\b(?:document|plan|scope|standard|software|system|site|audit|training|attestation|code of conduct)\b/i.test(text)) score += 2;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount >= 8 && wordCount <= 28) score += 2;
  if (wordCount > 40) score -= 2;
  if (/^(?:the discussion|the meeting|it was discussed|there was discussion)\b/i.test(text)) score -= 1;
  return score;
}

const CONCRETE_DETAIL_PATTERNS = [
  /\b(?:\d{1,2}(?:st|nd|rd|th)?|20\d{2}|v\d+(?:\.\d+)*)\b/ig,
  /\b[A-Z]{2,}(?:s)?\b/g,
  /\b(?:SBOM|MDR|ISO|CFR|MDSAP|MedSAP|SharePoint|Code of Conduct|training attestation|risk assessment|audit plan|on-site|site access|software development|software validation|purchasing controls|supplier|suppliers|provenance|complaints|field actions|new version|rollout|rollouts)\b/ig
];

function concreteDetailTerms(value) {
  const text = String(value || '');
  const terms = new Set();
  for (const pattern of CONCRETE_DETAIL_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      terms.add(match[0].toLowerCase().replace(/\s+/g, ' ').trim());
    }
  }
  return [...terms].filter(Boolean);
}

function countConcreteDetails(values) {
  const terms = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    for (const term of concreteDetailTerms(value)) terms.add(term);
  }
  return terms.size;
}

function detailOverlapRatio(left, right) {
  const leftTerms = new Set(concreteDetailTerms(left));
  const rightTerms = new Set(concreteDetailTerms(right));
  if (!leftTerms.size || !rightTerms.size) return null;
  let overlap = 0;
  for (const term of leftTerms) {
    if (rightTerms.has(term)) overlap += 1;
  }
  return overlap / Math.min(leftTerms.size, rightTerms.size);
}

function stagedPointRoles(value) {
  const text = String(value || '');
  const roles = new Set();
  if (/\b(?:current|currently|ongoing|has completed|have completed|is confirmed|was confirmed|status|progress|on track|scheduled|planned|in progress|working on)\b/i.test(text)) {
    roles.add('status');
  }
  if (/\b(?:agreed|agreement|confirmed|approved|decided|will proceed|go[- ]?ahead|sign(?:ed)?[- ]?off|finalis(?:e|ed)|accepted)\b/i.test(text)) {
    roles.add('decision');
  }
  if (/\b(?:risk|dependency|blocked|delay|waiting for|open point|constraint|gap|concern|uncertainty|required before|prerequisite|restricted)\b/i.test(text)) {
    roles.add('risk');
  }
  if (concreteDetailTerms(text).length || /\b(?:document|plan|scope|standard|software|system|site|audit|training|attestation|supplier|provenance|validation|purchasing|complaints|field actions)\b/i.test(text)) {
    roles.add('detail');
  }
  return roles;
}

function pointHasRole(value, role) {
  return stagedPointRoles(value).has(role);
}

function topicIsHighSubstance(topic, points) {
  const text = `${topic || ''} ${(Array.isArray(points) ? points : []).join(' ')}`;
  if (/\b(?:software|risk|regulatory|standards?|MDR|CFR|ISO|MDSAP|MedSAP|SBOM|audit plan|technical|validation|compliance|cybersecurity|documentation|attestation)\b/i.test(text)) {
    return true;
  }
  return countConcreteDetails(points) >= 5;
}

function topicNeedsProcessDetail(topic, points) {
  const text = `${topic || ''} ${(Array.isArray(points) ? points : []).join(' ')}`;
  return /\b(?:process overview|goods movement|warehouse|warehousing|packaging|packing|customer orders?|order picking|shipping|dispatch|storage|courier|barcode|barcodes|label|labels|UDI|EUDAMED|Udimed|UDAMED|regulatory data)\b/i.test(text);
}

function pointLimitForTopic(topic, points, options = {}) {
  const baseLimit = options.pointLimit ?? options.defaultPointLimit ?? 4;
  const highSubstanceLimit = options.highSubstancePointLimit ?? Math.max(baseLimit, 6);
  const processDetailLimit = options.processDetailPointLimit ?? Math.max(highSubstanceLimit, 8);
  const lowSubstanceLimit = options.lowSubstancePointLimit ?? Math.max(3, baseLimit);
  if (topicNeedsProcessDetail(topic, points)) return processDetailLimit;
  return topicIsHighSubstance(topic, points) ? highSubstanceLimit : lowSubstanceLimit;
}

function shouldMergeCompactPoints(existing, candidate) {
  const similarity = compactPointSimilarity(existing, candidate);
  const left = normalisePointForCompact(existing);
  const right = normalisePointForCompact(candidate);
  const overlap = detailOverlapRatio(existing, candidate);

  if (overlap !== null && overlap <= 0.5 && similarity < 0.9) return false;
  if (similarity >= 0.72) return true;
  if (similarity >= 0.62 && overlap !== null && overlap > 0.5) return true;
  return Boolean(left && right && (left.includes(right) || right.includes(left)));
}

function betterCompactPoint(left, right) {
  const leftScore = stagedPointSpecificityScore(left);
  const rightScore = stagedPointSpecificityScore(right);
  if (rightScore !== leftScore) return rightScore > leftScore ? right : left;
  return String(right || '').length < String(left || '').length ? right : left;
}

function selectDetailPreservingPoints(points, limit) {
  const rows = (Array.isArray(points) ? points : []).map((point, index) => ({
    point,
    index,
    roles: stagedPointRoles(point),
    score: stagedPointSpecificityScore(point)
  }));
  const selected = new Map();
  const rolesToProtect = ['status', 'decision', 'risk', 'detail'];

  for (const role of rolesToProtect) {
    const candidate = rows
      .filter((row) => row.roles.has(role))
      .sort((left, right) => right.score - left.score || left.index - right.index)[0];
    if (candidate) selected.set(candidate.index, candidate);
  }

  for (const row of rows.sort((left, right) => right.score - left.score || left.index - right.index)) {
    if (selected.size >= limit) break;
    selected.set(row.index, row);
  }

  return [...selected.values()]
    .sort((left, right) => left.index - right.index)
    .map((row) => row.point);
}

function compactStagedDiscussionPointList(points, options = {}) {
  const limit = options.limit ?? options.pointLimit ?? 4;
  const cleanedInput = [];
  const kept = [];
  let duplicatesRemoved = 0;
  for (const point of Array.isArray(points) ? points : []) {
    const cleaned = String(point || '').replace(/\s+/g, ' ').trim();
    if (!cleaned) continue;
    cleanedInput.push(cleaned);
    const duplicateIndex = kept.findIndex((existing) => shouldMergeCompactPoints(existing, cleaned));
    if (duplicateIndex >= 0) {
      kept[duplicateIndex] = betterCompactPoint(kept[duplicateIndex], cleaned);
      duplicatesRemoved += 1;
      continue;
    }
    kept.push(cleaned);
  }

  const selected = selectDetailPreservingPoints(kept, limit);
  const namedDetailsBefore = countConcreteDetails(cleanedInput);
  const namedDetailsAfter = countConcreteDetails(selected);
  return {
    points: selected,
    duplicatesRemoved,
    truncatedRemoved: Math.max(0, kept.length - selected.length),
    namedDetailsBefore,
    namedDetailsAfter,
    detailRetentionScore: namedDetailsBefore ? Math.round((namedDetailsAfter / namedDetailsBefore) * 100) : 100,
    roleCoverage: {
      status: selected.some((point) => pointHasRole(point, 'status')),
      decision: selected.some((point) => pointHasRole(point, 'decision')),
      risk: selected.some((point) => pointHasRole(point, 'risk')),
      detail: selected.some((point) => pointHasRole(point, 'detail'))
    }
  };
}

function compactStagedDiscussionCards(cards, options = {}) {
  const compacted = [];
  const telemetry = {
    pointsBefore: 0,
    pointsAfter: 0,
    duplicatesRemoved: 0,
    truncatedRemoved: 0,
    cardCount: 0
  };
  let namedDetailsBefore = 0;
  let namedDetailsAfter = 0;
  const detailRetentionWarnings = [];

  for (const card of Array.isArray(cards) ? cards : []) {
    if (!card || typeof card !== 'object') continue;
    const points = Array.isArray(card.points) ? card.points : [];
    telemetry.pointsBefore += points.length;
    const limit = pointLimitForTopic(card.topic, points, options);
    const compact = compactStagedDiscussionPointList(points, { ...options, limit });
    telemetry.duplicatesRemoved += compact.duplicatesRemoved;
    telemetry.truncatedRemoved += compact.truncatedRemoved;
    namedDetailsBefore += compact.namedDetailsBefore;
    namedDetailsAfter += compact.namedDetailsAfter;
    if (compact.detailRetentionScore < 80) {
      detailRetentionWarnings.push({
        topic: card.topic || 'Discussion',
        detailRetentionScore: compact.detailRetentionScore
      });
    }
    if (!compact.points.length) continue;
    telemetry.pointsAfter += compact.points.length;
    compacted.push({ ...card, points: compact.points });
  }

  telemetry.cardCount = compacted.length;
  telemetry.namedDetailsBefore = namedDetailsBefore;
  telemetry.namedDetailsAfter = namedDetailsAfter;
  telemetry.detailRetentionScore = namedDetailsBefore ? Math.round((namedDetailsAfter / namedDetailsBefore) * 100) : 100;
  telemetry.detailRetentionWarnings = detailRetentionWarnings;
  return { cards: compacted, telemetry };
}

function normaliseHumanDiscussionTerm(value) {
  return String(value || '')
    .replace(/\b(?:Udimed|UDAMED|Eudamed)\b/g, 'EUDAMED')
    .replace(/\bDoC's\b/g, 'DoCs')
    .replace(/\bWhse\b/g, 'Warehouse')
    .replace(/\bfront[- ]?end everything\b/ig, 'front-end work')
    .replace(/\s+/g, ' ')
    .trim();
}

function sentenceCaseHumanDiscussion(value) {
  const text = normaliseHumanDiscussionTerm(value);
  return text.replace(/^([a-z])/, (match) => match.toUpperCase());
}

function humaniseDiscussionPoint(value) {
  let text = sentenceCaseHumanDiscussion(value);
  if (!text) return '';
  text = text
    .replace(/^(?:the\s+)?(?:discussion|meeting)\s+(?:covered|focused on|looked at)\s+/i, 'The team reviewed ')
    .replace(/^it\s+was\s+discussed\s+that\s+/i, '')
    .replace(/^it\s+was\s+noted\s+that\s+/i, '')
    .replace(/^the\s+team\s+discussed\s+/i, 'The team reviewed ')
    .replace(/\b(?:key discussions covered|as discussed in the meeting)\b/ig, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text && !/[.!?]$/.test(text)) text += '.';
  return sentenceCaseHumanDiscussion(text);
}

const RAW_TRANSCRIPT_DISCUSSION_PATTERNS = [
  /^(?:well|yeah|yes|no|okay|ok|right|so|anyway|basically|actually|and then|and that|but)\b/i,
  /^(?:one of the things|the other thing|what I was|what we were|what was)\b/i,
  /\b(?:you know|I mean|sort of|kind of|as I say|like I said)\b/i,
  /\b(?:what you were,?\s+what was|\b\w+\s+it,?\s+but\s+\w+\s+it)\b/i
];

const STAGED_SPEAKER_TURN_PREFIX = /^(?:\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*)?(?:[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+){0,3})\s+(?:\d{1,2}:\d{2}(?::\d{2})?|said\s*:)|^\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*/;
const FIRST_PERSON_TRANSCRIPT_VOICE = /\b(?:I|I'm|I’m|I've|I’ve|I'd|I’d|we|we're|we’re|we've|we’ve|we'd|we’d|us|our|ours|you|you're|you’re|you've|you’ve|your|yours)\b/i;
const STANDALONE_MINUTES_SUBJECT = /^(?:the\s+(?:team|group|meeting|discussion|review|project|client|supplier|process|system|document|audit|work|risk|scope)|[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+){0,3}\s+(?:said|noted|confirmed|explained|reported|asked|agreed)|[A-Z0-9][A-Za-z0-9'’()./&+-]+\s+(?:is|are|was|were|has|have|will|would|remains?|requires?|includes?|covers?|supports?|uses?|needs?))/;

const DISCUSSION_ACTION_ONLY = /^(?:arrange|book|schedule|organise|coordinate|set\s+up|update|review|check|verify|validate|assess|send|share|provide|circulate|issue|upload|forward|confirm|prepare|complete|develop|build|create|finali[sz]e|finish|produce|draft|submit|approve|agree|accept|sign(?:\s+off)?|trace|generate|identify|document|follow[- ]?up|begin)\b/i;

function isRawTranscriptDiscussionPoint(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  if (STAGED_SPEAKER_TURN_PREFIX.test(text)) return true;
  if (RAW_TRANSCRIPT_DISCUSSION_PATTERNS.some((pattern) => pattern.test(text))) return true;
  const firstWord = text.split(/\s+/)[0] || '';
  if (/^(?:And|But|So)$/i.test(firstWord) && !/\b(?:agreed|confirmed|reviewed|noted|discussed|identified)\b/i.test(text)) return true;
  if (FIRST_PERSON_TRANSCRIPT_VOICE.test(text) && !STANDALONE_MINUTES_SUBJECT.test(text)) return true;
  if (/\b(?:is|was|were|has|have|will|would|could|should)\s*,\s*(?:is|was|were|has|have|will|would|could|should)\b/i.test(text)) return true;
  if (/\b(\w+)\s+\1\b/i.test(text) && !/\b(?:had had|that that)\b/i.test(text)) return true;
  return false;
}

function discussionPointIsActionOnly(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!DISCUSSION_ACTION_ONLY.test(text)) return false;
  return !/\b(?:was|were|has been|have been|is|are|the team|discussion|outstanding|confirmed|agreed|noted|identified|raised|explored)\b/i.test(text);
}

function finaliseDiscussionPointForMinutes(point, topic = '') {
  const human = humaniseDiscussionPoint(point);
  if (!human) return '';
  if (isMalformedStagedLine(human) || isRawTranscriptDiscussionPoint(human)) return '';
  if (discussionPointIsActionOnly(human)) return '';
  return human;
}

function humanDiscussionRole(value) {
  const text = String(value || '');
  if (/\b(?:current(?:ly)?|in progress|has been|have been|already|serves? as|is used|are used|stored|implemented|available|confirmed)\b/i.test(text)) return 'status';
  if (/\b(?:purchased|shipped|released|transported|stored|orders?|picking|packing|label(?:led)?|barcode|scanner|courier|invoice|dispatch|delivery|warehouse|NetSuite|DHL)\b/i.test(text)) return 'process';
  if (/\b(?:agreed|confirmed|decided|approved|will proceed|recommendation|responsibility|responsible)\b/i.test(text)) return 'decision';
  if (/\b(?:risk|dependency|blocker|gap|impact|deadline|timeline|outstanding|challenge|unclear|waiting for|required before)\b/i.test(text)) return 'risk';
  if (/\b(?:will|to\s+(?:review|share|send|update|complete|prepare|confirm|follow up)|needs?\s+to|should)\b/i.test(text)) return 'next';
  return 'detail';
}

function orderHumanDiscussionPoints(points, topic = '') {
  const priority = { status: 0, process: 1, detail: 2, decision: 3, risk: 4, next: 5 };
  const processHeavy = topicNeedsProcessDetail(topic, points);
  return (Array.isArray(points) ? points : [])
    .map((point, index) => ({
      point,
      index,
      role: humanDiscussionRole(point),
      broadOverview: /^(?:the\s+)?(?:discussion|meeting|team)\s+(?:covered|reviewed|focused on|looked at)\b/i.test(String(point || '')) ? 1 : 0,
      specificity: stagedPointSpecificityScore(point)
    }))
    .sort((left, right) => {
      if (processHeavy) return left.broadOverview - right.broadOverview || left.index - right.index;
      return (priority[left.role] ?? 9) - (priority[right.role] ?? 9) || left.broadOverview - right.broadOverview || right.specificity - left.specificity || left.index - right.index;
    })
    .map((item) => item.point);
}

function topicLabelForHumanMinutes(topic) {
  const cleaned = sentenceCaseHumanDiscussion(topic || 'Discussion')
    .replace(/\bUDI\s+and\s+EUDAMED\s+Responsibilities\b/i, 'UDI and regulatory data')
    .replace(/\bDeclarations?\s+of\s+Conformity\b/i, 'DoCs')
    .trim();
  return cleaned || 'Discussion';
}

function reshapeStagedDiscussionCardsForHumanMinutes(cards, options = {}) {
  const result = [];
  for (const card of Array.isArray(cards) ? cards : []) {
    if (!card || typeof card !== 'object') continue;
    const topic = topicLabelForHumanMinutes(card.topic);
    const seen = new Set();
    const points = [];
    let rawTranscriptPointsRemoved = 0;
    let malformedDiscussionPointsRemoved = 0;
    let actionOnlyPointsRemoved = 0;
    for (const point of orderHumanDiscussionPoints(Array.isArray(card.points) ? card.points : cardPoints(card), topic)) {
      const before = humaniseDiscussionPoint(point);
      const human = finaliseDiscussionPointForMinutes(point, topic);
      if (!human && before) {
        if (isMalformedStagedLine(before)) malformedDiscussionPointsRemoved += 1;
        else if (isRawTranscriptDiscussionPoint(before)) rawTranscriptPointsRemoved += 1;
        else if (discussionPointIsActionOnly(before)) actionOnlyPointsRemoved += 1;
      }
      const key = normaliseForSimilarity(human);
      if (!human || !key || seen.has(key)) continue;
      seen.add(key);
      points.push(human);
      if (points.length >= (topicNeedsProcessDetail(topic, points) ? (options.processDetailPointLimit ?? 8) : (options.pointLimit ?? 6))) break;
    }
    if (!points.length) continue;
    const qualityFlags = [
      ...(Array.isArray(card.qualityFlags) ? card.qualityFlags : []),
      ...(rawTranscriptPointsRemoved ? ['raw_transcript_discussion_points_removed'] : []),
      ...(malformedDiscussionPointsRemoved ? ['malformed_discussion_points_removed'] : []),
      ...(actionOnlyPointsRemoved ? ['action_only_discussion_points_removed'] : [])
    ];
    result.push({
      ...card,
      topic,
      points,
      ...(qualityFlags.length ? { qualityFlags: [...new Set(qualityFlags)] } : {})
    });
    if (result.length >= (options.cardLimit ?? 8)) break;
  }
  return result;
}

// --- Advisory completeness / editorial flags ------------------------------

function salientTokens(value) {
  return [...new Set(
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length >= 5 && !STOPWORDS.has(word))
  )];
}

function discussionRepresents(discussion, tokens) {
  if (!tokens.length) return true;
  const haystack = (Array.isArray(discussion) ? discussion : [])
    .map((card) => `${card?.topic || ''} ${cardPoints(card).join(' ')}`)
    .join(' ')
    .toLowerCase();
  return tokens.some((token) => haystack.includes(token));
}

// Builds advisory flags for the reviewer. Never mutates the minutes.
//   screens: { objectives?, summary?, discussion?, actions?, droppedDuplicates? }
function buildStagedValidationFlags(screens = {}) {
  const flags = [];
  const discussion = Array.isArray(screens.discussion) ? screens.discussion : [];

  for (const dropped of Array.isArray(screens.droppedDuplicates) ? screens.droppedDuplicates : []) {
    flags.push({
      type: 'duplicate_section',
      severity: 'info',
      message: `Removed a duplicate discussion section ("${dropped.topic}") that repeated "${dropped.duplicateOf}".`
    });
  }

  for (const dropped of Array.isArray(screens.droppedMisattributed) ? screens.droppedMisattributed : []) {
    flags.push({
      type: 'misattributed_discussion_evidence',
      severity: 'warning',
      message: `Removed ${dropped.droppedPointCount || 'some'} discussion point(s) under "${dropped.topic}" because they did not fit that workstream's evidence.`
    });
  }

  // Malformed text should already be filtered upstream; flag anything that
  // survives so it is never silently published.
  for (const card of discussion) {
    const qualityFlags = Array.isArray(card?.qualityFlags) ? card.qualityFlags : [];
    if (qualityFlags.includes('raw_transcript_discussion_points_removed')) {
      flags.push({
        type: 'raw_transcript_discussion_points_removed',
        severity: 'info',
        message: `Removed raw transcript-style wording under "${card.topic || 'Discussion'}" before final review.`
      });
    }
    if (qualityFlags.includes('malformed_discussion_points_removed')) {
      flags.push({
        type: 'malformed_discussion_points_removed',
        severity: 'warning',
        message: `Removed malformed generated wording under "${card.topic || 'Discussion'}" before final review.`
      });
    }
    for (const point of cardPoints(card)) {
      if (isMalformedStagedLine(point)) {
        flags.push({
          type: 'malformed_text',
          severity: 'warning',
          message: `Possible transcription-noise wording under "${card.topic || 'Discussion'}": "${point}".`
        });
      }
    }
  }

  // Completeness: a subject significant enough to drive an action or appear in
  // the objectives should normally be represented in the discussion. Flag,
  // never auto-fill.
  const subjects = [];
  for (const objective of Array.isArray(screens.objectives) ? screens.objectives : []) {
    subjects.push({ source: 'objective', text: String(objective || '') });
  }
  for (const action of Array.isArray(screens.actions) ? screens.actions : []) {
    subjects.push({ source: 'action', text: String(action?.action || action || '') });
  }
  const seen = new Set();
  for (const subject of subjects) {
    const tokens = salientTokens(subject.text);
    if (!tokens.length) continue;
    const key = tokens.slice(0, 3).join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    if (!discussionRepresents(discussion, tokens)) {
      flags.push({
        type: 'possible_omitted_workstream',
        severity: 'warning',
        message: `"${subject.text.trim().slice(0, 120)}" appears in the ${subject.source} but has no matching discussion section. Confirm it is covered or intentionally omitted.`
      });
    }
  }

  return flags;
}

// --- Final action quality gate --------------------------------------------

const FINAL_ACTION_VERB = /^(?:arrange|book|schedule|organise|coordinate|set\s+up|update|review|check|verify|validate|assess|send|share|provide|circulate|issue|upload|forward|confirm|prepare|complete|develop|build|create|finali[sz]e|finish|produce|draft|submit|approve|agree|accept|sign(?:\s+off)?|trace|generate|identify|document|follow[- ]?up)\b/i;
const FINAL_ACTION_DEBRIS = [
  /^\s*(?:and\s+)?then\b/i,
  /^\s*(?:i|we)\s+(?:think|suppose|guess)\b/i,
  /^\s*(?:maybe|probably|possibly|just)\b/i,
  /\b(?:would|could)\s+(?:be\s+)?(?:nice|good|useful)\s+to\b/i,
  /\bgive\s+(?:him|her|them|[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)\s+the\s+opportunity\s+to\b/i,
  /\bthe\s+opportunity\s+to\s+review\b/i
];
const FINAL_ACTION_WEAK_OBJECT = /^(?:it|this|that|these|those|them|everything|stuff|things|outputs?|documents?|final documents?|any final documents?|the outputs?|the documents?)$/i;

function cleanFinalActionValue(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .trim();
}

function normaliseFinalActionOwner(owner) {
  const cleaned = cleanFinalActionValue(owner) || 'Not stated';
  if (/^(?:we|us|our team|the team|everyone)$/i.test(cleaned)) return 'All';
  return cleaned;
}

function finalActionObjectText(action) {
  const text = cleanFinalActionValue(action);
  const followUp = text.match(/^follow[- ]?up\s+with\s+.+?\s+(?:for|on|about|regarding)\s+(.+)$/i);
  if (followUp) return cleanFinalActionValue(followUp[1]);
  const signOff = text.match(/^sign\s+off\s+(.+)$/i);
  if (signOff) return cleanFinalActionValue(signOff[1]);
  const verb = text.match(FINAL_ACTION_VERB);
  if (!verb) return '';
  return cleanFinalActionValue(text.slice(verb[0].length));
}

function finalActionHasConcreteObject(action) {
  const object = finalActionObjectText(action)
    .replace(/^(?:the|a|an|to|on|for|with|about|regarding)\s+/i, '')
    .replace(/\s+(?:for\s+review|with\s+.+|to\s+.+)$/i, '')
    .trim();
  if (!object || FINAL_ACTION_WEAK_OBJECT.test(object)) return false;
  const words = object.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return true;
  return /\b(?:qms|hpra|mdr|ppe|doc|docs?|docx|sbom|medenvoy|iec60601|81001|27427|v1\.01|v1\.02|usb|gui)\b/i.test(object);
}

function rewriteTranscriptShapedFinalAction(action, owner, evidence = '') {
  const text = cleanFinalActionValue(action);
  const combined = `${text} ${evidence || ''}`;
  const opportunity = text.match(/\bgive\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)\s+the\s+opportunity\s+to\s+review\s+(?:the\s+)?outputs?\s+of\s+that\s+testing\s+and\s+update\s+(?:any\s+)?final\s+documents?\b/i);
  if (opportunity) {
    const mentionedOwner = opportunity[1];
    const fullName = new RegExp(`\\b(${mentionedOwner}\\s+[A-Z][A-Za-z]+)\\b`).exec(combined)?.[1] || mentionedOwner;
    return {
      owner: fullName,
      action: /\belectrical\s+compliance\b/i.test(combined)
        ? 'Review electrical compliance testing outputs and update the final compliance documentation'
        : 'Review testing outputs and update the final documentation'
    };
  }
  return {
    owner: normaliseFinalActionOwner(owner),
    action: text
  };
}

function stagedFinalActionQualityIssue(candidate = {}) {
  const rewritten = rewriteTranscriptShapedFinalAction(
    candidate.action || candidate.meetingActionPoint || '',
    candidate.owner || candidate.meetingActionPointOwner || 'Not stated',
    candidate.evidence || candidate.sourceText || candidate.contextText || ''
  );
  const action = cleanFinalActionValue(rewritten.action);
  if (!action) return 'missing_action';
  if (isMalformedStagedLine(action)) return 'malformed_action';
  if (FINAL_ACTION_DEBRIS.some((pattern) => pattern.test(action))) return 'transcript_debris';
  if (!FINAL_ACTION_VERB.test(action)) return 'missing_actionable_verb';
  if (!finalActionHasConcreteObject(action)) return 'missing_concrete_object';
  if (/\b(?:someone|somebody|they|we)\s+(?:will|should|need to|needs to)\b/i.test(action)) return 'unclear_actor';
  if (/\b(?:look at|think about|discuss|consider|progress|sort out|stuff|things|everything)\b/i.test(action)) return 'vague_action';
  return null;
}

function normaliseFinalStagedActionCandidate(candidate = {}) {
  const rewritten = rewriteTranscriptShapedFinalAction(
    candidate.action || candidate.meetingActionPoint || '',
    candidate.owner || candidate.meetingActionPointOwner || 'Not stated',
    candidate.evidence || candidate.sourceText || candidate.contextText || ''
  );
  const deadline = cleanFinalActionValue(candidate.deadline || candidate.meetingActionPointDeadline || 'Not stated') || 'Not stated';
  const issue = stagedFinalActionQualityIssue({
    ...candidate,
    owner: rewritten.owner,
    action: rewritten.action
  });
  if (issue) return null;
  return {
    owner: normaliseFinalActionOwner(rewritten.owner),
    action: cleanFinalActionValue(rewritten.action),
    deadline
  };
}

module.exports = {
  normaliseForSimilarity,
  pointSimilarity,
  cardPoints,
  buildTightStagedObjectives,
  isMalformedStagedLine,
  hasStagedDecisionEvidence,
  cardsAreDuplicates,
  dedupeStagedDiscussionCards,
  compactStagedDiscussionCards,
  reshapeStagedDiscussionCardsForHumanMinutes,
  isRawTranscriptDiscussionPoint,
  finaliseDiscussionPointForMinutes,
  buildStagedValidationFlags,
  stagedFinalActionQualityIssue,
  normaliseFinalStagedActionCandidate
};
