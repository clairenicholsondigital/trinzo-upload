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

// What became of each thing the reviewer corrected, for the stage just produced.
//
// Two jobs, one pass. It is the never-contradicted check - a confirmed value missing from
// a stage that should carry it is a bug in us, reported as one. And it is the answer to
// the question a reviewer actually has, which is whether the tool took any notice: a
// correction that was honoured and one that vanished look identical on screen otherwise.
//
// It reports; it does not gate. The reviewer is not the one who should be held up by our
// failing to carry their words forward.
function auditConfirmedAgainstScreen(state, stage, screen) {
  const text = (value) => {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(text).join('\n');
    if (typeof value === 'object') return Object.values(value).map(text).join('\n');
    return String(value);
  };
  const haystack = text(screen);
  const entries = [];
  const check = (label, values) => {
    for (const value of (Array.isArray(values) ? values : [values]).map((item) => String(item || '').trim()).filter(Boolean)) {
      entries.push({ label, value, carried: haystack.includes(value) });
    }
  };

  const confirmedText = (items) => (Array.isArray(items) ? items : [])
    .map((item) => String(item?.humanFinal || item?.text || '').trim())
    .filter(Boolean);

  if (stage === 'summary') {
    check('purpose', state.meeting?.purpose);
    check('objective', confirmedText(state.objectives));
    check('topic', confirmedText(state.topics));
  }
  if (stage === 'discussion') {
    check('topic', confirmedText(state.topics));
    check('key fact', (state.meetingUnderstanding?.criticalFacts || []).map((fact) => fact?.text));
  }
  if (stage === 'actions') {
    check('action', (state.actions || []).map((item) => item?.humanFinal || item?.action));
    check('owner', [...new Set((state.actions || []).map((item) => item?.owner).filter((owner) => owner && owner !== 'Not stated'))]);
  }

  const missing = entries.filter((entry) => !entry.carried);
  return {
    stage,
    confirmedCount: entries.length,
    carriedCount: entries.length - missing.length,
    missing: missing.map(({ label, value }) => ({ label, value })),
    carried: entries.filter((entry) => entry.carried).map(({ label, value }) => ({ label, value }))
  };
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
  let state = createCanonicalState({
    transcriptText,
    fileName: options.fileName,
    meeting: {
      title: options.meetingTitle || '',
      type: options.meetingType || '',
      participants: evidence.participants
    }
  });
  const stageSnapshots = [];
  const stages = [
    ['context', () => semanticStages.contextStage(evidence, semanticProfile, state, options.reviewerGuidance)],
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

module.exports = { runCanonicalNoEditPass, auditSemanticLocks, auditCompleteness, auditConfirmedAgainstScreen };
