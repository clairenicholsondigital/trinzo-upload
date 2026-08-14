'use strict';

const { prepareEvidence } = require('./evidence');
const { loadMiniLMProfileSync, semanticFor } = require('./minilm');
const { createCanonicalState, acceptProposal, lockedSemanticSnapshot } = require('./state');
const { finalMinutes } = require('./stages');
const semanticStages = require('./semanticStages');
const { assessEvidenceTopology } = require('./topology');
const { groundProposal } = require('./grounding');

function auditSemanticLocks(state, minutes) {
  const expected = lockedSemanticSnapshot(state);
  const actual = {
    objectives: minutes.meetingObjectives,
    decisions: minutes.decisions,
    risks: minutes.risks,
    actions: minutes.actions.map((item) => ({ owner: item.meetingActionPointOwner, action: item.meetingActionPoint, deadline: item.meetingActionPointDeadline }))
  };
  const failures = [];
  for (const key of ['objectives', 'decisions', 'risks', 'actions']) {
    if (JSON.stringify(expected[key]) !== JSON.stringify(actual[key])) failures.push({ type: 'locked_semantics_changed', collection: key });
  }
  return { passed: failures.length === 0, failures };
}

function auditCompleteness(evidence, state, profile) {
  const captured = new Set([
    ...state.decisions.flatMap((item) => item.evidenceIds || []),
    ...state.risks.flatMap((item) => item.evidenceIds || []),
    ...state.actions.flatMap((item) => item.evidenceIds || [])
  ]);
  const suggestions = evidence.events.filter((event) => {
    const semantic = semanticFor(profile, event);
    return !captured.has(event.id) && ['commitment', 'request', 'decision', 'risk'].some((role) => Number(semantic.scores?.[role] || 0) >= 0.4);
  }).map((event) => ({
    type: 'possible_missed_evidence', evidenceIds: [event.id], text: event.text, semantic: semanticFor(profile, event)
  }));
  return { passed: true, suggestions };
}

function runCanonicalNoEditPass(transcriptText, options = {}) {
  const startedAt = Date.now();
  const evidence = prepareEvidence(transcriptText);
  const observedTopology = assessEvidenceTopology(evidence);
  const topology = evidence.events.some((event) => event.structuredSource === 'actions_owner_deadline_table')
    ? { ...observedTopology, observedMode: observedTopology.mode, mode: 'standard', structuredMinutes: true }
    : observedTopology;
  const strategy = options.strategy || 'semantic_v2';
  const semanticProfile = options.semanticProfile || loadMiniLMProfileSync(evidence, options);
  if (!semanticProfile?.available) throw new Error(`Canonical MiniLM profile unavailable: ${semanticProfile?.reason || 'unknown error'}`);
  let state = createCanonicalState({ transcriptText, fileName: options.fileName, meeting: { title: options.meetingTitle || '', participants: evidence.participants } });
  const stageSnapshots = [];
  const stages = [
    ['context', () => semanticStages.contextStage(evidence, semanticProfile)],
    ['content', () => semanticStages.contentStage(evidence, state, semanticProfile)],
    ['actions', () => semanticStages.actionsStage(evidence, state, semanticProfile, topology)]
  ];
  for (const [stage, build] of stages) {
    const stageStartedAt = Date.now();
    const proposal = groundProposal(build(), evidence);
    const inputStateVersion = state.version;
    state = acceptProposal(state, proposal);
    stageSnapshots.push({ stage, inputStateVersion, acceptedStateVersion: state.version, proposal, warnings: proposal.warnings || [], durationMs: Date.now() - stageStartedAt });
  }
  const visibleOutput = finalMinutes(state);
  const audits = { semanticLock: auditSemanticLocks(state, visibleOutput), completeness: auditCompleteness(evidence, state, semanticProfile) };
  const warnings = stageSnapshots.flatMap((snapshot) => snapshot.warnings.map((warning) => ({ ...warning, stage: snapshot.stage })));
  return {
    ok: true,
    pipeline: 'canonical_staged_v2',
    strategy,
    mode: 'no_human_edits',
    canonicalState: state,
    evidenceTopology: topology,
    stageSnapshots,
    visibleOutput,
    audits,
    reviewExperience: {
      mode: 'no_human_edits',
      warnings,
      warningCount: warnings.length,
      blockingCount: audits.semanticLock.passed ? 0 : audits.semanticLock.failures.length,
      readyForFinalApproval: audits.semanticLock.passed,
      finalReviewMessage: audits.semanticLock.passed ? 'Canonical semantics were preserved through final output.' : 'Final output changed locked canonical semantics.'
    },
    metrics: {
      evidenceEventCount: evidence.events.length,
      participantCount: evidence.participants.length,
      extractionMode: 'minilm_commitment_threads',
      topologyObservation: topology.mode,
      modelCalls: 1,
      embeddingModel: semanticProfile.modelName,
      semanticCandidateCount: Object.values(semanticProfile.events || {}).filter((item) => item.confidence >= 0.36).length,
      topicClusterCount: (semanticProfile.topics || []).length,
      durationMs: Date.now() - startedAt
    }
  };
}

module.exports = { runCanonicalNoEditPass, auditSemanticLocks, auditCompleteness };
