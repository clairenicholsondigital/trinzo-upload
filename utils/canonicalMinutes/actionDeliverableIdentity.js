'use strict';

// Compare the meaning-bearing frame of question-delivery actions. This catches
// an outcome phrased as "ask X the questions" beside its mechanical phrasing
// "send the question list to X" without relying on a client, person, question
// or transcript phrase. Preparation remains a separate deliverable.

const COMMUNICATION_VERBS = new Set([
  'ask', 'email', 'forward', 'send', 'share', 'submit', 'provide', 'issue',
  'deliver', 'circulate'
]);
const DELEGATED_VERBS = new Set([
  'ask', 'book', 'call', 'check', 'compile', 'confirm', 'contact', 'create',
  'draft', 'email', 'prepare', 'review', 'send', 'share', 'submit', 'update'
]);
const QUESTION_WORDS = new Set(['question', 'questions', 'query', 'queries', 'questionnaire']);
const FRAME_WORDS = new Set([
  ...COMMUNICATION_VERBS, ...QUESTION_WORDS,
  'a', 'an', 'and', 'agreed', 'all', 'about', 'for', 'of', 'on', 'the', 'to',
  'agre', 'list', 'set', 'pack', 'schedule', 'document', 'documents', 'item', 'items'
]);

function stem(token) {
  token = token.replace(/[’']s?$/, '');
  if (token === 'queries') return 'question';
  if (token === 'questionnaire') return 'question';
  if (token.length > 6 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 5 && token.endsWith('ed')) return token.slice(0, -2);
  if (token.length > 5 && token.endsWith('es')) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith('s')) return token.slice(0, -1);
  return token;
}

function tokens(value) {
  return (String(value || '').toLowerCase().match(/[a-z0-9][a-z0-9'’-]*/g) || []).map(stem);
}

const ACTION_VERBS = new Set([
  ...COMMUNICATION_VERBS, 'apply', 'arrange', 'assess', 'book', 'check',
  'complete', 'confirm', 'create', 'draft', 'finalise', 'finalize', 'finish',
  'prepare', 'review', 'schedule', 'test', 'update', 'verify'
]);
const CONTENT_STOP_WORDS = new Set([
  'a', 'an', 'and', 'all', 'also', 'as', 'at', 'by', 'for', 'from', 'has',
  'have', 'if', 'in', 'is', 'it', 'of', 'on', 'or', 'the', 'their', 'then',
  'to', 'when', 'whether', 'with'
]);

function contentTokens(value) {
  return tokens(value).filter((word) => word.length > 1 && !CONTENT_STOP_WORDS.has(word));
}

function originalInitialisms(value) {
  return String(value || '').match(/\b[A-Z]{2,5}\b/g) || [];
}

function expandInitialisms(words, ownText, otherText) {
  const expanded = new Set(words);
  const other = contentTokens(otherText);
  for (const abbreviation of originalInitialisms(ownText)) {
    const initials = abbreviation.toLowerCase();
    for (let width = 2; width <= Math.min(5, other.length); width += 1) {
      for (let at = 0; at <= other.length - width; at += 1) {
        const phrase = other.slice(at, at + width);
        if (phrase.map((word) => word[0]).join('') !== initials) continue;
        phrase.forEach((word) => expanded.add(word));
      }
    }
  }
  return expanded;
}

function actionClauses(value) {
  const words = tokens(value);
  const starts = [];
  words.forEach((word, index) => { if (ACTION_VERBS.has(word)) starts.push(index); });
  if (!starts.length) return [];
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? words.length;
    return { verb: words[start], words: words.slice(start, end).filter((word) => !CONTENT_STOP_WORDS.has(word)) };
  }).filter((clause) => clause.words.length >= 2);
}

function clauseCoverage(left, right, leftText, rightText) {
  if (left.verb !== right.verb) return 0;
  const a = expandInitialisms(left.words, leftText, rightText);
  const b = expandInitialisms(right.words, rightText, leftText);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

// A later turn often expands an existing commitment rather than creating another one:
// "send the contract" becomes "send the contract and the supporting schedules", or a
// standalone check is repeated inside a compound action. Compare verb/object clauses so
// the fuller record can replace the partial one without relying on any client vocabulary.
function sameOrNestedActionDeliverable(left = {}, right = {}) {
  const leftText = String(left.action || left.text || '');
  const rightText = String(right.action || right.text || '');
  const a = actionClauses(leftText); const b = actionClauses(rightText);
  if (!a.length || !b.length) return false;
  return a.some((one) => b.some((two) => clauseCoverage(one, two, leftText, rightText) >= 0.67));
}

function recipientTokens(value = '') {
  const match = String(value || '').match(/\b(?:to|with)\s+(?:the\s+)?(.+?)(?=\s+\b(?:for|by|before|after|so\s+that|in\s+order\s+to)\b|[.;]|$)/i);
  return new Set(match ? contentTokens(match[1]) : []);
}

function conflictingActionRecipients(left = {}, right = {}) {
  const a = recipientTokens(left.action || left.text); const b = recipientTokens(right.action || right.text);
  return Boolean(a.size && b.size && ![...a].some((word) => b.has(word)));
}

// Questions about whether the very same activity should happen are not commitments to do
// that activity. This is deliberately structural: the repeated verb and necessity phrase
// must both be present, so an ordinary review that happens to mention another review is
// left alone.
function circularMetaAction(value = '') {
  const text = String(value || '').trim().toLowerCase();
  const opening = text.match(/^([a-z]+)\b/)?.[1];
  if (!opening) return false;
  const noun = opening === 'review' ? 'review' : opening.replace(/e$/, '') + '(?:e|ing)?';
  return new RegExp(`\\bto\\s+(?:check|confirm|decide|determine|establish|understand)\\s+(?:if|whether)\\b[^.]{0,100}\\b${noun}\\b[^.]{0,40}\\b(?:need(?:ed|s)?|necessar(?:y|ily)|required)\\b`, 'i').test(text);
}

function ownerSet(record = {}) {
  return new Set((record.owners || []).map((owner) => String(owner).trim().toLowerCase()).filter(Boolean));
}

function compatibleOwners(left, right) {
  const a = ownerSet(left); const b = ownerSet(right);
  return !a.size || !b.size || [...a].some((owner) => b.has(owner));
}

function evidenceDistance(left = {}, right = {}) {
  const a = new Set(left.evidenceIds || []);
  if ((right.evidenceIds || []).some((id) => a.has(id))) return 0;
  const sequence = (id) => Number(String(id || '').match(/\d+/)?.[0] || NaN);
  let closest = Number.POSITIVE_INFINITY;
  for (const one of left.evidenceIds || []) for (const two of right.evidenceIds || []) {
    const x = sequence(one); const y = sequence(two);
    if (Number.isFinite(x) && Number.isFinite(y)) closest = Math.min(closest, Math.abs(x - y));
  }
  return closest;
}

// A short contact instruction is often emitted beside the concrete outcome of
// that contact: "Talk to Morgan" and "Obtain the implementation plan from
// Morgan" are one accountability item, not two. Keep this evidence-bounded so
// separate conversations with the same person remain separate, and do not
// collapse a contact row which already states a different purpose.
function bareContactFrame(record = {}) {
  const text = String(record.action || record.text || '').trim().replace(/[.?!]+$/, '');
  const match = text.match(/^(?:(?:talk|speak|chat|liaise|meet|check in|follow up)\s+(?:to|with)|(?:contact|call|chase|message))\s+(?:the\s+)?(.+)$/i);
  if (!match || /\b(?:about|regarding|concerning|for|so that|in order to|to (?:ask|check|confirm|discuss|obtain|request|review))\b/i.test(match[1])) return null;
  const contact = contentTokens(match[1]);
  if (!contact.length || contact.length > 5) return null;
  return { contact: new Set(contact), words: new Set(contentTokens(text)) };
}

function sameContactPurposeDeliverable(left = {}, right = {}) {
  if (!compatibleOwners(left, right) || evidenceDistance(left, right) > 6) return false;
  const leftBare = bareContactFrame(left); const rightBare = bareContactFrame(right);
  if (Boolean(leftBare) === Boolean(rightBare)) return false;
  const bare = leftBare || rightBare;
  const detailed = leftBare ? right : left;
  const detailedWords = new Set(contentTokens(detailed.action || detailed.text));
  if (![...bare.contact].every((word) => detailedWords.has(word))) return false;
  const addedMeaning = [...detailedWords].filter((word) => !bare.words.has(word));
  return addedMeaning.length >= 2;
}

// The two participants in one agreed check-in can be rendered from opposite
// sides: "check in with Morgan about the audit" (owned by Alex) and "speak to
// Alex about anything missing" (owned by Morgan).  Those are one conversation,
// not two deliverables.  This predicate only identifies the reciprocal frame;
// the caller must still prove which participant actually accepted the work.
function directedContactFrame(record = {}) {
  const value = String(record.action || record.text || '').trim().replace(/[.?!]+$/, '');
  const match = value.match(/^(?:touch base|check in|catch up|follow up|reach out|sync(?: up)?|have a (?:call|chat|catch-up) |talk|speak|chat|liaise|meet(?: up)?|contact|call|chase|message)\s+(?:(?:with|to)\s+)?(?:the\s+)?(.+?)(?=\s+\b(?:about|regarding|concerning|to|for|on)\b|[.;]|$)/i);
  if (!match) return null;
  const target = new Set(contentTokens(match[1]));
  return target.size && target.size <= 5 ? { target } : null;
}

function ownerMatchesTarget(record = {}, target = new Set()) {
  return [...ownerSet(record)].some((owner) => {
    const ownerWords = contentTokens(owner);
    return ownerWords.length && (ownerWords.every((word) => target.has(word))
      || [...target].every((word) => ownerWords.includes(word)));
  });
}

// The two sides of one agreed conversation are often cited from different
// moments of the same exchange (the offer, then the read-back), so allow a
// wider window than for ordinary duplicates; the reciprocal-owner test below
// is what keeps this narrow.
function sameReciprocalContactDeliverable(left = {}, right = {}) {
  if (evidenceDistance(left, right) > 12) return false;
  const a = directedContactFrame(left); const b = directedContactFrame(right);
  if (!a || !b) return false;
  return ownerMatchesTarget(left, b.target) && ownerMatchesTarget(right, a.target);
}

function questionCommunicationFrame(record = {}) {
  const words = tokens(record.action);
  if (!words.length || !COMMUNICATION_VERBS.has(words[0])) return null;
  const hasQuestionObject = words.some((word) => QUESTION_WORDS.has(word) || word === 'question');
  if (!hasQuestionObject) return null;

  // "Ask the supplier to send the questions" is a delegation, not another
  // wording of sending the questions. The owner columns may later differ, but
  // the action meaning itself should already keep these apart.
  let kind = 'question_communication';
  if (words[0] === 'ask') {
    const to = words.indexOf('to');
    if (to >= 0 && DELEGATED_VERBS.has(words[to + 1])) kind = 'delegated_question_communication';
  }

  const context = new Set(words.filter((word) => word.length > 2 && !FRAME_WORDS.has(word)));
  return { kind, context };
}

function contextCoverage(left, right) {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

function sameQuestionCommunicationDeliverable(left = {}, right = {}) {
  if (!compatibleOwners(left, right) || evidenceDistance(left, right) > 4) return false;
  const a = questionCommunicationFrame(left); const b = questionCommunicationFrame(right);
  if (!a || !b || a.kind !== b.kind) return false;
  // A generic execution row may omit the subjects listed in its fuller twin,
  // but it must still share almost all of its stated recipient/context words.
  return contextCoverage(a.context, b.context) >= 0.75;
}

module.exports = {
  questionCommunicationFrame,
  sameQuestionCommunicationDeliverable,
  sameOrNestedActionDeliverable,
  sameContactPurposeDeliverable,
  sameReciprocalContactDeliverable,
  circularMetaAction,
  actionClauses,
  conflictingActionRecipients
};
