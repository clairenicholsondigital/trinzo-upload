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

  // Malformed text should already be filtered upstream; flag anything that
  // survives so it is never silently published.
  for (const card of discussion) {
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

module.exports = {
  normaliseForSimilarity,
  pointSimilarity,
  cardPoints,
  isMalformedStagedLine,
  hasStagedDecisionEvidence,
  cardsAreDuplicates,
  dedupeStagedDiscussionCards,
  buildStagedValidationFlags
};
