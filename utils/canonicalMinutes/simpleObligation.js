'use strict';
// Nomination only: every deletion requires two source/retention assessments.
const C=require('./containedRequirement'),{hash}=require('../meetingMinutesProofHash'),{actionProvenanceSignature}=require('../meetingMinutesActionIdentity'),{ownerWitness}=require('../meetingMinutesSemanticSourceVerification');
const VERSION='simple-obligation-v1',clone=x=>structuredClone(x);
const canon=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
const forbidden=/\b(?:if|unless|after|before|once|when|until|pending|following|without|not|never|only|either|or|maybe|perhaps|probably|possibly|presumably|ideally|tentatively|today|tomorrow|yesterday|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|next|last|previous|each|every|daily|weekly|days?|weeks?|months?|years?|hours?|minutes?|seconds?|deadline|due)\b|[\d;?\n\/|"“”:()[\]{}]/i;
const words=s=>[...new Set((canon(s).match(/[\p{L}]+/gu)||[]).filter(w=>!['a','an','the','to','of','for','in','with','on','and','both'].includes(w)))];
function eligible(row){return C.eligible(row)&&typeof row.action==='string'&&row.action.length<=800&&/^(?:sign|share|send|review|check)\b/i.test(row.action)&&!forbidden.test(row.action)&&! /\band\b/i.test(row.action);}
function rank(row){return [/\bboth\b/i.test(row.action)?1:0,row.action.length,hash(row)];}
function preferred(a,b){const x=rank(a),y=rank(b);return x[0]!==y[0]?x[0]>y[0]:x[1]!==y[1]?x[1]>y[1]:x[2]>y[2];}
function shape(parent,child,units=[]){
 if(!eligible(parent)||!eligible(child)||canon(parent.action)===canon(child.action)||hash(parent)===hash(child)||!preferred(parent,child)||canon(parent.owners[0])!==canon(child.owners[0])||canon(parent.action).split(' ')[0]!==canon(child.action).split(' ')[0])return null;
 const a=words(parent.action).slice(1),b=words(child.action).slice(1),common=a.filter(w=>b.includes(w)).length;
 if(common<3||common/Math.max(a.length,b.length)<0.5)return null;
 const ids=[...new Set([...parent.evidenceIds,...child.evidenceIds])];if(ids.length>8||ids.some(id=>units.filter(u=>u.id===id).length!==1||units.some(u=>u.id===id&&u.classification==='remove'&&!u.restored)))return null;
 const left=parent.evidenceIds.map(id=>units.findIndex(u=>u.id===id)),right=child.evidenceIds.map(id=>units.findIndex(u=>u.id===id));
 // Adjacent source turns can hold one request and its acceptance. Proximity
 // is never proof that they concern the same work.
 if(Math.min(...left.flatMap(a=>right.map(b=>Math.abs(a-b))))>2)return null;
 const positions=ids.map(id=>units.findIndex(u=>u.id===id));if(Math.max(...positions)-Math.min(...positions)>12)return null;const context=units.filter((u,i)=>positions.some(at=>Math.abs(at-i)<=4)&&(u.classification!=='remove'||u.restored));
 if(!context.some(u=>ownerWitness(u,parent.owners[0])))return null;
 return {kind:'simple_obligation'};
}
function direction(left,right,all=[left,right],units=[]){for(const[parent,child]of[[left,right],[right,left]])if(shape(parent,child,units)&&all.filter(r=>shape(r,child,units)).length===1&&all.filter(r=>hash(r)===hash(child)).length===1)return {parent,child};return null;}
function context(packet,candidate){
 const ids=new Set(packet.rows.filter(r=>[candidate.leftRef,candidate.rightRef].includes(r.ref)).flatMap(r=>r.action.evidenceIds)),units=packet.sourceUnits,positions=[...ids].map(id=>units.findIndex(u=>u.id===id));
 if(positions.some(i=>i<0)||Math.max(...positions)-Math.min(...positions)>12)return {sourceUnits:[],contextFailure:'simple_obligation_context_too_wide'};
 const sourceUnits=units.filter((u,i)=>positions.some(at=>Math.abs(at-i)<=4)&&(u.classification!=='remove'||u.restored));
 return sourceUnits.length>32||JSON.stringify(sourceUnits).length>48000?{sourceUnits:[],contextFailure:'simple_obligation_context_capacity'}:{sourceUnits};
}
function reviewPacket(parent,child,units,ids,challenge){if(units.some(u=>ids.includes(u.id)&&/\b(?:withdrawn|cancelled|canceled|no action|no longer (?:required|needed))\b/i.test(u.text||'')))throw Error('simple_obligation_withdrawal');if(!shape(parent,child,units))throw Error('simple_obligation_not_eligible');return C.reviewPacket(parent,child,units,ids,challenge,{instructionComparison:'simple_obligation',contextualUnits:true,contextualOwners:true});}
function certify(parent,child,units,ids,primary,challenge){
 if(!shape(parent,child,units))throw Error('simple_obligation_not_eligible');
 const atomic=require('./actionSemanticReconciliation').prepareActionReconciliation({actions:[parent,child],sourceUnits:units});if(atomic.rows.some(r=>r.clauses.length!==1))throw Error('simple_obligation_compound');
 const N=require('../meetingMinutesActionReferenceReview');
 for(const[response,index]of[[primary,0],[challenge,1]]){const packet=reviewPacket(parent,child,units,ids,index===1),a=N.assess(packet,response);if(a.contractError||!a.modelPassed||a.relationship?.relation!=='same_obligation'||response.decisions.find(d=>d.kind==='source').rows.some(r=>r.basis!=='commitment'))throw Error(a.contractError||'simple_obligation_independent_veto');}
 const evidenceIds=[...new Set([...parent.evidenceIds,...child.evidenceIds,...C.sourceIds(reviewPacket(parent,child,units,ids,false),primary),...C.sourceIds(reviewPacket(parent,child,units,ids,true),challenge)])].sort();
 if(evidenceIds.length>8||evidenceIds.some(id=>units.filter(u=>u.id===id).length!==1||units.some(u=>u.id===id&&u.classification==='remove'&&!u.restored)))throw Error('simple_obligation_source_capacity');
 const body={version:VERSION,sourceHash:hash(units),parent:clone(parent),child:clone(child),contextSourceIds:[...ids],primary:clone(primary),challenge:clone(challenge),expectedSurvivor:{...clone(parent),evidenceIds,reviewFlagIds:[]}};return {...body,reviewHash:hash(body)};
}
function valid(packet,certificate,original,survivor){try{if(certificate?.version!==VERSION||certificate.sourceHash!==hash(packet.sourceUnits||[]))return false;const {reviewHash,...body}=certificate;if(hash(body)!==reviewHash||![certificate.parent,certificate.child].some(r=>hash(r)===hash(original.action))||![certificate.parent,certificate.expectedSurvivor].some(r=>actionProvenanceSignature(r)===actionProvenanceSignature(survivor.action)))return false;return certify(certificate.parent,certificate.child,packet.sourceUnits,certificate.contextSourceIds,certificate.primary,certificate.challenge).reviewHash===reviewHash;}catch{return false;}}
function conflicts(packet,proof,original,survivor,reasons){if(!proof?.simpleObligation)return reasons;return valid(packet,proof.simpleObligation,original,survivor)?reasons:[...reasons,'invalid_simple_obligation_review'];}
function coverage(packet,parent,child,certificate){return C.coverage(packet,parent,child,certificate).map(({containedRequirement,...proof})=>({...proof,simpleObligation:certificate}));}
function validMapping(packet,proof,original,survivor){if(!valid(packet,proof.simpleObligation,original,survivor))return false;const atomic=require('./actionSemanticReconciliation').prepareActionReconciliation({actions:[survivor.action,original.action],sourceUnits:packet.sourceUnits}),[a,b]=atomic.rows.map((r,i)=>({...r,ref:i===0?survivor.ref:original.ref})),expected=coverage({...packet,rows:[a,b]},a,b,proof.simpleObligation)[1];return hash(proof.semanticProof)===hash(expected.semanticProof)&&hash(proof.sourceSpans)===hash(expected.sourceSpans);}
module.exports={VERSION,context,eligible,shape,direction,reviewPacket,certify,valid,conflicts,coverage,validMapping};
