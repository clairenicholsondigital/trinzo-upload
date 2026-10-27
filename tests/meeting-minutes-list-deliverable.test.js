'use strict';
process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1='0';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../utils/canonicalMinutes/containedRequirement');
const R=require('../utils/canonicalMinutes/actionSemanticReconciliation');
const N=require('../utils/meetingMinutesActionReferenceReview');
const V=require('../utils/meetingMinutesAgentV2');
const {captureSemanticPolicy}=require('../utils/meetingMinutesSemanticPolicy');
const {reconcileGeneratedSemanticStage}=require('../utils/meetingMinutesSemanticStage');
const policy=captureSemanticPolicy({MEETING_MINUTES_AGENT_CONTAINED_REQUIREMENTS_V1:'1',MEETING_MINUTES_AGENT_ACTION_PROOF_CONTRACT_V2:'1'});
function fixture(){
 const units=V.normaliseSourceUnits([{id:'T0001',speaker:'Maya Patel',text:'I will prepare and provide one list of all branches receiving shipments for language assessment purposes.'}]);
 const row=(id,action)=>({id,action,owners:['Maya Patel'],timing:{kind:'not_stated',wording:'',exactDate:''},evidenceIds:['T0001'],reviewFlagIds:[]});
 return {units,actions:[row('prepare','Prepare a list of all branches that equipment is shipped to for language assessment purposes.'),
  row('provide','Provide a list of all branches that receive shipments for language assessment purposes.')]};
}
function response(data){
 const result=require('./helpers/meeting-minutes-contained-response')(data);
 result.decisions[0].rows.forEach(row=>{row.basis='commitment';});
 result.decisions[2].relation='same_obligation';
 return result;
}
const ask=async prompt=>({result:response(JSON.parse(prompt.split('\nDATA\n')[1]))});
const run=(f=fixture(),options={})=>reconcileGeneratedSemanticStage({changes:{actions:f.actions}},{sourceUnits:f.units},'actions',{policy,ask,...options});

test('prepare/provide list nomination is generic, directional, bounded and opt-in',()=>{
 const f=fixture(),[a,b]=f.actions;
 assert.equal(C.shape(b,a).kind,'list_deliverable');assert.equal(C.shape(a,b),null);
 assert.equal(C.direction(a,b).parent.id,'provide');assert.equal(C.direction(b,a).parent.id,'provide');
 assert.equal(R.prepareActionReconciliation({actions:f.actions,sourceUnits:f.units,scope:policy.scope}).candidates.length,0);
 assert.equal(R.prepareActionReconciliation({actions:f.actions,sourceUnits:f.units,scope:policy.scope,containedRequirements:true}).candidates.length,1);
 assert.equal(R.prepareActionReconciliation({actions:f.actions,sourceUnits:f.units,scope:policy.scope,containedRequirements:true,protectedActionIds:['prepare']}).candidates.length,0);
 assert.ok(R.mechanicalCoverage(a,b).reasons.includes('different_operation'),'ordinary operation safeguard remains active');
});

for(const [label,change] of [
 ['different owner',r=>r.owners=['Jo Lee']],['missing owner',r=>r.owners=[]],['extra owner',r=>r.owners.push('Jo Lee')],
 ['timing',r=>r.timing={kind:'target',wording:'Friday',exactDate:''}],['warning',r=>r.reviewFlagIds=['warning']],
 ['reviewer edit',r=>r.reviewed=true],['different source',r=>r.evidenceIds=['T0002']],
 ['additional condition',r=>r.action+=' after approval'],['recipient',r=>r.action+=' to Jo Lee'],
 ['different purpose',r=>r.action=r.action.replace('language assessment','insurance planning')],
 ['different object',r=>r.action=r.action.replace('all branches','all suppliers')],
 ['quantity',r=>r.action=r.action.replace('all branches','12 branches')],
 ['separate delivery',r=>r.action+=' and email it to Jo Lee'],
 ['rejected history',r=>r.timingDecision={reason:'no_timing_value',binding:{status:'not_stated'},rejectedExactDates:['2026-10-01']}]
])test(label+' remains outside list nomination',()=>{const f=fixture();change(f.actions[0]);assert.equal(C.direction(...f.actions),null);});

test('two independently bound reviews authorize one unchanged survivor and exact recovery',async()=>{
 const f=fixture(),before=structuredClone(f);let calls=0;
 const A=require('../routes/api').stagedEvaluation;
 const output=await run(f,{ask:async(prompt,options)=>{calls++;assert.equal(options.maxAttempts,1);assert.match(prompt,/LIST DELIVERABLE COMPARISON/);return ask(prompt);},verifySurvival:A.reconcileFinalApprovedActions});
 const saved=JSON.parse(JSON.stringify(A.admitMeetingAgentGeneratedActionChanges({sourceUnits:f.units},output.changes,'list-proof')));
 assert.equal(calls,2);assert.equal(saved.actions.length,1,JSON.stringify(saved.qualityState.actions.semanticReconciliation.unresolved));
 assert.equal(saved.actions[0].action,f.actions[1].action);
 const audit=saved.qualityState.actions.semanticReconciliation;
 assert.equal(audit.stats.merged,1);assert.ok(audit.receipts.every(r=>R.validateReconciliationReceipt(r,r.original,saved.actions[0],f.units)));
 assert.equal(A.reconcileFinalApprovedActions(saved.actions,f.actions,{sourceUnits:f.units,receipts:audit.receipts}).restored.length,0);
 assert.deepEqual(require('../utils/meetingMinutesEnquiryRecovery').originalEnquiryActions({...saved,sourceUnits:f.units}),f.actions);
 assert.deepEqual(f,before);
 const changed=structuredClone(saved);changed.actions[0].action+=' Include suppliers.';
 assert.equal(require('../utils/meetingMinutesEnquiryRecovery').originalEnquiryActions({...changed,sourceUnits:f.units}),null);
 const changedSource=structuredClone(f.units);changedSource[0].text+=' This was withdrawn.';
 assert.ok(audit.receipts.every(r=>!R.validateReconciliationReceipt(r,r.original,saved.actions[0],changedSource)));
});

test('independent preparation/delivery, ambiguous ownership and partial scope are semantic vetoes',async()=>{
 for(const relation of ['distinct_work','partial_overlap','unclear','discarded_requirement_of_survivor']){
  let calls=0;const f=fixture();const result=await run(f,{ask:async prompt=>{calls++;const answer=await ask(prompt);answer.result.decisions[2].relation=relation;return answer;}});
  assert.deepEqual(result.changes.actions,f.actions,relation);assert.equal(calls,1);assert.equal(result.changes.qualityState.actions.semanticReconciliation.stats.merged,0);
 }
 const f=fixture(),p=C.reviewPacket(f.actions[1],f.actions[0],f.units,['T0001'],false),q=C.reviewPacket(f.actions[1],f.actions[0],f.units,['T0001'],true);
 const first=response(JSON.parse(N.prompt(p).split('\nDATA\n')[1])),second=response(JSON.parse(N.prompt(q).split('\nDATA\n')[1]));
 second.decisions[0].rows[1].basis='required_component';
 assert.throws(()=>C.certify(f.actions[1],f.actions[0],f.units,['T0001'],first,second),/veto/);
 assert.throws(()=>C.certify(f.actions[1],f.actions[0],f.units,['T0001'],first,first),/request_binding/);
});

test('a failed independent challenge retains both obligations without retrying approval',async()=>{
 const f=fixture();let calls=0;const result=await run(f,{ask:async prompt=>{if(++calls===2)throw Error('challenge unavailable');return ask(prompt);}});
 assert.equal(calls,2);assert.deepEqual(result.changes.actions,f.actions);assert.equal(result.changes.qualityState.actions.semanticReconciliation.stats.merged,0);
});

test('list proof survives background saving, public projection and exports with exact recovery',async()=>{
 const f=fixture(),A=require('../routes/api').stagedEvaluation;
 const initial={draftId:'list-save',revision:1,payloadVersion:V.PAYLOAD_VERSION,sourceUnits:f.units,actions:[],discussion:[],reviewFlags:[],qualityState:{},
  details:{meetingTitle:'Dispatch review',meetingDate:'2026-10-27',meetingType:'General',internalAttendees:['Maya Patel'],clientAttendees:[]},
  staleStages:[],currentStep:3,selectedStep:3,changeHistory:[],redoHistory:[],meetingObjectives:[],unassignedSupportingDetails:[]};
 let saved=structuredClone(initial),writes=0;
 await A.persistMeetingAgentBackgroundStage({draftId:initial.draftId,userId:1,stage:'actions',sourceDraft:initial,result:await run(f),wait:async()=>{},
  getDraft:async()=>structuredClone(saved),saveDraft:async(fresh,changes)=>{writes++;saved=JSON.parse(JSON.stringify({...fresh,...changes,revision:fresh.revision+1}));return structuredClone(saved);}});
 assert.equal(writes,1);assert.equal(saved.actions.length,1);
 const payload=A.meetingAgentDraftPayload(saved),visible=A.publicMeetingAgentDraft(payload);
 assert.equal(visible.actions[0].action,f.actions[1].action);assert.equal(visible.qualityState,undefined);
 assert.deepEqual(require('../utils/meetingMinutesEnquiryRecovery').originalEnquiryActions(saved),f.actions);
 const JSZip=require('jszip'),{generateMeetingMinutesAgentDocx}=require('../utils/meetingMinutesAgentDocx'),{generateStagedMinutesPdf}=require('../utils/stagedMinutesPdf');
 const zip=await JSZip.loadAsync(await generateMeetingMinutesAgentDocx(A.meetingAgentDraftForDocx(payload),false));
 const xml=await zip.file('word/document.xml').async('string');assert.ok(xml.includes(f.actions[1].action));assert.ok(!xml.includes(f.actions[0].action));
 const pdf=await generateStagedMinutesPdf(A.meetingAgentDraftForPdf(payload,false));assert.equal(pdf.subarray(0,5).toString(),'%PDF-');
});
