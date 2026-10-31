'use strict';

const { mayDiscardSupportingDetail, meetingMinutesAgentSupportingDedupeThreshold } = require('./meetingMinutesDiscussionSelection');
const { hybridContentTokenOverlap, hybridTokenOverlap } = require('./meetingMinutesRecordMatching');
const { refereeDiscussionTargetId, meetingAgentDispositionError, meetingAgentRefereeRoute } = require('./meetingMinutesResponseContracts');
const { flattenHybridDiscussion } = require('./meetingMinutesDiscussionRows');
const { meetingMinutesAgentText } = require('./meetingMinutesPlainText');
const { isReviewerAuthored } = require('./canonicalMinutes/state');
const { hasMeetingAgentReviewerContent } = require('./meetingMinutesPublication');
const { hybridCandidateMatchesRecord } = require('./meetingMinutesActionDuplicatePolicy');
const { evidenceSupportScore } = require('./meetingMinutesEvidenceContext');
const { resolveEvidence } = require('./meetingMinutesEvidenceResolution');
const { normaliseAgentResult } = require('./meetingMinutesResultNormalization');
const { normaliseSourceUnits } = require('./meetingMinutesSource');
const { carryExactDiscussionProvenance } = require('./meetingMinutesExactDiscussionProvenance');
const { isRawTranscriptDiscussionPoint } = require('./stagedEditorial');

function refereeClusterSupportingCandidates(dispositions = [], candidates = []) {
  const dedupeThreshold = meetingMinutesAgentSupportingDedupeThreshold();
  const dispositionById = new Map((Array.isArray(dispositions) ? dispositions : [])
    .filter((item) => item?.candidateId).map((item) => [String(item.candidateId), item]));
  const result = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const disposition = dispositionById.get(String(candidate?.candidateId || ''));
    const kind = disposition?.disposition || disposition?.classification;
    if (!['core', 'supporting', 'merge', 'reject'].includes(kind)) continue;
    const targetId = refereeDiscussionTargetId(disposition)
      || (kind === 'core' ? candidate.candidateId : '');
    for (const member of Array.isArray(candidate.clusterMembers) ? candidate.clusterMembers : []) {
      if (!member?.text || !Array.isArray(member.evidenceIds) || !member.evidenceIds.length) continue;
      // Referee representatives carry only the best proposition. Other
      // editorial discovery rows remain useful collapsed context. Raw
      // deterministic windows are intentionally excluded, and a rejected
      // representative only releases distinct overflow—not its paraphrases.
      const editorialMember = ['primary', 'recovery', 'staged'].includes(member.sourcePass);
      const deterministicContext = member.sourcePass === 'deterministic'
        && Number(member.priority || 0) >= 7
        && String(member.text || '').trim().length >= 30
        && !/^\s*(?:yeah|yes|no|okay|ok|right|thanks|thank you|bye|cheers)\b/i.test(String(member.text || ''));
      if (!editorialMember && !deterministicContext) continue;
      if (kind === 'reject' && member.clusterRelation !== 'overflow') continue;
      // Members of different clusters can still say the same thing; release
      // each fact once rather than once per cluster.
      if (result.some((item) => hybridContentTokenOverlap(item.candidate.text, member.text) >= dedupeThreshold
        && mayDiscardSupportingDetail(member, item.candidate))) continue;
      const unassessed = member.clusterRelation === 'overflow';
      result.push({ candidate: member, mergeTarget: unassessed ? '' : targetId,
        clusterRepresentativeId: candidate.candidateId, ...(unassessed ? { unassessed: true } : {}) });
    }
  }
  return result.slice(0, 240);
}

function discussionRefereeSufficiency(discussion = [], baseline = []) {
  const visible = flattenHybridDiscussion(discussion);
  const baselineTopics = [...new Set((Array.isArray(baseline) ? baseline : [])
    .map((topic) => meetingMinutesAgentText(topic?.topic, 240).toLowerCase()).filter(Boolean))];
  const visibleTopics = [...new Set(visible
    .map((item) => meetingMinutesAgentText(item?.topic, 240).toLowerCase()).filter(Boolean))];
  const coveredTopics = baselineTopics.filter((topic) => visibleTopics.some((candidate) =>
    candidate === topic || hybridTokenOverlap(candidate, topic) >= 0.55));
  const topicCoverage = baselineTopics.length ? coveredTopics.length / baselineTopics.length : (visible.length ? 1 : 0);
  return {
    sufficient: visible.length > 0 && (baselineTopics.length <= 2 || topicCoverage >= 0.65),
    visibleCount: visible.length,
    baselineTopicCount: baselineTopics.length,
    coveredTopicCount: coveredTopics.length,
    topicCoverage
  };
}

// A failed sibling is not permission to reclassify an already checked claim.
// Match discovery records exactly, never by topic, shared sources or similarity.
function discussionRefereeFallbackPlan(result, contract, ensemble = [], baseline = []) {
  const inactive = { active: false, dispositions: result?.candidateDispositions || [],
    candidates: ensemble, discussion: baseline, settledCandidateIds: [], routedRecords: [] };
  if (meetingAgentRefereeRoute(result, contract) !== 'structured_prompt') return inactive;
  const error = meetingAgentDispositionError(result, contract.candidates, contract);
  const dispositions = error ? error.validCandidateDispositions || [] : result.candidateDispositions || [];
  if (!dispositions.length) return inactive;
  const stable = value => Array.isArray(value) ? value.map(stable)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort()
      .filter(key => value[key] !== undefined).map(key => [key, stable(value[key])])) : value;
  const key = (kind, record) => JSON.stringify(stable([kind, Object.fromEntries(
    Object.entries(record || {}).filter(([name]) => !['primaryEvidenceIds', 'discoveryDisposition'].includes(name))
  )]));
  const settled = new Set(dispositions.map(row => row.candidateId));
  const records = new Map();
  // Production selection is a compact wire projection without .record. Bind
  // private records only here, by unique exact identity, so settled discovery
  // cannot return through fallback. Never put these trees in the AI payload.
  const privateCandidates = new Map();
  for (const candidate of ensemble) {
    if (!candidate?.candidateId) continue;
    privateCandidates.set(candidate.candidateId,
      privateCandidates.has(candidate.candidateId) ? null : candidate);
  }
  const recordFor = candidate => {
    if (candidate?.record) return candidate.record;
    const source = privateCandidates.get(candidate?.candidateId);
    if (!source?.record || isReviewerAuthored(source) || !['sourcePass', 'recordType', 'topic', 'text', 'evidenceIds']
      .every(field => JSON.stringify(stable(candidate[field])) === JSON.stringify(stable(source[field])))) return null;
    return source.record;
  };
  const add = candidate => {
    const record = recordFor(candidate);
    if (!record || isReviewerAuthored(candidate) || hasMeetingAgentReviewerContent(record)
      || record.supportingDetails?.length) return;
    records.set(key(candidate.recordType, record), candidate);
  };
  for (const candidate of contract.candidates) {
    if (!settled.has(candidate.candidateId)) continue;
    add(candidate);
  }
  // Consume only members actually released by the existing supporting route,
  // not every member of a rejected/filtered cluster. A separately supplied
  // member whose verdict is missing still needs fallback.
  for (const released of refereeClusterSupportingCandidates(dispositions, contract.candidates)) {
    if (released.unassessed) continue;
    const { candidate: member } = released;
    if (contract.candidates.some(row => row.candidateId === member.candidateId)
      && !settled.has(member.candidateId)) continue;
    add(member);
  }
  const routedRecords = [];
  const discussion = baseline.map(topic => {
    if (isReviewerAuthored(topic)) return topic;
    const next = { ...topic };
    for (const [field, kind] of [['points', 'discussion_point'], ['decisions', 'decision'], ['openQuestions', 'open_question']]) {
      next[field] = (topic[field] || []).filter(record => {
        if (hasMeetingAgentReviewerContent(record) || !records.has(key(kind, record))) return true;
        routedRecords.push({ topic: topic.topic, kind, record: structuredClone(record) });
        return false;
      });
    }
    return next;
  }).filter(topic => isReviewerAuthored(topic)
    || ['points', 'decisions', 'openQuestions'].some(field => topic[field]?.length));
  return { active: true, dispositions, discussion, routedRecords,
    settledCandidateIds: [...settled],
    candidates: ensemble.filter(candidate => isReviewerAuthored(candidate) || hasMeetingAgentReviewerContent(candidate.record)
      || !settled.has(candidate.candidateId) && !records.has(key(candidate.recordType, candidate.record))) };
}

function corroboratedOmittedDiscussionRecords(candidates = [], discussion = [], sourceUnits = [], options = {}) {
  const unitsById = new Map(normaliseSourceUnits(sourceUnits).map((unit) => [unit.id, unit]));
  const eligible = (Array.isArray(candidates) ? candidates : []).filter((candidate) =>
    ['discussion_point', 'decision', 'open_question'].includes(candidate?.recordType)
    && ['primary', 'recovery', 'staged'].includes(candidate?.sourcePass)
    && candidate?.text && candidate?.evidenceIds?.length
  ).filter((candidate) => {
    const evidence = (candidate.evidenceIds || []).map((id) => unitsById.get(id)).filter(Boolean)
      .map((unit) => `${unit.speaker || ''}: ${unit.text || ''}`).join(' ');
    if (evidence && evidenceSupportScore(candidate.text, evidence) >= 0.22) return true;
    // A correctly expanded source year is not an unsupported quantity. Use
    // the same anchored value proof as normalisation, while still requiring
    // support from an ID this candidate actually supplied.
    if (!options.meetingDate) return false;
    const resolved = resolveEvidence(candidate.text, sourceUnits, candidate.evidenceIds, options);
    return resolved.supportScore >= 0.22
      && resolved.evidenceIds.some(id => candidate.evidenceIds.includes(id));
  });
  const represented = flattenHybridDiscussion(discussion);
  const groups = [];
  for (const candidate of eligible) {
    const group = groups.find((items) => items.some((other) => {
      const sameTopic = String(other.topic || '').toLowerCase() === String(candidate.topic || '').toLowerCase()
        || hybridTokenOverlap(other.topic, candidate.topic) >= 0.55;
      const lexical = hybridContentTokenOverlap(other.text, candidate.text);
      const evidence = new Set(other.evidenceIds || []);
      const sharedEvidence = (candidate.evidenceIds || []).some((id) => evidence.has(id));
      return sameTopic && (lexical >= 0.5 || (sharedEvidence && lexical >= 0.25));
    }));
    if (group) group.push(candidate);
    else groups.push([candidate]);
  }
  const additions = [];
  const sourceRank = { primary: 3, recovery: 2, staged: 1 };
  const typeRank = { decision: 3, open_question: 2, discussion_point: 1 };
  const explicitlyMaterial = (candidate) => candidate.recordType === 'decision'
    || candidate.recordType === 'open_question'
    || /\b(?:agree(?:d|ment)?|decid(?:e|ed|ion)|approv(?:e|ed|al)|block(?:ed|er|ing)?|risk|depend(?:s|ent|ency)?|subject to|unresolved|required|must|standard|regulation|scope|deadline|target|increase|decrease|quantity|total|percent|%|\d+(?:[.,]\d+)?)\b/i
      .test(String(candidate.text || ''));
  for (const group of groups) {
    const sources = new Set(group.map((candidate) => candidate.sourcePass));
    // Independent discovery corroboration is the normal route. A strongly
    // material decision or unresolved matter may also survive from one source,
    // but it remains subject to evidence validation above and compacting below.
    if (sources.size < 2 && !group.some(explicitlyMaterial)) continue;
    if (group.some((candidate) => represented.some((item) => {
      const sameTopic = String(item.topic || '').toLowerCase() === String(candidate.topic || '').toLowerCase()
        || hybridTokenOverlap(item.topic, candidate.topic) >= 0.55;
      return sameTopic && (hybridCandidateMatchesRecord(candidate, item.record)
        || hybridContentTokenOverlap(candidate.text, item.record?.text) >= 0.58);
    }))) continue;
    const preferred = [...group].sort((left, right) => Number(sourceRank[right.sourcePass] || 0) - Number(sourceRank[left.sourcePass] || 0)
      || Number(typeRank[right.recordType] || 0) - Number(typeRank[left.recordType] || 0)
      || String(right.text).length - String(left.text).length)[0];
    additions.push({
      ...preferred,
      evidenceIds: [...new Set(group.flatMap((candidate) => candidate.evidenceIds || []))].slice(0, 12),
      sourcePasses: [...sources]
    });
  }
  const byTopic = new Map();
  for (const candidate of additions) {
    const topic = meetingMinutesAgentText(candidate.topic || 'Additional evidenced points', 240);
    if (!byTopic.has(topic)) byTopic.set(topic, { topic, points: [], decisions: [], openQuestions: [] });
    const key = candidate.recordType === 'decision' ? 'decisions'
      : candidate.recordType === 'open_question' ? 'openQuestions' : 'points';
    byTopic.get(topic)[key].push({
      ...(candidate.record || {}), text: candidate.text,
      evidenceIds: [...new Set(candidate.evidenceIds || [])].slice(0, 8)
    });
  }
  return normaliseAgentResult({ discussion: [...byTopic.values()] }, sourceUnits, 'discussion', options).discussion;
}

function exactDiscussionTwinEvidence(candidate = {}, candidates = [], sourceUnits = [], options = {}, rejectedIds = new Set()) {
  const hasEvidence = (row) => (Array.isArray(row?.evidenceIds) && row.evidenceIds.length)
    || (Array.isArray(row?.record?.evidenceIds) && row.record.evidenceIds.length);
  const rejected = (row) => row?.reviewerAuthored === true || row?.record?.reviewerAuthored === true
    || rejectedIds.has(String(row?.candidateId || ''))
    || ['reject', 'rejected'].includes(row?.dispositionHint)
    || row?.record?.discoveryDisposition === 'reject'
    || [row, row?.record].some(value => value?._unsupportedEvidenceIds?.length || value?._weakEvidenceIds?.length);
  if (!['discussion_point', 'decision', 'open_question'].includes(candidate.recordType)
    || typeof candidate.text !== 'string' || !candidate.text || hasEvidence(candidate) || rejected(candidate)
    || (candidate.record?.text && candidate.record.text !== candidate.text)) return [];
  // Navigation, presentation and provenance may differ between discovery
  // passes. Every other field, including any actor, timing, qualification or
  // explicit transcript-version metadata, must describe the identical claim.
  const navigation = new Set(['candidateId', 'sourcePass', 'recordType', 'topic', 'text', 'evidenceIds', 'record',
    'priority', 'sequence', 'context', 'focusText', 'focusEvidenceId', 'dispositionHint', 'kindHints', 'clusterMembers']);
  const provenance = new Set(['id', 'text', 'evidenceIds', 'reviewFlagIds', 'supportingDetails', 'primaryEvidenceIds', 'discoveryDisposition']);
  const stable = (value) => Array.isArray(value) ? value.map(stable)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  const fields = (value, ignored) => Object.fromEntries(Object.entries(value || {}).filter(([key]) => !ignored.has(key)));
  const claimKey = (row) => JSON.stringify(stable([
    row.recordType, row.text, fields(row, navigation), fields(row.record, provenance)
  ]));
  const key = claimKey(candidate);
  const twins = (Array.isArray(candidates) ? candidates : []).filter(twin => twin && twin !== candidate
    && twin.candidateId !== candidate.candidateId && ['primary', 'recovery'].includes(twin.sourcePass)
    && !rejected(twin) && twin.text === candidate.text
    && (!twin.record?.text || twin.record.text === twin.text) && claimKey(twin) === key);
  const requested = (row) => [...new Set((Array.isArray(row.evidenceIds) ? row.evidenceIds : row.record?.evidenceIds || [])
    .filter(id => typeof id === 'string' && id))];
  // This is an empty-slot repair, not overflow handling. Do not reorder or
  // evict existing citations, or truncate a ninth source to make a union fit.
  const union = [...new Set(twins.flatMap(requested))];
  if (!union.length || union.length > 8) return [];
  const validated = new Set();
  for (const twin of twins) {
    const supplied = requested(twin);
    if (!supplied.length) continue;
    const resolved = resolveEvidence(candidate.text, sourceUnits, supplied, options);
    // Reuse only surviving supplied evidence. A remap to newly found sources
    // or an invalid/weak donor is not proof that its original links were valid.
    if (resolved.invalidIds.length || resolved.weakIds.length || !resolved.evidenceIds.length
      || resolved.evidenceIds.some(id => !supplied.includes(id))) continue;
    resolved.evidenceIds.forEach(id => validated.add(id));
  }
  return [...validated].sort();
}

function reconstructMissingRefereeDiscussion(discussion = [], dispositions = [], candidates = [], sourceUnits = [], options = {}) {
  const result = (Array.isArray(discussion) ? discussion : []).map((topic) => ({
    ...topic,
    points: [...(topic.points || [])],
    decisions: [...(topic.decisions || [])],
    openQuestions: [...(topic.openQuestions || [])]
  }));
  const existingIds = new Set(flattenHybridDiscussion(result)
    .map((item) => String(item.record?.id || '')).filter(Boolean));
  const candidatesById = new Map((Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => candidate?.candidateId).map((candidate) => [String(candidate.candidateId), candidate]));
  const groups = new Map();
  for (const disposition of Array.isArray(dispositions) ? dispositions : []) {
    const kind = disposition?.disposition || disposition?.classification;
    const candidateId = String(disposition?.candidateId || '');
    const candidate = candidatesById.get(candidateId);
    const targetId = refereeDiscussionTargetId(disposition)
      || (kind === 'core' ? candidateId : '');
    if (!targetId || kind === 'reject' || !candidate
      || !['discussion_point', 'decision', 'open_question'].includes(candidate.recordType)) continue;
    if (!groups.has(targetId)) groups.set(targetId, []);
    groups.get(targetId).push({ disposition, kind, candidate });
  }
  const reconstructedTargetIds = [];
  const rejectedIds = new Set((Array.isArray(dispositions) ? dispositions : [])
    .filter(item => (item?.disposition || item?.classification) === 'reject').map(item => String(item.candidateId || '')));
  const sourceRank = { primary: 5, recovery: 4, staged: 3, deterministic: 2, unknown: 1 };
  const typeRank = { decision: 3, open_question: 2, discussion_point: 1 };
  for (const [targetId, group] of groups) {
    if (existingIds.has(targetId)) continue;
    const eligible = group.filter((item) => item.kind === 'core');
    // An invalid merge reference is unresolved checking, not permission to
    // promote its supporting material into a new primary proposition.
    const selected = [...eligible].sort((left, right) =>
      Number(!isRawTranscriptDiscussionPoint(right.candidate.text)) - Number(!isRawTranscriptDiscussionPoint(left.candidate.text))
      || Number(sourceRank[right.candidate.sourcePass] || 0) - Number(sourceRank[left.candidate.sourcePass] || 0)
      || Number(typeRank[right.candidate.recordType] || 0) - Number(typeRank[left.candidate.recordType] || 0)
      || Number(right.candidate.priority || 0) - Number(left.candidate.priority || 0)
      || String(right.candidate.text || '').length - String(left.candidate.text || '').length)[0];
    if (!selected?.candidate?.text) continue;
    // Supporting text retains its own citations below. It must not donate
    // those citations to the primary claim before its placement is checked;
    // later detaching a misplaced child cannot otherwise undo that donation.
    const evidenceIds = [...new Set(eligible.flatMap((item) => [
      ...(item.candidate.evidenceIds || item.candidate.record?.evidenceIds || []),
      ...(Array.isArray(item.disposition.evidenceIds) ? item.disposition.evidenceIds : [])
    ]))].slice(0, 12);
    if (!evidenceIds.length) evidenceIds.push(...exactDiscussionTwinEvidence(
      selected.candidate, candidates, sourceUnits, options, rejectedIds
    ));
    const record = {
      ...(selected.candidate.record || {}), id: targetId,
      text: selected.candidate.text, evidenceIds,
      primaryEvidenceIds: [...new Set([
        ...(selected.candidate.evidenceIds || selected.candidate.record?.evidenceIds || []),
        ...(Array.isArray(selected.disposition.evidenceIds) ? selected.disposition.evidenceIds : [])
      ])].filter(id => evidenceIds.includes(id)).slice(0, 12),
      supportingDetails: group
        .filter((item) => item !== selected && ['supporting', 'merge'].includes(item.kind))
        .map((item) => ({
          ...(item.candidate.record || {}),
          id: item.candidate.record?.id || item.candidate.candidateId,
          text: item.candidate.text,
          originalTopic: item.candidate.record?.originalTopic || item.candidate.originalTopic || item.candidate.topic,
          evidenceIds: [...new Set([
            ...(item.candidate.evidenceIds || item.candidate.record?.evidenceIds || []),
            ...(Array.isArray(item.disposition.evidenceIds) ? item.disposition.evidenceIds : [])
          ])].slice(0, 8)
        }))
    };
    const topicName = meetingMinutesAgentText(selected.candidate.topic, 240) || 'Discussion';
    let topic = result.find((item) => item.topic.toLowerCase() === topicName.toLowerCase())
      || result.find((item) => hybridTokenOverlap(item.topic, topicName) >= 0.6);
    if (!topic) {
      topic = { id: `reconstructed-topic-${result.length + 1}`, topic: topicName, points: [], decisions: [], openQuestions: [] };
      result.push(topic);
    }
    const key = selected.candidate.recordType === 'decision' ? 'decisions'
      : selected.candidate.recordType === 'open_question' ? 'openQuestions' : 'points';
    topic[key].push(record);
    existingIds.add(targetId);
    reconstructedTargetIds.push(targetId);
  }
  return {
    discussion: carryExactDiscussionProvenance(result,
      normaliseAgentResult({ discussion: result }, sourceUnits, 'discussion', options).discussion),
    exactPublicationOrigins: result,
    reconstructedTargetIds,
    referencedTargetIds: [...groups.keys()],
    unresolvedTargetIds: [...groups.keys()].filter((id) => !existingIds.has(id))
  };
}

function enrichDiscussionEvidenceFromDispositions(discussion = [], dispositions = [], candidates = []) {
  const result = (Array.isArray(discussion) ? discussion : []).map((topic) => ({
    ...topic,
    points: (topic.points || []).map((record) => ({ ...record })),
    decisions: (topic.decisions || []).map((record) => ({ ...record })),
    openQuestions: (topic.openQuestions || []).map((record) => ({ ...record }))
  }));
  const recordRows = result.flatMap((topic) => [...topic.points, ...topic.decisions, ...topic.openQuestions]
    .map((record) => ({ topic: topic.topic || 'Discussion', record })));
  const recordsById = new Map(recordRows.filter((item) => item.record?.id)
    .map((item) => [String(item.record.id), item.record]));
  const candidatesById = new Map((Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => candidate?.candidateId).map((candidate) => [candidate.candidateId, candidate]));
  for (const disposition of Array.isArray(dispositions) ? dispositions : []) {
    const classification = disposition?.disposition || disposition?.classification;
    if (!['core', 'merge'].includes(classification)) continue;
    const targetId = disposition?.mergeTarget || disposition?.targetId
      || disposition?.discussionId || disposition?.targetRecordId || disposition?.primaryId;
    const record = recordsById.get(String(targetId || ''));
    const candidate = candidatesById.get(disposition?.candidateId);
    if (!record || !candidate) continue;
    record.evidenceIds = [...new Set([
      ...(record.evidenceIds || []), ...(candidate.evidenceIds || candidate.record?.evidenceIds || [])
    ])].slice(0, 12);
  }
  const classifiedCandidates = (Array.isArray(dispositions) ? dispositions : []).flatMap((disposition) => {
    const classification = disposition?.disposition || disposition?.classification;
    const candidate = candidatesById.get(disposition?.candidateId);
    return candidate && ['core', 'merge'].includes(classification) ? [{ candidate, disposition }] : [];
  });
  for (const row of recordRows.filter((item) => !(item.record.evidenceIds || []).length)) {
    const ranked = classifiedCandidates.map((item) => {
      const lexical = hybridContentTokenOverlap(row.record.text, item.candidate.text || item.candidate.record?.text || '');
      const topic = hybridTokenOverlap(row.topic, item.candidate.topic || '') * 0.3;
      return { ...item, score: lexical + topic };
    }).filter((item) => item.score >= 0.28)
      .sort((left, right) => right.score - left.score);
    if (!ranked.length) continue;
    row.record.evidenceIds = [...new Set(ranked.filter((item) => item.score >= ranked[0].score - 0.12)
      .slice(0, 3).flatMap((item) => item.candidate.evidenceIds || item.candidate.record?.evidenceIds || []))].slice(0, 12);
  }
  return result;
}

module.exports = {
  corroboratedOmittedDiscussionRecords,
  discussionRefereeFallbackPlan,
  refereeClusterSupportingCandidates,
  discussionRefereeSufficiency,
  enrichDiscussionEvidenceFromDispositions,
  reconstructMissingRefereeDiscussion,
  exactDiscussionTwinEvidence
};
