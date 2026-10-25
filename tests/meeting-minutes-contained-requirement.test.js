'use strict';
process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1='0';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../utils/canonicalMinutes/containedRequirement');
const R=require('../utils/canonicalMinutes/actionSemanticReconciliation');
const N=require('../utils/meetingMinutesActionReferenceReview');
const {captureSemanticPolicy}=require('../utils/meetingMinutesSemanticPolicy');
const {reconcileGeneratedSemanticStage}=require('../utils/meetingMinutesSemanticStage');
const policy=captureSemanticPolicy({MEETING_MINUTES_AGENT_CONTAINED_REQUIREMENTS_V1:'1'});
const sourceUnits=require('../utils/meetingMinutesAgentV2').normaliseSourceUnits([{id:'T0001',speaker:'Maya Patel',text:'I will draft the membership notice explaining the annual fee increase from £20 to £24 starting in January.'}]);
const row=(id,action)=>({id,action,owners:['Maya Patel'],timing:{kind:'not_stated',wording:'',exactDate:''},evidenceIds:['T0001'],reviewFlagIds:[]});
const original=()=>[row('p','Draft the membership notice explaining the annual fee increase from £20 to £24 starting in January.'),row('c','Explain the annual fee increase in the membership notice.')];
const response=require('./helpers/meeting-minutes-contained-response');
function forPacket(packet){return response({...packet,selectedSurvivor:'A'});}
function fixture(){
 const records=original(),packet=R.prepareActionReconciliation({actions:records,sourceUnits,scope:policy.scope,containedRequirements:true});
 const [parent,child]=records;
 const first=C.reviewPacket(parent,child,sourceUnits,['T0001'],false),second=C.reviewPacket(parent,child,sourceUnits,['T0001'],true);
 const certificate=C.certify(parent,child,sourceUnits,['T0001'],forPacket(first),forPacket(second));
 const p=packet.rows[0],c=packet.rows[1],candidate=packet.candidates[0];
 const envelope={version:packet.version,packetHash:packet.packetHash,sourceHash:packet.sourceHash,inputHash:packet.inputHash,
  decisions:[{candidateId:candidate.candidateId,relation:'equivalent',survivorRef:p.ref,coverage:C.coverage(packet,p,c,certificate)}]};
 return {records,packet,certificate,envelope};
}
const ask=async(prompt,options)=>{assert.equal(options.maxAttempts,1);const data=JSON.parse(prompt.split('\nDATA\n')[1]);return {result:response(data)};};
const run=(records=original(),options={})=>reconcileGeneratedSemanticStage({changes:{actions:records}},{sourceUnits},'actions',{policy,ask,...options});

test('new class is opt-in, frozen, action-only and capped at one candidate',async()=>{
 assert.equal(captureSemanticPolicy({}).mode,'off');assert.equal(policy.maxCandidates,1);
 const records=original();assert.equal(R.prepareActionReconciliation({actions:records,sourceUnits,scope:policy.scope}).candidates.length,0);
 const input={changes:{discussion:[]}};assert.equal(await reconcileGeneratedSemanticStage(input,{sourceUnits},'discussion',{policy,ask}),input);
 const output=await reconcileGeneratedSemanticStage({changes:{actions:records}},{sourceUnits},'actions',{ask});assert.deepEqual(output.changes.actions,records);
});
test('safe content shape nominates both input orders but excludes independent work and qualifications',()=>{
 const [parent,child]=original();assert.ok(C.shape(parent,child));assert.ok(C.direction(child,parent));
 for(const text of ['Send the membership notice.','Approve the membership notice.','Explain the annual fee increase to the committee.','Explain the annual fee increase in the membership notice by Friday.','Explain only the annual fee increase in the membership notice.'])assert.equal(C.shape(parent,{...child,action:text}),null,text);
 for(const mutate of [r=>r.timing.kind='dependency',r=>r.reviewFlagIds=['warning'],r=>r.owners.push('Jo Lee'),r=>r.reviewed=true,r=>r.timingDecision={reason:'no_timing_value',binding:{status:'not_stated'},rejectedWordings:['Friday']},r=>r.action+=' and send it to members.']){
  const changed=structuredClone(parent);mutate(changed);assert.equal(C.shape(changed,child),null);
 }
 assert.equal(C.direction(parent,child,[parent,child,{...parent,id:'another'}]),null);
 assert.equal(C.shape({...parent,action:parent.action.replace('starting in January','by January')},child),null);
});
test('two independent request bindings are required and semantic veto cannot become a certificate',()=>{
 const [p,c]=original(),a=C.reviewPacket(p,c,sourceUnits,['T0001'],false),b=C.reviewPacket(p,c,sourceUnits,['T0001'],true);
 assert.notEqual(a.requestId,b.requestId);assert.match(N.prompt(b),/INDEPENDENT CHALLENGE/);
 assert.throws(()=>C.certify(p,c,sourceUnits,['T0001'],forPacket(a),forPacket(a)),/wrong_request_binding/);
 const veto=forPacket(b);veto.decisions[2].relation='distinct_work';assert.throws(()=>C.certify(p,c,sourceUnits,['T0001'],forPacket(a),veto),/veto/);
 const timing=forPacket(b);const check=b.sourceRows[0].requests.find(r=>r.field==='contentTiming');assert.ok(check);timing.decisions[0].rows[0].checks.find(r=>r.id===check.id).status='unclear';
 assert.throws(()=>C.certify(p,c,sourceUnits,['T0001'],forPacket(a),timing),/veto/);
});
test('certificate authorizes only exact whole-clause mappings and final receipt',()=>{
 const {records,packet,envelope}=fixture(),result=R.applyActionReconciliation(packet,envelope,{sourceUnits});
 assert.equal(result.actions.length,1,JSON.stringify(result.unresolved));assert.equal(result.actions[0].action,records[0].action);
 assert.ok(result.receipts.length);for(const receipt of result.receipts)assert.ok(R.validateReconciliationReceipt(receipt,receipt.original,result.actions[0],sourceUnits));
 for(const mutate of [e=>e.decisions[0].coverage[1].semanticProof.clauses[0].facets.object.original='other',e=>e.decisions[0].coverage[1].semanticProof.clauses[0].facets.operation.sourceSpans[0].quote='clipped',e=>e.decisions[0].coverage[1].containedRequirement.primary.decisions[2].relation='distinct_work',e=>e.decisions[0].coverage[1].sourceSpans[0].quote='wrong source']){
  const bad=structuredClone(envelope);mutate(bad);assert.equal(R.applyActionReconciliation(packet,bad,{sourceUnits}).actions.length,2);
 }
});
test('provider cannot supply a trusted certificate through expanded or malformed transport',()=>{
 const {packet,envelope}=fixture(),transport=require('../utils/meetingMinutesSemanticProofTransport');
 for(const compact of [false,true]){const input=structuredClone(envelope);if(compact)delete input.decisions[0].coverage[0].semanticProof;
  const expanded=transport.materializeSemanticDecisions(packet,input,'actions');assert.ok(expanded.decisions[0].coverage.every(p=>!p.containedRequirement));}
});
test('stage executes two source reviews, preserves full wording and passes final survival',async()=>{
 const api=require('../routes/api').stagedEvaluation;let calls=0;
 const output=await run(original(),{ask:async(...args)=>{calls++;return ask(...args);},verifySurvival:api.reconcileFinalApprovedActions});
 const audit=output.changes.qualityState.actions.semanticReconciliation;
 assert.equal(calls,2);assert.equal(output.changes.actions.length,1,JSON.stringify(audit.unresolved));assert.equal(audit.stats.merged,1);
 assert.equal(api.reconcileFinalApprovedActions(output.changes.actions,original(),{sourceUnits,receipts:audit.receipts}).restored.length,0);
});
test('source veto, malformed result and provider failure retain both rows without a semantic retry',async()=>{
 for(const mode of ['veto','malformed','failure']){let calls=0;
  const output=await run(original(),{ask:async(prompt,options)=>{calls++;if(mode==='failure')throw Error('offline');if(mode==='malformed')return {result:{}};
   const answer=await ask(prompt,options);answer.result.decisions[2].relation='distinct_work';return answer;}});
  assert.deepEqual(output.changes.actions,original());assert.equal(calls,1);assert.ok(output.changes.qualityState.actions.semanticReconciliation.unresolved.length);
 }
});
test('identity admission, JSON reload and reversible recovery preserve proof; reviewer/source edits invalidate it',async()=>{
 const api=require('../routes/api').stagedEvaluation,{originalEnquiryActions}=require('../utils/meetingMinutesEnquiryRecovery');
 const output=await run(),admitted=api.admitMeetingAgentGeneratedActionChanges({sourceUnits},output.changes,'contained-contract');
 const saved=JSON.parse(JSON.stringify({sourceUnits,...admitted}));
 assert.equal(saved.actions.length,1);assert.deepEqual(originalEnquiryActions(saved),original());
 const audit=saved.qualityState.actions.semanticReconciliation;
 for(const receipt of audit.receipts)assert.ok(R.validateReconciliationReceipt(receipt,receipt.original,saved.actions[0],sourceUnits));
 for(const mutate of [d=>d.actions[0].action+=' Please check.',d=>d.sourceUnits[0].text+=' Correction.',d=>d.keptActionIds=[d.actions[0].id]]){const edited=structuredClone(saved);mutate(edited);assert.equal(originalEnquiryActions(edited),null);}
});
test('the last container preposition does not split an internal content phrase',()=>{
 const p=row('p','Draft the membership notice explaining the increase in annual fees.'),c=row('c','Explain the increase in annual fees in the membership notice.');
 assert.ok(C.shape(p,c));assert.equal(C.shape(p,{...c,action:'Explain the increase in annual fees in the finance report.'}),null);
});
test('a failed optional review does not discard an independently proven existing merge',async()=>{
 const records=[row('e1','Send the detailed inspection report.'),row('e2','Send the detailed inspection report.'),...original()];
 const source=require('../utils/meetingMinutesAgentV2').normaliseSourceUnits([...sourceUnits,{id:'T0002',speaker:'Maya Patel',text:'I will send the detailed inspection report.'}]);
 records[0].evidenceIds=['T0002'];records[1].evidenceIds=['T0002'];
 const combined=captureSemanticPolicy({MEETING_MINUTES_AGENT_BOUNDED_SURVIVOR_DEDUPE_V1:'1',MEETING_MINUTES_AGENT_CONTAINED_REQUIREMENTS_V1:'1'});
 const output=await reconcileGeneratedSemanticStage({changes:{actions:records}},{sourceUnits:source},'actions',{policy:combined,ask:async()=>{throw Error('optional review unavailable');}});
 assert.equal(output.changes.actions.length,3);assert.equal(output.changes.actions.filter(r=>r.action==='Send the detailed inspection report.').length,1);
 assert.ok(output.changes.actions.some(r=>r.id==='p'));assert.ok(output.changes.actions.some(r=>r.id==='c'));
 assert.equal(output.changes.qualityState.actions.semanticReconciliation.stats.merged,1);
});
test('source context, capacity and removed evidence cannot be silently narrowed to obtain approval',()=>{
 const [p,c]=original();assert.throws(()=>C.reviewPacket(p,c,sourceUnits,[],false),/context/);
 const expanded=Array.from({length:9},(_,i)=>({...sourceUnits[0],id:'T'+String(i+1).padStart(4,'0')}));
 const ids=expanded.map(unit=>unit.id),first=C.reviewPacket(p,c,expanded,ids,false),second=C.reviewPacket(p,c,expanded,ids,true);
 assert.throws(()=>C.certify(p,c,expanded,ids,forPacket(first),forPacket(second)),/capacity/);
 const removed=[{...sourceUnits[0],classification:'remove',restored:false}],a=C.reviewPacket(p,c,removed,['T0001'],false),b=C.reviewPacket(p,c,removed,['T0001'],true);
 assert.throws(()=>C.certify(p,c,removed,['T0001'],forPacket(a),forPacket(b)),/ineligible_source/);
});
test('actual background save, public projection and Word/PDF exports retain one full instruction and private recovery',async()=>{
 const api=require('../routes/api').stagedEvaluation,V=require('../utils/meetingMinutesAgentV2');
 const initial={draftId:'contained-save',revision:1,payloadVersion:V.PAYLOAD_VERSION,sourceUnits,actions:[],discussion:[],reviewFlags:[],qualityState:{},
  details:{meetingTitle:'Membership review',meetingDate:'2026-10-25',meetingType:'General',internalAttendees:['Maya Patel'],clientAttendees:[]},
  staleStages:[],currentStep:3,selectedStep:3,changeHistory:[],redoHistory:[],meetingObjectives:[],unassignedSupportingDetails:[]};
 let saved=structuredClone(initial),writes=0;
 const result=await run();
 await api.persistMeetingAgentBackgroundStage({draftId:initial.draftId,userId:1,stage:'actions',sourceDraft:initial,result,
  wait:async()=>{},getDraft:async()=>structuredClone(saved),saveDraft:async(fresh,changes)=>{writes++;saved=JSON.parse(JSON.stringify({...fresh,...changes,revision:fresh.revision+1}));return structuredClone(saved);}});
 assert.equal(writes,1);assert.equal(saved.actions.length,1);
 const payload=api.meetingAgentDraftPayload(saved),visible=api.publicMeetingAgentDraft(payload);
 assert.equal(visible.actions.length,1);assert.equal(visible.actions[0].action,original()[0].action);assert.equal(visible.qualityState,undefined);
 const audit=saved.qualityState.actions.semanticReconciliation;assert.ok(audit.receipts.length);
 assert.ok(audit.receipts.every(receipt=>R.validateReconciliationReceipt(receipt,receipt.original,saved.actions[0],sourceUnits)));
 assert.deepEqual(require('../utils/meetingMinutesEnquiryRecovery').originalEnquiryActions(saved),original());
 const JSZip=require('jszip'),{generateMeetingMinutesAgentDocx}=require('../utils/meetingMinutesAgentDocx'),{generateStagedMinutesPdf}=require('../utils/stagedMinutesPdf');
 for(const evidence of [false,true]){
  const zip=await JSZip.loadAsync(await generateMeetingMinutesAgentDocx(api.meetingAgentDraftForDocx(payload),evidence));
  const xml=await zip.file('word/document.xml').async('string');assert.ok(xml.includes(original()[0].action));assert.ok(!xml.includes(original()[1].action));assert.ok(!xml.includes('Synthetic contract fixture'));
  const projection=api.meetingAgentDraftForPdf(payload,evidence);const pdf=await generateStagedMinutesPdf(projection);assert.equal(pdf.subarray(0,5).toString(),'%PDF-');assert.ok(pdf.length>1000);
 }
});
