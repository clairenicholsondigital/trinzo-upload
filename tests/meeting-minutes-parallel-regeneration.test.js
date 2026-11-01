'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const P=require('../utils/meetingMinutesParallel'),db=require('../utils/db');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'parallel-regeneration-'));
const config=Object.fromEntries(['summary','discussion','actions'].map(stage=>[stage,{
 published:true,webhookUrl:'https://'+stage+'.example.invalid',
 instructionsSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,'../config/meeting-minutes-parallel',stage+'.txt'))).digest('hex')
}]));
fs.writeFileSync(path.join(temp,'configuration.json'),JSON.stringify(config));
process.env.MEETING_MINUTES_PARALLEL_CONFIG=path.join(temp,'configuration.json');
const drafts=new Map();let creates=0,updates=0,progressUpdates=0,calls=0;
db.getMeetingMinutesAgentDraft=async(id,user)=>user==='owner'?structuredClone(drafts.get(id)||null):null;
db.createMeetingMinutesAgentDraft=async input=>{
 creates++;const draft={...input.payload,draftId:'18',revision:1,status:'draft',title:input.title,fileName:input.fileName,rawTranscript:input.rawTranscript};
 drafts.set('18',draft);return structuredClone(draft);
};
db.updateMeetingMinutesAgentDraft=async(id,user,revision,change)=>{
 const current=drafts.get(id);assert.equal(user,'owner');
 if(current.revision!==revision)throw Object.assign(Error('Conflict'),{statusCode:409});
 const draft={...change.payload,draftId:id,revision:revision+1,status:change.status,title:change.title,rawTranscript:current.rawTranscript};
 drafts.set(id,draft);updates++;if(change.payload.generation?.progress)progressUpdates++;return structuredClone(draft);
};
const priorFetch=global.fetch;
global.fetch=async url=>{
 calls++;const stage=new URL(url).hostname.split('.')[0];await new Promise(r=>setTimeout(r,50));
 const result={schemaVersion:1,specialist:stage,reviewFlags:[],...(stage==='summary'?{
 executiveSummary:{text:'A new summary.',evidenceIds:['T1']},meetingObjectives:[]}:
 stage==='discussion'?{discussion:[]}:{actions:[],actionProposals:[]})};
 return {ok:true,text:async()=>JSON.stringify(result)};
};
const router=require('../routes/api');
test.after(()=>{global.fetch=priorFetch;fs.rmSync(temp,{recursive:true,force:true});});
async function request(){
 const route=router.stack.find(l=>l.route?.path==='/meeting-minutes-agent/drafts/:draftId/generate-background')?.route;
 const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
 await route.stack.at(-1).handle({params:{draftId:'17'},authUser:{userId:'owner'},body:{revision:1,stage:'actions'}},res);return res;
}
test('concurrent regeneration requests create one new version and keep the old draft and its edits unchanged',async()=>{
 const old={generationProvider:P.PROVIDER,draftId:'17',revision:1,status:'draft',rawTranscript:'Alex: Review this.',
 details:{meetingTitle:'Review',internalAttendees:[],clientAttendees:[]},sourceUnits:[{id:'T1',text:'Review this.',speaker:'Alex',timestamp:'',classification:'keep'}],
 discussion:[],actions:[{id:'manual-action-1',action:'Reviewer-owned correction',owners:['Alex'],timing:{kind:'target',wording:'only after approval',exactDate:''},evidenceIds:['T1']}],
 executiveSummary:'Reviewer summary.',meetingObjectives:[],reviewFlags:[],currentStep:5,selectedStep:3,
 qualityState:{parallel:{completedAt:'2026-10-28T12:00:00Z'}},changeHistory:[{id:'history',label:'Previous decision'}]};
 drafts.set('17',structuredClone(old));
 const responses=await Promise.all([request(),request()]);
 for(const r of responses){assert.equal(r.statusCode,202,JSON.stringify(r.body));assert.equal(r.body.draft.draftId,'18');}
 for(let i=0;i<100 && !drafts.get('18').qualityState.parallel?.completedAt;i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(creates,1);assert.equal(calls,3);assert.equal(updates-progressUpdates,2,'one start and one final result save; advisory progress is separate');
 assert.ok(progressUpdates>0);
 assert.deepEqual(drafts.get('17'),old);assert.equal(drafts.get('18').executiveSummary,'A new summary.');
 assert.deepEqual(drafts.get('18').actions,[]);assert.deepEqual(drafts.get('18').sourceUnits,old.sourceUnits);
});
