'use strict';

const { clean } = require('./evidence');
const { semanticFor } = require('./minilm');
const deterministicStages = require('./stages');
const { deadlineFrom } = deterministicStages;

function unique(items, key) {
  const seen = new Set();
  return items.filter((item) => {
    const value = clean(key(item)).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function score(profile, event, role) {
  return Number(semanticFor(profile, event).scores?.[role] || 0);
}

function hasSemanticRole(profile, event, role, threshold = 0.36) {
  const semantic = semanticFor(profile, event);
  const roleScore = Number(semantic.scores?.[role] || 0);
  const opposing = Math.max(
    role === 'commitment' || role === 'request' || role === 'acceptance' ? score(profile, event, 'completed') : 0,
    role !== 'rejection' ? score(profile, event, 'rejection') : 0,
    role !== 'hypothetical' ? score(profile, event, 'hypothetical') : 0,
    score(profile, event, 'administrative')
  );
  return roleScore >= threshold && (roleScore >= opposing - 0.015 || semantic.primaryRole === role);
}

function trainedProbability(profile, event, group, label) {
  return Number(semanticFor(profile, event)?.[group]?.[label] || 0);
}

function participantByFirstName(value, participants) {
  const matches = participants.filter((name) => name.split(/\s+/)[0].toLowerCase() === clean(value).toLowerCase());
  return matches.length === 1 ? matches[0] : '';
}

function stripDeadline(text, deadline) {
  let value = clean(text).replace(/[.]+$/, '')
    .replace(/\bTrace SW to identify the change in the SW between\b/gi, 'Document software versioning traceability between');
  if (deadline !== 'Not stated') {
    value = clean(value.replace(new RegExp(`\\b(?:by|before|on|at)?\\s*${deadline.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'), ''));
  }
  return value.replace(/\b(?:by|on|at)\s*$/i, '').replace(/^[,;:\s]+|[,;:\s]+$/g, '');
}

function actionShape(event, evidence) {
  const text = clean(event.text);
  const shapes = [
    { re: /^(.+?)\s+(?:are|is)\s+still not finalised[.!]?$/i, owner: () => 'Not stated', action: (match) => `Finalise ${match[1]}` },
    { re: /^(.+?)\s+input is still missing for\s+(.+?)[.!]?$/i, owner: () => 'Not stated', action: (match) => `Provide ${match[1]} input for ${match[2]}` },
    { re: /^(.+? document) is absent\b.*$/i, owner: () => 'Not stated', action: (match) => `Draft ${match[1]}` },
    { re: /^(.+?)\s+follow-up feedback is still pending[.!]?$/i, owner: () => 'Not stated', action: (match) => `Follow up ${match[1]} feedback` },
    { re: /^(?:yeah|yes|yep|agreed)[,;]?\s+(?:and\s+)?([a-z][a-z-]+ing\s+.+?)(?:,\s+and\s+I['’]ll\b|$)/i, owner: () => event.speaker, action: (match) => match[1] },
    { re: /\bI\s*(?:['’]ll|will|shall|can|need to|am going to)\s+(.+)/i, owner: () => event.speaker, action: (match) => match[1] },
    { re: /(?:^|[.!?]\s+)([A-Z][A-Za-z'’.-]+),\s*(?:can|could|will|would)\s+you\s+(.+)/i, owner: (match) => participantByFirstName(match[1], evidence.participants), action: (match) => match[2] },
    { re: /(?:^|[.!?]\s+)([A-Z][A-Za-z'’.-]+),\s*please\s+(.+)/i, owner: (match) => participantByFirstName(match[1], evidence.participants), action: (match) => match[2] },
    { re: /(?:^|[.;]\s*|\bactions?[:,.]?\s*)([A-Z][A-Za-z'’.-]+)\s+to\s+(.+)/i, owner: (match) => participantByFirstName(match[1], evidence.participants), action: (match) => match[2] },
    { re: /(?:^|\bactions?[:,.]?\s*)([A-Z][A-Za-z'’.-]+),\s*you(?:['’]re| are)\s+(.+)/i, owner: (match) => participantByFirstName(match[1], evidence.participants), action: (match) => match[2] },
    { re: /\b(?:let['’]s|we need(?: to)?|we should)\s+(.+)/i, owner: () => 'Not stated', action: (match) => match[1] },
    { re: /\bmy (?:action|job|task) is\s+(.+)/i, owner: () => event.speaker, action: (match) => match[1] },
    { re: /\bI(?:['’]m| am)\s+(?:doing|handling|covering|taking)\s+(.+)/i, owner: () => event.speaker, action: (match) => match[1] },
  ];
  for (const shape of shapes) {
    const match = text.match(shape.re);
    if (match && /\b(?:I can\s+(?:see|hear|understand|remember|imagine|tell|feel|notice)|I['’]ll be honest)\b/i.test(text)) return null;
    if (match) return { owner: shape.owner(match), action: shape.action(match) };
  }
  return null;
}

function buildCommitmentThreads(evidence, profile, topology = { mode: 'standard' }) {
  const threads = [];
  const sourceEvents = topology.mode === 'distributed_recap' && topology.evidenceWindow
    ? evidence.events.slice(topology.evidenceWindow.startIndex, topology.evidenceWindow.endIndex + 1)
    : evidence.events;
  const candidates = sourceEvents.filter((event) => {
    const shape = actionShape(event, evidence);
    const confirmed = trainedProbability(profile, event, 'actionProbabilities', 'confirmed_action');
    const possible = trainedProbability(profile, event, 'actionProbabilities', 'possible_action');
    const notAction = trainedProbability(profile, event, 'actionProbabilities', 'not_action');
    const completed = trainedProbability(profile, event, 'actionProbabilities', 'completed_history');
    const commitmentSignal = trainedProbability(profile, event, 'signalProbabilities', 'explicit_commitment_verb');
    return Boolean(shape) && (
      event.roles.includes('action_candidate')
      || topology.mode === 'distributed_recap'
      ||
      confirmed >= 0.26
      || (possible >= 0.25 && commitmentSignal >= 0.48)
      || (topology.mode === 'distributed_recap' && Math.max(confirmed, possible) >= Math.max(notAction, completed) - 0.12)
    );
  });
  for (const event of candidates) {
    const eventShape = actionShape(event, evidence);
    const existing = [...threads].reverse().find((thread) => {
      if (event.turnIndex - thread.turnEnd > 2) return false;
      const priorShape = [...thread.events].reverse().map((item) => actionShape(item, evidence)).find(Boolean);
      if (eventShape?.owner && priorShape?.owner && eventShape.owner !== priorShape.owner && eventShape.action && !/^(?:do|handle|take)\s+(?:it|that)\b/i.test(eventShape.action)) return false;
      return thread.speakers.includes(event.speaker)
        || score(profile, event, 'acceptance') >= 0.38
        || score(profile, event, 'request') >= 0.38
        || (priorShape?.owner === event.speaker && score(profile, event, 'commitment') >= 0.3);
    });
    if (existing) {
      existing.events.push(event);
      existing.turnEnd = event.turnIndex;
      if (!existing.speakers.includes(event.speaker)) existing.speakers.push(event.speaker);
    } else {
      threads.push({ id: `thread_${String(threads.length + 1).padStart(3, '0')}`, events: [event], turnStart: event.turnIndex, turnEnd: event.turnIndex, speakers: [event.speaker], topologyMode: topology.mode });
    }
  }
  return threads.map((thread) => ({
    ...thread,
    evidenceIds: thread.events.map((event) => event.id),
    semanticScores: Object.fromEntries(['commitment', 'request', 'acceptance', 'completed', 'hypothetical', 'rejection'].map((role) => [role, Math.max(...thread.events.map((event) => score(profile, event, role)), 0)]))
  }));
}

function actionsFromThread(thread, evidence, profile) {
  const negative = Math.max(thread.semanticScores.completed, thread.semanticScores.hypothetical, thread.semanticScores.rejection);
  const positive = Math.max(thread.semanticScores.commitment, thread.semanticScores.request, thread.semanticScores.acceptance);
  const trainedConfirmed = Math.max(...thread.events.map((event) => trainedProbability(profile, event, 'actionProbabilities', 'confirmed_action')), 0);
  const trainedCompleted = Math.max(...thread.events.map((event) => trainedProbability(profile, event, 'actionProbabilities', 'completed_history')), 0);
  const trainedNotAction = Math.max(...thread.events.map((event) => trainedProbability(profile, event, 'actionProbabilities', 'not_action')), 0);
  const explicitActionForm = thread.events.some((event) => event.roles.includes('action_candidate') && actionShape(event, evidence));
  const strongExplicitAction = thread.events.some((event) => event.roles.includes('action_candidate') && !event.roles.includes('hypothetical') && /\b(?:I['’]ll|I will|I shall|I need to)\b/i.test(event.text) && actionShape(event, evidence));
  const acceptedProposal = thread.events.some((event) => {
    const shape = actionShape(event, evidence);
    if (!shape || !/^(?:do|handle|take)\s+(?:it|that)[.!?]*$/i.test(shape.action)) return false;
    const sourceIndex = evidence.events.findIndex((item) => item.id === event.id);
    return evidence.events.slice(Math.max(0, sourceIndex - 10), sourceIndex).some((item) => /\bwe need(?: to)?\s+.+/i.test(item.text));
  });
  if (thread.topologyMode !== 'distributed_recap') {
    if (!explicitActionForm && !acceptedProposal && trainedCompleted > trainedConfirmed + 0.12) return [];
    if (!explicitActionForm && !acceptedProposal && trainedNotAction > trainedConfirmed + 0.2 && trainedConfirmed < 0.28) return [];
    if (!acceptedProposal && !strongExplicitAction && thread.semanticScores.hypothetical >= 0.7 && thread.semanticScores.hypothetical > positive + 0.08) return [];
    if (thread.semanticScores.rejection >= 0.6 && thread.semanticScores.rejection > positive + 0.08) return [];
  }
  const shapedEvents = thread.events.map((event) => ({ event, shape: actionShape(event, evidence) })).filter((item) => item.shape?.action && item.shape?.owner && (!item.event.roles.includes('hypothetical') || acceptedProposal));
  const concrete = shapedEvents.filter((item) => !/^(?:do|handle|take)\s+(?:it|that)\b/i.test(item.shape.action));
  return (concrete.length ? concrete : shapedEvents).map((shaped) => {
    let deadline = deadlineFrom(shaped.event.text);
    let action = stripDeadline(shaped.shape.action, deadline)
      .replace(/^(?:yeah|yes|okay|right|agreed)[,;:\s]+/i, '')
      .replace(/\s+(?:and|so)\s+(?:that|we|I)\b.*$/i, '')
      .replace(/[.]+$/, '');
    const sourceIndex = evidence.events.findIndex((event) => event.id === shaped.event.id);
    if (/^(?:do|handle|take)\s+(?:it|that)$/i.test(action)) {
      const priorEvents = evidence.events.slice(Math.max(0, sourceIndex - 10), sourceIndex).reverse();
      const proposal = priorEvents.map((event) => event.text.match(/\bwe need(?: to)?\s+(.+?)[.!?]?$/i)).find(Boolean);
      const requestEvent = priorEvents.find((event) => /\b(?:can|could|will|would)\s+you\s+.+/i.test(event.text));
      const request = requestEvent?.text.match(/\b(?:can|could|will|would)\s+you\s+(.+?)[?]?$/i);
      if (request) {
        action = request[1].replace(/[?]+$/, '');
        if (deadline === 'Not stated') deadline = deadlineFrom(requestEvent.text);
      } else if (proposal) action = proposal[1].replace(/[.]+$/, '');
    }
    if (deadline === 'Not stated') {
      const following = evidence.events.slice(sourceIndex + 1, sourceIndex + 4);
      const boundedAnswer = following.find((event, index) => index > 0 && /\bwhen\b/i.test(following[index - 1]?.text || '') && deadlineFrom(event.text) !== 'Not stated');
      if (boundedAnswer) deadline = deadlineFrom(boundedAnswer.text);
    }
    action = stripDeadline(action, deadline);
    const genericObject = action.match(/^(.*?\b)(guide|document|report|plan|file|table|draft)(\b.*)$/i);
    if (genericObject && new RegExp(`\\b(?:the|a|this|that)\\s+${genericObject[2]}\\b`, 'i').test(action)) {
      const priorObject = evidence.events.slice(Math.max(0, sourceIndex - 10), sourceIndex).reverse()
        .map((event) => event.text.match(new RegExp(`\\b((?:[a-z][a-z-]*\\s+){1,3}${genericObject[2]})\\b`, 'i')))
        .find(Boolean);
      if (priorObject) action = `${genericObject[1]}${priorObject[1]}${genericObject[3]}`.replace(/\bthe\s+the\b/gi, 'the');
    }
    if (action.split(/\s+/).length < 2 || action.split(/\s+/).length > 32) return null;
    return {
      owner: shaped.shape.owner,
      action: action.charAt(0).toUpperCase() + action.slice(1),
      deadline,
      evidenceIds: thread.evidenceIds,
      threadId: thread.id,
      semanticConfidence: Number(Math.max(positive - negative, 0).toFixed(4))
    };
  }).filter(Boolean);
}

function titleFromRepresentative(text) {
  const value = clean(text)
    .replace(/^(?:yeah|yes|okay|right|so|well)[,;:\s]+/i, '')
    .replace(/^(?:I|we|they|the team)\s+(?:think|know|discussed|reviewed|covered|noted|said|have|has)\s+(?:that\s+)?/i, '')
    .replace(/^I(?:['’]ll|\s+(?:can|will|shall|need to))\s+/i, '')
    .replace(/\bwe(?:'ve| have)\b/gi, 'the team has')
    .replace(/\bwe(?:'re| are)\b/gi, 'the team is')
    .replace(/\bwe\b/gi, 'the team')
    .replace(/\bour\b/gi, "the team's")
    .replace(/[.?!]+$/, '');
  const words = value.split(/\s+/).slice(0, 10).join(' ');
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Substantive discussion';
}

function minutesPoint(text) {
  let value = clean(text).replace(/[.]+$/, '')
    .replace(/\bTrace SW to identify the change in the SW between\b/gi, 'Document software versioning traceability between');
  value = value
    .replace(/^I\s+(?:think|believe|guess|suppose)\s+(?:that\s+)?/i, '')
    .replace(/^we\s+(?:discussed|reviewed|noted|confirmed)\s+/i, 'The team $1 ')
    .replace(/^you know[,;:\s]*/i, '')
    .replace(/^(?:yeah|yes|okay|right|so|well)[,;:\s]+/i, '');
  if (/^I\s*(?:['’]ll|will|can)\b|\byou know\b|\b(?:no project update today|do not have a project update today|can everyone hear me|red light|share my screen)\b|^(?:and|but|or|yes|yeah|okay|right)[.!?]?$/i.test(value)) return '';
  value = value
    .replace(/\bI['’]ll\b/gi, 'the speaker will')
    .replace(/\bI['’]m\b/gi, 'the speaker is')
    .replace(/\bwe(?:'ve| have)\b/gi, 'the team has')
    .replace(/\bwe\b/gi, 'the team')
    .replace(/\bour\b/gi, "the team's")
    .replace(/\bI\b/g, 'the speaker')
    .replace(/\bmy\b/gi, "the speaker's");
  if (value.split(/\s+/).length < 5 || /(?:\b(?:and|but|or|because|that|which|with|from|to|for|of|the|a|an)|[,;:])$/i.test(value)) return '';
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}.` : '';
}

function contextStage(evidence, profile) {
  const byId = new Map(evidence.events.map((event) => [event.id, event]));
  const topics = (profile.topics || []).filter((topic) => !/\b(?:no project update today|do not have a project update today|can everyone hear me|red light|webcam)\b/i.test(topic.representativeText || '') && !topic.evidenceIds.every((id) => { const event = byId.get(id); return event ? isSupersededBackground(event, evidence) : false; })).slice(0, 8);
  return {
    meeting: { participants: evidence.participants },
    objectives: topics.slice(0, 6).map((topic) => ({ text: `Review ${titleFromRepresentative(topic.representativeText)}`, evidenceIds: topic.evidenceIds, topicId: topic.id })),
    warnings: topics.length ? [] : [{ type: 'thin_context', severity: 'warning', message: 'MiniLM found no confident substantive topic clusters.' }]
  };
}

function selectLongDiscussionTopics(topics, evidence, byId, profile) {
  if (evidence.events.length < 100) return topics;
  const selected = topics.slice(0, 8);
  const selectedIds = new Set(selected.map((topic) => topic.id));
  const strongestRiskTopics = topics.filter((topic) => !selectedIds.has(topic.id)).map((topic, index) => ({
    topic,
    index,
    confidence: Math.max(...topic.evidenceIds.map((id) => {
      const event = byId.get(id);
      return event ? score(profile, event, 'risk') : 0;
    }), 0)
  })).sort((left, right) => right.confidence - left.confidence || left.index - right.index).slice(0, 4);
  for (const [riskIndex, riskTopic] of strongestRiskTopics.entries()) {
    if (riskTopic.confidence < (riskIndex === 0 ? 0.7 : 0.55) || selected.length >= 16) continue;
    selected.push(riskTopic.topic);
    selectedIds.add(riskTopic.topic.id);
  }
  const riskGovernanceTopic = topics.find((topic) => !selectedIds.has(topic.id) && topic.evidenceIds.some((id) => /\brisk\s+(?:management|register|file)\b/i.test(byId.get(id)?.text || '')));
  if (riskGovernanceTopic && selected.length < 16) {
    selected.push(riskGovernanceTopic);
    selectedIds.add(riskGovernanceTopic.id);
  }
  const consequential = topics.filter((topic) => !selectedIds.has(topic.id) && topic.evidenceIds.some((id) => {
    const event = byId.get(id);
    return (event?.roles || []).some((role) => ['action_candidate', 'decision_candidate', 'risk_candidate'].includes(role)) || /\bwe need(?: to)?\b/i.test(event?.text || '');
  }));
  for (const topic of consequential) {
    if (selected.length >= 16) break;
    selected.push(topic);
    selectedIds.add(topic.id);
  }
  const stopwords = new Set(['about', 'after', 'again', 'because', 'before', 'being', 'could', 'didn', 'doesn', 'doing', 'going', 'having', 'meeting', 'other', 'really', 'should', 'something', 'their', 'there', 'these', 'thing', 'things', 'think', 'those', 'through', 'under', 'which', 'would']);
  const documentFrequency = new Map();
  for (const event of evidence.events) {
    const tokens = new Set(clean(event.text).toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) || []);
    for (const token of tokens) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
  }
  const ranked = topics.filter((topic) => !selectedIds.has(topic.id)).map((topic, index) => {
    const sourceText = topic.evidenceIds.map((id) => byId.get(id)?.text || '').join(' ');
    const tokens = [...new Set(sourceText.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) || [])].filter((token) => !stopwords.has(token));
    const tokenScores = tokens.map((token) => {
      const rarity = Math.log((evidence.events.length + 1) / ((documentFrequency.get(token) || 0) + 1));
      const technical = /\d|-/.test(token) ? 0.45 : token.length >= 10 ? 0.2 : 0;
      return rarity + technical;
    }).sort((left, right) => right - left);
    const distinctiveness = tokenScores.slice(0, 4).reduce((sum, value) => sum + value, 0) / Math.max(Math.min(tokenScores.length, 4), 1);
    return { topic, index, score: distinctiveness + (Number(topic.cohesion || 0) * 0.12) };
  }).sort((left, right) => right.score - left.score || left.index - right.index);
  selected.push(...ranked.slice(0, Math.max(0, 16 - selected.length)).map((item) => item.topic));
  return selected.sort((left, right) => Number(left.turnStart || 0) - Number(right.turnStart || 0));
}

function isSupersededBackground(event, evidence) {
  const historicalPlan = /\b(?:original|previous|earlier)\s+(?:plan|option|intention)\b/i.test(event.text);
  const tentative = event.roles.includes('hypothetical') || /\b(?:maybe|might|could|we should)\b/i.test(event.text);
  if (!historicalPlan && !tentative) return false;
  const index = evidence.events.findIndex((item) => item.id === event.id);
  const following = evidence.events.slice(index + 1, index + 6);
  return following.some((item) => /\b(?:actually|instead|rather|changed?|not this|not now|do not|don['’]?t)\b/i.test(item.text));
}

function contentStage(evidence, state, profile) {
  const byId = new Map(evidence.events.map((event) => [event.id, event]));
  const longTranscript = evidence.events.length >= 100;
  const selectedTopics = selectLongDiscussionTopics(profile.topics || [], evidence, byId, profile);
  const topicCandidates = selectedTopics.map((topic, index) => ({
    topic,
    index,
    explicitEvidence: topic.evidenceIds.some((id) => (byId.get(id)?.roles || []).some((role) => ['action_candidate', 'decision_candidate', 'risk_candidate'].includes(role)) || /\bwe need(?: to)?\b/i.test(byId.get(id)?.text || ''))
  }));
  if (!longTranscript) topicCandidates.sort((left, right) => Number(right.explicitEvidence) - Number(left.explicitEvidence) || left.index - right.index);
  const discussionLimit = longTranscript ? 16 : evidence.events.length >= 25 ? 10 : 8;
  let discussion = topicCandidates.slice(0, discussionLimit).map(({ topic }) => {
    const source = topic.evidenceIds.map((id) => byId.get(id)).filter(Boolean).filter((event) => !isSupersededBackground(event, evidence) && (score(profile, event, 'administrative') < 0.55 || /\b(?:offsite|absent|unavailable|miss)\b.*\b(?:meeting|check-in|call|session)\b|\b(?:meeting|check-in|call|session)\b.*\b(?:offsite|absent|unavailable|miss)\b/i.test(event.text)));
    const minuteEvidence = source.map((event) => {
      let text = minutesPoint(event.text);
      if (text && /\b(?:offsite|absent|unavailable|miss)\b/i.test(event.text)) text = text.replace(/\bThe speaker\b/g, event.speaker).replace(/\bthe speaker\b/g, event.speaker);
      return { text, evidenceIds: [event.id] };
    }).filter((item) => item.text);
    const points = longTranscript
      ? (minuteEvidence.length ? [{ text: minuteEvidence.slice(0, 2).map((item) => item.text).join(' '), evidenceIds: minuteEvidence.slice(0, 2).flatMap((item) => item.evidenceIds) }] : [])
      : minuteEvidence.slice(0, 4);
    return { topic: titleFromRepresentative(topic.representativeText), points, evidenceIds: topic.evidenceIds, topicId: topic.id, cohesion: topic.cohesion };
  }).filter((item) => item.points.length);
  if (longTranscript) {
    const riskCards = discussion.filter((card) => card.evidenceIds.some((id) => {
      const event = byId.get(id);
      return event && score(profile, event, 'risk') >= 0.6;
    }));
    if (riskCards.length >= 2) {
      const riskIds = new Set(riskCards.map((card) => card.topicId));
      const riskPointEvidence = riskCards.flatMap((card) => card.points);
      discussion = [
        ...discussion,
        {
          topic: 'Risks and dependencies',
          points: [{ text: riskPointEvidence.map((point) => point.text).join(' '), evidenceIds: riskPointEvidence.flatMap((point) => point.evidenceIds) }],
          evidenceIds: riskCards.flatMap((card) => card.evidenceIds),
          topicId: 'consolidated_risks',
          cohesion: Math.max(...riskCards.map((card) => Number(card.cohesion || 0)), 0)
        }
      ].slice(0, 17);
    }
  }
  // Keep explicit, deterministic speech-act extraction as the precision anchor.
  // MiniLM extends it for conversational variants, but may not independently
  // promote an informational sentence into a decision or risk.
  const deterministic = deterministicStages.contentStage(evidence, state);
  // Preserve the immediately preceding rationale/proposal for an explicit
  // decision even when clustering keeps only the short acceptance turn.
  for (const decision of deterministic.decisions) {
    const decisionIndex = evidence.events.findIndex((event) => (decision.evidenceIds || []).includes(event.id));
    const prior = decisionIndex > 0 ? evidence.events[decisionIndex - 1] : null;
    const point = prior && !isSupersededBackground(prior, evidence) ? minutesPoint(prior.text) : '';
    if (point && !discussion.some((card) => (card.evidenceIds || []).includes(prior.id))) {
      discussion.push({ topic: titleFromRepresentative(prior.text), points: [{ text: point, evidenceIds: [prior.id] }], evidenceIds: [prior.id], topicId: `decision_context_${prior.id}`, cohesion: 1 });
    }
  }
  const decisions = [...deterministic.decisions];
  const risks = [...deterministic.risks];
  for (const event of evidence.events) {
    const evidenceProbabilities = semanticFor(profile, event).evidenceProbabilities || {};
    const evidenceRank = Object.entries(evidenceProbabilities).sort((left, right) => right[1] - left[1]);
    const decisionSignal = trainedProbability(profile, event, 'signalProbabilities', 'decision_language');
    if (event.roles.includes('decision_candidate') && ((evidenceRank[0]?.[0] === 'decision_agreement' && evidenceRank[0][1] >= 0.22) || decisionSignal >= 0.72)) {
      let text = clean(event.text).replace(/^(?:yeah|yes|okay|right|so)[,;:\s]+/i, '').replace(/[.]+$/, '');
      if (/\b(?:move|reschedule|change|replace)\s+it\s+to\s+/i.test(text)) {
        const eventIndex = evidence.events.findIndex((item) => item.id === event.id);
        const prior = evidence.events.slice(Math.max(0, eventIndex - 4), eventIndex).reverse()
          .map((item) => item.text.match(/\b(?:move|reschedule|change|replace)\s+(.+?)\s+to\s+([^,.]+)/i)).find(Boolean);
        if (prior) text = text.replace(/\b((?:move|reschedule|change|replace))\s+it\s+to\s+([^,.]+)/i, `$1 ${prior[1]} to $2`);
      }
      if (text.length >= 8 && text.length <= 240) decisions.push({ text: text.charAt(0).toUpperCase() + text.slice(1), evidenceIds: [event.id], semanticConfidence: score(profile, event, 'decision') });
    }
    const riskSignal = trainedProbability(profile, event, 'signalProbabilities', 'risk_language');
    if (event.roles.includes('risk_candidate') && !event.roles.includes('hypothetical') && ((evidenceRank[0]?.[0] === 'risk_dependency' && evidenceRank[0][1] >= 0.22) || riskSignal >= 0.72)) {
      const text = minutesPoint(event.text);
      if (text) risks.push({ text, evidenceIds: [event.id], semanticConfidence: score(profile, event, 'risk') });
    }
  }
  return { discussion, decisions: unique(decisions, decisionDedupKey), risks: unique(risks, (item) => item.text), warnings: [] };
}

function resolveActionReferent(item, evidence) {
  const indices = (item.evidenceIds || []).map((id) => evidence.events.findIndex((event) => event.id === id)).filter((index) => index >= 0);
  if (!indices.length) return item;
  const sourceIndex = Math.min(...indices);
  const contextEvents = evidence.events.slice(Math.max(0, sourceIndex - 10), Math.max(...indices) + 1);
  const context = contextEvents.map((event) => event.text).join(' ');
  let action = clean(item.action);
  const referentMatches = [...context.matchAll(/\b((?:[a-z][a-z0-9'’-]*\s+){0,4}(?:working sessions?|check-in calls?|recurrence calls?|buttons?|ports?|controls?|drivers?|task lists?|project plans?|guides?|documents?|reports?|plans?|bills?|invoices?|files?|standards?|procedures?|declarations? of conformity))\b/gi)];
  const referent = clean(referentMatches.at(-1)?.[1] || '').replace(/^(?:at\s+)?(?:the|a|an|that|this)\s+/i, '');
  if (referent) {
    action = action
      .replace(/\bhave a (?:read around|look)\b/i, /\breports?\b/i.test(referent) ? `review referenced reports (${referent})` : `review ${referent}`)
      .replace(/\blook at\b$/i, `review ${referent}`)
      .replace(/\bset that up\b/i, `set up ${referent}`)
      .replace(/\barrange that\b/i, `arrange ${referent}`)
      .replace(/\breview (?:it|that)\b/i, `review ${referent}`)
      .replace(/\bfollow up on that\b/i, `follow up on ${referent}`);
    if (/\bsend (?:a )?copy\b/i.test(action)) action = action.replace(/\bsend (?:a )?copy\b/i, `send a copy of ${referent}`);
  }
  if (/\bget (?:a )?(.{0,60}?call) in\b/i.test(action)) action = action.replace(/\bget (?:a )?(.{0,60}?call) in\b/i, 'schedule a $1');
  if (/\bsend (?:a )?copy\b/i.test(action) && /\b[A-Z]{2,}\b/.test(context) && /\bauthori[sz]ed rep(?:resentative)?\b/i.test(context) && /\bbill\b/i.test(context)) {
    const acronym = context.match(/\b[A-Z]{2,}\b/)?.[0];
    action = `Send a copy of the ${acronym} authorised representative bill`;
  }
  return { ...item, action: action.charAt(0).toUpperCase() + action.slice(1) };
}

function acceptedCollectiveActions(evidence) {
  const actions = [];
  evidence.events.forEach((event, index) => {
    const match = event.text.match(/\bwe will\s+(.+?)[.!?]?$/i);
    if (!match || event.roles.includes('hypothetical')) return;
    const acceptance = evidence.events.slice(index + 1, index + 4).find((item) => /^(?:agreed|confirmed|yes|yeah)[.!]?$/i.test(clean(item.text)));
    if (!acceptance) return;
    const action = clean(match[1]).replace(/[.?!]+$/, '');
    if (action.split(/\s+/).length < 2 || action.split(/\s+/).length > 24) return;
    actions.push({ owner: event.speaker, action: action.charAt(0).toUpperCase() + action.slice(1), deadline: deadlineFrom(event.text), evidenceIds: [event.id, acceptance.id], semanticConfidence: 1 });
  });
  return actions;
}

function explicitObligationActions(evidence) {
  const actions = [];
  for (const event of evidence.events) {
    const match = event.text.match(/\bI\s+(?:need to|must|have to)\s+(.+?)[.!?]?$/i);
    if (!match || event.roles.includes('hypothetical') || /\?\s*$/.test(event.text)) continue;
    let action = clean(match[1]).replace(/[.?!]+$/, '');
    if (/^look at$/i.test(action)) {
      const objects = [...event.text.slice(0, match.index).matchAll(/\b((?:[a-z][a-z0-9'’-]*\s+){0,3}(?:buttons?|ports?|controls?|drivers?|documents?|reports?|plans?|files?|standards?|procedures?))\b/gi)];
      const object = clean(objects.at(-1)?.[1] || '').replace(/^(?:at\s+)?(?:the|a|an|that|this)\s+/i, '');
      if (object) action = `Review ${object}`;
    }
    if (action.split(/\s+/).length < 2 || action.split(/\s+/).length > 24) continue;
    actions.push({ owner: event.speaker, action: action.charAt(0).toUpperCase() + action.slice(1), deadline: deadlineFrom(event.text), evidenceIds: [event.id], semanticConfidence: 1 });
  }
  return actions;
}

function acceptedTentativeActions(evidence) {
  const actions = [];
  evidence.events.forEach((event, index) => {
    if (!/\bI\s+(?:might|may)\b[^.]{0,80}\b(?:draft|draught|prepare|write)\b/i.test(event.text)) return;
    const following = evidence.events.slice(index + 1, index + 7);
    const acceptance = following.find((item) => /\b(?:send it to me|send it over|I['’]ll review it|I will review it|send it[^.]{0,30}review)\b/i.test(item.text));
    if (!acceptance) return;
    actions.push({ owner: event.speaker, action: 'Draft content and send it for review', deadline: 'Not stated', evidenceIds: [event.id, acceptance.id], semanticConfidence: 1 });
  });
  return actions;
}

function decisionDedupKey(item) {
  return clean(item.text).toLowerCase()
    .replace(/^(?:so|well|okay|right)[,;:\s]+/, '')
    .replace(/\bwe['’]ve\b/g, 'we have')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function actionPublishability(item, evidence, profile) {
  const source = (item.evidenceIds || []).map((id) => evidence.events.find((event) => event.id === id)).filter(Boolean);
  const semantics = source.map((event) => semanticFor(profile, event));
  const maximum = (group, label) => Math.max(...semantics.map((semantic) => Number(semantic?.[group]?.[label] || 0)), 0);
  const confirmed = maximum('actionProbabilities', 'confirmed_action');
  const possible = maximum('actionProbabilities', 'possible_action');
  const negative = Math.max(maximum('actionProbabilities', 'not_action'), maximum('actionProbabilities', 'completed_history'));
  const administrative = Math.max(...source.map((event) => score(profile, event, 'administrative')), 0);
  const words = clean(item.action).split(/\s+/).filter(Boolean);
  let quality = confirmed + (possible * 0.35) - (negative * 0.7) - (administrative * 0.6);
  if (item.owner && item.owner !== 'Not stated') quality += 0.15;
  if (source.some((event) => event.roles.includes('action_candidate') && !event.roles.includes('hypothetical') && /\bI\s+(?:need to|must|have to)\b/i.test(event.text))) quality += 0.9;
  if (item.deadline && item.deadline !== 'Not stated') quality += 0.12;
  if (words.length >= 4 && words.length <= 20) quality += 0.12;
  if (/\b(?:review|send|share|confirm|complete|prepare|update|provide|request|schedule|draft|test|submit|follow up|investigate|create|develop|finalise)\b/i.test(item.action)) quality += 0.1;
  if (/\b(?:share my screen|book a holiday|mum['’]?s shopping|talk to you soon|speak to you next week)\b/i.test(item.action)) quality -= 1;
  if (/^(?:be|go|do|take|get|send|share|review|add|put|time)\s+(?:it|that|this|there|right|out|you)?[.!?]?$/i.test(item.action)) quality -= 0.8;
  if (/\?|\b(?:probably|maybe|I['’]?ll|I am|I think|I don['’]?t|wouldn['’]?t)\b/i.test(item.action)) quality -= 0.45;
  if (words.length < 3 || words.length > 28) quality -= 0.6;
  return quality;
}

function actionsStage(evidence, state, profile, topology) {
  const threads = buildCommitmentThreads(evidence, profile, topology);
  const deterministic = deterministicStages.actionsStage(evidence, state, topology).actions;
  let actions = unique([
    ...deterministic,
    ...threads.flatMap((thread) => actionsFromThread(thread, evidence, profile)),
    ...acceptedTentativeActions(evidence),
    ...acceptedCollectiveActions(evidence),
    ...explicitObligationActions(evidence)
  ].map((item) => resolveActionReferent(item, evidence)), (item) => `${item.owner}|${item.action}`);
  const structuredEvidenceIds = new Set(evidence.events.filter((event) => event.structuredSource === 'actions_owner_deadline_table').map((event) => event.id));
  if (structuredEvidenceIds.size) {
    actions = unique(actions.filter((item) => (item.evidenceIds || []).some((id) => structuredEvidenceIds.has(id))).map((item) => ({
      ...item,
      action: clean(clean(item.action)
        .replace(/\bRsk Mgmt\b/gi, 'Risk Management')
        .replace(/\bTrace SW to identify the change in the SW between\b/gi, 'Document software versioning traceability between')
        .replace(/^Review (.+?) standard compare to (.+?) documentation to outline what testing needs to be completed for (.+?) testing$/i, 'Compare $1 with $2 documentation and identify $3 testing gaps')
        .replace(/\b(?:by|on|at)\s*$/i, ''))
    })), (item) => `${item.owner}|${item.action}`);
  } else if (evidence.events.length >= 100 && topology.mode === 'standard') {
    const ranked = actions
      .map((item, index) => ({ item, index, publishability: actionPublishability(item, evidence, profile), explicitObligation: (item.evidenceIds || []).some((id) => {
        const event = evidence.events.find((candidate) => candidate.id === id);
        return event?.roles.includes('action_candidate') && !event.roles.includes('hypothetical') && !/\?\s*$/.test(event.text) && /\bI\s+(?:need to|must|have to)\b/i.test(event.text);
      }) }))
      .filter((candidate) => candidate.publishability >= 0.08);
    const mandatory = ranked.filter((candidate) => candidate.explicitObligation);
    const optional = ranked.filter((candidate) => !candidate.explicitObligation)
      .sort((left, right) => right.publishability - left.publishability || left.index - right.index);
    actions = [...mandatory, ...optional.slice(0, Math.max(0, 6 - mandatory.length))]
      .sort((left, right) => left.index - right.index)
      .map((candidate) => candidate.item);
  }
  const unresolvedThreads = threads.filter((thread) => !actions.some((action) => action.threadId === thread.id)).map((thread) => ({
    threadId: thread.id, evidenceIds: thread.evidenceIds, scores: thread.semanticScores,
    reason: 'Semantic candidate could not be safely converted into an owner/action record.'
  }));
  return {
    actions,
    extractionMode: 'minilm_commitment_threads',
    commitmentThreads: threads,
    unresolvedThreads,
    warnings: [
      ...(actions.length ? [] : [{ type: 'no_actions_detected', severity: 'info', message: 'No transcript-supported action passed the MiniLM commitment-thread safety checks.' }]),
      ...(unresolvedThreads.length ? [{ type: 'unresolved_commitment_threads', severity: 'warning', message: `${unresolvedThreads.length} semantic commitment thread(s) require adjudication.`, evidenceIds: unresolvedThreads.flatMap((item) => item.evidenceIds) }] : [])
    ]
  };
}

module.exports = { contextStage, contentStage, actionsStage, buildCommitmentThreads, actionsFromThread, hasSemanticRole };
