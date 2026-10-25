'use strict';
process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1='0';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../utils/canonicalMinutes/contactParaphrase'),R=require('../utils/canonicalMinutes/actionSemanticReconciliation');
const S=require('../utils/meetingMinutesSemanticStage'),N=require('../utils/meetingMinutesActionReferenceReview');
const {captureSemanticPolicy}=require('../utils/meetingMinutesSemanticPolicy');
const response=require('./helpers/meeting-minutes-contained-response');
const row=(id,action)=>({id,action,owners:['Maya Patel'],timing:{kind:'not_stated',wording:'',exactDate:''},evidenceIds:['T0001'],reviewFlagIds:[]});
const cases=[['contact',row('p','Discuss with Morgan the supplier registration activities and obtain clarity on the associated plan, timeline and responsibilities.'),row('c','Follow up with Morgan to obtain clarity on the supplier registration activities, plan, timeline, and responsibilities.')]];
const policy=captureSemanticPolicy({MEETING_MINUTES_AGENT_CONTACT_PARAPHRASE_V1:'1'});
for(const [name,parent,child]of cases){
 const sourceUnits=require('../utils/meetingMinutesAgentV2').normaliseSourceUnits([{id:'T0001',speaker:'Maya Patel',text:'I will '+parent.action[0].toLowerCase()+parent.action.slice(1)}]);
 const answer=packet=>{const r=response({...packet,selectedSurvivor:'A'});r.decisions[2].relation='same_obligation';r.decisions[0].rows.forEach(row=>row.basis='commitment');return r;};
 test(name+': nominates either order, keeps exact fuller existing row and valid reversible receipts',async()=>{
  const A=require('../routes/api').stagedEvaluation;
  for(const actions of [[parent,child],[child,parent]]){
   let calls=0;assert.ok(R.prepareActionReconciliation({actions,sourceUnits}).candidates.every(c=>!c.contactParaphrase));
   const out=await S.reconcileGeneratedSemanticStage({changes:{actions}},{sourceUnits},'actions',{policy,verifySurvival:A.reconcileFinalApprovedActions,ask:async prompt=>{calls++;return {result:answer(JSON.parse(prompt.split('\nDATA\n')[1]))};}});
   assert.equal(calls,2);assert.equal(out.changes.actions.length,1,JSON.stringify(out.changes.qualityState.actions.semanticReconciliation.unresolved));assert.equal(out.changes.actions[0].action,parent.action);
   const admitted=A.admitMeetingAgentGeneratedActionChanges({sourceUnits},out.changes,'paraphrase-test');
   const saved=JSON.parse(JSON.stringify({sourceUnits,...admitted}));
   assert.deepEqual(require('../utils/meetingMinutesEnquiryRecovery').originalEnquiryActions(saved),actions);
   for(const receipt of saved.qualityState.actions.semanticReconciliation.receipts)assert.ok(R.validateReconciliationReceipt(receipt,receipt.original,saved.actions[0],sourceUnits));
  }
 });
 for(const [label,change]of [
  ['warning',r=>r.reviewFlagIds=['warning']],['owner',r=>r.owners=['Other Person']],['reviewer',r=>r.reviewerAuthored=true],['extra metadata',r=>r.notes='keep'],
  ['dated',r=>r.timing={kind:'target',wording:'tomorrow',exactDate:''}],['condition',r=>r.action+=' if approved'],['history',r=>r.timingDecision={status:'rejected',rejectedWordings:['tomorrow']}],
  ['recipient',r=>r.action=r.action.replace(/Morgan/,'Taylor')],['separate work',r=>r.action='Send the completed notice to the regional team.']
 ])test(name+': excludes '+label,()=>{const other=structuredClone(child);change(other);assert.equal(C.direction(parent,other),null);});
 test(name+': independent veto or withdrawal never authorizes a merge',async()=>{
  for(const challenge of [false,true]){let calls=0;const out=await S.reconcileGeneratedSemanticStage({changes:{actions:[parent,child]}},{sourceUnits},'actions',{policy,ask:async prompt=>{calls++;const data=JSON.parse(prompt.split('\nDATA\n')[1]),r=answer(data);if(data.reviewPurpose===(challenge?'independent_challenge':'proposal'))r.decisions[2].relation='distinct_work';return {result:r};}});assert.equal(calls,challenge?2:1);assert.deepEqual(out.changes.actions,[parent,child]);}
  assert.throws(()=>C.reviewPacket(parent,child,[{...sourceUnits[0],text:sourceUnits[0].text+' That instruction is cancelled.'}],['T0001'],false),/withdrawal/);
 });
 test(name+': malformed/missing independent accounting cannot certify',()=>{
  const p=C.reviewPacket(parent,child,sourceUnits,['T0001'],false),q=C.reviewPacket(parent,child,sourceUnits,['T0001'],true),a=answer(p),b=answer(q);b.decisions[1].checks=[];
  assert.throws(()=>C.certify(parent,child,sourceUnits,['T0001'],a,b));
 });
}
test('different purpose, ambiguous survivors and execution work remain distinct',()=>{
 const [_,p,c]=cases[0];
 assert.equal(C.direction(p,{...c,action:c.action.replace('supplier registration','training preparation')}),null);
 assert.equal(C.direction(p,c,[p,{...p,id:'another'},c]),null);
 assert.equal(C.frame('Follow up with Morgan to obtain clarity on the supplier registration plan and send the approved summary.'),null);
 assert.equal(C.frame('Discuss with Morgan the supplier activities and obtain clarity on the next week deadline.'),null);
});
test('flag is off by default, frozen on capture and does not enlarge the pair budget',()=>{
 const env={MEETING_MINUTES_AGENT_CONTACT_PARAPHRASE_V1:'1',MEETING_MINUTES_AGENT_CONTACT_ENQUIRY_DEDUPE_V1:'1',MEETING_MINUTES_AGENT_BOUNDED_SURVIVOR_DEDUPE_V1:'1'};
 const p=captureSemanticPolicy(env);assert.equal(p.contactParaphrases,true);assert.equal(p.maxCandidates,2);env.MEETING_MINUTES_AGENT_CONTACT_PARAPHRASE_V1='0';assert.equal(p.contactParaphrases,true);assert.equal(captureSemanticPolicy(env).contactParaphrases,undefined);assert.ok(Object.isFrozen(p));
});
test('provider transport cannot inject a trusted contact certificate',()=>{
 const T=require('../utils/meetingMinutesSemanticProofTransport');const [_,p,c]=cases[0];const sourceUnits=[{id:'T0001',speaker:'Maya Patel',text:p.action}];const packet=R.prepareActionReconciliation({actions:[p,c],sourceUnits,scope:policy.scope,contactParaphrases:true});const pair=packet.candidates[0];
 const response={decisions:[{candidateId:pair.candidateId,relation:'equivalent',survivorRef:pair.leftRef,coverage:[{originalRef:pair.rightRef,survivorRef:pair.leftRef,contactParaphrase:{trusted:true},sourceIds:['T0001'],clauseMap:[]}]}]};
 for(const coverage of [response.decisions[0].coverage,[{...response.decisions[0].coverage[0],semanticProof:{clauses:[]}}]]){const normalized=T.materializeSemanticDecisions(packet,{decisions:[{...response.decisions[0],coverage}]},'actions');assert.ok(normalized.decisions[0].coverage.every(p=>!p.contactParaphrase));}
});
