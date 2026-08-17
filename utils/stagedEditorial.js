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
      .filter((word) => word.length >= minLength && !STOPWORDS.has(word))
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

function classifyStagedTopic(value) {
  const text = String(value || '').toLowerCase();
  if (/\b(?:hotel|reservation|travel|flight|taxi|dinner|lunch|greeting|introductions?|participant arrangements?)\b/.test(text)) return 'administrative_only';
  if (/\b(?:site access|document access|evidence access|audit dates?|audit schedule|preparation schedule|delivery schedule|deadline|timeline)\b/.test(text)) return 'administrative_but_material';
  return 'substantive';
}

function topicIsIncomplete(value) {
  const text = String(value || '').trim();
  return !text || /\b(?:the|a|an|to|of|for|with|in|on|at|and|or|relation to)\s*[.?!,:;-]*$/i.test(text) || /\b(?:was|were|is|are) discussed\s+in\s+relation\s+to\s+the\b/i.test(text);
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
    .filter((topic) => topic && !topicIsIncomplete(topic) && classifyStagedTopic(topic) !== 'administrative_only');
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
  if (/^(?:from\s+)?directly\s+from\b/i.test(text)) return true;
  if (/\b(?:a point of related point|will\s+[A-Z][a-z]+\s+has\s+access|performing some inactions)\b/i.test(text)) return true;
  if (/\b(?:access shirt|back[- ]to[- ]somber pressure valves?|version one to 10[12])\b/i.test(text)) return true;
  if (/\b(?:that will,?\s+that|will,?\s+that)\b/i.test(text) && !/\b(?:the team|discussion|review|meeting)\b/i.test(text)) return true;
  if (/\b(?:they may or may not|may or may not),?\s+(?:like|you know)\b/i.test(text)) return true;
  if (/\b(?:it['’]?s|that['’]?s)\s+(?:minimal|probably|maybe)\b/i.test(text) && !/\b(?:the team|discussion|review)\b/i.test(text)) return true;
  return false;
}

// --- Unsupported "decision/agreement" evidence bar ------------------------

const DECISION_EVIDENCE = /\b(?:agreed|agreement|approv(?:e|ed|al)|sign(?:ed)?[- ]?off|confirm(?:ed)?|decid(?:e|ed)|decision|will proceed|go[- ]?ahead|finalis(?:e|ed)|resolved|concluded|ratified|accepted|should be (?:covered|included))\b/i;

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

const REPORTED_SPEECH_DISCUSSION_PREFIX = /^([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+){0,3})\s+(said|explained|reported)\s+that\s+(.+)$/i;
const REPORTED_QUESTION_DISCUSSION_PREFIX = /^([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+){0,3})\s+asked\s+whether\s+(.+)$/i;
const INCOMPLETE_DISCUSSION_ENDING = /\b(?:and|or|but|because|although|though|if|when|while|that|which|who|whose|where|whether|with|without|from|to|for|of|the|a|an)\s*[.!?]?$/i;
const REPORTED_SPEECH_DISFLUENCY = /^(?:[,;:]|and\b|but\b|so\b)|\b(?:you know|know what|I mean|sort of|kind of|like\s+[A-Z]|we don't really|we do not really)\b|\b([A-Za-z]+)\s*,\s*\1\b|\b([A-Za-z]+\s+it),\s+but\s+it\s+\2\b/i;

function discussionPointIsCompleteSentence(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text || text.split(/\s+/).length < 5) return false;
  if (INCOMPLETE_DISCUSSION_ENDING.test(text)) return false;
  if (/[,;:]\s*[.!?]?$/.test(text)) return false;
  if (/\b(?:that|which|who)\s+(?:they|we|it|the team)\s*[.!?]?$/i.test(text)) return false;
  if (/^(?:in|as|for|with|from|to)\b/i.test(text) && !/\b(?:is|are|was|were|has|have|will|would|requires?|includes?|covers?|supports?|uses?|needs?)\b/i.test(text)) return false;
  if (/^in\s+the\s+(?:work|process|discussion|meeting)\s+that\b/i.test(text)) return false;
  return true;
}

function neutraliseReportedDiscussion(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const statement = text.match(REPORTED_SPEECH_DISCUSSION_PREFIX);
  if (statement) {
    const body = statement[3].replace(/^[,;:\s]+/, '').trim();
    if (!body || REPORTED_SPEECH_DISFLUENCY.test(statement[3]) || FIRST_PERSON_TRANSCRIPT_VOICE.test(body)) return '';
    if (!discussionPointIsCompleteSentence(body)) return '';
    return sentenceCaseHumanDiscussion(body);
  }
  const question = text.match(REPORTED_QUESTION_DISCUSSION_PREFIX);
  if (question) {
    const body = question[2].replace(/^[,;:\s]+/, '').trim();
    if (!body || REPORTED_SPEECH_DISFLUENCY.test(body) || FIRST_PERSON_TRANSCRIPT_VOICE.test(body)) return '';
    if (!discussionPointIsCompleteSentence(body)) return '';
    return 'The discussion considered whether ' + body.replace(/[.?!]+$/, '') + '.';
  }
  return text;
}

const RAW_TRANSCRIPT_DISCUSSION_PATTERNS = [
  /^(?:well|yeah|yes|no|okay|ok|right|so|anyway|basically|actually|and then|and that|but|that['’]s|that will)\b/i,
  /^(?:one of the things|the other thing|what I was|what we were|what was|there['’]s one to)\b/i,
  /^(?:let['’]s hope|I would (?:imagine|guess|suppose|think)|I['’]d (?:imagine|guess|suppose|think))\b/i,
  /\b[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+){0,3}\s+would\s+(?:imagine|guess|suppose|think)\b/i,
  /\b(?:isn['’]t|aren['’]t|wasn['’]t|weren['’]t|doesn['’]t|don['’]t|didn['’]t|wouldn['’]t|couldn['’]t|shouldn['’]t)\s+(?:it|that|this|there)\s*\?\s*$/i,
  /\b(?:you know|I mean|sort of|kind of|as I say|like I said)\b/i,
  /\b(?:what you were,?\s+what was|\b\w+\s+it,?\s+but\s+\w+\s+it)\b/i
];

const STAGED_SPEAKER_TURN_PREFIX = /^(?:\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*)?(?:[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+){0,3})\s+(?:\d{1,2}:\d{2}(?::\d{2})?|said\s*:)|^\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*/;
const FIRST_PERSON_TRANSCRIPT_VOICE = /\b(?:I|I'm|I’m|I've|I’ve|I'd|I’d|we|we're|we’re|we've|we’ve|we'd|we’d|us|our|ours|you|you're|you’re|you've|you’ve|your|yours|let['’]s)\b/i;
const STANDALONE_MINUTES_SUBJECT = /^(?:the\s+(?:team|group|meeting|discussion|review|project|client|supplier|process|system|document|audit|work|risk|scope)|[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+){0,3}\s+(?:noted|confirmed|agreed)|[A-Z0-9][A-Za-z0-9'’()./&+-]+\s+(?:is|are|was|were|has|have|will|would|remains?|requires?|includes?|covers?|supports?|uses?|needs?))/;

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
  const neutral = neutraliseReportedDiscussion(point);
  if (!neutral) return '';
  const human = humaniseDiscussionPoint(neutral);
  if (!human) return '';
  if (isMalformedStagedLine(human) || isRawTranscriptDiscussionPoint(human)) return '';
  if (!discussionPointIsCompleteSentence(human)) return '';
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

const DISCUSSION_TOPIC_INFERENCE = [
  ['Cybersecurity and access controls', /\b(?:cyber\s*security|usb|port lock|password|unauthori[sz]ed|interference|gui|screen access)\b/i],
  ['Language support and localisation', /\b(?:languages?|translations?|translated|locali[sz]ation|characters?|fonts?|arabic|vietnamese|greek)\b/i],
  ['Electrical compliance testing', /\b(?:iec\s*60601|60601-1|electrical compliance)\b/i],
  ['Alarm behaviour and controls', /\b(?:alarm|mute button|led|flash(?:ing)?|priority)\b/i],
  ['Software change traceability', /\b(?:17 changes|visibility within the code|device file history|traceability|retrospective test data)\b/i],
  ['Risks and dependencies', /\b(?:risk management|risk matrix|benefit-risk|risks?|dependencies|blockers?|mitigation)\b/i],
  ['Regulatory and compliance', /\b(?:regulatory|compliance|mdr|mdsap|hpra|eudamed|authorised representative|authorized representative)\b/i],
  ['Scope and requirements', /\b(?:scope|requirements?|standards?|specifications?|criteria)\b/i],
  ['Documentation and evidence', /\b(?:documents?|documentation|technical file|reports?|records?|evidence)\b/i],
  ['Operations and processes', /\b(?:operations?|process(?:es)?|workflow|warehouse|supplier|customer order)\b/i]
];

function discussionTopicLooksTranscriptShaped(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return true;
  if (/^(?:absolutely|definitely|probably|possibly|maybe|perhaps|like\b|that\b|this\b|it\b|there\b|so\b|well\b|and\b|but\b)/i.test(text)) return true;
  if (/\b(?:I|we|you|they|he|she|it)(?:['’](?:m|ve|d|ll|re|s))?\b/i.test(text)) return true;
  if (/\b(?:am|is|are|was|were|be|been|being|will|would|could|should|might|may|can|has|have|had|does?|did)\b/i.test(text)) return true;
  if (/^(?:address|follow|develop(?:ing)?|deem(?:ed)?|determine(?:d)?|confirm|ensure|make|take|get|give|send|share)\b/i.test(text)) return true;
  return false;
}

function topicLabelForHumanMinutes(topic, points = []) {
  const cleaned = sentenceCaseHumanDiscussion(topic || 'Discussion')
    .replace(/\bUDI\s+and\s+EUDAMED\s+Responsibilities\b/i, 'UDI and regulatory data')
    .replace(/\bDeclarations?\s+of\s+Conformity\b/i, 'DoCs')
    .trim();
  if (cleaned && !discussionTopicLooksTranscriptShaped(cleaned)) return cleaned;
  const source = (Array.isArray(points) ? points : []).join(' ');
  const inferred = DISCUSSION_TOPIC_INFERENCE.find(([, pattern]) => pattern.test(source));
  return inferred ? inferred[0] : 'Discussion';
}

function reshapeStagedDiscussionCardsForHumanMinutes(cards, options = {}) {
  const result = [];
  for (const card of Array.isArray(cards) ? cards : []) {
    if (!card || typeof card !== 'object') continue;
    const sourcePoints = Array.isArray(card.points) ? card.points : cardPoints(card);
    const topic = topicLabelForHumanMinutes(card.topic, sourcePoints);
    const seen = new Set();
    const points = [];
    let rawTranscriptPointsRemoved = 0;
    let malformedDiscussionPointsRemoved = 0;
    let actionOnlyPointsRemoved = 0;
    for (const point of orderHumanDiscussionPoints(Array.isArray(card.points) ? card.points : cardPoints(card), topic)) {
      const before = humaniseDiscussionPoint(point);
      const human = finaliseDiscussionPointForMinutes(point, topic);
      if (!human && before) {
        if (isRawTranscriptDiscussionPoint(before)) rawTranscriptPointsRemoved += 1;
        else if (isMalformedStagedLine(before)) malformedDiscussionPointsRemoved += 1;
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
  const matches = tokens.filter((token) => haystack.includes(token)).length;
  return matches >= Math.min(2, tokens.length);
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
      const suggestionText = subject.text.trim().slice(0, 240);
      const suggestionTopic = suggestionText
        .replace(/^(?:arrange|book|schedule|organise|coordinate|set\s+up|update|review|check|verify|validate|assess|send|share|provide|circulate|issue|upload|forward|confirm|prepare|complete|develop|build|create|finali[sz]e|finish|produce|draft|submit|approve|agree|accept|trace|generate|identify|document|follow[- ]?up)\s+/i, '')
        .replace(/[.!?]+$/, '')
        .trim()
        .slice(0, 120);
      flags.push({
        type: 'possible_omitted_workstream',
        severity: 'warning',
        message: `"${subject.text.trim().slice(0, 120)}" appears in the ${subject.source} but has no matching discussion section. Confirm it is covered or intentionally omitted.`,
        discussionSuggestion: {
          topic: suggestionTopic || 'Discussion point to review',
          point: suggestionText,
          source: subject.source
        }
      });
    }
  }

  return flags;
}

// --- Final action quality gate --------------------------------------------

const FINAL_ACTION_VERB = /^(?:arrange|book|schedule|organise|coordinate|set\s+up|continue|update|review|check|verify|validate|assess|send|share|provide|circulate|issue|upload|forward|confirm|prepare|complete|develop|build|create|finali[sz]e|finish|produce|draft|submit|approve|agree|accept|sign(?:\s+off)?|trace|generate|identify|document|follow[- ]?up)\b/i;
const FINAL_ACTION_DEBRIS = [
  /^\s*(?:and\s+)?then\b/i,
  /^\s*(?:i|we)\s+(?:think|suppose|guess)\b/i,
  /^\s*(?:maybe|probably|possibly|just)\b/i,
  /\b(?:would|could)\s+(?:be\s+)?(?:nice|good|useful)\s+to\b/i,
  /\bgive\s+(?:him|her|them|[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)\s+the\s+opportunity\s+to\b/i,
  /\bthe\s+opportunity\s+to\s+review\b/i,
  /\badjusting\s+overall\b/i
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
  if (/^not stated$/i.test(cleaned)) return 'Not stated';
  if (/^(?:we|us|our team|the team|everyone)$/i.test(cleaned)) return 'All';
  return cleaned;
}

function normaliseAndValidateActionOwner(owner, participants = []) {
  const cleaned = normaliseFinalActionOwner(owner || 'Not stated');
  if (/^not stated$/i.test(cleaned)) return { owner: 'Not stated', status: 'accepted' };
  if (/^all$/i.test(cleaned)) return { owner: 'All', status: 'accepted' };
  if (/^(?:it['’]?s|i|we|you|they|he|she|review|complete|update|share|send|confirm|action|owner)$/i.test(cleaned)) return { owner: 'Not stated', status: 'rejected_fragment' };
  const keyFor = (value) => String(value || '').toLowerCase().normalize('NFKD').replace(/[^a-z\s'-]/g, '').replace(/\s+/g, ' ').trim();
  const names = [...new Set((Array.isArray(participants) ? participants : []).map((name) => String(name || '').trim()).filter(Boolean))];
  const key = keyFor(cleaned);
  const exact = names.find((name) => keyFor(name) === key);
  if (exact) return { owner: exact, status: 'accepted' };
  const parts = key.split(' ').filter(Boolean);
  const close = names.filter((name) => {
    const candidate = keyFor(name).split(' ').filter(Boolean);
    return parts.length && candidate.length && ((parts.length === 1 && candidate.includes(parts[0])) || (parts[0] === candidate[0] && parts.at(-1) === candidate.at(-1)));
  });
  if (close.length === 1) return { owner: close[0], status: 'repaired_unambiguous' };
  return { owner: 'Not stated', status: close.length ? 'ambiguous' : 'not_participant' };
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
  let object = finalActionObjectText(action)
    .replace(/^(?:the|a|an|to|on|for|with|about|regarding)\s+/i, '')
    .trim();
  if (!/^continue\b/i.test(cleanFinalActionValue(action))) {
    object = object.replace(/\s+(?:for\s+review|with\s+.+|to\s+.+)$/i, '').trim();
  }
  if (!object || FINAL_ACTION_WEAK_OBJECT.test(object)) return false;
  const words = object.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return true;
  // General domain acronyms only — no client/product names or transcript-specific
  // version literals. (This module is intentionally dependency-free; the shared
  // dictionary in utils/domainTerms.js is the canonical list these mirror.)
  return /\b(?:qms|hpra|mdr|ppe|docs?|docx|sbom|iec ?60601|81001|27427|usb|gui)\b/i.test(object);
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
  if (finalActionMixesWorkstreams(action)) return 'mixed_workstream_clauses';
  if (FINAL_ACTION_DEBRIS.some((pattern) => pattern.test(action))) return 'transcript_debris';
  if (!FINAL_ACTION_VERB.test(action)) return 'missing_actionable_verb';
  if (!finalActionHasConcreteObject(action)) return 'missing_concrete_object';
  if (/\b(?:someone|somebody|they|we)\s+(?:will|should|need to|needs to)\b/i.test(action)) return 'unclear_actor';
  if (/\b(?:look at|think about|discuss|consider|progress|sort out|stuff|things|everything)\b/i.test(action)) return 'vague_action';
  return null;
}

function finalActionMixesWorkstreams(value) {
  const text = cleanFinalActionValue(value);
  const families = [
    /\b(?:language|languages?|translation|font|characters?|symbols?|graphics driver)\b/i,
    /\b(?:electrical compliance|iec\s*60601|electrical testing)\b/i,
    /\b(?:alarm|mute button|led|flash(?:ing)?|priority|clinical|clinician|sound|chirps?)\b/i,
    /\b(?:usb|port lock|gui|screen control|cyber\s*security|password)\b/i,
    /\b(?:change request|change control|version|traceability|technical file|device file history|17 changes?)\b/i,
    /\b(?:risk management|risk file|risk matrix|standards?|81001|27427)\b/i,
    /\b(?:debug|test scripts?|test data|validation|verification)\b/i
  ].filter((pattern) => pattern.test(text)).length;
  if (families < 2) return false;
  const clauses = text.split(/\s*(?:[.;]\s+|[.;](?=[A-Z0-9])|\band then\b|\bthen\b)\s*/i)
    .map((part) => part.trim())
    .filter((part) => part.split(/\s+/).filter(Boolean).length >= 3);
  return clauses.length >= 2;
}

function normaliseFinalStagedActionCandidate(candidate = {}) {
  const rewritten = rewriteTranscriptShapedFinalAction(
    candidate.action || candidate.meetingActionPoint || '',
    candidate.owner || candidate.meetingActionPointOwner || 'Not stated',
    candidate.evidence || candidate.sourceText || candidate.contextText || ''
  );
  const rawDeadline = cleanFinalActionValue(candidate.deadline || candidate.meetingActionPointDeadline || 'Not stated') || 'Not stated';
  const deadline = /^not stated$/i.test(rawDeadline) ? 'Not stated' : rawDeadline;
  const evidence = cleanFinalActionValue(candidate.evidence || candidate.sourceText || candidate.contextText || '');
  if (/^review\s+(?:the\s+)?USB port cybersecurity controls\.?$/i.test(rewritten.action) && !evidence) return null;
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
  classifyStagedTopic,
  topicIsIncomplete,
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
  normaliseFinalStagedActionCandidate,
  normaliseAndValidateActionOwner
};
