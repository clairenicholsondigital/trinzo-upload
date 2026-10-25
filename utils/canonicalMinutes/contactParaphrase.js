'use strict';
// A separate opt-in class for contact-purpose paraphrases; no wording edits.
const {hash}=require('../meetingMinutesProofHash');
const {actionProvenanceSignature}=require('../meetingMinutesActionIdentity');
const {isReviewerAuthored}=require('./state');
const C=require('./containedRequirement');
const VERSION='contact-paraphrase-v1';
const canonical=value=>String(value||'').normalize('NFKC').replace(/[’]/g,"'").toLowerCase().replace(/\s+/g,' ').trim().replace(/[.!]+$/,'').trim();
const prohibited=/\b(?:if|unless|after|before|once|when|until|pending|following|without|never|not|only|either|or|maybe|perhaps|probably|possibly|tentatively|deadline|due|today|tomorrow|yesterday|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|next|last|previous|each|every|send|share|provide|deliver|approve|prepare|create|compile|update|implement|buy|purchase|fit|install|submit|publish|review|test)\b|\d|[;?\n"“”:()[\]{}]/i;
const words=value=>[...new Set((canonical(value).match(/[\p{L}]+/gu)||[]).filter(w=>!['a','an','the','to','of','for','in','with','on','and','associated','related'].includes(w)))].sort();
function frame(value){
 const text=String(value||'').trim().replace(/[.!]+$/,'');
 if(prohibited.test(text)||/[.!?]/.test(text))return null;
 const follow=text.match(/^(?:follow\s+up|speak|talk)\s+(?:with|to)\s+(.+?)\s+to\s+(?:obtain|get|seek)\s+clarity\s+(?:on|about|regarding)\s+(.+)$/i);
 const discuss=text.match(/^discuss\s+with\s+(.+?)\s+(.+?)\s+and\s+(?:obtain|get|seek)\s+clarity\s+(?:on|about|regarding)\s+(.+)$/i);
 const match=follow||discuss;if(!match||!/^\p{Lu}[\p{L}'’-]*(?:\s+\p{Lu}[\p{L}'’-]*){0,3}$/u.test(match[1]))return null;
 const purpose=words(follow?match[2]:match[2]+' '+match[3]);
 if(purpose.length<4||purpose.length>40)return null;
 return {recipient:canonical(match[1]),purpose};
}
function eligible(row){return C.eligible(row)&&!!frame(row.action);}
function shape(parent,child){
 if(!eligible(parent)||!eligible(child)||canonical(parent.owners[0])!==canonical(child.owners[0])
  ||canonical(parent.action).length<=canonical(child.action).length)return null;
 const a=frame(parent.action),b=frame(child.action);
 // Exact informative purpose vocabulary nominates only. Source/retention proof
 // still checks recipient, meaning, occurrence and every obligation twice.
 if(a.recipient!==b.recipient||hash(a.purpose)!==hash(b.purpose))return null;
 if(!parent.evidenceIds.some(id=>child.evidenceIds.includes(id))||new Set([...parent.evidenceIds,...child.evidenceIds]).size>8)return null;
 return {recipient:a.recipient};
}
function direction(left,right,all=[left,right]){
 for(const [parent,child]of[[left,right],[right,left]])if(shape(parent,child)
  &&all.filter(row=>shape(row,child)).length===1&&all.filter(row=>hash(row)===hash(child)).length===1)return {parent,child};
 return null;
}
function reviewPacket(parent,child,sourceUnits,contextSourceIds,challenge){
 const cited=new Set([...parent.evidenceIds,...child.evidenceIds]);
 if(sourceUnits.some(unit=>cited.has(unit.id)&&/\b(?:withdrawn|cancelled|canceled|no action|no longer (?:required|needed))\b/i.test(String(unit.text||''))))throw Error('contact_source_withdrawal');
 return C.reviewPacket(parent,child,sourceUnits,contextSourceIds,challenge,{instructionComparison:'contact_paraphrase'});
}
function certify(parent,child,sourceUnits,contextSourceIds,primary,challenge){
 if(!shape(parent,child))throw Error('contact_shape_not_eligible');
 const R=require('./actionSemanticReconciliation'),N=require('../meetingMinutesActionReferenceReview');
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
 if(!proof?.contactParaphrase)return reasons;
 return valid(packet,proof.contactParaphrase,original,survivor)?reasons.filter(reason=>!['different_operation','different_destination'].includes(reason)):[...reasons,'invalid_qualified_contact_review'];
}
function coverage(packet,parentRow,childRow,certificate){
 return C.coverage(packet,parentRow,childRow,certificate).map(({containedRequirement,...proof})=>({...proof,contactParaphrase:certificate}));
}
function validMapping(packet,proof,original,survivor){
 if(!valid(packet,proof.contactParaphrase,original,survivor))return false;
 const atomic=require('./actionSemanticReconciliation').prepareActionReconciliation({actions:[survivor.action,original.action],sourceUnits:packet.sourceUnits});
 const [parentRow,originalRow]=atomic.rows.map((row,index)=>({...row,ref:index===0?survivor.ref:original.ref}));
 const expected=coverage({...packet,rows:[parentRow,originalRow]},parentRow,originalRow,proof.contactParaphrase)[1];
 return hash(proof.semanticProof)===hash(expected.semanticProof)&&hash(proof.sourceSpans)===hash(expected.sourceSpans);
}
module.exports={VERSION,frame,eligible,shape,direction,reviewPacket,certify,valid,conflicts,coverage,validMapping};
