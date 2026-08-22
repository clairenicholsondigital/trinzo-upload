'use strict';

const crypto = require('crypto');

const COLLECTIONS = ['objectives', 'topics', 'discussion', 'decisions', 'risks', 'actions', 'rejections'];

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
    topics: [],
    discussion: [],
    decisions: [],
    risks: [],
    actions: [],
    rejections: [],
    meetingUnderstanding: {
      meetingPurpose: '',
      meetingPurposeId: '',
      criticalFacts: []
    },
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

// Whether an item is the reviewer's own words rather than the model's.
//
// approvedItem has stamped `locked: true` on every accepted item since this module was
// written, and nothing has ever read it - the only references in the repository are
// assertions in canonical-staged.test.js. It cannot be the discriminator either, because
// it is set unconditionally, on model proposals as well. `source` is what actually
// separates the two: buildConfirmedState passes stage_1|2|3_human_confirmation when a
// screen came back from a reviewer, against the default stage_N_no_edit_acceptance.
//
// Cards assembled for a screen are plain objects rather than accepted items, so they
// carry the intent as `reviewerAuthored` or, for topic cards, the older `confirmedTopic`.
// All three mean the same thing to a gate: these words are the reviewer's and are not
// ours to reword, filter or drop.
const REVIEWER_SOURCE = /_human_confirmation$/;

function isReviewerAuthored(item) {
  if (!item || typeof item !== 'object') return false;
  return item.reviewerAuthored === true
    || item.confirmedTopic === true
    || REVIEWER_SOURCE.test(String(item.source || ''));
}

function acceptProposal(state, proposal, options = {}) {
  const version = state.version + 1;
  const next = { ...state, version };
  if (proposal.meeting) next.meeting = { ...state.meeting, ...proposal.meeting };
  if (proposal.meetingUnderstanding) {
    next.meetingUnderstanding = {
      ...(state.meetingUnderstanding || {}),
      ...proposal.meetingUnderstanding,
      criticalFacts: Array.isArray(proposal.meetingUnderstanding.criticalFacts)
        ? proposal.meetingUnderstanding.criticalFacts
        : (state.meetingUnderstanding?.criticalFacts || [])
    };
  }
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

module.exports = { createCanonicalState, acceptProposal, lockedSemanticSnapshot, isReviewerAuthored };
