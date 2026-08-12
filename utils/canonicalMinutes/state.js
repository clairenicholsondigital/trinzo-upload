'use strict';

const crypto = require('crypto');

const COLLECTIONS = ['objectives', 'discussion', 'decisions', 'risks', 'actions', 'rejections'];

function createCanonicalState({ transcriptText, fileName = 'transcript.txt', meeting = {} }) {
  return {
    schemaVersion: '1.0',
    runId: crypto.randomUUID(),
    transcript: {
      fileName,
      sha256: crypto.createHash('sha256').update(String(transcriptText || ''), 'utf8').digest('hex')
    },
    meeting,
    objectives: [],
    discussion: [],
    decisions: [],
    risks: [],
    actions: [],
    rejections: [],
    warnings: [],
    version: 0
  };
}

function approvedItem(kind, item, version, index, options = {}) {
  const value = typeof item === 'string' ? { text: item } : { ...item };
  return {
    ...value,
    id: value.id || `${kind}_${version}_${index + 1}`,
    status: 'human_approved',
    locked: true,
    source: options.source || `stage_${version}_no_edit_acceptance`,
    aiOriginal: value.aiOriginal ?? value.text ?? value.action ?? '',
    humanFinal: value.humanFinal ?? value.text ?? value.action ?? ''
  };
}

function acceptProposal(state, proposal, options = {}) {
  const version = state.version + 1;
  const next = { ...state, version };
  if (proposal.meeting) next.meeting = { ...state.meeting, ...proposal.meeting };
  for (const key of COLLECTIONS) {
    if (!Object.prototype.hasOwnProperty.call(proposal, key)) continue;
    next[key] = (Array.isArray(proposal[key]) ? proposal[key] : []).map((item, index) => approvedItem(key.slice(0, -1), item, version, index, options));
  }
  next.warnings = [...state.warnings, ...(proposal.warnings || [])];
  return next;
}

function lockedSemanticSnapshot(state) {
  return {
    objectives: state.objectives.map((item) => item.humanFinal),
    decisions: state.decisions.map((item) => item.humanFinal),
    risks: state.risks.map((item) => item.humanFinal),
    actions: state.actions.map((item) => ({ owner: item.owner, action: item.action, deadline: item.deadline }))
  };
}

module.exports = { createCanonicalState, acceptProposal, lockedSemanticSnapshot };
