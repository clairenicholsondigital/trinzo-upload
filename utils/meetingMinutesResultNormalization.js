'use strict';

const { normaliseDiscussion, normalisePointList } = require('./meetingMinutesDiscussionNormalization');
const { normaliseActions } = require('./meetingMinutesActionNormalization');
const {
  normaliseExecutiveSummary, isAutomaticTerminologyFlag, salientExcerpt, recordLabel, text
} = require('./meetingMinutesText');
const { normaliseFlag, flagRecordsIn, uniqueFlags } = require('./meetingMinutesReviewFlags');
const { assessmentOwnershipReviewNotice } = require('./meetingMinutesAssessmentEvidence');
const actionDiagnostics = require('./meetingMinutesActionDiagnostics');
const { evidenceContextFor, evidenceWindowText } = require('./meetingMinutesEvidenceContext');
const { actionTimingIssueFlag } = require('./meetingMinutesTimingFlags');
const { ownerSupportedByEvidence, ownerAssignedInMeeting } = require('./meetingMinutesPeopleEvidence');
const {
  correctnessChecksEnabled, laterRevisionUnit, citedRevisionUnit
} = require('./meetingMinutesEvidenceChecks');
const { timingWordingHasMeaning } = require('./meetingMinutesTimingPublication');
const { tokenOverlap } = require('./meetingMinutesRecordMatching');
const TimingIntegrity = require('./meetingMinutesTiming');
const { SCHEMA_VERSION } = require('./meetingMinutesResponseContracts');

function normaliseAgentResult(candidate = {}, units = [], stage = '', options = {}) {
  // enforceEvidence strips owners and timings the cited passages do not support.
  // That is right for agent output. It is wrong for a reviewer's own edits: the
  // reviewer is the human check on the agent, so their entry is flagged for
  // confirmation but never silently reverted.
  const enforceEvidence = options.enforceEvidence !== false;
  const discussion = normaliseDiscussion(candidate, units, options);
  const actions = normaliseActions(candidate, units, options);
  const objectives = normalisePointList(candidate.objectives, units, 'objective');
  const executiveSummary = normaliseExecutiveSummary(candidate.executiveSummary);
  // Objectives carry evidence links like any other record, but they are a
  // synthesis rather than a citable claim, so they are deliberately left out of
  // the missing-evidence sweep below - every save would otherwise re-flag them.
  for (const objective of objectives) delete objective._unsupportedEvidenceIds;
  const flags = (Array.isArray(candidate.reviewFlags) ? candidate.reviewFlags : []).filter((flag) => !isAutomaticTerminologyFlag(flag)).map((flag, index) => normaliseFlag(
    stage === 'actions' ? assessmentOwnershipReviewNotice(flag, candidate, units) : flag, index));
  const suppliedFlagCount = flags.length;
  const diagnosticNormalisedRows = actionDiagnostics.active() ? actions.map(action => actionDiagnostics.refs([action])) : [];
  const flagRecords = flagRecordsIn([...discussion, ...actions]);
  const originalFlagReferences = new Map(flagRecords.map(record => [record, new Set(record.reviewFlagIds)]));
  const records = [
    ...discussion.flatMap((topic) => [...topic.points, ...topic.decisions, ...topic.openQuestions]),
    ...actions
  ];
  const unitById = new Map(evidenceContextFor(units).rows.map((unit) => [unit.id, unit]));
  for (const action of actions) {
    for (const issue of action._timingDateIssues || []) {
      const message = /^timing_inference_/.test(issue.code) ? issue.message
        : `${issue.message} ${issue.preserveValue ? 'The stated date was retained for review.' : enforceEvidence ? 'The exact date was removed; confirm the retained source wording.' : 'Confirm the timing.'}`;
      const flag = normaliseFlag(actionTimingIssueFlag(issue, action, message), flags.length);
      flags.push(flag);
      action.reviewFlagIds.push(flag.id);
    }
    delete action._timingDateIssues;
    const evidenceText = evidenceWindowText(units, action.evidenceIds, 1);
    const unsupportedOwners = action.owners.filter((owner) => !ownerSupportedByEvidence(owner, evidenceText, units)
      && !ownerAssignedInMeeting(owner, action.action, units));
    if (unsupportedOwners.length) {
      const beforeOwnerCheck = actionDiagnostics.refs([action]);
      if (enforceEvidence) action.owners = action.owners.filter((owner) => !unsupportedOwners.includes(owner));
      const ownerCheckRefs = actionDiagnostics.refs([action]);
      actionDiagnostics.event(enforceEvidence ? 'owner_removed' : 'owner_flagged', beforeOwnerCheck, ownerCheckRefs,
        { mechanism: 'normaliseAgentResult', reason: 'unsupported_by_selected_evidence', unsupportedOwners });
      if (actionDiagnostics.active()) diagnosticNormalisedRows[actions.indexOf(action)].push(...ownerCheckRefs);
      const flag = normaliseFlag({
        kind: 'ownership',
        message: `Confirm or correct unsupported action ownership: ${unsupportedOwners.join(', ')}.`,
        evidenceIds: action.evidenceIds
      }, flags.length);
      flags.push(flag);
      action.reviewFlagIds.push(flag.id);
    }
    if (action._timingPublicationIssue) {
      const flag = normaliseFlag({
        kind: 'timing',
        message: action._timingPublicationIssue === 'task_duration_not_due_date'
          ? 'Timing was removed because it described how long the work lasts rather than when it is due.'
          : action._timingPublicationIssue === 'no_timing_signal'
            ? 'Timing was removed because it does not say when the work is due or what it depends on.'
            : 'Timing was removed because it was a copied action sentence rather than a date, target or dependency phrase.',
        evidenceIds: action.evidenceIds
      }, flags.length);
      flags.push(flag);
      action.reviewFlagIds.push(flag.id);
    }
    if (action.timing.kind !== 'not_stated') {
      if (correctnessChecksEnabled() && !timingWordingHasMeaning(action.timing)) {
        const meaninglessTiming = action.timing.wording || action.timing.exactDate;
        if (enforceEvidence) action.timing = { kind: 'not_stated', wording: '', exactDate: '' };
        const flag = normaliseFlag({
          kind: 'timing',
          message: `Timing ${enforceEvidence ? 'removed' : 'needs checking'} because "${meaninglessTiming}" does not state a date, target or dependency.`,
          evidenceIds: action.evidenceIds
        }, flags.length);
        flags.push(flag);
        action.reviewFlagIds.push(flag.id);
        if (enforceEvidence) continue;
      }
      const wordingSupported = action.timing.wording && (
        evidenceText.toLowerCase().includes(action.timing.wording.toLowerCase()) ||
        tokenOverlap(action.timing.wording, evidenceText) >= 0.5
      );
      // Exact-date validity and source-to-action binding were assessed above
      // by the shared policy. Do not re-derive the same date as its own proof,
      // or erase a genuine source-stated overdue date merely for being past.
      const exactDateSupported = Boolean(action.timing.exactDate && TimingIntegrity.isValidCalendarDate(action.timing.exactDate));
      if (!wordingSupported && !exactDateSupported) {
        const unsupportedTiming = action.timing.wording || action.timing.exactDate;
        if (enforceEvidence) action.timing = { kind: 'not_stated', wording: '', exactDate: '' };
        const flag = normaliseFlag({
          kind: 'timing',
          message: `Confirm or correct unsupported action timing: ${unsupportedTiming}.`,
          evidenceIds: action.evidenceIds
        }, flags.length);
        flags.push(flag);
        action.reviewFlagIds.push(flag.id);
      }
    }
    if (action._timingClauseNote) {
      const note = action._timingClauseNote;
      const flag = normaliseFlag({
        kind: 'timing',
        message: note.type === 'reassign'
          ? `The cited passage gives "${note.from}" for a different step and "${note.to}" for this one. Confirm the timing.`
          : '',
        evidenceIds: action.evidenceIds
      }, flags.length);
      flags.push(flag);
      action.reviewFlagIds.push(flag.id);
    }
    if (action._timingConflicts?.length) {
      const flag = normaliseFlag({
        kind: 'timing',
        message: 'Conflicting timing was returned for duplicate versions of this action; confirm the correct timing.',
        evidenceIds: action.evidenceIds
      }, flags.length);
      flags.push(flag);
      action.reviewFlagIds.push(flag.id);
    }
  }
  if (correctnessChecksEnabled()) {
    const discussionRecords = new Set(discussion.flatMap((topic) => [...topic.points, ...topic.decisions, ...topic.openQuestions]));
    for (const record of records) {
      if (!discussionRecords.has(record) || !record.evidenceIds.length) continue;
      const revision = laterRevisionUnit(units, record.evidenceIds) || citedRevisionUnit(units, record.evidenceIds, record.text || record.action || '');
      if (revision) {
        record.evidenceIds = [...new Set([...record.evidenceIds, revision.id])].slice(0, 8);
        const flag = normaliseFlag({
          kind: 'uncertain_fact',
          message: `Conflicting passage: the speaker appears to revise this shortly afterwards ("${salientExcerpt(revision.text, /./).slice(0, 200)}"). Confirm which statement is current.`,
          evidenceIds: record.evidenceIds
        }, flags.length);
        flags.push(flag);
        record.reviewFlagIds.push(flag.id);
      }
    }
  }
  for (const [index, record] of records.entries()) {
    if (record._unsupportedEvidenceIds?.length) {
      const flag = normaliseFlag({
        kind: 'missing_evidence',
        message: `"${recordLabel(record)}" pointed to transcript lines that do not exist (${record._unsupportedEvidenceIds.join(', ')}). Check it against the transcript.`,
        evidenceIds: record.evidenceIds
      }, flags.length + index);
      flags.push(flag);
      record.reviewFlagIds.push(flag.id);
    }
    const hadWeakEvidence = Boolean(record._weakEvidenceIds?.length);
    if (hadWeakEvidence) {
      const flag = normaliseFlag({
        kind: 'missing_evidence',
        message: `The linked transcript lines only partly support "${recordLabel(record)}". Check the wording against the transcript.`,
        evidenceIds: record.evidenceIds
      }, flags.length + index);
      flags.push(flag);
      record.reviewFlagIds.push(flag.id);
    }
    delete record._unsupportedEvidenceIds;
    delete record._weakEvidenceIds;
    delete record._evidenceDisposition;
    delete record._timingConflicts;
    delete record._timingClauseNote;
    delete record._timingPublicationIssue;
    if (hadWeakEvidence && !record.evidenceIds.length) continue;
    if (record.evidenceIds.length) continue;
    const flag = normaliseFlag({ kind: 'missing_evidence', message: `No transcript passage clearly supports "${recordLabel(record)}". Check it, or delete it if it was not said.` }, flags.length + index);
    flags.push(flag);
    record.reviewFlagIds.push(flag.id);
  }
  if (stage === 'discussion') flags.push(...unresolvedReferenceFlags(units));
  // Capture only checks created here, against exactly one action. Incoming
  // warnings may already concern discarded wording; never invent their origin
  // from the current row or a quotation parsed out of their explanation.
  for (const flag of flags.slice(suppliedFlagCount)) {
    const targets = flagRecords.filter(record => record.reviewFlagIds.includes(flag.id));
    if (targets.length === 1 && targets[0].action && !flag.actionWordingAtCheck) {
      flag.actionWordingAtCheck = text(targets[0].action, 1600);
    }
  }
  // A review decision belongs to its original warning and row. Only untouched
  // automatic duplicates, or a validation warning regenerated for that same
  // target, may share a flag. Build the kept list and aliases together so they
  // can never disagree about which reviewer decisions remain distinct.
  const { reviewFlags, alias } = uniqueFlags(flags, suppliedFlagCount, flagRecords, originalFlagReferences);
  if (alias.size) {
    const repoint = (record) => {
      if (Array.isArray(record?.reviewFlagIds)) record.reviewFlagIds = [...new Set(record.reviewFlagIds.map((id) => {
        const visited = new Set();
        while (alias.has(id) && !visited.has(id)) { visited.add(id); id = alias.get(id); }
        return id;
      }))];
      for (const detail of record?.supportingDetails || []) repoint(detail);
    };
    for (const topic of discussion) for (const record of [...(topic.points || []), ...(topic.decisions || []), ...(topic.openQuestions || [])]) repoint(record);
    for (const action of actions) repoint(action);
  }
  if (actionDiagnostics.active()) actions.forEach((action, index) => actionDiagnostics.event('normalisation_finalised',
    diagnosticNormalisedRows[index] || [], actionDiagnostics.refs([action]), { mechanism: 'normaliseAgentResult', index }));
  return { schemaVersion: SCHEMA_VERSION, discussion, actions, objectives, executiveSummary, reviewFlags };
}

function unresolvedReferenceFlags(units = []) {
  const standardLike = /\b(?:standard|IEC|ISO|EN|BS|ASTM|six(?:ty)?[- ]?oh[- ]?one|eight[- ]?ten[- ]?oh[- ]?one|twenty[- ]?seven)\b/i;
  const uncertainty = /\b(?:something|whatever|I think|maybe|roughly|approximately|or so|not sure|can't remember|cannot remember)\b/i;
  return evidenceContextFor(units).rows.filter((unit) => standardLike.test(unit.text) && uncertainty.test(unit.text)).map((unit, index) => normaliseFlag({
    kind: 'unclear_reference',
    message: `Confirm the standard reference exactly as spoken: “${unit.text.slice(0, 220)}”`,
    evidenceIds: [unit.id]
  }, index));
}

module.exports = { normaliseAgentResult };
