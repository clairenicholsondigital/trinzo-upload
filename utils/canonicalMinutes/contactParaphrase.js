'use strict';
const { frame, eligible, reviewFrame, reviewShape, shape, direction } = require('./contactParaphraseShape');
// A separate opt-in class for contact-purpose paraphrases; no wording edits.
const {hash}=require('../meetingMinutesProofHash');
const {actionProvenanceSignature}=require('../meetingMinutesActionIdentity');
const C=require('./containedRequirement');
const VERSION='contact-paraphrase-v1';
function reviewPacket(parent,child,sourceUnits,contextSourceIds,challenge){
 const cited=new Set([...parent.evidenceIds,...child.evidenceIds]);
 if(sourceUnits.some(unit=>cited.has(unit.id)&&/\b(?:withdrawn|cancelled|canceled|no action|no longer (?:required|needed))\b/i.test(String(unit.text||''))))throw Error('contact_source_withdrawal');
 return C.reviewPacket(parent,child,sourceUnits,contextSourceIds,challenge,{instructionComparison:reviewShape(parent,child)?'contact_review':'contact_paraphrase'});
}
function certify(parent,child,sourceUnits,contextSourceIds,primary,challenge){
 const match=shape(parent,child,true);
 if(!match)throw Error('contact_shape_not_eligible');
 const R=require('./actionReconciliationPreparation'),N=require('../meetingMinutesActionReferenceReview');
 const atomic=R.prepareActionReconciliation({actions:[parent,child],sourceUnits});
 if(atomic.rows.some(row=>row.clauses.length!==1))throw Error('contact_compound_instruction');
 const packets=[reviewPacket(parent,child,sourceUnits,contextSourceIds,false),reviewPacket(parent,child,sourceUnits,contextSourceIds,true)];
 for(const [index,response]of[primary,challenge].entries()){
  const packet=packets[index],assessment=N.assess(packet,response);
  if(assessment.contractError||!assessment.modelPassed||assessment.relationship?.relation!=='same_obligation'
   ||response.decisions.find(s=>s.kind==='source').rows.some(row=>row.basis!=='commitment'))throw Error(assessment.contractError||'contact_independent_veto');

 }
 const evidenceIds=[...new Set([...parent.evidenceIds,...child.evidenceIds,...packets.flatMap((packet,index)=>C.sourceIds(packet,[primary,challenge][index]))])].sort();
 if(evidenceIds.length>8)throw Error('contact_evidence_capacity');
 if(evidenceIds.some(id=>sourceUnits.filter(unit=>unit.id===id).length!==1||sourceUnits.some(unit=>unit.id===id&&unit.classification==='remove'&&!unit.restored)))throw Error('contact_ineligible_source');
 const body={version:VERSION,...(match.reviewContact?{reviewContact:true}:{}),sourceHash:hash(sourceUnits),parent:structuredClone(parent),child:structuredClone(child),contextSourceIds:[...contextSourceIds],
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
 if(!proof?.contactParaphrase)return reasons;
 return valid(packet,proof.contactParaphrase,original,survivor)?reasons.filter(reason=>!['different_operation','different_destination'].includes(reason)):[...reasons,'invalid_qualified_contact_review'];
}
function coverage(packet,parentRow,childRow,certificate){
 return C.coverage(packet,parentRow,childRow,certificate).map(({containedRequirement,...proof})=>({...proof,contactParaphrase:certificate}));
}
function validMapping(packet,proof,original,survivor){
 if(!valid(packet,proof.contactParaphrase,original,survivor))return false;
 const atomic=require('./actionReconciliationPreparation').prepareActionReconciliation({actions:[survivor.action,original.action],sourceUnits:packet.sourceUnits});
 const [parentRow,originalRow]=atomic.rows.map((row,index)=>({...row,ref:index===0?survivor.ref:original.ref}));
 const expected=coverage({...packet,rows:[parentRow,originalRow]},parentRow,originalRow,proof.contactParaphrase)[1];
 return hash(proof.semanticProof)===hash(expected.semanticProof)&&hash(proof.sourceSpans)===hash(expected.sourceSpans);
}
module.exports={VERSION,frame,reviewFrame,reviewShape,eligible,shape,direction,reviewPacket,certify,valid,conflicts,coverage,validMapping};
