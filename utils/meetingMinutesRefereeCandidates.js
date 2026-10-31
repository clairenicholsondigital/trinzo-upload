'use strict';

const { meetingMinutesAgentText } = require('./meetingMinutesPlainText');
const { hybridTokenOverlap, hybridContentTokenOverlap } = require('./meetingMinutesRecordMatching');
const { isRawTranscriptDiscussionPoint } = require('./stagedEditorial');
const { selectSupportingDetailParent } = require('./canonicalMinutes/supportingDetailPlacement');
const { isPublishableTopicLabel } = require('./canonicalMinutes/topicEditorial');
const crypto = require('crypto');
const { TIMING_POLICY_VERSION } = require('./meetingMinutesTiming');
const { refereeDiscussionTargetId } = require('./meetingMinutesResponseContracts');

function discussionInformationTokens(value = '') {
  const stop = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'those', 'these', 'then', 'than', 'their', 'there', 'will', 'would', 'could', 'should']);
  const stem = (token) => {
    if (token.length > 6 && /ing$/.test(token)) return token.slice(0, -3);
    if (token.length > 5 && /ed$/.test(token)) return token.slice(0, -2);
    if (token.length > 5 && /es$/.test(token)) return token.slice(0, -2);
    if (token.length > 4 && /s$/.test(token)) return token.slice(0, -1);
    return token;
  };
  return new Set((String(value || '').toLowerCase().match(/[a-z0-9][a-z0-9'’–-]{2,}/g) || [])
    .filter((token) => !stop.has(token)).map(stem));
}

function hybridCandidatePack(candidates = [], maxChars = 70000, maxCandidates = 320) {
  const sourceRank = { recovery: 4, primary: 3, staged: 2, deterministic: 1 };
  const ordered = [...(Array.isArray(candidates) ? candidates : [])]
    .sort((left, right) => Number(['action_chain', 'action_thread'].includes(right.recordType)) - Number(['action_chain', 'action_thread'].includes(left.recordType))
      || Number(sourceRank[right.sourcePass] || 0) - Number(sourceRank[left.sourcePass] || 0)
      || Number(right.priority || 0) - Number(left.priority || 0)
      || Number(left.sequence || 0) - Number(right.sequence || 0));
  const result = [];
  let chars = 2;
  for (const item of ordered) {
    if (result.length >= maxCandidates) break;
    const compact = {
      candidateId: item.candidateId, sourcePass: item.sourcePass, recordType: item.recordType,
      topic: item.topic, text: item.text, owners: item.record?.owners || item.owners,
      timing: item.record?.timing || item.timing, evidenceIds: item.evidenceIds,
      timingDecision: item.record?.timingDecision || item.timingDecision,
      focusEvidenceId: item.focusEvidenceId, cueKinds: item.cueKinds,
      dispositionHint: item.dispositionHint, priority: item.priority, sequence: item.sequence,
      ...(['action_chain', 'action_thread'].includes(item.recordType) ? {
        candidateIds: item.candidateIds, ownerHints: item.ownerHints,
        timingEvidenceIds: item.timingEvidenceIds, dependencyEvidenceIds: item.dependencyEvidenceIds,
        ...(item.recordType === 'action_chain' ? {
          signals: item.signals, scores: item.scores, uncertainties: item.uncertainties,
          eventUnits: item.eventUnits, topicAnchors: item.topicAnchors
        } : {}),
        context: meetingMinutesAgentText(item.context, meetingAgentCandidateContextChars())
      } : item.sourcePass === 'deterministic' && Number(item.priority || 0) >= 8 ? {
        context: meetingMinutesAgentText(item.context, 1200)
      } : {})
    };
    const size = JSON.stringify(compact).length + 1;
    if (chars + size > maxChars) continue;
    result.push(compact); chars += size;
  }
  return result.sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
}

function meetingAgentCandidateContextChars() {
  const value = Number(process.env.MEETING_MINUTES_AGENT_CANDIDATE_CONTEXT_CHARS);
  return Number.isFinite(value) && value >= 400 ? Math.min(5000, Math.floor(value)) : 5000;
}

function meetingAgentCandidateTimingSignature(candidate = {}, includeKind = true) {
  const timing = (candidate.record || candidate).timing || {};
  return JSON.stringify([...(includeKind ? [meetingMinutesAgentText(timing.kind, 40).toLowerCase()] : []),
    meetingMinutesAgentText(timing.wording, 220).toLowerCase(), meetingMinutesAgentText(timing.exactDate, 20)]);
}

function meetingAgentRefereeCandidates(stage, candidates = []) {
  const rows = Array.isArray(candidates) ? candidates : [];
  const sourceRank = { recovery: 4, primary: 3, staged: 2, deterministic: 1 };
  const recordRank = { decision: 4, open_question: 3, discussion_point: 2 };
  const distinct = (items) => {
    const retained = [];
    for (const candidate of items) {
      const evidence = new Set(candidate.evidenceIds || []);
      const duplicate = retained.some((existing) => existing.recordType === candidate.recordType
        // Different source timing claims need separate adjudication. A model
        // enum difference for the identical wording/date is still one claim.
        && (candidate.recordType !== 'action' || meetingAgentCandidateTimingSignature(existing, false) === meetingAgentCandidateTimingSignature(candidate, false))
        && hybridTokenOverlap(existing.text, candidate.text) >= 0.72
        && (candidate.evidenceIds || []).some((id) => (existing.evidenceIds || []).includes(id)));
      if (!duplicate || !evidence.size) retained.push(candidate);
    }
    return retained;
  };
  const discussionTopicKey = (candidate) => {
    const topic = meetingMinutesAgentText(candidate?.topic, 240).toLowerCase();
    // Untitled transcript windows are one source group, even when their words
    // happen to hit several editorial facets. Otherwise raw windows consume a
    // slot per facet in every round and displace named, readable discoveries.
    if (!topic) return 'untitled-evidence';
    const value = `${topic} ${candidate?.text || ''}`.toLowerCase();
    // Discovery passes often give the same workstream slightly different
    // headings. Group those headings by general editorial facet before the
    // finite Referee selection, otherwise 24 one-row topic labels can displace
    // later material completely. This only affects coverage/attachment; the
    // Referee still decides whether every representative is core or context.
    const facets = [
      ['risk-dependency', /\b(?:risks?|block(?:ed|er|ers|ing)?|depend(?:s|ent|ents|ency|encies)?|subject to|constraints?|unresolved|pending|awaiting)\b/],
      ['access-confidentiality', /\b(?:access|confidential|sharepoint|document sharing|secure transmission|permission)\b/],
      ['software-security', /\b(?:software|cyber|security|sbom|component|version|validation|debug)\b/],
      ['scope-standards', /\b(?:scope|standard|regulat(?:ion|ory)|compliance|product|requirement|audit focus)\b/],
      ['timing-logistics', /\b(?:schedule|timing|date|day|week|month|travel|hotel|site|logistics|calendar)\b/],
      ['roles-responsibilities', /\b(?:role|responsib(?:le|ility)|owner|lead|staff|team|attendee)\b/]
    ];
    const matched = facets.filter(([, pattern]) => pattern.test(value)).map(([name]) => name);
    if (matched.length) return matched.slice(0, 2).join('|');
    if (topic) {
      const tokens = [...discussionInformationTokens(topic)].slice(0, 3);
      return tokens.length ? `topic:${tokens.join('-')}` : topic;
    }
    // Raw deterministic windows have no editorial topic. Treat them as one
    // source group so they cannot consume most of the finite Referee batch at
    // the expense of already structured topic candidates.
    return 'untitled-evidence';
  };
  const discussionSalience = (candidate) => {
    const text = String(candidate?.text || '');
    const material = /\b(?:agree(?:d|ment)?|decid(?:e|ed|ion)|approv(?:e|ed|al)|block(?:ed|er|ing)?|risk|depend(?:s|ent|ency)?|subject to|unresolved|required|must|standard|regulation|scope|deadline|target|responsib(?:le|ility)|owner|lead|increase|decrease|\d+(?:[.,]\d+)?%?)\b/i.test(text);
    const readable = !isRawTranscriptDiscussionPoint(text);
    const editorialRank = readable && ['primary', 'recovery'].includes(candidate?.sourcePass) ? 2
      : readable && candidate?.sourcePass === 'staged' ? 1 : 0;
    return editorialRank * 1000 + Number(recordRank[candidate?.recordType] || 0) * 100
      + Number(material) * 30
      + Number(sourceRank[candidate?.sourcePass] || 0) * 10
      + Number(candidate?.priority || 0);
  };
  const propositionClusters = (items) => {
    const clusters = [];
    for (const candidate of items) {
      const evidence = new Set(candidate.evidenceIds || []);
      const cluster = clusters.find((group) => group.some((other) => {
        const lexical = hybridContentTokenOverlap(other.text, candidate.text);
        const sharedEvidence = (other.evidenceIds || []).some((id) => evidence.has(id));
        const leftNumbers = new Set(String(other.text || '').match(/\b\d+(?:[.,]\d+)?%?\b/g) || []);
        const rightNumbers = new Set(String(candidate.text || '').match(/\b\d+(?:[.,]\d+)?%?\b/g) || []);
        // Only a genuine quantity conflict keeps two phrasings apart. Requiring
        // the same *count* of numbers split "order 13 kilos Monday" from
        // "order 13 kilos by the 15th" into separate clusters, and each then
        // released its own paraphrases as context. Same rule as
        // supportingDetailAddsInformation.
        const incompatibleNumbers = leftNumbers.size && rightNumbers.size
          && ![...leftNumbers].some((value) => rightNumbers.has(value));
        if (incompatibleNumbers) return false;
        const leftTopic = discussionInformationTokens(other.topic || '');
        const rightTopic = discussionInformationTokens(candidate.topic || '');
        const topicCompatible = !leftTopic.size || !rightTopic.size
          || [...leftTopic].some((token) => rightTopic.has(token));
        const subjectMatch = selectSupportingDetailParent({ text: candidate.text },
          [{ record: { id: other.candidateId, text: other.text } }]).target;
        return Boolean(subjectMatch) && ((topicCompatible && lexical >= 0.56)
          || (sharedEvidence && lexical >= 0.28));
      }));
      if (cluster) cluster.push(candidate);
      else clusters.push([candidate]);
    }
    return clusters.map((cluster) => {
      const ordered = [...cluster].sort((left, right) =>
        discussionSalience(right) - discussionSalience(left)
        || Number(left.sequence || 0) - Number(right.sequence || 0));
      return {
        ...ordered[0],
        clusterMembers: ordered.slice(1).map((member) => ({
          candidateId: member.candidateId,
          sourcePass: member.sourcePass,
          recordType: member.recordType,
          topic: member.topic,
          text: member.text,
          evidenceIds: member.evidenceIds,
          priority: member.priority,
          sequence: member.sequence,
          clusterRelation: 'paraphrase'
        })).slice(0, 12)
      };
    });
  };
  const balancedDiscussion = (items, limit) => {
    // Reserve one independent assessment per named primary/recovery subject.
    // Secondary extractor headings are not equivalent evidence of a new
    // subject: promoting each heading to its own group displaced qualified
    // primary statements with more assertive secondary summaries in replay.
    const named = new Map();
    for (const candidate of items) {
      if (!['primary', 'recovery'].includes(candidate.sourcePass)
        || !isPublishableTopicLabel(candidate.topic) || isRawTranscriptDiscussionPoint(candidate.text)) continue;
      const key = String(candidate.topic).toLowerCase().replace(/\s+/g, ' ').trim();
      if (!named.has(key)) named.set(key, []);
      named.get(key).push(candidate);
    }
    const selected = [];
    for (const group of named.values()) {
      if (selected.length >= limit) break;
      const best = propositionClusters(group).sort((left, right) => discussionSalience(right) - discussionSalience(left)
        || Number(left.sequence || 0) - Number(right.sequence || 0))[0];
      if (best) selected.push(best);
    }
    const reservedIds = new Set(selected.flatMap(candidate => [candidate.candidateId,
      ...(candidate.clusterMembers || []).map(member => member.candidateId)]));
    const groups = new Map();
    items.forEach((candidate) => {
      if (reservedIds.has(candidate.candidateId)) return;
      const key = discussionTopicKey(candidate);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(candidate);
    });
    // A broad Agent topic can contain several genuinely different
    // propositions. Collapse source-level paraphrases first, then round-robin
    // the distinct propositions so repeated schedule or background rows do not
    // displace scope, risk, dependency or decision content.
    for (const [key, group] of groups) groups.set(key,
      propositionClusters(group).sort((left, right) =>
        discussionSalience(right) - discussionSalience(left)
        || Number(left.sequence || 0) - Number(right.sequence || 0)));
    while (selected.length < limit) {
      let added = false;
      for (const group of groups.values()) {
        if (!group.length || selected.length >= limit) continue;
        selected.push(group.shift());
        added = true;
      }
      if (!added) break;
    }
    // Unselected distinct propositions stay in the private ledger. The
    // selection-coverage handoff retains editorial overflow for review without
    // attaching it to a different subject or inventing a referee verdict.
    return selected;
  };
  if (stage === 'discussion') {
    // The structured Prompt emits one record per candidate. Large, repetitive
    // discovery ledgers can exceed its response budget even when their input
    // fits. Referee only the strongest distinct propositions; the complete
    // ledger remains available to the deterministic recovery path below.
    return balancedDiscussion(hybridCandidatePack(
      rows.filter((candidate) => ['discussion_point', 'decision', 'open_question'].includes(candidate?.recordType)),
      42000, 100
    ), Math.max(14, Math.min(32,
      Number(process.env.MEETING_MINUTES_AGENT_DISCUSSION_REFEREE_CANDIDATE_LIMIT || 24))))
      .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
  }
  // Preserve both polished action candidates and the strongest multi-turn
  // lifecycle evidence. If chains are allowed to consume the whole character
  // budget, the disposition-only response has nothing suitable to reconstruct
  // into formal action wording.
  const actions = distinct(hybridCandidatePack(
    rows.filter((candidate) => candidate?.recordType === 'action'), 30000, 60
  )).slice(0, 16);
  const lifecycles = distinct(hybridCandidatePack(
    rows.filter((candidate) => ['action_chain', 'action_thread'].includes(candidate?.recordType)), 18000, 30
  )).slice(0, 8);
  return [...actions, ...lifecycles]
    .slice(0, Math.max(14, Math.min(32,
      Number(process.env.MEETING_MINUTES_AGENT_ACTION_REFEREE_CANDIDATE_LIMIT || 24))))
    .sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
}

function meetingMinutesAgentRefereeContract(stage, candidates = [], requestId = crypto.randomUUID(), options = {}) {
  const isDiscussion = stage === 'discussion';
  // Select once from discovery. Batches and repairs are exact subsets of that
  // selection, never another opportunity to cluster away a supplied identity.
  const copied = structuredClone(candidates);
  const supplied = options.selected ? copied : meetingAgentRefereeCandidates(stage, copied);
  const retainedDiscussionTargets = structuredClone(options.retainedDiscussionTargets || []);
  return Object.freeze({
    requestId,
    stage: isDiscussion ? 'DISCUSSION_REFEREE' : 'ACTION_REFEREE',
    candidates: Object.freeze(supplied.map((candidate) => Object.freeze(candidate))),
    expectedCandidateIds: Object.freeze(supplied.map((candidate) => candidate.candidateId)),
    ...(retainedDiscussionTargets.length ? {
      retainedDiscussionTargets: Object.freeze(retainedDiscussionTargets.map((target) => Object.freeze(target))),
      knownDiscussionTargetIds: Object.freeze(retainedDiscussionTargets.map((target) => target.targetId))
    } : {})
  });
}

function compactMeetingAgentRefereeCandidate(candidate = {}, options = {}) {
  const compact = {
    candidateId: meetingMinutesAgentText(candidate.candidateId, 160),
    sourcePass: meetingMinutesAgentText(candidate.sourcePass, 80),
    recordType: meetingMinutesAgentText(candidate.recordType, 80),
    topic: meetingMinutesAgentText(candidate.topic, 240),
    text: meetingMinutesAgentText(candidate.text, 1400),
    owners: (Array.isArray(candidate.owners) ? candidate.owners : [])
      .map((owner) => meetingMinutesAgentText(owner, 180)).filter(Boolean).slice(0, 8),
    timing: candidate.timing && typeof candidate.timing === 'object' ? {
      kind: meetingMinutesAgentText(candidate.timing.kind, 40),
      wording: meetingMinutesAgentText(candidate.timing.wording, 220),
      exactDate: meetingMinutesAgentText(candidate.timing.exactDate, 20)
    } : undefined,
    ...(candidate.timingDecision ? { timingProvenance: {
      status: meetingMinutesAgentText(candidate.timingDecision.status, 40),
      policyVersion: TIMING_POLICY_VERSION,
      source: 'application_assessment_not_source_evidence',
      // A rejected exact date can coexist with supported timing wording.
      // Keep the recorded scope so that status does not imply both were rejected.
      rejectedExactDates: (Array.isArray(candidate.timingDecision.rejectedExactDates)
        ? candidate.timingDecision.rejectedExactDates : [])
        .filter((value) => typeof value === 'string')
        .map((value) => meetingMinutesAgentText(value, 20)).filter(Boolean).slice(0, 8),
      rejectedWordings: (Array.isArray(candidate.timingDecision.rejectedWordings)
        ? candidate.timingDecision.rejectedWordings : [])
        .filter((value) => typeof value === 'string')
        .map((value) => meetingMinutesAgentText(value, 220)).filter(Boolean).slice(0, 8)
    } } : {}),
    evidenceIds: [...new Set((Array.isArray(candidate.evidenceIds) ? candidate.evidenceIds : [])
      .map((id) => meetingMinutesAgentText(id, 30)).filter(Boolean))].slice(0, 20),
    focusEvidenceId: meetingMinutesAgentText(candidate.focusEvidenceId, 30),
    ...(options.independentDiscussionJudgement ? {} : {
      dispositionHint: meetingMinutesAgentText(candidate.dispositionHint, 80),
      priority: Number(candidate.priority || 0)
    }),
    sequence: Number(candidate.sequence || 0)
  };
  // Discussion cluster members are deliberately not copied into the Referee's
  // candidate object. The Referee classifies the representative proposition;
  // letting secondary context influence that single disposition caused whole
  // clusters to become core. Their evidence windows are still included in the
  // prepared evidence packet, and the server attaches the grounded member rows
  // as collapsed supporting detail after classification.
  if (['action_chain', 'action_thread'].includes(compact.recordType)) {
    Object.assign(compact, {
      candidateIds: (Array.isArray(candidate.candidateIds) ? candidate.candidateIds : [])
        .map((id) => meetingMinutesAgentText(id, 160)).filter(Boolean).slice(0, 20),
      cueKinds: (Array.isArray(candidate.cueKinds) ? candidate.cueKinds : [])
        .map((kind) => meetingMinutesAgentText(kind, 80)).filter(Boolean).slice(0, 20),
      ownerHints: (Array.isArray(candidate.ownerHints) ? candidate.ownerHints : [])
        .map((owner) => meetingMinutesAgentText(owner, 180)).filter(Boolean).slice(0, 8),
      timingEvidenceIds: (Array.isArray(candidate.timingEvidenceIds) ? candidate.timingEvidenceIds : [])
        .map((id) => meetingMinutesAgentText(id, 30)).filter(Boolean).slice(0, 12),
      dependencyEvidenceIds: (Array.isArray(candidate.dependencyEvidenceIds) ? candidate.dependencyEvidenceIds : [])
        .map((id) => meetingMinutesAgentText(id, 30)).filter(Boolean).slice(0, 12),
      signals: candidate.signals && typeof candidate.signals === 'object' ? candidate.signals : undefined,
      uncertainties: (Array.isArray(candidate.uncertainties) ? candidate.uncertainties : [])
        .map((value) => meetingMinutesAgentText(value, 240)).filter(Boolean).slice(0, 8)
    });
  }
  return Object.fromEntries(Object.entries(compact).filter(([, value]) => value !== undefined
    && value !== '' && (!Array.isArray(value) || value.length)));
}

function effectiveDiscussionRefereeDispositions(dispositions = [], candidates = []) {
  const rows = (Array.isArray(dispositions) ? dispositions : []).map((item) => ({ ...item }));
  const candidatesById = new Map((Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => candidate?.candidateId)
    .map((candidate) => [String(candidate.candidateId), candidate]));
  const facetKey = (candidate) => {
    const value = `${candidate?.topic || ''} ${candidate?.text || ''}`.toLowerCase();
    const facets = [
      ['risk-dependency', /\b(?:risk|block(?:ed|er|ing)?|depend(?:s|ent|ency)?|subject to|constraint|unresolved|pending|awaiting)\b/],
      ['access-confidentiality', /\b(?:access|confidential|sharepoint|document sharing|secure transmission|permission)\b/],
      ['software-security', /\b(?:software|cyber|security|sbom|component|version|validation)\b/],
      ['scope-standards', /\b(?:scope|standard|regulat(?:ion|ory)|compliance|product|requirement|audit focus)\b/],
      ['timing-logistics', /\b(?:schedule|timing|date|day|week|month|travel|hotel|site|logistics|calendar)\b/],
      ['roles-responsibilities', /\b(?:role|responsib(?:le|ility)|owner|lead|staff|team|attendee)\b/]
    ];
    const matched = facets.filter(([, pattern]) => pattern.test(value)).map(([name]) => name);
    if (matched.length) return matched.slice(0, 2).join('|');
    const topicTokens = [...discussionInformationTokens(candidate?.topic || '')].slice(0, 3);
    return topicTokens.length ? `topic:${topicTokens.join('-')}` : 'general-context';
  };
  const groups = new Map();
  for (const row of rows) {
    const candidate = candidatesById.get(String(row?.candidateId || ''));
    if (!candidate) continue;
    const facet = facetKey(candidate);
    if (!groups.has(facet)) groups.set(facet, []);
    groups.get(facet).push({ row, candidate });
  }
  const materiallyVisible = (candidate) => candidate?.recordType === 'decision'
    || candidate?.recordType === 'open_question'
    || /\b(?:agree(?:d|ment)?|decid(?:e|ed|ion)|approv(?:e|ed|al)|block(?:ed|er|ing)?|risk|depend(?:s|ent|ency)?|subject to|unresolved|required|must|standard|regulation|scope|deadline|target|responsib(?:le|ility)|owner|lead|increase|decrease|monday|tuesday|wednesday|thursday|friday|week|month|year|\d+(?:[.,]\d+)?%?)\b/i
      .test(String(candidate?.text || ''));
  const rank = ({ candidate }) => Number(candidate?.recordType === 'decision') * 50
    + Number(candidate?.recordType === 'open_question') * 40
    + Number(materiallyVisible(candidate)) * 20
    + Number(candidate?.priority || 0);
  for (const group of groups.values()) {
    const usable = group.filter(({ row }) => ['core', 'supporting'].includes(row.disposition || row.classification));
    let anchors = usable.filter(({ row }) => (row.disposition || row.classification) === 'core');
    if (!anchors.length && usable.length) {
      const anchor = [...usable].sort((left, right) => rank(right) - rank(left))[0];
      anchor.row.disposition = 'core';
      anchor.row.targetId = anchor.row.targetId || anchor.candidate.candidateId;
      anchor.row.websitePromotedFrom = materiallyVisible(anchor.candidate)
        ? 'material_supporting_anchor' : 'orphaned_supporting';
      anchors = [anchor];
    }
    if (!anchors.length) continue;
    const anchorTarget = refereeDiscussionTargetId(anchors[0].row) || anchors[0].candidate.candidateId;
    for (const item of usable) {
      if ((item.row.disposition || item.row.classification) !== 'supporting') continue;
      if (!refereeDiscussionTargetId(item.row)) item.row.targetId = anchorTarget;
    }
  }
  return rows;
}

module.exports = {
  compactMeetingAgentRefereeCandidate,
  discussionInformationTokens,
  effectiveDiscussionRefereeDispositions,
  hybridCandidatePack,
  meetingAgentCandidateTimingSignature,
  meetingAgentRefereeCandidates,
  meetingMinutesAgentRefereeContract
};
