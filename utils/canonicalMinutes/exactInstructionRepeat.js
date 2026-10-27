'use strict';
// This is a nomination and proof contract, never permission to merge by text.
const {isReviewerAuthored}=require('./state');
const {hash}=require('../meetingMinutesProofHash');
const fields=new Set(['id','occurrenceId','action','owners','timing','timingDecision','evidenceIds','reviewFlagIds']);
const clean=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
function eligible(row){
 const t=row?.timing,d=row?.timingDecision;
 return row&&Object.keys(row).every(key=>fields.has(key))&&!isReviewerAuthored(row)
  &&row.owners?.length===1&&Boolean(clean(row.owners[0]))
  &&['target','deadline'].includes(t?.kind)&&Boolean(clean(t.wording))&&!t.exactDate
  &&d&&['unresolved','rejected'].includes(d.status)&&!d.binding?.conflictingSourceIds?.length
  &&Array.isArray(row.evidenceIds)&&row.evidenceIds.length>0&&row.evidenceIds.length<=8
  &&new Set(row.evidenceIds).size===row.evidenceIds.length
  &&Array.isArray(row.reviewFlagIds)&&row.reviewFlagIds.length<=24
  &&typeof row.action==='string'&&Boolean(clean(row.action))&&!/[;?\n]|[.!].+\S/.test(row.action);
}
function shape(parent,child){
 if(!eligible(parent)||!eligible(child)||parent.timing.kind!=='target'||child.timing.kind!=='deadline'
  ||clean(parent.action)!==clean(child.action)||clean(parent.owners[0])!==clean(child.owners[0])
  ||clean(parent.timing.wording)!==clean(child.timing.wording)
  ||hash([...parent.evidenceIds].sort())!==hash([...child.evidenceIds].sort())
  ||new Set([...parent.reviewFlagIds,...child.reviewFlagIds]).size>24)return null;
 // Prefer the existing target, never promote unresolved timing to a deadline.
 // The two source reviews must still establish one occurrence and full retention.
 if([parent,child].some(row=>(row.timingDecision.rejectedWordings||[])
  .some(wording=>clean(wording)===clean(parent.timing.wording))))return null;
 return {kind:'exact_instruction_repeat'};
}
function reviewRolePassed(assessment,parent,child){
 return Boolean(shape(parent,child)&&assessment.modelPassed
  &&assessment.relationship?.relation==='same_obligation'
  &&assessment.sourceRoles?.length===2&&assessment.sourceRoles.every(row=>row.basis==='commitment'));
}
// ID-independent ordering is only used for this new, spare-capacity class.
function orderKey(row){const {id,occurrenceId,...meaning}=row;return hash(meaning);}
module.exports={shape,reviewRolePassed,orderKey};
