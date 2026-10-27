'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const V=require('../utils/meetingMinutesAgentV2');
const source=()=>V.normaliseSourceUnits([
 {id:'T0001',speaker:'Morgan Reed',text:'For the archived equipment changes, extra documentation is required for any deviation.'},
 {id:'T0002',speaker:'Morgan Reed',text:'Moving on to the delivery schedule.'},
 {id:'T0003',speaker:'Morgan Reed',text:'The team meeting has ended.'},
 {id:'T0004',speaker:'Morgan Reed',text:'The new guideline covers pressure systems.'},
 {id:'T0005',speaker:'Morgan Reed',text:"Taylor, I'll send that guideline over and we can perhaps get an assessment of it."},
 {id:'T0006',speaker:'Morgan Reed',text:'We could have a look at it to see if we need to do anything.'},
 {id:'T0007',speaker:'Taylor Finch',text:'I have the background notes.'}
]);
const wording=verb=>`${verb} the applicability of the referenced guideline and determine whether any action is required from it.`;
for(const verb of ['Assess','Evaluate'])test(`${verb}: lexical-only fallback cannot replace supplied references or mark them verified`,()=>{
 const units=source(),ids=['T0005','T0006'],before=structuredClone(units),resolved=V.resolveEvidence(wording(verb),units,ids,{action:true});
 assert.deepEqual(resolved.evidenceIds,ids);assert.deepEqual(resolved.weakIds,ids);assert.equal(resolved.supportScore,0);
 assert.deepEqual(units,before);assert.deepEqual(ids,['T0005','T0006']);
 // A later normalization must get the same uncertainty, not a promoted cache hit.
 resolved.evidenceIds.push('T0001');resolved.weakIds.length=0;
 const again=V.resolveEvidence(wording(verb),units,ids,{action:true});assert.deepEqual(again.evidenceIds,ids);assert.deepEqual(again.weakIds,ids);
});
test('normalization surfaces uncertainty against the retained source without rewriting the instruction',()=>{
 const units=source(),action={id:'assessment',action:wording('Assess'),owners:['Taylor Finch'],evidenceIds:['T0005','T0006'],timing:{kind:'not_stated',wording:'',exactDate:''},reviewFlagIds:[]};
 const out=V.normaliseAgentResult({actions:[action]},units,'',{enforceEvidence:false});
 assert.equal(out.actions.length,1);assert.equal(out.actions[0].action,action.action);assert.ok(!out.actions[0].evidenceIds.includes('T0001'));
 for(const id of action.evidenceIds)assert.ok(out.actions[0].evidenceIds.includes(id));
 assert.ok(out.reviewFlags.some(flag=>flag.kind==='missing_evidence'&&flag.status==='open'&&flag.evidenceIds.includes('T0005')));
});
test('invalid supplied IDs remain invalid and never become retained evidence',()=>{
 const out=V.resolveEvidence(wording('Assess'),source(),['T0005','T9999','T0006','T0005'],{action:true});
 assert.deepEqual(out.evidenceIds,['T0005','T0006']);assert.deepEqual(out.weakIds,['T0005','T0006']);assert.deepEqual(out.invalidIds,['T9999']);
});
test('a genuinely supported alternative still repairs the wrong workstream',()=>{
 const units=V.normaliseSourceUnits([
  {id:'T0001',speaker:'Taylor Finch',text:"I'll prepare the annual finance report."},
  {id:'T0002',speaker:'Morgan Reed',text:'The supplier insurance register is still awaiting review.'},
  {id:'T0003',speaker:'Taylor Finch',text:"I'll review the supplier insurance register and confirm the missing certificates."}
 ]);
 const out=V.resolveEvidence('Review the supplier insurance register and confirm the missing certificates.',units,['T0001'],{action:true});
 assert.ok(out.evidenceIds.includes('T0003'));assert.ok(!out.evidenceIds.includes('T0001'));
});
test('unsupported explicit values cannot acquire fallback evidence',()=>{
 const out=V.resolveEvidence('Assess guideline 72912 and determine whether action is required.',source(),['T0005'],{action:true});
 assert.deepEqual(out.evidenceIds,[]);assert.ok(out.weakIds.includes('T0005'));
});
