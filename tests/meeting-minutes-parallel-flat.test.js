'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),JSZip=require('jszip');
const E=require('../utils/meetingMinutesParallelEngine'),P=require('../utils/meetingMinutesParallel');
const evidence=[{id:'T0001',speaker:'Alex',timestamp:'1:00',text:'Proceed, but not this week.'}];
const item={id:'DI1',text:'The approach was accepted, but must not start this week.',evidenceIds:['T0001']};
const flat=()=>({schemaVersion:1,specialist:'discussion',items:[structuredClone(item)],reviewFlags:[{kind:'uncertain_fact',message:'Check the source qualification.',evidenceIds:['T0001']}]});
test('flat discussion integrates without rewriting, categorising or mutating the provider reply',async()=>{
 const raw=flat(),snapshot=structuredClone(raw),calls=[];
 const config=Object.fromEntries(E.STAGES.map(stage=>[stage,{webhookUrl:'https://'+stage+'.invalid'}]));
 const result=await E.runSpecialists({schemaVersion:1,meetingDetails:{},evidence},config,{fetchImpl:async(url,init)=>{
  const stage=new URL(url).hostname.split('.')[0];calls.push({stage,prompt:JSON.parse(init.body).prompt});
  const reply=stage==='discussion'?raw:stage==='summary'?{schemaVersion:1,specialist:'summary',executiveSummary:{text:'',evidenceIds:[]},meetingObjectives:[],reviewFlags:[]}:{schemaVersion:1,specialist:'actions',actions:[],actionProposals:[],reviewFlags:[]};
  return {ok:true,text:async()=>JSON.stringify(reply)};
 }});
 assert.equal(result.status,'completed');assert.equal(calls.length,3);assert.equal(new Set(calls.map(x=>x.prompt)).size,1);
 assert.deepEqual(result.branches.discussion.result,snapshot);assert.deepEqual(raw,snapshot);
 const [container]=result.minutes.discussion;
 assert.equal(container.hideHeading,true);assert.deepEqual(container.points,[item]);assert.deepEqual(container.decisions,[]);assert.deepEqual(container.openQuestions,[]);
 assert.equal(result.minutes.reviewFlags[0].specialist,'discussion');
 const changes=P.resultChanges({qualityState:{},reviewFlags:[]},result);
 const draft={generationProvider:P.PROVIDER,details:{},sourceUnits:evidence,...changes};
 assert.deepEqual(P.publication(draft).discussion,result.minutes.discussion);
 assert.deepEqual(P.reviewChanges(draft,{discussion:changes.discussion}).discussion,changes.discussion);
 const zip=await JSZip.loadAsync(await require('../utils/meetingMinutesAgentDocx').generateMeetingMinutesAgentDocx(draft,true));
 const xml=await zip.file('word/document.xml').async('string');assert(xml.includes(item.text));assert(!xml.includes('Open question —'));assert(!xml.includes('<w:t>Discussion</w:t>'));
});
test('flat contract rejects mixed shapes, invented references, missing text and repeated IDs',()=>{
 const invalid=[r=>r.discussion=[],r=>r.items[0].evidenceIds=['unknown'],r=>r.items[0].text='',r=>r.items.push(structuredClone(r.items[0])),r=>r.items[0].topic='Invented heading',r=>r.items=null];
 for(const mutate of invalid){const r=flat();mutate(r);assert.throws(()=>E.validateResult('discussion',r,evidence));}
 assert.deepEqual(E.discussionForMinutes(E.validateResult('discussion',{...flat(),items:[]},evidence)),[]);
});
test('existing grouped discussion remains exactly compatible',()=>{
 const grouped={schemaVersion:1,specialist:'discussion',discussion:[{id:'TOP1',topic:'Existing',points:[item],decisions:[],openQuestions:[]}],reviewFlags:[]};
 assert.equal(E.discussionForMinutes(E.validateResult('discussion',grouped,evidence)),grouped.discussion);
});

test('configuration selects the verified flat instruction file only for the explicit flat format',()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'flat-config-')),filename=path.join(dir,'config.json');
 const prior=process.env.MEETING_MINUTES_PARALLEL_CONFIG;
 try {
  const config=Object.fromEntries(E.STAGES.map(stage=>[stage,{published:true,webhookUrl:'https://'+stage+'.invalid',instructionsSha256:E.hash(fs.readFileSync(path.join(__dirname,'../config/meeting-minutes-parallel',stage+'.txt'),'utf8'))}]));
  process.env.MEETING_MINUTES_PARALLEL_CONFIG=filename;
  fs.writeFileSync(filename,JSON.stringify(config));assert.deepEqual(P.configuration(),config);
  config.discussion.format='flat-v1';config.discussion.instructionsSha256=E.hash(fs.readFileSync(path.join(__dirname,'../config/meeting-minutes-parallel/discussion-flat.txt'),'utf8'));
  fs.writeFileSync(filename,JSON.stringify(config));assert.deepEqual(P.configuration(),config);
  config.discussion.instructionsSha256='unverified';fs.writeFileSync(filename,JSON.stringify(config));assert.throws(()=>P.configuration(),/not been verified/);
 }finally{if(prior===undefined)delete process.env.MEETING_MINUTES_PARALLEL_CONFIG;else process.env.MEETING_MINUTES_PARALLEL_CONFIG=prior;fs.rmSync(dir,{recursive:true});}
});
