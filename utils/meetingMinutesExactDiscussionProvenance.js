'use strict';

const safety = require('./canonicalMinutes/discussionMergeSafety');
const fields = ['points', 'decisions', 'openQuestions'];
const flatten = discussion => (discussion || []).flatMap(topic => fields.flatMap(kind =>
  (topic[kind] || []).map(record => ({ topic, kind, record }))));

// Only the app's already-normalised discussion trees may call this bridge.
// Exact unchanged claims and complete surviving metadata establish identity;
// neither a similarity merge nor an external/model-supplied alias does so.
function carryExactDiscussionProvenance(before = [], after = []) {
  const original = flatten(before), surviving = flatten(after);
  const beforeCounts = safety.identityCounts(before), afterCounts = safety.identityCounts(after);
  const eligible = ({ topic, record }) => !safety.protectedTopic(topic)
    && safety.mergeableRecord(record);
  const aliases = new Map();
  for (const source of original) {
    const r = source.record;
    if (!eligible(source) || r.supportingDetails?.length || beforeCounts.get(r.id) !== 1) continue;
    const matches = surviving.filter(target => eligible(target) && target.kind === source.kind
      && afterCounts.get(target.record.id) === 1 && target.record.text === r.text
      && r.evidenceIds.every(id => target.record.evidenceIds.includes(id))
      && (r.reviewFlagIds || []).every(id => (target.record.reviewFlagIds || []).includes(id)));
    if (matches.length !== 1) continue;
    const target = matches[0].record;
    // Re-derive only identities actually present in the trusted input tree.
    // A historical alias alone may have come from an older approximate merge.
    const predecessors = [r.id].filter(id => id !== target.id);
    if (predecessors.some(id => afterCounts.has(id))) continue;
    for (const id of predecessors) {
      const owners = aliases.get(id) || new Set(surviving
        .filter(row => (row.record.mergedFromIds || []).includes(id)).map(row => row.record.id));
      owners.add(target.id); aliases.set(id, owners);
    }
  }
  return after.map(topic => Object.fromEntries(Object.entries(topic).map(([key, value]) =>
    !fields.includes(key) ? [key, value] : [key, value.map(record => {
      const add = [...aliases].filter(([, owners]) => owners.size === 1 && owners.has(record.id)).map(([id]) => id);
      const history = [...new Set([...(record.mergedFromIds || []), ...add])];
      if (!add.length || history.length > 1000) return record;
      return { ...record, mergedFromIds: history };
    })])));
}

module.exports = { carryExactDiscussionProvenance };
