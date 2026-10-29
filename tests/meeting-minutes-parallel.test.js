'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),JSZip=require('jszip');
const P=require('../utils/meetingMinutesParallel'), E=require('../utils/meetingMinutesParallelEngine');
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
test('a partial provider response fails visibly without repair, retry or false empty completion',async()=>{
 let calls=0;
 const config=Object.fromEntries(E.STAGES.map(s=>[s,{webhookUrl:'https://'+s+'.example.invalid'}]));
 const result=await E.runSpecialists(P.packet(base()),config,{fetchImpl:async(url)=>{
  calls++;const stage=new URL(url).hostname.split('.')[0];return {ok:true,text:async()=>stage==='actions'?'invalid':JSON.stringify(replies()[stage])};
 }});
 assert.equal(calls,3);assert.equal(result.status,'partial');assert.equal(result.minutes.actions,null);
 assert.throws(()=>P.resultChanges(base(),result),/could not be generated/);
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
 const initial=base();let stored=structuredClone(initial),executions=0,saves=0;
 const runner=P.createRunner({getDraft:async()=>structuredClone(stored),saveDraft:async(d,u,c)=>{
  saves++;stored={...stored,...c,revision:stored.revision+1};return structuredClone(stored);
 },config:()=>({}),execute:async()=>{executions++;stored.details.meetingTitle='Changed while running';return (await generated()).result;}});
 await runner.start(initial,1);await runner.active.get('17');
 assert.equal(executions,1);assert.equal(stored.generation.status,'failed');assert.match(stored.generation.error,/changed during/);
 assert.equal(stored.details.meetingTitle,'Changed while running');assert.deepEqual(stored.actions,[]);
 assert.equal(stored.qualityState.parallelAttempt.result.status,'completed');
});
test('provider failures keep already saved content and never call the legacy pipeline',async()=>{
 const draft=base();draft.discussion=replies().discussion.discussion;let stored=structuredClone(draft),calls=0;
 const runner=P.createRunner({getDraft:async()=>stored,saveDraft:async(d,u,c)=>(stored={...stored,...c,revision:stored.revision+1}),
 config:()=>({}),execute:async()=>{calls++;throw Error('signed-secret-provider-url');}});
 await runner.start(draft,1);await runner.active.get('17');
 assert.equal(calls,1);assert.deepEqual(stored.discussion,draft.discussion);
 assert.equal(stored.generation.status,'failed');assert.ok(!stored.generation.error.includes('signed-secret'));
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
