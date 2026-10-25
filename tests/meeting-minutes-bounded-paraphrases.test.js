'use strict';
process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1='0';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../utils/canonicalMinutes/containedRequirement'),R=require('../utils/canonicalMinutes/actionSemanticReconciliation');
const S=require('../utils/meetingMinutesSemanticStage'),N=require('../utils/meetingMinutesActionReferenceReview');
const {captureSemanticPolicy}=require('../utils/meetingMinutesSemanticPolicy');
const response=require('./helpers/meeting-minutes-contained-response');
const row=(id,action)=>({id,action,owners:['Maya Patel'],timing:{kind:'not_stated',wording:'',exactDate:''},evidenceIds:['T0001'],reviewFlagIds:[]});
const cases=[
 ['issue',row('p','Bring the absence of entries in the quality database to the regional team for review.'),row('c','Raise the absence of entries in the quality database with the regional team.')],
 ['content',row('p','Include the annual service fee increase from £40 to £50 in the renewals notice and explain the change.'),row('c','Explain the service fee increase in the membership renewal notice.')]
];
const policy=captureSemanticPolicy({MEETING_MINUTES_AGENT_CONTAINED_REQUIREMENTS_V1:'1'});
for(const [name,parent,child]of cases){
 const sourceUnits=require('../utils/meetingMinutesAgentV2').normaliseSourceUnits([{id:'T0001',speaker:'Maya Patel',text:'I will '+parent.action[0].toLowerCase()+parent.action.slice(1)}]);
 const answer=packet=>{const r=response({...packet,selectedSurvivor:'A'});r.decisions[2].relation='same_obligation';r.decisions[0].rows.forEach(row=>row.basis='commitment');return r;};
 test(name+': nominates either order, keeps exact fuller existing row and valid reversible receipts',async()=>{
  const A=require('../routes/api').stagedEvaluation;
  for(const actions of [[parent,child],[child,parent]]){
   let calls=0;assert.ok(R.prepareActionReconciliation({actions,sourceUnits}).candidates.every(c=>!c.containedRequirement));
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
  ['recipient',r=>r.action=r.action.replace(/regional team|membership renewal notice/,'customer team')],['separate work',r=>r.action='Send the completed notice to the regional team.']
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
test('same recipient but different issue, unrelated container and competing survivors are excluded',()=>{
 assert.equal(C.direction(cases[0][1],{...cases[0][2],action:'Raise the absence of deliveries from the storage warehouse with the regional team.'}),null);
 assert.equal(C.direction(cases[1][1],{...cases[1][2],action:'Explain the service fee increase in the finance committee report.'}),null);
 assert.equal(C.direction(cases[1][1],cases[1][2],[cases[1][1],{...cases[1][1],id:'p2'},cases[1][2]]),null);
});
