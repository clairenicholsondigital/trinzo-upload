'use strict';
// Research-only packet adapters. No transport, persistence or edit application.
const crypto=require('node:crypto');
const P=require('./globalActionRegister');
const R=require('../../utils/canonicalMinutes/actionSemanticReconciliation');
const S=require('../../utils/meetingMinutesSemanticSourceVerification');
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,stable(value[k])])):value;
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
function blindCase(item,index){
 const ids=new Map(item.sourceUnits.map((s,i)=>[s.id,`G${index+1}S${i+1}`]));
 return {caseId:`case-${index+1}`,packet:P.prepare({
  actions:item.actions.map((a,i)=>({...structuredClone(a),id:`G${index+1}A${i+1}`,evidenceIds:a.evidenceIds.map(id=>ids.get(id)||id)})),
  sourceUnits:item.sourceUnits.map(s=>({...structuredClone(s),id:ids.get(s.id)}))})};
}
function verificationPacket(items){
 const rows=[],sourceUnits=[],candidates=[];
 for(const {caseId,packet,survivorIndex=0} of items){
  const prepared=R.prepareActionReconciliation({actions:packet.rows.map(r=>r.action),sourceUnits:packet.sourceUnits});
  if(prepared.rows.length!==2)throw Error('Source challenge requires exactly two originals.');
  rows.push(...prepared.rows);sourceUnits.push(...packet.sourceUnits);
  candidates.push({candidateId:caseId,leftRef:prepared.rows[0].ref,rightRef:prepared.rows[1].ref,survivorRef:prepared.rows[survivorIndex].ref});
 }
 if(new Set(sourceUnits.map(s=>s.id)).size!==sourceUnits.length)throw Error('Source challenge IDs must be unique.');
 const body={version:'global-register-source-challenge-research-v1',rows,sourceUnits,candidates,sourceHash:hash(sourceUnits),inputHash:hash(rows.map(r=>r.action))};
 return {...body,packetHash:hash(body)};
}
function verificationPrompt(packet){
 return S.verificationPrompt(packet,packet.candidates,packet.rows,packet.sourceUnits,{researchOnly:true,allowEdits:false})
  +'\nADDITIONAL REVIEW RULE: The full original action record is authoritative input, including its timing object and timingDecision history. supported/retained must cover dependency/condition/deadline/occurrence/recipient/quantity and uncertainty, not just the action text. Do not discard a qualification merely because it appears in timing rather than action. Never upgrade unresolved/rejected timing. Judge each original against the selected survivor. Classifier decisions/reasons are intentionally withheld. This request cannot authorize an edit.';
}
function verify(packet,response){return S.verificationError(packet,packet.candidates,response);}
module.exports={blindCase,verificationPacket,verificationPrompt,verify,hash};
