'use strict';

const { prepareEvidence, clean } = require('./evidence');
const { loadMiniLMProfileSync } = require('./minilm');
const { createCanonicalState, acceptProposal } = require('./state');
const semanticStages = require('./semanticStages');
const { assessEvidenceTopology } = require('./topology');

function strings(values) {
  return (Array.isArray(values) ? values : []).map((value) => clean(value)).filter(Boolean);
}

function approvedText(values, key = 'text') {
  return strings(values).map((text) => ({ [key]: text, humanFinal: text, aiOriginal: text }));
}

function approvedDiscussion(values) {
  return (Array.isArray(values) ? values : []).map((card) => ({
    topic: clean(card?.topic) || 'Discussion',
    points: strings(card?.points || card?.bullets).map((text) => ({ text })),
    humanFinal: clean(card?.topic) || 'Discussion',
    aiOriginal: clean(card?.topic) || 'Discussion'
  })).filter((card) => card.points.length);
}

function approvedActions(values) {
  return (Array.isArray(values) ? values : []).map((item) => ({
    owner: clean(item?.owner) || 'Not stated',
    action: clean(item?.action),
    deadline: clean(item?.deadline) || 'Not stated',
    humanFinal: clean(item?.action),
    aiOriginal: clean(item?.action)
  })).filter((item) => item.action);
}

function buildConfirmedState(transcriptText, fileName, confirmed = {}) {
  const details = confirmed.details || {};
  const participants = strings(details.participants || details.allAttendees || [
    ...(details.internalAttendees || []), ...(details.clientAttendees || [])
  ]);
  let state = createCanonicalState({
    transcriptText,
    fileName,
    meeting: {
      title: clean(details.meetingTitle),
      date: clean(details.meetingDate),
      location: clean(details.meetingLocation),
      type: clean(details.meetingType),
      participants
    }
  });
  const summary = confirmed.summary || {};
  if (Object.keys(summary).length) {
    state = acceptProposal(state, {
      objectives: approvedText(summary.objectives),
      meeting: state.meeting
    }, { source: 'stage_1_human_confirmation' });
  }
  if (Array.isArray(confirmed.discussion)) {
    const confirmedCards = approvedDiscussion(confirmed.discussion);
    const decisionText = confirmed.discussion.filter((card) => /^decisions?$/i.test(clean(card?.topic))).flatMap((card) => strings(card?.points || card?.bullets));
    const riskText = confirmed.discussion.filter((card) => /^(?:risks?|issues? and risks?)$/i.test(clean(card?.topic))).flatMap((card) => strings(card?.points || card?.bullets));
    state = acceptProposal(state, {
      discussion: confirmedCards,
      decisions: approvedText([...strings(confirmed.decisions), ...decisionText]),
      risks: approvedText([...strings(confirmed.risks), ...riskText])
    }, { source: 'stage_2_human_confirmation' });
  }
  if (Array.isArray(confirmed.actions)) {
    state = acceptProposal(state, { actions: approvedActions(confirmed.actions) }, { source: 'stage_3_human_confirmation' });
  }
  return state;
}

function summaryScreen(proposal) {
  const objectives = proposal.objectives.map((item) => item.text);
  const overallTopics = (Array.isArray(proposal.topics) && proposal.topics.length
    ? proposal.topics.map((item) => item.text)
    : objectives.map((text) => clean(text).replace(/^Review\s+/i, ''))).filter(Boolean);
  const meetingType = clean(proposal.meeting?.type).toLowerCase();
  return {
    objectives,
    overallTopics,
    executiveSummary: /webinar/.test(meetingType) && /rehearsal|practice|run[ -]?through/.test(meetingType)
      ? `The webinar rehearsal reviewed ${overallTopics.join('; ').replace(/; ([^;]+)$/, '; and $1').toLowerCase()}.`
      : overallTopics.length
      ? `The meeting reviewed ${overallTopics.join('; ')}.`
      : 'No substantive meeting topics were identified automatically.'
  };
}

function discussionScreen(proposal) {
  const cards = proposal.discussion.map((card) => ({
    topic: card.topic,
    points: card.points.map((point) => point.text).filter(Boolean),
    evidenceIds: card.evidenceIds || [],
    topicId: card.topicId || null
  }));
  if (proposal.decisions.length) cards.push({ topic: 'Decisions', points: proposal.decisions.map((item) => item.text), evidenceIds: proposal.decisions.flatMap((item) => item.evidenceIds || []), topicId: 'canonical_decisions' });
  if (proposal.risks.length) cards.push({ topic: 'Risks', points: proposal.risks.map((item) => item.text), evidenceIds: proposal.risks.flatMap((item) => item.evidenceIds || []), topicId: 'canonical_risks' });
  return cards;
}

function warningFlags(warnings, stage) {
  return (warnings || []).map((warning, index) => ({
    ...warning,
    blocking: Boolean(warning.blocking),
    resolutionKey: warning.resolutionKey || `canonical_${stage}_${warning.type || index}`
  }));
}

function runCanonicalLiveStage(transcriptText, options = {}) {
  const stage = clean(options.stage).toLowerCase();
  if (!['summary', 'discussion', 'actions'].includes(stage)) throw new Error(`Unsupported canonical live stage: ${stage}`);
  const evidence = prepareEvidence(transcriptText);
  const observedTopology = assessEvidenceTopology(evidence);
  const topology = evidence.events.some((event) => event.structuredSource === 'actions_owner_deadline_table')
    ? { ...observedTopology, observedMode: observedTopology.mode, mode: 'standard', structuredMinutes: true }
    : observedTopology;
  const profile = loadMiniLMProfileSync(evidence, options);
  if (!profile?.available) throw new Error(`Canonical MiniLM profile unavailable: ${profile?.reason || 'unknown error'}`);
  const confirmed = options.confirmed || {};
  let state = buildConfirmedState(transcriptText, options.fileName || 'transcript.txt', confirmed);
  let proposal;
  if (stage === 'summary') proposal = semanticStages.contextStage(evidence, profile, state);
  if (stage === 'discussion') proposal = semanticStages.contentStage(evidence, state, profile);
  if (stage === 'actions') proposal = semanticStages.actionsStage(evidence, state, profile, topology);
  const screen = stage === 'summary' ? summaryScreen(proposal)
    : stage === 'discussion' ? discussionScreen(proposal)
      : proposal.actions.map(({ owner, action, deadline, evidenceIds }) => ({ owner, action, deadline, evidenceIds }));
  return {
    pipeline: 'canonical_staged_v2',
    strategy: 'semantic_v2',
    stagedStage: stage,
    screens: { [stage]: screen },
    decisions: stage === 'discussion' ? proposal.decisions.map((item) => item.text) : strings(confirmed.decisions),
    risks: stage === 'discussion' ? proposal.risks.map((item) => item.text) : strings(confirmed.risks),
    validationFlags: warningFlags(proposal.warnings, stage),
    canonicalDiagnostics: {
      inputStateVersion: state.version,
      confirmedCollections: {
        objectives: state.objectives.length,
        discussion: state.discussion.length,
        decisions: state.decisions.length,
        risks: state.risks.length,
        actions: state.actions.length
      },
      evidenceEventCount: evidence.events.length,
      participantCount: evidence.participants.length,
      topology: topology.mode,
      modelName: profile.modelName,
      humanConfirmedInputIsAuthoritative: true
    },
    telemetryPreview: {
      topicCount: (profile.topics || []).length,
      discussionCards: stage === 'discussion' ? screen.length : 0,
      actionCount: stage === 'actions' ? screen.length : 0,
      embeddingClassifier: { used: true, model: profile.modelName },
      evidenceClassifier: { used: true }
    }
  };
}

module.exports = { runCanonicalLiveStage, buildConfirmedState };
