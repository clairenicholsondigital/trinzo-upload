'use strict';
// Nomination only. No wording similarity, shared citation or warning establishes
// equivalence. The contained-requirement source/retention contract owns proof.
const {hash}=require('../meetingMinutesProofHash');
const {isReviewerAuthored}=require('./state');
const fields=new Set(['id','occurrenceId','action','owners','timing','timingDecision','evidenceIds','reviewFlagIds']);
const clean=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/[.!]+$/,'').replace(/\s+/g,' ').trim();
const words=value=>(clean(value).match(/[\p{L}\p{N}]+/gu)||[]).filter(word=>!['a','an','the','of','with','and','to','it'].includes(word));
function eligible(row){
 const t=row?.timing,d=row?.timingDecision;
 return row&&Object.keys(row).every(key=>fields.has(key))&&!isReviewerAuthored(row)
  &&row.owners?.length===1&&String(row.owners[0]).trim()
  &&['dependency','target'].includes(t?.kind)&&Boolean(t.wording)&&!t.exactDate
  &&d&&['unresolved','rejected'].includes(d.status)&&!d.binding?.conflictingSourceIds?.length
  &&Array.isArray(row.evidenceIds)&&row.evidenceIds.length>0&&row.evidenceIds.length<=8
  &&new Set(row.evidenceIds).size===row.evidenceIds.length
  &&Array.isArray(row.reviewFlagIds)&&row.reviewFlagIds.length<=24
  &&typeof row.action==='string'&&!/[;?\n]|[.!].+\S/.test(row.action);
}
function shape(parent,child){
 if(!eligible(parent)||!eligible(child)||clean(parent.owners[0])!==clean(child.owners[0])
  ||parent.timing.kind!==child.timing.kind||!parent.evidenceIds.some(id=>child.evidenceIds.includes(id))
  ||new Set([...parent.evidenceIds,...child.evidenceIds]).size>8
  ||new Set([...parent.reviewFlagIds,...child.reviewFlagIds]).size>24)return null;
 // Only an existing fuller record may survive, independent of input order.
 const size=row=>clean(row.action).length+clean(row.timing.wording).length;
 if(size(parent)<=size(child))return null;
 const a=words(parent.action),b=words(child.action),common=[...new Set(b)].filter(word=>a.includes(word));
 if(a.length<4||b.length<4||hash(a.slice(0,2))!==hash(b.slice(0,2))
  ||common.length<3||common.length/Math.min(new Set(a).size,new Set(b).size)<0.55)return null;
 if([...parent.timingDecision.rejectedWordings||[],...child.timingDecision.rejectedWordings||[]]
  .some(wording=>clean(wording)===clean(parent.timing.wording)))return null;
 return {kind:'qualified_repeat'};
}
module.exports={shape};
