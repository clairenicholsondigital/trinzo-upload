'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const verify=require('../utils/meetingMinutesSemanticSourceVerification');
const R=require('../utils/canonicalMinutes/actionSemanticReconciliation');
const source=(speaker,id='T1',text='I will share the calibration tracker.')=>({id,speaker,text});
const row=id=>({id,action:'Share the calibration tracker.',owners:['Nora Patel'],evidenceIds:['T1'],reviewFlagIds:[],timing:{kind:'not_stated',wording:'',exactDate:''}});
function reconcile(sourceUnits,mutate=()=>{}){const actions=[row('a'),row('b')];mutate(actions);const packet=R.prepareActionReconciliation({actions,sourceUnits});return {actions,packet,result:R.applyActionReconciliation(packet,R.buildDeterministicEnvelope(packet),{actions,sourceUnits})};}
test('existing exact duplicate path accepts a source-established Teams full-name identity and retains raw evidence',()=>{
 const units=[source('Patel, Nora M')],out=reconcile(units);
 assert.equal(out.result.actions.length,1);
 assert.equal(units[0].speaker,'Patel, Nora M');
 assert.ok(out.result.receipts.length);
 assert.ok(out.result.receipts.every(r=>R.validateReconciliationReceipt(r,r.original,out.result.actions[0],units)));
 const changed=[...units,source('Patel, Nora J','T2')];
 assert.ok(out.result.receipts.every(r=>!R.validateReconciliationReceipt(r,r.original,out.result.actions[0],changed)));
});
for(const speaker of ['Nora','Patel, Nora J','Nora Patel'])test('a separate or incomplete identity cannot alias Teams owner: '+speaker,()=>{
 const units=[source('Patel, Nora M'),source(speaker,'T2','I work on another project.')],out=reconcile(units);
 // A first-name-only label cannot create a competing full identity; but it
 // must never become a full-name ownership witness itself.
 if(speaker!=='Nora')assert.deepEqual(out.result.actions,out.actions);
 const witness=verify.sourceOwnerWitnessScope(units);
 if(speaker==='Nora')assert.equal(witness(units[1],'Nora Patel'),false);
});
test('unbound or duplicate source identities cannot establish an alias witness',()=>{
 const unit=source('Patel, Nora M'),witness=verify.sourceOwnerWitnessScope([unit]);
 assert.equal(witness(unit,'Nora Patel'),true);
 assert.equal(witness({...unit,id:'missing'},'Nora Patel'),false);
 assert.equal(witness({...unit,speaker:'Patel, Nora J'},'Nora Patel'),false);
 assert.equal(verify.sourceOwnerWitnessScope([unit,{...unit,text:'Other source'}])(unit,'Nora Patel'),false);
 assert.equal(witness(unit,'Nora'),false);
 assert.equal(witness(unit,'Nora Marie Patel'),false);
});
for(const change of [
 actions=>actions[1].owners=['Nora'],
 actions=>actions[1].action='Share the calibration tracker with Alex.',
 actions=>actions[1].timing={kind:'target',wording:'next week',exactDate:''}
])test('source identity evidence never overrides a different obligation or review state',()=>{
 const out=reconcile([source('Patel, Nora M')],change);assert.deepEqual(out.result.actions,out.actions);
});
test('scope is captured from sources rather than later source mutations',()=>{
 const units=[source('Patel, Nora M')],witness=verify.sourceOwnerWitnessScope(units),original={...units[0]};
 units[0].speaker='Another Person';
 assert.equal(witness(original,'Nora Patel'),true);
 assert.equal(witness(units[0],'Nora Patel'),false);
});

test('exact duplicate reconciliation retains review flags and source-bound recovery',()=>{
 const units=[source('Patel, Nora M')],out=reconcile(units,actions=>actions[1].reviewFlagIds=['check-source']);
 assert.equal(out.result.actions.length,1);
 assert.deepEqual(out.result.actions[0].reviewFlagIds,['check-source']);
 assert.ok(out.result.receipts.every(r=>R.validateReconciliationReceipt(r,r.original,out.result.actions[0],units)));
});
test('reference-based source and retention review uses the same bound full-name witnesses',()=>{
 const register=require('../utils/meetingMinutesActionReviewRegister').prepare({actions:[row('a'),row('b')],sourceUnits:[source('Patel, Nora M')]});
 const Ref=require('../utils/meetingMinutesActionReferenceReview'),pair=register.comparisons[0],packet=Ref.prepare(register,pair.comparisonId,pair.leftRef);
 assert.ok(packet.sourceRows.every(row=>row.ownerWitnesses[0].refs.includes('T1')));
 const data=JSON.parse(Ref.prompt(packet,{completeContract:true}).split('\nDATA\n')[1]);
 const response=require('./helpers/meeting-minutes-contained-response')(data);
 assert.equal(Ref.validate(packet,response),'');
 assert.equal(Ref.assess(packet,response).modelPassed,true);
 response.decisions[0].rows[1].checks[0].refs=[];
 assert.notEqual(Ref.validate(packet,response),'');
});
test('bounded witness retrieval retains the source-established label but rejects a global conflicting initial',()=>{
 const S=require('../utils/meetingMinutesSemanticStage'),actions=[row('a'),row('b')];
 const units=[source('Patel, Nora M')],packet=R.prepareActionReconciliation({actions,sourceUnits:units,scope:'bounded_existing_survivors'});
 const candidates=[{candidateId:'pair',leftRef:packet.rows[0].ref,rightRef:packet.rows[1].ref}];
 assert.equal(S.promptContext(packet,candidates).contextFailure,undefined);
 const conflicted=R.prepareActionReconciliation({actions,sourceUnits:[...units,source('Patel, Nora J','T2')],scope:'bounded_existing_survivors'});
 const nextCandidates=[{candidateId:'pair',leftRef:conflicted.rows[0].ref,rightRef:conflicted.rows[1].ref}];
 assert.equal(S.promptContext(conflicted,nextCandidates).contextFailure,'owner_context_unavailable');
});
for(const other of ['Nora Mary Patel','Patel, Nora Mary'])test('a fully spelled middle name elsewhere prevents the shortened alias: '+other,()=>{
 const units=[source('Patel, Nora M'),source(other,'T2')],out=reconcile(units);
 assert.deepEqual(out.result.actions,out.actions);
 const witness=verify.sourceOwnerWitnessScope(units);
 assert.equal(witness(units[0],'Nora Patel'),false);
 assert.equal(witness(units[0],'Nora M Patel'),true,'the exact initialled full identity remains usable');
});
