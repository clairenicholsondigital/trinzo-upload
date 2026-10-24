'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const V=require('../utils/meetingMinutesAgentV2'),R=require('../utils/meetingMinutesMinimalFidelityRepair'),C=require('../utils/canonicalMinutes/discussionClaimConsolidation');
const future='Morgan Lee will review the supplier documents.';
function fixture(){
 const original=future+' The supplier has sent a registration confirmation email.';
 const corrected=future+' The supplier has received a registration confirmation email.';
 const sourceUnits=[{id:'T0001',speaker:'Chair',text:future},{id:'T0002',speaker:'Supplier',text:'I received a registration confirmation email.'}];
 const discussion=[{topic:'Supplier documents',points:[{id:'supplier',text:original,evidenceIds:['T0001','T0002'],reviewFlagIds:[],supportingDetails:[]}],decisions:[],openQuestions:[]}];
 const items=V.discussionFidelityCheckItems(discussion,sourceUnits);
 const initial=[{id:items[0].id,verdict:'corrected',issue:'',problemQuote:original,evidenceQuote:sourceUnits[1].text,correctedText:'Morgan Lee agreed to review the supplier documents. The supplier received a registration confirmation email.',reason:'The source says received.'}];
 const result={id:items[0].id,verdict:'corrected',issue:'',problemQuote:original,evidenceQuote:sourceUnits[1].text,correctedText:corrected,reason:'The source says received.'};
 const proof={version:R.VERSION,id:items[0].id,originalHash:C.hash(original),correctedHash:C.hash(corrected),originalContainsError:true,errorCorrected:true,correctedFullySourceSupported:true,allOtherClaimsRetained:true,noNewWork:true,sameFutureAssertions:true,sameTemporalClaims:true,explicitQuantitiesUnchanged:true,allImplicitQuantityChangesSourceSupported:true,sourceWitnesses:[{sourceId:'T0002',quote:sourceUnits[1].text}]};
 return{original,corrected,sourceUnits,discussion,items,initial,result,proof:{results:[proof]}};
}
async function run(f,transform={}){const calls=[];const result=await R.repair(f.discussion,f.items,f.initial,{request:async(part,prompt)=>{calls.push(part);const r=structuredClone(part==='proposal'?{schemaVersion:1,results:[f.result]}:f.proof);transform[part]?.(part==='verification'?r.results[0]:r);return r;}});return{result,calls};}
test('small independently verified factual correction preserves existing work and passes the original guard',async()=>{
 const f=fixture(),baseline=V.applyDiscussionFidelityResults(f.discussion,f.items,f.initial);assert.equal(baseline.accounting.items[0].reason,'correction_assertion_strength_not_proved');
 const {result,calls}=await run(f);assert.deepEqual(calls,['proposal','verification']);assert.equal(result.corrected,1);assert.equal(result.discussion[0].points[0].text,f.corrected);assert.ok(result.discussion[0].points[0].text.startsWith(future));
 assert.equal(result.accounting.minimalCorrectionRepair.applied,true);assert.deepEqual(result.accounting.minimalCorrectionRepair.attempts[0].originalResult,f.initial[0]);assert.equal(f.discussion[0].points[0].text,f.original);
});
for(const [name,change] of [
 ['semantic rejection',p=>p.noNewWork=false],['unsupported correction',p=>p.correctedFullySourceSupported=false],
 ['lost fact',p=>p.allOtherClaimsRetained=false],['changed target',p=>p.correctedHash='changed'],
 ['invented quotation',p=>p.sourceWitnesses[0].quote='Invented'],['borrowed source',p=>p.sourceWitnesses[0].sourceId='T0099'],
 ['unknown proof metadata',p=>p.extra=true],['style-only change',p=>p.originalContainsError=false],['implicit quantity not proved',p=>p.allImplicitQuantityChangesSourceSupported=false],['temporal claim changed',p=>p.sameTemporalClaims=false]
])test(name+' retains original wording, warning and failure history',async()=>{
 const f=fixture(),baseline=V.applyDiscussionFidelityResults(f.discussion,f.items,f.initial),{result}=await run(f,{verification:change});assert.deepEqual(result.discussion,baseline.discussion);assert.deepEqual(result.flags,baseline.flags);assert.equal(result.accounting.minimalCorrectionRepair.applied,false);
});
for(const [name,value]of[
 ['new work',future+' The supplier has received a registration confirmation email and can send it to the reviewer.'],
 ['changed future clause','Morgan Lee will prepare the supplier documents. The supplier has received a registration confirmation email.'],
 ['removed work','The supplier has received a registration confirmation email.'],
 ['new number',future+' The supplier has received 2 registration confirmation emails.'],
 ['new name',future+' The supplier has received a registration confirmation email from Nora.'],
 ['new condition',future+' The supplier has received a registration confirmation email only if the request is approved.']
])test('bounded edit rejects '+name,async()=>{const f=fixture(),{result,calls}=await run(f,{proposal:p=>p.results[0].correctedText=value});assert.deepEqual(calls,['proposal']);assert.equal(result.accounting.minimalCorrectionRepair.applied,false);});
test('provider failure preserves rejected original without approving a flag',async()=>{
 const f=fixture(),baseline=V.applyDiscussionFidelityResults(f.discussion,f.items,f.initial),result=await R.repair(f.discussion,f.items,f.initial,{request:async()=>{throw Error('offline');}});assert.deepEqual(result.discussion,baseline.discussion);assert.deepEqual(result.flags,baseline.flags);
});
test('supported rows and reviewer-authored rows make no repair calls',async()=>{
 for(const manual of [false,true]){const f=fixture();if(manual){f.discussion[0].points[0].reviewerAuthored=true;f.items=V.discussionFidelityCheckItems(f.discussion,f.sourceUnits);}else f.initial=[{id:f.items[0].id,verdict:'supported'}];let calls=0;await R.repair(f.discussion,f.items,f.initial,{request:async()=>{calls++;}});assert.equal(calls,0);}
});
test('source changed during the independent check cannot authorise a repair',async()=>{
 const f=fixture();const result=await R.repair(f.discussion,f.items,f.initial,{request:async(part)=>{
  if(part==='proposal')return{results:[f.result]};f.items[0].passageUnits[1].text='Changed source';return f.proof;
 }});assert.equal(result.accounting.minimalCorrectionRepair.applied,false);assert.equal(result.accounting.minimalCorrectionRepair.attempts[0].reason,'stale_input');
});
test('one failed item does not prevent checking a second, while total repair calls stay bounded',async()=>{
 const f=fixture(),other=structuredClone(f.items[0]);other.id='df-second';other.path=[0,'points',1];other.rowIndex=1;
 f.discussion[0].points.push({...structuredClone(f.discussion[0].points[0]),id:'second'});f.items.push(other);f.initial.push({...f.initial[0],id:other.id});let calls=0;
 const result=await R.repair(f.discussion,f.items,f.initial,{request:async(part,prompt)=>{
  calls++;if(calls===1)return{results:[{id:f.items[0].id,verdict:'uncertain'}]};
  if(part==='proposal')return{results:[{...f.result,id:other.id}]};return{results:[{...f.proof.results[0],id:other.id}]};
 }});assert.equal(calls,3);assert.equal(result.corrected,1);assert.equal(result.discussion[0].points[0].text,f.original);assert.equal(result.discussion[0].points[1].text,f.corrected);
 assert.equal(result.accounting.minimalCorrectionRepair.attempts.length,2);
});
test('repair receipt survives payload save normalization and stays private',async()=>{
 const f=fixture(),{result}=await run(f),A=require('../routes/api').stagedEvaluation;
 const audit=result.accounting.minimalCorrectionRepair;
 const payload=A.meetingAgentDraftPayload({discussion:result.discussion,actions:[],sourceUnits:f.sourceUnits,reviewFlags:result.flags,qualityState:{discussion:{minimalFidelityRepair:audit}}});
 assert.deepEqual(payload.qualityState.discussion.minimalFidelityRepair,audit);
 assert.equal(A.publicMeetingAgentDraft(payload).qualityState,undefined);
});
test('spelled quantities and temporal qualifiers cannot change in a small edit',()=>{
 assert.equal(R.boundedEdit('The reviewer has received three confirmation emails.','The reviewer has received two confirmation emails.'),null);
 assert.equal(R.boundedEdit('The reviewer has probably received the email.','The reviewer has received the email.'),null);
 assert.equal(R.boundedEdit('The reviewer received the email before approval.','The reviewer received the email after approval.'),null);
});
test('pre-existing warnings on the target cannot be reinterpreted by this factual repair',async()=>{
 const f=fixture();f.discussion[0].points[0].reviewFlagIds=['existing-attribution'];let calls=0;
 const result=await R.repair(f.discussion,f.items,f.initial,{request:async()=>{calls++;}});assert.equal(calls,0);assert.equal(result.accounting.minimalCorrectionRepair,undefined);
});
test('publishing one correction preserves unrelated flag identities and withheld material',async()=>{
 const f=fixture();f.discussion[0].points.push({id:'unrelated',text:'The supplier report is complete and contains approved test results.',evidenceIds:['T0002'],reviewFlagIds:[]});
 f.items=V.discussionFidelityCheckItems(f.discussion,f.sourceUnits);
 f.initial.push({id:f.items[1].id,verdict:'uncertain',issue:'added_detail',problemQuote:f.discussion[0].points[1].text,evidenceQuote:'',reason:'The source does not establish that the report is complete.'});
 const baseline=V.applyDiscussionFidelityResults(f.discussion,f.items,f.initial),{result}=await run(f);
 assert.equal(result.accounting.minimalCorrectionRepair.applied,true);assert.deepEqual(result.withheld,baseline.withheld);
 const originalMeaning=baseline.flags.find(x=>/^flag-fidelity-meaning-/.test(x.id));
 for(const flag of baseline.flags.filter(x=>x.id!==originalMeaning.id))assert.deepEqual(result.flags.find(x=>x.id===flag.id),flag);
 assert.deepEqual(result.discussion[0].points.slice(1),baseline.discussion[0].points.slice(1));
});
