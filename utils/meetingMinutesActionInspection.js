'use strict';
const D = require('./meetingMinutesActionDiagnostics');
const R = require('./canonicalMinutes/actionSemanticReconciliation');
const { normaliseSemanticPolicy } = require('./meetingMinutesSemanticPolicy');

// Explicit developer inspection of saved records; no network, authority or writes.
async function inspect(draft, positions, options = {}) {
  if (!Array.isArray(positions) || positions.length !== 2 || positions[0] === positions[1]
    || positions.some(n => !Number.isInteger(n) || n < 1 || n > (draft.actions || []).length)) {
    throw Error('Supply two different 1-based action positions from this saved draft.');
  }
  const rows = positions.map(n => draft.actions[n - 1]);
  const saved = draft.qualityState?.actions?.semanticReconciliation;
  const policy = normaliseSemanticPolicy(saved?.policy);
  const { audit, value } = await D.capture(() => {
    const packet = policy.mode === 'off' ? { candidates: [], unresolved: [] } : R.prepareActionReconciliation({ actions: rows, sourceUnits: draft.sourceUnits || [], ...policy,
      protectedActionIds: draft.keptActionIds || [], protectedOccurrenceIds: draft.keptActionOccurrenceIds || [],
      meetingDate: draft.details?.meetingDate || '' });
    const local = options.localDedupe ? options.localDedupe(structuredClone(rows), { sourceUnits: draft.sourceUnits || [] }) : null;
    return { policyActive: policy.mode !== 'off', candidates: packet.candidates.map(c => ({ id: c.candidateId, leftIntoRight: c.leftIntoRight, rightIntoLeft: c.rightIntoLeft })),
      unresolved: packet.unresolved, localOutputCount: local?.length ?? null,
      mechanicalDirections: [R.mechanicalCoverage(rows[0], rows[1]), R.mechanicalCoverage(rows[1], rows[0])] };
  }, { targeted: true, sourceHash: D.hash(draft.sourceUnits || []) });
  const trace = draft.qualityState?.actions?.actionDiagnostics;
  const traceRefs = new Set((trace?.nodes || []).filter(n => rows.some(r => D.hash(r) === D.hash(n.record))).map(n => n.ref));
  const matchedFinalSnapshots = traceRefs.size;
  const lineageEvents = new Set();
  let expanded = true;
  while (expanded && trace) {
    expanded = false;
    for (const e of trace.events) {
      const borrowingProposal = e.kind === 'owner_borrow_proposed' && traceRefs.has(e.inputs[0]);
      if (!borrowingProposal && !e.outputs.some(ref => traceRefs.has(ref))) continue;
      lineageEvents.add(e.sequence);
      // Referee candidate IDs are explicitly pass-qualified by the candidate
      // ledger. This is a recorded namespace hand-off, not a local-ID guess.
      if (e.candidateId) {
        for (const origin of trace.events.filter(o => o.origin?.candidateId === e.candidateId)) {
          lineageEvents.add(origin.sequence);
          for (const ref of origin.outputs) if (!traceRefs.has(ref)) { traceRefs.add(ref); expanded = true; }
        }
      }
      if (e.resolutionEvent) {
        lineageEvents.add(e.resolutionEvent);
        const resolution = trace.events.find(r => r.sequence === e.resolutionEvent);
        for (const ref of [...(resolution?.inputs || []), ...(resolution?.outputs || [])]) if (!traceRefs.has(ref)) { traceRefs.add(ref); expanded = true; }
      }
      // Register-level observations are not individual parentage assertions.
      if (['semantic_register', 'final_register'].includes(e.kind)) continue;
      for (const ref of e.inputs) if (!traceRefs.has(ref)) { traceRefs.add(ref); expanded = true; }
    }
  }
  // Existing candidate metadata is evidence of an origin, not proof of the full lineage.
  const candidateEvidence = (draft.candidateLedger || []).filter(c => c.recordType === 'action'
    && rows.some(r => c.text === r.action));
  return { version: D.VERSION, positions, actions: structuredClone(rows), policy,
    assessment: value, nominationTrace: audit, savedReconciliation: saved ? {
      inputHash: saved.inputHash, stats: saved.stats, assessment: saved.assessment,
      caveat: 'Saved aggregate counts describe the original full register, not this isolated pair.' } : null,
    lineage: trace ? { availability: trace.sourceHash && trace.sourceHash !== D.hash(draft.sourceUnits || []) ? 'source_changed' : matchedFinalSnapshots ? 'captured' : 'snapshot_not_matched', matchedFinalSnapshots, truncated: trace.truncated, errors: trace.errors,
      nodes: trace.nodes.filter(n => traceRefs.has(n.ref)),
      events: trace.events.filter(e => lineageEvents.has(e.sequence)),
      caveat: 'Hashes bind exact snapshots. A missing match is not inferred to be the same action.' }
      : { availability: 'historical_not_captured', missing: ['normalisation transitions', 'bundle membership', 'owner donor', 'restoration transitions'],
        caveat: 'This older draft predates action diagnostics. Replaying a helper is a reproduction, not a historical event.' },
    candidateEvidence: structuredClone(candidateEvidence), sourceReferences: [...new Set(rows.flatMap(r => r.evidenceIds || []))],
    productionWrites: 0, providerCalls: 0 };
}
module.exports = { inspect };
