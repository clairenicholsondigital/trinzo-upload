'use strict';

function baseDraft() {
  return {
    draftId: 'persistence-test', revision: 1,
    details: { meetingTitle: 'Original title' },
    discussion: [{ topic: 'Existing', points: [] }],
    actions: [{ id: 'A0', action: 'Existing action' }], pendingProposal: null,
    executiveSummary: 'Existing summary',
    meetingObjectives: [{ id: 'O0', text: 'Existing objective' }],
    candidateLedger: [], passProvenance: [], passCache: [], qualityState: {},
    reviewFlags: [], staleStages: [], currentStep: 1,
    generation: { stage: 'discussion', status: 'running', startedAt: '2026-09-16T10:00:00.000Z' }
  };
}

const results = {
  discussion: { changes: {
    discussion: [{ topic: 'Generated discussion', points: [] }],
    meetingObjectives: [{ id: 'OD', text: 'Discussion objective' }],
    candidateLedger: [{ candidateId: 'D1', recordType: 'discussion_point' }],
    passProvenance: [{ stage: 'discussion', pass: 'primary' }],
    passCache: [{ stage: 'discussion', pass: 'primary', promptSha256: 'd'.repeat(64), result: {} }],
    qualityState: { discussion: { completedPasses: ['primary'] } }
  }, reviewFlags: [], replaceCoverageFlags: false },
  actions: { changes: {
    actions: [{ id: 'A1', action: 'Generated action' }], pendingProposal: null,
    candidateLedger: [{ candidateId: 'A1', recordType: 'action' }],
    passProvenance: [{ stage: 'actions', pass: 'primary' }],
    passCache: [{ stage: 'actions', pass: 'primary', promptSha256: 'a'.repeat(64), result: {} }],
    qualityState: { actions: { completedPasses: ['primary'] } }
  }, reviewFlags: [], replaceCoverageFlags: false },
  summary: { changes: {
    executiveSummary: 'Generated summary',
    meetingObjectives: [{ id: 'OS', text: 'Summary objective' }],
    passProvenance: [{ stage: 'summary', pass: 'summary' }],
    passCache: [{ stage: 'summary', pass: 'summary', promptSha256: 's'.repeat(64), result: {} }],
    qualityState: { summary: { completedPasses: ['summary'] } }
  }, reviewFlags: [], replaceCoverageFlags: false }
};

module.exports = { baseDraft, results };
