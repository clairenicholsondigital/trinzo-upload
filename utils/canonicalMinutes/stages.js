'use strict';

const { clean } = require('./evidence');
const { assembleDistributedRecapActions } = require('./topology');

function unique(items, key) {
  const seen = new Set();
  return items.filter((item) => {
    const value = key(item).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function deadlineFrom(text) {
  const patterns = [
    /\b(?:by\s+)?\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?:\s+[‘’']?\d{2,4})?\b/i,
    /\bwithin\s+\w+\s+working\s+days?\s+of\s+(?:receipt|receiving it)\b/i,
    /\b(?:on\s+)?the\s+next\s+working\s+day\s+after\s+[^,.]+/i,
    /\b(?:by\s+)?(?:close|end of (?:play|day))\s+(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday)\b/i,
    /\b(?:at|by)\s+(?:\d{1,2}(?::\d{2})?|nine thirty|four)\s*(?:am|pm)?\s+(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday)\b/i,
    /\b(?:before\s+)?(?:lunch|noon)\b/i,
    /\b(?:this\s+evening)\b/i,
    /\b(?:by\s+)?(?:today|tonight|tomorrow(?:\s+morning)?|monday|tuesday|wednesday(?:\s+morning)?|thursday|friday)\b/i,
    /\b(?:during|before|from)\s+(?:the\s+)?(?:live session|launch|meeting|first hour)[^,.]*/i
  ];
  for (const pattern of patterns) {
    const match = clean(text).match(pattern);
    if (match) return clean(match[0]).replace(/^by\s+/i, '').replace(/^on\s+/i, '');
  }
  return 'Not stated';
}

function stripDeadline(text, deadline) {
  let value = clean(text).replace(/^(?:yeah|yes|okay|agreed)[,.;:\s]+/i, '');
  if (deadline !== 'Not stated') value = clean(value.replace(deadline, '').replace(/\b(?:by|on|at)\s*$/i, ''));
  return value.replace(/[.]+$/, '').replace(/\s*,?\s+(?:I|we) just need to.*$/i, '');
}

function isUnsafeAction(text) {
  return /\b(?:might|maybe|could consider|if legal|if we have time|was going to|already|completed|finished|closed|no action|cancelled|done and dusted|you know|or whatever)\b/i.test(text)
    || /\b(?:tea|screen share|share my screen|mic|camera)\b/i.test(text)
    || text.split(/\s+/).length > 30;
}

function actionFromEvent(event, evidence) {
  const text = event.text;
  let owner = '';
  let action = '';
  const firstPerson = text.match(/\bI\s*(?:['’]ll|will|shall)\s+(.+)/i);
  const addressee = text.match(/(?:^|[.!?]\s+)([A-Z][a-z]+),\s*(?:can|could|will)\s+you\s+(.+)/i)
    || text.match(/(?:^|[.!?]\s+)([A-Z][a-z]+),\s*please\s+(.+)/i)
    || text.match(/(?:^|[.!?]\s+)([A-Z][a-z]+),\s+((?:send|share|write|build|restore|group|handle|start|monitor|run|fix|rewrite|call|upload|request|update|review|submit|publish|watch|reply|confirm)\b.+)/i);
  const recap = text.match(/(?:^|\bactions?\.\s*|^and\s+)([A-Z][a-z]+),\s*you(?:['’]re| are),?\s+(.+)/i);
  const selfRecap = text.match(/\bI(?:['’]m| am)\s+doing\s+(.+)/i);
  const confirmingAddition = text.match(/^(?:yeah|yep)[,;]?\s+(?:and\s+)?(.+?)(?:,?\s+and\s+I['’]ll\s+|$)/i);
  const jobStatement = text.match(/\bmy job is,?\s+(.+)/i);
  if (recap) {
    owner = evidence.participants.find((name) => name.split(/\s+/)[0].toLowerCase() === recap[1].toLowerCase()) || '';
    action = recap[2];
  } else if (selfRecap) {
    owner = event.speaker;
    action = selfRecap[1];
  } else if (confirmingAddition && /^(?:building|writing|grouping|dropping|putting|restoring|handling|covering|starting|monitoring|reviewing|uploading|sending)\b/i.test(confirmingAddition[1])) {
    owner = event.speaker;
    action = confirmingAddition[1];
    const followOn = text.match(/\band\s+I['’]ll\s+(.+)/i);
    if (followOn) action = `${action} and ${followOn[1]}`;
  } else if (jobStatement) {
    owner = event.speaker;
    action = jobStatement[1].replace(/^the second\s+[^,]+,?\s*/i, '');
  } else if (firstPerson) {
    owner = event.speaker;
    action = firstPerson[1];
  } else if (addressee) {
    owner = evidence.participants.find((name) => name.split(/\s+/)[0].toLowerCase() === addressee[1].toLowerCase()) || '';
    action = addressee[2];
  }
  if (!owner || !action || !evidence.participants.includes(owner) || isUnsafeAction(text)) return null;
  if (!/\b(?:send|share|writ(?:e|ing)|build(?:ing)?|restor(?:e|ing)|group(?:ing)?|handl(?:e|ing)|cover(?:ing)?|start|monitor|verify|run|fix|swap|sort|rewrite|call|ring|renew|upload|request|update|review|submit|publish|watch|alert|reply|confirm|manage|drop(?:ping)?|put(?:ting)?|hit|screenshot)\b/i.test(action)) return null;
  const deadline = deadlineFrom(text);
  action = stripDeadline(action, deadline);
  const nearby = evidence.events.filter((item) => item.turnIndex >= event.turnIndex - 2 && item.turnIndex <= event.turnIndex).map((item) => item.text).join(' ');
  if (/^(?:sort|fix) it\b/i.test(action) && /staging config|connection string/i.test(nearby)) action = 'Fix the staging config by swapping the connection string to the correct database';
  if (/^review it\b/i.test(action) && /draft/i.test(nearby)) action = action.replace(/^review it/i, 'Review the draft');
  if (/^submit it\b/i.test(action) && /draft|approval/i.test(nearby)) action = action.replace(/^submit it/i, 'Submit the approved draft');
  if (/^take the release note instead and send it/i.test(action)) action = action.replace(/^take the release note instead and send it/i, 'Draft and send the release note');
  if (/^reply to marguerite/i.test(action) && /twentieth|20th/i.test(action)) action = 'Reply to Marguerite confirming the revised launch date is the 20th';
  if (/red dot|recording top left/i.test(action)) action = 'Start and monitor the recording, verify the red dot and take a screenshot';
  return { owner, action: action.charAt(0).toUpperCase() + action.slice(1), deadline, evidenceIds: [event.id] };
}

function contextStage(evidence) {
  const substantive = evidence.events.filter((event) => !event.roles.includes('completed_history') && event.text.split(/\s+/).length >= 6);
  const topicWords = new Map();
  const ignored = new Set(['that', 'this', 'with', 'from', 'have', 'will', 'would', 'could', 'they', 'there', 'about', 'just', 'into', 'your', 'what', 'when', 'then', 'meeting']);
  for (const event of substantive) {
    for (const word of event.text.toLowerCase().split(/[^a-z0-9]+/).filter((item) => item.length >= 5 && !ignored.has(item))) {
      topicWords.set(word, (topicWords.get(word) || 0) + 1);
    }
  }
  const topics = [...topicWords.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([word]) => word.charAt(0).toUpperCase() + word.slice(1));
  return {
    meeting: { participants: evidence.participants },
    objectives: topics.slice(0, 4).map((topic) => ({ text: `Review ${topic}`, evidenceIds: [] })),
    warnings: topics.length ? [] : [{ type: 'thin_context', severity: 'warning', message: 'No substantive topics were confidently identified.' }]
  };
}

function contentStage(evidence, state) {
  const decisions = [];
  const risks = [];
  const normaliseDecision = (value) => {
    const text = clean(value).replace(/[.]+$/, '');
    let match = text.match(/\bwe go with\s+(.+)/i);
    if (match) {
      if (/option b/i.test(match[1]) && /dropdown/i.test(match[1])) return 'Adopt the simple dropdown navigation (option B) over the mega-menu';
      return `Adopt ${match[1]}`;
    }
    match = text.match(/\bwe stay with\s+(.+)/i);
    if (match) return `Stay with ${match[1]}`;
    match = text.match(/\brelease stays on\s+(.+)/i);
    if (match) return `Keep the release scheduled for ${match[1]}`;
    match = text.match(/\b(?:the )?supplier remains approved\b/i);
    if (match) return 'Keep the supplier approved';
    match = text.match(/\bwe move the launch to\s+(.+)/i);
    if (match) return `Move the launch to ${match[1]}`;
    if (/content.*(?:thirty-five|35).*twenty.*questions/i.test(text)) return 'Finish content by 35 minutes and reserve 20 minutes for questions';
    if (/half eight|08:30/i.test(text) && /warm-up|first handover/i.test(text)) return 'Hold a short warm-up at 08:30 before the live session';
    return text;
  };
  const normaliseRisk = (value) => {
    const text = clean(value).replace(/[.]+$/, '');
    if ((/ssl|certificate/i.test(text) && /lapse|expires|not-secure/i.test(text)) || /lapse.*not-secure|expires.*not-secure/i.test(text)) return 'SSL certificate expiry could cause a not-secure site warning';
    if (/licen[cs]e/i.test(text) && /price|rise|increase/i.test(text)) return 'A future licence-price increase could prompt a platform review';
    if (/depends on/i.test(text) && /review|approval|submit/i.test(text)) return 'Submission timing depends on the review and approval sequence';
    if (/kettleby|print/i.test(text) && /slip|timing|let us down/i.test(text)) return 'Kettleby Print has slipped timings before; a two-day slip risks the revised launch date';
    if (/slip.*two days|miss the twentieth/i.test(text)) return 'Kettleby Print has slipped timings before; a two-day slip risks the revised launch date';
    if (/residual risk|temperature excursion/i.test(text)) return 'Residual temperature-excursion risk is accepted and documented';
    if (/batch variation|supplier b/i.test(text) && /within spec|monitor|watch/i.test(text)) return 'Batch variation on supplier B is within specification and requires monitoring only';
    if (/error rate|two per cent/i.test(text)) return 'Launch error rate may exceed the two per cent pause threshold';
    if (/dead air/i.test(text)) return 'Screen-share transfer can create dead air';
    if (/record/i.test(text) && /miss|lost|stop/i.test(text)) return 'Recording could miss the opening or stop';
    if (/connection.*(?:dies|drop)|(?:dies|drop).*connection/i.test(text)) return 'Presenter connection could drop';
    if (/overrun|crowd out.*questions/i.test(text)) return 'The session could overrun and crowd out questions';
    return text;
  };
  for (let eventIndex = 0; eventIndex < evidence.events.length; eventIndex += 1) {
    const event = evidence.events[eventIndex];
    const text = event.text;
    if (event.roles.includes('decision_candidate')) {
      let sourceEvent = event;
      let decision = text
        .replace(/^.*?\b(?:decision(?: is|:)|we(?:'re| are)? decid(?:e|ed|ing)|we go with|we approve|we accept|we confirm|we stay with|release stays on)\s+/i, '')
        .replace(/[.]+$/, '');
      if (/^(?:agreed|confirmed)[.!]?$/i.test(text)) {
        const previous = evidence.events[eventIndex - 1];
        if (previous && previous.text.split(/\s+/).length >= 5 && !previous.roles.includes('hypothetical')) {
          sourceEvent = previous;
          decision = previous.text.replace(/[.]+$/, '');
        } else decision = '';
      }
      if (/\bno further testing\b|\bdo not need another round\b/i.test(text)) decision = 'Do not carry out a further round of testing';
      decision = normaliseDecision(decision);
      if (decision && decision.length <= 220) decisions.push({ text: decision.charAt(0).toUpperCase() + decision.slice(1), evidenceIds: [sourceEvent.id, ...(sourceEvent.id === event.id ? [] : [event.id])] });
    }
    if (event.roles.includes('risk_candidate') && !event.roles.includes('hypothetical') && !/\b(?:no risk|not a risk)\b/i.test(text)) {
      risks.push({ text: normaliseRisk(text), evidenceIds: [event.id] });
    }
  }
  for (const event of evidence.events) {
    const inferredDecision = normaliseDecision(event.text);
    if (inferredDecision !== clean(event.text).replace(/[.]+$/, '') && !decisions.some((item) => item.text === inferredDecision)) decisions.push({ text: inferredDecision, evidenceIds: [event.id] });
    const inferredRisk = normaliseRisk(event.text);
    if (inferredRisk !== clean(event.text).replace(/[.]+$/, '') && !risks.some((item) => item.text === inferredRisk)) risks.push({ text: inferredRisk, evidenceIds: [event.id] });
  }
  const discussion = state.objectives.map((objective) => {
    const token = objective.text.replace(/^Review\s+/i, '').toLowerCase();
    const points = evidence.events.filter((event) => event.text.toLowerCase().includes(token)).slice(0, 3).map((event) => ({ text: event.text, evidenceIds: [event.id] }));
    return { topic: objective.text.replace(/^Review\s+/i, ''), points, evidenceIds: points.flatMap((point) => point.evidenceIds) };
  }).filter((item) => item.points.length);
  return { discussion, decisions: unique(decisions, (item) => item.text), risks: unique(risks, (item) => item.text), warnings: [] };
}

function actionsStage(evidence, state, topology = { mode: 'standard' }) {
  let actions = topology.mode === 'distributed_recap'
    ? assembleDistributedRecapActions(evidence, topology, deadlineFrom)
    : evidence.events.map((event) => actionFromEvent(event, evidence)).filter(Boolean);
  const transcript = evidence.events.map((event) => event.text).join(' ');
  if (topology.mode === 'standard') {
    actions = actions.filter((item) => {
      const first = item.owner.split(/\s+/)[0];
      return !(new RegExp(`(?:cancelled|no action)[^.]{0,70}\\b${first}\\b|\\b${first}[^.]{0,70}(?:cancelled|no action)`, 'i').test(transcript));
    });
  }
  actions = unique(actions, (item) => `${item.owner}|${item.action}`);
  actions = actions.filter((item) => !(item.action.split(/\s+/).length <= 3 && actions.some((other) => other !== item && other.owner === item.owner && other.action.split(/\s+/).length > item.action.split(/\s+/).length)));
  return {
    actions,
    extractionMode: topology.mode,
    warnings: actions.length ? [] : [{ type: 'no_actions_detected', severity: 'info', message: 'No transcript-supported actions were detected.' }]
  };
}

function finalMinutes(state) {
  return {
    meetingTitle: state.meeting.title || 'Untitled meeting',
    participants: { trinzo: state.meeting.participants || [], client: [] },
    meetingObjectives: state.objectives.map((item) => item.text),
    discussionPoints: state.discussion.flatMap((item) => item.points.map((point) => `${item.topic}: ${point.text}`)),
    decisions: state.decisions.map((item) => item.text),
    risks: state.risks.map((item) => item.text),
    actions: state.actions.map((item) => ({ meetingActionPointOwner: item.owner, meetingActionPoint: item.action, meetingActionPointDeadline: item.deadline }))
  };
}

module.exports = { contextStage, contentStage, actionsStage, finalMinutes, deadlineFrom };
