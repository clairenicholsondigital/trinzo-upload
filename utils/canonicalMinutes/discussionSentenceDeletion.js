'use strict';

// Assessment-only deletion plans. No live generation call site and no new prose.
const safety = require('./discussionMergeSafety');
const key = value => value?.recordId + '|' + value?.clauseIndex;
const dependent = text => /\b(?:this|that|these|those|it|its|they|their|them|he|his|she|her|therefore|however|then|again|respectively|former|latter|subsequently|previously)\b/i.test(text)
  || /["“”«»]|(?:^|\s)'/.test(text) || safety.conditions(text).length > 0;
const validRef = (candidate, ref) => ref && Number.isInteger(ref.clauseIndex) && ref.clauseIndex >= 0
  && candidate.rows.some(row => row.record.id === ref.recordId && ref.clauseIndex < row.clauses.length);
function eligible(candidate) {
  return candidate.sourceUnits.length <= 12
    && (candidate.rows.length === 1 || candidate.rows[0].record.evidenceIds.some(id =>
      candidate.rows.every(row => row.record.evidenceIds.includes(id))))
    && candidate.rows.every(row =>
    row.clauses.length >= 2 && row.clauses.every(text => !dependent(text)));
}
function plan(candidate, deletions) {
  if (!eligible(candidate) || !Array.isArray(deletions) || !deletions.length) return null;
  const removed = new Set();
  for (const deletion of deletions) {
    if (!validRef(candidate, deletion) || !validRef(candidate, deletion.coveredBy)
      || Object.keys(deletion).some(field => !['recordId', 'clauseIndex', 'coveredBy'].includes(field))
      || Object.keys(deletion.coveredBy).some(field => !['recordId', 'clauseIndex'].includes(field))
      || key(deletion) === key(deletion.coveredBy) || removed.has(key(deletion))) return null;
    removed.add(key(deletion));
  }
  const sentence = ref => candidate.rows.find(row => row.record.id === ref.recordId).clauses[ref.clauseIndex];
  for (const deletion of deletions) {
    if (removed.has(key(deletion.coveredBy))
      || !safety.claimsCompatible(sentence(deletion), sentence(deletion.coveredBy))) return null;
  }
  const proposedRows = candidate.rows.map(row => ({ ...row.record,
    text: row.clauses.filter((_, clauseIndex) => !removed.has(key({ recordId: row.record.id, clauseIndex }))).join(' ') }));
  if (proposedRows.some(row => !row.text.trim())) return null;
  return { ...candidate, deletions: structuredClone(deletions), proposedRows,
    proposedText: proposedRows.map(row => row.text).join(' '),
    outputClauses: candidate.rows.flatMap(row => row.clauses.filter((_, clauseIndex) =>
      !removed.has(key({ recordId: row.record.id, clauseIndex })))) };
}
function verified(candidate, checks) {
  if (!Array.isArray(checks) || checks.length !== candidate.deletions.length) return false;
  const seen = new Set();
  for (const check of checks) {
    const deletion = candidate.deletions.find(row => key(row) === key(check));
    if (!deletion || seen.has(key(check)) || !validRef(candidate, check.coveredBy)
      || key(deletion.coveredBy) !== key(check.coveredBy) || check.equivalent !== true
      || !Array.isArray(check.sourceIds) || !check.sourceIds.length
      || new Set(check.sourceIds).size !== check.sourceIds.length
      || check.sourceIds.some(id => !candidate.sourceUnits.some(source => source.id === id))) return false;
    seen.add(key(check));
  }
  return true;
}
module.exports = { eligible, plan, verified };
