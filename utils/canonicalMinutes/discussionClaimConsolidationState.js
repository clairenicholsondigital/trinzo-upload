'use strict';

const crypto = require('node:crypto');

const VERSION = 'discussion-claim-consolidation-v1';
const clone = value => JSON.parse(JSON.stringify(value));
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined
    && !(Array.isArray(value[key]) && !value[key].length)).map(key => [key,
      /^(?:evidenceIds|primaryEvidenceIds|reviewFlagIds|mergedFromIds)$/.test(key) && Array.isArray(value[key])
        ? [...new Set(value[key])].sort() : stable(value[key])])) : value;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

function canRestore(discussion, sourceUnits, audit) {
  return Array.isArray(discussion) && Array.isArray(sourceUnits)
    && audit?.version === VERSION && audit.applied === true
    && Array.isArray(audit.original) && Array.isArray(audit.ledger) && audit.ledger.length > 0
    && audit.sourceHash === hash(sourceUnits) && audit.originalHash === hash(audit.original)
    && Array.isArray(audit.affectedTopics) && audit.affectedTopics.length > 0
    && audit.affectedTopics.every(topic => topic && Number.isInteger(topic.index) && topic.index >= 0
      && discussion[topic.index] && audit.original[topic.index]
      && hash(discussion[topic.index]) === topic.finalHash)
    && new Set(audit.affectedTopics.map(topic => topic.index)).size === audit.affectedTopics.length;
}
function restore(discussion, sourceUnits, audit) {
  if (!canRestore(discussion, sourceUnits, audit)) return null;
  const restored = clone(discussion);
  for (const topic of audit.affectedTopics) restored[topic.index] = clone(audit.original[topic.index]);
  return restored;
}

module.exports = { VERSION, clone, stable, hash, canRestore, restore };
