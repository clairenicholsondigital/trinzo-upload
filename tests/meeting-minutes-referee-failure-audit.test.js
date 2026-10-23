'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), vm=require('node:vm');
const audit=require('../utils/meetingMinutesRefereeFailureAudit');
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
    assert.deepEqual(p.existingDiscussionTargets,[parent]);
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
function retryHarness(ask) {
  const from=source.indexOf('async function askPowerAutomateMeetingMinutesAgentWithRetry(');
  const to=source.indexOf('\nfunction normaliseStagedCandidateResult',from);
  assert.ok(from>=0&&to>from);
  const warnings=[];
  const context={Date,Number,Math,JSON,Promise,process:{env:{}},
    setTimeout:callback=>{callback();},MEETING_AGENT_RETRY_MS:[0,0],
    meetingMinutesAgentText:(v,n)=>String(v||'').slice(0,n),
    askPowerAutomateMeetingMinutesAgent:ask,meetingAgentResultError:()=>null,
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
  const end=source.indexOf('\nfunction meetingAgentReviewPacketError',start);
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
test('the production referee call actually wires rejection capture to the durable private checkpoint',async()=>{
  const h=progressHarness(),c=contract([]),logs=[];let providerCalls=0,capturedError;
  const result={requestId:'request',stage:'DISCUSSION_REFEREE',expectedCandidateCount:1,returnedDispositionCount:1,
    candidateDispositions:[{candidateId:'child',disposition:'merge',targetId:'PRIVATE_BAD_TARGET',reason:'Covered.',evidenceIds:['T0001']}]};
  const retry=retryHarness(async()=>{providerCalls++;return structuredClone(result);});
  const start=source.indexOf('  const call = async (pass, prompt, callOptions = {}) => {',source.indexOf('async function generateHybridMeetingAgentStageRaw('));
  const end=source.indexOf("\n\n  if (stage === 'summary')",start);
  assert.ok(start>0&&end>start);
  const context={Date,Math,Number,JSON,process:{env:{}},
    stage:'discussion',draft:{draftId:'draft'},passCache:[],passProvenance:[],completedPasses:[],degradedSources:[],
    stageDeadlineAt:Date.now()+5000,refereeFailureAudit:undefined,refereeAuditRunId:'fixture-run',
    options:{onRefereeFailure:journal=>h.persist('draft','owner','discussion',{refereeFailureAudit:journal})},
    meetingMinutesAgentText:(v,n)=>String(v||'').slice(0,n),meetingAgentPassCacheKey:()=> 'fixture-hash',
    meetingMinutesAgentReplayPassCacheEnabled:()=>false,progress:async()=>{},
    meetingAgentPassTimingPolicy:()=>({deadlineAt:Date.now()+5000,attemptTimeoutMs:1000}),
    askPowerAutomateMeetingMinutesAgentWithRetry:retry.run,appendRefereeFailureAudit:audit.appendRefereeFailureAudit,
    refereeFailureSnapshot:audit.refereeFailureSnapshot,meetingAgentFailureClass:A.meetingAgentFailureClass,
    console:{warn:s=>logs.push(s),info:s=>logs.push(s)}};
  vm.runInNewContext(source.slice(start,end)+'\nthis.call=call;',context);
  const value=await context.call('referee-batch-1','PRIVATE exact request',{
    optional:true,maxAttempts:1,responseKind:'referee',refereeContract:c,requestId:c.requestId,
    validateResult:r=>A.meetingAgentDispositionError(r,[child],c),captureError:e=>{capturedError=e;}});
  assert.equal(value,null);assert.equal(providerCalls,1);assert.equal(capturedError.code,'invalid_referee_target');
  const entry=h.stored.qualityState.discussion.refereeFailureAudit.entries[0];
  assert.equal(entry.prompt.value,'PRIVATE exact request');
  assert.equal(entry.rawReply.value.candidateDispositions[0].targetId,'PRIVATE_BAD_TARGET');
  assert.equal(entry.contract.value.requestId,c.requestId);
  assert.equal(entry.validation.code,'invalid_referee_target');
  assert.ok(!logs.join('').includes('PRIVATE_BAD_TARGET'));
  assert.ok(!JSON.stringify(A.publicMeetingAgentDraft(h.stored)).includes('PRIVATE_BAD_TARGET'));
});
