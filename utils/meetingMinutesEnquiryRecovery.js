'use strict';
const { validateReconciliationReceipt } = require('./canonicalMinutes/actionSemanticReconciliation');
const { isActionOnlySemanticScope } = require('./meetingMinutesSemanticPolicy');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const sameEnquiryActionSnapshot = (left, right) => JSON.stringify(stable(left)) === JSON.stringify(stable(right));
function originalEnquiryActions(draft) {
  const phase=draft.qualityState?.actions?.actionPhaseCorrection;
  if(phase?.applied && !draft.keptActionIds?.length && !draft.keptActionOccurrenceIds?.length)
    return require('./meetingMinutesActionPhaseCorrection').restore(draft.actions,phase,draft.sourceUnits||[],draft.details?.meetingDate||'');
  const union=draft.qualityState?.actions?.actionUnionRewrite;
  if(union?.version==='compilation-union-v1'&&union.applied&&!draft.keptActionIds?.length&&!draft.keptActionOccurrenceIds?.length)
    return require('./meetingMinutesCompilationUnion').restore(draft.actions,union,draft.sourceUnits||[],draft.details?.meetingDate||'');
  const audit = draft.qualityState?.actions?.semanticReconciliation;
  if (!audit?.applied || !isActionOnlySemanticScope(audit.policy?.scope) || !audit.receipts?.length
    || !Array.isArray(audit.original) || !Array.isArray(audit.restoreSnapshot)
    || draft.keptActionIds?.length || draft.keptActionOccurrenceIds?.length
    || !sameEnquiryActionSnapshot(draft.actions, audit.restoreSnapshot)) return null;
  if (!audit.receipts.every(receipt => draft.actions.some(action =>
    validateReconciliationReceipt(receipt, receipt.original, action, draft.sourceUnits || [])))) return null;
  return structuredClone(audit.original);
}
module.exports = { originalEnquiryActions, sameEnquiryActionSnapshot };
