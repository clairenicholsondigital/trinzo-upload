'use strict';
const { validateReconciliationReceipt } = require('./canonicalMinutes/actionSemanticReconciliation');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const sameEnquiryActionSnapshot = (left, right) => JSON.stringify(stable(left)) === JSON.stringify(stable(right));
function originalEnquiryActions(draft) {
  const audit = draft.qualityState?.actions?.semanticReconciliation;
  if (!audit?.applied || audit.policy?.scope !== 'contact_enquiries' || !audit.receipts?.length
    || !Array.isArray(audit.original) || !Array.isArray(audit.restoreSnapshot)
    || draft.keptActionIds?.length || draft.keptActionOccurrenceIds?.length
    || !sameEnquiryActionSnapshot(draft.actions, audit.restoreSnapshot)) return null;
  if (!audit.receipts.every(receipt => draft.actions.some(action =>
    validateReconciliationReceipt(receipt, receipt.original, action, draft.sourceUnits || [])))) return null;
  return structuredClone(audit.original);
}
module.exports = { originalEnquiryActions, sameEnquiryActionSnapshot };
