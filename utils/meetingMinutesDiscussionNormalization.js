'use strict';

const { text } = require('./meetingMinutesText');
const { stableId, tokenOverlap } = require('./meetingMinutesRecordMatching');
const { resolveEvidence } = require('./meetingMinutesEvidenceResolution');
const { evidenceContextFor, comparisonText } = require('./meetingMinutesEvidenceContext');
const { correctnessChecksEnabled, uncitedClaimSupported } = require('./meetingMinutesEvidenceChecks');
const {
  reviewerProvenance, reviewerMergeHistory, reviewerFilingProvenance
} = require('./meetingMinutesReviewerEdits');
const { isActionCategoryTopicCard } = require('./canonicalMinutes/topicEditorial');

function normalisePoint(value, units, prefix, index, options = {}) {
  const candidate = typeof value === 'string' ? { text: value } : (value || {});
  // A reviewer may promote complete retained context into the minutes. Keep
  // their full wording at the save boundary, as for filed supporting details.
  const pointText = options.preserveReviewerEdits === true && candidate.reviewerAuthored === true
    ? String(candidate.text || candidate.point || candidate.value || '').trim()
    : text(candidate.text || candidate.point || candidate.value, 1600);
  if (!pointText) return null;
  const pointId = text(candidate.id, 80) || stableId(prefix, pointText, index);
  const suppliedIds = (Array.isArray(candidate.evidenceIds) ? candidate.evidenceIds : []).map((id) => text(id, 30)).filter(Boolean);
  const resolved = resolveEvidence(pointText, units, candidate.evidenceIds, { meetingDate: options.meetingDate, preserveDiscussionEvidence: true });
  if (options.preserveReviewerEdits === true && candidate.reviewerAuthored === true && candidate.filingOrigins?.length) {
    const validSuppliedIds = [...new Set(suppliedIds.filter(id => evidenceContextFor(units).known.has(id)))];
    if (validSuppliedIds.length) resolved.evidenceIds = validSuppliedIds;
  }
  if (correctnessChecksEnabled() && !suppliedIds.some((id) => evidenceContextFor(units).known.has(id))
    && resolved.evidenceIds.length && !uncitedClaimSupported(pointText, resolved, units)) {
    resolved.evidenceIds = [];
  }
  const supportingDetails = (Array.isArray(candidate.supportingDetails) ? candidate.supportingDetails : [])
    .map((detail, detailIndex) => {
      const source = typeof detail === 'string' ? { text: detail } : (detail || {});
      // Filing retained context is a reviewer operation. Do not truncate a
      // complete review-only detail when it is moved under a chosen point.
      const detailText = options.preserveReviewerEdits === true && source.reviewerAuthored === true
        ? String(source.text || source.point || source.value || '').trim()
        : text(source.text || source.point || source.value, 1600);
      if (!detailText) return null;
      const detailEvidence = resolveEvidence(detailText, units, source.evidenceIds, { meetingDate: options.meetingDate });
      if (options.preserveReviewerEdits === true && source.reviewerAuthored === true) {
        const validSuppliedIds = [...new Set((Array.isArray(source.evidenceIds) ? source.evidenceIds : [])
          .map(id => text(id, 30)).filter(id => evidenceContextFor(units).known.has(id)))];
        if (validSuppliedIds.length) detailEvidence.evidenceIds = validSuppliedIds;
      }
      const detailFlags = [...new Set((Array.isArray(source.reviewFlagIds) ? source.reviewFlagIds : []).map((id) => text(id, 80)).filter(Boolean))];
      const detailId = text(source.id, 80) || stableId(`${prefix}-supporting`, detailText, detailIndex);
      return {
        id: detailId,
        ...reviewerProvenance(source, options),
        ...reviewerMergeHistory(source, 'mergedFromIds', detailId, options),
        ...reviewerFilingProvenance(source, options),
        ...(typeof source.originalTopic === 'string' && text(source.originalTopic, 220)
          ? { originalTopic: text(source.originalTopic, 220) } : {}),
        ...(source.placementStatus === 'unresolved' ? {
          placementStatus: 'unresolved', placementReason: text(source.placementReason, 100)
        } : {}),
        text: detailText,
        evidenceIds: detailEvidence.evidenceIds,
        // A context line keeps its flag, so the flag can point at it.
        ...(detailFlags.length ? { reviewFlagIds: detailFlags } : {})
      };
    }).filter(Boolean).slice(0, options.preserveReviewerEdits === true ? undefined : 50);
  return {
    id: pointId,
    ...reviewerProvenance(candidate, options),
    ...reviewerMergeHistory(candidate, 'mergedFromIds', pointId, options),
    ...reviewerFilingProvenance(candidate, options),
    ...(typeof candidate.originalTopic === 'string' && text(candidate.originalTopic, 220)
      ? { originalTopic: text(candidate.originalTopic, 220) } : {}),
    text: pointText,
    ...(['core', 'supporting', 'reject'].includes(candidate.discoveryDisposition)
      ? { discoveryDisposition: candidate.discoveryDisposition } : {}),
    evidenceIds: resolved.evidenceIds,
    ...(Array.isArray(candidate.primaryEvidenceIds) ? {
      primaryEvidenceIds: [...new Set(candidate.primaryEvidenceIds)]
        .filter((id) => evidenceContextFor(units).known.has(id)).slice(0, 12)
    } : {}),
    supportingDetails,
    reviewFlagIds: [...new Set((Array.isArray(candidate.reviewFlagIds) ? candidate.reviewFlagIds : []).map((id) => text(id, 80)).filter(Boolean))],
    _unsupportedEvidenceIds: resolved.invalidIds,
    _weakEvidenceIds: resolved.weakIds
  };
}

function normalisePointList(values, units, prefix, options = {}) {
  return (Array.isArray(values) ? values : []).map((value, index) => normalisePoint(value, units, prefix, index, options))
    .filter(Boolean).slice(0, options.preserveReviewerEdits === true ? undefined : 50);
}

function recordSimilarity(left, right) {
  const numbers = (value) => new Set(String(value || '').match(/\b\d+(?:[.,]\d+)?%?\b/g) || []);
  const leftNumbers = numbers(left?.text); const rightNumbers = numbers(right?.text);
  if (leftNumbers.size && rightNumbers.size
    && ![...leftNumbers].some((value) => rightNumbers.has(value))) return 0;
  const lexical = tokenOverlap(comparisonText(left?.text || ''), comparisonText(right?.text || ''));
  const leftEvidence = new Set(left?.evidenceIds || []);
  const sharedEvidence = (right?.evidenceIds || []).some((id) => leftEvidence.has(id));
  return lexical + (sharedEvidence ? 0.12 : 0);
}

// Merging generated wording must not discard the other row's source anchors or
// review links. Primary anchors count only when that row's evidence resolution
// retained them. Preserve the original first-eight citation order because the
// subsequent similarity checks also use citation overlap. Reprioritising that
// budget here would change later merge decisions. Selection/ranking stays with
// the original winner, including its wording, id and discovery disposition.
function mergeDiscussionSourceMetadata(winner, other) {
  const evidenceIds = [...new Set([...(winner.evidenceIds || []), ...(other.evidenceIds || [])])];
  const primaryIds = [...new Set([winner, other].flatMap(row =>
    (row.primaryEvidenceIds || []).filter(id => (row.evidenceIds || []).includes(id))))];
  winner.evidenceIds = evidenceIds.slice(0, 8);
  if (Array.isArray(winner.primaryEvidenceIds) || Array.isArray(other.primaryEvidenceIds)) {
    winner.primaryEvidenceIds = primaryIds.filter(id => winner.evidenceIds.includes(id));
  }
  for (const field of ['reviewFlagIds', '_unsupportedEvidenceIds', '_weakEvidenceIds']) {
    if (Array.isArray(winner[field]) || Array.isArray(other[field])) {
      winner[field] = [...new Set([...(winner[field] || []), ...(other[field] || [])])];
    }
  }
}

function dedupePointList(values = [], options = {}) {
  const coreIds = new Set(Array.isArray(options.authoritativeCoreIds) ? options.authoritativeCoreIds : []);
  const numbers = row => String(row?.text || '').match(/\b\d+(?:[.,]\d+)?%?\b/g) || [];
  const kept = [];
  for (const value of values) {
    const duplicate = kept.find((existing) => !(coreIds.has(existing.id) && coreIds.has(value.id)
      && JSON.stringify(numbers(existing)) !== JSON.stringify(numbers(value)))
      && recordSimilarity(existing, value) >= 0.86);
    if (!duplicate) kept.push(value);
    else {
      mergeDiscussionSourceMetadata(duplicate, value);
      const details = [...(duplicate.supportingDetails || []), ...(value.supportingDetails || [])];
      const keptDetails = [];
      for (const detail of details) {
        const existing = keptDetails.find(other => comparisonText(other.text) === comparisonText(detail.text));
        if (existing) mergeDiscussionSourceMetadata(existing, detail);
        else keptDetails.push(detail);
      }
      duplicate.supportingDetails = keptDetails.slice(0, 50);
    }
  }
  return kept;
}

function discussionTopicItems(candidate = {}) {
  return (Array.isArray(candidate.discussion) ? candidate.discussion : []).map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const hasTopicArrays = ['points', 'decisions', 'openQuestions'].some((key) => Array.isArray(item[key]));
    if (hasTopicArrays) return item;

    // Some Copilot topic versions have returned valid, grounded records in a
    // flat discussion array even though the schema asks for topic containers.
    // Preserve that evidence rather than turning a shape error into an empty
    // draft. Only explicit record labels/text prefixes affect the record type;
    // otherwise the safe default is an ordinary discussion point.
    const recordText = text(item.text || item.point || item.value, 1600);
    if (!recordText) return item;
    const suppliedType = text(item.recordType || item.type || item.kind, 80).toLowerCase().replace(/[\s-]+/g, '_');
    const isDecision = suppliedType === 'decision' || /^decision\s*[:—-]/i.test(recordText);
    const isQuestion = ['open_question', 'openquestion', 'question'].includes(suppliedType)
      || /^open\s+question\s*[:—-]/i.test(recordText);
    const cleanedText = recordText.replace(isDecision
      ? /^decision\s*[:—-]\s*/i
      : isQuestion ? /^open\s+question\s*[:—-]\s*/i : /$^/, '');
    const record = { ...item, text: cleanedText };
    return {
      id: item.topicId,
      topic: text(item.topic || item.category || item.subject, 220) || 'Discussion',
      points: isDecision || isQuestion ? [] : [record],
      decisions: isDecision ? [record] : [],
      openQuestions: isQuestion ? [record] : []
    };
  });
}

function normaliseDiscussion(candidate = {}, units = [], options = {}) {
  const reviewerSave = options.preserveReviewerEdits === true;
  const normaliseRows = (rows, prefix) => {
    const normalised = normalisePointList(rows, units, prefix, options);
    return reviewerSave ? normalised : dedupePointList(normalised, options);
  };
  const topics = discussionTopicItems(candidate).slice(0, reviewerSave ? undefined : 80).map((item, index) => {
    const topic = text(item?.topic, 220) || 'Discussion';
    const topicId = text(item?.id, 80) || stableId('topic', topic, index);
    return {
      id: topicId,
      ...reviewerProvenance(item, options),
      ...reviewerMergeHistory(item, 'mergedTopicIds', topicId, options),
      topic,
      // The reviewer's choice to leave this title out of the minutes.
      ...(item?.hideHeading === true ? { hideHeading: true } : {}),
      points: normaliseRows(item?.points, `point-${index}`),
      decisions: normaliseRows(item?.decisions, `decision-${index}`),
      openQuestions: normaliseRows(item?.openQuestions, `question-${index}`)
    };
  }).filter((item) => item.points.length || item.decisions.length || item.openQuestions.length);
  // Saving the editor is not a fresh selection pass. Preserve the reviewer's
  // rows and classifications, even when two rows resemble one another or a
  // heading uses an output category. Generated content still uses the gates below.
  if (reviewerSave) return topics;
  const merged = [];
  for (const topic of topics) {
    // A reviewer's save keeps their topics as they arranged them: two cards
    // both still called "New topic", or "Project" beside "Project timeline",
    // are separate topics until the reviewer merges them.
    const existing = options.mergeTopics === false ? null
      : merged.find((item) => tokenOverlap(comparisonText(item.topic), comparisonText(topic.topic)) >= 0.82);
    if (!existing) { merged.push(topic); continue; }
    existing.points = dedupePointList([...existing.points, ...topic.points], options);
    existing.decisions = dedupePointList([...existing.decisions, ...topic.decisions], options);
    existing.openQuestions = dedupePointList([...existing.openQuestions, ...topic.openQuestions], options);
  }
  // A high-confidence decision should not also be shown as an unresolved
  // question or ordinary point. Prefer the more useful record type.
  for (const topic of merged) {
    topic.points = topic.points.filter((point) => !topic.decisions.some((decision) => recordSimilarity(point, decision) >= 0.92));
    topic.openQuestions = topic.openQuestions.filter((question) => !topic.decisions.some((decision) => recordSimilarity(question, decision) >= 0.92));
  }
  // Action buckets are output categories, not discussion subjects. Remove a generated
  // action-only bucket at the normalisation boundary so it cannot leak into the saved
  // draft or exported minutes. Mixed cards remain intact: factual discussion is more
  // important than a coarse heading and must not be thrown away with the actions.
  return merged.filter((topic) => !isActionCategoryTopicCard(topic));
}

module.exports = { normaliseDiscussion, normalisePointList };
