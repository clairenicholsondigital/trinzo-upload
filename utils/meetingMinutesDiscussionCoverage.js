'use strict';

const KINDS = new Set(['discussion_point', 'decision', 'open_question']);
const rows = discussion => (discussion || []).flatMap(topic =>
  ['points', 'decisions', 'openQuestions'].flatMap(kind => (topic[kind] || [])));
const ids = record => new Set([record?.id, ...(record?.mergedFromIds || [])].filter(Boolean));

// Selection is not adjudication. Only independently supplied candidates and
// genuine paraphrases belong to the assessed set; response-budget overflow
// must never inherit a verdict from an unrelated representative.
function discussionSelectionCoverage(ensemble = [], selected = []) {
  const supplied = new Set(selected.map(candidate => candidate.candidateId));
  const clustered = new Set(selected.flatMap(candidate => (candidate.clusterMembers || [])
    .filter(member => member.clusterRelation !== 'overflow').map(member => member.candidateId)));
  const unassessed = ensemble.filter(candidate => KINDS.has(candidate?.recordType)
    && !supplied.has(candidate.candidateId) && !clustered.has(candidate.candidateId));
  return { suppliedCandidateIds: [...supplied], clusteredCandidateIds: [...clustered],
    unassessedCandidateIds: [...new Set(unassessed.map(candidate => candidate.candidateId))],
    unassessedEditorialCandidates: unassessed.filter(candidate =>
      ['primary', 'recovery', 'staged'].includes(candidate.sourcePass)) };
}

// Track accepted target identities through the actual publication gates, not
// just the reconstruction step. Aliases prove consolidation; similarity alone
// cannot certify that a disappeared proposition survived another sentence.
function discussionPublicationCoverage(discussion = [], dispositions = [], ensemble = [], options = {}) {
  const byId = new Map(ensemble.map(candidate => [candidate.candidateId, candidate]));
  const targets = new Map();
  for (const verdict of dispositions) {
    if ((verdict.disposition || verdict.classification) !== 'core') continue;
    const targetId = String(verdict.targetId || verdict.mergeTarget || verdict.discussionId
      || verdict.targetRecordId || verdict.primaryId || verdict.candidateId || '');
    if (!targetId) continue;
    if (!targets.has(targetId)) targets.set(targetId, []);
    targets.get(targetId).push(verdict.candidateId);
  }
  const allPrimary = rows(discussion);
  const visible = allPrimary.filter(record => Array.isArray(record.evidenceIds) && record.evidenceIds.length);
  const supports = [];
  const seen = new Set();
  const visit = record => {
    if (!record || seen.has(record)) return;
    seen.add(record); supports.push(record);
    for (const child of record.supportingDetails || []) visit(child);
  };
  allPrimary.forEach(record => (record.supportingDetails || []).forEach(visit));
  const filing = options.unassignedSupportingDetails || [];
  const matches = (record, targetId, candidateIds) => {
    const aliases = ids(record);
    if (aliases.has(targetId)) return true;
    return candidateIds.some(id => {
      const candidate = byId.get(id);
      if (aliases.has(id)) return true;
      // Discovery IDs are not necessarily unique across passes. Require the
      // exact claim as well before using that weaker provenance link.
      return candidate?.record?.id && aliases.has(candidate.record.id)
        && record.text === candidate.text;
    });
  };
  const entries = [...targets].map(([targetId, candidateIds]) => {
    const primaries = visible.filter(record => matches(record, targetId, candidateIds));
    const primary = primaries.length === 1 ? primaries[0] : null;
    const supporting = supports.find(record => matches(record, targetId, candidateIds));
    const retained = filing.find(record => matches(record, targetId, candidateIds));
    const withheld = (options.withheldRows || []).find(item => matches(item.record || item, targetId, candidateIds));
    return { targetId, candidateIds, status: primaries.length > 1 ? 'ambiguous' : primary ? 'visible' : supporting ? 'supporting'
      : retained ? 'needs_filing' : withheld ? 'withheld' : 'unmaterialized',
    ...(primary ? { recordId: primary.id } : {}) };
  });
  const unresolvedTargetIds = entries.filter(entry => entry.status !== 'visible').map(entry => entry.targetId);
  return { expectedCoreTargetCount: entries.length, visibleCoreTargetCount: entries.length - unresolvedTargetIds.length,
    complete: unresolvedTargetIds.length === 0, unresolvedTargetIds, targets: entries };
}

module.exports = { discussionSelectionCoverage, discussionPublicationCoverage };
