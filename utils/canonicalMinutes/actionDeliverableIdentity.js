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
  sameQuestionCommunicationDeliverable
};
