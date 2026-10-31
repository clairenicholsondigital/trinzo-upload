'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const api=require('../routes/api').stagedEvaluation;
const prewarmSource=fs.readFileSync(require.resolve('../utils/meetingMinutesCandidatePrewarm'),'utf8');
const ledgerSource=fs.readFileSync(require.resolve('../utils/meetingMinutesCandidateLedger'),'utf8');
const runtimeSource=fs.readFileSync(require.resolve('../utils/meetingMinutesGenerationRuntime'),'utf8');
function productionFunction(text,name){
  let start=text.indexOf('function '+name+'(');
  if(start>=6&&text.slice(start-6,start)==='async ')start-=6;
  const end=text.indexOf('\n}\n',start);
  if(start<0||end<=start)throw Error('Missing production function: '+name);
  return text.slice(start,end+2);
}
const discoverySource=fs.readFileSync(require.resolve('../utils/meetingMinutesOriginalDiscovery'),'utf8');
const draft=()=>({draftId:'ready-join',preparedTranscript:'[T0001] Morgan: I will prepare the report.',transcriptSha256:'source-hash',details:{meetingDate:'2026-06-17'},sourceUnits:[{id:'T0001',speaker:'Morgan',text:'I will prepare the report.'}]});
function harness(){
  let resolve,reject,calls=0;
  const pending=new Promise((yes,no)=>{resolve=yes;reject=no});
  const cache=new Map(),d=draft();
  const context=vm.createContext({Date,Map,Promise,Number,Array,structuredClone,setTimeout,clearTimeout,
    crypto:require('node:crypto'),normaliseSourceUnits:require('../utils/meetingMinutesAgentV2').normaliseSourceUnits,
    privateStagedCandidateCache:cache,PRIVATE_STAGED_CACHE_TTL_MS:60000,PRIVATE_STAGED_CACHE_MAX_ENTRIES:20,
    privateStagedCandidateCacheKey:api.privateStagedCandidateCacheKey,cachedStagedCandidatesForStage:api.cachedStagedCandidatesForStage,
    withPrivateStagedCandidateSlot:task=>task(),buildPrivateStagedCandidateLedger:()=>{calls++;return pending;}});
  vm.runInContext(productionFunction(runtimeSource,'prunePrivateStagedCandidateCache'),context);
  for(const name of ['startPrivateStagedCandidateLedger','awaitPrivateStagedCandidateLedger','peekReadyPrivateStagedCandidateLedger']) {
    vm.runInContext(productionFunction(name==='peekReadyPrivateStagedCandidateLedger'?ledgerSource:prewarmSource,name),context);
  }
  const rows=api.stagedCandidateLedgerFromResult({discussion:[],objectives:[],actions:[{id:'report',action:'Prepare the report.',owners:['Morgan'],timing:{kind:'not_stated',wording:'',exactDate:''},evidenceIds:['T0001'],reviewFlagIds:[]}]},d);
  const freeze=(current=[])=>{
    Object.assign(context,{draft:d,stage:'actions',stagedJoinPending:true,stagedAll:structuredClone(current),stagedJoinStatus:'pending',stagedCandidatesFromPrewarm:false});
    const start=discoverySource.indexOf('  const stagedCandidateJoin = { initial: stagedJoinStatus');
    const end=discoverySource.indexOf('  const primaryParsed = primaryResult ||',start);
    assert.ok(start>=0&&end>start);
    vm.runInContext('{'+discoverySource.slice(start,end)+'\nthis.frozen={rows:stagedAll,audit:stagedCandidateJoin};}',context);
    return structuredClone(context.frozen);
  };
  return {d,rows,cache,context,resolve,reject,freeze,calls:()=>calls,
    start:()=>context.startPrivateStagedCandidateLedger(d,'actions'),
    join:()=>context.awaitPrivateStagedCandidateLedger(d,'actions',1),
    peek:(value=d)=>context.peekReadyPrivateStagedCandidateLedger(value,'actions')};
}

test('already completed staged actions are adopted after the first join times out, without more provider work',async()=>{
  const h=harness();const first=await h.join();assert.equal(first,null);assert.equal(h.calls(),1);
  assert.equal(h.peek().status,'pending');
  const completed=h.start();h.resolve(h.rows);await completed;
  const frozen=h.freeze();assert.equal(frozen.rows.length,1);assert.equal(frozen.audit.adoptedWithoutWait,true);
  assert.equal(frozen.audit.initial,'pending');assert.equal(frozen.audit.atAdjudication,'ready');assert.equal(frozen.audit.usedCount,1);
  assert.equal(h.calls(),1,'peeking never starts another extraction');
  h.rows[0].record.action='Changed after adjudication';
  assert.equal(frozen.rows[0].record.action,'Prepare the report.');
});
test('ready before the initial join and an honestly empty ready result remain usable',async()=>{
  for(const empty of [false,true]){
    const h=harness(),started=h.start();h.resolve(empty?[]:h.rows);await started;
    assert.equal((await h.join()).length,empty?0:1);assert.equal(h.peek().status,'ready');assert.equal(h.calls(),1);
  }
});
test('pending at adjudication stays excluded even if it completes afterwards',async()=>{
  const h=harness();await h.join();const frozen=h.freeze();assert.equal(frozen.rows.length,0);assert.equal(frozen.audit.atAdjudication,'pending');
  const completion=h.start();h.resolve(h.rows);await completion;
  assert.equal(h.peek().rows.length,1);assert.equal(frozen.rows.length,0,'completion cannot alter a frozen generation');
});
test('failed work is not reused or restarted by the nonblocking peek',async()=>{
  const h=harness(),promise=h.start();h.reject(Error('extractor failed'));await assert.rejects(promise,/extractor failed/);
  assert.equal(h.peek().status,'absent');assert.equal(h.freeze().rows.length,0);assert.equal(h.calls(),1);
});
test('expired, changed-input and stale-inference results cannot join the current stage',async()=>{
  const h=harness(),promise=h.start();h.resolve(h.rows);await promise;
  assert.equal(h.peek({...h.d,sourceUnits:[{...h.d.sourceUnits[0],text:'Different work in the source.'}]}).status,'stale');
  for(const changed of [{...h.d,preparedTranscript:h.d.preparedTranscript+' changed'},
    {...h.d,transcriptSha256:'different-source'},
    {...h.d,details:{...h.d.details,meetingDate:'2026-06-18'}},
    {...h.d,details:{...h.d.details,meetingType:'board'}}])assert.equal(h.peek(changed).status,'absent');
  const entry=h.cache.get(api.privateStagedCandidateCacheKey(h.d,'actions'));
  entry.value[0].timingInferenceInputKey='old-policy';assert.equal(h.peek().status,'stale');assert.equal(h.freeze().rows.length,0);
  entry.expiresAt=Date.now()-1;assert.equal(h.peek().status,'absent');assert.equal(h.calls(),1);
});
test('an existing ensemble is not replaced and peeking does not mutate reviewer work',async()=>{
  const h=harness(),promise=h.start();h.resolve(h.rows);await promise;
  h.d.actions=[{id:'manual',action:'Reviewer-owned instruction.',reviewerAuthored:true}];const before=structuredClone(h.d);
  const own=[{candidateId:'existing'}],frozen=h.freeze(own);
  assert.deepEqual(frozen.rows,own);assert.equal(frozen.audit.adoptedWithoutWait,false);assert.deepEqual(h.d,before);
});

// Load the actual process owner with controlled extractor/provider I/O. Canonical
// policies and shared cache identities are retained; no network or subprocess runs.
function lifecycleHarness(t) {
  const runtime=require('../utils/meetingMinutesGenerationRuntime');
  const previousStaged=new Map(runtime.privateStagedCandidateCache);
  const previousPrimary=new Map(runtime.privateActionPrimaryCache);
  runtime.privateStagedCandidateCache.clear();runtime.privateActionPrimaryCache.clear();
  t.after(()=>{
    runtime.privateStagedCandidateCache.clear();runtime.privateActionPrimaryCache.clear();
    for(const [key,value] of previousStaged)runtime.privateStagedCandidateCache.set(key,value);
    for(const [key,value] of previousPrimary)runtime.privateActionPrimaryCache.set(key,value);
  });
  const extracted=[],requested=[],fallback=[];
  const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
  const actualRequire=require('node:module').createRequire(require.resolve('../utils/meetingMinutesCandidatePrewarm'));
  const context={module:{exports:{}},console,structuredClone,setTimeout,clearTimeout,
    process:{env:{...process.env,MEETING_MINUTES_AGENT_STAGED_CANDIDATE_CONCURRENCY:'1'}},
    require(name){
      if(name==='./stagedMiniLmTrooper')return {generatePreparedTrooperStage(stage,transcript,options){
        const pending=deferred();extracted.push({stage,transcript,options,...pending});return pending.promise;
      }};
      if(name==='./meetingMinutesAgentTransport')return {askPowerAutomateMeetingMinutesAgentWithRetry(prompt,options){
        const pending=deferred();requested.push({prompt,options,...pending});return pending.promise;
      }};
      return actualRequire(name);
    }};
  vm.runInNewContext(prewarmSource,context,{filename:require.resolve('../utils/meetingMinutesCandidatePrewarm')});
  const owned=context.module.exports;
  const prewarm=owned.createMeetingMinutesCandidatePrewarm(async(...args)=>{
    fallback.push(args);return {state:{discussion:[],actions:[],summary:{}}};
  });
  return {runtime,prewarm,extracted,requested,fallback,
    state:()=>JSON.parse(JSON.stringify(owned.privateStagedCandidateQueueState())),
    tick:()=>new Promise(resolve=>setImmediate(resolve))};
}

test('actual prewarm queue preserves discussion priority, FIFO, capacity and release after failure',async t=>{
  const h=lifecycleHarness(t);
  const input=label=>({...draft(),draftId:label,transcriptSha256:label,
    sourceUnits:[{...draft().sourceUnits[0],text:'I will prepare the report. '+label}]});
  const first=h.prewarm.startPrivateStagedCandidateLedger(input('active'),'actions');
  const failed=assert.rejects(first,/controlled extractor failure/);
  const action=h.prewarm.startPrivateStagedCandidateLedger(input('queued-action'),'actions');
  const discussionA=h.prewarm.startPrivateStagedCandidateLedger(input('discussion-first'),'discussion');
  const discussionB=h.prewarm.startPrivateStagedCandidateLedger(input('discussion-second'),'discussion');
  await h.tick();
  assert.deepEqual(h.state(),{stagedActive:1,stagedQueued:3});
  assert.equal(h.extracted.length,1);
  h.extracted[0].reject(Error('controlled extractor failure'));await failed;await h.tick();
  assert.match(h.extracted[1].transcript,/discussion-first/);
  assert.deepEqual(h.state(),{stagedActive:1,stagedQueued:2});
  h.extracted[1].resolve({screens:{discussion:[]}});await discussionA;await h.tick();
  assert.match(h.extracted[2].transcript,/discussion-second/);
  h.extracted[2].resolve({screens:{discussion:[]}});await discussionB;await h.tick();
  assert.match(h.extracted[3].transcript,/queued-action/);
  assert.deepEqual(h.extracted.map(row=>row.stage),['actions','discussion','discussion','actions']);
  assert.deepEqual(h.state(),{stagedActive:1,stagedQueued:0});
  h.extracted[3].resolve({screens:{actions:[]}});await action;await h.tick();
  assert.deepEqual(h.state(),{stagedActive:0,stagedQueued:0});
  const value={...draft(),fileName:'fallback.txt'};
  assert.deepEqual(await h.prewarm.buildPrivateStagedCandidateLedger(value),[]);
  assert.deepEqual(JSON.parse(JSON.stringify(h.fallback)),[[value.preparedTranscript,{fileName:'fallback.txt'}]]);
});

test('actual Primary prewarm deduplicates requests and preserves cache identity, expiry and failure recovery',async t=>{
  const h=lifecycleHarness(t),value=draft();
  const response={result:{actions:[],discussion:[]},timings:[{elapsedMs:1,ok:true}]};
  const key=input=>api.meetingAgentPassCacheKey(h.runtime.meetingAgentActionPrimaryPromptForDraft(input));
  const first=h.prewarm.startPrivateActionPrimaryPrewarm(value);
  assert.equal(h.prewarm.startPrivateActionPrimaryPrewarm(value),first);
  assert.equal(h.requested.length,1);
  assert.equal(typeof h.requested[0].options.validateResult,'function');
  h.requested[0].resolve(response);const ready=await first;
  assert.equal(await h.prewarm.usePrivateActionPrimaryPrewarm(value,h.requested[0].prompt),ready);
  assert.equal(h.requested.length,1);
  for(const changed of [
    {...value,preparedTranscript:value.preparedTranscript+' Updated source.'},
    {...value,steer:'Check the approval dependency.'},
    {...value,details:{...value.details,meetingDate:'2026-06-18'}}
  ]){
    const before=h.requested.length,promise=h.prewarm.startPrivateActionPrimaryPrewarm(changed);
    assert.equal(h.requested.length,before+1);
    assert.notEqual(key(changed),key(value));
    h.requested.at(-1).resolve(response);await promise;
  }
  const originalKey=key(value);
  h.runtime.privateActionPrimaryCache.get(originalKey).expiresAt=Date.now()-1;
  const expired=h.prewarm.startPrivateActionPrimaryPrewarm(value);
  const oldFailure=assert.rejects(expired,/older request failed/);
  const replacement={expiresAt:Date.now()+60000,status:'ready',promise:Promise.resolve(ready)};
  h.runtime.privateActionPrimaryCache.set(originalKey,replacement);
  h.requested.at(-1).reject(Error('older request failed'));await oldFailure;
  assert.equal(h.runtime.privateActionPrimaryCache.get(originalKey),replacement);
  assert.equal(h.prewarm.startPrivateActionPrimaryPrewarm(value),replacement.promise);
  const retryInput={...value,steer:'Recover a failed request.'};
  const pending=h.prewarm.startPrivateActionPrimaryPrewarm(retryInput);
  const failed=assert.rejects(pending,/retryable fixture failure/);
  h.requested.at(-1).reject(Error('retryable fixture failure'));await failed;
  assert.equal(h.runtime.privateActionPrimaryCache.has(key(retryInput)),false);
  const beforeRetry=h.requested.length,retry=h.prewarm.startPrivateActionPrimaryPrewarm(retryInput);
  assert.equal(h.requested.length,beforeRetry+1);
  h.requested.at(-1).resolve(response);await retry;
  const safeInput={...value,steer:'Optional failed adoption.'};
  const safe=h.prewarm.usePrivateActionPrimaryPrewarm(safeInput,h.runtime.meetingAgentActionPrimaryPromptForDraft(safeInput));
  h.requested.at(-1).reject(Error('optional fixture failure'));
  assert.equal(await safe,null);
});
