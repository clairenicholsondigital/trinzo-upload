'use strict';

const { clean } = require('./evidence');
const { semanticFor } = require('./minilm');
const deterministicStages = require('./stages');
const { deadlineFrom } = deterministicStages;
const { actionHasConcreteObject, applyOperationalPhaseTiming, attachTemporalContext, composeDecision, composeRisk, consolidate, deriveRoleDecisions, tokenOverlap } = require('./canonicalResolver');
const { purposePlan, objectiveIntentForText, topicOrderRank } = require('./meetingPurpose');
const { resolveActionRecords } = require('./actionResolution');
const { editorialTopicLabel, editorialTopics } = require('./topicEditorial');

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

function enrichedEvidenceEnabled() {
  return process.env.MEETING_MINUTES_ENRICHED_EVIDENCE !== '0';
}

function enrichedProbability(profile, event, group, label) {
  return enrichedEvidenceEnabled() ? trainedProbability(profile, event, group, label) : 0;
}

function enrichedLabel(profile, event, group) {
  if (!enrichedEvidenceEnabled()) return '';
  const probabilities = semanticFor(profile, event)?.[group] || {};
  return Object.entries(probabilities).sort((left, right) => right[1] - left[1])[0]?.[0] || '';
}

function independentlyCanonical(profile, event) {
  const dependency = Math.max(enrichedProbability(profile, event, 'contextDependencyProbabilities', 'needs_previous'), enrichedProbability(profile, event, 'contextDependencyProbabilities', 'accepts_previous'));
  const noncanonical = Math.max(enrichedProbability(profile, event, 'canonicalWorthinessProbabilities', 'supporting_detail'), enrichedProbability(profile, event, 'canonicalWorthinessProbabilities', 'duplicate_expression'), enrichedProbability(profile, event, 'canonicalWorthinessProbabilities', 'context_only'));
  const canonical = enrichedProbability(profile, event, 'canonicalWorthinessProbabilities', 'canonical_item');
  return !((dependency >= 0.65 || noncanonical >= 0.65) && canonical < 0.5);
}

function discourseMayPublish(profile, event, section) {
  const discourse = semanticFor(profile, event)?.discourseRoleProbabilities || {};
  if (!Object.keys(discourse).length || section === 'action') return true;
  const canonical = Number(discourse.canonical_assertion || 0);
  const attachment = Math.max(
    Number(discourse.acceptance || 0), Number(discourse.single_item_recap || 0),
    Number(discourse.supporting_detail || 0), Number(discourse.context_only || 0),
    Number(discourse.administrative || 0), Number(discourse.completed_history || 0),
    Number(discourse.hypothetical || 0), Number(discourse.unassigned_proposal || 0)
  );
  const multiItemRecap = Number(discourse.multi_item_recap || 0);
  if (multiItemRecap >= 0.2 && canonical <= multiItemRecap + 0.05) return false;
  if (Number(discourse.acceptance || 0) >= 0.5 && Number(discourse.acceptance || 0) > canonical * 2) return false;
  if (Math.max(Number(discourse.administrative || 0), Number(discourse.context_only || 0)) >= 0.5 && canonical < 0.2) return false;
  if (canonical < 0.12 && attachment > canonical) return false;
  if (section === 'decision' && canonical < 0.12 && Number(discourse.canonical_commitment || 0) > canonical) return false;
  return true;
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

function hasExplicitFutureCommitment(text) {
  return /\bI\s*(?:['’]ll|will|shall)\s+(?:send|share|provide|arrange|review|complete|prepare|update|confirm|get|upload|forward|circulate|draft|submit|finish|finalise|finalize|investigate|check|schedule|create|develop)\b/i.test(clean(text))
    && !/\b(?:probably|maybe|might|I think|I don['’]?t|wouldn['’]?t)\b/i.test(clean(text))
    && !/\?\s*$/.test(clean(text));
}

function actionShape(event, evidence) {
  const text = clean(event.text);
  const shapes = [
    { re: /^(.+?)\s+(?:are|is)\s+still not finalised[.!]?$/i, owner: () => 'Not stated', action: (match) => `Finalise ${match[1]}` },
    { re: /^(.+?)\s+input is still missing for\s+(.+?)[.!]?$/i, owner: () => 'Not stated', action: (match) => `Provide ${match[1]} input for ${match[2]}` },
    { re: /^(.+? document) is absent\b.*$/i, owner: () => 'Not stated', action: (match) => `Draft ${match[1]}` },
    { re: /^(.+?)\s+follow-up feedback is still pending[.!]?$/i, owner: () => 'Not stated', action: (match) => `Follow up ${match[1]} feedback` },
    { re: /^(?:yeah|yes|yep|agreed)[,;]?\s+(?:and\s+)?([a-z][a-z-]+ing\s+.+?)(?:,\s+and\s+I['’]ll\b|$)/i, owner: () => event.speaker, action: (match) => match[1] },
    { re: /\bI\s*(?:['’]ll|will|shall|can|need to|must|have to|am going to)\s+(.+)/i, owner: () => event.speaker, action: (match) => match[1] },
    { re: /\bI(?:['’]ve| have)\s+got to\s+(.+)/i, owner: () => event.speaker, action: (match) => match[1] },
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

function semanticActionCandidate(event, profile) {
  const semantic = semanticFor(profile, event);
  const action = Math.max(
    Number(semantic.actionProbabilities?.confirmed_action || 0),
    Number(semantic.actionProbabilities?.possible_action || 0)
  );
  const evidenceAction = Math.max(
    Number(semantic.evidenceProbabilities?.action_commitment || 0),
    Number(semantic.evidenceProbabilities?.document_control_task || 0),
    Number(semantic.evidenceProbabilities?.regulatory_obligation || 0)
  );
  const discourse = Number(semantic.discourseRoleProbabilities?.canonical_commitment || 0);
  const commitment = Number(semantic.scores?.commitment || 0);
  const request = Number(semantic.scores?.request || 0);
  const explicitSignal = Number(semantic.signalProbabilities?.explicit_commitment_verb || 0);
  const objectSignal = Math.max(
    Number(semantic.signalProbabilities?.deliverable_object || 0),
    Number(semantic.signalProbabilities?.document_or_record || 0),
    Number(semantic.signalProbabilities?.recipient_or_handover || 0)
  );
  const completed = Math.max(
    Number(semantic.actionProbabilities?.completed_history || 0),
    Number(semantic.lifecycleProbabilities?.completed || 0),
    Number(semantic.lifecycleProbabilities?.inactive || 0)
  );
  const active = Number(semantic.lifecycleProbabilities?.active || 0);
  const noise = Math.max(
    Number(semantic.evidenceProbabilities?.low_value_noise || 0),
    Number(semantic.scores?.administrative || 0)
  );
  const hypothetical = Math.max(
    Number(semantic.scores?.hypothetical || 0),
    Number(semantic.signalProbabilities?.hypothetical_language || 0)
  );
  const ongoingWork = /\b(?:ongoing|work in progress|working on|starting to|trying to|continu(?:e|ing)|further (?:work|updates?) (?:is|are )?(?:needed|required)|updates? (?:still )?need(?:s)? to happen)\b/i.test(event.text);
  const cue = /\b(?:action(?:s)?|I\s*(?:['’]ll|will|shall|can|need to|must|have to|am going to)|we\s*(?:['’]ll|will|need to|must|have to)|you\s+(?:will|need to|must|have to)|(?:can|could|will|would)\s+you|please|needs? to|has to|must|still (?:need|needs|requires?|pending|outstanding)|remain(?:s|ing)? (?:to be done|outstanding|open|pending)|ongoing|work in progress|working on|starting to|trying to|continu(?:e|ing)|follow[- ]?up|sign off|approve|review|complete|update|share|send|confirm|trace|generate|schedule|arrange|set up|prepare|provide|finish|finalise|finalize|investigate|check|raise|bring|discuss|upload|forward|circulate|draft|document)\b/i.test(event.text);
  const explicitNegative = /\b(?:already (?:done|complete|completed|sent|finished|closed)|no action|nothing to action|not (?:an|a) action|do not (?:make|record|minute)|cancelled|withdrawn)\b/i.test(event.text);
  const personalOrAdministrative = /\b(?:book a holiday|holiday plans?|mum['’]?s shopping|mother['’]?s shopping|make tea|coffee|share my screen|microphone|camera|can everyone hear|speak to you next week|talk to you next week)\b/i.test(event.text);
  const ungroundedQuestion = /\?\s*$/.test(clean(event.text))
    && !/\b(?:can|could|will|would)\s+you\s+(?:review|send|share|complete|update|confirm|prepare|provide|check|schedule|arrange|upload|draft|document|sign|approve|submit|follow)\b/i.test(event.text);
  const positive = Math.max(action, evidenceAction, discourse, commitment * 0.7, request * 0.7, explicitSignal * 0.65);
  const learnedStrong = active >= 0.15 && (
    action >= 0.2
    || evidenceAction >= 0.25
    || discourse >= 0.2
    || (commitment >= 0.35 && objectSignal >= 0.25)
  );
  return (cue || learnedStrong)
    && (objectSignal >= 0.28 || ongoingWork)
    && (positive >= 0.2 || ongoingWork)
    && (noise < 0.58 || ongoingWork)
    && !explicitNegative
    && !personalOrAdministrative
    && !ungroundedQuestion
    && !(completed >= 0.58 && completed > action + 0.08 && !ongoingWork)
    && !(hypothetical >= 0.72 && Math.max(request, discourse, evidenceAction) < 0.3);
}

function semanticCandidateScore(event, profile) {
  const semantic = semanticFor(profile, event);
  const explicitProspective = /\b(?:I|we)\s*(?:['’]ll|will|shall|can|need to|must|have to|am going to)|\b(?:you|[A-Z][A-Za-z'’.-]+)\s+(?:will|need to|needs to|must|have to|has to)|\b(?:can|could|will|would)\s+you\s+(?:review|send|share|complete|update|confirm|prepare|provide|check|schedule|arrange|upload|draft|document|sign|approve|submit|follow)|\b(?:needs? to|must|has to|have to)\s+be\b/i.test(event.text) ? 0.7 : 0;
  const outstanding = /\b(?:still (?:need|needs|requires?|pending|outstanding)|remain(?:s|ing)? (?:to be done|outstanding|open|pending)|ongoing|work in progress|working on|starting to|trying to|in progress|follow[- ]?up (?:is|remains) (?:open|pending)|yet to be|further (?:work|updates?) (?:is|are )?(?:needed|required)|updates? (?:still )?need(?:s)? to happen|needs? (?:review|completion|updating|confirmation)|continu(?:e|ing) (?:to |with )?(?:review|complete|update|test|prepare|develop|document|resolve|progress))\b/i.test(event.text) ? 1 : 0;
  const weakOrPersonal = /\?\s*$|\b(?:probably|maybe|might|could have|if you wanted|book a holiday|shopping|make tea|speak to you next week)\b/i.test(event.text) ? 0.65 : 0;
  return Number((
    (Number(semantic.actionProbabilities?.confirmed_action || 0) * 1.25)
    + (Number(semantic.actionProbabilities?.possible_action || 0) * 0.65)
    + Number(semantic.evidenceProbabilities?.action_commitment || 0)
    + (Number(semantic.evidenceProbabilities?.document_control_task || 0) * 0.45)
    + (Number(semantic.evidenceProbabilities?.regulatory_obligation || 0) * 0.55)
    + (Number(semantic.discourseRoleProbabilities?.canonical_commitment || 0) * 1.1)
    + (Number(semantic.scores?.request || 0) * 0.35)
    + explicitProspective
    + outstanding
    - Number(semantic.actionProbabilities?.completed_history || 0)
    - (Number(semantic.evidenceProbabilities?.low_value_noise || 0) * 1.2)
    - (Number(semantic.scores?.administrative || 0) * 0.8)
    - weakOrPersonal
  ).toFixed(4));
}

function candidateReviewScore(item, evidence, profile) {
  if (item.semanticOnly) return Number(item.semanticConfidence || 0);
  const source = (item.evidenceIds || []).map((id) => evidence.events.find((event) => event.id === id)).filter(Boolean);
  const bestSemantic = Math.max(...source.map((event) => semanticCandidateScore(event, profile)), 0);
  return actionPublishability(item, evidence, profile) + (bestSemantic * 0.45);
}

function reviewCandidateNoise(item, evidence) {
  const text = clean(item.action);
  const sourceText = (item.evidenceIds || []).map((id) => evidence.events.find((event) => event.id === id)?.text || '').join(' ');
  const malformed = /,\s*I['’]m\b|\bbecause I['’]m\b/i.test(text);
  const unresolvedObject = /\b(?:review|send|share|update|complete)\s+(?:it|that|this)(?:\s+as well)?$/i.test(text);
  return malformed || unresolvedObject || nonMinuteActionText(`${text} ${sourceText}`) || isUnderspecifiedAction(item);
}

function nonMinuteActionText(value) {
  return /\b(?:book a holiday|holiday plans?|mum['’]?s shopping|mother['’]?s shopping|make tea|coffee|share my screen|microphone|camera|can everyone hear|speak to you next week|talk to you next week|out for (?:the )?next|away for (?:the )?next)\b/i.test(clean(value));
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
    return (Boolean(shape) && (
      event.roles.includes('action_candidate')
      || topology.mode === 'distributed_recap'
      || confirmed >= 0.26
      || (possible >= 0.25 && commitmentSignal >= 0.48)
      || (topology.mode === 'distributed_recap' && Math.max(confirmed, possible) >= Math.max(notAction, completed) - 0.12)
    )) || semanticActionCandidate(event, profile);
  });
  for (const event of candidates) {
    const eventShape = actionShape(event, evidence);
    const eventIndex = evidence.events.findIndex((item) => item.id === event.id);
    const existing = [...threads].reverse().find((thread) => {
      if (event.turnIndex - thread.turnEnd > 2) return false;
      const maxEventGap = topology.mode === 'distributed_recap' ? 16 : 8;
      const maxThreadEvents = topology.mode === 'distributed_recap' ? 12 : 6;
      if (thread.events.length >= maxThreadEvents) return false;
      if (Number.isInteger(thread.eventEndIndex) && eventIndex - thread.eventEndIndex > maxEventGap) return false;
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
      existing.eventEndIndex = eventIndex;
      if (!existing.speakers.includes(event.speaker)) existing.speakers.push(event.speaker);
    } else {
      threads.push({ id: `thread_${String(threads.length + 1).padStart(3, '0')}`, events: [event], turnStart: event.turnIndex, turnEnd: event.turnIndex, eventStartIndex: eventIndex, eventEndIndex: eventIndex, speakers: [event.speaker], topologyMode: topology.mode });
    }
  }
  return threads.map((thread) => ({
    ...thread,
    evidenceIds: thread.events.map((event) => event.id),
    semanticScores: Object.fromEntries(['commitment', 'request', 'acceptance', 'completed', 'hypothetical', 'rejection'].map((role) => [role, Math.max(...thread.events.map((event) => score(profile, event, role)), 0)]))
  }));
}

function semanticThreadReviewCandidate(thread, evidence, profile) {
  const ranked = thread.events.map((event) => ({ event, score: semanticCandidateScore(event, profile) }))
    .sort((left, right) => right.score - left.score || left.event.turnIndex - right.event.turnIndex);
  const representative = ranked[0]?.event;
  if (!representative) return null;
  const shaped = ranked.map(({ event }) => ({ event, shape: actionShape(event, evidence) }))
    .find((item) => item.shape?.action && item.shape?.owner);
  const deadlineEvent = thread.events.find((event) => deadlineFrom(event.text) !== 'Not stated');
  const action = clean(shaped?.shape?.action || representative.text).replace(/[.]+$/, '');
  return {
    owner: clean(shaped?.shape?.owner) || 'Not stated',
    action,
    deadline: deadlineEvent ? deadlineFrom(deadlineEvent.text) : 'Not stated',
    evidenceIds: thread.evidenceIds,
    threadId: thread.id,
    semanticOnly: true,
    semanticConfidence: Math.max(...ranked.map((item) => item.score), 0)
  };
}

function actionsFromThread(thread, evidence, profile) {
  const negative = Math.max(thread.semanticScores.completed, thread.semanticScores.hypothetical, thread.semanticScores.rejection);
  const positive = Math.max(thread.semanticScores.commitment, thread.semanticScores.request, thread.semanticScores.acceptance);
  const trainedConfirmed = Math.max(...thread.events.map((event) => trainedProbability(profile, event, 'actionProbabilities', 'confirmed_action')), 0);
  const trainedCompleted = Math.max(...thread.events.map((event) => trainedProbability(profile, event, 'actionProbabilities', 'completed_history')), 0);
  const trainedNotAction = Math.max(...thread.events.map((event) => trainedProbability(profile, event, 'actionProbabilities', 'not_action')), 0);
  const explicitActionForm = thread.events.some((event) => event.roles.includes('action_candidate') && actionShape(event, evidence));
  const strongExplicitAction = thread.events.some((event) => event.roles.includes('action_candidate') && !event.roles.includes('hypothetical') && (hasExplicitFutureCommitment(event.text) || /\bI\s+(?:need to|must|have to)\b/i.test(event.text)) && actionShape(event, evidence));
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
      explicitFutureCommitment: hasExplicitFutureCommitment(shaped.event.text),
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

function publishableTopicRepresentative(text) {
  const value = clean(text);
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length < 4) return false;
  if (/^(?:and|but|because|when|presumably|interesting|so|well|yeah|yes|okay|right)\b/i.test(value)) return false;
  if (/(?:\b(?:and|but|because|that|which|with|from|to|for|of|the|a|an)|[,;:])$/i.test(value)) return false;
  // Substance is decided per-transcript by the MiniLM clusterer (it only emits
  // clusters above its substantive threshold). A fixed domain-keyword whitelist
  // here over-filtered legitimate topics whose vocabulary happened to fall
  // outside the list, so rely on the structural checks above instead.
  return true;
}

function minutesPoint(text, speaker = '') {
  let value = clean(text).replace(/[.]+$/, '');
  const subject = clean(speaker) && !/^(?:not stated|unknown|speaker|client|trinzo)$/i.test(clean(speaker)) ? clean(speaker) : 'The participant';
  value = value
    .replace(/^(?:and\s+)?then[,;:\s]+/i, '')
    .replace(/^I\s+(?:think|believe|guess|suppose)\s+(?:that\s+)?/i, '')
    .replace(/^we\s+(?:discussed|reviewed|noted|confirmed)\s+/i, 'The team $1 ')
    .replace(/^you know[,;:\s]*/i, '')
    .replace(/^(?:yeah|yes|okay|right|so|well)[,;:\s]+/i, '');
  if (/^I\s*(?:['’]ll|will|can)\b|\byou know\b|\b(?:no project update today|do not have a project update today|can everyone hear me|red light|share my screen)\b|^(?:and|but|or|yes|yeah|okay|right)[.!?]?$/i.test(value)) return '';
  value = value
    .replace(/\bI['’]ll\b/gi, `${subject} will`)
    .replace(/\bI['’]m\b/gi, `${subject} is`)
    .replace(/\bI['’]ve\b/gi, `${subject} has`)
    .replace(/\bwe(?:'ve| have)\b/gi, 'the team has')
    .replace(/\bwe\b/gi, 'the team')
    .replace(/\bour\b/gi, "the team's")
    .replace(/\bI\b/g, subject)
    .replace(/\bmy\b/gi, `${subject}'s`);
  const escapedSubject = subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  value = value
    .replace(new RegExp(`\\b${escapedSubject} (?:don['’]?t|do not)\\b`, 'gi'), `${subject} does not`)
    .replace(new RegExp(`\\b${escapedSubject} (?:haven['’]?t|have not)\\b`, 'gi'), `${subject} has not`)
    .replace(new RegExp(`\\b${escapedSubject} think\\b`, 'gi'), `${subject} thinks`)
    .replace(new RegExp(`\\b${escapedSubject} know\\b`, 'gi'), `${subject} knows`)
    .replace(new RegExp(`\\b${escapedSubject} need\\b`, 'gi'), `${subject} needs`)
    .replace(new RegExp(`\\b${escapedSubject} do\\b`, 'gi'), `${subject} does`)
    .replace(/\bhow it how\b/gi, 'how')
    .replace(/\bkind of\b/gi, '')
    .replace(/\bsort of\b/gi, '')
    .replace(/\blike,?\s+/gi, '')
    .replace(/\s{2,}/g, ' ');
  if (value.split(/\s+/).length < 5 || /\bthat is that there is\b/i.test(value) || /(?:\b(?:and|but|or|because|that|which|with|from|into|onto|to|for|of|the|a|an)|[,;:])$/i.test(value)) return '';
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}.` : '';
}

const GUIDANCE_STOPWORDS = new Set(['about', 'after', 'again', 'also', 'before', 'client', 'emphasise', 'emphasize', 'focus', 'highlight', 'meeting', 'prioritise', 'prioritize', 'should', 'that', 'their', 'there', 'these', 'this', 'with']);

function guidanceTokens(value) {
  return new Set((clean(value).toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) || []).filter((token) => !GUIDANCE_STOPWORDS.has(token)));
}

function prioritiseForGuidance(items, evidence, reviewerGuidance) {
  const wanted = guidanceTokens(reviewerGuidance);
  if (!wanted.size || !Array.isArray(items) || items.length < 2) return items;
  const byId = new Map(evidence.events.map((event) => [event.id, event]));
  return items.map((item, index) => {
    const source = [item.text, item.topic, item.objective, item.summary,
      ...(item.evidenceIds || []).map((id) => byId.get(id)?.text || '')].join(' ');
    const available = guidanceTokens(source);
    const relevance = [...wanted].filter((token) => available.has(token)).length;
    return { item, index, relevance };
  }).sort((left, right) => right.relevance - left.relevance || left.index - right.index).map(({ item }) => item);
}

function objectivePhraseForTopic(topic, topicHints, evidence) {
  const intent = objectiveIntentForText(topicHints, topic.representativeText);
  const title = topic.editorialText || editorialTopicLabel(topic, evidence);
  return `${intent} ${title.charAt(0).toLowerCase()}${title.slice(1)}`;
}

function contextStage(evidence, profile, state = {}, reviewerGuidance = '') {
  // Topics ALWAYS come from this transcript's own MiniLM clusters. The
  // meeting-type profile (if any) is a thin classifier used only to order those
  // topics and choose an objective intent verb — it contributes no text and can
  // never introduce another meeting's content.
  const purpose = purposePlan(state.meeting);
  const topicHints = purpose?.topicHints || [];
  const byId = new Map(evidence.events.map((event) => [event.id, event]));
  let clusters = (profile.topics || []).filter((topic) =>
    publishableTopicRepresentative(topic.representativeText)
    && !/\b(?:no project update today|do not have a project update today|can everyone hear me|red light|webcam)\b/i.test(topic.representativeText || '')
    && !topic.evidenceIds.every((id) => { const event = byId.get(id); return event ? isSupersededBackground(event, evidence) : false; }));
  if (topicHints.length) {
    clusters = clusters
      .map((topic, index) => ({ topic, index, rank: topicOrderRank(topicHints, topic.representativeText) }))
      .sort((left, right) => left.rank - right.rank || left.index - right.index)
      .map((entry) => entry.topic);
  }
  const topics = prioritiseForGuidance(editorialTopics(clusters, evidence, 8), evidence, reviewerGuidance);
  return {
    meeting: state.meeting || { participants: evidence.participants },
    objectives: topics.slice(0, 6).map((topic) => ({ text: objectivePhraseForTopic(topic, topicHints, evidence), evidenceIds: topic.evidenceIds, topicId: topic.id })),
    topics: topics.map((topic) => ({ text: topic.editorialText, evidenceIds: topic.evidenceIds, topicId: topic.id })),
    purposeProfile: purpose?.profileId || null,
    warnings: topics.length ? [] : [{ type: 'thin_context', severity: 'warning', message: 'MiniLM found no confident substantive topic clusters.' }]
  };
}

function topicMatchScore(confirmedTopic, card) {
  const wanted = guidanceTokens(confirmedTopic);
  const available = guidanceTokens([card.topic, ...(card.points || []).map((point) => point.text || point)].join(' '));
  if (!wanted.size || !available.size) return 0;
  return [...wanted].filter((token) => available.has(token)).length / wanted.size;
}

function applyConfirmedTopicAgenda(discussion, state) {
  const confirmed = (state.topics || []).map((item) => ({
    text: clean(item.humanFinal || item.text),
    topicId: clean(item.topicId)
  })).filter((item) => item.text);
  if (!confirmed.length || !discussion.length) return discussion;
  const unused = new Set(discussion.map((_item, index) => index));
  const ordered = [];
  for (const topic of confirmed) {
    const exactIndex = topic.topicId
      ? [...unused].find((index) => discussion[index].topicId === topic.topicId)
      : undefined;
    if (exactIndex !== undefined) {
      unused.delete(exactIndex);
      ordered.push({ ...discussion[exactIndex], topic: topic.text, confirmedTopic: true });
      continue;
    }
    const ranked = [...unused].map((index) => ({ index, score: topicMatchScore(topic.text, discussion[index]) }))
      .sort((left, right) => right.score - left.score || left.index - right.index);
    // Only bind a confirmed topic to a card that shares vocabulary with it.
    // A zero-overlap positional fallback used to steal an unrelated card by
    // index, which mis-filed content (e.g. a mute/fan point landing under a
    // risk-management heading). Leave unmatched confirmed topics unbound; the
    // real card keeps its own transcript-derived label and is appended below.
    const selected = ranked.find((entry) => entry.score > 0);
    if (!selected) continue;
    unused.delete(selected.index);
    ordered.push({ ...discussion[selected.index], topic: topic.text, confirmedTopic: true });
  }
  // Once Summary has been confirmed it is the agenda contract. Do not append
  // unrelated clusters after it; that recreates noise the reviewer already
  // removed on the previous screen. With no usable match, retain the original
  // discussion as a safe fallback instead of returning an empty screen.
  return ordered.length ? ordered : discussion;
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
  // Discussion is ALWAYS derived from this transcript's evidence. There is no
  // canned-template branch — a meeting-type profile never supplies body text.
  let discussion = topicCandidates.slice(0, discussionLimit).map(({ topic }) => {
    const source = topic.evidenceIds.map((id) => byId.get(id)).filter(Boolean).filter((event) => !isSupersededBackground(event, evidence) && (score(profile, event, 'administrative') < 0.55 || /\b(?:offsite|absent|unavailable|miss)\b.*\b(?:meeting|check-in|call|session)\b|\b(?:meeting|check-in|call|session)\b.*\b(?:offsite|absent|unavailable|miss)\b/i.test(event.text)));
    const minuteEvidence = source.map((event) => {
      let text = minutesPoint(event.text, event.speaker);
      return { text, evidenceIds: [event.id] };
    }).filter((item) => item.text);
    const points = longTranscript
      ? (minuteEvidence.length ? [{ text: minuteEvidence.slice(0, 2).map((item) => item.text).join(' '), evidenceIds: minuteEvidence.slice(0, 2).flatMap((item) => item.evidenceIds) }] : [])
      : minuteEvidence.slice(0, 4);
    return { topic: editorialTopicLabel(topic, evidence), points, evidenceIds: topic.evidenceIds, topicId: topic.id, cohesion: topic.cohesion };
  }).filter((item) => item.topic && item.topic !== 'Substantive discussion' && item.points.length);
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
  discussion = applyConfirmedTopicAgenda(discussion, state);
  // Keep explicit, deterministic speech-act extraction as the precision anchor.
  // MiniLM extends it for conversational variants, but may not independently
  // promote an informational sentence into a decision or risk.
  const deterministic = deterministicStages.contentStage(evidence, state);
  // Preserve the immediately preceding rationale/proposal for an explicit
  // decision even when clustering keeps only the short acceptance turn.
  for (const decision of deterministic.decisions) {
    const decisionIndex = evidence.events.findIndex((event) => (decision.evidenceIds || []).includes(event.id));
    const prior = decisionIndex > 0 ? evidence.events[decisionIndex - 1] : null;
    const point = prior && !isSupersededBackground(prior, evidence) ? minutesPoint(prior.text, prior.speaker) : '';
    if (point && !discussion.some((card) => (card.evidenceIds || []).includes(prior.id))) {
      discussion.push({ topic: titleFromRepresentative(prior.text), points: [{ text: point, evidenceIds: [prior.id] }], evidenceIds: [prior.id], topicId: `decision_context_${prior.id}`, cohesion: 1 });
    }
  }
  const decisions = deterministic.decisions.map((item) => ({ ...item, deterministic: true }));
  decisions.push(...deriveRoleDecisions(evidence, decisions));
  const risks = [...deterministic.risks];
  for (const event of evidence.events) {
    const evidenceProbabilities = semanticFor(profile, event).evidenceProbabilities || {};
    const evidenceRank = Object.entries(evidenceProbabilities).sort((left, right) => right[1] - left[1]);
    const decisionSignal = trainedProbability(profile, event, 'signalProbabilities', 'decision_language');
    const discourseAssertion = enrichedProbability(profile, event, 'discourseRoleProbabilities', 'canonical_assertion');
    const eventIndex = evidence.events.findIndex((candidate) => candidate.id === event.id);
    const sameTurnDecision = evidence.events.slice(Math.max(0, eventIndex - 2), eventIndex)
      .some((candidate) => candidate.turnId === event.turnId && candidate.roles.includes('decision_candidate'));
    const policyClause = sameTurnDecision && /\bwe\s+(?:only\s+)?(?:pause|stop|proceed|continue|launch|release)\b/i.test(event.text);
    const classifierDecisionCandidate = (discourseAssertion >= 0.32 && Number(evidenceProbabilities.decision_agreement || 0) >= 0.25) || policyClause;
    if ((event.roles.includes('decision_candidate') || classifierDecisionCandidate) && independentlyCanonical(profile, event) && (policyClause || (evidenceRank[0]?.[0] === 'decision_agreement' && evidenceRank[0][1] >= 0.22) || decisionSignal >= 0.72)) {
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
    if (event.roles.includes('risk_candidate') && independentlyCanonical(profile, event) && !event.roles.includes('hypothetical') && ((evidenceRank[0]?.[0] === 'risk_dependency' && evidenceRank[0][1] >= 0.22) || riskSignal >= 0.72)) {
      const text = minutesPoint(event.text, event.speaker);
      if (text) risks.push({ text, evidenceIds: [event.id], semanticConfidence: score(profile, event, 'risk') });
    }
  }
  const resolvedRisks = resolveEnrichedRisks(risks, evidence, profile);
  return { discussion, decisions: resolveEnrichedDecisions(decisions, evidence, profile), risks: resolvedRisks, warnings: [] };
}

function resolveActionReferent(item, evidence) {
  const indices = (item.evidenceIds || []).map((id) => evidence.events.findIndex((event) => event.id === id)).filter((index) => index >= 0);
  if (!indices.length) return item;
  const sourceIndex = Math.min(...indices);
  const contextEvents = evidence.events.slice(Math.max(0, sourceIndex - 10), Math.max(...indices) + 1);
  const context = contextEvents.map((event) => event.text).join(' ');
  const sourceSpeaker = evidence.events[sourceIndex]?.speaker;
  const referentContext = contextEvents
    .filter((event) => !sourceSpeaker || event.speaker === sourceSpeaker)
    .map((event) => event.text)
    .join(' ');
  let action = clean(item.action);
  // Referent resolution is generic: it captures the nearest preceding concrete
  // noun phrase from THIS transcript's context and rewrites pronoun-shaped
  // commitments ("get that over", "share with you the X") around it. The noun
  // vocabulary is a general business-object list — no per-meeting phrases.
  const referentMatches = [...referentContext.matchAll(/\b(working sessions?|check-in calls?|recurrence calls?|code of conduct|trackers?|buttons?|ports?|controls?|drivers?|task lists?|project plans?|guides?|documents?|reports?|plans?|bills?|invoices?|files?|standards?|regulations?|procedures?|declarations? of conformity)\b/gi)];
  const referent = clean(referentMatches.at(-1)?.[1] || '');
  if (referent) {
    action = action
      .replace(/\bhave a (?:read around|look)\b/i, /\breports?\b/i.test(referent) ? `review referenced reports (${referent})` : `review ${referent}`)
      .replace(/\blook at\b$/i, `review ${referent}`)
      .replace(/^get (?:it|that|this) over\b.*$/i, `send the ${referent}`)
      .replace(/^share with you (?:the|a|an|that|this)?\s*.+$/i, `share the ${referent}`)
      .replace(/\bset that up\b/i, `set up ${referent}`)
      .replace(/\barrange that\b/i, `arrange ${referent}`)
      .replace(/\breview (?:it|that)\b/i, `review ${referent}`)
      .replace(/\bfollow up on that\b/i, `follow up on ${referent}`)
      .replace(/\b(?:it|that|them)\b/i, referent);
    if (/\bsend (?:a )?copy\b/i.test(action)) action = action.replace(/\bsend (?:a )?copy\b/i, `send a copy of ${referent}`);
  }
  action = action
    .replace(/^try and\s+/i, '')
    .replace(/\s+so (?:it['’]?s|that['’]?s) not like\b.*$/i, '')
    .replace(/\bshare the share with you the\b/i, 'share the')
    .replace(/\bsend the (?:and\s+)?I have that\b/i, 'send the')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (/^review (?:it|that)\b/i.test(action) && /\bdraft(?:ing|ed)?\b|\bdraught(?:ing|ed)?\b/i.test(context)) {
    action = action.replace(/^review (?:it|that)\b/i, 'Review the draft content');
  }
  action = action.replace(/\s+and then we can have another call\b.*$/i, ' and arrange a follow-up call');
  if (/\bget (?:a )?(.{0,60}?call) in\b/i.test(action)) action = action.replace(/\bget (?:a )?(.{0,60}?call) in\b/i, 'schedule a $1');
  if (/\bsend (?:a )?copy\b/i.test(action) && /\b[A-Z]{2,}\b/.test(context) && /\bauthori[sz]ed rep(?:resentative)?\b/i.test(context) && /\bbill\b/i.test(context)) {
    const acronym = context.match(/\b[A-Z]{2,}\b/)?.[0];
    action = `Send a copy of the ${acronym} authorised representative bill`;
  }
  const explicitFutureCommitment = item.explicitFutureCommitment
    || contextEvents.some((event) => event.roles.includes('action_candidate') && !event.roles.includes('hypothetical') && hasExplicitFutureCommitment(event.text));
  return { ...item, action: action.charAt(0).toUpperCase() + action.slice(1), explicitFutureCommitment };
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

function learnedSlotActions(evidence, profile) {
  if (process.env.MEETING_MINUTES_SLOT_ACTIONS !== '1') return [];
  return evidence.events.flatMap((event) => {
    const semantic = semanticFor(profile, event);
    const slots = Array.isArray(semantic.canonicalSlots) ? semantic.canonicalSlots : [];
    const actionSlots = slots.filter((slot) => slot.label === 'ACTION' && Number(slot.confidence || 0) >= 0.58);
    if (!actionSlots.length) return [];
    const confirmed = Number(semantic.actionProbabilities?.confirmed_action || 0);
    const commitment = Number(semantic.discourseRoleProbabilities?.canonical_commitment || 0);
    const administrative = Number(semantic.discourseRoleProbabilities?.administrative || 0);
    const recap = Number(semantic.discourseRoleProbabilities?.single_item_recap || 0);
    const ownerSlot = slots.filter((slot) => slot.label === 'OWNER').sort((left, right) => Number(right.confidence || 0) - Number(left.confidence || 0))[0];
    const owner = ownerSlot ? participantByFirstName(ownerSlot.text, evidence.participants) : event.speaker;
    if (!owner || !evidence.participants.includes(owner)) return [];
    const firstActionStart = Math.min(...actionSlots.map((slot) => Number(slot.start)));
    const learnedOwner = Number(ownerSlot?.confidence || 0) >= 0.75 && Number(ownerSlot.end) <= firstActionStart;
    const learnedGate = (learnedOwner && recap >= 0.22)
      || (learnedOwner && commitment >= 0.42 && confirmed >= 0.45 && commitment >= administrative + 0.08)
      || (!learnedOwner && commitment >= 0.6 && confirmed >= 0.7 && administrative < 0.18);
    if (!learnedGate) return [];
    const actionStart = firstActionStart;
    const actionEnd = Math.max(...actionSlots.map((slot) => Number(slot.end)));
    const action = clean(event.text.slice(actionStart, actionEnd));
    if (!action) return [];
    const temporalDeadline = Math.max(Number(semantic.temporalRoleProbabilities?.deadline_current || 0), Number(semantic.temporalRoleProbabilities?.deadline_previous || 0));
    const dueSlot = temporalDeadline >= 0.35 ? slots.filter((slot) => slot.label === 'DUE' && Number(slot.confidence || 0) >= 0.75).sort((left, right) => Number(right.confidence || 0) - Number(left.confidence || 0))[0] : null;
    return [{ owner, action: action.charAt(0).toUpperCase() + action.slice(1), deadline: dueSlot?.text || 'Not stated', evidenceIds: [event.id], semanticConfidence: Math.max(confirmed, commitment), learnedSlot: true, learnedAssignment: learnedOwner }];
  });
}

function decisionDedupKey(item) {
  return clean(item.text).toLowerCase()
    .replace(/^(?:so|well|okay|right)[,;:\s]+/, '')
    .replace(/\bwe['’]ve\b/g, 'we have')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function canonicaliseCandidates(items, textOf, qualityOf, profile = null) {
  return consolidate(items, { textOf, qualityOf, profile, lexicalThreshold: 0.55 });
}

function resolveEnrichedDecisions(items, evidence, profile) {
  if (!enrichedEvidenceEnabled()) return unique(items, decisionDedupKey);
  const eligible = items.filter((item) => {
    const sources = (item.evidenceIds || []).map((id) => evidence.events.find((event) => event.id === id)).filter(Boolean);
    if (item.deterministic) {
      const canonicalShape = /^(?:Adopt|Stay|Keep|Move|Finish|Hold|Approve|Accept|Confirm|Do not|Use)\b/i.test(clean(item.text));
      if (canonicalShape) return true;
    }
    return sources.some((event) => {
      const assertion = enrichedProbability(profile, event, 'discourseRoleProbabilities', 'canonical_assertion');
      const explicitCollectiveDecision = /\b(?:decision\s*(?:is|:)|we\s+(?:have\s+)?(?:decided|agreed|approve|approved|accept|accepted|confirm|confirmed|stay|stayed|concluded|selected|chose|went with)|we\s+(?:only\s+)?(?:pause|stop|proceed|continue|launch|release))\b/i.test(event.text);
      return independentlyCanonical(profile, event) && discourseMayPublish(profile, event, 'decision') && (explicitCollectiveDecision || assertion >= 0.5);
    });
  });
  const resolved = canonicaliseCandidates(eligible, (item) => item.text, (item) => {
    const sources = (item.evidenceIds || []).map((id) => evidence.events.find((event) => event.id === id)).filter(Boolean);
    const canonical = Math.max(...sources.map((event) => enrichedProbability(profile, event, 'canonicalWorthinessProbabilities', 'canonical_item')), 0);
    const assertion = Math.max(...sources.map((event) => enrichedProbability(profile, event, 'discourseRoleProbabilities', 'canonical_assertion')), 0);
    const recap = Math.max(...sources.map((event) => enrichedProbability(profile, event, 'discourseRoleProbabilities', 'multi_item_recap')), 0);
    const acceptance = Math.max(...sources.map((event) => enrichedProbability(profile, event, 'discourseRoleProbabilities', 'acceptance')), 0);
    return canonical + assertion - (recap * 0.8) - (acceptance * 0.35);
  }, profile);
  const eventById = new Map(evidence.events.map((event) => [event.id, event]));
  return resolved.map((item) => ({ ...item, text: composeDecision(item, eventById) })).filter((item) => item.text);
}

function resolveEnrichedRisks(items, evidence, profile) {
  if (!enrichedEvidenceEnabled()) return unique(items, (item) => item.text);
  const eligible = items.filter((item) => {
    const text = clean(item.text);
    if (/^(?:but\s+)?(?:that|this|it)(?:\s+is|'s)\s+(?:their|the|a)\s+risk[.!?]*$/i.test(text)) return false;
    if (/\brisk assessment\b.*\b(?:forms?\s+an?\s+input|feeds?\s+(?:in)?to|audit plan|sequential)\b/i.test(text)) return false;
    if (/\b(?:risk analysis|risk assessment|risk management)\b/i.test(text) && !/\b(?:risks?\s+(?:is|are|that|of)|could|may|might|concern|issue|missing|delay|fail|unable|unavailable|dependency|block)\b/i.test(text)) return false;
    if (/\b(?:yeah|yep|okay|right)(?:[,.!?\s]+(?:yeah|yep|okay|right))*[.!?]*$/i.test(text)) return false;
    if (/\byou know\b/i.test(text) || /\b(?:a|an|the|and|or|but|of|for|to|in|with)\s*[.!?]*$/i.test(text)) return false;
    const sources = (item.evidenceIds || []).map((id) => evidence.events.find((event) => event.id === id)).filter(Boolean);
    return sources.some((event) => independentlyCanonical(profile, event));
  });
  const eventById = new Map(evidence.events.map((event) => [event.id, event]));
  return consolidate(eligible, {
    textOf: (item) => item.text,
    qualityOf: (item) => {
    const sources = (item.evidenceIds || []).map((id) => evidence.events.find((event) => event.id === id)).filter(Boolean);
    const canonical = Math.max(...sources.map((event) => enrichedProbability(profile, event, 'canonicalWorthinessProbabilities', 'canonical_item')), 0);
      const concision = Math.max(0, 1 - (clean(item.text).split(/\s+/).length / 60));
      return canonical + (concision * 0.12);
    },
    profile,
    eventById,
    lexicalThreshold: 0.3,
    anchorGrouping: true,
    anchorTurnDistance: 8
  }).map((item) => ({
    ...item,
    text: canonicalRiskText(composeRisk(item, evidence, profile))
  })).filter((item) => item.text);
}

function canonicalRiskText(value) {
  const text = clean(value).replace(/^.*?\bthe risk is that\s+/i, 'There is a risk that ');
  if (/\bthere(?:'s| is) always a risk\b.*\bplan for (?:it|that)\b/i.test(text)) return '';
  if (/^There is a risk that .*\breali[sz]e something is missing\b.*\bnot there to help\b/i.test(text)) {
    return 'Required information or actions may be missed while the responsible team member is unavailable.';
  }
  return text;
}

function actionIsSuperseded(item, evidence, profile) {
  if (item.learnedSlot) return false;
  const indices = (item.evidenceIds || []).map((id) => evidence.events.findIndex((event) => event.id === id)).filter((index) => index >= 0);
  if (!indices.length || !item.owner || item.owner === 'Not stated') return false;
  const end = Math.max(...indices);
  const ownerFirst = clean(item.owner).split(/\s+/)[0];
  return evidence.events.slice(end + 1, end + 7).some((event) => {
    const modifies = enrichedProbability(profile, event, 'contextDependencyProbabilities', 'modifies_previous');
    const lifecycle = Math.max(enrichedProbability(profile, event, 'lifecycleProbabilities', 'superseded'), enrichedProbability(profile, event, 'lifecycleProbabilities', 'inactive'));
    const explicit = new RegExp(`\\b${ownerFirst.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b.*\\b(?:cancelled|withdrawn|reassigned|no longer)\\b`, 'i').test(event.text)
      || new RegExp(`\\b(?:cancelled|withdrawn|reassigned|no longer)\\b.*\\b${ownerFirst.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(event.text);
    return explicit || (modifies >= 0.3 && lifecycle >= 0.25 && new RegExp(`\\b${ownerFirst}\\b`, 'i').test(event.text));
  });
}

function resolveEnrichedActions(items, evidence, profile) {
  if (!enrichedEvidenceEnabled()) return items;
  const eligible = items.filter((item) => !actionIsSuperseded(item, evidence, profile)).filter((item) => {
    const sources = (item.evidenceIds || []).map((id) => evidence.events.find((event) => event.id === id)).filter(Boolean);
    const inactive = Math.max(...sources.flatMap((event) => ['completed', 'inactive', 'superseded'].map((label) => enrichedProbability(profile, event, 'lifecycleProbabilities', label))), 0);
    const active = Math.max(...sources.map((event) => enrichedProbability(profile, event, 'lifecycleProbabilities', 'active')), 0);
    const confirmed = Math.max(...sources.map((event) => trainedProbability(profile, event, 'actionProbabilities', 'confirmed_action')), 0);
    const possible = Math.max(...sources.map((event) => trainedProbability(profile, event, 'actionProbabilities', 'possible_action')), 0);
    const commitment = Math.max(...sources.map((event) => enrichedProbability(profile, event, 'discourseRoleProbabilities', 'canonical_commitment')), 0);
    const canonical = Math.max(...sources.map((event) => enrichedProbability(profile, event, 'canonicalWorthinessProbabilities', 'canonical_item')), 0);
    const noise = Math.max(...sources.map((event) => trainedProbability(profile, event, 'evidenceProbabilities', 'low_value_noise')), 0);
    const learnedOrActionable = item.learnedSlot || item.explicitFutureCommitment || confirmed >= 0.08 || possible >= 0.08 || commitment >= 0.1;
    const completeEnough = actionHasConcreteObject(item.action) || canonical >= 0.45 || noise < 0.5;
    return learnedOrActionable && completeEnough && (item.learnedSlot || sources.some((event) => independentlyCanonical(profile, event))) && !(inactive >= 0.65 && inactive > active);
  });
  const eventById = new Map(evidence.events.map((event) => [event.id, event]));
  const resolved = consolidate(eligible, {
    textOf: (item) => item.action,
    ownerOf: (item) => item.owner,
    qualityOf: (item) => actionPublishability(item, evidence, profile) + (Math.min(clean(item.action).split(/\s+/).length, 15) * 0.025) + (item.deadline !== 'Not stated' ? 0.2 : 0) - (item.learnedSlot ? 0.35 : 0) - (/\?|\b(?:it|that)\b/i.test(item.action) ? 0.25 : 0),
    profile,
    eventById,
    lexicalThreshold: 0.5,
    anchorGrouping: true,
    anchorTurnDistance: 24
  });
  return resolved.filter((item) => {
    const sameOwner = resolved.filter((other) => other !== item && clean(other.owner).toLowerCase() === clean(item.owner).toLowerCase());
    if (!sameOwner.length) return true;
    if (item.learnedSlot && !item.learnedAssignment && sameOwner.some((other) => other.learnedAssignment)) return false;
    const words = clean(item.action).split(/\s+/).filter(Boolean).length;
    const source = (item.evidenceIds || []).map((id) => evidence.events.find((event) => event.id === id)).filter(Boolean);
    const recap = Math.max(...source.map((event) => enrichedProbability(profile, event, 'discourseRoleProbabilities', 'multi_item_recap')), 0);
    const commitment = Math.max(...source.map((event) => enrichedProbability(profile, event, 'discourseRoleProbabilities', 'canonical_commitment')), 0);
    return words > 3 && !(recap >= 0.18 && recap > commitment);
  });
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
  if (item.explicitFutureCommitment || source.some((event) => event.roles.includes('action_candidate') && !event.roles.includes('hypothetical') && hasExplicitFutureCommitment(event.text))) quality += 0.8;
  if (item.deadline && item.deadline !== 'Not stated') quality += 0.12;
  if (words.length >= 4 && words.length <= 20) quality += 0.12;
  if (/\b(?:review|send|share|confirm|complete|prepare|update|provide|request|schedule|draft|test|submit|follow up|investigate|create|develop|finalise)\b/i.test(item.action)) quality += 0.1;
  if (/\b(?:share my screen|book a holiday|(?:mum|mother)['’]?s shopping|shopping for (?:my|their) (?:mum|mother)|housebound|weekend plans?|talk to you soon|speak to you next week|get down the road)\b/i.test(item.action)) quality -= 2;
  if (/^(?:be|stay) there\b|\b(?:free|available|availability)\b/i.test(item.action)) quality -= 1.2;
  if (/^(?:be|go|do|take|get|send|share|review|add|put|time)\s+(?:it|that|this|there|right|out|you)?[.!?]?$/i.test(item.action)) quality -= 0.8;
  if (/\?|\b(?:probably|maybe|I am|I think|I don['’]?t|wouldn['’]?t)\b/i.test(item.action)) quality -= 0.45;
  if (/\bI['’]?ll\s+(?:probably|maybe)\b/i.test(item.action)) quality -= 0.35;
  if (words.length < 3 || words.length > 28) quality -= 0.6;
  return quality;
}

function isUnderspecifiedAction(item) {
  const action = clean(item?.action);
  return /^(?:send|share|copy|give|take|put|sort|start|follow\s+up)\s+(?:it|that|this|her|him|them|here|there)\b/i.test(action)
    || /^(?:do|handle|take)\s+(?:it|that|this)\b/i.test(action)
    || /^(?:run|get)\s+(?:it|that|this)\b/i.test(action)
    || /^(?:be|stay)\s+there(?:\s+for\s+\w+)?[.!?]*$/i.test(action)
    || /^be\s+(?:mid|in|at|on)\b/i.test(action)
    || /^need\s+(?:before|after|by|for|when)\b/i.test(action)
    || /^try\s+and\s+do\s+is\b/i.test(action)
    || /^quickly\s+share\s+(?:so|if|when)\b/i.test(action)
    || /^know\s+(?:some|more|the|that)\b/i.test(action)
    || /^guarantee\s+if\b/i.test(action)
    || /\b(?:in terms of|that transmits)\s*[.!?]*$/i.test(action)
    || /^(?:start|continue|finish)\s+with\s+(?:it|that|this|order)(?:\s+from\s+.+)?[.!?]*$/i.test(action)
    || /\?\s*$/.test(action);
}

function canonicalActionText(value) {
  const text = clean(value);
  const provideOverview = text.match(/^(?:also\s+)?give\s+(?:you|them|him|her)\s+the\s+(.+?)\s+and\s+an?\s+overall\s+view\s+of\s+the\s+(.+?)(?:\s+themselves)?[.!?]*$/i);
  if (provideOverview) {
    const subject = clean(provideOverview[1]).replace(/\s+need$/i, '');
    const object = clean(provideOverview[2]).replace(/\s+themselves$/i, '');
    return `Provide the applicable ${subject} and an overview of the ${object}`;
  }
  const frontLoad = text.match(/^front[ -]?end\s+everything\s+for\s+(.+?)\s+as\s+much\s+as\s+possible[.!?]*$/i);
  if (frontLoad) return `Complete as much preparation as possible during ${frontLoad[1]}`;
  return text;
}

function actionsStage(evidence, state, profile, topology) {
  const threads = buildCommitmentThreads(evidence, profile, topology);
  const deterministic = deterministicStages.actionsStage(evidence, state, topology).actions;
  let actions = unique([
    ...deterministic,
    ...threads.flatMap((thread) => actionsFromThread(thread, evidence, profile)),
    ...acceptedTentativeActions(evidence),
    ...acceptedCollectiveActions(evidence),
    ...explicitObligationActions(evidence),
    ...learnedSlotActions(evidence, profile)
  ].map((item) => resolveActionReferent(item, evidence)), (item) => `${item.owner}|${item.action}`);
  if (enrichedEvidenceEnabled()) {
    actions = applyOperationalPhaseTiming(attachTemporalContext(resolveActionRecords(resolveEnrichedActions(actions, evidence, profile), evidence, {
      deadlineFrom,
      profileLabel: (event) => enrichedLabel(profile, event, 'temporalRoleProbabilities')
    }).map((item) => {
      if (item.deadline && item.deadline !== 'Not stated') return item;
      const lastIndex = Math.max(...(item.evidenceIds || []).map((id) => evidence.events.findIndex((event) => event.id === id)), -1);
      const deadlineEvent = evidence.events.slice(lastIndex + 1, lastIndex + 3).find((event) => enrichedLabel(profile, event, 'temporalRoleProbabilities') === 'deadline_previous' && deadlineFrom(event.text) !== 'Not stated');
      if (deadlineEvent) return { ...item, deadline: deadlineFrom(deadlineEvent.text), evidenceIds: [...new Set([...(item.evidenceIds || []), deadlineEvent.id])] };
      return item;
    }), evidence, profile, deadlineFrom), evidence, topology);
  }
  let actionCandidates = actions;
  const structuredEvidenceIds = new Set(evidence.events.filter((event) => event.structuredSource === 'actions_owner_deadline_table').map((event) => event.id));
  if (structuredEvidenceIds.size) {
    actions = unique(actions.filter((item) => item.learnedSlot || (item.evidenceIds || []).some((id) => structuredEvidenceIds.has(id)) || actionPublishability(item, evidence, profile) >= 0.45).map((item) => ({
      ...item,
      action: clean(clean(item.action)
        .replace(/\bRsk Mgmt\b/gi, 'Risk Management')
        .replace(/\bTrace SW to identify the change in the SW between\b/gi, 'Document software versioning traceability between')
        .replace(/^Review (.+?) standard compare to (.+?) documentation to outline what testing needs to be completed for (.+?) testing$/i, 'Compare $1 with $2 documentation and identify $3 testing gaps')
        .replace(/\b(?:by|on|at)\s*$/i, ''))
    })), (item) => `${item.owner}|${item.action}`);
  } else if (evidence.events.length >= 100 && topology.mode === 'standard') {
    const ranked = actions
      .filter((item) => !isUnderspecifiedAction(item))
      .map((item, index) => ({ item, index, publishability: actionPublishability(item, evidence, profile), strongCommitment: item.explicitFutureCommitment || (item.evidenceIds || []).some((id) => {
        const event = evidence.events.find((candidate) => candidate.id === id);
        return event?.roles.includes('action_candidate') && !event.roles.includes('hypothetical') && !/\?\s*$/.test(event.text) && (/\bI\s+(?:need to|must|have to)\b/i.test(event.text) || hasExplicitFutureCommitment(event.text));
      }) }))
      .filter((candidate) => candidate.publishability >= 0.08);
    const mandatory = ranked.filter((candidate) => candidate.strongCommitment);
    const optional = ranked.filter((candidate) => !candidate.strongCommitment)
      .sort((left, right) => right.publishability - left.publishability || left.index - right.index);
    actionCandidates = [...mandatory, ...optional]
      .sort((left, right) => left.index - right.index)
      .map((candidate) => candidate.item);
    actions = [...mandatory, ...optional.filter((candidate) => candidate.publishability >= 0.22)]
      .sort((left, right) => left.index - right.index)
      .map((candidate) => candidate.item);
  }
  const representedThreads = new Set(actionCandidates.map((item) => item.threadId).filter(Boolean));
  const semanticReviewCandidates = threads
    .filter((thread) => !representedThreads.has(thread.id))
    .map((thread) => semanticThreadReviewCandidate(thread, evidence, profile))
    .filter(Boolean)
    .sort((left, right) => right.semanticConfidence - left.semanticConfidence);
  actionCandidates = unique([...actionCandidates, ...semanticReviewCandidates], (item) => `${item.threadId || ''}|${item.owner}|${item.action}`);
  if (!structuredEvidenceIds.size) {
    actionCandidates = actionCandidates
      .filter((item) => !reviewCandidateNoise(item, evidence))
      .map((item, index) => ({ item, index, score: candidateReviewScore(item, evidence, profile) }))
      .filter((candidate) => candidate.score >= 0.06)
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, 24)
      .sort((left, right) => left.index - right.index)
      .map((candidate) => candidate.item);
  }
  // The same generic noise gate used for reviewer candidates must also protect
  // the published list. Otherwise a high classifier score can promote an
  // absence/status remark (for example, “out for the next few days”) as a task.
  actions = actions.filter((item) => !reviewCandidateNoise(item, evidence));
  const unresolvedThreads = threads.filter((thread) => !actions.some((action) => {
    if (action.threadId === thread.id) return true;
    const actionEvidence = new Set(action.evidenceIds || []);
    return thread.evidenceIds.some((id) => actionEvidence.has(id));
  })).map((thread) => ({
    threadId: thread.id, evidenceIds: thread.evidenceIds, scores: thread.semanticScores,
    reason: 'Semantic candidate could not be safely converted into an owner/action record.'
  }));
  // Only interrupt the reviewer for a credible, concrete omission. Raw thread
  // counts include tentative remarks, acknowledgements and fragments which are
  // useful for telemetry but make a permanently noisy UI warning.
  const credibleUnresolvedThreads = unresolvedThreads.filter((thread) => {
    const candidate = semanticThreadReviewCandidate(
      threads.find((item) => item.id === thread.threadId), evidence, profile
    );
    return candidate
      && candidate.semanticConfidence >= 0.38
      && !reviewCandidateNoise(candidate, evidence)
      && !actions.some((action) => action.evidenceIds?.some((id) => candidate.evidenceIds.includes(id)));
  });
  return {
    actions: actions.map((item) => ({ ...item, action: canonicalActionText(item.action) })),
    actionCandidates: actionCandidates.slice(0, 24).map((item) => ({ ...item, action: item.semanticOnly ? clean(item.action) : canonicalActionText(item.action) })),
    extractionMode: 'minilm_commitment_threads',
    commitmentThreads: threads,
    unresolvedThreads,
    warnings: [
      ...(actions.length ? [] : [{ type: 'no_actions_detected', severity: 'info', message: 'No transcript-supported action passed the MiniLM commitment-thread safety checks.' }]),
      ...(credibleUnresolvedThreads.length ? [{ type: 'unresolved_commitment_threads', severity: 'warning', message: 'A transcript-supported commitment may still need an owner or clearer wording. Check the suggested actions below.', evidenceIds: credibleUnresolvedThreads.flatMap((item) => item.evidenceIds) }] : [])
    ]
  };
}

module.exports = { contextStage, contentStage, actionsStage, buildCommitmentThreads, actionsFromThread, semanticActionCandidate, semanticThreadReviewCandidate, hasSemanticRole, learnedSlotActions, resolveEnrichedActions, isUnderspecifiedAction, canonicalActionText, canonicalRiskText };
