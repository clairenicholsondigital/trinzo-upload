'use strict';
const C=require('./discussionClaimConsolidation');
const clone=value=>structuredClone(value);
function combine(previous,next,sourceUnits,assessmentKey){
  if(!next.audit.applied)return {...previous,audit:{...previous.audit,[assessmentKey]:{
    method:next.audit.method,candidates:next.audit.candidates,reason:next.audit.reason,packetHash:next.audit.packetHash}}};
  if(!previous.audit.applied)return next;
  if(!C.canRestore(previous.discussion,sourceUnits,previous.audit)
    ||!C.canRestore(next.discussion,sourceUnits,next.audit)||next.audit.inputHash!==C.hash(previous.discussion))return previous;
  return {discussion:next.discussion,audit:{...next.audit,original:clone(previous.audit.original),
    originalHash:previous.audit.originalHash,priorAudit:clone(previous.audit),
    ledger:[...clone(previous.audit.ledger),...clone(next.audit.ledger)],
    affectedTopics:[...new Set([...previous.audit.affectedTopics,...next.audit.affectedTopics].map(t=>t.index))]
      .map(index=>({index,finalHash:C.hash(next.discussion[index])}))}};
}
module.exports={combine};
