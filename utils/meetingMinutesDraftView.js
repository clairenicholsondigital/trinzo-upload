'use strict';

// Complete Library/editor draft projection and insights, including both engine views and warning/proposal visibility.

const { circularMetaAction } = require('./canonicalMinutes/actionDeliverableIdentity');
const discussionClaims = require('./canonicalMinutes/discussionClaimConsolidationState');
const { isPublishableTopicLabel } = require('./canonicalMinutes/topicEditorial');
const { isClientReadyActionWording } = require('./meetingMinutesActionDuplicatePolicy');
const { timingLabel: meetingAgentTimingLabel } = require('./meetingMinutesAgentDocx');
const { originalEnquiryActions } = require('./meetingMinutesEnquiryRecovery');
const { filingReviewFlags, filingSuggestions } = require('./meetingMinutesFilingReview');
const { meetingAgentActionsPrewarmState, meetingAgentGenerationState, meetingAgentSpeculationState, publicMeetingAgentGeneration } = require('./meetingMinutesGenerationRuntime');
const optionalReview = require('./meetingMinutesOptionalReview');
const parallelMinutes = require('./meetingMinutesParallel');
const { meetingMinutesAgentText } = require('./meetingMinutesPlainText');
const { completeDiscussionSuggestionText, meetingAgentPublicationContent, stripMinorCommunicationCourtesy } = require('./meetingMinutesPublication');
const { meetingAgentProposalReviewFlagId, mergeMeetingAgentFlags } = require('./meetingMinutesReviewFlags');
const { MEETING_AGENT_MAX_STEP, MEETING_AGENT_STEP_LABELS, meetingAgentStageGeneratedAt } = require('./meetingMinutesStageProtocol');
const { normalizeUnassignedSupportingDetails } = require('./meetingMinutesSupportingDetails');
const { normaliseKnownTermsDeep: normaliseMeetingAgentKnownTermsDeep } = require('./meetingMinutesText');
const { isValidCalendarDate, TIMING_POLICY_VERSION } = require('./meetingMinutesTiming');

function publicMeetingAgentDraft(draft = {}, options = {}) {
  if (parallelMinutes.isParallel(draft)) return parallelMinutes.publicDraft(draft, options);
  draft = meetingAgentWithLegacyDateReview(draft);
  const publication = meetingAgentPublicationContent(draft);
  const { rawTranscript: _rawTranscript, preparedTranscript: _preparedTranscript, salientDetails: _salientDetails, candidateLedger: _candidateLedger, passProvenance: _passProvenance, passCache: _passCache, qualityState: _qualityState, changeHistory, redoHistory, ...publicFields } = draft;
  const visibleDiscussion = publication.discussion;
  const visibleActions = publication.actions;
  const visibleProposal = filterIncompleteProposalChanges(publicFields.pendingProposal, draft.sourceUnits || []);
  const visibleReviewFlags = reconcileMeetingAgentOrphanFlags(
    filingReviewFlags(draft, publication.reviewFlags),
    [...visibleDiscussion, ...visibleActions, ...normalizeUnassignedSupportingDetails(draft.unassignedSupportingDetails), ...optionalReview.entries(draft).map(entry=>entry.record)],
    visibleProposal
  );
  const safe = normaliseMeetingAgentKnownTermsDeep({
    ...publicFields,
    ...publication,
    ...(Array.isArray(draft.unassignedSupportingDetails) ? {
      unassignedSupportingDetails: optionalReview.active(normalizeUnassignedSupportingDetails(draft.unassignedSupportingDetails), draft)
    } : {}),
    discussion: visibleDiscussion,
    actions: visibleActions,
    pendingProposal: visibleProposal,
    reviewFlags: require('../utils/meetingMinutesCoverageEvidence').coverageEvidenceFlags(draft, visibleReviewFlags)
  });
  const generation = meetingAgentGenerationState(safe.generation);
  const completedAt = generation ? meetingAgentStageGeneratedAt(draft, generation.stage) : '';
  // A stale failed/running marker must not outlive a successfully persisted
  // result for the same attempt. This changes presentation state only; it does
  // not start, cancel or repeat any generation work.
  const supersededGeneration = generation && completedAt && generation.startedAt
    && new Date(completedAt).getTime() >= new Date(generation.startedAt).getTime();
  safe.generation = supersededGeneration ? null : publicMeetingAgentGeneration(generation);
  safe.actionsPrewarm = meetingAgentActionsPrewarmState(draft);
  safe.speculation = meetingAgentSpeculationState(draft);
  // When each stage was last run. The tab uses this to tell "run and found
  // nothing" from "not run yet", so a background run that comes back empty is
  // adopted like any other rather than left to surface as a revision conflict.
  safe.generatedStages = {
    discussion: meetingAgentStageGeneratedAt(draft, 'discussion'),
    actions: meetingAgentStageGeneratedAt(draft, 'actions'),
    summary: meetingAgentStageGeneratedAt(draft, 'summary')
  };
  // Degraded-source details remain in private qualityState and telemetry. If a
  // recovery path produced a grounded result and the stage persisted it as a
  // success, reviewers should see that success—not an implementation warning.
  // A stage which cannot produce a validated result is represented separately
  // by generation.status === 'failed' and already receives an actionable error.
  safe.qualityNotice = '';
  safe.stageLabel = MEETING_AGENT_STEP_LABELS[Math.max(0, Math.min(MEETING_AGENT_MAX_STEP, Number(safe.currentStep) || 0))];
  // The client only needs to know whether an undo exists. Shipping up to 30
  // full before/after snapshots on every save was pure weight.
  safe.canRestoreCombinedDiscussion = discussionClaims.canRestore(safe.discussion, draft.sourceUnits,
    draft.qualityState?.discussion?.claimConsolidation) === true;
  safe.canRestorePairedDiscussionActions = safe.canRestoreCombinedDiscussion
    && Boolean(draft.qualityState?.discussion?.claimConsolidation?.separationActionRevisions?.length);
  safe.canRestoreCombinedActions = Boolean(originalEnquiryActions(draft));
  safe.canRestorePhaseActions = safe.canRestoreCombinedActions && draft.qualityState?.actions?.actionPhaseCorrection?.applied === true;
  safe.changeHistoryCount = Array.isArray(changeHistory) ? changeHistory.length : 0;
  // The client only needs to know a redo exists and what it is called.
  const latestRedo = Array.isArray(redoHistory) ? redoHistory[redoHistory.length - 1] : null;
  safe.lastRedo = latestRedo ? { id: latestRedo.id, label: latestRedo.label, createdAt: latestRedo.createdAt } : null;
  const latestUndo = Array.isArray(changeHistory) ? changeHistory[changeHistory.length - 1] : null;
  safe.lastUndo = latestUndo ? {
    id: meetingMinutesAgentText(latestUndo.id, 80),
    label: meetingMinutesAgentText(latestUndo.label || 'Last review decision', 160),
    createdAt: latestUndo.createdAt || latestUndo.acceptedAt || ''
  } : null;
  if (options.summary) {
    return {
      draftId: safe.draftId,
      revision: safe.revision,
      status: safe.status,
      title: safe.details?.meetingTitle || safe.title || 'Meeting minutes',
      fileName: safe.fileName || '',
      currentStep: safe.currentStep || 0,
      stageLabel: safe.stageLabel,
      generation: safe.generation ? {
        stage: safe.generation.stage,
        status: safe.generation.status,
        message: safe.generation.message || '',
        startedAt: safe.generation.startedAt || ''
      } : null,
      openFlagCount: (safe.reviewFlags || []).filter((flag) => flag.status === 'open').length,
      updatedAt: safe.updatedAt,
      createdAt: safe.createdAt,
      resumeUrl: `/meeting-minutes-agent?draftId=${encodeURIComponent(safe.draftId || '')}`
    };
  }
  safe.excludedSupportingDetails = optionalReview.entries(draft);
  safe.filingReview = { ...filingSuggestions(safe), occurrences:optionalReview.keys(safe) };
  return safe;
}

function meetingInsightEvidence(draft = {}, evidenceIds = []) {
  const wanted = new Set((Array.isArray(evidenceIds) ? evidenceIds : []).map(String));
  return (Array.isArray(draft.sourceUnits) ? draft.sourceUnits : [])
    .filter((unit) => wanted.has(String(unit?.id || '')))
    .slice(0, 3)
    .map((unit) => ({
      id: meetingMinutesAgentText(unit?.id, 80),
      speaker: meetingMinutesAgentText(unit?.speaker, 120),
      timestamp: meetingMinutesAgentText(unit?.timestamp, 40),
      text: meetingMinutesAgentText(unit?.text, 700)
    }));
}

function buildMeetingInsights(drafts = [], filters = {}) {
  const entries = [];
  const meetings = [];
  const people = new Set();
  const topics = new Map();
  const addTopic = (value) => {
    const topic = meetingMinutesAgentText(value, 240);
    if (topic) topics.set(topic, (topics.get(topic) || 0) + 1);
    return topic;
  };
  const addPeople = (values) => (Array.isArray(values) ? values : []).map((value) => meetingMinutesAgentText(value, 120)).filter(Boolean).map((value) => {
    people.add(value);
    return value;
  });

  for (const raw of Array.isArray(drafts) ? drafts : []) {
    const draft = publicMeetingAgentDraft(raw);
    const details = draft.details || {};
    const meeting = {
      draftId: String(draft.draftId || ''),
      title: meetingMinutesAgentText(details.meetingTitle || draft.title || 'Meeting minutes', 300),
      date: meetingMinutesAgentText(details.meetingDate || '', 20),
      location: meetingMinutesAgentText(details.meetingLocation || '', 160),
      status: meetingMinutesAgentText(draft.status || 'draft', 30),
      updatedAt: draft.updatedAt || null,
      resumeUrl: `/meeting-minutes-agent?draftId=${encodeURIComponent(draft.draftId || '')}`
    };
    meetings.push(meeting);
    addPeople([...(details.internalAttendees || []), ...(details.clientAttendees || []), ...(details.allAttendees || [])]);
    const evidenceFor = (ids) => meetingInsightEvidence(draft, ids);
    const addEntry = (kind, text, extra = {}) => {
      const cleanText = meetingMinutesAgentText(text, 1800);
      if (!cleanText) return;
      const entryPeople = addPeople(extra.people || []);
      const topic = addTopic(extra.topic || '');
      entries.push({
        id: meetingMinutesAgentText(`${meeting.draftId}-${kind}-${extra.id || entries.length}`, 180),
        kind, text: cleanText, topic, people: entryPeople,
        timing: meetingMinutesAgentText(extra.timing, 240),
        meeting,
        evidence: evidenceFor(extra.evidenceIds),
        needsAttention: Boolean(extra.needsAttention),
        attentionReason: meetingMinutesAgentText(extra.attentionReason, 240)
      });
    };
    for (const topic of Array.isArray(draft.discussion) ? draft.discussion : []) {
      const topicName = topic?.topic || 'Discussion';
      for (const item of Array.isArray(topic?.decisions) ? topic.decisions : []) addEntry('decision', item?.text || item, { id: item?.id, topic: topicName, evidenceIds: item?.evidenceIds });
      for (const item of Array.isArray(topic?.openQuestions) ? topic.openQuestions : []) addEntry('question', item?.text || item, { id: item?.id, topic: topicName, evidenceIds: item?.evidenceIds, needsAttention: true, attentionReason: 'Open question' });
      for (const item of Array.isArray(topic?.points) ? topic.points : []) addEntry('discussion', item?.text || item, { id: item?.id, topic: topicName, evidenceIds: item?.evidenceIds });
    }
    for (const action of Array.isArray(draft.actions) ? draft.actions : []) {
      const owners = Array.isArray(action?.owners) ? action.owners : [];
      const timing = meetingAgentTimingLabel(action?.timing);
      const missingOwner = owners.length === 0;
      const missingTiming = !action?.timing || action.timing.kind === 'not_stated' || (!action.timing.wording && !action.timing.exactDate);
      addEntry('action', action?.action, {
        id: action?.id, people: owners, timing, evidenceIds: action?.evidenceIds,
        needsAttention: missingOwner || missingTiming,
        attentionReason: missingOwner && missingTiming ? 'No owner or date agreed' : missingOwner ? 'No owner agreed' : missingTiming ? 'No date agreed' : ''
      });
    }
  }

  const stats = {
    meetings: meetings.length,
    decisions: entries.filter((entry) => entry.kind === 'decision').length,
    actions: entries.filter((entry) => entry.kind === 'action').length,
    openQuestions: entries.filter((entry) => entry.kind === 'question').length
  };
  const type = ['decision', 'action', 'question', 'discussion'].includes(String(filters.type || '')) ? String(filters.type) : '';
  const person = String(filters.person || '').trim().toLowerCase();
  const topic = String(filters.topic || '').trim().toLowerCase();
  const status = ['draft', 'review', 'complete'].includes(String(filters.status || '').toLowerCase()) ? String(filters.status).toLowerCase() : '';
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(filters.from || '')) ? String(filters.from) : '';
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(filters.to || '')) ? String(filters.to) : '';
  const stopWords = new Set(['what', 'when', 'where', 'which', 'who', 'why', 'how', 'did', 'does', 'have', 'has', 'about', 'from', 'with', 'that', 'this', 'were', 'was', 'the', 'our', 'and', 'for', 'into']);
  const terms = String(filters.q || '').toLowerCase().match(/[a-z0-9][a-z0-9'’-]{1,}/g)?.filter((term) => !stopWords.has(term)) || [];
  const intent = /\b(decid\w*|decis\w*|agree\w*)/i.test(String(filters.q || '')) ? 'decision' : /\b(action\w*|commit\w*|follow[- ]?up|doing|owner\w*)/i.test(String(filters.q || '')) ? 'action' : '';
  const scored = entries.map((entry) => {
    const haystack = [entry.text, entry.topic, entry.meeting.title, entry.meeting.date, entry.meeting.location, entry.people.join(' '), entry.timing].join(' ').toLowerCase();
    const termScore = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
    return { entry, score: termScore + (intent && entry.kind === intent ? 2 : 0) };
  }).filter(({ entry, score }) => {
    if (terms.length && score === 0) return false;
    if (type && entry.kind !== type) return false;
    if (person && !entry.people.some((value) => value.toLowerCase() === person)) return false;
    if (topic && entry.topic.toLowerCase() !== topic) return false;
    if (status && entry.meeting.status !== status) return false;
    if (from && (!entry.meeting.date || entry.meeting.date < from)) return false;
    if (to && (!entry.meeting.date || entry.meeting.date > to)) return false;
    return true;
  }).sort((left, right) => right.score - left.score || String(right.entry.meeting.date || right.entry.meeting.updatedAt || '').localeCompare(String(left.entry.meeting.date || left.entry.meeting.updatedAt || '')));
  const limit = Math.min(Math.max(Number(filters.limit) || 80, 1), 300);
  const offset = Math.min(Math.max(Number(filters.offset) || 0, 0), 100000);
  return {
    stats,
    facets: {
      people: [...people].sort((a, b) => a.localeCompare(b)).slice(0, 200),
      topics: [...topics.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 200).map(([name, count]) => ({ name, count }))
    },
    recentMeetings: meetings.sort((a, b) => String(b.date || b.updatedAt || '').localeCompare(String(a.date || a.updatedAt || ''))).slice(0, 8),
    attention: entries.filter((entry) => entry.needsAttention).slice(0, 12),
    results: scored.slice(offset, offset + limit).map(({ entry }) => entry),
    pagination: { total: scored.length, limit, offset }
  };
}

function meetingAgentProposalFlagMatchesChange(flag = {}, change = {}) {
  if (String(flag.id || '') === meetingAgentProposalReviewFlagId(change)) return true;
  if (flag.kind !== 'possible_missed_follow_up') return false;
  const record = change.after || change.before || {};
  const recordEvidence = new Set(record.evidenceIds || []);
  const sharedEvidence = (flag.evidenceIds || []).some((id) => recordEvidence.has(id));
  const recordText = meetingMinutesAgentText(record.action || record.text || record.topic, 240).toLowerCase();
  const message = meetingMinutesAgentText(flag.message, 500).toLowerCase();
  return sharedEvidence && (!recordText || message.includes(recordText.slice(0, 80)));
}

function isVagueReconstructedAction(value = '') {
  const source = meetingMinutesAgentText(value, 500).toLowerCase().replace(/[.?!]+$/, '').trim();
  // A conversation is only a useful action when the minutes say what it must
  // achieve.  Models otherwise turn social closings ("I'll speak to you next
  // week") and unresolved references into rows such as "Speak with the team
  // as agreed".  Reject the whole contact-only family, including named
  // contacts; an owner or a date does not supply the missing deliverable.
  const contactOpening = /^(?:(?:talk|speak|chat|liaise|meet|check in|touch base|catch up|follow up|reach out|sync(?: up)?)\s+(?:to|with)\b|(?:contact|call|message|phone|ring)\s+(?!a meeting\b|the meeting\b))/i.test(source);
  const contactOnly = contactOpening
    && !/\b(?:about|regarding|concerning|in relation to|to (?:ask|check|clarify|confirm|decide|determine|discuss|establish|find|obtain|request|resolve|review|verify)|so that|in order to)\b/.test(source)
    && !/\band\s+(?:ask|check|clarify|confirm|decide|determine|discuss|document|establish|find|obtain|prepare|provide|request|resolve|review|send|share|update|verify)\b/.test(source);
  const vagueReferences = [
    /\bfollow up\b/, /\bwhat can be done\b/, /\b(?:the|this|that) plan\b/,
    /\bbetter picture\b/, /\b(?:crossover|overlap)\b/, /\bregarding (?:it|this|that)\b/
  ].filter((pattern) => pattern.test(source)).length;
  return contactOnly || circularMetaAction(source)
    || /^(?:plan|address|handle|manage|resolve|sort out|deal with)\s+(?:the\s+)?(?:timeline|situation|issue|matter|arrangements?|logistics?|availability|constraint)(?:\s+(?:around|regarding|for)\s+(?:the\s+)?(?:recorded\s+)?(?:availability\s+)?constraint)?$/.test(source)
    || /^(?:ensure|make sure)\s+(?:that\s+)?(?:everything|things|items)\s+(?:is|are)\s+(?:ready|in place)$/.test(source)
    || vagueReferences >= 3;
}

// Historic metadata must not disappear silently when calendar validation
// blanks an impossible date. Surface it without rewriting the stored draft
// on a read; its original value is retained in private preparation context.
function meetingAgentWithLegacyDateReview(draft = {}) {
  if (parallelMinutes.isParallel(draft)) return draft;
  const value = String(draft.details?.meetingDate || '').trim();
  if (!value || isValidCalendarDate(value) || draft.qualityState?.preparation?.dateContext?.invalid?.length) return draft;
  const dateContext = { meetingDate: '', source: 'legacy_metadata', candidates: [{ source: 'legacy_metadata', date: value }],
    invalid: [{ source: 'legacy_metadata', date: value }], conflict: false, timingPolicyVersion: TIMING_POLICY_VERSION };
  return { ...draft, qualityState: { ...(draft.qualityState || {}), preparation: {
    ...(draft.qualityState?.preparation || {}), dateContext
  } }, reviewFlags: mergeMeetingAgentFlags(draft.reviewFlags || [], [{
    id: 'meeting-date-source-check', kind: 'timing', status: 'open', evidenceIds: [],
    message: 'The saved meeting date is not a valid calendar date. Check the meeting details before using it to calculate dates.'
  }]) };
}

function completeActionSuggestionText(value = '') {
  const source = meetingMinutesAgentText(value, 1600).trim();
  const words = source.match(/[\p{L}\p{N}][\p{L}\p{N}'’/-]*/gu) || [];
  if (words.length < 2 || !isClientReadyActionWording(source)
    || isVagueReconstructedAction(source) || /[:;]\s*$/.test(source)) return false;
  // These are noun headings beginning with a word that can also be an
  // imperative ("Review of controls", "Update on testing"). A determiner or
  // direct object after the verb remains valid: "Review the controls".
  if (/^(?:review|update|summary|overview|discussion|status|progress)\s+(?:of|on|for)\b/i.test(source)) return false;
  const objectWords = words.slice(1).map((word) => word.toLowerCase());
  const placeholders = new Set(['it', 'this', 'that', 'them', 'thing', 'things', 'something', 'someone', 'somebody', 'person', 'people', 'relevant']);
  return objectWords.some((word) => !placeholders.has(word));
}

function cleanDiscussionProposalTopic(topic = {}) {
  if (!topic || typeof topic !== 'object') return null;
  const clean = { ...topic };
  for (const kind of ['points', 'decisions', 'openQuestions']) {
    clean[kind] = (Array.isArray(topic[kind]) ? topic[kind] : []).filter((record) =>
      completeDiscussionSuggestionText(record?.text || record));
  }
  const hasRows = clean.points.length || clean.decisions.length || clean.openQuestions.length;
  if (!hasRows || !isPublishableTopicLabel(clean.topic || '')) return null;
  return clean;
}

// One final proposal boundary is shared by normal generation, regeneration,
// explicit AI edits, completeness audits and legacy drafts loaded from disk.
// Removal suggestions remain visible; additions and edits must contain a
// complete record rather than a heading, label or dangling phrase.
function filterIncompleteProposalChanges(proposal = null, sourceUnits = []) {
  if (!proposal || !Array.isArray(proposal.changes)) return proposal;
  const stage = proposal.stage === 'discussion' ? 'discussion' : 'actions';
  const changes = [];
  for (const change of proposal.changes) {
    if (change?.type === 'remove') { changes.push(change); continue; }
    if (!change?.after) continue;
    if (stage === 'actions') {
      const after = stripMinorCommunicationCourtesy(change.after, sourceUnits);
      if (after && completeActionSuggestionText(after.action)) changes.push({ ...change, after });
      continue;
    }
    const after = change.after?.topic
      ? cleanDiscussionProposalTopic(change.after)
      : completeDiscussionSuggestionText(change.after?.text) ? change.after : null;
    if (after) changes.push({ ...change, after });
  }
  return changes.length ? { ...proposal, changes } : null;
}

function meetingAgentReferencedFlagIds(records = []) {
  const ids = new Set();
  const walk = (value) => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== 'object') return;
    for (const id of Array.isArray(value.reviewFlagIds) ? value.reviewFlagIds : []) ids.add(String(id));
    for (const key of ['points', 'decisions', 'openQuestions', 'supportingDetails']) if (Array.isArray(value[key])) walk(value[key]);
  };
  walk(records);
  return ids;
}

function meetingAgentReviewRecords(records = []) {
  const found = [];
  const walk = (value, type = '') => {
    if (Array.isArray(value)) { value.forEach((item) => walk(item, type)); return; }
    if (!value || typeof value !== 'object') return;
    if (value.action || value.text) found.push({ value, type: value.action ? 'action' : type || 'discussion' });
    for (const key of ['points', 'decisions', 'openQuestions', 'supportingDetails']) {
      if (Array.isArray(value[key])) walk(value[key], key === 'supportingDetails' ? 'supporting' : 'discussion');
    }
  };
  walk(records);
  return found;
}

function meetingAgentFlagLikelyHasCurrentTarget(flag = {}, records = []) {
  const flagId = String(flag.id || '');
  const message = meetingMinutesAgentText(flag.message, 500).toLowerCase();
  const evidence = new Set(Array.isArray(flag.evidenceIds) ? flag.evidenceIds : []);
  const candidates = meetingAgentReviewRecords(records).filter(({ value, type }) => {
    if ((value.reviewFlagIds || []).map(String).includes(flagId)) return true;
    if (['ownership', 'timing', 'possible_missed_follow_up'].includes(flag.kind) && type !== 'action') return false;
    const valueText = meetingMinutesAgentText(value.action || value.text, 1600).toLowerCase();
    const wording = meetingMinutesAgentText(value.timing?.wording, 220).toLowerCase();
    const exactDate = meetingMinutesAgentText(value.timing?.exactDate, 40).toLowerCase();
    const owners = Array.isArray(value.owners) ? value.owners : [];
    const explicitlyNamed = (valueText.length >= 12 && message.includes(valueText.slice(0, 90)))
      || (wording && message.includes(wording))
      || (exactDate && message.includes(exactDate))
      || owners.some((owner) => message.includes(meetingMinutesAgentText(owner, 180).toLowerCase()));
    const sharesEvidence = (value.evidenceIds || []).some((id) => evidence.has(id));
    return explicitlyNamed || sharesEvidence;
  });
  if (!candidates.length) return false;
  if (candidates.some(({ value }) => (value.reviewFlagIds || []).map(String).includes(flagId))) return true;
  const named = candidates.filter(({ value }) => {
    const valueText = meetingMinutesAgentText(value.action || value.text, 1600).toLowerCase();
    const wording = meetingMinutesAgentText(value.timing?.wording, 220).toLowerCase();
    const exactDate = meetingMinutesAgentText(value.timing?.exactDate, 40).toLowerCase();
    return (valueText.length >= 12 && message.includes(valueText.slice(0, 90)))
      || (wording && message.includes(wording)) || (exactDate && message.includes(exactDate));
  });
  return named.length === 1 || (named.length === 0 && candidates.length === 1);
}

const MEETING_AGENT_PROPOSAL_REMOVED_NOTE = 'The related suggestion is no longer available.';

const MEETING_AGENT_ITEM_SCOPED_FLAG_KINDS = new Set(['missing_evidence', 'ownership', 'attribution', 'timing']);

// Keep the review queue aligned with what can actually be reviewed. A warning
// follows a surviving saved item or pending suggestion; if its only target was
// removed, the warning closes automatically and remains closed after reload.
// Broader issues such as unresolved decisions and possible follow-ups remain
// open when they have no item, because their purpose is to ask the reviewer to
// add or clarify missing content.
function reconcileMeetingAgentOrphanFlags(flags = [], records = [], proposal = null, previousRecords = []) {
  const currentReferences = meetingAgentReferencedFlagIds(records);
  const previousReferences = meetingAgentReferencedFlagIds(previousRecords);
  const changes = Array.isArray(proposal?.changes) ? proposal.changes : [];
  return (Array.isArray(flags) ? flags : []).map((flag) => {
    if ((flag.status || 'open') !== 'open') return flag;
    const id = String(flag.id || '');
    // Meeting metadata belongs to Details, independently of action rows.
    if (id === 'meeting-date-source-check') return flag;
    // These warnings concern a whole field or a source step which may have
    // no action row yet. Absence of an action is not evidence of resolution.
    if (['executiveSummary', 'meetingObjectives', 'timedStepCoverage'].includes(flag.temporalField)) return flag;
    const hasProposal = changes.some((change) => meetingAgentProposalFlagMatchesChange(flag, change));
    if (currentReferences.has(id) || hasProposal || meetingAgentFlagLikelyHasCurrentTarget(flag, records)) return flag;
    const lostSavedTarget = previousReferences.has(id);
    const lostProposal = /^proposal-review-/i.test(id);
    if (!lostSavedTarget && !lostProposal && !MEETING_AGENT_ITEM_SCOPED_FLAG_KINDS.has(flag.kind)) return flag;
    return {
      ...flag,
      status: 'dismissed',
      correctionNote: flag.correctionNote || (lostProposal ? MEETING_AGENT_PROPOSAL_REMOVED_NOTE : MEETING_AGENT_ITEM_REMOVED_NOTE)
    };
  });
}

// A flag dismissed only because its item was deleted reopens when an item
// pointing at it comes back (the reviewer re-adds the same unsupported text).
const MEETING_AGENT_ITEM_REMOVED_NOTE = 'The item was removed.';

module.exports = {
  MEETING_AGENT_ITEM_REMOVED_NOTE,
  MEETING_AGENT_ITEM_SCOPED_FLAG_KINDS,
  MEETING_AGENT_PROPOSAL_REMOVED_NOTE,
  buildMeetingInsights,
  cleanDiscussionProposalTopic,
  completeActionSuggestionText,
  filterIncompleteProposalChanges,
  isVagueReconstructedAction,
  meetingAgentFlagLikelyHasCurrentTarget,
  meetingAgentProposalFlagMatchesChange,
  meetingAgentReferencedFlagIds,
  meetingAgentReviewRecords,
  meetingAgentWithLegacyDateReview,
  meetingInsightEvidence,
  publicMeetingAgentDraft,
  reconcileMeetingAgentOrphanFlags
};
