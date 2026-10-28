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
const run=(actions=pair(),options={})=>reconcileGeneratedSemanticStage({changes:{actions}},{sourceUnits:options.sourceUnits||sources},'actions',{policy,ask,...options});

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
 if(mode==='component')assert.ok(output.changes.qualityState.actions.semanticReconciliation.unresolved.some(item=>item.reason==='qualified_repeat_source_role_conflict'));
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

test('qualified-repeat role clarification is scoped and never converts component evidence into a commitment',()=>{
 const [p,c]=pair(),a=C.reviewPacket(p,c,sources,['T0001'],false),b=C.reviewPacket(p,c,sources,['T0001'],true);
 assert.match(N.prompt(a),/Classify each source row relative to the TWO actions/);
 assert.match(N.prompt(a),/Never relabel a source row merely to permit consolidation/);
 const first=response(a),second=response(b);first.decisions[0].rows[1].basis='required_component';
 assert.throws(()=>C.certify(p,c,sources,['T0001'],first,second),/qualified_repeat_source_role_conflict/);
 const plain={...a,instructionComparison:'content_instruction'};
 assert.doesNotMatch(N.prompt(plain),/QUALIFIED REPEAT ROLE RULE/);
});

test('same-operation detail needs correct directional roles, complete retention and two independent proofs',async()=>{
 const records=pair();records[0].action='Take a photo of the boundary fence and include it with the council correspondence.';records[1].action='Take a photo of the railway-side boundary fence damage';
 records[0].timing={kind:'target',wording:'tomorrow; as part of the council correspondence this week',exactDate:''};records[1].timing={kind:'target',wording:'tomorrow',exactDate:''};
 const photoSources=require('../utils/meetingMinutesAgentV2').normaliseSourceUnits([{id:'T0001',speaker:'Maya Patel',text:'I will take a photo of the railway-side boundary fence damage tomorrow and include that photo with the council correspondence this week.'}]);
 const detailAsk=async(...args)=>{const answer=await ask(...args);answer.result.decisions[0].rows[1].basis='required_component';answer.result.decisions[2].relation='discarded_requirement_of_survivor';return answer;};
 let calls=0;const good=await run(records,{sourceUnits:photoSources,ask:async(...args)=>{calls++;return detailAsk(...args);}});
 assert.equal(calls,2);assert.equal(good.changes.actions.length,1);
 for(const mode of ['reversed','unsupported','lost_detail','distinct','challenge']){
  let n=0;const result=await run(records,{sourceUnits:photoSources,ask:async(...args)=>{n++;const answer=await detailAsk(...args);
   if(mode==='reversed')answer.result.decisions[0].rows.forEach((row,i)=>row.basis=i===0?'required_component':'commitment');
   if(mode==='unsupported')answer.result.decisions[0].rows[1].checks[0].status='unclear';
   if(mode==='lost_detail')answer.result.decisions[1].checks[0].status='not_retained';
   if(mode==='distinct'||mode==='challenge'&&n===2)answer.result.decisions[2].relation='distinct_work';return answer;}});
  assert.deepEqual(result.changes.actions,records,mode);assert.equal(n,mode==='challenge'?2:1);
 }
});

function completionFixture(){
 const units=require('../utils/meetingMinutesAgentV2').normaliseSourceUnits([
  {id:'T0001',speaker:'Jordan Blake',text:'Maya, please complete the supplier declaration requirements before I share tender information.'},
  {id:'T0002',speaker:'Maya Patel',text:'I will complete and sign that declaration before you share it.'},
  {id:'T0003',speaker:'Jordan Blake',text:'Yes, the supplier declaration must be in place first.'}
 ]);
 const full=row('full','Before tender information is shared with Maya Patel.');
 full.action='Complete and sign the supplier declaration required for tender participation.';full.evidenceIds=['T0001','T0003'];
 const short=row('short','Before tender information is shared');
 short.action='Complete the supplier declaration requirements.';short.evidenceIds=['T0003'];
 return {units,actions:[full,short]};
}

test('fuller completion/signing nominates generically and supplies the uncited acceptance context',async()=>{
 const f=completionFixture(),before=structuredClone(f);let calls=0;
 assert.equal(C.direction(...f.actions).kind,'qualified_repeat');
 assert.equal(C.direction(...[...f.actions].reverse()).parent.id,'full');
 assert.ok(R.mechanicalCoverage(f.actions[0],f.actions[1]).reasons.includes('operation_would_be_lost'),'the signing operation cannot be discarded');
 const output=await run(f.actions,{sourceUnits:f.units,ask:async prompt=>{
  calls++;const data=JSON.parse(prompt.split('\nDATA\n')[1]);
  assert.ok(data.sourceCatalog.some(ref=>ref.unitId==='T0002'&&ref.field==='text'),'adjacent acceptance must be available');
  return ask(prompt);
 }});
 const saved=JSON.parse(JSON.stringify(output.changes.actions[0])),audit=output.changes.qualityState.actions.semanticReconciliation;
 assert.equal(calls,2);assert.equal(output.changes.actions.length,1,JSON.stringify(audit.unresolved));
 assert.equal(saved.action,f.actions[0].action);assert.deepEqual(saved.timing,f.actions[0].timing);
 assert.equal(saved.timingDecision.status,'unresolved');assert.deepEqual(saved.reviewFlagIds,['warning-full','warning-short']);
 assert.ok(saved.evidenceIds.includes('T0002'));assert.ok(audit.receipts.every(r=>R.validateReconciliationReceipt(r,r.original,saved,f.units)));
 const api=require('../routes/api').stagedEvaluation;
 assert.equal(api.reconcileFinalApprovedActions([saved],f.actions,{sourceUnits:f.units,receipts:audit.receipts}).restored.length,0);
 assert.deepEqual(require('../utils/meetingMinutesEnquiryRecovery').originalEnquiryActions({...api.admitMeetingAgentGeneratedActionChanges({sourceUnits:f.units},output.changes,'completion-proof'),sourceUnits:f.units}),f.actions);
 assert.deepEqual(f,before);
});

test('completion/signing preserves vetoes and all rejection history',async()=>{
 for(const mode of ['unsupported signing','lost condition','different obligation','challenge veto','provider failure']){
  const f=completionFixture();let calls=0;
  const output=await run(f.actions,{sourceUnits:f.units,ask:async prompt=>{
   calls++;if(mode==='provider failure')throw Error('offline');const answer=await ask(prompt);
   if(mode==='unsupported signing')answer.result.decisions[0].rows[0].checks[0].status='unsupported';
   if(mode==='lost condition')answer.result.decisions[1].checks[0].status='not_retained';
   if(mode==='different obligation'||mode==='challenge veto'&&calls===2)answer.result.decisions[2].relation='distinct_work';
   return answer;
  }});
  assert.deepEqual(output.changes.actions,f.actions,mode);assert.equal(calls,mode==='challenge veto'?2:1);
 }
 const f=completionFixture();f.actions[1].timingDecision.status='rejected';f.actions[1].timingDecision.rejectedExactDates=['2026-11-02'];
 const out=await run(f.actions,{sourceUnits:f.units});assert.equal(out.changes.actions.length,1);
 assert.deepEqual(out.changes.actions[0].timingDecision.rejectedExactDates,['2026-11-02']);assert.equal(out.changes.actions[0].timing.exactDate,'');
});

test('completion/signing nomination excludes different documents, owners, reviewer edits and added steps',()=>{
 for(const change of [r=>r.action='Complete the supplier questionnaire requirements.',r=>r.action+=' and send it to procurement',r=>r.action+=' after legal approval',r=>r.owners=['Jo Lee'],r=>r.evidenceIds=['T0009'],r=>r.reviewed=true,r=>r.timing.exactDate='2026-11-02']){
  const f=completionFixture();change(f.actions[1]);assert.equal(C.direction(...f.actions),null);
 }
 const f=completionFixture();assert.equal(C.direction(...f.actions,[...f.actions,{...f.actions[0],id:'ambiguous'}]),null);
});

test('a name outside the two-turn identity window cannot authorize completion/signing',async()=>{
 const f=completionFixture();
 f.units=require('../utils/meetingMinutesAgentV2').normaliseSourceUnits([
  {id:'T0001',speaker:'Jordan Blake',text:'Complete and sign the supplier declaration before sharing tender information.'},
  {id:'T0003',speaker:'Jordan Blake',text:'The supplier declaration requirements come first.'},
  ...Array.from({length:4},(_,i)=>({id:'T'+String(i+4).padStart(4,'0'),speaker:'Jordan Blake',text:'We discussed another matter.'})),
  {id:'T0002',speaker:'Maya Patel',text:'I will review an unrelated invoice.'}
 ]);
 const packet=C.reviewPacket(...f.actions,f.units,f.units.map(u=>u.id),false);
 assert.ok(packet.sourceRows.every(row=>row.ownerWitnesses.every(witness=>witness.refs.length===0)));
 const output=await run(f.actions,{sourceUnits:f.units});assert.deepEqual(output.changes.actions,f.actions);
 assert.equal(output.changes.qualityState.actions.semanticReconciliation.receipts.length,0);
 assert.ok(output.changes.qualityState.actions.semanticReconciliation.unresolved.length>0);
});

test('a present identity witness never replaces the instruction-to-owner source check',async()=>{
 const f=completionFixture(),p=C.reviewPacket(...f.actions,f.units,f.units.map(u=>u.id),false);
 const answer=response(p),r=answer.decisions[0].rows[0],instruction=r.checks.find(c=>p.sourceRows[0].requests.find(q=>q.id===c.id).field==='instruction');
 instruction.refs=['T0001'];
 assert.equal(N.validate(p,answer),'missing_source_owner_witness');
});

test('nearby-identity requests state the ownership reference requirement per check without supplying answers',()=>{
 const f=completionFixture();
 for(const challenge of [false,true]){
  const p=C.reviewPacket(...f.actions,f.units,f.units.map(u=>u.id),challenge),before=structuredClone(p);
  const prompt=N.prompt(p,{completeContract:true}),data=JSON.parse(prompt.split('\nDATA\n')[1]);
  assert.match(prompt,/OWNERSHIP REFERENCE ACCOUNTING/);
  for(const row of data.sourceRows)for(const request of row.requests){
   if(request.ownershipWitnessRequired)assert.deepEqual(request.requiredOwnerWitnessGroups,row.ownerWitnesses);
   else assert.equal(request.requiredOwnerWitnessGroups,undefined);
   const answer=data.outputShape.decisions[0].rows.find(r=>r.rowId===row.rowId).checks.find(c=>c.id===request.id);
   assert.equal(answer.status,'unclear');assert.deepEqual(answer.refs,[]);
  }
  assert.deepEqual(p,before);
  const responseWithoutWitness=response(p);
  for(const row of responseWithoutWitness.decisions[0].rows){
   const sourceRow=p.sourceRows.find(r=>r.rowId===row.rowId);
   for(const check of row.checks)if(sourceRow.requests.find(r=>r.id===check.id).ownershipWitnessRequired)check.refs=['T0001'];
  }
  assert.equal(N.validate(p,responseWithoutWitness),'missing_source_owner_witness');
 }
});
