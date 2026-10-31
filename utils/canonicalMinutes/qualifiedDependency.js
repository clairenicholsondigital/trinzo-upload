'use strict';
const { eligible, shape, direction } = require('./qualifiedDependencyShape');
// A separate proof class. It never changes dependency wording or timing status.
const {hash}=require('../meetingMinutesProofHash');
const {actionProvenanceSignature}=require('../meetingMinutesActionIdentity');
const C=require('./containedRequirement');
const VERSION='qualified-dependency-v1';
function reviewPacket(parent,child,sourceUnits,contextSourceIds,challenge){
 const cited=new Set([...parent.evidenceIds,...child.evidenceIds]);
 if(sourceUnits.some(unit=>cited.has(unit.id)&&/\b(?:withdrawn|cancelled|canceled|no action|no longer (?:required|needed))\b/i.test(String(unit.text||''))))throw Error('dependency_source_withdrawal');
 return C.reviewPacket(parent,child,sourceUnits,contextSourceIds,challenge,{qualifiedDependency:true});
}
function certify(parent,child,sourceUnits,contextSourceIds,primary,challenge){
 if(!shape(parent,child))throw Error('dependency_shape_not_eligible');
 const R=require('./actionReconciliationPreparation'),N=require('../meetingMinutesActionReferenceReview');
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
 const atomic=require('./actionReconciliationPreparation').prepareActionReconciliation({actions:[survivor.action,original.action],sourceUnits:packet.sourceUnits});
 const [parentRow,originalRow]=atomic.rows.map((row,index)=>({...row,ref:index===0?survivor.ref:original.ref}));
 const expected=coverage({...packet,rows:[parentRow,originalRow]},parentRow,originalRow,proof.qualifiedDependency)[1];
 return hash(proof.semanticProof)===hash(expected.semanticProof)&&hash(proof.sourceSpans)===hash(expected.sourceSpans);
}
module.exports={VERSION,eligible,shape,direction,reviewPacket,certify,valid,conflicts,coverage,validMapping};
