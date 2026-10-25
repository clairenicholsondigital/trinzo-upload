'use strict';
// Isolated feasibility harness. Never imported by a route or worker. Its output
// is an assessment queue; it cannot change, remove or publish an action.
const { createHash } = require('node:crypto');
const { mechanicalCoverage } = require('../../utils/canonicalMinutes/actionSemanticReconciliation');
const clone = value => structuredClone(value);
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const relations = new Set(['distinct', 'equivalent', 'left_covered_by_right', 'right_covered_by_left', 'partial_overlap', 'unresolved']);
function prepare(input = {}) {
  const actions = clone(input.actions || []), sourceUnits = clone(input.sourceUnits || []);
  const sources = new Map();
  for (const source of sourceUnits) {
    if (!source.id || sources.has(source.id)) throw Error('Source IDs must be present and unique.');
    sources.set(source.id, source);
  }
  // Bound research cost explicitly; never silently truncate the register.
  if (actions.length > 100) throw Error('Research register exceeds the 100-action budget.');
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
  const body = { version: 'global-action-register-research-v1', rows, sourceUnits, comparisons,
    unresolvedContext: clone(input.unresolvedContext || []) };
  return { ...body, packetHash: hash(body) };
}
function prompt(packet) {
  return 'RESEARCH ONLY. Compare every supplied pair against its full source context. Classify distinct, equivalent, left_covered_by_right, right_covered_by_left, partial_overlap or unresolved. Same owner or overlapping source lines never proves coverage. Preserve separate operations, recipients, conditions, effective dates versus deadlines, quantities, methods, occurrence, uncertainty and warnings. A letter containing an explanation may be one deliverable or separate work: determine from the source, never the leading verb. Groups remain unmapped context. Do not write replacement actions. Return {packetHash, decisions:[{comparisonId, relation, reason}]}, exactly one decision per pair. Every consolidation nomination still needs independent source-backed coverage and qualification before any production edit.\n' + JSON.stringify(packet);
}
function assess(packet, response) {
  const { packetHash, ...body } = packet;
  if (hash(body) !== packetHash || response?.packetHash !== packetHash) throw Error('Changed or stale register.');
  if (!Array.isArray(response.decisions) || response.decisions.length !== packet.comparisons.length) throw Error('Incomplete comparison accounting.');
  const expected = new Map(packet.comparisons.map(pair => [pair.comparisonId,pair])), seen = new Set();
  const queue = response.decisions.map(decision => {
    const pair = expected.get(decision.comparisonId);
    if (!pair || seen.has(decision.comparisonId) || !relations.has(decision.relation) || !String(decision.reason || '').trim()) throw Error('Invalid comparison decision.');
    seen.add(decision.comparisonId);
    return { ...clone(decision), leftRef: pair.leftRef, rightRef: pair.rightRef,
      status: ['equivalent','left_covered_by_right','right_covered_by_left'].includes(decision.relation)
        ? 'needs_independent_source_verification' : 'assessment_only' };
  });
  return { actions: packet.rows.map(row=>clone(row.action)), unresolvedContext: clone(packet.unresolvedContext),
    comparisons: queue, appliedEdits: 0, productionQualified: false };
}
module.exports = { prepare, prompt, assess };
