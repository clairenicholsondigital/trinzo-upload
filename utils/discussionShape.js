'use strict';

// Shape rules for the minuted discussion that do not depend on any particular
// meeting. Actions are extracted separately from the transcript, so the body
// should record what was discussed and decided rather than list who is doing
// what a second time.

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

// One named person from THIS meeting taking on work: "Jo Marsh will handle
// ...", "Dan takes responsibility to ...". The name must belong to a speaker or
// someone the meeting mentions, so "Need to order ..." or "Agreement to supply
// ..." is never read as a person.
const ASSIGNMENT_PREDICATE = String.raw`(?:will|shall|is\s+to|is\s+going\s+to|to\s+(?!be\b)|takes\s+(?:responsibility|ownership)|has\s+taken\s+(?:responsibility|ownership)|is\s+responsible\s+for|agreed\s+to|confirmed\s+(?:to|for|on)|will\s+take\s+over|aims\s+to|committed\s+to|is\s+assigned|was\s+assigned|handles|owns)`;

// What makes a statement a group decision rather than one person's task.
const GROUP_DECISION = /\b(?:the (?:team|group|committee|meeting|board)|everyone|all agreed|we agreed|agreed that|decided that|approved|signed off|instead of|rather than|not to|chosen|choose|opted|rule|policy|in favour)\b/i;

function escapeName(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isSinglePersonAssignment(text, people = []) {
  const value = clean(text);
  if (!value) return false;
  if (/^(?:decision\s*:?\s*)?actions?\s+assigned\b/i.test(value)) return true;
  if (GROUP_DECISION.test(value)) return false;
  const opening = value.replace(/^(?:decision(?:\s+(?:to|that))?\s*:?\s*)/i, '');
  return (Array.isArray(people) ? people : []).some((name) => {
    const parts = clean(name).split(/\s+/).filter((part) => part.length >= 2);
    if (!parts.length) return false;
    const forms = [parts.join(' '), parts[0]].map(escapeName);
    return forms.some((form) => new RegExp(String.raw`^${form}\s+${ASSIGNMENT_PREDICATE}\b`, 'i').test(opening));
  });
}

// "Recap", "Summary of key actions", "Next steps for ...", "Job assignments",
// "Decisions on ... updates": titles that announce a restatement of actions.
const RECAP_TITLE = /\b(?:recap|summary of (?:the )?(?:key\s+)?(?:actions?|action items|next steps|decisions|responsibilities)|key (?:next steps|actions|action items)|action items?|actions? and responsibilities|job assignments|roles? (?:and responsibilities|confirmation|recap)|confirmation of (?:roles|responsibilities)|next steps|upcoming actions|decisions on .+ (?:updates|next steps))\b/i;

// A line that assigns or lists work: "Ines to split ...", "Alan will ...",
// "Action assigned: ...", "Key next steps include ...", "Plan to ...".
const ASSIGNMENT_LINE = /(?:^|[;:.]\s*)(?:actions?\s+assigned|key\s+(?:next\s+steps|actions)\s+include|next\s+steps\s+include|plan\s+to\b)/i;

// Anywhere in the line, a person from this meeting given work: "..., Andrew to
// check the spec and Rebecca to update the risk files".
function namesSomeoneWithWork(text, people = []) {
  const value = clean(text);
  return (Array.isArray(people) ? people : []).some((name) => {
    const parts = clean(name).split(/\s+/).filter((part) => part.length >= 2);
    if (!parts.length) return false;
    return [parts.join(' '), parts[0]].map(escapeName).some((form) => new RegExp(
      String.raw`\b${form}(?:'s|’s)?\s+(?:main\s+)?(?:will|is\s+to|to\s+(?!be\b)|takes|focus|is\s+responsible|confirms|confirmed\s+(?:for|on|to))\b`, 'i').test(value));
  });
}

function isAssignmentLine(text, people = []) {
  return ASSIGNMENT_LINE.test(clean(text)) || isSinglePersonAssignment(text, people) || namesSomeoneWithWork(text, people);
}

function topicItems(topic = {}) {
  return [
    ...(Array.isArray(topic.points) ? topic.points : []),
    ...(Array.isArray(topic.decisions) ? topic.decisions : []),
    ...(Array.isArray(topic.openQuestions) ? topic.openQuestions : [])
  ];
}

// Returns { discussion, demoted, droppedTopics } without mutating the input.
function shapeDiscussion(discussion = [], people = []) {
  const topics = (Array.isArray(discussion) ? discussion : []).map((topic) => ({
    ...topic,
    points: [...(Array.isArray(topic.points) ? topic.points : [])],
    decisions: [...(Array.isArray(topic.decisions) ? topic.decisions : [])],
    openQuestions: [...(Array.isArray(topic.openQuestions) ? topic.openQuestions : [])]
  }));
  let demoted = 0;
  for (const topic of topics) {
    const keep = [];
    for (const decision of topic.decisions) {
      if (isSinglePersonAssignment(decision?.text, people)) {
        topic.points.push(decision);
        demoted += 1;
      } else {
        keep.push(decision);
      }
    }
    topic.decisions = keep;
  }
  const droppedTopics = [];
  const result = [];
  for (const topic of topics) {
    // Open questions are always carried over, so they do not count towards
    // whether the topic is a restatement of tasks.
    const items = [...topic.points, ...topic.decisions];
    const assignmentShare = items.length
      ? items.filter((item) => isAssignmentLine(item?.text, people)).length / items.length
      : 0;
    if (RECAP_TITLE.test(clean(topic.topic)) && items.length && assignmentShare >= 0.6 && result.length) {
      // Anything that is not a restated task (a real decision, an open
      // question) moves to the previous topic rather than being lost.
      const previous = result[result.length - 1];
      previous.points.push(...topic.points.filter((item) => !isAssignmentLine(item?.text, people)));
      previous.decisions.push(...topic.decisions.filter((item) => !isAssignmentLine(item?.text, people)));
      previous.openQuestions.push(...topic.openQuestions);
      droppedTopics.push(clean(topic.topic));
      continue;
    }
    result.push(topic);
  }
  return { discussion: result, demoted, droppedTopics };
}

module.exports = {
  isSinglePersonAssignment,
  isAssignmentLine,
  shapeDiscussion,
  RECAP_TITLE
};
