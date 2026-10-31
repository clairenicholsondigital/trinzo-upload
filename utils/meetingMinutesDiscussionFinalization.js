'use strict';

const { flattenHybridDiscussion } = require('./meetingMinutesDiscussionRows');
const { meetingMinutesAgentText } = require('./meetingMinutesPlainText');
const { hybridTokenOverlap } = require('./meetingMinutesRecordMatching');
const { regroupDiscussionBySegments } = require('./canonicalMinutes/discourseSegments');
const {
  organiseDiscussionForReview, removePersonalAsides, finaliseDiscussionForPublication
} = require('./canonicalMinutes/discussionOrganiser');
const { shapeDiscussion, dedupeDiscussionBody } = require('./discussionShape');
const { discussionInformationTokens } = require('./meetingMinutesRefereeCandidates');
const { isReviewerAuthored } = require('./canonicalMinutes/state');
const { isRawTranscriptDiscussionPoint } = require('./stagedEditorial');
const { numericActionEditIssue } = require('./meetingMinutesActionNumericPreservation');
const { temporalClaim, temporalMeaningRetained } = require('./meetingMinutesTemporalReview');

// Reversible experiment: make every surviving additional detail a normal
// discussion point. The source parent is recorded so a later rollback can
// mechanically put these rows back without regenerating or guessing. Existing
// publication, evidence, fragment and administration safeguards still run.
function promoteAllDiscussionDetails(discussion = []) {
  const result = (Array.isArray(discussion) ? discussion : []).map((topic) => ({
    ...topic,
    points: (topic.points || []).map((record) => ({ ...record, supportingDetails: [...(record.supportingDetails || [])] })),
    decisions: (topic.decisions || []).map((record) => ({ ...record, supportingDetails: [...(record.supportingDetails || [])] })),
    openQuestions: (topic.openQuestions || []).map((record) => ({ ...record, supportingDetails: [...(record.supportingDetails || [])] }))
  }));
  const visible = result.flatMap((topic) => ['points', 'decisions', 'openQuestions']
    .flatMap((kind) => topic[kind] || []));
  let promoted = 0;
  for (const topic of result) {
    const additions = [];
    for (const kind of ['points', 'decisions', 'openQuestions']) {
      for (const record of topic[kind] || []) {
        for (const detail of record.supportingDetails || []) {
          const text = meetingMinutesAgentText(detail?.text, 1600);
          if (!text || !(detail.evidenceIds || []).length) continue;
          // Include-all exposes useful context, not transcript turns or a
          // second wording of a fact already visible elsewhere in the draft.
          // Reviewer-authored wording remains untouched by these generated-
          // content safeguards.
          const generated = !isReviewerAuthored(detail);
          if (generated && (isRawTranscriptDiscussionPoint(text)
            || !supportingDetailAddsInformation(detail, visible, record))) continue;
          const promotedDetail = {
            ...detail,
            id: detail.id || `included-detail-${record.id || 'row'}-${promoted + 1}`,
            text,
            evidenceIds: [...new Set(detail.evidenceIds || [])].slice(0, 8),
            supportingDetails: [],
            simulationSource: 'supporting_detail',
            simulationParentId: record.id || ''
          };
          additions.push(promotedDetail);
          visible.push(promotedDetail);
          promoted += 1;
        }
        record.supportingDetails = [];
      }
    }
    if (additions.length) topic.points.push(...additions);
  }
  return { discussion: result, promoted };
}

function discussionStructureDiagnostics(discussion = [], options = {}) {
  const oversizedPointCount = Math.max(6, Number(options.oversizedPointCount || 8));
  const singletonSimilarity = Math.min(1, Math.max(0.4, Number(options.singletonSimilarity || 0.55)));
  const topics = (Array.isArray(discussion) ? discussion : []).map((topic, index) => {
    const rows = flattenHybridDiscussion([topic]);
    return {
      index,
      topic: meetingMinutesAgentText(topic?.topic || 'Discussion', 240),
      body: rows.map((item) => meetingMinutesAgentText(item.record?.text, 500)).filter(Boolean).join(' '),
      pointCount: rows.length
    };
  });
  const oversizedSections = topics.filter((topic) => topic.pointCount >= oversizedPointCount)
    .map(({ body, ...topic }) => topic);
  const suspiciousSingletons = [];
  for (const topic of topics.filter((item) => item.pointCount === 1)) {
    const nearest = topics.filter((candidate) => candidate.index !== topic.index)
      .map((candidate) => ({
        topic: candidate.topic,
        // Heading-only comparison missed fragments whose generated title was
        // unhelpful.  Compare the singleton proposition with the neighbour's
        // heading and body as well; diagnostics remain read-only.
        similarity: Math.max(
          hybridTokenOverlap(topic.topic, candidate.topic),
          hybridTokenOverlap(topic.body, `${candidate.topic} ${candidate.body}`),
          hybridTokenOverlap(`${topic.topic} ${topic.body}`, `${candidate.topic} ${candidate.body}`)
        )
      }))
      .sort((left, right) => right.similarity - left.similarity)[0];
    if (nearest && nearest.similarity >= singletonSimilarity) {
      suspiciousSingletons.push({
        topic: topic.topic,
        possibleNeighbour: nearest.topic,
        similarity: Number(nearest.similarity.toFixed(2))
      });
    }
  }
  return {
    topicCount: topics.length,
    visiblePointCount: topics.reduce((sum, topic) => sum + topic.pointCount, 0),
    oversizedSections,
    suspiciousSingletons
  };
}

async function finalisePromotedDiscussion(discussion = [], options = {}) {
  let result = Array.isArray(discussion) ? discussion : [];
  let moved = 0;
  let organiser = null;
  const topicLabels = Array.isArray(options.topicLabels) ? options.topicLabels : [];
  if (topicLabels.some(Boolean)) {
    const refiled = regroupDiscussionBySegments(
      result,
      options.sourceUnits || [],
      options.topicSegments || [],
      topicLabels
    );
    result = refiled.discussion;
    moved = refiled.moved;
  }
  if (options.organise === true) {
    organiser = await organiseDiscussionForReview(result, options.sourceUnits || [], {
      // A second pass sees the finished body. Keep its merge bar deliberately
      // conservative: rows may move only between near-equivalent labels, and
      // restatements still need the organiser's evidence/content agreement.
      mergeSimilarity: 0.85,
      adjacentSimilarity: 0.92,
      labelSimilarity: 0.6,
      mergeRestatements: true,
      preserveVisibleRows: options.includeAllDetails === true,
      supportingSubjectPolicy: options.supportingSubjectPolicy,
      onRestatements: options.onRestatements,
      onUnassignedSupportingDetail: options.onUnassignedSupportingDetail
    });
    result = organiser.discussion;
  }
  let rePromoted = 0;
  if (options.includeAllDetails === true) {
    const included = promoteAllDiscussionDetails(result);
    result = included.discussion;
    rePromoted = included.promoted;
  }
  result = removePersonalAsides(result);
  result = shapeDiscussion(result, options.people || []).discussion;
  result = await finaliseDiscussionForPublication(result, {
    sourceUnits: options.sourceUnits || [],
    people: options.people || [],
    rewritePartialOverlaps: options.rewritePartialOverlaps,
    onUnassignedSupportingDetail: options.onUnassignedSupportingDetail,
    onPartialOverlapConsolidated: options.onPartialOverlapConsolidated
  });
  const bodyDedupe = dedupeDiscussionBody(result, options.people || []);
  result = bodyDedupe.discussion;
  return {
    discussion: result,
    moved,
    rePromoted,
    organiser: organiser ? { before: organiser.before, after: organiser.after } : null,
    dropped: bodyDedupe.dropped,
    diagnostics: discussionStructureDiagnostics(result)
  };
}

function lowInformationStatusSubject(value = '') {
  const text = String(value || '').trim();
  const status = /\b(?:on track|on schedule|progressing as (?:planned|expected)|proceeding as planned|underway as planned|going to plan)\b/i;
  if (!status.test(text)) return new Set();
  // A status phrase carrying its own date, quantity, blocker or concrete
  // completion update still adds information and must remain independently
  // reviewable. This only identifies bare reassurance about a named subject.
  if (/\b(?:by|before|after|next|this|today|tomorrow|yesterday|deadline|due|scheduled|completed?|finished?|blocked?|delayed?|awaiting|\d)\b/i.test(text)) return new Set();
  const subject = text
    .replace(/^\s*(?:the\s+)?(?:work|activity|task|project|process)\s+(?:is|remains?|stays?)\s+/i, '')
    .replace(/^\s*(?:is|remains?|stays?)?\s*(?:on track|on schedule)\s+(?:for|with|on)?\s*/i, '')
    .replace(/\b(?:is|are|remains?|stays?)?\s*(?:on track|on schedule|progressing as (?:planned|expected)|proceeding as planned|underway as planned|going to plan)\b/ig, ' ');
  const tokens = discussionInformationTokens(subject);
  return tokens.size >= 2 ? tokens : new Set();
}

function supportingDetailAddsInformation(detail, retained = [], primary = {}) {
  const text = String(detail?.text || '').trim();
  if (!text) return false;
  const detailTokens = discussionInformationTokens(text);
  if (!detailTokens.size) return false;
  const detailNumbers = new Set(text.match(/\b\d+(?:[.,]\d+)?%?\b/g) || []);
  const evidence = new Set(detail?.evidenceIds || []);
  const statusSubject = lowInformationStatusSubject(text);
  for (const other of [primary, ...retained]) {
    const otherText = String(other?.text || '').trim();
    if (!otherText) continue;
    // Coverage of some words or one shared number is not coverage of every
    // quantity, unit, bound, range and identifier in the supporting claim.
    if (numericActionEditIssue(text, otherText)) continue;
    const otherTokens = discussionInformationTokens(otherText);
    const covered = [...detailTokens].filter((token) => otherTokens.has(token)).length / detailTokens.size;
    const otherNumbers = new Set(otherText.match(/\b\d+(?:[.,]\d+)?%?\b/g) || []);
    const conflictingQuantity = detailNumbers.size && otherNumbers.size
      && ![...detailNumbers].some((number) => otherNumbers.has(number));
    if (conflictingQuantity) continue;
    const sharedEvidence = (other?.evidenceIds || []).some((id) => evidence.has(id));
    // Similarity is symmetric: a short identity/status sentence can share most
    // of its words with a much richer schedule. It cannot represent that
    // schedule. For temporal content require directional detail coverage and
    // retain the complete timing in both directions before discarding a row.
    // The reverse check also protects a preferred/possible date from being
    // replaced by an otherwise identical unconditional statement.
    if (temporalClaim(text)
      && (covered < 0.8 || !temporalMeaningRetained(text, otherText)
        || !temporalMeaningRetained(otherText, text))) continue;
    if (statusSubject.size) {
      const subjectCovered = [...statusSubject].filter((token) => otherTokens.has(token)).length / statusSubject.size;
      if (subjectCovered >= 0.8) return false;
    }
    // A short source fragment adds no reviewer value when its meaningful words
    // are already present in a fuller proposition. Evidence overlap permits a
    // slightly looser threshold, but never collapses conflicting quantities.
    if (covered >= 0.8 || (sharedEvidence && covered >= 0.62)) return false;
  }
  return true;
}

module.exports = {
  discussionStructureDiagnostics,
  finalisePromotedDiscussion,
  lowInformationStatusSubject,
  promoteAllDiscussionDetails,
  supportingDetailAddsInformation
};
