'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const api=require('../routes/api').stagedEvaluation;
const source=fs.readFileSync(require.resolve('../routes/api'),'utf8');
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
    vm.runInContext(productionFunction(source,name),context);
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
