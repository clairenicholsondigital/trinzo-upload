'use strict';

const { firstString } = require('./meetingMinutesPlainText');

function stagedAnalyticsObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stagedAnalyticsArray(value) {
  return Array.isArray(value) ? value : [];
}

function stagedAnalyticsText(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(stagedAnalyticsText).filter(Boolean).join('\n');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).replace(/\s+/g, ' ').trim();
}

function stagedAnalyticsWords(value) {
  return stagedAnalyticsText(value).toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2);
}

function stagedAnalyticsSimilarity(left, right) {
  const leftWords = new Set(stagedAnalyticsWords(left));
  const rightWords = new Set(stagedAnalyticsWords(right));
  if (!leftWords.size && !rightWords.size) return 1;
  if (!leftWords.size || !rightWords.size) return 0;
  const overlap = [...leftWords].filter((word) => rightWords.has(word)).length;
  return overlap / Math.max(leftWords.size, rightWords.size);
}

function stagedReviewField(stage, fieldPath, label, value) {
  return {
    stage,
    fieldPath,
    label,
    value: stagedAnalyticsText(value)
  };
}

function flattenStagedReviewVersion(versions = {}) {
  const fields = [];
  const details = stagedAnalyticsObject(versions.details);
  fields.push(stagedReviewField('details', 'details.meetingTitle', 'Meeting title', details.meetingTitle));
  fields.push(stagedReviewField('details', 'details.meetingDate', 'Meeting date', details.meetingDate));
  fields.push(stagedReviewField('details', 'details.meetingLocation', 'Meeting location', details.meetingLocation));
  fields.push(stagedReviewField('details', 'details.meetingType', 'Meeting type', details.meetingType));
  fields.push(stagedReviewField('details', 'details.internalAttendees', 'Trinzo participants', details.internalAttendees || details.trinzoAttendees));
  fields.push(stagedReviewField('details', 'details.clientAttendees', 'Client participants', details.clientAttendees || details.allAttendees));

  const summary = stagedAnalyticsObject(versions.summary);
  // The purpose and the key facts steer more of the later stages than anything else the
  // reviewer touches, and until now neither was recorded — so the edit analytics were
  // blind to the two fields most worth knowing about.
  fields.push(stagedReviewField('summary', 'summary.meetingPurpose', 'Meeting purpose', summary.meetingPurpose));
  fields.push(stagedReviewField('summary', 'summary.keyFacts', 'Key facts to preserve', summary.keyFacts));
  fields.push(stagedReviewField('summary', 'summary.objectives', 'Meeting objectives', summary.objectives));
  fields.push(stagedReviewField('summary', 'summary.executiveSummary', 'Executive summary', summary.executiveSummary));
  fields.push(stagedReviewField('summary', 'summary.overallTopics', 'Overall topics', summary.overallTopics));

  stagedAnalyticsArray(versions.discussion).forEach((item, index) => {
    fields.push(stagedReviewField('discussion', `discussion.${index}.topic`, `Discussion ${index + 1} topic`, item?.topic));
    fields.push(stagedReviewField('discussion', `discussion.${index}.points`, `Discussion ${index + 1} points`, item?.points || item?.bullets || item?.discussionPoints));
  });

  stagedAnalyticsArray(versions.actions).forEach((item, index) => {
    fields.push(stagedReviewField('actions', `actions.${index}.owner`, `Action ${index + 1} owner`, item?.owner));
    fields.push(stagedReviewField('actions', `actions.${index}.action`, `Action ${index + 1}`, item?.action || item?.meetingActionPoint));
    fields.push(stagedReviewField('actions', `actions.${index}.deadline`, `Action ${index + 1} due`, item?.deadline || item?.meetingActionPointDeadline));
  });

  return fields.filter((field) => field.value);
}

function classifyStagedReviewEdit(before, after) {
  if (!before && after) return 'added_by_reviewer';
  if (before && !after) return 'removed_by_reviewer';
  if (before === after) return 'accepted_unchanged';
  const similarity = stagedAnalyticsSimilarity(before, after);
  if (similarity >= 0.82) return 'wording_or_formatting_edit';
  if (similarity >= 0.45) return 'substantive_rewrite';
  return 'structural_or_semantic_change';
}

function buildStagedReviewDiffs(generatedVersions = {}, approvedVersions = {}) {
  const generated = flattenStagedReviewVersion(generatedVersions);
  const approved = flattenStagedReviewVersion(approvedVersions);
  const generatedByPath = new Map(generated.map((field) => [field.fieldPath, field]));
  const approvedByPath = new Map(approved.map((field) => [field.fieldPath, field]));
  const paths = [...new Set([...generatedByPath.keys(), ...approvedByPath.keys()])].sort();
  return paths.map((fieldPath) => {
    const before = generatedByPath.get(fieldPath);
    const after = approvedByPath.get(fieldPath);
    const beforeText = before ? before.value : '';
    const afterText = after ? after.value : '';
    const editType = classifyStagedReviewEdit(beforeText, afterText);
    return {
      stage: (after || before)?.stage || '',
      fieldPath,
      label: (after || before)?.label || fieldPath,
      editType,
      before: beforeText,
      after: afterText,
      beforeLength: beforeText.length,
      afterLength: afterText.length,
      similarity: Number(stagedAnalyticsSimilarity(beforeText, afterText).toFixed(3))
    };
  });
}

function summariseStagedReviewDiffs(fieldDiffs = []) {
  const byType = {};
  const byStage = {};
  fieldDiffs.forEach((diff) => {
    byType[diff.editType] = (byType[diff.editType] || 0) + 1;
    const stage = diff.stage || 'unknown';
    byStage[stage] = byStage[stage] || {};
    byStage[stage][diff.editType] = (byStage[stage][diff.editType] || 0) + 1;
  });
  return {
    totalFields: fieldDiffs.length,
    changedFields: fieldDiffs.filter((diff) => diff.editType !== 'accepted_unchanged').length,
    byType,
    byStage,
    recurringProblemCandidates: fieldDiffs
      .filter((diff) => ['substantive_rewrite', 'structural_or_semantic_change', 'removed_by_reviewer'].includes(diff.editType))
      .map((diff) => ({ stage: diff.stage, fieldPath: diff.fieldPath, editType: diff.editType, label: diff.label }))
  };
}

function stagedWorkflowInteractionEvents(events = []) {
  return stagedAnalyticsArray(events).slice(-250).map((event) => ({
    id: firstString(event?.id).slice(0, 120),
    type: firstString(event?.type).slice(0, 120),
    at: firstString(event?.at).slice(0, 80),
    stage: firstString(event?.stage).slice(0, 100),
    activeScreen: Number.isFinite(Number(event?.activeScreen)) ? Number(event.activeScreen) : null,
    source: firstString(event?.source).slice(0, 120),
    details: stagedAnalyticsObject(event?.details)
  })).filter((event) => event.type);
}

function summariseStagedWorkflowInteractions(events = []) {
  const byType = {};
  const byStage = {};
  events.forEach((event) => {
    byType[event.type] = (byType[event.type] || 0) + 1;
    const stage = event.stage || 'unknown';
    byStage[stage] = byStage[stage] || {};
    byStage[stage][event.type] = (byStage[stage][event.type] || 0) + 1;
  });
  return {
    totalEvents: events.length,
    byType,
    byStage,
    stageTransitionCount: events.filter((event) => ['stage_entered', 'stage_left', 'stage_revisited'].includes(event.type)).length,
    candidateDecisionCount: events.filter((event) => ['action_candidate_accepted', 'action_candidate_dismissed'].includes(event.type)).length,
    manualActionEventCount: events.filter((event) => /^manual_action_|^action_row_/.test(event.type)).length,
    ownerCorrectionCount: events.filter((event) => event.type === 'action_owner_changed').length,
    pdfEventCount: events.filter((event) => /^pdf_/.test(event.type)).length,
    resumeCount: events.filter((event) => event.type === 'draft_resumed').length,
    errorEventCount: events.filter((event) => /(?:failed|error|retry|timeout)/.test(event.type)).length,
    abandonmentSignalCount: events.filter((event) => event.type === 'workflow_abandonment_signal').length
  };
}

function stagedReviewProjectKey(details = {}, draftId = '') {
  return firstString(
    details.projectKey,
    details.projectName,
    details.meetingTitle,
    draftId,
    'unscoped'
  ).slice(0, 500);
}

module.exports = { stagedAnalyticsObject, stagedAnalyticsArray, stagedAnalyticsText, buildStagedReviewDiffs, summariseStagedReviewDiffs, stagedWorkflowInteractionEvents, summariseStagedWorkflowInteractions, stagedReviewProjectKey };
