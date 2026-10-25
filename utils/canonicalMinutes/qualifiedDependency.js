'use strict';
// A separate proof class. It never changes dependency wording or timing status.
const {hash}=require('../meetingMinutesProofHash');
const {actionProvenanceSignature}=require('../meetingMinutesActionIdentity');
const {isReviewerAuthored}=require('./state');
const C=require('./containedRequirement');
const VERSION='qualified-dependency-v1';
const FIELDS=new Set(['id','occurrenceId','action','owners','timing','timingDecision','evidenceIds','reviewFlagIds']);
const canonical=value=>String(value||'').normalize('NFKC').replace(/[’]/g,"'").toLowerCase().replace(/\s+/g,' ').trim().replace(/[.!]+$/,'').trim();
const prohibited=/\b(?:if|unless|after|before|once|when|until|pending|following|without|never|not|only|either|or|maybe|perhaps|probably|possibly|tentatively|deadline|due|today|tomorrow|yesterday|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|next|last|previous|each|every)\b|\d|[;?\n"“”:()[\]{}]/i;
const words=value=>(canonical(value).match(/[\p{L}\p{N}]+/gu)||[]).filter(w=>!['a','an','the','to','of','for','in','with','by','required'].includes(w)).map(w=>w.length>3?w.replace(/s$/,''):w);
function eligible(row){
 const decision=row?.timingDecision;
 return row&&Object.keys(row).every(key=>FIELDS.has(key))&&!isReviewerAuthored(row)&&row.owners?.length===1&&String(row.owners[0]).trim()
  &&row.timing?.kind==='dependency'&&!row.timing.exactDate&&/^Dependent on\s+\S/i.test(row.timing.wording||'')&&!row.reviewFlagIds?.length
  &&Array.isArray(row.evidenceIds)&&row.evidenceIds.length>0&&row.evidenceIds.length<=8&&new Set(row.evidenceIds).size===row.evidenceIds.length
  &&!decision?.checkerStatus&&decision?.status==='unresolved'&&decision.reason==='timing_source_unresolved'&&decision.binding?.status==='unresolved'
  &&!decision.binding.conflictingSourceIds?.length&&!decision.rejectedExactDates?.length&&!decision.rejectedWordings?.length
  &&!prohibited.test(row.action+' '+row.timing.wording)
  &&!/[.!?]/.test(String(row.action).replace(/[.!?]+$/,''))
  &&!/[.!?]/.test(String(row.timing.wording).replace(/[.!?]+$/,''))
  &&!/\b(?:and|then)\s+(?:send|share|provide|review|check|approve|buy|purchase|fit|install|call|email|submit|publish|generate|create|prepare|compile|update|test)\b/i.test(row.action);
}
function method(row){return String(row.action).match(/^\s*(?:complete|finish|resolve)\s+(.+?)\s+by\s+(generating|creating|compiling|updating|preparing|testing)\s+(.+?)[.!]?\s*$/i);}
function shape(parent,child){
 if(!eligible(parent)||!eligible(child)||canonical(parent.owners[0])!==canonical(child.owners[0])
  ||String(parent.timingDecision.meetingDate||'')!==String(child.timingDecision.meetingDate||''))return null;
 const a=method(parent),b=method(child);if(!a||!b||a[2].toLowerCase()!==b[2].toLowerCase())return null;
 const full=canonical(parent.timing.wording),short=canonical(child.timing.wording);
 // A strict literal dependency prefix, with only a route/provider extension,
 // chooses the fuller existing row. Same-length or competing conditions hold.
 if(!full.startsWith(short+' ')||! /^(?:through|via|from)\s+[\p{L}\s-]+$/u.test(full.slice(short.length+1)))return null;
 const left=[...new Set(words(a[3]))],right=[...new Set(words(b[3]))],common=left.filter(w=>right.includes(w));
 if(common.length<2||common.length/Math.max(1,Math.min(left.length,right.length))<0.6)return null;
 if(!parent.evidenceIds.some(id=>child.evidenceIds.includes(id))||new Set([...parent.evidenceIds,...child.evidenceIds]).size>8)return null;
 return {method:a[2].toLowerCase(),dependency:full};
}
function direction(left,right,all=[left,right]){
 for(const [parent,child]of[[left,right],[right,left]])if(shape(parent,child)
  &&all.filter(row=>shape(row,child)).length===1&&all.filter(row=>hash(row)===hash(child)).length===1)return {parent,child};
 return null;
}
function reviewPacket(parent,child,sourceUnits,contextSourceIds,challenge){
 const cited=new Set([...parent.evidenceIds,...child.evidenceIds]);
 if(sourceUnits.some(unit=>cited.has(unit.id)&&/\b(?:withdrawn|cancelled|canceled|no action|no longer (?:required|needed))\b/i.test(String(unit.text||''))))throw Error('dependency_source_withdrawal');
 return C.reviewPacket(parent,child,sourceUnits,contextSourceIds,challenge,{qualifiedDependency:true});
}
function certify(parent,child,sourceUnits,contextSourceIds,primary,challenge){
 if(!shape(parent,child))throw Error('dependency_shape_not_eligible');
 const R=require('./actionSemanticReconciliation'),N=require('../meetingMinutesActionReferenceReview');
 const atomic=R.prepareActionReconciliation({actions:[parent,child],sourceUnits});
 if(atomic.rows.some(row=>row.clauses.length!==1))throw Error('dependency_compound_instruction');
 const packets=[reviewPacket(parent,child,sourceUnits,contextSourceIds,false),reviewPacket(parent,child,sourceUnits,contextSourceIds,true)];
 for(const [index,response]of[primary,challenge].entries()){
  const packet=packets[index],assessment=N.assess(packet,response);
  if(assessment.contractError||!assessment.modelPassed||assessment.relationship?.relation!=='same_obligation'
   ||response.decisions.find(s=>s.kind==='source').rows.some(row=>row.basis!=='commitment'))throw Error(assessment.contractError||'dependency_independent_veto');
  const required=packet.retentionRequests.find(check=>check.field==='timing');
  const timing=response.decisions.find(s=>s.kind==='retention').checks.find(check=>check.id===required?.id);
  if(!timing?.refs.some(id=>packet.survivorCatalog.find(ref=>ref.id===id)?.field==='timing.wording'))throw Error('dependency_wording_witness_missing');
 }
 const evidenceIds=[...new Set([...parent.evidenceIds,...child.evidenceIds,...packets.flatMap((packet,index)=>C.sourceIds(packet,[primary,challenge][index]))])].sort();
 if(evidenceIds.length>8)throw Error('dependency_evidence_capacity');
 if(evidenceIds.some(id=>sourceUnits.filter(unit=>unit.id===id).length!==1||sourceUnits.some(unit=>unit.id===id&&unit.classification==='remove'&&!unit.restored)))throw Error('dependency_ineligible_source');
 const body={version:VERSION,sourceHash:hash(sourceUnits),parent:structuredClone(parent),child:structuredClone(child),contextSourceIds:[...contextSourceIds],
  primary:structuredClone(primary),challenge:structuredClone(challenge),expectedSurvivor:{...structuredClone(parent),evidenceIds,reviewFlagIds:[]}};
 return {...body,reviewHash:hash(body)};
}
function valid(packet,certificate,original,survivor){
 try{
  if(!certificate||certificate.version!==VERSION||certificate.sourceHash!==hash(packet.sourceUnits||[])
   ||!certificate.parent||!certificate.child||!certificate.expectedSurvivor||!original?.action||!survivor?.action)return false;
  const {reviewHash,...body}=certificate;if(hash(body)!==reviewHash)return false;
  if(![certificate.parent,certificate.child].some(row=>hash(row)===hash(original.action))
   ||![certificate.parent,certificate.expectedSurvivor].some(row=>actionProvenanceSignature(row)===actionProvenanceSignature(survivor.action)))return false;
  return certify(certificate.parent,certificate.child,packet.sourceUnits,certificate.contextSourceIds,certificate.primary,certificate.challenge).reviewHash===reviewHash;
 }catch{return false;}
}

function conflicts(packet,proof,original,survivor,reasons){
 if(!proof?.qualifiedDependency)return reasons;
 return valid(packet,proof.qualifiedDependency,original,survivor)?reasons.filter(reason=>!['different_operation','different_timing'].includes(reason)):[...reasons,'invalid_qualified_dependency_review'];
}
function coverage(packet,parentRow,childRow,certificate){
 return C.coverage(packet,parentRow,childRow,certificate).map(({containedRequirement,...proof})=>({...proof,qualifiedDependency:certificate}));
}
function validMapping(packet,proof,original,survivor){
 if(!valid(packet,proof.qualifiedDependency,original,survivor))return false;
 const atomic=require('./actionSemanticReconciliation').prepareActionReconciliation({actions:[survivor.action,original.action],sourceUnits:packet.sourceUnits});
 const [parentRow,originalRow]=atomic.rows.map((row,index)=>({...row,ref:index===0?survivor.ref:original.ref}));
 const expected=coverage({...packet,rows:[parentRow,originalRow]},parentRow,originalRow,proof.qualifiedDependency)[1];
 return hash(proof.semanticProof)===hash(expected.semanticProof)&&hash(proof.sourceSpans)===hash(expected.sourceSpans);
}
module.exports={VERSION,eligible,shape,direction,reviewPacket,certify,valid,conflicts,coverage,validMapping};
