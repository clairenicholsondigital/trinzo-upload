// Turns finished Meeting Minutes Agent minutes into the speaker-line text the
// project-update analyser reads, so a meeting is processed once by the minutes
// agent and the project report is built from those reviewed minutes.
//
// The analyser splits input into "Speaker: text" turns, and treats a line like
// "Name 10:30" as a timestamped turn. Every line here therefore starts with a
// plain label, and clock times inside the text are written as 10.30.

const MINUTES_LABEL = 'Minutes';

function cleanLine(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .replace(/(\d):(\d{2})/g, '$1.$2')
    .trim();
}

function asText(item) {
  if (item == null) return '';
  if (typeof item === 'string') return item;
  return item.text || '';
}

function sentence(value) {
  const text = cleanLine(value);
  if (!text) return '';
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

// A label the analyser accepts as a speaker: a capital letter followed by
// letters and spaces only.
function speakerLabel(value) {
  const label = cleanLine(value).replace(/[^A-Za-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!label || !/^[A-Z]/.test(label)) return MINUTES_LABEL;
  return label.slice(0, 60);
}

// `minutes` is the publication shape the minutes agent exports
// (details, executiveSummary, meetingObjectives, discussion[{topic, points}],
// actions[{owner, action, deadline}]).
function renderMinutesForProjectUpdate(minutes = {}, options = {}) {
  const lines = [];
  const details = minutes.details || {};
  const title = cleanLine(details.meetingTitle);
  const date = cleanLine(details.meetingDate);
  if (title || date) {
    lines.push(`${MINUTES_LABEL}: ${sentence([title, date ? `held ${date}` : ''].filter(Boolean).join(', '))}`);
  }

  const summary = cleanLine(minutes.executiveSummary);
  if (summary) lines.push(`${MINUTES_LABEL}: ${sentence(summary)}`);

  for (const objective of Array.isArray(minutes.meetingObjectives) ? minutes.meetingObjectives : []) {
    const text = sentence(asText(objective));
    if (text) lines.push(`${MINUTES_LABEL}: Objective: ${text}`);
  }

  for (const topic of Array.isArray(minutes.discussion) ? minutes.discussion : []) {
    const heading = cleanLine(topic && topic.topic);
    const prefix = heading && heading.toLowerCase() !== 'discussion' ? `${heading}: ` : '';
    const records = [
      ...(Array.isArray(topic && topic.points) ? topic.points : []).map(asText),
      ...(Array.isArray(topic && topic.decisions) ? topic.decisions : []).map((item) => `Decision: ${asText(item)}`),
      ...(Array.isArray(topic && topic.openQuestions) ? topic.openQuestions : []).map((item) => `Open question: ${asText(item)}`)
    ];
    for (const record of records) {
      const text = sentence(record);
      if (text) lines.push(`${MINUTES_LABEL}: ${prefix}${text}`);
    }
  }

  const actionList = options.includeActions === false ? [] : (Array.isArray(minutes.actions) ? minutes.actions : []);
  for (const action of actionList) {
    const task = cleanLine(action && action.action);
    if (!task) continue;
    const owner = cleanLine(action.owner);
    const deadline = cleanLine(action.deadline);
    const hasOwner = owner && owner.toLowerCase() !== 'not stated';
    const label = hasOwner ? speakerLabel(owner.split(',')[0]) : MINUTES_LABEL;
    const ownerText = hasOwner ? ` Owner: ${owner}.` : '';
    const dueText = deadline && deadline.toLowerCase() !== 'not stated' ? ` Due: ${deadline}.` : '';
    const verb = task.replace(/^to\s+/i, '').replace(/^([A-Z])(?=[a-z])/, (letter) => letter.toLowerCase());
    lines.push(`${label}: Action: I will ${sentence(verb)}${ownerText}${dueText}`);
  }

  return lines.join('\n');
}

// The reviewed actions from the minutes, in the project report's action shape.
// These replace the analyser's own action guesses, because the minutes agent
// has already extracted and the reviewer has already checked them.
function minutesActionsForProjectReport(actions = []) {
  return (Array.isArray(actions) ? actions : []).map((action) => {
    const task = cleanLine(action && action.action);
    if (!task) return null;
    const owner = cleanLine(action.owner);
    const deadline = cleanLine(action.deadline);
    return {
      action: sentence(task),
      related_milestone: 'unlinked',
      meetingActionPointOwner: owner && owner.toLowerCase() !== 'not stated' ? owner : 'Owner not specified',
      actionConfidence: 1,
      deadline: deadline && deadline.toLowerCase() !== 'not stated' ? deadline : '',
      source: 'meeting_minutes_agent'
    };
  }).filter(Boolean).slice(0, 100);
}

// Swap in the minutes' actions. Leaves the report alone when the minutes have
// no actions, so the analyser's output is never emptied by mistake.
function applyMinutesActionsToProjectReport(result, actions) {
  const report = result && result.projectReport;
  const minutesActions = Array.isArray(actions) ? actions : [];
  if (!report || typeof report !== 'object' || !minutesActions.length) return result;
  report.actions = minutesActions;
  report.actionsSource = 'meeting_minutes_agent';
  return result;
}

function minutesHaveContent(minutes = {}) {
  const discussion = Array.isArray(minutes.discussion) ? minutes.discussion : [];
  const hasDiscussion = discussion.some((topic) =>
    [...(topic.points || []), ...(topic.decisions || []), ...(topic.openQuestions || [])].some((item) => cleanLine(asText(item))));
  const hasActions = (Array.isArray(minutes.actions) ? minutes.actions : []).some((action) => cleanLine(action && action.action));
  return hasDiscussion || hasActions;
}

module.exports = {
  renderMinutesForProjectUpdate,
  minutesHaveContent,
  minutesActionsForProjectReport,
  applyMinutesActionsToProjectReport
};
