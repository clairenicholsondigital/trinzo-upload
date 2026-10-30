'use strict';
process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1='0';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../utils/canonicalMinutes/contactParaphrase'),R=require('../utils/canonicalMinutes/actionSemanticReconciliation');
const S=require('../utils/meetingMinutesSemanticStage');
const {captureSemanticPolicy}=require('../utils/meetingMinutesSemanticPolicy');
const response=require('./helpers/meeting-minutes-contained-response');
const {registerBounds,registerVeto,registerAccounting}=require('./helpers/reconciliation-guards');
const row=(id,action)=>({id,action,owners:['Maya Patel'],timing:{kind:'not_stated',wording:'',exactDate:''},evidenceIds:['T0001'],reviewFlagIds:[]});
const cases=[['contact',row('p','Discuss with Morgan the supplier registration activities and obtain clarity on the associated plan, timeline and responsibilities.'),row('c','Follow up with Morgan to obtain clarity on the supplier registration activities, plan, timeline, and responsibilities.')]];
cases.push(['enquiry paraphrase',
 row('enquiry-parent','Follow up with Morgan regarding supplier activities, responsibilities, status, and plan relating to product registration and compliance work.'),
 row('enquiry-child',"Speak to Morgan to clarify the supplier's role and avoid duplication in product registration activities.")]);
const policy=captureSemanticPolicy({MEETING_MINUTES_AGENT_CONTACT_PARAPHRASE_V1:'1'});
for(const [name,parent,child]of cases){
 const sourceUnits=require('../utils/meetingMinutesAgentV2').normaliseSourceUnits([{id:'T0001',speaker:'Maya Patel',text:'I will '+parent.action[0].toLowerCase()+parent.action.slice(1)}]);
 const answer=packet=>{const r=response({...packet,selectedSurvivor:'A'});r.decisions[2].relation='same_obligation';r.decisions[0].rows.forEach(row=>row.basis='commitment');return r;};
 const guards={name,parent,child,C,S,policy,sourceUnits,answer};
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
 registerBounds(guards,r=>r.action=r.action.replace(/Morgan/,'Taylor'));
 registerVeto(guards);
 for(const [label,mutate]of [
  ['deliverable-content category',r=>r.decisions[2].relation='discarded_requirement_of_survivor'],
  ['component rather than commitment',r=>r.decisions[0].rows[1].basis='required_component']
 ])for(const challenge of [false,true])test(`${name}: ${label} at ${challenge?'challenge':'proposal'} stops at that review and records a veto`,async()=>{
  const D=require('../utils/meetingMinutesActionDiagnostics');
  for(const actions of [[parent,child],[child,parent]]){
   const before=structuredClone(actions);let calls=0;
   const {value:out,audit}=await D.capture(()=>S.reconcileGeneratedSemanticStage({changes:{actions}},{sourceUnits},'actions',{policy,ask:async(prompt,options)=>{
    calls++;assert.equal(options.maxAttempts,1);const data=JSON.parse(prompt.split('\nDATA\n')[1]),r=answer(data);
    if(data.reviewPurpose===(challenge?'independent_challenge':'proposal'))mutate(r);return {result:r};
   }}));
   assert.deepEqual(actions,before);assert.deepEqual(out.changes.actions,before);assert.equal(calls,challenge?2:1);
   const reviews=audit.events.filter(e=>e.kind==='independent_review');assert.equal(reviews.length,calls);
   assert.equal(reviews.at(-1).role,challenge?'challenge':'primary');assert.equal(reviews.at(-1).outcome,'semantic_veto');
   assert.ok(reviews.every(e=>e.role!==(challenge?'challenge':'primary')||e.outcome!=='accepted'));
   const q=out.changes.qualityState.actions.semanticReconciliation;assert.equal(q.stats.merged,0);assert.equal(q.receipts.length,0);
   assert.ok(q.unresolved.some(e=>e.reason==='contact_paraphrase_independent_veto'));
  }
 });
 test(name+': a cached rejected proposal cannot trigger a challenge or bypass the early veto',async()=>{
  const actions=[parent,child];let calls=0;
  const first=await S.reconcileGeneratedSemanticStage({changes:{actions}},{sourceUnits},'actions',{policy,ask:async prompt=>{
   calls++;const data=JSON.parse(prompt.split('\nDATA\n')[1]),r=answer(data);r.decisions[2].relation='discarded_requirement_of_survivor';return {result:r};
  }});
  assert.equal(calls,1);assert.equal(first.changes.qualityState.actions.semanticReconciliation.cache.length,1);
  let unexpected=0;
  const next=await S.reconcileGeneratedSemanticStage({changes:{actions}},{sourceUnits,qualityState:first.changes.qualityState},'actions',{policy,ask:async()=>{unexpected++;throw Error('Rejected cached proposal must not invoke a provider');}});
  assert.equal(unexpected,0);assert.deepEqual(next.changes.actions,actions);
  const q=next.changes.qualityState.actions.semanticReconciliation;assert.equal(q.stats.merged,0);assert.equal(q.calls.length,1);assert.equal(q.calls[0].cached,true);
  assert.ok(q.unresolved.some(e=>e.reason==='contact_paraphrase_independent_veto'));
 });
 registerAccounting(guards);
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

test('new enquiry grammar retains bounds and does not turn overlap into equivalence',()=>{
 const [,p,c]=cases[1];
 for(const action of [
  c.action.replace('Morgan','Taylor'),
  'Speak to Morgan to clarify the training schedule and attendance expectations.',
  c.action.replace('clarify','clarify and update'),
  c.action.replace('activities.','activities and send the report.'),
  c.action.replace('activities.','activities if approved.'),
  c.action.replace('activities.','activities tomorrow.'),
  c.action.replace('activities.','activities on 15 November.'),
 ])assert.equal(C.direction(p,{...c,action}),null,action);
 assert.equal(C.direction(p,c,[p,{...p,id:'ambiguous-survivor'},c]),null);
 const disjoint={...c,evidenceIds:['T0002']};assert.equal(C.direction(p,disjoint),null);
 // The wider vocabulary gate is exclusive to the newly bounded grammar.
 assert.equal(C.direction({...p,action:p.action.replace('regarding','to obtain clarity on')},c),null);
});
