'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),JSZip=require('jszip');
const P=require('../utils/meetingMinutesParallel'), E=require('../utils/meetingMinutesParallelEngine');
const G=require('../utils/meetingMinutesAgentGeneration');
const source=[{id:'T0001',speaker:'Alex',timestamp:'0:00',text:'We hope to finish the review on Tuesday, then add the technical considerations.',classification:'keep'}];
const record=(id,text)=>({id,text,evidenceIds:['T0001']});
function base(){return {generationProvider:P.PROVIDER,draftId:'17',revision:1,status:'draft',payloadVersion:5,
 details:{meetingTitle:'Review',meetingDate:'2026-10-28',internalAttendees:['Alex'],clientAttendees:[]},
 sourceUnits:structuredClone(source),preparedTranscript:source[0].text,discussion:[],actions:[],meetingObjectives:[],executiveSummary:'',
 reviewFlags:[],qualityState:{preparation:{dateContext:{source:'reviewer'}}},changeHistory:[],redoHistory:[],currentStep:0,
 unassignedSupportingDetails:[],removedActions:[],keptActionIds:[],keptActionOccurrenceIds:[]};}
function replies(){return {
 summary:{schemaVersion:1,specialist:'summary',executiveSummary:{text:'Review the proposed work.',evidenceIds:['T0001']},meetingObjectives:[record('O1','Review scope.')],reviewFlags:[]},
 discussion:{schemaVersion:1,specialist:'discussion',discussion:[{id:'TOP1',topic:'Technical review',points:[record('P1','Review is hoped for Tuesday; later additions have no agreed date.')],decisions:[],openQuestions:[]}],reviewFlags:[]},
 actions:{schemaVersion:1,specialist:'actions',actions:[{id:'A1',action:'Review the file.',owners:['Alex'],timing:{kind:'target',wording:'hoping for Tuesday',exactDate:''},evidenceIds:['T0001']}],
 actionProposals:[{id:'AP1',action:'Add technical considerations.',owners:[],timing:{kind:'not_stated',wording:'',exactDate:''},reason:'No accepted owner was established.',evidenceIds:['T0001']}],reviewFlags:[]}
};}
async function generated(options={}){
 const values=replies();const starts=[];
 const config=Object.fromEntries(E.STAGES.map(s=>[s,{webhookUrl:'https://'+s+'.example.invalid'}]));
 const result=await E.runSpecialists(P.packet(base()),config,{fetchImpl:async(url,init)=>{
  const stage=new URL(url).hostname.split('.')[0];starts.push({stage,body:JSON.parse(init.body)});
  await new Promise(r=>setTimeout(r,5));return {ok:true,text:async()=>JSON.stringify(values[stage])};
 },...options});
 return {result,starts};
}
test('the integrated engine sends exactly three independent concurrent requests with identical packets',async()=>{
 const {result,starts}=await generated();assert.equal(result.status,'completed');assert.equal(starts.length,3);
 assert.deepEqual(starts.map(x=>x.stage),['summary','discussion','actions']);
 assert.equal(new Set(starts.map(x=>x.body.prompt)).size,1);
 assert.equal(result.minutes.actionProposals.length,1);assert.equal(result.minutes.actions.length,1);
});
test('a malformed provider response retries only its branch once before preserving partial failure',async()=>{
 let calls=0;const perStage={summary:0,discussion:0,actions:0};
 const config=Object.fromEntries(E.STAGES.map(s=>[s,{webhookUrl:'https://'+s+'.example.invalid'}]));
 const result=await E.runSpecialists(P.packet(base()),config,{fetchImpl:async(url)=>{
  calls++;const stage=new URL(url).hostname.split('.')[0];perStage[stage]++;return {ok:true,text:async()=>stage==='actions'?'invalid':JSON.stringify(replies()[stage])};
 }});
 assert.equal(calls,4);assert.deepEqual(perStage,{summary:1,discussion:1,actions:2});
 assert.equal(result.status,'partial');assert.equal(result.minutes.actions,null);
 assert.equal(result.branches.actions.formatFailures.length,2);assert.equal(result.branches.actions.error.code,'INVALID_JSON');
 assert.throws(()=>P.resultChanges(base(),result),/could not be generated/);
});
test('a retried specialist preserves successful branches, exact requests and checked previews while recovering',async()=>{
 const calls=[],events=[],counts={summary:0,discussion:0,actions:0};let releaseRetry,settled=false;
 const invalid='PRIVATE malformed reply https://private.example.invalid/secret';
 const config=Object.fromEntries(E.STAGES.map(stage=>[stage,{webhookUrl:'https://'+stage+'.example.invalid'}]));
 const running=E.runSpecialists(P.packet(base()),config,{now:()=>1234567890000,requestId:'unchanged-request',
  fetchImpl:(url,init)=>{const stage=new URL(url).hostname.split('.')[0];calls.push({stage,body:init.body});counts[stage]++;
   if(stage==='summary'&&counts.summary===2)return new Promise(resolve=>{releaseRetry=()=>resolve({ok:true,text:async()=>JSON.stringify(replies().summary)});});
   return Promise.resolve({ok:true,text:async()=>stage==='summary'?JSON.stringify({lastResponse:invalid}):JSON.stringify(replies()[stage])});
  },onProgress:event=>events.push(event)});
 running.then(()=>{settled=true;});await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(counts,{summary:2,discussion:1,actions:1});assert.equal(settled,false);
 assert.equal(new Set(calls.map(call=>call.body)).size,1,'retry must reuse the exact original request body');
 assert.equal(events.filter(event=>event.stage==='summary').at(-1).code,'retrying');
 assert.ok(!events.some(event=>event.code==='failed'));
 let progress=null;for(const event of events)progress=G.mergeMeetingAgentProgress(progress,event,{includePreviews:true});
 assert.equal(progress.sections.summary.preview,undefined);assert.equal(progress.sections.summary.counts,undefined);
 assert.ok(progress.sections.actions.preview);assert.ok(progress.sections.discussion.preview);
 releaseRetry();const result=await running;
 assert.equal(result.status,'completed');assert.deepEqual(result.minutes,(await generated()).result.minutes);
 assert.deepEqual(events.filter(event=>event.stage==='summary').map(event=>event.code),
  ['request_sent','response_received','validating','retrying','response_received','validating','validated']);
 assert.equal(result.branches.summary.formatFailures.length,1);assert.equal(result.branches.summary.formatFailures[0].textShape,'other_text');
 assert.equal(result.branches.actions.formatFailures,undefined);assert.equal(result.branches.discussion.formatFailures,undefined);
 assert.ok(!JSON.stringify(result.branches.summary.formatFailures).includes('PRIVATE'));
 assert.ok(!JSON.stringify(result.branches.summary.formatFailures).includes('https:'));
 const stored={...base(),...P.resultChanges(base(),result)};
 assert.deepEqual(stored.qualityState.parallel.branches.summary.formatFailures,result.branches.summary.formatFailures);
 assert.equal(P.publicDraft(stored).qualityState,undefined);
});

test('the runner keeps successful previews and saved content separate through recovery or final format failure',async()=>{
 for(const recover of [true,false]){
  const initial=base();initial.executiveSummary='Previously saved summary.';
  initial.actions=[{...replies().actions.actions[0],action:'Keep the existing reviewer action.'}];
  initial.discussion=structuredClone(replies().discussion.discussion);initial.discussion[0].points[0].text='Keep the existing reviewer discussion.';
  let stored=structuredClone(initial),tail=Promise.resolve(),releaseRetry;const counts={summary:0,discussion:0,actions:0};
  const config=Object.fromEntries(E.STAGES.map(stage=>[stage,{webhookUrl:'https://'+stage+'.example.invalid'}]));
  const runner=P.createRunner({getDraft:async()=>structuredClone(stored),config:()=>config,
   serialWrite:(_id,task)=>{const next=tail.then(task);tail=next.catch(()=>{});return next;},
   saveDraft:async(draft,user,changes)=>(stored={...stored,...changes,revision:stored.revision+1},structuredClone(stored)),
   execute:(packet,configuration,options)=>E.runSpecialists(packet,configuration,{...options,fetchImpl:url=>{
    const stage=new URL(url).hostname.split('.')[0];counts[stage]++;
    if(stage==='summary'&&counts.summary===2)return new Promise(resolve=>{releaseRetry=()=>resolve({ok:true,text:async()=>recover?JSON.stringify(replies().summary):'PRIVATE final malformed reply'});});
    return Promise.resolve({ok:true,text:async()=>stage==='summary'?JSON.stringify({lastResponse:'PRIVATE first malformed reply'}):JSON.stringify(replies()[stage])});
   }})});
  await runner.start(initial,1);await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(counts,{summary:2,discussion:1,actions:1});
  assert.equal(stored.generation.progress.sections.summary.code,'retrying');
  assert.ok(stored.generation.progress.sections.discussion.preview);assert.ok(stored.generation.progress.sections.actions.preview);
  assert.deepEqual(stored.actions,initial.actions);assert.deepEqual(stored.discussion,initial.discussion);
  assert.equal(stored.executiveSummary,initial.executiveSummary);
  const waiting=G.publicMeetingAgentProgress(stored,stored.generation,Date.now(),{includePreviews:true});
  assert.ok(waiting.sections.actions.preview);assert.equal(waiting.sections.summary.preview,undefined);
  releaseRetry();await runner.active.get('17');assert.deepEqual(counts,{summary:2,discussion:1,actions:1});
  if(recover){
   assert.equal(stored.generation,null);assert.equal(stored.executiveSummary,'Review the proposed work.');
   assert.equal(stored.qualityState.parallel.branches.summary.formatFailures.length,1);
  }else{
   assert.equal(stored.generation.status,'failed');assert.equal(stored.executiveSummary,initial.executiveSummary);
   assert.deepEqual(stored.actions,initial.actions);assert.deepEqual(stored.discussion,initial.discussion);
   assert.equal(stored.qualityState.parallelAttempt.result.branches.summary.formatFailures.length,2);
   assert.ok(Object.values(G.publicMeetingAgentProgress(stored,stored.generation,Date.now(),{includePreviews:true}).sections)
    .every(section=>section.preview===undefined));
  }
  assert.ok(!JSON.stringify(P.publicDraft(stored)).includes('PRIVATE'));
 }
});

test('two malformed branches recover independently and empty inner responses remain format failures',async()=>{
 const counts={summary:0,discussion:0,actions:0};
 const config=Object.fromEntries(E.STAGES.map(stage=>[stage,{webhookUrl:'https://'+stage+'.example.invalid'}]));
 const result=await E.runSpecialists(P.packet(base()),config,{fetchImpl:async url=>{
  const stage=new URL(url).hostname.split('.')[0];counts[stage]++;
  return {ok:true,text:async()=>counts[stage]===1&&stage!=='actions'
   ?stage==='summary'?JSON.stringify({lastResponse:''}):JSON.stringify({responses:['']})
   :JSON.stringify(replies()[stage])};
 }});
 assert.deepEqual(counts,{summary:2,discussion:2,actions:1});assert.equal(result.status,'completed');
 for(const [stage,envelope]of [['summary','lastResponse'],['discussion','responses_last']]){
  const failure=result.branches[stage].formatFailures[0];
  assert.equal(failure.code,'INVALID_AGENT_JSON');assert.equal(failure.envelope,envelope);
  assert.equal(failure.textShape,'empty');assert.equal(failure.candidateBytes,0);
 }
});

test('format diagnostics contain bounded structure only for empty, fenced, json-like and other replies',()=>{
 const privateText='PRIVATE response https://private.example.invalid/secret';
 for(const [raw,code,envelope,shape]of [
  ['', 'INVALID_JSON','body','empty'],
  ['  ', 'INVALID_JSON','body','empty'],
  ['```json\\n'+privateText+'\\n```','INVALID_JSON','body','fenced'],
  ['{"private":','INVALID_JSON','body','json_like'],
  [JSON.stringify({lastResponse:'```json\\n'+privateText+'\\n```'}),'INVALID_AGENT_JSON','lastResponse','fenced'],
  [JSON.stringify({responses:['{"private":']}),'INVALID_AGENT_JSON','responses_last','json_like'],
  [JSON.stringify(privateText),'INVALID_AGENT_JSON','body','other_text']
 ]){
  assert.throws(()=>E.decodeReply(raw),error=>{
   assert.equal(error.code,code);assert.equal(error.responseDiagnostics.envelope,envelope);
   assert.equal(error.responseDiagnostics.textShape,shape);assert.equal(error.responseDiagnostics.candidateType,'string');
   assert.equal(error.responseDiagnostics.responseBytes,Buffer.byteLength(raw));
   assert.ok(Object.keys(error.responseDiagnostics).every(key=>['responseBytes','envelope','candidateType','candidateBytes','textShape'].includes(key)));
   assert.ok(!JSON.stringify(error).includes('PRIVATE'));assert.ok(!JSON.stringify(error).includes('https:'));
   assert.ok(!error.message.includes('private'));return true;
  });
 }
});

test('format retries share the original deadline and require at least ten seconds remaining',async t=>{
 for(const elapsed of [170000,170001,180000]){
  let clock=0;const counts={summary:0,discussion:0,actions:0},timeouts=[];
  const configured=t.mock.method(AbortSignal,'timeout',milliseconds=>{timeouts.push(milliseconds);return new AbortController().signal;});
  try{
   const config=Object.fromEntries(E.STAGES.map(stage=>[stage,{webhookUrl:'https://'+stage+'.example.invalid'}]));
   const result=await E.runSpecialists(P.packet(base()),config,{now:()=>clock,fetchImpl:async url=>{
    const stage=new URL(url).hostname.split('.')[0];const attempt=++counts[stage];
    return {ok:true,text:async()=>{if(stage==='summary'&&attempt===1){clock=elapsed;return 'invalid';}return JSON.stringify(replies()[stage]);}};
   }});
   const retried=elapsed===170000;
   assert.deepEqual(counts,{summary:retried?2:1,discussion:1,actions:1});
   assert.deepEqual(timeouts,retried?[180000,180000,180000,10000]:[180000,180000,180000]);
   assert.equal(result.status,retried?'completed':'partial');
   assert.ok(result.parallelElapsedMs<=180000);
  }finally{configured.mock.restore();}
 }
});

test('schema, evidence, dates, HTTP and transport failures do not authorize format retries',async()=>{
 const badSchema={...replies().actions,schemaVersion:2},badEvidence=replies().actions,badDate=replies().actions;
 badEvidence.actions[0].evidenceIds=['UNKNOWN'];badDate.actions[0].timing.exactDate='2026-02-30';
 for(const [code,body,status,thrown]of [
  ['INVALID_CONTRACT',JSON.stringify(badSchema),200],['UNKNOWN_EVIDENCE',JSON.stringify(badEvidence),200],
  ['INVALID_DATE',JSON.stringify(badDate),200],['PROVIDER_HTTP_401','PRIVATE authentication reply',401],
  ['PROVIDER_HTTP_429','PRIVATE rate reply',429],['PROVIDER_HTTP_503','PRIVATE service reply',503],
  ['PROVIDER_ERROR','{"error":"PRIVATE failure"}',200],
  ['PROVIDER_UNAVAILABLE',null,200,Error('PRIVATE network URL')],['PROVIDER_TIMEOUT',null,200,Object.assign(Error('PRIVATE timeout'),{name:'TimeoutError'})]
 ]){
  const counts={summary:0,discussion:0,actions:0},events=[];
  const config=Object.fromEntries(E.STAGES.map(stage=>[stage,{webhookUrl:'https://'+stage+'.example.invalid'}]));
  const result=await E.runSpecialists(P.packet(base()),config,{onProgress:event=>events.push(event),fetchImpl:async url=>{
   const stage=new URL(url).hostname.split('.')[0];counts[stage]++;
   if(stage==='actions'&&thrown)throw thrown;
   return {ok:stage!=='actions'||status===200,status,text:async()=>stage==='actions'?body:JSON.stringify(replies()[stage])};
  }});
  assert.deepEqual(counts,{summary:1,discussion:1,actions:1},code);
  assert.equal(result.branches.actions.error.code,code);assert.equal(result.branches.actions.formatFailures,undefined);
  assert.ok(!events.some(event=>event.code==='retrying'),code);
 }
 const absentConfig=Object.fromEntries(E.STAGES.map(stage=>[stage,{webhookUrl:stage==='actions'?'':'https://'+stage+'.example.invalid'}]));
 let configuredCalls=0;
 const unconfigured=await E.runSpecialists(P.packet(base()),absentConfig,{fetchImpl:async url=>{
  configuredCalls++;return {ok:true,text:async()=>JSON.stringify(replies()[new URL(url).hostname.split('.')[0]])};
 }});
 assert.equal(configuredCalls,2);assert.equal(unconfigured.branches.actions.error.code,'NOT_CONFIGURED');
 // A replacement response still has to pass schema and evidence validation; no third call.
 for(const [replacement,code]of [[badSchema,'INVALID_CONTRACT'],[badEvidence,'UNKNOWN_EVIDENCE']]){
  let calls=0;const values=replies();values.actions=replacement;
  const config=Object.fromEntries(E.STAGES.map(stage=>[stage,{webhookUrl:'https://'+stage+'.example.invalid'}]));
  const result=await E.runSpecialists(P.packet(base()),config,{fetchImpl:async url=>{
   const stage=new URL(url).hostname.split('.')[0];if(stage==='actions')calls++;
   return {ok:true,text:async()=>stage==='actions'&&calls===1?'invalid':JSON.stringify(values[stage])};
  }});
  assert.equal(calls,2);assert.equal(result.branches.actions.error.code,code);assert.equal(result.branches.actions.formatFailures.length,1);
 }
});

test('branch progress follows actual responses without changing concurrent requests or final results',async()=>{
 const starts=[],events=[],observedLaunchCounts=[],release={};let settled=false;
 const config=Object.fromEntries(E.STAGES.map(stage=>[stage,{webhookUrl:'https://'+stage+'.example.invalid'}]));
 const options={requestId:'progress-run',now:()=>1234567890000};
 const running=E.runSpecialists(P.packet(base()),config,{...options,
  fetchImpl:(url,init)=>{const stage=new URL(url).hostname.split('.')[0];starts.push({stage,body:JSON.parse(init.body)});
   return new Promise(resolve=>{release[stage]=()=>resolve({ok:true,text:async()=>JSON.stringify(replies()[stage])});});},
  onProgress:event=>{observedLaunchCounts.push(starts.length);events.push(event);}
 });
 running.then(()=>{settled=true;});
 assert.deepEqual(starts.map(item=>item.stage),E.STAGES);
 release.actions();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(settled,false,'one validated branch cannot complete the minutes');
 assert.deepEqual(events.filter(event=>event.stage==='actions').map(event=>event.code),['request_sent','response_received','validating','validated']);
 const checkedAction=events.find(event=>event.stage==='actions' && event.code==='validated');
 assert.deepEqual(checkedAction.counts,{records:1,proposals:1,flags:0});
 assert.deepEqual(checkedAction.preview,{actions:[{action:'Review the file.',owners:['Alex'],timing:{kind:'target',wording:'hoping for Tuesday',exactDate:''}}]});
 assert.ok(events.filter(event=>event.stage!=='actions').every(event=>event.code==='request_sent'));
 release.summary();release.discussion();const result=await running;
 const baseline=await generated(options);
 assert.deepEqual(result,baseline.result);assert.deepEqual(starts,baseline.starts);
 assert.ok(observedLaunchCounts.every(count=>count===3),'all requests start before observer work');
 for(const event of events){assert.ok(Object.keys(event).every(key=>['stage','code','counts','preview'].includes(key)));if(event.counts||event.preview)assert.equal(event.code,'validated');}
 assert.ok(!JSON.stringify(events).includes('evidenceIds'));assert.ok(!JSON.stringify(events).includes('actionProposals'));
 assert.ok(!JSON.stringify(events).includes(source[0].text));
});
test('validated branch previews persist before the other branches finish without publishing draft content',async()=>{
 const initial=base();let stored=structuredClone(initial),calls=0;const release={};
 const config=Object.fromEntries(E.STAGES.map(stage=>[stage,{webhookUrl:'https://'+stage+'.example.invalid'}]));
 const runner=P.createRunner({getDraft:async()=>structuredClone(stored),config:()=>config,
  saveDraft:async(draft,user,changes)=>(stored={...stored,...changes,revision:stored.revision+1},structuredClone(stored)),
  execute:(packet,configuration,options)=>E.runSpecialists(packet,configuration,{...options,fetchImpl:url=>{
   calls++;const stage=new URL(url).hostname.split('.')[0];
   return new Promise(resolve=>{release[stage]=()=>resolve({ok:true,text:async()=>JSON.stringify(replies()[stage])});});
  }})});
 await runner.start(initial,1);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls,3);release.summary();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(stored.generation.status,'running');assert.equal(stored.generation.progressInputHash,P.inputHash(stored));
 assert.equal(stored.generation.progress.sections.summary.preview.executiveSummary,'Review the proposed work.');
 assert.equal(stored.executiveSummary,'');assert.deepEqual(stored.discussion,[]);assert.deepEqual(stored.actions,[]);
 assert.equal(stored.qualityState.summary,undefined);
 const reopened=G.publicMeetingAgentProgress(structuredClone(stored),stored.generation,Date.now(),{includePreviews:true});
 assert.deepEqual(reopened.sections.summary.preview,{executiveSummary:'Review the proposed work.',meetingObjectives:[{text:'Review scope.'}]});
 assert.equal(reopened.sections.actions.preview,undefined);assert.equal(reopened.status,'running');
 release.discussion();release.actions();await runner.active.get('17');
 assert.equal(calls,3);assert.equal(stored.generation,null);assert.equal(stored.executiveSummary,'Review the proposed work.');
});

test('flat discussion previews reuse display conversion and all previews remain bounded allowlisted text',async()=>{
 const values=replies();values.discussion={schemaVersion:1,specialist:'discussion',items:[record('flat-id','Keep this exact flat wording.')],reviewFlags:[]};
 const events=[],config=Object.fromEntries(E.STAGES.map(stage=>[stage,{webhookUrl:'https://'+stage+'.example.invalid'}]));
 await E.runSpecialists(P.packet(base()),config,{fetchImpl:async url=>({ok:true,text:async()=>JSON.stringify(values[new URL(url).hostname.split('.')[0]])}),onProgress:event=>events.push(event)});
 assert.deepEqual(events.find(event=>event.stage==='discussion'&&event.code==='validated').preview,
  {discussion:[{topic:'Discussion',hideHeading:true,points:[{text:'Keep this exact flat wording.'}],decisions:[],openQuestions:[]}]});
 const sentinel='private-preview-field';
 const topic={topic:'Topic',points:Array.from({length:100},()=>({text:'t'.repeat(2000),id:sentinel,evidenceIds:[sentinel],raw:sentinel})),decisions:[],openQuestions:[],url:sentinel};
 const projected=G.normaliseMeetingAgentSectionPreview('discussion',{discussion:[topic,topic],raw:sentinel});
 assert.equal(projected.discussion.length,1);assert.equal(projected.discussion[0].points.length,80);
 assert.equal(projected.discussion[0].points[0].text.length,1600);assert.ok(!JSON.stringify(projected).includes(sentinel));
 const actions=G.normaliseMeetingAgentSectionPreview('actions',{actions:Array.from({length:100},()=>({action:'a'.repeat(2000),
  owners:Array(20).fill('o'.repeat(200)),timing:{kind:'stated',wording:'w'.repeat(800),exactDate:'2026-10-29',private:sentinel},id:sentinel,private:sentinel}))});
 assert.equal(actions.actions.length,60);assert.equal(actions.actions[0].action.length,1600);
 assert.equal(actions.actions[0].owners.length,12);assert.equal(actions.actions[0].owners[0].length,180);
 assert.equal(actions.actions[0].timing.wording.length,600);assert.ok(!JSON.stringify(actions).includes(sentinel));
 const event={stage:'summary',code:'validated',preview:{executiveSummary:'Text',meetingObjectives:[]}};
 assert.equal(G.mergeMeetingAgentProgress(null,event).sections.summary.preview,undefined);
 assert.equal(G.mergeMeetingAgentProgress(null,{...event,code:'validating'},{includePreviews:true}).sections.summary.preview,undefined);
 assert.equal(G.mergeMeetingAgentProgress(null,event,{includePreviews:true}).sections.summary.preview.executiveSummary,'Text');
});

test('throwing, rejected and unresolved progress observers cannot change provider outcomes', {timeout:2000},async()=>{
 const baseline=await generated({now:()=>1234567890000});
 for(const observer of [()=>{throw Error('private observer failure');},()=>Promise.reject(Error('private observer failure')),()=>new Promise(()=>{})]){
  const observed=await generated({now:()=>1234567890000,onProgress:observer});
  assert.equal(observed.starts.length,3);assert.deepEqual(observed.result,baseline.result);assert.deepEqual(observed.starts,baseline.starts);
 }
});
test('storage and publication preserve wording, qualifications, sources and proposal status exactly',async()=>{
 const {result}=await generated();const draft={...base(),...P.resultChanges(base(),result)};
 draft.actions[0].timing.wording='27th through to 7th August, if access is granted';
 draft.discussion[0].points[0].text='Alex will review the file; no later deadline was agreed.';
 const payload=P.payload(draft),publicView=P.publicDraft({...draft,qualityState:{...draft.qualityState,secret:'private'}});
 assert.deepEqual(payload.actions,draft.actions);assert.deepEqual(publicView.actions,draft.actions);
 assert.deepEqual(P.publication(draft).discussion,draft.discussion);
 assert.equal(publicView.qualityState,undefined);assert.equal(publicView.preparedTranscript,undefined);
 assert.equal(publicView.parallelActionProposals[0].status,'open');
 assert.equal(publicView.generatedStages.actions.length>0,true);assert.equal(publicView.actions.length,1);
 assert.equal(P.publicDraft(draft,{summary:true}).generationProvider,P.PROVIDER);
});
test('review edits retain qualified timing and cannot forge warning provenance or source references',()=>{
 const draft=base();draft.discussion=replies().discussion.discussion;draft.actions=replies().actions.actions;
 draft.reviewFlags=[{id:'F1',message:'Original warning',evidenceIds:['T0001'],status:'open'}];
 const actions=structuredClone(draft.actions);actions[0].action+=' after approval';
 const changes=P.reviewChanges(draft,{actions,reviewFlags:[{id:'F1',message:'Forged',evidenceIds:[],status:'corrected',note:'Checked',correctionNote:'Kept the conditional timing.'}]});
 assert.equal(changes.actions[0].timing.wording,'hoping for Tuesday');assert.match(changes.actions[0].action,/after approval/);
 assert.equal(changes.reviewFlags[0].message,'Original warning');assert.deepEqual(changes.reviewFlags[0].evidenceIds,['T0001']);
 assert.equal(changes.reviewFlags[0].status,'corrected');
 assert.equal(changes.reviewFlags[0].correctionNote,'Kept the conditional timing.');
 actions[0].evidenceIds=['UNKNOWN'];assert.throws(()=>P.reviewChanges(draft,{actions}),/unknown source/);
});
test('new-draft generation retains the original source and metadata but resets reviewer decisions and generated content',async()=>{
 const {result}=await generated();const old={...base(),...P.resultChanges(base(),result)};
 old.actions[0].action='Reviewer correction';old.keptActionIds=['A1'];
 const next=P.initialPayload(old);
 assert.equal(old.actions[0].action,'Reviewer correction');assert.deepEqual(next.actions,[]);
 assert.deepEqual(next.sourceUnits,old.sourceUnits);assert.deepEqual(next.details,old.details);
 assert.deepEqual(next.keptActionIds,[]);assert.deepEqual(next.changeHistory,[]);
});
test('background persistence retries only the save and preserves edits made during generation',async()=>{
 const initial=base();let stored=structuredClone(initial),executions=0,saves=0;const progressCodes=[];
 const runner=P.createRunner({getDraft:async()=>structuredClone(stored),saveDraft:async(d,u,c)=>{
  if(c.generation?.progress)progressCodes.push(c.generation.progress.code);
  saves++;stored={...stored,...c,revision:stored.revision+1};return structuredClone(stored);
 },config:()=>({}),execute:async(packet,configuration,{onProgress})=>{executions++;onProgress({stage:'actions',code:'validated',counts:{records:1}});stored.details.meetingTitle='Changed while running';return (await generated()).result;}});
 await runner.start(initial,1);await runner.active.get('17');
 assert.equal(executions,1);assert.equal(stored.generation.status,'failed');assert.match(stored.generation.error,/changed during/);
 assert.equal(stored.details.meetingTitle,'Changed while running');assert.deepEqual(stored.actions,[]);
 assert.equal(stored.qualityState.parallelAttempt.result.status,'completed');
 assert.ok(progressCodes.includes('validated'));assert.ok(!progressCodes.includes('saving'),'conflicted content is not being saved as generated minutes');
});
test('provider failures keep already saved content and never call the legacy pipeline',async()=>{
 const partial={...(await generated()).result,status:'partial'};
 for(const outcome of ['throw','partial']){
  const draft=base();draft.discussion=replies().discussion.discussion;let stored=structuredClone(draft),calls=0;const progressCodes=[];
  const runner=P.createRunner({getDraft:async()=>stored,saveDraft:async(d,u,c)=>{
   if(c.generation?.progress)progressCodes.push(c.generation.progress.code);
   return (stored={...stored,...c,revision:stored.revision+1});},
   config:()=>({}),execute:async(packet,configuration,{onProgress})=>{calls++;onProgress({stage:'actions',code:'failed'});if(outcome==='throw')throw Error('signed-secret-provider-url');return partial;}});
  await runner.start(draft,1);await runner.active.get('17');
  assert.equal(calls,1);assert.deepEqual(stored.discussion,draft.discussion);
  assert.equal(stored.generation.status,'failed');assert.ok(!stored.generation.error.includes('signed-secret'));
  assert.ok(progressCodes.includes('failed'));assert.ok(!progressCodes.includes('saving'),outcome+' must not claim to save generated minutes');
 }
});
test('advisory progress uses current serialized drafts and drains before final persistence',async()=>{
 let stored=base(),tail=Promise.resolve(),releaseWrite,firstWrite;const blocked=new Promise(resolve=>{firstWrite=resolve;});
 const release=new Promise(resolve=>{releaseWrite=resolve;});let providerCalls=0,first=true;const snapshots=[];
 const config=Object.fromEntries(E.STAGES.map(stage=>[stage,{webhookUrl:'https://'+stage+'.example.invalid'}]));
 const runner=P.createRunner({getDraft:async()=>structuredClone(stored),config:()=>config,
  serialWrite:(id,task)=>{assert.equal(id,'17');const next=tail.then(task);tail=next.catch(()=>{});return next;},
  saveDraft:async(draft,user,changes)=>{
   if(changes.generation?.progress && first){first=false;firstWrite();await release;}
   if(draft.revision!==stored.revision)throw Object.assign(Error('Conflict'),{statusCode:409});
   if(changes.generation?.progress){snapshots.push(structuredClone(changes.generation.progress));assert.equal(changes.generation.message,'Preparing your meeting minutes…');}
   if(changes.generation===null)assert.equal(stored.generation.progress.code,'saving');
   stored={...stored,...changes,revision:stored.revision+1};return structuredClone(stored);
  },execute:(packet,configuration,options)=>E.runSpecialists(packet,configuration,{...options,
   fetchImpl:async url=>{providerCalls++;return {ok:true,text:async()=>JSON.stringify(replies()[new URL(url).hostname.split('.')[0]])};}})});
 await runner.start(base(),1);await blocked;
 assert.equal(providerCalls,3,'provider requests do not wait for progress persistence');
 assert.deepEqual(stored.actions,[]);assert.equal(stored.generation.status,'running');
 assert.equal(stored.qualityState.parallel,undefined,'validated branches are not yet published');
 stored.fileName='Reviewer supplied filename';stored.revision++;
 releaseWrite();await runner.active.get('17');
 assert.equal(providerCalls,3);assert.equal(stored.fileName,'Reviewer supplied filename');
 assert.equal(stored.generation,null);assert.equal(stored.actions[0].action,'Review the file.');
 assert.equal(snapshots.at(-1).code,'saving');assert.ok(snapshots.some(snapshot=>snapshot.sections.actions?.code==='validated'));
 assert.ok(snapshots.every(snapshot=>snapshot.code!=='ready'));
});
test('progress write failures do not fail generation or expose observer errors',async()=>{
 let stored=base(),executions=0,progressAttempts=0;
 const runner=P.createRunner({getDraft:async()=>structuredClone(stored),config:()=>({}),
  saveDraft:async(draft,user,changes)=>{if(changes.generation?.progress){progressAttempts++;throw Error('private progress storage error');}
   stored={...stored,...changes,revision:stored.revision+1};return structuredClone(stored);},
  execute:async(packet,configuration,{onProgress})=>{executions++;onProgress({stage:'actions',code:'validated',counts:{records:1,proposals:1,flags:0}});return (await generated()).result;}});
 await runner.start(base(),1);await runner.active.get('17');
 assert.equal(executions,1);assert.ok(progressAttempts>0);assert.equal(stored.generation,null);
 assert.equal(stored.actions[0].action,'Review the file.');assert.ok(!JSON.stringify(stored).includes('private progress storage error'));
});
test('advisory writes reject superseded run identities while legacy fake run fixtures remain compatible',async()=>{
 const result=(await generated()).result;
 for(const replacement of [{requestId:'new-run'},{bootId:'new-boot'},{startedAt:'2027-01-01T00:00:00Z'},{status:'failed'}]){
  let stored=base(),progressWrites=0;
  const runner=P.createRunner({getDraft:async()=>structuredClone(stored),config:()=>({}),
   saveDraft:async(draft,user,changes)=>{if(changes.generation?.progress)progressWrites++;stored={...stored,...changes,revision:stored.revision+1};return structuredClone(stored);},
   execute:async(packet,configuration,{onProgress})=>{stored.generation={...stored.generation,...replacement};onProgress({stage:'actions',code:'validated',counts:{records:1},preview:{actions:replies().actions.actions}});return result;}});
  await runner.start(base(),1);await runner.active.get('17');assert.equal(progressWrites,0,JSON.stringify(replacement));
 }
 let stored={...base(),generation:{requestId:'legacy-fixture',status:'running'}};
 const runner=P.createRunner({getDraft:async()=>structuredClone(stored),config:()=>({}),
  saveDraft:async(draft,user,changes)=>(stored={...stored,...changes,revision:stored.revision+1}),
  execute:async(packet,configuration,{onProgress})=>{onProgress({stage:'actions',code:'validated',counts:{records:1}});return result;}});
 await runner.run(structuredClone(stored),1);assert.equal(stored.generation,null);assert.equal(stored.actions[0].action,'Review the file.');
});
test('Word export retains incomplete dates and evidence verbatim for parallel drafts',async()=>{
 const {result}=await generated();const draft={...base(),...P.resultChanges(base(),result)};
 draft.discussion[0].points[0].text='The review runs from 27th through to 7th August.';
 const buffer=await require('../utils/meetingMinutesAgentDocx').generateMeetingMinutesAgentDocx(draft,true);
 const zip=await JSZip.loadAsync(buffer);const xml=await zip.file('word/document.xml').async('string');
 assert.ok(xml.includes('27th through to 7th August'));assert.ok(xml.includes(source[0].text));
});
test('default stays legacy and an unauthorised preview cannot select a private Microsoft configuration',()=>{
 const before=process.env.MEETING_MINUTES_AGENT_GENERATOR;delete process.env.MEETING_MINUTES_AGENT_GENERATOR;
 try {
 assert.equal(P.chooseProvider({body:{},authUser:{role:'admin'}}),'legacy');
 assert.throws(()=>P.chooseProvider({body:{generationProvider:P.PROVIDER},authUser:{role:'client'}}),e=>e.statusCode===403);
 assert.throws(()=>P.chooseProvider({body:{generationProvider:'unknown'},authUser:{role:'admin'}}),e=>e.statusCode===400);
 }finally{if(before===undefined)delete process.env.MEETING_MINUTES_AGENT_GENERATOR;else process.env.MEETING_MINUTES_AGENT_GENERATOR=before;}
});
