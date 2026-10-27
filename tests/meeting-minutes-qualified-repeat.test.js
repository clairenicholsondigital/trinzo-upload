'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../utils/canonicalMinutes/containedRequirement');
const R=require('../utils/canonicalMinutes/actionSemanticReconciliation');
const N=require('../utils/meetingMinutesActionReferenceReview');
const {captureSemanticPolicy}=require('../utils/meetingMinutesSemanticPolicy');
const {reconcileGeneratedSemanticStage}=require('../utils/meetingMinutesSemanticStage');
const response=require('./helpers/meeting-minutes-dependency-response');
const policy=captureSemanticPolicy({MEETING_MINUTES_AGENT_CONTAINED_REQUIREMENTS_V1:'1'});
const sources=require('../utils/meetingMinutesAgentV2').normaliseSourceUnits([{id:'T0001',speaker:'Maya Patel',text:'I will share the inspection analysis with Jordan once we have more information, before Jordan arrives. I need confidentiality and conduct agreements in place before sharing.'}]);
const row=(id,wording)=>({id,action:'Share the inspection analysis with Jordan.',owners:['Maya Patel'],timing:{kind:'dependency',wording,exactDate:''},
 timingDecision:{status:'unresolved',reason:'timing_source_unresolved',rejectedExactDates:[],rejectedWordings:[],binding:{status:'unresolved',conflictingSourceIds:[]}},evidenceIds:['T0001'],reviewFlagIds:['warning-'+id]});
const pair=()=>[row('full','Once more information and the confidentiality and conduct agreements are in place; before Jordan arrives.'),row('short','Once more information is available, before Jordan arrives.')];
const ask=async(prompt)=>({result:response(JSON.parse(prompt.split('\nDATA\n')[1]))});
const run=(actions=pair(),options={})=>reconcileGeneratedSemanticStage({changes:{actions}},{sourceUnits:sources},'actions',{policy,ask,...options});

test('qualified repeats nominate an existing fuller record in either order; no deterministic merge',()=>{
 const [p,c]=pair();assert.equal(C.direction(p,c).kind,'qualified_repeat');assert.equal(C.direction(c,p).parent.id,p.id);
 const packet=R.prepareActionReconciliation({actions:[p,c],sourceUnits:sources,scope:policy.scope,containedRequirements:true});
 assert.equal(packet.candidates.length,1);assert.equal(R.applyActionReconciliation(packet,R.buildDeterministicEnvelope(packet),{sourceUnits:sources}).actions.length,2);
 for(const mutate of [x=>x.owners=['Someone Else'],x=>x.timing.exactDate='2026-10-28',x=>x.timing.kind='not_stated',x=>x.timingDecision.status='verified',x=>x.timingDecision.binding.conflictingSourceIds=['T0002'],x=>x.action='Write the inspection letter.',x=>x.evidenceIds=['T0002'],x=>x.reviewed=true,x=>x.unrecognisedMetadata=true]){
  const changed=structuredClone(c);mutate(changed);assert.equal(C.shape(p,changed),null);
 }
 assert.equal(C.direction(p,c,[p,c,{...p,id:'third'}]),null);
});
test('two independent source proofs retain conditions, all flags and active rejection guards, with recoverable originals',async()=>{
 const records=pair();records[1].timingDecision.status='rejected';records[1].timingDecision.rejectedExactDates=['2026-10-28'];let calls=0;
 const output=await run(records,{ask:async(...args)=>{calls++;return ask(...args);}}),audit=output.changes.qualityState.actions.semanticReconciliation;
 assert.equal(calls,2);assert.equal(output.changes.actions.length,1,JSON.stringify(audit.unresolved));
 const saved=JSON.parse(JSON.stringify(output.changes.actions[0]));assert.equal(saved.action,records[0].action);assert.deepEqual(saved.timing,records[0].timing);
 assert.equal(saved.timingDecision.status,'unresolved');assert.deepEqual(saved.timingDecision.rejectedExactDates,['2026-10-28']);
 assert.deepEqual(saved.reviewFlagIds,['warning-full','warning-short']);assert.deepEqual(saved.evidenceIds,['T0001']);
 assert.ok(audit.receipts.length);for(const receipt of audit.receipts)assert.ok(R.validateReconciliationReceipt(receipt,receipt.original,saved,sources));
 assert.ok(audit.receipts.some(receipt=>receipt.original.timingDecision.status==='rejected'));
 const api=require('../routes/api').stagedEvaluation;
 assert.equal(api.reconcileFinalApprovedActions([saved],records,{sourceUnits:sources,receipts:audit.receipts}).restored.length,0);
 const draft={...api.admitMeetingAgentGeneratedActionChanges({sourceUnits:sources},output.changes,'qualified-repeat-contract'),sourceUnits:sources};assert.deepEqual(require('../utils/meetingMinutesEnquiryRecovery').originalEnquiryActions(draft),records);
 for(const mutate of [s=>s.timing.wording='Immediately',s=>s.reviewFlagIds=[],s=>s.timingDecision.rejectedExactDates=[]]){
  const edited=structuredClone(saved);mutate(edited);assert.ok(audit.receipts.some(receipt=>!R.validateReconciliationReceipt(receipt,receipt.original,edited,sources)));
 }
});
test('source or retention veto, component-only answer and provider failure retain both without retry',async()=>{
 for(const mode of ['source','retention','component','failure','challenge']){let calls=0;const output=await run(pair(),{ask:async(...args)=>{calls++;if(mode==='failure')throw Error('offline');const answer=await ask(...args);
  if(mode==='source')answer.result.decisions[0].rows[0].checks[0].status='unclear';
  if(mode==='retention')answer.result.decisions[1].checks[0].status='not_retained';
  if(mode==='component')answer.result.decisions[0].rows[1].basis='required_component';
  if(mode==='challenge'&&calls===2)answer.result.decisions[2].relation='distinct_work';return answer;}});
 assert.deepEqual(output.changes.actions,pair(),mode);assert.equal(calls,mode==='challenge'?2:1,mode);
 }
});
test('timing-kind reference alone cannot certify complete timing retention',()=>{
 const [p,c]=pair(),a=C.reviewPacket(p,c,sources,['T0001'],false),b=C.reviewPacket(p,c,sources,['T0001'],true);
 const first=response(a),second=response(b);for(const check of second.decisions[1].checks)if(b.retentionRequests.find(r=>r.id===check.id).field==='timing')check.refs=[b.survivorCatalog.find(ref=>ref.field==='timing.kind').id];
 assert.throws(()=>C.certify(p,c,sources,['T0001'],first,second),/timing_wording_not_retained/);
 assert.throws(()=>C.certify(p,c,sources,['T0001'],first,first),/wrong_request_binding/);
 assert.match(N.prompt(a),/QUALIFIED REPEAT COMPARISON/);
});
test('attachment variant only nominates the photograph, never the separately assigned correspondence',()=>{
 const [p,c]=pair();p.action='Take a photo of the boundary fence and include it with the council correspondence.';c.action='Take a photo of the railway-side boundary fence damage';
 p.timing={kind:'target',wording:'tomorrow; as part of the correspondence this week',exactDate:''};c.timing={kind:'target',wording:'tomorrow',exactDate:''};
 assert.equal(C.direction(p,c).kind,'qualified_repeat');
 assert.equal(C.direction(p,{...c,action:'Write to the council about the boundary fence with a photo this week.'}),null);
});

test('background persistence and public output retain open warnings after consolidation',async()=>{
 const api=require('../routes/api').stagedEvaluation,V=require('../utils/meetingMinutesAgentV2');
 const flags=pair().map(row=>V.normaliseFlag({id:row.reviewFlagIds[0],kind:'timing',status:'open',message:'Confirm timing: '+row.timing.wording,evidenceIds:row.evidenceIds}));
 const initial={draftId:'qualified-repeat-save',revision:1,payloadVersion:V.PAYLOAD_VERSION,sourceUnits:sources,actions:[],discussion:[],reviewFlags:[],qualityState:{},
  details:{meetingTitle:'Inspection review',meetingDate:'2026-10-27',meetingType:'General',internalAttendees:['Maya Patel'],clientAttendees:[]},
  staleStages:[],currentStep:3,selectedStep:3,changeHistory:[],redoHistory:[],meetingObjectives:[],unassignedSupportingDetails:[]};
 const result=await run();result.reviewFlags=flags;let saved=structuredClone(initial),writes=0;
 await api.persistMeetingAgentBackgroundStage({draftId:initial.draftId,userId:1,stage:'actions',sourceDraft:initial,result,wait:async()=>{},
  getDraft:async()=>structuredClone(saved),saveDraft:async(fresh,changes)=>{writes++;saved=JSON.parse(JSON.stringify({...fresh,...changes,revision:fresh.revision+1}));return structuredClone(saved);}});
 assert.equal(writes,1);assert.equal(saved.actions.length,1);assert.deepEqual(saved.reviewFlags,flags);
 const visible=api.publicMeetingAgentDraft(api.meetingAgentDraftPayload(saved));assert.equal(visible.actions.length,1);
 assert.deepEqual(visible.actions[0].reviewFlagIds,['warning-full','warning-short']);assert.deepEqual(visible.reviewFlags,flags);
 assert.equal(visible.qualityState,undefined);assert.deepEqual(require('../utils/meetingMinutesEnquiryRecovery').originalEnquiryActions(saved),pair());
});

test('new qualified comparisons do not displace existing contained-content nominations',()=>{
 const records=[...pair(),{id:'notice-full',action:'Draft the membership notice explaining the annual fee increase.',owners:['Maya Patel'],timing:{kind:'not_stated',wording:'',exactDate:''},evidenceIds:['T0002'],reviewFlagIds:[]},
  {id:'notice-short',action:'Explain the annual fee increase in the membership notice.',owners:['Maya Patel'],timing:{kind:'not_stated',wording:'',exactDate:''},evidenceIds:['T0002'],reviewFlagIds:[]}];
 const packet=R.prepareActionReconciliation({actions:records,sourceUnits:sources,scope:policy.scope,containedRequirements:true,maxCandidates:1});
 assert.equal(packet.candidates.length,1);assert.ok(packet.rows.find(row=>row.ref===packet.candidates[0].containedRequirement.survivorRef).action.id.startsWith('notice-'));
});
