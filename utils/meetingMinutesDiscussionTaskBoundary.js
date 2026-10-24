'use strict';
const { isSinglePersonAssignment } = require('./discussionShape');
const { isReviewerAuthored } = require('./canonicalMinutes/state');

// A narrow publication veto, not an action extractor or a replacement verdict.
// Only unambiguous executable future assignments are filed. Mixed facts,
// decisions, questions, uncertain grammar and reviewer-owned trees stay put.
const WORK_VERB = '(?:arrange|book|call|chase|check|circulate|complete|confirm|contact|draft|email|finalise|finalize|follow\\s+up|forward|get|investigate|issue|liaise|order|organise|organize|prepare|produce|provide|review|schedule|send|share|sign|source|speak|submit|test|update|write)';
const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function futureWorkClause(value, people) {
  const text = String(value || '').trim();
  const names = [...new Set(people.flatMap(name => [String(name).trim(), String(name).trim().split(/\s+/)[0]]))]
    .filter(Boolean).sort((a, b) => b.length - a.length).map(escape);
  if (!names.length) return false;
  const person = `(?:${names.join('|')})`;
  const report = new RegExp(`^${person}(?:\\s+and\\s+${person})*\\s+(?:discuss|discusses|discussed|outline|outlines|outlined)\\s+plans?\\s+to\\s+${WORK_VERB}\\b`, 'i').exec(text);
  const direct = isSinglePersonAssignment(text, people)
    && new RegExp(`\\b(?:will|shall|is\\s+going\\s+to|is\\s+to)\\s+${WORK_VERB}\\b`, 'i').exec(text);
  if (!report && !direct) return false;
  const remainder = report ? text.slice(report[0].length)
    : text.replace(/^.*?\b(?:will|shall|is\s+going\s+to|is\s+to)\s+/i, '');
  const checked = report ? remainder.replace(new RegExp(`\\band\\s+${person}['’]s\\s+(?:review|update|inspection|assessment)\\b`, 'gi'), 'and work') : remainder;
  // A current/past fact, meaningful qualification or new subject is ambiguous.
  if (/:|\b(?:but|whereas|while|because|if|unless|once|provided|subject\s+to)\b|\b(?:is|are|was|were|has|have|had|can|cannot|could|would|should|must|already|currently|not|never|failed|fell|rose|reached|identified|reported|completed|started|stopped|supports|requires)\b/i.test(checked)
    || /\band\s+(?:the\b|[A-Z][\p{L}'’.-]+\b)/u.test(checked)) return false;
  return true;
}
function isPureFutureAssignment(value, people = []) {
  const text = String(value || '').trim();
  const clauses = [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)]
    .flatMap(part => part.segment.split(';')).map(part => part.trim()).filter(Boolean);
  return clauses.length > 0 && clauses.every(clause => futureWorkClause(clause, people));
}

function retainPureFutureAssignments(discussion = [], people = [], retain) {
  const retained = [];
  const protectedTree = record => isReviewerAuthored(record)
    || (record?.supportingDetails || []).some(protectedTree);
  const topics = discussion.map(topic => {
    if (isReviewerAuthored(topic) || /^manual-topic-/.test(String(topic.id || ''))) return topic;
    const points = (topic.points || []).filter(record => {
      if (protectedTree(record) || !isPureFutureAssignment(record.text, people)) return true;
      if (typeof retain !== 'function' || retain(record, {
        originalTopic: record.originalTopic || topic.topic, placementReason: 'action_only_discussion'
      }) !== true) return true;
      retained.push({ id: record.id, reason: 'action_only_discussion' });
      return false;
    });
    return { ...topic, points };
  }).filter(topic => (topic.points || []).length || (topic.decisions || []).length || (topic.openQuestions || []).length);
  return { discussion: topics, retained };
}
module.exports = { isPureFutureAssignment, retainPureFutureAssignments };
