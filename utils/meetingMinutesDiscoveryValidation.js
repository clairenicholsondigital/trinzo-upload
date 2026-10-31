'use strict';

const { normaliseSourceUnits } = require('./meetingMinutesSource');
const { normaliseAgentResult } = require('./meetingMinutesResultNormalization');
const {
  dedupeHybridActionRecords,
  dedupeHybridActionProposals
} = require('./meetingMinutesActionDuplicatePolicy');
const { cleanActionWording } = require('./meetingMinutesText');
const { hybridTokenOverlap } = require('./meetingMinutesRecordMatching');
const { evidenceSupportScore } = require('./meetingMinutesEvidenceContext');
const { documentReferenceContextEvidence } = require('./meetingMinutesAssessmentEvidence');
const { isMeetingAdminAction, actionEvidenceDisposition } = require('./meetingMinutesActionEvidence');
const { gateEnabled: transcriptTextGateEnabled, transcriptTextIssue } = require('./actionTextGate');
const { normaliseFlag: normaliseMeetingAgentFlag } = require('./meetingMinutesReviewFlags');
const crypto = require('crypto');
const { flattenHybridDiscussion } = require('./meetingMinutesDiscussionRows');
const { meetingMinutesAgentText } = require('./meetingMinutesPlainText');
const {
  normaliseAgentCandidateDispositions,
  SCHEMA_VERSION: MEETING_AGENT_SCHEMA_VERSION
} = require('./meetingMinutesResponseContracts');

function normaliseAgentDeclaredProposals(result = {}, sourceUnits = [], options = {}) {
  const direct = Array.isArray(result?.actionProposals) ? result.actionProposals : [];
  const dispositions = Array.isArray(result?.candidateDispositions) ? result.candidateDispositions : [];
  const fromDispositions = dispositions.filter((item) => item?.disposition === 'proposal' && item?.action)
    .map((item) => ({
      id: item.id || item.candidateId,
      action: item.action,
      owners: Array.isArray(item.owners) ? item.owners : [],
      timing: item.timing,
      evidenceIds: item.evidenceIds,
      reviewFlagIds: []
    }));
  const raw = [...direct, ...fromDispositions].map((item) => item?.record || item).filter((item) => item?.action);
  const units = normaliseSourceUnits(sourceUnits);
  const validIds = new Set(units.map((unit) => unit.id));
  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  const normalised = normaliseAgentResult({ actions: raw }, sourceUnits, 'actions', {
    // A proposal is allowed to describe an unaccepted offer or ambiguous
    // follow-up, so the automatic-action lifecycle gate is intentionally not
    // used here. The explicit evidence validation below remains mandatory.
    enforceEvidence: false, meetingDate: options.meetingDate
  }).actions;
  return dedupeHybridActionRecords(normalised.map((action) => {
    const sameLabel = raw.filter(item => item.id && item.id === action.id);
    // Discovery labels are ordinal within a response. When two replies reuse
    // one, require a unique wording match rather than borrowing the first
    // proposal's citations for a different document or assessment.
    const sameWording = sameLabel.filter(item => cleanActionWording(item.action) === action.action);
    const supplied = sameLabel.length === 1 ? sameLabel[0]
      : sameLabel.length > 1 ? (sameWording.length === 1 ? sameWording[0] : null)
        : raw.find(item => hybridTokenOverlap(item.action, action.action) >= 0.55);
    let evidenceIds = [...new Set((supplied?.evidenceIds || []).filter((id) => validIds.has(id)))].slice(0, 8);
    let evidence = evidenceIds.map((id) => `${unitById.get(id)?.speaker || ''}: ${unitById.get(id)?.text || ''}`).join(' ');
    let documentContext = null;
    if (evidenceIds.length && evidenceSupportScore(action.action, evidence) < 0.22) {
      documentContext = documentReferenceContextEvidence(action.action, evidenceIds, sourceUnits);
      if (!documentContext) {
        const prefix = action.action.match(/\b(ISO|IEC|ASTM|EN|BS)\s+(\d{3,5}(?:[-–]\d{1,4})*(?::\d{4})?)\b/i);
        if (prefix) {
          const withoutPrefix = action.action.replace(prefix[0], `standard ${prefix[2]}`);
          const uncertain = documentReferenceContextEvidence(withoutPrefix, evidenceIds, sourceUnits);
          if (uncertain && !uncertain.evidenceIds.some(id =>
            String(unitById.get(id)?.text || '').toLowerCase().includes(prefix[0].toLowerCase()))) {
            documentContext = { ...uncertain, unstatedPrefix: prefix[1].toUpperCase() };
          }
        }
      }
      if (documentContext) {
        evidenceIds = documentContext.evidenceIds;
        evidence = evidenceIds.map((id) => `${unitById.get(id)?.speaker || ''}: ${unitById.get(id)?.text || ''}`).join(' ');
      }
    }
    if (!evidenceIds.length || evidenceSupportScore(action.action, evidence) < 0.22) return null;
    // Still screened for what is never an action at all: running the meeting
    // ("No bother Dermot, we'll come to you in a minute") and wording that is
    // a line of the conversation rather than a written instruction.
    if (isMeetingAdminAction(action.action) || actionEvidenceDisposition(action.action, evidence) === 'meeting_admin') return null;
    if (transcriptTextGateEnabled() && transcriptTextIssue(action.action, sourceUnits)) return null;
    if (documentContext) {
      const flag = normaliseMeetingAgentFlag({
        id: 'flag-document-reference-' + crypto.createHash('sha256').update(JSON.stringify([
          action.id, action.action, documentContext.originalEvidenceIds, documentContext.addedEvidenceIds
        ])).digest('hex').slice(0, 16),
        kind: 'unclear_reference',
        message: documentContext.unstatedPrefix
          ? `Document reference to correct: the proposed ${documentContext.unstatedPrefix} identifier prefix is not stated in the linked source. Confirm or correct the document name before including this assessment. Added context does not verify ownership or acceptance.`
          : 'Document reference to check: the action names a document identified in the preceding source passage. Confirm that this assessment concerns that document. The connection, ownership and acceptance have not been verified by adding this context.',
        evidenceIds, actionWordingAtCheck: action.action,
        documentReferenceContext: { kind: 'adjacent_identity_context', ...documentContext }
      });
      return { ...action, evidenceIds, reviewFlagIds: [...new Set([...(action.reviewFlagIds || []), flag.id])] };
    }
    return { ...action, evidenceIds };
  }).filter(Boolean));
}

function meetingAgentEmptyDiscoveryError(result, stage, candidates = [], sourceUnits = [], options = {}) {
  const isDiscussion = stage === 'discussion';
  const isActions = stage === 'actions';
  if (!isDiscussion && !isActions) return null;
  const normalised = Array.isArray(sourceUnits) && sourceUnits.length
    ? normaliseAgentResult(result, sourceUnits, stage, { meetingDate: options.meetingDate })
    : null;
  const hasOutput = isDiscussion
    ? normalised
      ? flattenHybridDiscussion(normalised.discussion).some((item) =>
        Array.isArray(item?.record?.evidenceIds) && item.record.evidenceIds.length > 0)
      : Array.isArray(result?.discussion) && result.discussion.length > 0
    : normalised
      ? normalised.actions.some((item) => Array.isArray(item?.evidenceIds) && item.evidenceIds.length > 0)
        || normaliseAgentDeclaredProposals(result, sourceUnits, { meetingDate: options.meetingDate })
          .some((item) => Array.isArray(item?.evidenceIds) && item.evidenceIds.length > 0)
      : (Array.isArray(result?.actions) && result.actions.length > 0)
        || (Array.isArray(result?.actionProposals) && result.actionProposals.length > 0);
  if (hasOutput) return null;
  const isSubstantiveCandidate = (candidate) => {
    const recordType = String(candidate?.recordType || candidate?.kind || '');
    if (isDiscussion) {
      return ['decision', 'open_question', 'objective'].includes(recordType)
        || Number(candidate?.priority || 0) >= 7;
    }
    const owners = candidate?.owners || candidate?.record?.owners || candidate?.ownerHints || [];
    const signals = candidate?.signals || {};
    return ['action_chain', 'action_thread'].includes(recordType)
      ? ['committed', 'accepted_request', 'conditional_commitment'].includes(candidate?.dispositionHint)
        && Boolean(signals.commitment || signals.acceptance || signals.assignment || signals.scheduled)
      : recordType === 'action' && Number(candidate?.priority || 0) >= 8
        && (Array.isArray(owners) ? owners.length > 0 : Boolean(owners));
  };
  const substantive = (Array.isArray(candidates) ? candidates : []).filter(isSubstantiveCandidate);
  if (!substantive.length) return null;
  // An empty actions draft is not a failed call when the agent has explicitly
  // disposed of every substantive candidate as already covered, completed or a
  // mere suggestion. Retrying that answer only re-sends the same prompt and
  // costs a minute of the reviewer's wait; the Power Automate run itself
  // succeeded. Only the substantive candidates need accounting for: the
  // error exists because of them, not the low-priority windows around them.
  const unaccounted = isActions ? agentUnaccountedCandidates(result, substantive, sourceUnits) : substantive;
  if (isActions && !unaccounted.length) return null;
  const error = new Error(`The ${isDiscussion ? 'discussion' : 'action'} agent returned an empty draft despite substantive evidence candidates`
    + (isActions ? ` (${unaccounted.length} of ${substantive.length} without a reasoned disposition: ${unaccounted.slice(0, 4).join(', ')}).` : '.'));
  error.code = `empty_${isDiscussion ? 'discussion' : 'action'}_with_substantive_candidates`;
  error.statusCode = 502;
  error.retryable = true;
  return error;
}

function agentUnaccountedCandidates(result = {}, candidates = [], sourceUnits = []) {
  const supplied = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => meetingMinutesAgentText(candidate?.candidateId, 120)).filter(Boolean);
  const dispositions = Array.isArray(sourceUnits) && sourceUnits.length
    ? normaliseAgentCandidateDispositions(result, sourceUnits)
    : (Array.isArray(result?.candidateDispositions) ? result.candidateDispositions : []);
  const settled = new Set(dispositions
    .filter((item) => ['reject', 'completed', 'suggestion'].includes(item?.disposition)
      && meetingMinutesAgentText(item?.reason, 500))
    .map((item) => meetingMinutesAgentText(item?.candidateId, 120)));
  return supplied.filter((candidateId) => !settled.has(candidateId));
}

// The structured Referee normally returns dispositions rather than repeating
// complete action objects. reconstructRefereeActions turns those dispositions
// back into records; proposal rows must then enter the same proposal pipeline
// as proposals written directly by an Agent response. Reading only the raw
// response here silently discarded every disposition-only proposal.
function normaliseRefereeDeclaredProposals(result = {}, reconstructed = {}, sourceUnits = [], options = {}) {
  return normaliseAgentDeclaredProposals({
    ...result,
    actionProposals: dedupeHybridActionProposals([
      ...(Array.isArray(result?.actionProposals) ? result.actionProposals : []),
      ...(Array.isArray(reconstructed?.actionProposals) ? reconstructed.actionProposals : [])
    ])
  }, sourceUnits, options);
}

function normaliseAnchoredActionDiscovery(result = {}, sourceUnits = [], options = {}) {
  const units = normaliseSourceUnits(sourceUnits);
  const validEvidence = new Set(units.map((unit) => unit.id));
  const splitScalarList = (value) => [...new Set(meetingMinutesAgentText(value, 1600)
    .split(/\s*[|;]\s*/).map((item) => item.trim()).filter(Boolean))];
  const rows = Array.isArray(result?.actionResults) ? result.actionResults : [];
  const actions = [];
  const actionProposals = [];
  for (const row of rows) {
    const action = meetingMinutesAgentText(row?.action, 1200);
    // Refusals can contain the same future/intent tokens as commitments. They
    // are never publishable work, so enforce that invariant independently of
    // the model's disposition.
    if (/^(?:i|we|you|he|she|they)(?:\s+(?:am|are|is))?\s+(?:not|never)\b|^(?:i|we|you|he|she|they)(?:'m|'re|'s)\s+(?:not|never)\b|^(?:i|we|you|he|she|they)\s+(?:won't|wouldn't|can't|cannot|don't|do not)\b/i.test(action)) continue;
    const evidenceIds = splitScalarList(row?.evidenceCsv)
      .flatMap((item) => item.split(/\s*,\s*/))
      .map((item) => item.trim()).filter((item) => validEvidence.has(item));
    if (!action || !evidenceIds.length) continue;
    const disposition = ({
      core: 'publish', keep: 'publish', uncertain: 'proposal', supporting: 'proposal',
      complete: 'completed', done: 'completed', idea: 'suggestion', discard: 'reject'
    })[meetingMinutesAgentText(row?.disposition, 60).toLowerCase()]
      || meetingMinutesAgentText(row?.disposition, 60).toLowerCase();
    if (!['publish', 'proposal'].includes(disposition)) continue;
    const timingKind = meetingMinutesAgentText(row?.timingKind, 40).toLowerCase();
    const record = {
      id: meetingMinutesAgentText(row?.resultId, 160)
        || `action-discovery-${crypto.createHash('sha256').update(`${action}|${evidenceIds.join('|')}`).digest('hex').slice(0, 12)}`,
      action,
      owners: splitScalarList(row?.ownersCsv),
      timing: {
        kind: ['deadline', 'target', 'dependency', 'not_stated'].includes(timingKind)
          ? timingKind : 'not_stated',
        wording: meetingMinutesAgentText(row?.timingWording, 220),
        exactDate: meetingMinutesAgentText(row?.exactDate, 20)
      },
      evidenceIds: [...new Set(evidenceIds)].slice(0, 12),
      reviewFlagIds: []
    };
    (disposition === 'publish' ? actions : actionProposals).push(record);
  }
  const normalisedActions = normaliseAgentResult(
    { actions }, sourceUnits, 'actions', { meetingDate: options.meetingDate }
  ).actions;
  const normalisedProposals = normaliseAgentDeclaredProposals(
    { actionProposals }, sourceUnits, { meetingDate: options.meetingDate }
  );
  return {
    schemaVersion: MEETING_AGENT_SCHEMA_VERSION,
    discussion: [], actions: normalisedActions,
    actionProposals: normalisedProposals,
    candidateDispositions: [], reviewFlags: []
  };
}

function normaliseAnchoredDiscussionDiscovery(result = {}, anchors = [], sourceUnits = []) {
  const expected = (Array.isArray(anchors) ? anchors : []).filter((anchor) => anchor?.anchorId);
  const expectedIds = expected.map((anchor) => String(anchor.anchorId));
  const rows = Array.isArray(result?.anchorResults) ? result.anchorResults : [];
  const returnedIds = rows.map((row) => meetingMinutesAgentText(row?.anchorId, 180));
  const counts = new Map(returnedIds.map((id) => [id, Number(returnedIds.filter((value) => value === id).length)]));
  const invalidIds = expectedIds.filter((id) => counts.get(id) !== 1)
    .concat(returnedIds.filter((id) => !expectedIds.includes(id)));
  // The candidate IDs are the authoritative accounting contract. AI Builder
  // occasionally serialises a correct set in a different order or misstates a
  // redundant count field. Reorder the complete set here; only a genuinely
  // missing, duplicate or unexpected ID warrants another model request.
  const accountingValid = rows.length === expectedIds.length && invalidIds.length === 0;
  if (!accountingValid) {
    const error = new Error('Anchored discussion discovery returned incomplete candidate accounting.');
    error.statusCode = 502;
    error.code = 'invalid_anchored_discussion_accounting';
    error.retryable = true;
    error.invalidCandidateIds = [...new Set(invalidIds)];
    throw error;
  }
  const validEvidence = new Set((Array.isArray(sourceUnits) ? sourceUnits : []).map((unit) => unit?.id).filter(Boolean));
  const anchorById = new Map(expected.map((anchor) => [String(anchor.anchorId), anchor]));
  const resultById = new Map(rows.map((row) => [String(row.anchorId), row]));
  const topics = new Map();
  for (const expectedId of expectedIds) {
    const row = resultById.get(expectedId);
    const recordType = meetingMinutesAgentText(row?.recordType, 60).toLowerCase();
    const rawDisposition = meetingMinutesAgentText(row?.disposition, 40).toLowerCase();
    const disposition = ({
      keep: 'core', context: 'supporting', merge: 'supporting', discard: 'reject',
      // AI Builder occasionally copies its recordType enum into disposition.
      // A decision or material unresolved question is intrinsically core;
      // ordinary discussion remains collapsed. This is a typed-field repair,
      // not a content-specific inference.
      decision: recordType === 'decision' ? 'core' : 'supporting',
      open_question: recordType === 'open_question' ? 'core' : 'supporting',
      discussion_point: 'supporting'
    })[rawDisposition]
      || (['core', 'supporting', 'reject'].includes(rawDisposition) ? rawDisposition : 'supporting');
    if (disposition === 'reject') continue;
    const anchor = anchorById.get(String(row.anchorId));
    const allowedEvidence = new Set((anchor?.evidenceIds || []).filter((id) => validEvidence.has(id)));
    const returnedEvidence = meetingMinutesAgentText(row?.evidenceCsv, 800)
      .split(',').map((id) => id.trim()).filter((id) => allowedEvidence.has(id));
    const evidenceIds = [...new Set(returnedEvidence.length ? returnedEvidence : [...allowedEvidence])];
    const recordText = meetingMinutesAgentText(row?.text, 1200);
    if (!recordText || !evidenceIds.length) continue;
    const topicName = meetingMinutesAgentText(row?.topic, 240) || 'Discussion';
    if (!topics.has(topicName)) topics.set(topicName, {
      id: `topic-${topics.size + 1}`, topic: topicName, points: [], decisions: [], openQuestions: []
    });
    const record = {
      id: String(row.anchorId), text: recordText, evidenceIds,
      supportingDetails: [], reviewFlagIds: [], discoveryDisposition: disposition
    };
    if (recordType === 'decision') topics.get(topicName).decisions.push(record);
    else if (recordType === 'open_question') topics.get(topicName).openQuestions.push(record);
    else topics.get(topicName).points.push(record);
  }
  return {
    schemaVersion: MEETING_AGENT_SCHEMA_VERSION,
    meetingObjectives: [], discussion: [...topics.values()], actions: [], reviewFlags: []
  };
}

module.exports = {
  normaliseAgentDeclaredProposals,
  meetingAgentEmptyDiscoveryError,
  normaliseRefereeDeclaredProposals,
  normaliseAnchoredActionDiscovery,
  normaliseAnchoredDiscussionDiscovery
};
