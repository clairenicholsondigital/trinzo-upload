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

// ---- One fact, one line -----------------------------------------------------
//
// The body is assembled from several sources - the model's own rows, recovered
// candidates, promoted supporting details - and each stage checks itself
// against what it can see at the time. The result is the same fact arriving
// twice in different words, most visibly as a figure spelled out beside its
// digits ("over a thousand pints" and "over 1000 pints"), or one assignment
// stated as a point, again in a recap line and again as a decision.
//
// This runs last, on the finished body, which is the only place every row is
// visible at once. It removes rows, never rewrites them.

const BODY_STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'those', 'these', 'then',
  'than', 'their', 'there', 'will', 'would', 'could', 'should', 'have', 'has', 'been', 'was', 'were', 'are',
  'not', 'but', 'its', 'his', 'her', 'our', 'your', 'about', 'also', 'more', 'some', 'any', 'all', 'they',
  'them', 'who', 'what', 'when', 'which', 'while', 'per', 'via', 'out', 'off', 'onto', 'over', 'under']);

const BODY_NUMBER_WORD = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90
};

function bodyTokens(value) {
  return (clean(value).toLowerCase().match(/[a-z0-9][a-z0-9'’-]{2,}/g) || [])
    .filter((token) => !BODY_STOP.has(token))
    .map((token) => token.replace(/(?:ing|ed|es|s)$/, ''));
}

// Figures as values, so "twelve hundred" matches 1200 and "a thousand" 1000.
function bodyFigures(value) {
  const words = clean(value).toLowerCase().replace(/[-–]/g, ' ');
  const found = new Set();
  for (const digit of words.match(/\d[\d,]*(?:\.\d+)?/g) || []) {
    const number = Number(digit.replace(/,/g, ''));
    if (Number.isFinite(number)) found.add(String(number));
  }
  let current = 0;
  let running = 0;
  const flush = () => {
    const total = running + current;
    if (total) found.add(String(total));
    current = 0; running = 0;
  };
  for (const token of words.match(/[a-z]+/g) || []) {
    if (BODY_NUMBER_WORD[token] != null) current += BODY_NUMBER_WORD[token];
    else if (token === 'hundred') current = (current || 1) * 100;
    else if (token === 'thousand') { running += (current || 1) * 1000; current = 0; }
    else flush();
  }
  flush();
  found.delete('1');
  return found;
}

function bodyOverlap(left, right) {
  const a = bodyTokens(left);
  const b = new Set(bodyTokens(right));
  if (!a.length || !b.size) return 0;
  return a.filter((token) => b.has(token)).length / Math.min(a.length, b.size);
}

// Sharing one small number is weak evidence: "the source of the three-second
// requirement" appears in a question and in advice about the same thing, and
// they are different rows. Two figures in common, or one distinctive one,
// marks the pair as the same statement.
function sharesFigure(left, right) {
  const other = bodyFigures(right);
  const shared = [...bodyFigures(left)].filter((figure) => other.has(figure));
  return shared.length >= 2 || shared.some((figure) => Number(figure) >= 10);
}

// Why a row repeats one that is already in the minutes, or '' when it does not.
function repeatsRow(value, kept) {
  const overlap = bodyOverlap(value, kept);
  if (overlap >= 0.6) return 'same wording';
  if (overlap >= 0.4 && sharesFigure(value, kept)) return 'same figures, different words';
  return '';
}

// "Alan to submit the application and check the towpath; Deepa to reorder the
// medals and manage social media" - a run-through of several people's jobs,
// each already minuted on its own line.
function recapsSeveralRows(value, keptTexts, people) {
  const named = (Array.isArray(people) ? people : []).filter((name) => {
    const parts = clean(name).split(/\s+/).filter((part) => part.length >= 2);
    if (!parts.length) return false;
    return [parts.join(' '), parts[0]].map(escapeName)
      .some((form) => new RegExp(String.raw`\b${form}\b`, 'i').test(value));
  });
  if (named.length < 2 || !namesSomeoneWithWork(value, people)) return '';
  const echoed = keptTexts.filter((kept) => bodyOverlap(value, kept) >= 0.3).length;
  return echoed >= 2 ? 'recaps rows already minuted' : '';
}

// "Action assigned to split the list and write the rationale before the next
// meeting", "Next steps: ...", "Actions: ..." - a line that announces what
// went on the actions list rather than recording what was discussed. The
// actions are extracted separately and shown in their own table, so this is
// minutes about the minutes.
const ANNOUNCES_ACTIONS = /^\s*(?:decision\s*:?\s*)?(?:actions?\s+(?:assigned|agreed|arising|identified|allocated)|next\s+steps?\s*(?:agreed|identified)?\s*[:\-]|actions?\s*[:\-]|action\s+points?\s*[:\-]|key\s+actions?\s*[:\-])/i;
function announcesActions(value) {
  return ANNOUNCES_ACTIONS.test(clean(value));
}

// Returns { discussion, dropped } without mutating the input. Open questions
// are never dropped: an unresolved question is not a restatement.
function dedupeDiscussionBody(discussion = [], people = []) {
  const dropped = [];
  const kept = [];
  const topics = (Array.isArray(discussion) ? discussion : []).map((topic) => {
    const next = { ...topic, points: [], decisions: [], openQuestions: [...(topic.openQuestions || [])] };
    // Decisions are settled first, so a point restating a decision is the row
    // that goes, not the other way round.
    for (const kind of ['decisions', 'points']) {
      for (const row of Array.isArray(topic?.[kind]) ? topic[kind] : []) {
        const value = clean(row?.text);
        if (!value) { next[kind].push(row); continue; }
        if (announcesActions(value)) {
          dropped.push({ text: value.slice(0, 200), because: 'announces the actions list', kept: '' });
          continue;
        }
        const match = kept.find((entry) => repeatsRow(value, entry.text));
        const because = match ? repeatsRow(value, match.text)
          : recapsSeveralRows(value, kept.map((entry) => entry.text), people);
        if (because) {
          dropped.push({ text: value.slice(0, 200), because, kept: (match?.text || '').slice(0, 120) });
          continue;
        }
        kept.push({ text: value });
        next[kind].push(row);
      }
    }
    return next;
  });
  return {
    discussion: topics.filter((topic) => topic.points.length || topic.decisions.length || topic.openQuestions.length),
    dropped
  };
}

module.exports = {
  isSinglePersonAssignment,
  isAssignmentLine,
  shapeDiscussion,
  dedupeDiscussionBody,
  announcesActions,
  RECAP_TITLE
};
