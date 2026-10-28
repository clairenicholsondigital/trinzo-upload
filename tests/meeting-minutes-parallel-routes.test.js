'use strict';
process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1='0';
const test=require('node:test'),assert=require('node:assert/strict'),JSZip=require('jszip');
const P=require('../utils/meetingMinutesParallel'),db=require('../utils/db');
let saved,writes;const archive=new Map();
db.getMeetingMinutesAgentDraft=async(id,user)=>user!=='owner'?null:id===saved.draftId?structuredClone(saved):structuredClone(archive.get(id)||null);
db.createMeetingMinutesAgentDraft=async input=>{archive.set(saved.draftId,structuredClone(saved));saved={...structuredClone(input.payload),draftId:'18',revision:1,status:'draft',title:input.title,fileName:input.fileName,rawTranscript:input.rawTranscript};return structuredClone(saved);};
db.updateMeetingMinutesAgentDraft=async(id,user,rev,change)=>{
 if(user!=='owner')throw Error('Wrong owner');
 if(rev!==saved.revision)throw Object.assign(Error('Conflict'),{statusCode:409});
 saved={...structuredClone(change.payload),draftId:id,revision:rev+1,status:change.status,title:change.title};writes++;
 return structuredClone(saved);
};
const router=require('../routes/api'),A=router.stagedEvaluation;
function reset(){
 archive.clear();
 saved={generationProvider:P.PROVIDER,draftId:'17',revision:1,status:'draft',payloadVersion:5,
 details:{meetingTitle:'Review',meetingDate:'2026-10-28',meetingLocation:'Microsoft Teams',internalAttendees:['Alex'],clientAttendees:[]},
 sourceUnits:[{id:'T0001',speaker:'Alex',timestamp:'0:01',classification:'keep',text:'We hope for Tuesday, and the later technical additions have no stated date.'}],
 discussion:[{id:'TOP1',topic:'Summary of individual action assignments',points:[{id:'P1',text:'The review runs from 27th through to 7th August.',evidenceIds:['T0001']}],decisions:[],openQuestions:[]}],
 actions:[{id:'A1',action:'Review the file.',owners:['Alex'],timing:{kind:'target',wording:'hoping for Tuesday',exactDate:''},evidenceIds:['T0001']}],
 executiveSummary:'Review scope.',meetingObjectives:[],reviewFlags:[{id:'F1',kind:'timing',status:'open',message:'Check the hopeful target.',evidenceIds:['T0001']}],
 qualityState:{summary:{completedAt:'2026-10-28T12:00:00Z'},parallel:{privatePacket:'do not expose'}},
 parallelActionProposals:[{id:'AP1',action:'Add technical considerations.',owners:[],timing:{kind:'not_stated',wording:'',exactDate:''},evidenceIds:['T0001'],reason:'No owner was established.',status:'open'}],
 changeHistory:[],redoHistory:[],staleStages:[],currentStep:5,selectedStep:2,unassignedSupportingDetails:[],removedActions:[]};writes=0;
}
async function request(method,suffix='',body={},userId='owner',params={}){
 const route=router.stack.find(l=>l.route?.path==='/meeting-minutes-agent/drafts/:draftId'+suffix&&l.route.methods[method])?.route;assert.ok(route);
 const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
 await route.stack.at(-1).handle({params:{draftId:saved.draftId,...params},authUser:{userId},body:{revision:saved.revision,...body}},res);
 return res;
}
test('parallel drafts save and reopen without legacy removal, date expansion or timing cleanup',async()=>{
 reset();const before=structuredClone(saved);let r=await request('get');assert.equal(r.statusCode,200);
 assert.deepEqual(r.body.draft.discussion,before.discussion);assert.equal(r.body.draft.qualityState,undefined);
 r=await request('patch','',{actions:r.body.draft.actions,discussion:r.body.draft.discussion,selectedStep:3});
 assert.equal(r.statusCode,200,JSON.stringify(r.body));assert.equal(writes,1);
 assert.deepEqual(saved.discussion,before.discussion);assert.deepEqual(saved.actions,before.actions);
 assert.equal(saved.generationProvider,P.PROVIDER);assert.deepEqual(saved.qualityState,before.qualityState);
 assert.deepEqual((await request('get')).body.draft.discussion,before.discussion);
});
test('edits survive save/reopen and Word/PDF adapters without inventing dates',async()=>{
 reset();const discussion=structuredClone(saved.discussion);discussion[0].points[0].text+=' if access is granted.';
 const r=await request('patch','',{discussion});assert.equal(r.statusCode,200,JSON.stringify(r.body));
 const reopened=(await request('get')).body.draft;
 const word=A.meetingAgentDraftForDocx(reopened),pdf=A.meetingAgentDraftForPdf(reopened,true);
 assert.equal(word.discussion[0].points[0].text,discussion[0].points[0].text);
 assert.equal(pdf.discussion[0].points[0],discussion[0].points[0].text);
 const zip=await JSZip.loadAsync(await require('../utils/meetingMinutesAgentDocx').generateMeetingMinutesAgentDocx(word,true));
 assert.ok((await zip.file('word/document.xml').async('string')).includes('27th through to 7th August'));
 assert.ok(pdf.evidenceAppendix.some(e=>e.id==='T0001'));
});
test('possible actions remain separate until an explicit reviewer decision, which can be undone and redone',async()=>{
 reset();const before=structuredClone(saved);
 const r=await request('post','/parallel-proposals/:proposalId',{decision:'accept'},'owner',{proposalId:'AP1'});
 assert.equal(r.statusCode,200,JSON.stringify(r.body));assert.equal(saved.actions.length,2);
 assert.equal(saved.parallelActionProposals[0].status,'accepted');assert.equal(saved.reviewFlags.length,2);
 assert.equal((await request('post','/undo')).statusCode,200);
 assert.deepEqual(saved.actions,before.actions);assert.equal(saved.parallelActionProposals[0].status,'open');
 assert.equal((await request('post','/redo')).statusCode,200);
 assert.equal(saved.actions.length,2);assert.equal(saved.parallelActionProposals[0].status,'accepted');
});
test('dismissed suggestions remain recoverable; no source or reviewer warning is dropped',async()=>{
 reset();const r=await request('post','/parallel-proposals/:proposalId',{decision:'dismiss'},'owner',{proposalId:'AP1'});
 assert.equal(r.statusCode,200);assert.equal(saved.parallelActionProposals[0].status,'dismissed');
 assert.equal(saved.actions.length,1);assert.equal(saved.reviewFlags.length,1);
 assert.equal((await request('post','/undo')).statusCode,200);assert.equal(saved.parallelActionProposals[0].status,'open');
});
test('neutral event timing saves, reopens and exports without hiding wording or deriving a date',async()=>{
 reset();const actions=structuredClone(saved.actions);
 actions[0].timing={kind:'stated',wording:'on the day; throughout',exactDate:''};
 let r=await request('patch','',{actions});assert.equal(r.statusCode,200,JSON.stringify(r.body));
 const reopened=(await request('get')).body.draft;
 assert.deepEqual(reopened.actions[0].timing,actions[0].timing);
 const word=A.meetingAgentDraftForDocx(reopened),pdf=A.meetingAgentDraftForPdf(reopened,true);
 assert.deepEqual(word.actions[0].timing,actions[0].timing);
 assert.equal(pdf.actions[0].deadline,'Timing: on the day; throughout');
 const xml=await (await JSZip.loadAsync(await require('../utils/meetingMinutesAgentDocx').generateMeetingMinutesAgentDocx(word,false))).file('word/document.xml').async('string');
 assert.ok(xml.includes('Timing: on the day; throughout'));
});
test('another owner and stale saves cannot change parallel drafts',async()=>{
 reset();assert.equal((await request('patch','',{},'other')).statusCode,404);assert.equal(writes,0);
 assert.equal((await request('patch','',{revision:0})).statusCode,409);assert.equal(writes,0);
});
test('independent discussion edits do not mark the transcript-grounded summary and actions stale',async()=>{
 reset();const discussion=structuredClone(saved.discussion);discussion[0].points[0].text+=' Reviewer clarification.';
 const r=await request('patch','',{discussion});assert.equal(r.statusCode,200);assert.deepEqual(saved.staleStages,[]);
});
