'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../utils/canonicalMinutes/containedRequirement');
const R=require('../utils/canonicalMinutes/actionSemanticReconciliation');
const N=require('../utils/meetingMinutesActionReferenceReview');
const V=require('../utils/meetingMinutesAgentV2');
const {captureSemanticPolicy}=require('../utils/meetingMinutesSemanticPolicy');
const {reconcileGeneratedSemanticStage}=require('../utils/meetingMinutesSemanticStage');
const response=require('./helpers/meeting-minutes-dependency-response');
const policy=captureSemanticPolicy({MEETING_MINUTES_AGENT_CONTAINED_REQUIREMENTS_V1:'1',MEETING_MINUTES_AGENT_EXACT_INSTRUCTION_REPEAT_V1:'1',MEETING_MINUTES_AGENT_BOUNDED_SURVIVOR_DEDUPE_V1:'1',MEETING_MINUTES_AGENT_CONTACT_ENQUIRY_DEDUPE_V1:'1'});
const sources=V.normaliseSourceUnits([{id:'T0001',speaker:'Maya Patel',text:'I will email the first three suppliers to request a quote and allow two weeks for a response.'}]);
const row=(id,kind)=>({id,action:'Email the first three suppliers to request a quote and allow two weeks for a response.',owners:['Maya Patel'],
 timing:{kind,wording:'allow two weeks for a response',exactDate:''},timingDecision:{status:'unresolved',reason:'timing_source_unresolved',rejectedExactDates:[],rejectedWordings:[],binding:{status:'unresolved',conflictingSourceIds:[]}},evidenceIds:['T0001'],reviewFlagIds:['warning-'+id]});
const pair=()=>[row('target','target'),row('deadline','deadline')];
const ask=async prompt=>({result:response(JSON.parse(prompt.split('\nDATA\n')[1]))});
const run=(actions=pair(),options={})=>reconcileGeneratedSemanticStage({changes:{actions}},{sourceUnits:sources},'actions',{policy,ask,...options});
const packet=actions=>R.prepareActionReconciliation({actions,sourceUnits:sources,...policy});

test('equal-length exact instructions nominate the existing target in either order, without automatic merge',()=>{
 const [p,c]=pair();assert.equal(C.direction(p,c).kind,'exact_instruction_repeat');assert.equal(C.direction(c,p).parent.id,p.id);
 for(const rows of [[p,c],[c,p]]){const q=packet(rows);assert.equal(q.candidates.length,1);assert.equal(q.rows.find(r=>r.ref===q.candidates[0].containedRequirement.survivorRef).action.timing.kind,'target');assert.equal(R.applyActionReconciliation(q,R.buildDeterministicEnvelope(q),{sourceUnits:sources}).actions.length,2);}
 for(const mutate of [x=>x.action=x.action.replace('three','four'),x=>x.owners=['Someone Else'],x=>x.action=x.action.replace('suppliers','customers'),x=>x.timing.wording='within three weeks',x=>x.timing.exactDate='2026-11-01',x=>x.timingDecision.status='verified',x=>x.timingDecision.binding.conflictingSourceIds=['T0002'],x=>x.evidenceIds=['T0002'],x=>x.timingDecision.rejectedWordings=[x.timing.wording],x=>x.reviewed=true,x=>x.unknownMetadata='retain me',x=>x.timing.kind='target']){
  const changed=structuredClone(c);mutate(changed);assert.equal(C.shape(p,changed),null);
 }
 assert.equal(C.direction(p,c,[p,c,{...p,id:'another-occurrence'}]),null);
 const kept=R.prepareActionReconciliation({actions:[p,c],sourceUnits:sources,...policy,protectedActionIds:[p.id]});assert.equal(kept.candidates.length,0);
});

test('independent proofs preserve all warning and timing histories in receipts, recovery and final preservation',async()=>{
 const records=pair();records[1].timingDecision.status='rejected';records[1].timingDecision.rejectedExactDates=['2026-11-01'];let calls=0;
 const out=await run(records,{ask:async(...args)=>{calls++;return ask(...args);}}),audit=out.changes.qualityState.actions.semanticReconciliation;
 assert.equal(calls,2);assert.equal(out.changes.actions.length,1,JSON.stringify(audit.unresolved));
 const saved=JSON.parse(JSON.stringify(out.changes.actions[0]));assert.deepEqual(saved.timing,records[0].timing);assert.equal(saved.timingDecision.status,'unresolved');
 assert.deepEqual(saved.timingDecision.rejectedExactDates,['2026-11-01']);assert.deepEqual(saved.reviewFlagIds,['warning-deadline','warning-target']);
 assert.equal(audit.receipts.length,1);const receipt=audit.receipts[0];
 assert.deepEqual(receipt.lineage.map(r=>r.original.timingDecision).sort((a,b)=>a.status.localeCompare(b.status)),records.map(r=>r.timingDecision).sort((a,b)=>a.status.localeCompare(b.status)));
 assert.ok(R.validateReconciliationReceipt(receipt,receipt.original,saved,sources));
 const api=require('../routes/api').stagedEvaluation;
 assert.equal(api.reconcileFinalApprovedActions([saved],records,{sourceUnits:sources,receipts:audit.receipts}).restored.length,0);
 const draft=JSON.parse(JSON.stringify({...api.admitMeetingAgentGeneratedActionChanges({sourceUnits:sources},out.changes,'exact-instruction-contract'),sourceUnits:sources}));
 assert.deepEqual(require('../utils/meetingMinutesEnquiryRecovery').originalEnquiryActions(draft),records);
 for(const mutate of [s=>s.timing.kind='deadline',s=>s.timingDecision.status='verified',s=>s.timingDecision.rejectedExactDates=[],s=>s.reviewFlagIds=[],s=>s.action=s.action.replace('three','four')]){
  const edited=structuredClone(saved);mutate(edited);assert.equal(R.validateReconciliationReceipt(receipt,receipt.original,edited,sources),false);
 }
 assert.equal(R.validateReconciliationReceipt(receipt,receipt.original,saved,[{...sources[0],text:'Changed source'}]),false);
});

test('vetoes, unsupported source roles, missing source and provider errors preserve originals without retry',async()=>{
 for(const mode of ['source','retention','component','distinct','failure','challenge','wording']){let calls=0;const out=await run(pair(),{ask:async(...args)=>{calls++;if(mode==='failure')throw Error('offline');const answer=await ask(...args);
  if(mode==='source')answer.result.decisions[0].rows[0].checks[0].status='unclear';
  if(mode==='retention')answer.result.decisions[1].checks[0].status='not_retained';
  if(mode==='component')answer.result.decisions[0].rows[1].basis='required_component';
  if(mode==='distinct'||mode==='challenge'&&calls===2)answer.result.decisions[2].relation='distinct_work';
  if(mode==='wording'){const data=JSON.parse(args[0].split('\nDATA\n')[1]);for(const check of answer.result.decisions[1].checks)if(data.retentionRequests.find(r=>r.id===check.id).field==='timing')check.refs=[data.survivorCatalog.find(r=>r.field==='timing.kind').id];}
  return answer;}});assert.deepEqual(out.changes.actions,pair(),mode);assert.equal(calls,['challenge','wording'].includes(mode)?2:1,mode);}
 const missing=await reconcileGeneratedSemanticStage({changes:{actions:pair()}},{sourceUnits:[]},'actions',{policy,ask});assert.deepEqual(missing.changes.actions,pair());
});

test('certificate is independently bound and cannot retain timing by kind alone',()=>{
 const [p,c]=pair(),first=C.reviewPacket(p,c,sources,['T0001'],false),second=C.reviewPacket(p,c,sources,['T0001'],true);
 assert.match(N.prompt(first),/EXACT INSTRUCTION COMPARISON/);
 assert.throws(()=>C.certify(p,c,sources,['T0001'],response(first),response(first)),/wrong_request_binding/);
 const bad=response(second);for(const check of bad.decisions[1].checks)if(second.retentionRequests.find(r=>r.id===check.id).field==='timing')check.refs=[second.survivorCatalog.find(r=>r.field==='timing.kind').id];
 assert.throws(()=>C.certify(p,c,sources,['T0001'],response(first),bad),/timing_wording_not_retained/);
});

test('new exact comparisons use spare capacity and do not displace established classes',()=>{
 const records=[...pair(),row('other','not_stated'),row('other-short','not_stated')];
 for(const a of records.slice(2)){a.timing={kind:'not_stated',wording:'',exactDate:''};delete a.timingDecision;a.reviewFlagIds=[];a.evidenceIds=['T0002'];}
 records[2].action='Draft the membership notice explaining the annual fee increase.';records[3].action='Explain the annual fee increase in the membership notice.';
 for(const actions of [records,[...records].reverse(),records.map((r,i)=>({...r,id:'changed-'+i}))]){
  const q=packet(actions);assert.equal(q.candidates.length,2);assert.equal(q.rows.find(r=>r.ref===q.candidates[0].containedRequirement.survivorRef).action.action,records[2].action);
 }
 const q=R.prepareActionReconciliation({actions:records,sourceUnits:sources,...policy,maxCandidates:1});assert.equal(q.candidates.length,1);assert.ok(q.unresolved.some(r=>r.reason==='candidate_budget_exhausted'));
 const flags=pair();flags[0].reviewFlagIds=Array.from({length:24},(_,i)=>'f'+i);assert.equal(packet(flags).candidates.length,0);
});


test('exact instruction comparisons are opt-in and pinned to the generation policy',async()=>{
 const P=require('../utils/meetingMinutesSemanticPolicy');
 const oldPolicy=P.captureSemanticPolicy({MEETING_MINUTES_AGENT_CONTAINED_REQUIREMENTS_V1:'1'});
 assert.equal(oldPolicy.exactInstructionRepeats,undefined);
 assert.equal(P.normaliseSemanticPolicy({...oldPolicy,containedRequirements:false,exactInstructionRepeats:true}).exactInstructionRepeats,undefined);
 const old=await run(pair(),{policy:oldPolicy});assert.deepEqual(old.changes.actions,pair());assert.equal(old.changes.qualityState.actions.semanticReconciliation.assessment.nominatedCandidates,0);
 assert.equal(P.semanticPolicyForRun({_semanticPolicy:oldPolicy}).exactInstructionRepeats,undefined);
 assert.equal(P.semanticPolicyForRun({_semanticPolicy:policy}).exactInstructionRepeats,true);
});

test('background persistence and public output keep warnings and reversible original timing decisions',async()=>{
 const api=require('../routes/api').stagedEvaluation,records=pair();
 const flags=records.map(r=>V.normaliseFlag({id:r.reviewFlagIds[0],kind:'timing',status:'open',message:'Confirm '+r.timing.kind+' classification: '+r.timing.wording,evidenceIds:r.evidenceIds}));
 const initial={draftId:'exact-repeat-save',revision:1,payloadVersion:V.PAYLOAD_VERSION,sourceUnits:sources,actions:[],discussion:[],reviewFlags:[],qualityState:{},
  details:{meetingTitle:'Supplier review',meetingDate:'2026-10-27',meetingType:'General',internalAttendees:['Maya Patel'],clientAttendees:[]},
  staleStages:[],currentStep:3,selectedStep:3,changeHistory:[],redoHistory:[],meetingObjectives:[],unassignedSupportingDetails:[]};
 const result=await run();result.reviewFlags=flags;let saved=structuredClone(initial),writes=0;
 await api.persistMeetingAgentBackgroundStage({draftId:initial.draftId,userId:1,stage:'actions',sourceDraft:initial,result,wait:async()=>{},
  getDraft:async()=>structuredClone(saved),saveDraft:async(fresh,changes)=>{writes++;saved=JSON.parse(JSON.stringify({...fresh,...changes,revision:fresh.revision+1}));return structuredClone(saved);}});
 assert.equal(writes,1);assert.equal(saved.actions.length,1);assert.deepEqual(saved.reviewFlags,flags);
 const visible=api.publicMeetingAgentDraft(api.meetingAgentDraftPayload(saved));assert.equal(visible.actions.length,1);
 assert.deepEqual(visible.actions[0].reviewFlagIds,['warning-deadline','warning-target']);assert.deepEqual(visible.reviewFlags,flags);assert.equal(visible.qualityState,undefined);
 assert.deepEqual(require('../utils/meetingMinutesEnquiryRecovery').originalEnquiryActions(saved),records);
 const stable=api.reconcileFinalApprovedActions(saved.actions,records,{sourceUnits:sources,receipts:saved.qualityState.actions.semanticReconciliation.receipts});
 assert.deepEqual(stable.restored,[]);assert.deepEqual(stable.actions,saved.actions);
});

test('exhausted shared deadline preserves originals instead of accepting a single source review',async()=>{
 const now=Date.now;let elapsed=0,calls=0;Date.now=()=>now()+elapsed;
 try{
  const out=await run(pair(),{ask:async(...args)=>{calls++;const answer=await ask(...args);elapsed=100000;return answer;}});
  assert.equal(calls,1);assert.deepEqual(out.changes.actions,pair());
  assert.ok(out.changes.qualityState.actions.semanticReconciliation.unresolved.some(r=>r.reason==='semantic_budget_exhausted'));
 }finally{Date.now=now;}
});
