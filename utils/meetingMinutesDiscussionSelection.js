'use strict';

const { meetingMinutesAgentText } = require('./meetingMinutesPlainText');
const { isReviewerAuthored } = require('./canonicalMinutes/state');
const { isRawTranscriptDiscussionPoint } = require('./stagedEditorial');
const { hybridContentTokenOverlap, hybridTokenOverlap } = require('./meetingMinutesRecordMatching');
const { isSourceSupportedMaterialDetail } = require('./canonicalMinutes/discussionPublication');
const {
  supportingDetailAddsInformation, lowInformationStatusSubject
} = require('./meetingMinutesDiscussionFinalization');
const { normaliseSourceUnits } = require('./meetingMinutesSource');
const { temporalClaim } = require('./meetingMinutesTemporalReview');
const { hybridCandidateMatchesRecord } = require('./meetingMinutesActionDuplicatePolicy');
const { numericActionEditIssue } = require('./meetingMinutesActionNumericPreservation');
const { flattenHybridDiscussion } = require('./meetingMinutesDiscussionRows');
const { duplicateGroups } = require('./canonicalMinutes/semanticDedupe');
const { safeLogError } = require('./apiErrors');
const { normaliseAgentResult } = require('./meetingMinutesResultNormalization');
const { selectSupportingDetailParent } = require('./canonicalMinutes/supportingDetailPlacement');
const { carryExactDiscussionProvenance } = require('./meetingMinutesExactDiscussionProvenance');

function meetingMinutesAgentSupportingDedupeThreshold() {
  const value = Number(process.env.MEETING_MINUTES_AGENT_SUPPORTING_DEDUPE_THRESHOLD);
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : 0.72;
}

const PRIORITY_SUPPORTING_DETAIL = /\b(?:high|medium|moderate|low|significant|material|residual|cybersecurity|safety)?\s*risk(?:s|y)?\b|\b(?:hazard|threat|blocker|blocking|blocked|roadblock|at risk|off track|on track|behind schedule|ahead of schedule|delay(?:ed|s)?|overdue|partway through|in progress|underway|not (?:yet )?started|target(?:ed)? completion|due (?:by|on)|failed|failure)\b|\b(?:no|not)\s+(?:final\s+)?(?:decision|agreement|option|solution)\s+(?:was\s+)?(?:made|reached|agreed|selected|chosen)\b|\b(?:decision|choice|issue|matter|discussion)\s+(?:was\s+)?(?:deferred|postponed|parked)\b/i;

const MATERIAL_METRIC_DETAIL = /(?:[$£€]\s*\d|\b\d+(?:[.,]\d+)?\s*%|\b\d+(?:[.,]\d+)?\s+out of\s+\d+(?:[.,]\d+)?\b|\b(?:increase(?:d)?|decrease(?:d)?|improve(?:d)?|reduc(?:e|ed)|rose|fell|dropped|grew)\b[^.]{0,90}\d|\b(?:average|score|rate|volume|total|target|resolution time|satisfaction|ticket volume|item count)\b[^.]{0,90}\d)/i;

function prioritySupportingDetail(value = '') {
  const text = meetingMinutesAgentText(value, 1600);
  return PRIORITY_SUPPORTING_DETAIL.test(text) || MATERIAL_METRIC_DETAIL.test(text);
}

// Priority facts must read as ordinary minutes, carry evidence and add meaning
// not already present in a visible row.  This promotes risks and meaningful
// delivery status out of the optional drawer without inventing or rewriting
// anything. Keep both a whole-draft and per-topic ceiling: risk-heavy technical
// meetings can otherwise turn every elaboration containing "risk", "underway"
// or a target date back into a primary row after the referee condensed it. Any
// detail which is not promoted remains attached to its parent for review.
function promotePrioritySupportingDetails(discussion = [], limit = 6, maxPerTopic = 2, sourceUnits = []) {
  const result = (Array.isArray(discussion) ? discussion : []).map((topic) => ({
    ...topic,
    points: (topic.points || []).map((record) => ({ ...record, supportingDetails: [...(record.supportingDetails || [])] })),
    decisions: (topic.decisions || []).map((record) => ({ ...record, supportingDetails: [...(record.supportingDetails || [])] })),
    openQuestions: (topic.openQuestions || []).map((record) => ({ ...record, supportingDetails: [...(record.supportingDetails || [])] }))
  }));
  const visible = result.flatMap((topic) => [...topic.points, ...topic.decisions, ...topic.openQuestions]);
  const totalLimit = Math.max(0, Number(limit) || 0);
  const topicLimit = Math.max(0, Number(maxPerTopic) || 0);
  let promoted = 0;
  for (const topic of result) {
    if (isReviewerAuthored(topic)) continue;
    const additions = [];
    let promotedInTopic = 0;
    for (const kind of ['decisions', 'openQuestions', 'points']) {
      for (const record of topic[kind] || []) {
        if (isReviewerAuthored(record)) continue;
        const retained = [];
        for (const detail of record.supportingDetails || []) {
          const value = meetingMinutesAgentText(detail?.text, 1600);
          const readable = value && !isRawTranscriptDiscussionPoint(value);
          // This is deliberately a little broader than the final publication
          // deduper. A related detail can stay nested without information loss;
          // promoting it and hoping a later pass removes it is what caused the
          // discussion sections to expand again.
          const duplicate = visible.some((other) => other !== record
            && hybridContentTokenOverlap(other?.text, value) >= 0.58)
            || hybridContentTokenOverlap(record?.text, value) >= 0.58;
          if (promoted < totalLimit && promotedInTopic < topicLimit
            && readable && !isReviewerAuthored(detail)
            && (prioritySupportingDetail(value) || isSourceSupportedMaterialDetail(detail, sourceUnits))
            && (detail.evidenceIds || []).length && !duplicate
            && supportingDetailAddsInformation(detail, visible, {})) {
            const row = {
              ...detail,
              id: detail.id || `priority-${record.id || 'row'}-${promoted + 1}`,
              text: value,
              evidenceIds: [...new Set(detail.evidenceIds || [])].slice(0, 8),
              supportingDetails: []
            };
            additions.push(row);
            visible.push(row);
            promoted += 1;
            promotedInTopic += 1;
          } else retained.push(detail);
        }
        record.supportingDetails = retained;
      }
    }
    if (additions.length) topic.points.push(...additions);
  }
  return { discussion: result, promoted };
}

// Ordinary context remains sparse after semantic consolidation. Distinct,
// evidenced temporal context is not expendable merely because its parent has
// already used that context budget; it stays collapsed unless independently
// eligible for publication. Reviewer content also remains authoritative.
function limitSupportingDetails(discussion = [], maxTotal = 12, maxPerRecord = 2, sourceUnits = []) {
  const usableIds = new Set(normaliseSourceUnits(sourceUnits)
    .filter((unit) => unit.classification !== 'remove' || unit.restored === true)
    .map((unit) => String(unit.id)));
  const protectedDetails = new Set();
  const prepare = (record, reviewerTopic) => {
    const original = record.supportingDetails || [];
    const reviewerRecord = reviewerTopic || isReviewerAuthored(record);
    const consolidated = reviewerRecord ? original : consolidateSupportingDetails(record);
    const details = !reviewerRecord && original.some(isReviewerAuthored)
      ? original.filter((detail) => isReviewerAuthored(detail) || consolidated.includes(detail))
      : consolidated;
    for (const detail of details) {
      const evidence = Array.isArray(detail.evidenceIds) ? detail.evidenceIds : [];
      if (reviewerRecord || isReviewerAuthored(detail)
        || (temporalClaim(detail.text) && !isRawTranscriptDiscussionPoint(detail.text)
          && evidence.length && evidence.every((id) => usableIds.has(String(id))))) {
        protectedDetails.add(detail);
      }
    }
    return { ...record, supportingDetails: details };
  };
  const result = (Array.isArray(discussion) ? discussion : []).map((topic) => ({
    ...topic,
    points: (topic.points || []).map((record) => prepare(record, isReviewerAuthored(topic))),
    decisions: (topic.decisions || []).map((record) => prepare(record, isReviewerAuthored(topic))),
    openQuestions: (topic.openQuestions || []).map((record) => prepare(record, isReviewerAuthored(topic)))
  }));
  const rows = result.flatMap((topic) => ['decisions', 'openQuestions', 'points']
    .flatMap((kind) => topic[kind] || []));
  const ordinary = new Map(rows.map((record) => [record,
    record.supportingDetails.filter((detail) => !protectedDetails.has(detail)).slice(0, maxPerRecord)]));
  const selected = new Set(protectedDetails);
  let retained = 0;
  for (let detailIndex = 0; detailIndex < maxPerRecord && retained < maxTotal; detailIndex += 1) {
    for (const record of rows) {
      const detail = ordinary.get(record)?.[detailIndex];
      if (!detail || retained >= maxTotal) continue;
      selected.add(detail);
      retained += 1;
    }
  }
  for (const record of rows) record.supportingDetails = record.supportingDetails.filter((detail) => selected.has(detail));
  return result;
}

function mergeHybridDiscussionTopics(base = [], additions = []) {
  const merged = (Array.isArray(base) ? base : []).map((topic) => ({
    ...topic, points: [...(topic.points || [])], decisions: [...(topic.decisions || [])], openQuestions: [...(topic.openQuestions || [])]
  }));
  for (const addition of Array.isArray(additions) ? additions : []) {
    let target = merged.find((topic) => topic.topic.toLowerCase() === addition.topic.toLowerCase());
    if (!target) target = merged.find((topic) => hybridTokenOverlap(topic.topic, addition.topic) >= 0.6);
    if (!target) {
      merged.push(addition);
      continue;
    }
    for (const key of ['points', 'decisions', 'openQuestions']) {
      for (const record of addition[key] || []) {
        if (!(target[key] || []).some((existing) => hybridCandidateMatchesRecord({
          recordType: key === 'points' ? 'discussion_point' : key === 'decisions' ? 'decision' : 'open_question',
          text: record.text, evidenceIds: record.evidenceIds
        }, existing))) target[key].push(record);
      }
    }
  }
  return merged;
}

function consolidateSupportingDetails(record = {}) {
  const ordered = [...(record.supportingDetails || [])].sort((left, right) =>
    Number(Boolean(lowInformationStatusSubject(left?.text).size)) - Number(Boolean(lowInformationStatusSubject(right?.text).size))
    || String(right?.text || '').length - String(left?.text || '').length);
  const retained = [];
  for (const detail of ordered) {
    if (supportingDetailAddsInformation(detail, retained, record)) retained.push(detail);
  }
  return retained.slice(0, 50);
}

// Preserve the existing untimed duplicate policy. A similarity match alone
// cannot discard timed material: its directional content and timing must be
// represented by the row which would replace it.
function mayDiscardSupportingDetail(detail, existing) {
  return !numericActionEditIssue(String(detail?.text || ''), String(existing?.text || ''))
    && (!temporalClaim(detail?.text) || !supportingDetailAddsInformation(detail, [], existing));
}

function meetingMinutesAgentSupportingSemanticThreshold() {
  const value = Number(process.env.MEETING_MINUTES_AGENT_SUPPORTING_SEMANTIC_THRESHOLD);
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : 0.8;
}

// Word overlap cannot see that "Dan takes responsibility to order six sacks
// today" and "Dan will order malt directly to get a better rate" are one
// fact. The MiniLM worker can, and the legacy staged path already uses it.
// One embedding call over every supporting detail (plus the primary rows, so
// a detail restating a primary row goes too), keeping the first member of
// each group. Primary rows are never dropped here; they are listed first so
// they win any group they belong to. Falls back to lexical grouping when the
// worker is unavailable, and to no change on any error.
async function dedupeSupportingDetailsSemantically(discussion = [], options = {}) {
  const topics = Array.isArray(discussion) ? discussion : [];
  const primaryRecords = flattenHybridDiscussion(topics).map((item) => item.record).filter(Boolean);
  const primaries = primaryRecords.map((record) => meetingMinutesAgentText(record?.text, 1600));
  const details = [];
  for (const topic of topics) {
    for (const kind of ['points', 'decisions', 'openQuestions']) {
      for (const record of Array.isArray(topic?.[kind]) ? topic[kind] : []) {
        (record.supportingDetails || []).forEach((detail, index) => {
          details.push({ record, index, text: meetingMinutesAgentText(detail?.text, 1600) });
        });
      }
    }
  }
  if (!details.length) return topics;
  // Do this exact, evidence-aware containment check before the optional worker.
  // It catches the common one-suggestion case and remains effective if the
  // semantic service is unavailable. Conflicting figures are preserved by
  // supportingDetailAddsInformation.
  for (const entry of details) {
    if (!supportingDetailAddsInformation(entry.record.supportingDetails[entry.index], primaryRecords, {})) {
      entry.dropDeterministically = true;
    }
  }
  let dedupe;
  try {
    dedupe = await duplicateGroups([...primaries, ...details.map((detail) => detail.text)], {
      threshold: options.threshold || meetingMinutesAgentSupportingSemanticThreshold(),
      ...(options.vectors !== undefined ? { vectors: options.vectors } : {})
    });
  } catch (error) {
    safeLogError('[meeting-minutes-agent] supporting semantic dedupe skipped', error);
    dedupe = { groups: [], semantic: false };
  }
  const dropped = new Set(details.map((detail, index) => detail.dropDeterministically ? index : -1).filter((index) => index >= 0));
  for (const group of dedupe?.groups || []) {
    const ordered = [...group].sort((left, right) => left - right);
    for (const memberIndex of ordered.slice(1)) {
      if (memberIndex < primaries.length) continue;
      const detail = details[memberIndex - primaries.length];
      const value = detail.record.supportingDetails[detail.index];
      const represented = ordered.filter((index) => index < memberIndex
        && (index < primaries.length || !dropped.has(index - primaries.length))).some((index) => {
        const existing = index < primaries.length ? primaryRecords[index]
          : details[index - primaries.length].record.supportingDetails[details[index - primaries.length].index];
        return mayDiscardSupportingDetail(value, existing);
      });
      if (represented) dropped.add(memberIndex - primaries.length);
    }
  }
  if (!dropped.size) return topics;
  const droppedByRecord = new Map();
  dropped.forEach((detailIndex) => {
    const entry = details[detailIndex];
    if (!droppedByRecord.has(entry.record)) droppedByRecord.set(entry.record, new Set());
    droppedByRecord.get(entry.record).add(entry.index);
  });
  for (const [record, indexes] of droppedByRecord) {
    record.supportingDetails = (record.supportingDetails || []).filter((detail, index) => !indexes.has(index));
  }
  console.log(JSON.stringify({
    event: 'meeting_agent_supporting_semantic_dedupe',
    journeyId: options.journeyId,
    detailCount: details.length,
    droppedCount: dropped.size,
    via: dedupe.pairs?.[0]?.via || (dedupe.semantic === false ? 'lexical' : 'semantic'),
    dropped: [...dropped].map((index) => details[index].text.slice(0, 160))
  }));
  return topics;
}

const OWNER_FOLLOW_UP_PATTERN = new RegExp(
  '^(?!(?:Action|Agreed|Agreement|Aim|Approval|Commitment|Confirmation|Decided|Decision|Goal|Intention|It|Need|Option|Plan|Proposal|Request|Requirement|Rule|Team|That|The|This)\\b)'
  + "[A-Z][\\p{L}'’.-]+(?:\\s+[A-Z][\\p{L}'’.-]+){0,2}\\s+(?:to|will|is to)\\s+"
  + '(?:arrange|book|call|chase|check|circulate|complete|confirm|contact|draft|email|finalise|finalize|follow up|forward|get|investigate|issue|liaise|order|organise|organize|place|prepare|produce|provide|raise|review|ring|schedule|send|service|share|sign|source|speak|submit|test|update|write)\\b',
  'u'
);

function compactDiscussionPropositions(discussion = [], recovered = [], sourceUnits = [], options = {}) {
  const retainUnassigned = (detail, context = {}) => {
    if (typeof options.onUnassignedSupportingDetail !== 'function'
      || options.onUnassignedSupportingDetail(detail, context) !== true) {
      throw new Error('Unfiled supporting detail requires a lossless review collector.');
    }
  };
  const kindRank = { discussion_point: 1, open_question: 2, decision: 3 };
  const numberTokens = (value) => new Set(String(value || '').match(/\b\d+(?:[.,]\d+)?%?\b/g) || []);
  const compatible = (left, right) => {
    const lexical = hybridContentTokenOverlap(left.record?.text, right.record?.text);
    const evidence = new Set(left.record?.evidenceIds || []);
    const sharedEvidence = (right.record?.evidenceIds || []).some((id) => evidence.has(id));
    const sequence = (id) => Number(String(id || '').match(/\d+/)?.[0] || NaN);
    const nearbyEvidence = (right.record?.evidenceIds || []).some((id) =>
      (left.record?.evidenceIds || []).some((other) => {
        const a = sequence(id); const b = sequence(other);
        return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 2;
      }));
    const compatibleTopic = String(left.topic || '').toLowerCase() === String(right.topic || '').toLowerCase()
      || hybridTokenOverlap(left.topic, right.topic) >= 0.55;
    const leftNumbers = numberTokens(left.record?.text); const rightNumbers = numberTokens(right.record?.text);
    const explicitAlternative = (value) => /\b\d+(?:st|nd|rd|th)?\s+(?:or|\/|either)\s+\d+(?:st|nd|rd|th)?\b/i.test(String(value || ''));
    const sameNumbers = leftNumbers.size === rightNumbers.size
      && [...leftNumbers].every((value) => rightNumbers.has(value));
    if ((explicitAlternative(left.record?.text) || explicitAlternative(right.record?.text)) && !sameNumbers) return false;
    // Distinct figures and dates are distinct claims even when the surrounding
    // wording is very similar. A high lexical score previously collapsed a
    // 9th/10th pair into one synthetic alternative.
    if (leftNumbers.size && rightNumbers.size && ![...leftNumbers].some((value) => rightNumbers.has(value))) return false;
    // Topic labels are generated independently and vary more than the
    // propositions beneath them. Strong proposition equivalence or shared
    // evidence therefore joins records across labels, while weaker matches
    // still require compatible topics.
    return lexical >= 0.72 || (sharedEvidence && lexical >= 0.42)
      || (nearbyEvidence && lexical >= 0.5)
      || (compatibleTopic && (lexical >= 0.58 || (sharedEvidence && lexical >= 0.24)));
  };
  const rows = flattenHybridDiscussion(discussion);
  // A typed core decision must not lose the main position to a longer
  // supporting paraphrase. This list is supplied only from settled referee
  // accounting, never inferred from a heading, similarity or record label.
  const authoritativeCoreIds = new Set(Array.isArray(options.authoritativeCoreIds) ? options.authoritativeCoreIds : []);
  const rowIds = new Map(); for (const row of rows) rowIds.set(row.record?.id, (rowIds.get(row.record?.id) || 0) + 1);
  const sources = new Map(); for (const unit of sourceUnits) sources.set(unit.id, sources.has(unit.id) ? null : unit);
  const authoritativeCore = row => authoritativeCoreIds.has(row.record?.id) && rowIds.get(row.record?.id) === 1
    && row.record?.evidenceIds?.length && row.record.evidenceIds.every(id => sources.get(id)?.text)
    && !isReviewerAuthored(row.record);
  const groups = [];
  for (const row of rows) {
    const group = groups.find((items) => items.some((other) => compatible(other, row))
      && !items.some(other => authoritativeCore(other) && authoritativeCore(row)
        && (() => { const numbers = value => String(value || '').match(/\b\d+(?:[.,]\d+)?%?\b/g) || [];
          return JSON.stringify(numbers(other.record.text)) !== JSON.stringify(numbers(row.record.text))
            || numericActionEditIssue(other.record.text, row.record.text)
            || numericActionEditIssue(row.record.text, other.record.text); })()));
    if (group) group.push(row); else groups.push([row]);
  }
  const topics = [];
  const topicFor = (name) => {
    let topic = topics.find((item) => item.topic.toLowerCase() === String(name || '').toLowerCase());
    if (!topic) topic = topics.find((item) => hybridTokenOverlap(item.topic, name) >= 0.6);
    if (!topic) { topic = { id: `compact-${topics.length + 1}`, topic: name || 'Discussion', points: [], decisions: [], openQuestions: [] }; topics.push(topic); }
    return topic;
  };
  for (const group of groups) {
    const clientReady = (item) => !isRawTranscriptDiscussionPoint(item.record?.text);
    const ordered = [...group].sort((left, right) => (kindRank[right.recordType] || 0) - (kindRank[left.recordType] || 0)
      || Number(clientReady(right)) - Number(clientReady(left))
      || Number(authoritativeCore(right)) - Number(authoritativeCore(left))
      || String(right.record?.text || '').length - String(left.record?.text || '').length);
    const selected = ordered[0];
    const mergedFromIds = [...new Set(group.flatMap(item => [
      item.record?.id, ...(item.record?.mergedFromIds || [])
    ]).filter(id => id && id !== selected.record?.id))];
    const record = {
      ...selected.record,
      ...(mergedFromIds.length ? { mergedFromIds } : {}),
      evidenceIds: [...new Set(group.flatMap((item) => item.record?.evidenceIds || []))].slice(0, 12)
    };
    const details = [
      ...(record.supportingDetails || []).map(detail => ({ ...detail,
        originalTopic: detail?.originalTopic || selected.topic })),
      ...ordered.slice(1).flatMap((item) => [
        { id: item.record?.id, text: item.record?.text, evidenceIds: item.record?.evidenceIds || [],
          originalTopic: item.record?.originalTopic || item.topic },
        ...(item.record?.supportingDetails || []).map(detail => ({ ...detail,
          originalTopic: detail?.originalTopic || item.topic }))
      ])
    ].filter((detail) => detail?.text && (hybridContentTokenOverlap(detail.text, record.text) < 0.94
      || !mayDiscardSupportingDetail(detail, record)));
    const retainedDetails = details.filter((detail, index) => details.findIndex((other) =>
      hybridContentTokenOverlap(other.text, detail.text) >= 0.9
        && mayDiscardSupportingDetail(detail, other)) === index);
    record.supportingDetails = retainedDetails.slice(0, 50);
    for (const detail of retainedDetails.slice(50)) retainUnassigned(detail,
      { originalTopic: selected.topic, placementReason: 'parent_detail_capacity' });
    const topic = topicFor(selected.topic);
    // "Mick to contact the engineer today" is a follow-up, not a decision; the
    // Referee's bucket is otherwise taken verbatim, so keep it visible as a
    // discussion point rather than mislabel it. The Actions stage owns it.
    const ownerFollowUp = selected.recordType === 'decision' && OWNER_FOLLOW_UP_PATTERN.test(String(record.text || ''));
    const key = selected.recordType === 'decision' && !ownerFollowUp ? 'decisions'
      : selected.recordType === 'open_question' ? 'openQuestions' : 'points';
    topic[key].push(record);
  }

  // Corroborated omissions no longer bypass the referee into the visible draft.
  // Explicit decisions remain core; other accurate recovery material needs a
  // justified parent in the same topic or lossless retention for review.
  const recoveredRows = flattenHybridDiscussion(recovered);
  const materialCore = /\b(?:agree(?:d|ment)?|decid(?:e|ed|ion)|approv(?:e|ed|al)|reject(?:ed|ion)?|block(?:ed|er|ing)?|cannot|can't|unable|depend(?:s|ent|ency)?|subject to|prevent(?:s|ed|ing)?|significant risk|material risk|unresolved|required decision|requires? confirmation|not yet (?:agreed|approved|resolved|confirmed)|awaiting (?:approval|decision|confirmation)|responsibil(?:ity|ities)|handled (?:at|by)|separate track|workstream|in parallel|handover|debrief|end of day|after (?:the )?site|return journey)\b/i;
  const recoveredCore = recoveredRows.filter((item) => item.recordType === 'decision'
    || materialCore.test(String(item.record?.text || '')));
  if (recoveredCore.length) {
    const visibleCore = normaliseAgentResult({ discussion: recoveredCore.map((item) => ({
      topic: item.topic,
      decisions: item.recordType === 'decision' ? [item.record] : [],
      points: item.recordType === 'discussion_point' ? [item.record] : [],
      openQuestions: item.recordType === 'open_question' ? [item.record] : []
    })) }, sourceUnits, 'discussion', options).discussion;
    return compactDiscussionPropositions(mergeHybridDiscussionTopics(topics, visibleCore),
      recoveredRows.filter((item) => !recoveredCore.includes(item)).map((item) => ({
        topic: item.topic, points: item.recordType === 'discussion_point' ? [item.record] : [],
        decisions: [], openQuestions: item.recordType === 'open_question' ? [item.record] : []
      })), sourceUnits, options);
  }
  for (const item of recoveredRows) {
    const topic = topics.find((candidate) => candidate.topic.toLowerCase() === String(item.topic || '').toLowerCase())
      || topics.find((candidate) => hybridTokenOverlap(candidate.topic, item.topic) >= 0.55);
    const records = topic ? [...topic.decisions, ...topic.openQuestions, ...topic.points] : [];
    if (records.some((record) => hybridContentTokenOverlap(record.text, item.record?.text) >= 0.9
      && mayDiscardSupportingDetail(item.record, record))) continue;
    const selection = selectSupportingDetailParent(item.record || {},
      records.map(record => ({ topic: topic.topic, record })), { sourceUnits, subjectPolicy: options.supportingSubjectPolicy });
    if (!selection.target) {
      retainUnassigned(item.record, { originalTopic: item.topic, placementReason: selection.reason });
      continue;
    }
    const target = selection.target.record;
    const detail = {
      id: item.record?.id || `supporting-${target.id}-${target.supportingDetails?.length || 0}`,
      text: item.record?.text || '', evidenceIds: [...new Set(item.record?.evidenceIds || [])],
      originalTopic: item.record?.originalTopic || item.topic,
      ...(item.record?.reviewFlagIds?.length ? { reviewFlagIds: [...item.record.reviewFlagIds] } : {})
    };
    if ((target.supportingDetails || []).length >= 50) {
      retainUnassigned(detail, { originalTopic: item.topic, placementReason: 'parent_detail_capacity' });
    } else target.supportingDetails = [...(target.supportingDetails || []), detail];
  }
  // A referee can classify a candidate as supporting without repeating its
  // full text in the visible response. Keep that accurate secondary material
  // under a justified core proposition or in the review-only filing pool.
  // The candidate ledger remains private; full supporting text is retained.
  const allPrimary = topics.flatMap((topic) => [...topic.decisions, ...topic.openQuestions, ...topic.points]
    .map((record) => ({ topic, record })));
  // Dedupe across the whole draft, not per parent: the same chiller-risk fact
  // attached under four different propositions was four reviewer rows.
  const supportingDedupeThreshold = meetingMinutesAgentSupportingDedupeThreshold();
  const attachedRecords = allPrimary.flatMap(({ record }) => [
    record, ...(record.supportingDetails || [])
  ]).filter(record => record?.text);
  for (const item of Array.isArray(options.supportingCandidates) ? options.supportingCandidates : []) {
    const candidate = item?.candidate || item;
    const detailText = String(candidate?.text || candidate?.record?.text || '').trim();
    if (!detailText) continue;
    const originalTopic = candidate.record?.originalTopic || candidate.originalTopic || candidate.topic;
    const explicitTarget = meetingMinutesAgentText(item?.mergeTarget, 80);
    const detailEvidenceIds = [...new Set([...(candidate.evidenceIds || []), ...(candidate.record?.evidenceIds || [])])];
    const detailFlagIds = [...new Set([...(candidate.reviewFlagIds || []), ...(candidate.record?.reviewFlagIds || [])])];
    // A later generated-prose normaliser has a 1,600-character limit. Keep a
    // longer source detail intact for explicit reviewer filing instead.
    if (detailText.length > 1600) {
      retainUnassigned({ id: candidate.candidateId || candidate.record?.id || candidate.id,
        text: detailText, evidenceIds: detailEvidenceIds, reviewFlagIds: detailFlagIds },
      { originalTopic, placementReason: 'long_supporting_detail' });
      continue;
    }
    const selection = selectSupportingDetailParent({ ...candidate, text: detailText }, allPrimary,
      { explicitTarget, sourceUnits, subjectPolicy: options.supportingSubjectPolicy });
    if (!selection.target) {
      retainUnassigned({
        ...candidate,
        id: candidate.candidateId || candidate.record?.id || candidate.id,
        text: detailText,
        evidenceIds: detailEvidenceIds, reviewFlagIds: detailFlagIds
      }, { originalTopic, placementReason: selection.reason });
      continue;
    }
    const target = selection.target.record;
    // Filing must not discard a different quantity, qualification or live
    // review link just because an untimed sentence sounds similar.
    if (attachedRecords.some(existing => hybridContentTokenOverlap(existing.text, detailText) >= supportingDedupeThreshold
      && !numericActionEditIssue(detailText, existing.text)
      && !supportingDetailAddsInformation({ text: detailText, evidenceIds: detailEvidenceIds }, [], existing)
      && detailFlagIds.every(id => (existing.reviewFlagIds || []).includes(id))
      && (candidate.reviewerAuthored !== true || existing.reviewerAuthored === true))) continue;
    const existing = target.supportingDetails || [];
    const detail = {
      id: candidate.candidateId || candidate.record?.id || candidate.id || `supporting-${target.id}-${existing.length}`,
      text: detailText,
      evidenceIds: detailEvidenceIds,
      originalTopic,
      ...(detailFlagIds.length ? { reviewFlagIds: detailFlagIds } : {})
    };
    if (existing.length >= 50) {
      retainUnassigned(detail, { originalTopic, placementReason: 'parent_detail_capacity' });
    } else target.supportingDetails = [...existing, detail];
    attachedRecords.push(detail);
  }
  // A Referee may conservatively label a genuinely material proposition as
  // supporting. Keep secondary context collapsed by default, but promote a
  // detail when it adds a distinct decision, scope/requirement, risk,
  // dependency, quantified change or consequential unresolved matter. This is
  // evidence- and language-based; it contains no meeting/client vocabulary.
  const materialDetail = /\b(?:agree(?:d|ment)?|decid(?:e|ed|ion)|approv(?:e|ed|al)|reject(?:ed|ion)?|scope|require(?:d|ment|s)?|must|standard|regulat(?:ion|ory)|compliance|risk|block(?:ed|er|ing)?|depend(?:s|ent|ency)?|subject to|unresolved|uncertain|not yet (?:agreed|approved|resolved|confirmed)|awaiting (?:approval|decision|confirmation)|primary (?:role|focus|objective|purpose)|responsibil(?:ity|ities)|handled (?:at|by)|separate track|workstream|in parallel|coordination|handover|debrief|end of day|after (?:the )?site|return journey|increase|decrease|reduc(?:e|ed|tion)|total|target|deadline|\d+(?:[.,]\d+)?%)\b/i;
  const visibleRecords = topics.flatMap((topic) => [...topic.decisions, ...topic.openQuestions, ...topic.points]);
  if (options.promoteMaterialSupporting !== false) {
    for (const topic of topics) {
      for (const record of [...topic.decisions, ...topic.openQuestions, ...topic.points]) {
        const retained = [];
        for (const detail of record.supportingDetails || []) {
          const rawSpeech = isRawTranscriptDiscussionPoint(detail?.text);
          const restatesVisible = visibleRecords.some((visible) => visible !== record
            && hybridContentTokenOverlap(visible?.text, detail?.text) >= 0.42)
            || hybridContentTokenOverlap(record?.text, detail?.text) >= 0.42;
          if (!rawSpeech && materialDetail.test(String(detail?.text || ''))
            && !restatesVisible
            && supportingDetailAddsInformation(detail, visibleRecords, {})) {
            const promoted = {
              id: detail.id || `promoted-${record.id}-${topic.points.length}`,
              text: detail.text,
              evidenceIds: [...new Set(detail.evidenceIds || [])].slice(0, 8),
              supportingDetails: []
            };
            topic.points.push(promoted);
            visibleRecords.push(promoted);
          } else retained.push(detail);
        }
        record.supportingDetails = retained;
      }
    }
  }
  // Do not publish a generated "9th or 10th"-style alternative when the
  // source never states that alternative and separate grounded rows already
  // preserve each date/number. This is a general anti-synthesis rule: it does
  // not choose between the values or rewrite either claim.
  const allRows = topics.flatMap((topic) => ['points', 'decisions', 'openQuestions']
    .flatMap((kind) => (topic[kind] || []).map((record) => ({ topic, kind, record }))));
  const sourceUnitsById = new Map(normaliseSourceUnits(sourceUnits).map((unit) => [String(unit.id), unit]));
  const syntheticAlternative = (record) => {
    const match = String(record?.text || '').match(/\b(\d+(?:st|nd|rd|th)?)\s+(?:or|\/|either)\s+(\d+(?:st|nd|rd|th)?)\b/i);
    if (!match) return false;
    const source = (record.evidenceIds || []).map((id) => sourceUnitsById.get(String(id))?.text || '').join(' ');
    if (new RegExp(`\\b${match[1]}\\s+(?:or|\\/|either)\\s+${match[2]}\\b`, 'i').test(source)) return false;
    const plain = (value) => String(value).replace(/(?:st|nd|rd|th)$/i, '');
    const hasSibling = (value) => allRows.some((row) => row.record !== record
      && new RegExp(`\\b${plain(value)}(?:st|nd|rd|th)?\\b`, 'i').test(String(row.record?.text || '')));
    return hasSibling(match[1]) && hasSibling(match[2]);
  };
  for (const topic of topics) for (const kind of ['points', 'decisions', 'openQuestions']) {
    topic[kind] = (topic[kind] || []).filter((record) => !syntheticAlternative(record));
  }
  const clientReadyDiscussion = (record) => {
    const value = String(record?.text || '').trim();
    if (!value) return false;
    if (isRawTranscriptDiscussionPoint(value)) return false;
    // Direct second-person questions are transcript fragments, not formal
    // propositions. Genuine unresolved matters are retained when expressed as
    // an evidenced declarative question (for example, "Whether access will be
    // available remained unresolved").
    if (/^\s*(?:can|could|would|will|do|does|did|are|is|have|has)\s+you\b/i.test(value)) return false;
    if (/^\s*we\b/i.test(value)
      && !/^\s*we\s+(?:agreed|decided|confirmed|approved|concluded|will|must|need)/i.test(value)) return false;
    return true;
  };
  // The prose/evidence gate rejects parents, not their retained descendants.
  // Use the pre-normalisation trees so review handoff does not truncate long
  // text, nested context or history while the unsupported parent stays blocked.
  const originalRows = flattenHybridDiscussion(topics).map(item => item.record);
  const originalDetails = [];
  const indexDetail = detail => {
    if (!detail || typeof detail !== 'object') return;
    originalDetails.push(detail);
    for (const child of Array.isArray(detail.supportingDetails) ? detail.supportingDetails : []) indexDetail(child);
  };
  for (const record of originalRows) for (const detail of record.supportingDetails || []) indexDetail(detail);
  const sameId = (left, right) => meetingMinutesAgentText(left?.id, 80)
    && meetingMinutesAgentText(left.id, 80) === meetingMinutesAgentText(right?.id, 80);
  const keepParent = (record, topic) => {
    if ((record.evidenceIds || []).length && clientReadyDiscussion(record)) return true;
    const sourceDetails = originalRows.filter(source => sameId(source, record))
      .flatMap(source => source.supportingDetails || []);
    const remainingDetails = (record.supportingDetails || []).flatMap(detail => {
      const originals = originalDetails.filter(source => sameId(source, detail));
      return originals.length ? originals : [detail];
    });
    for (const detail of new Set([...sourceDetails, ...remainingDetails])) {
      retainUnassigned(detail, { originalTopic: topic.topic, placementReason: 'parent_not_publishable' });
    }
    return false;
  };
  return carryExactDiscussionProvenance(topics,
    normaliseAgentResult({ discussion: topics }, sourceUnits, 'discussion', options).discussion).map((topic) => ({
    ...topic,
    points: (topic.points || []).filter((record) => keepParent(record, topic))
      .map((record) => ({ ...record, supportingDetails: consolidateSupportingDetails(record)
        .filter((detail) => (detail.evidenceIds || []).length) })),
    decisions: (topic.decisions || []).filter((record) => keepParent(record, topic))
      .map((record) => ({ ...record, supportingDetails: consolidateSupportingDetails(record)
        .filter((detail) => (detail.evidenceIds || []).length) })),
    openQuestions: (topic.openQuestions || []).filter((record) => keepParent(record, topic))
      .map((record) => ({ ...record, supportingDetails: consolidateSupportingDetails(record)
        .filter((detail) => (detail.evidenceIds || []).length) }))
  })).filter((topic) => topic.points.length || topic.decisions.length || topic.openQuestions.length);
}

module.exports = {
  compactDiscussionPropositions,
  consolidateSupportingDetails,
  dedupeSupportingDetailsSemantically,
  limitSupportingDetails,
  mayDiscardSupportingDetail,
  meetingMinutesAgentSupportingDedupeThreshold,
  mergeHybridDiscussionTopics,
  prioritySupportingDetail,
  promotePrioritySupportingDetails
};
