'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), vm=require('node:vm');
const audit=require('../utils/meetingMinutesRefereeFailureAudit');
const {createOriginalExecution}=require('../utils/meetingMinutesOriginalExecution');
const A=require('../routes/api').stagedEvaluation;
const source=fs.readFileSync(require.resolve('../routes/api'),'utf8');
const payload=prompt=>JSON.parse(prompt.split('refereePayload:\n')[1]);
const child={candidateId:'child',recordType:'discussion_point',text:'The supplier requires oversight.',evidenceIds:['T0001']};
const parent={candidateId:'parent',targetId:'approved-parent',recordType:'discussion_point',text:'The supplier oversight remains unresolved.',evidenceIds:['T0010']};
const sources=Array.from({length:12},(_,i)=>({id:`T${String(i+1).padStart(4,'0')}`,speaker:'Chair',text:`Source statement ${i+1}.`}));
function contract(targets=[parent]) {return A.meetingMinutesAgentRefereeContract('discussion',[child],'request',{selected:true,retainedDiscussionTargets:targets});}

test('initial and repair prompts provide the same approved catalogue and its source evidence',()=>{
  const c=contract(),before=structuredClone(c);
  for(const build of [A.meetingMinutesAgentRefereePrompt,A.meetingMinutesAgentRefereeRepairPrompt]) {
    const p=payload(build({stage:'discussion',contract:c,sourceUnits:sources}));
    assert.deepEqual(p.existingDiscussionTargets,[{...parent,candidateId:parent.targetId}]);
    assert.equal(p.existingDiscussionTargets[0].candidateId,p.existingDiscussionTargets[0].targetId);
    assert.ok(!JSON.stringify(p).includes('"parent"'));
    assert.deepEqual(p.expectedCandidateIds,['child']);
    assert.equal(p.expectedCandidateCount,1);
    assert.deepEqual(p.candidateEnsemble.map(r=>r.candidateId),['child']);
    assert.match(p.preparedTranscript,/Source statement 10\./);
  }
  assert.deepEqual(c,before);
});
test('supplying a catalogue does not permit unknown or unapproved cross-batch targets',()=>{
  const reply=targetId=>({requestId:'request',stage:'DISCUSSION_REFEREE',expectedCandidateCount:1,returnedDispositionCount:1,
    candidateDispositions:[{candidateId:'child',disposition:'merge',targetId,reason:'Covered.',evidenceIds:['T0001']}]});
  assert.equal(A.meetingAgentDispositionError(reply('approved-parent'),[child],contract()),null);
  assert.equal(A.meetingAgentDispositionError(reply('unknown'),[child],contract()).code,'invalid_referee_target');
  assert.equal(A.meetingAgentDispositionError(reply('parent'),[child],contract()).code,'invalid_referee_target');
  assert.equal(A.meetingAgentDispositionError(reply('approved-parent'),[child],contract([]),[child,parent]).code,'invalid_referee_target');
});
test('empty-target discussion and action prompts do not acquire extra catalogue fields',()=>{
  for(const stage of ['discussion','actions']) {
    const c=A.meetingMinutesAgentRefereeContract(stage,[child],'request',{selected:true});
    assert.equal(payload(A.meetingMinutesAgentRefereePrompt({stage,contract:c,sourceUnits:sources})).existingDiscussionTargets,undefined);
  }
});

// Execute the actual retry function with an isolated provider stub. No network,
// real transcripts, credentials, library, timers or database writes are used.
function retryHarness(ask, reportedError = () => null) {
  const from=source.indexOf('async function askPowerAutomateMeetingMinutesAgentWithRetry(');
  const to=source.indexOf('\nfunction normaliseStagedCandidateResult',from);
  assert.ok(from>=0&&to>from);
  const warnings=[];
  const context={Date,Number,Math,JSON,Promise,process:{env:{}},
    setTimeout:callback=>{callback();},MEETING_AGENT_RETRY_MS:[0,0],
    meetingMinutesAgentText:(v,n)=>String(v||'').slice(0,n),
    askPowerAutomateMeetingMinutesAgent:ask,meetingAgentResultError:reportedError,
    meetingAgentFailureClass:A.meetingAgentFailureClass,refereeFailureSnapshot:audit.refereeFailureSnapshot,
    console:{warn:value=>warnings.push(value)}};
  vm.runInNewContext(source.slice(from,to)+'\nthis.run=askPowerAutomateMeetingMinutesAgentWithRetry;',context);
  return {run:context.run,warnings};
}
test('a rejected reply is captured before adapters mutate it, with its actual repair prompt',async()=>{
  const captures=[];let calls=0;
  const h=retryHarness(async()=>({targetId:++calls===1?'bad-initial':'bad-repair'}));
  const error=Object.assign(new Error('Invalid target'),{code:'invalid_referee_target',retryable:true,statusCode:502});
  await assert.rejects(h.run('initial exact prompt',{maxAttempts:2,repairPrompt:()=> 'repair exact prompt',
    transformResult:r=>{r.targetId='adapted-'+r.targetId;return r;},validateResult:()=>error,
    onFailure:input=>captures.push(input)}),/Invalid target/);
  assert.equal(calls,2);assert.equal(captures.length,2);
  assert.equal(captures[0].rawReply.value.targetId,'bad-initial');
  assert.equal(captures[0].normalizedReply.value.targetId,'adapted-bad-initial');
  assert.equal(captures[1].prompt.value,'repair exact prompt');
  assert.equal(captures[1].rawReply.value.targetId,'bad-repair');
  assert.equal(captures[1].attemptInfo.repair,true);
});
test('a capture storage failure cannot replace the real error or add provider retries',async()=>{
  let calls=0;const h=retryHarness(async()=>{calls++;return {targetId:'bad'};});
  const real=Object.assign(new Error('Real validation failure'),{retryable:false});
  await assert.rejects(h.run('private source text',{maxAttempts:3,validateResult:()=>real,
    onFailure:()=>{throw new Error('private storage details');}}),error=>error===real);
  assert.equal(calls,1);assert.equal(h.warnings.length,1);
  assert.ok(!h.warnings[0].includes('private source text'));
  assert.ok(!h.warnings[0].includes('private storage details'));
});
test('successful replies produce no failure capture and preserve their outcome',async()=>{
  let captures=0,calls=0;const h=retryHarness(async()=>{calls++;return {ok:true};});
  const result=await h.run('exact prompt',{onFailure:()=>captures++});
  assert.equal(result.result.ok,true);assert.equal(calls,1);assert.equal(captures,0);
});
test('transport failures explicitly record that no reply exists',async()=>{
  let capture;const h=retryHarness(async()=>{throw Object.assign(new Error('Network failed'),{retryable:false});});
  await assert.rejects(h.run('exact prompt',{onFailure:r=>{capture=r;}}));
  assert.equal(capture.rawReply.complete,false);assert.equal(capture.rawReply.reason,'no_reply');
});
test('snapshots are immutable copies and oversized replies are fingerprinted rather than truncated',()=>{
  const reply={value:'before'},snapshot=audit.refereeFailureSnapshot(reply);reply.value='after';
  assert.equal(snapshot.value.value,'before');
  const huge=audit.refereeFailureSnapshot({value:'x'.repeat(audit.MAX_SNAPSHOT_BYTES+1)});
  assert.equal(huge.complete,false);assert.equal(huge.value,undefined);assert.equal(huge.sha256.length,64);
  assert.equal(audit.refereeFailureSnapshot(1n).reason,'not_serializable');
});
test('the private journal limits count, total bytes and retained age on append',()=>{
  const now=Date.now();let state;
  for(let i=0;i<20;i++)state=audit.appendRefereeFailureAudit(state,{pass:`pass-${i}`,prompt:audit.refereeFailureSnapshot('x'.repeat(120000))},now+i);
  assert.equal(state.entries.length,8);assert.equal(state.dropped,12);
  assert.ok(Buffer.byteLength(JSON.stringify(state))<=audit.MAX_AUDIT_BYTES);
  state=audit.appendRefereeFailureAudit(state,{pass:'later'},now+audit.RETENTION_MS+100);
  assert.equal(state.entries.length,1);assert.equal(state.dropped,20);
});
test('aggregate byte limits drop old entries and entry limits explicitly omit oversized components',()=>{
  const snapshot=audit.refereeFailureSnapshot('x'.repeat(120000));let state;
  for(let i=0;i<8;i++)state=audit.appendRefereeFailureAudit(state,{pass:String(i),prompt:snapshot,rawReply:snapshot,normalizedReply:snapshot});
  assert.ok(state.entries.length<8);assert.ok(state.dropped>0);
  assert.ok(Buffer.byteLength(JSON.stringify(state))<=audit.MAX_AUDIT_BYTES);
  const larger=audit.refereeFailureSnapshot('x'.repeat(audit.MAX_SNAPSHOT_BYTES-2));
  state=audit.appendRefereeFailureAudit(null,{prompt:larger,rawReply:larger,normalizedReply:larger,contract:larger});
  assert.equal(state.entries[0].contract.complete,false);
  assert.equal(state.entries[0].contract.reason,'entry_budget');
  assert.ok(Buffer.byteLength(JSON.stringify(state.entries[0]))<=audit.MAX_ENTRY_BYTES);
});
test('audit source evidence bypasses glossary rewriting and is excluded from public drafts',()=>{
  const privateMarker='PRIVATE_REFEREE_REPLY udimed 28 November';
  const state={discussion:{note:'udimed',refereeFailureAudit:audit.appendRefereeFailureAudit(null,{prompt:audit.refereeFailureSnapshot(privateMarker)})}};
  assert.equal(A.normaliseMeetingAgentQualityState(state).discussion.note,'EUDAMED');
  assert.deepEqual(A.normaliseMeetingAgentQualityState(state).discussion.refereeFailureAudit,state.discussion.refereeFailureAudit);
  const visible=A.publicMeetingAgentDraft({discussion:[],actions:[],sourceUnits:[],qualityState:state});
  assert.equal(visible.qualityState,undefined);
  assert.ok(!JSON.stringify(visible).includes(privateMarker));
});

function progressHarness() {
  let stored={draftId:'draft',sourceUnits:[],discussion:[],actions:[],qualityState:{actions:{keep:'other-stage'}},generation:{status:'running',stage:'discussion'}};
  const start=source.indexOf('async function updateMeetingAgentHybridProgress(');
  const end=source.indexOf('\nfunction meetingAgentSummaryAuthority',start);
  const context={MEETING_AGENT_BOOT_ID:'fixture',Date,
    meetingAgentSerialDraftWrite:async(id,fn)=>fn(),getMeetingMinutesAgentDraft:async()=>structuredClone(stored),
    normaliseMeetingAgentGeneration:v=>v,normaliseMeetingAgentPassCache:v=>v,
    saveMeetingAgentDraft:async(fresh,req,changes)=>{stored=A.meetingAgentDraftPayload({...fresh,...changes});}};
  vm.runInNewContext(source.slice(start,end)+'\nthis.persist=updateMeetingAgentHybridProgress;',context);
  return {persist:context.persist,get stored(){return stored;}};
}
test('a private audit checkpoint persists before stage completion without entering public generation state',async()=>{
  const h=progressHarness(),journal=audit.appendRefereeFailureAudit(null,{prompt:audit.refereeFailureSnapshot('PRIVATE checkpoint 28 November')});
  await h.persist('draft','owner','discussion',{refereeFailureAudit:journal});
  assert.deepEqual(h.stored.qualityState.discussion.refereeFailureAudit,journal);
  assert.equal(h.stored.qualityState.actions.keep,'other-stage');
  assert.equal(h.stored.generation.refereeFailureAudit,undefined);
  assert.ok(!JSON.stringify(A.publicMeetingAgentDraft(h.stored)).includes('PRIVATE checkpoint'));
});
test('the production referee call actually wires rejection capture to the durable private checkpoint',async(t)=>{
 for(const stage of ['discussion','actions']){
  const atomic=stage==='discussion'?child:{...child,recordType:'action',text:'Send the tracker.',record:{action:'Send the tracker.',owners:['Nora Patel'],evidenceIds:['T0001']}};
  const h=progressHarness(),c=A.meetingMinutesAgentRefereeContract(stage,[atomic],'request',{selected:true}),logs=[],diagnosticPasses=[];let providerCalls=0,capturedError;
  const result={requestId:'request',stage:c.stage,expectedCandidateCount:1,returnedDispositionCount:1,
    candidateDispositions:[{candidateId:'child',disposition:stage==='discussion'?'merge':'publish',targetId:'PRIVATE_BAD_TARGET',reason:'Covered.',evidenceIds:['T0001']}]};
  const retry=retryHarness(async()=>{providerCalls++;return structuredClone(result);});
  const diagnostics=require('../utils/meetingMinutesActionDiagnostics');
  const scoped=t.mock.method(diagnostics,'scoped',(pass,task)=>{diagnosticPasses.push(pass);return task();});
  const warn=t.mock.method(console,'warn',s=>logs.push(s));
  const info=t.mock.method(console,'info',s=>logs.push(s));
  const createExecution=createOriginalExecution({...A.originalMinutesStageServices,
    askPowerAutomateMeetingMinutesAgentWithRetry:retry.run});
  const context=createExecution({draftId:'draft',details:{},sourceUnits:[],discussion:[],actions:[]},stage,
    {onRefereeFailure:journal=>h.persist('draft','owner',stage,{refereeFailureAudit:journal})});
  const value=await context.call('referee-batch-1','PRIVATE exact request',{
    optional:true,maxAttempts:1,responseKind:'referee',refereeContract:c,requestId:c.requestId,
    validateResult:r=>A.meetingAgentDispositionError(r,[atomic],c),captureError:e=>{capturedError=e;}});
  assert.deepEqual(diagnosticPasses,['referee-batch-1']);
  assert.equal(value,null);assert.equal(providerCalls,1);assert.equal(capturedError.code,stage==='discussion'?'invalid_referee_target':'unmaterialized_referee_action');
  const entry=h.stored.qualityState[stage].refereeFailureAudit.entries[0];
  assert.equal(entry.prompt.value,'PRIVATE exact request');
  assert.equal(entry.rawReply.value.candidateDispositions[0].targetId,'PRIVATE_BAD_TARGET');
  assert.equal(entry.contract.value.requestId,c.requestId);
  assert.equal(entry.validation.code,capturedError.code);
  assert.ok(!logs.join('').includes('PRIVATE_BAD_TARGET'));
  assert.ok(!JSON.stringify(A.publicMeetingAgentDraft(h.stored)).includes('PRIVATE_BAD_TARGET'));
  scoped.mock.restore();warn.mock.restore();info.mock.restore();
 }
});

function transportHarness(body, status = 200) {
  const helper=source.indexOf('function meetingAgentHasTypedError(');
  const start=helper>=0?helper:source.indexOf('async function askPowerAutomateMeetingMinutesAgent(prompt, options = {})');
  const transport=source.indexOf('async function askPowerAutomateMeetingMinutesAgent(prompt, options = {})',start);
  const end=source.indexOf('\n}\n',transport)+3;
  assert.ok(start>=0&&end>start,'transport source boundaries must exist');let calls=0;
  const state={timeoutCleared:false,slotReleased:false};let beforeBodyRead;
  const context={URL,AbortController,Number,Math,JSON,Set,process:{env:{}},
    setTimeout:()=>0,clearTimeout:()=>{state.timeoutCleared=true;},meetingAgentFlowUrlFor:()=> 'https://example.invalid/referee',
    acquireMeetingAgentCallSlot:async()=>()=>{state.slotReleased=true;},parseJsonLenient:A.parseJsonLenient,meetingAgentResultError:A.meetingAgentResultError,
    fetch:async()=>{calls++;return {ok:status>=200&&status<300,status,text:async()=>{beforeBodyRead={...state};return typeof body==='function'?body():body;}};}};
  vm.runInNewContext(source.slice(start,end)+'\nthis.ask=askPowerAutomateMeetingMinutesAgent;',context);
  return {ask:context.ask,get calls(){return calls;},get state(){return state;},get beforeBodyRead(){return beforeBodyRead;}};
}
test('malformed response bodies reach the private failure audit before structural parsing rejects them',async()=>{
  const exact=' {"output":"PRIVATE malformed reply udimed"}\n',transport=transportHarness(exact),h=retryHarness(transport.ask);let capture;
  await assert.rejects(h.run('exact request',{maxAttempts:1,responseKind:'referee',onFailure:x=>{capture=x;}}),e=>e.code==='power_automate_invalid_structure');
  assert.equal(transport.calls,1);assert.equal(capture.wireReply.complete,true);
  assert.equal(capture.wireReply.value,exact);assert.equal(capture.normalizedReply.reason,'no_reply');
});
test('non-JSON and HTTP error bodies retain exact private evidence without changing the failure code',async()=>{
  for(const [body,status,code] of [['PRIVATE non-JSON reply',200,'power_automate_invalid_structure'],['PRIVATE upstream failure',503,'power_automate_http_503'],['',200,'power_automate_empty_response']]){
    const transport=transportHarness(body,status),h=retryHarness(transport.ask);let capture;
    await assert.rejects(h.run('request',{maxAttempts:1,responseKind:'referee',onFailure:x=>{capture=x;}}),e=>e.code===code);
    assert.equal(transport.calls,1);assert.equal(capture.wireReply.value,body);
  }
});
test('wire snapshots are optional, bounded and capture-hook failure leaves successful results intact',async()=>{
  let passed;const h=retryHarness(async(prompt,options)=>{passed=options;return {ok:true};});
  await h.run('request');assert.equal(passed.onRawResponse,undefined);
  const transport=transportHarness('{"actions":[],"discussion":[]}');
  const result=await transport.ask('request',{onRawResponse:()=>{throw Error('PRIVATE storage failure');}});
  assert.deepEqual(JSON.parse(JSON.stringify(result)),{actions:[],discussion:[]});assert.equal(transport.calls,1);
  const huge='x'.repeat(audit.MAX_SNAPSHOT_BYTES+10),large=retryHarness(transportHarness(huge).ask);let capture;
  await assert.rejects(large.run('request',{maxAttempts:1,onFailure:x=>{capture=x;}}));
  assert.equal(capture.wireReply.complete,false);assert.equal(capture.wireReply.value,undefined);assert.equal(capture.wireReply.sha256.length,64);
});
test('wire evidence participates in entry limits and stays private in both stage checkpoints',async()=>{
  const snapshot=audit.refereeFailureSnapshot('x'.repeat(audit.MAX_SNAPSHOT_BYTES-2));
  const journal=audit.appendRefereeFailureAudit(null,{prompt:snapshot,wireReply:snapshot,rawReply:snapshot,normalizedReply:snapshot,contract:snapshot});
  assert.ok(Buffer.byteLength(JSON.stringify(journal.entries[0]))<=audit.MAX_ENTRY_BYTES);
  for(const stage of ['discussion','actions']){
    const h=progressHarness(),privateJournal=audit.appendRefereeFailureAudit(null,{wireReply:audit.refereeFailureSnapshot('PRIVATE exact wire udimed')});
    await h.persist('draft','owner',stage,{refereeFailureAudit:privateJournal});
    assert.deepEqual(h.stored.qualityState[stage].refereeFailureAudit,privateJournal);
    assert.ok(!JSON.stringify(A.publicMeetingAgentDraft(h.stored)).includes('PRIVATE exact wire'));
    assert.equal(h.stored.qualityState[stage].refereeFailureAudit.entries[0].wireReply.value,'PRIVATE exact wire udimed');
  }
});

test('typed provider error envelopes remain errors for every supported response kind',async()=>{
  const envelope={error:{code:'microsoft_route_failure',message:'The Microsoft agent route did not return a response.',retryable:true}};
  for(const responseKind of [undefined,'referee','semantic_reconciliation','timing_check','discussion_discovery','anchored_discussion_discovery','anchored_action_discovery','topic_arrangement']){
    const t=transportHarness(JSON.stringify(envelope)),h=retryHarness(t.ask,A.meetingAgentResultError);let capture;
    await assert.rejects(h.run('exact request',{maxAttempts:1,responseKind,onFailure:x=>{capture=x;}}),e=>e.code==='microsoft_route_failure'&&e.retryable===true);
    assert.equal(t.calls,1);
    if(responseKind==='referee')assert.deepEqual(capture.rawReply.value,envelope);
    else assert.equal(capture.rawReply.reason,'no_reply');
    assert.equal(capture.wireReply.value,JSON.stringify(envelope));
  }
});
test('unknown shapes remain invalid and provider retry hints cannot authorize semantic retries',async()=>{
  for(const body of ['{"Done":true}','{"error":{"message":"No code"}}','{"error":{"code":""}}']){
    const t=transportHarness(body),h=retryHarness(t.ask,A.meetingAgentResultError);
    await assert.rejects(h.run('request',{maxAttempts:1,responseKind:'semantic_reconciliation'}),e=>e.code==='power_automate_invalid_structure');
  }
  for(const [code,retryable,expected]of [['invalid_referee_output',true,false],['microsoft_route_failure',false,false],['microsoft_route_failure','true',false],['microsoft_route_failure',true,true]])assert.equal(A.meetingAgentResultError({error:{code,message:'Failure',retryable}}).retryable,expected);
});
test('a retryable provider route failure can recover within the unchanged attempt limit',async()=>{
  let calls=0;const h=retryHarness(async()=>++calls===1?{error:{code:'microsoft_route_failure',message:'Route failed.',retryable:true}}:{decisions:[]},A.meetingAgentResultError);
  const result=await h.run('request',{maxAttempts:2,responseKind:'semantic_reconciliation'});
  assert.equal(calls,2);assert.deepEqual(result.result,{decisions:[]});assert.equal(result.timings[0].errorCode,'microsoft_route_failure');
});
test('explicit per-attempt timeouts apply with or without an overall deadline',async()=>{
  const observed=[],h=retryHarness(async(prompt,options)=>{observed.push(options.timeoutMs);return {ok:true};});
  await h.run('request',{maxAttempts:1,attemptTimeoutMs:17000});assert.equal(observed.pop(),17000);
  await h.run('request',{maxAttempts:1,attemptTimeoutMs:17000,deadlineAt:Date.now()+60000});assert.equal(observed.pop(),17000);
  await h.run('request',{maxAttempts:1,attemptTimeoutMs:60000,deadlineAt:Date.now()+18000});assert(observed.at(-1)>=17000&&observed.at(-1)<=18000);
});

test('direct generation and audit calls cannot normalise typed provider errors into empty minutes',async()=>{
  const envelope={error:{code:'microsoft_route_failure',message:'No route reply.',retryable:true}};
  const t=transportHarness(JSON.stringify(envelope));
  await assert.rejects(t.ask('request'),e=>e.code==='microsoft_route_failure'&&e.retryable===true);
  assert.equal(t.calls,1);
});

test('the attempt deadline and active-call slot cover reading the full response body',async()=>{
  const t=transportHarness('{"actions":[],"discussion":[]}');
  await t.ask('request',{paced:true});
  assert.equal(t.beforeBodyRead.timeoutCleared,false,'body reading must still be under the deadline');
  assert.equal(t.beforeBodyRead.slotReleased,false,'a body in flight still occupies its call slot');
  assert.equal(t.state.timeoutCleared,true);assert.equal(t.state.slotReleased,true);
  for(const [name,code]of [['AbortError','power_automate_timeout'],['Error','power_automate_unreachable']]){
    const broken=transportHarness(()=>{throw Object.assign(Error('PRIVATE body failure'),{name});});
    await assert.rejects(broken.ask('request',{paced:true}),e=>e.code===code);
    assert.equal(broken.state.timeoutCleared,true);assert.equal(broken.state.slotReleased,true);
  }
});
