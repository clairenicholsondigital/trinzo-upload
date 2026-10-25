'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const V=require('../utils/meetingMinutesAgentV2');
const unit=(id,speaker,text)=>({id,speaker,text});
const row=(action,evidenceIds,owners=['Taylor Finch'])=>({id:'work',action,owners,timing:{kind:'not_stated',wording:'',exactDate:''},evidenceIds,reviewFlagIds:[]});
const normalize=(a,units)=>V.normaliseAgentResult({actions:[a]},units,'actions',{meetingDate:'2026-08-05'});
const noticeUnits=[
 unit('T0001','Morgan Reed','The annual membership fee will increase from twenty pounds to thirty pounds starting in January.'),
 unit('T0002','Morgan Reed',"Taylor, you handle the renewals, so you'll explain the increase gently in the letter."),
 unit('T0003','Taylor Finch',"I'll soften it."),
 unit('T0004','Taylor Finch',"I'll frame it as keeping the centre going."),
 unit('T0005','Morgan Reed',"Moving on to the waiting list."),
 unit('T0006','Taylor Finch',"I'll email the top three applicants and offer them a membership place.")
];

test('normalisation retains a supplied assignment/acceptance exchange and supplementary fee context',()=>{
 const a=row('Draft the renewals letter communicating the increase of the annual membership fee from £20 to £30 starting in January.',['T0001','T0002','T0003','T0004']);
 const d=normalize(a,noticeUnits);assert.equal(d.actions.length,1);const out=d.actions[0];
 for(const id of ['T0002','T0003','T0004'])assert.ok(out.evidenceIds.includes(id),id+' must remain');
 assert.ok(out.evidenceIds.includes('T0001'),'amount/effective-date context remains available');
 assert.ok(!out.evidenceIds.includes('T0006'),'another task is not an ownership anchor');
 assert.deepEqual(out.owners,a.owners);assert.equal(out.timing.kind,'not_stated');
 assert.ok(out.evidenceIds.length<=8);assert.deepEqual(a.evidenceIds,['T0001','T0002','T0003','T0004'],'input is immutable');
 const again=normalize(out,noticeUnits).actions[0];assert.deepEqual(again.evidenceIds,out.evidenceIds,'repeated normalisation retains the exchange');
});

test('ongoing work and a supplied tool dependency survive remapping without borrowing a completed subset',()=>{
 const units=[
  unit('T0001','Taylor Finch',"I've added five controller drivers that did not have any issues."),
  unit('T0002','Taylor Finch','Three controller drivers still need to be generated.'),
  unit('T0003','Taylor Finch','Those drivers were generated using the configuration editor.'),
  unit('T0004','Taylor Finch',"I'm trying to get access to that."),
  unit('T0005','Taylor Finch',"The website is blocked by the firewall, and I have raised it with IT so we would generate new controller drivers."),
  unit('T0006','Morgan Reed','The remaining controller drivers depend on access to the configuration editor.')
 ];
 const a=row('Complete the remaining integration work by generating the required controller drivers.',['T0003','T0004','T0005','T0006']);
 const out=normalize(a,units).actions[0];assert.ok(out);
 for(const id of ['T0003','T0004','T0005','T0006'])assert.ok(out.evidenceIds.includes(id),id+' remains cited');
 assert.ok(!out.evidenceIds.includes('T0001'),'completed drivers do not establish outstanding work');
 assert.deepEqual(out.owners,a.owners);assert.ok(out.evidenceIds.length<=8);
});

test('an unrelated future task by the same person is not appended as a commitment anchor',()=>{
 const units=[unit('T0001','Morgan Reed','The annual safety report requires preparation.'),
  unit('T0002','Taylor Finch',"I'll prepare the annual finance report.")];
 const a=row('Prepare the annual safety report.',['T0001']);
 const out=V.backfillActionCommitmentEvidence([a],units)[0];
 assert.deepEqual(out.evidenceIds,['T0001']);assert.equal(out.timing.kind,'not_stated');
});

test('completed work is not appended to a remaining-work action even with a different future task in that turn',()=>{
 for(const text of ["I've added all the controller drivers.","I've added the controller drivers, and I'll send the budget report tomorrow."]){
  const units=[unit('T0001','Morgan Reed','The controller drivers still require generation.'),unit('T0002','Taylor Finch',text)];
  const out=V.backfillActionCommitmentEvidence([row('Generate the remaining controller drivers.',['T0001'])],units)[0];
  assert.ok(!out.evidenceIds.includes('T0002'));assert.equal(out.timing.kind,'not_stated');
 }
});

test('an anaphoric commitment cannot cross a change to a different task',()=>{
 const units=[unit('T0001','Morgan Reed','The equipment safety report requires review.'),
  unit('T0002','Morgan Reed','Moving on to the finance report.'),
  unit('T0003','Taylor Finch',"Right, I'll have a look at that.")];
 const out=V.backfillActionCommitmentEvidence([row('Review the equipment safety report.',['T0001'])],units)[0];
 assert.deepEqual(out.evidenceIds,['T0001']);
});

test('a current explicit commitment may contain a question without losing its citation',()=>{
 const units=[unit('T0001','Morgan Reed','The equipment safety report needs review.'),
  unit('T0002','Taylor Finch',"I'll review the equipment safety report. Is the folder accessible?")];
 const out=V.backfillActionCommitmentEvidence([row('Review the equipment safety report.',['T0001'])],units)[0];
 assert.ok(out.evidenceIds.includes('T0002'));
});

test('ambiguous first names cannot add another person as an owner witness',()=>{
 const units=[unit('T0001','Morgan Reed','The equipment safety report needs review.'),
  unit('T0002','Taylor Finch',"I'll review the equipment safety report."),
  unit('T0003','Taylor West',"I'm reviewing the equipment safety report.")];
 const out=V.backfillActionCommitmentEvidence([row('Review the equipment safety report.',['T0001'],['Taylor'])],units)[0];
 assert.deepEqual(out.evidenceIds,['T0001']);assert.deepEqual(out.owners,['Taylor']);
});

test('a supplied wrong workstream still remaps to the actual task evidence',()=>{
 const units=[unit('T0001','Taylor Finch',"I'll prepare the annual finance report."),
  unit('T0002','Morgan Reed','The supplier insurance register is still awaiting review.'),
  unit('T0003','Taylor Finch',"I'll review the supplier insurance register and confirm the missing certificates.")];
 const out=normalize(row('Review the supplier insurance register and confirm the missing certificates.',['T0001']),units).actions[0];
 assert.ok(out);assert.ok(out.evidenceIds.includes('T0003'));assert.ok(!out.evidenceIds.includes('T0001'));
});

test('a save or reviewer-authored row does not silently repick its source references',()=>{
 const units=[unit('T0001','Taylor Finch','The finance report is available.'),
  unit('T0002','Taylor Finch',"I'll review the equipment safety report.")];
 const a=row('Review the equipment safety report.',['T0001']);
 for(const [input,options]of [[a,{preserveReviewerEdits:true}],[{...a,reviewerAuthored:true},{}]]){
  const d=V.normaliseAgentResult({actions:[input]},units,'',{enforceEvidence:false,...options});
  assert.equal(d.actions.length,1);assert.deepEqual(d.actions[0].evidenceIds,['T0001']);
  assert.equal(d.actions[0].action,a.action);assert.deepEqual(d.actions[0].owners,a.owners);
 }
});

test('retaining a supplied exchange cannot bring a subsequent topic or its timing into the task',()=>{
 const units=[...noticeUnits.slice(0,4),unit('T0005','Morgan Reed','Moving on to equipment inspections.'),
  unit('T0006','Taylor Finch',"Tomorrow.")];
 const a=row('Draft the renewals letter explaining the membership fee increase.',['T0002','T0003','T0004','T0005','T0006']);
 const out=normalize(a,units).actions[0];assert.ok(out);
 for(const id of ['T0002','T0003','T0004'])assert.ok(out.evidenceIds.includes(id));
 assert.ok(!out.evidenceIds.includes('T0006'));assert.equal(out.timing.kind,'not_stated');
});
