'use strict';
// Immutable pair inventory for source reviews; never edits action records.
const { createHash } = require('node:crypto');
const mechanicalCoverage=(...args)=>require('./canonicalMinutes/actionSemanticReconciliation').mechanicalCoverage(...args);
const clone = value => structuredClone(value);
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
function prepare(input = {}) {
  const actions = clone(input.actions || []), sourceUnits = clone(input.sourceUnits || []);
  const sources = new Map();
  for (const source of sourceUnits) {
    if (!source.id || sources.has(source.id)) throw Error('Source IDs must be present and unique.');
    sources.set(source.id, source);
  }
  // Bound review cost explicitly; never silently truncate the register.
  if (actions.length > 100) throw Error('Review register exceeds the 100-action budget.');
  const rows = actions.map((action, index) => ({ ref: `action-${index}-${hash(action).slice(0,16)}`, action,
    unresolvedSourceIds: (action.evidenceIds || []).filter(id => !sources.has(id)),
    sources: (action.evidenceIds || []).filter(id => sources.has(id)).map(id => sources.get(id)) }));
  const comparisons = [];
  for (let i=0;i<rows.length;i++) for(let j=i+1;j<rows.length;j++) {
    const left = rows[i], right = rows[j];
    comparisons.push({ comparisonId: hash([left.ref, right.ref]).slice(0,24), leftRef: left.ref, rightRef: right.ref,
      // Same first verb / owner / source overlap are neither gates nor proof.
      leftCoveredByRight: mechanicalCoverage(left.action, right.action),
      rightCoveredByLeft: mechanicalCoverage(right.action, left.action) });
  }
  const body = { version: 'action-review-register-v1', rows, sourceUnits, comparisons,
    unresolvedContext: clone(input.unresolvedContext || []) };
  return { ...body, packetHash: hash(body) };
}
module.exports={prepare};
