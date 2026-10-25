'use strict';
process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1='0';
const test=require('node:test'),assert=require('node:assert/strict'),V=require('../utils/meetingMinutesAgentV2');
const D=require('../utils/canonicalMinutes/qualifiedDependency'),R=require('../utils/canonicalMinutes/actionSemanticReconciliation');
const P=require('../utils/meetingMinutesSemanticPolicy'),S=require('../utils/meetingMinutesSemanticStage'),N=require('../utils/meetingMinutesActionReferenceReview');
const response=require('./helpers/meeting-minutes-dependency-response');
const policy=P.captureSemanticPolicy({MEETING_MINUTES_AGENT_QUALIFIED_DEPENDENCY_DEDUPE_V1:'1'});
const {sourceUnits,original}=require('./helpers/meeting-minutes-dependency-fixture');
const ask=async(prompt,options)=>{assert.equal(options.maxAttempts,1);return {result:response(JSON.parse(prompt.split('\nDATA\n')[1]))};};
const run=(actions=original(),options={})=>S.reconcileGeneratedSemanticStage({changes:{actions}},{sourceUnits},'actions',{policy,ask,...options});
function fixture(){const records=original(),packet=R.prepareActionReconciliation({actions:records,sourceUnits,scope:policy.scope,qualifiedDependencies:true});
 const a=D.reviewPacket(...records,sourceUnits,['T0001'],false),b=D.reviewPacket(...records,sourceUnits,['T0001'],true);
 const certificate=D.certify(...records,sourceUnits,['T0001'],response(a),response(b));
 const candidate=packet.candidates[0],envelope={version:packet.version,packetHash:packet.packetHash,sourceHash:packet.sourceHash,inputHash:packet.inputHash,decisions:[{candidateId:candidate.candidateId,relation:'equivalent',survivorRef:packet.rows[0].ref,coverage:D.coverage(packet,...packet.rows,certificate)}]};return {records,packet,envelope,certificate};}
test('policy is opt-in, action-only, frozen for legacy work and within existing budgets',async()=>{
 assert.equal(P.captureSemanticPolicy({}).qualifiedDependencies,undefined);assert.equal(policy.scope,'qualified_dependencies');assert.equal(policy.maxCandidates,1);
 const p=R.prepareActionReconciliation({actions:original(),sourceUnits,scope:policy.scope});assert.equal(p.candidates.length,0);
 const input={changes:{actions:original()}};assert.equal(await S.reconcileGeneratedSemanticStage(input,{sourceUnits},'actions',{ask}),input);
 const discussion={changes:{discussion:[]}};assert.equal(await S.reconcileGeneratedSemanticStage(discussion,{sourceUnits},'discussion',{policy,ask}),discussion);
 const combined=P.captureSemanticPolicy({MEETING_MINUTES_AGENT_CONTACT_ENQUIRY_DEDUPE_V1:'1',MEETING_MINUTES_AGENT_BOUNDED_SURVIVOR_DEDUPE_V1:'1',MEETING_MINUTES_AGENT_CONTAINED_REQUIREMENTS_V1:'1',MEETING_MINUTES_AGENT_QUALIFIED_DEPENDENCY_DEDUPE_V1:'1'});assert.equal(combined.maxCandidates,2);assert.equal(combined.scope,'contact_and_existing_survivors');assert.ok(combined.containedRequirements&&combined.qualifiedDependencies);
});
test('nomination always chooses the fuller existing dependency, in either input order',()=>{
 const [full,short]=original();assert.equal(D.direction(full,short).parent,full);assert.equal(D.direction(short,full).parent,full);assert.equal(D.shape(short,full),null);
 assert.equal(D.direction(full,short,[full,short,{...full,id:'second-full'}]),null);
});
test('separate methods, conditions, statuses, histories, warnings and reviewer rows stay excluded',()=>{
 const [full,short]=original();for(const mutate of [
  r=>r.owners=['Other Person'],r=>r.action=r.action.replace('generating','testing'),r=>r.action='Review the validation reports.',r=>r.action+=' and send the report.',
  r=>r.timing.wording='Dependent on approval from the sponsor.',r=>r.timing.exactDate='2026-11-01',r=>r.timing.kind='deadline',r=>r.timing.wording+=' By Friday.',
  r=>r.timingDecision.status='verified',r=>r.timingDecision.checkerStatus='rejected',r=>r.timingDecision.rejectedWordings=['after approval'],r=>r.timingDecision.rejectedExactDates=['2026-11-01'],r=>r.timingDecision.binding.conflictingSourceIds=['T0001'],
  r=>r.reviewFlagIds=['warning'],r=>r.reviewerAuthored=true,r=>r.unrecognisedMetadata=true
 ]){const changed=structuredClone(full);mutate(changed);assert.equal(D.shape(changed,short),null,JSON.stringify(changed));}
});
test('both independent reviews must support commitments, complete timing wording and the same obligation',()=>{
 const records=original(),a=D.reviewPacket(...records,sourceUnits,['T0001'],false),b=D.reviewPacket(...records,sourceUnits,['T0001'],true);
 assert.notEqual(a.requestId,b.requestId);assert.match(N.prompt(a),/DEPENDENCY COMPARISON/);
 assert.throws(()=>D.certify(...records,sourceUnits,['T0001'],response(a),response(a)),/wrong_request/);
 for(const mutate of [r=>r.decisions[0].rows[1].basis='required_component',r=>r.decisions[2].relation='partial_overlap',r=>r.decisions[0].rows[0].checks[0].status='unclear',r=>r.decisions[1].checks.find(c=>c.id===b.retentionRequests.find(q=>q.field==='timing').id).refs=['v3']]){
  const bad=response(b);mutate(bad);assert.throws(()=>D.certify(...records,sourceUnits,['T0001'],response(a),bad),/veto|witness/);
 }
});
test('proof keeps wording, unresolved timing status and full original recovery records',()=>{
 const {records,packet,envelope}=fixture(),output=R.applyActionReconciliation(packet,envelope,{sourceUnits});
 assert.equal(output.actions.length,1,JSON.stringify(output.unresolved));assert.deepEqual(output.actions[0],records[0]);assert.ok(output.receipts.length);
 assert.ok(output.receipts.every(receipt=>R.validateReconciliationReceipt(receipt,receipt.original,output.actions[0],sourceUnits)));
 for(const mutate of [r=>r.action+=' Different scope.',r=>r.timing.wording=records[1].timing.wording,r=>r.timingDecision.status='verified',r=>r.timingDecision.checkerStatus='rejected',r=>r.evidenceIds=[]]){const changed=structuredClone(output.actions[0]);mutate(changed);assert.ok(output.receipts.every(receipt=>!R.validateReconciliationReceipt(receipt,receipt.original,changed,sourceUnits)));}
});
test('proof tampering and provider-supplied certificates cannot authorize removal',()=>{
 const {packet,envelope}=fixture();for(const mutate of [e=>e.decisions[0].coverage[1].sourceSpans[0].quote='clipped',e=>e.decisions[0].coverage[1].semanticProof.clauses[0].facets.object.original='other',e=>e.decisions[0].coverage[1].qualifiedDependency.primary.decisions[2].relation='distinct_work']){
  const bad=structuredClone(envelope);mutate(bad);assert.equal(R.applyActionReconciliation(packet,bad,{sourceUnits}).actions.length,2);
 }
 const expanded=require('../utils/meetingMinutesSemanticProofTransport').materializeSemanticDecisions(packet,envelope,'actions');assert.ok(expanded.decisions[0].coverage.every(proof=>!proof.qualifiedDependency));assert.equal(R.applyActionReconciliation(packet,expanded,{sourceUnits}).actions.length,2);
});
test('stage, final preservation, identity admission, reload and recovery preserve the fuller dependency',async()=>{
 const api=require('../routes/api').stagedEvaluation;let calls=0;
 for(const records of [original(),original().reverse()]){
  const output=await run(records,{verifySurvival:api.reconcileFinalApprovedActions,ask:async(...args)=>{calls++;return ask(...args);}});
  const q=output.changes.qualityState.actions.semanticReconciliation;assert.equal(output.changes.actions.length,1,JSON.stringify(q.unresolved));assert.equal(q.stats.merged,1);
  const saved=JSON.parse(JSON.stringify({sourceUnits,...api.admitMeetingAgentGeneratedActionChanges({sourceUnits},output.changes,'dependency-roundtrip')}));
  assert.equal(saved.actions.length,1);assert.deepEqual(saved.actions[0].timing,original()[0].timing);assert.equal(saved.actions[0].timingDecision.status,'unresolved');
  assert.deepEqual(require('../utils/meetingMinutesEnquiryRecovery').originalEnquiryActions(saved),records);
  assert.ok(saved.qualityState.actions.semanticReconciliation.receipts.every(receipt=>R.validateReconciliationReceipt(receipt,receipt.original,saved.actions[0],sourceUnits)));
 }
 assert.equal(calls,4);
});
test('provider failure or veto keeps both rows without approval-seeking retries',async()=>{
 for(const mode of ['veto','failure','challenge-failure']){let calls=0;const output=await run(original(),{ask:async(prompt,options)=>{calls++;if(mode==='failure'||mode==='challenge-failure'&&calls===2)throw Error('unavailable');const reply=await ask(prompt,options);if(mode==='veto')reply.result.decisions[2].relation='distinct_work';return reply;}});
 assert.deepEqual(output.changes.actions,original());assert.equal(calls,mode==='challenge-failure'?2:1);const audit=output.changes.qualityState.actions.semanticReconciliation;assert.equal(audit.stats.merged,0);if(mode==='challenge-failure')assert.equal(audit.assessment.providerAssessed,0);}
});

test('background save and Word/PDF exports retain the full dependency and its unresolved status',async()=>{
 const api=require('../routes/api').stagedEvaluation;
 const initial={draftId:'dependency-save',revision:1,payloadVersion:V.PAYLOAD_VERSION,sourceUnits,actions:[],discussion:[],reviewFlags:[],qualityState:{},
  details:{meetingTitle:'Dataset review',meetingDate:'2026-10-25',meetingType:'General',internalAttendees:['Sam Lee'],clientAttendees:[]},staleStages:[],currentStep:3,selectedStep:3,changeHistory:[],redoHistory:[],meetingObjectives:[],unassignedSupportingDetails:[]};
 let saved=structuredClone(initial),writes=0;
 await api.persistMeetingAgentBackgroundStage({draftId:initial.draftId,userId:1,stage:'actions',sourceDraft:initial,result:await run(),wait:async()=>{},getDraft:async()=>structuredClone(saved),saveDraft:async(fresh,changes)=>{writes++;saved=JSON.parse(JSON.stringify({...fresh,...changes,revision:fresh.revision+1}));return structuredClone(saved);}});
 assert.equal(writes,1);assert.equal(saved.actions.length,1);assert.deepEqual(saved.actions[0].timing,original()[0].timing);assert.equal(saved.actions[0].timingDecision.status,'unresolved');
 const payload=api.meetingAgentDraftPayload(saved),visible=api.publicMeetingAgentDraft(payload);assert.equal(visible.qualityState,undefined);assert.equal(visible.actions.length,1);
 assert.deepEqual(require('../utils/meetingMinutesEnquiryRecovery').originalEnquiryActions(saved),original());
 const zip=require('jszip'),{generateMeetingMinutesAgentDocx}=require('../utils/meetingMinutesAgentDocx'),{generateStagedMinutesPdf}=require('../utils/stagedMinutesPdf');
 for(const evidence of [false,true]){const doc=await zip.loadAsync(await generateMeetingMinutesAgentDocx(api.meetingAgentDraftForDocx(payload),evidence)),xml=await doc.file('word/document.xml').async('string');
  assert.ok(xml.includes(original()[0].action));assert.ok(xml.includes('through the operations team'));assert.ok(!xml.includes(original()[1].action));assert.ok(!xml.includes('Synthetic dependency contract fixture'));
  const pdf=await generateStagedMinutesPdf(api.meetingAgentDraftForPdf(payload,evidence));assert.equal(pdf.subarray(0,5).toString(),'%PDF-');assert.ok(pdf.length>1000);
 }
});

test('missing context, evidence overflow, removed evidence and malformed certificates fail closed',()=>{
 const records=original(),fixturePacket=R.prepareActionReconciliation({actions:records,sourceUnits});
 assert.throws(()=>D.reviewPacket(...records,sourceUnits,[],false),/context/);
 for(const certificate of [null,{}, {version:D.VERSION,sourceHash:require('../utils/meetingMinutesProofHash').hash(sourceUnits)}])assert.equal(D.valid(fixturePacket,certificate,...fixturePacket.rows),false);
 const expanded=Array.from({length:9},(_,i)=>({...sourceUnits[0],id:'T'+String(i+1).padStart(4,'0')})),ids=expanded.map(unit=>unit.id);
 const a=D.reviewPacket(...records,expanded,ids,false),b=D.reviewPacket(...records,expanded,ids,true);
 assert.throws(()=>D.certify(...records,expanded,ids,response(a),response(b)),/capacity/);
 const removed=[{...sourceUnits[0],classification:'remove',restored:false}],c=D.reviewPacket(...records,removed,['T0001'],false),d=D.reviewPacket(...records,removed,['T0001'],true);
 assert.throws(()=>D.certify(...records,removed,['T0001'],response(c),response(d)),/ineligible_source/);
});
test('optional dependency failure preserves an independently proved existing merge and existing class priority',async()=>{
 const records=original(),extra=id=>({id,action:'Send the detailed inspection report.',owners:['Sam Lee'],timing:{kind:'not_stated',wording:'',exactDate:''},evidenceIds:['T0002'],reviewFlagIds:[]});
 const source=V.normaliseSourceUnits([...sourceUnits,{id:'T0002',speaker:'Sam Lee',text:'I will send the detailed inspection report.'}]);
 const combined=P.captureSemanticPolicy({MEETING_MINUTES_AGENT_BOUNDED_SURVIVOR_DEDUPE_V1:'1',MEETING_MINUTES_AGENT_QUALIFIED_DEPENDENCY_DEDUPE_V1:'1'});
 const output=await S.reconcileGeneratedSemanticStage({changes:{actions:[...records,extra('one'),extra('two')]}},{sourceUnits:source},'actions',{policy:combined,ask:async()=>{throw Error('optional failure');}});
 assert.equal(output.changes.actions.length,3);assert.equal(output.changes.actions.filter(row=>row.action==='Send the detailed inspection report.').length,1);
 assert.ok(output.changes.actions.some(row=>row.id==='full')&&output.changes.actions.some(row=>row.id==='short'));
});

test('redundant same-turn speaker references can be removed without inventing evidence or changing verdicts',()=>{
 const records=original(),packet=D.reviewPacket(...records,sourceUnits,['T0001'],false),reply=response(packet);
 reply.decisions[0].rows.forEach(row=>row.checks.filter(check=>row.checks[0].id===check.id).forEach(check=>check.refs.push('T0001@speaker')));
 const before=structuredClone(reply),assessment=N.assess(packet,reply);assert.equal(assessment.contractError,'');assert.equal(assessment.modelPassed,true);assert.equal(assessment.referenceAdjustments.length,2);assert.deepEqual(reply,before);
 const onlyMetadata=response(packet);onlyMetadata.decisions[0].rows[0].checks[0].refs=['T0001@speaker'];assert.equal(N.validate(packet,onlyMetadata),'invalid_source_quote');
 const unknown=response(packet);unknown.decisions[0].rows[0].checks[0].refs.push('unknown@speaker');assert.notEqual(N.validate(packet,unknown),'');
 const extra=V.normaliseSourceUnits([...sourceUnits,{id:'T0002',speaker:'Other Person',text:'A different task.'}]),other=D.reviewPacket(...records,extra,['T0001','T0002'],false),cross=response(other);
 cross.decisions[0].rows[0].checks[0].refs=['T0001','T0002@speaker'];assert.equal(N.validate(other,cross),'invalid_source_quote');
});

test('withdrawal in an original cited turn cannot be overruled by two positive model answers',()=>{
 const records=original();for(const status of ['withdrawn','cancelled','no longer required']){
 const denied=[{...sourceUnits[0],text:sourceUnits[0].text+' That task is '+status+'.'}];
 assert.throws(()=>D.reviewPacket(...records,denied,['T0001'],false),/source_withdrawal/);
 const first=D.reviewPacket(...records,sourceUnits,['T0001'],false),second=D.reviewPacket(...records,sourceUnits,['T0001'],true);
 assert.throws(()=>D.certify(...records,denied,['T0001'],response(first),response(second)),/source_withdrawal/);
 }
});
