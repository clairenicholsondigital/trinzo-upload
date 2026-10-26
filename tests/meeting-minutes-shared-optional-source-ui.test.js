'use strict';
process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1='0';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),express=require('express'),{chromium}=require('playwright');
const V=require('../utils/meetingMinutesAgentV2'),db=require('../utils/db'),base=require('./helpers/meeting-minutes-review-browser').draft,root=path.resolve(__dirname,'..'),clone=x=>structuredClone(x);
let saved,patches,errors,browser;
const get=db.getMeetingMinutesAgentDraft,update=db.updateMeetingMinutesAgentDraft;
db.getMeetingMinutesAgentDraft=async()=>clone(saved);db.updateMeetingMinutesAgentDraft=async(id,user,revision,change)=>{assert.equal(revision,saved.revision);saved={...clone(change.payload),draftId:id,revision:revision+1,status:change.status||'draft'};return clone(saved);};
const router=require('../routes/api');db.getMeetingMinutesAgentDraft=get;db.updateMeetingMinutesAgentDraft=update;
test.before(async()=>{browser=await chromium.launch({headless:true});});test.after(async()=>browser?.close());
async function fixture(t,mutate=()=>{},mobile=false){saved=base();saved.payloadVersion=5;saved.qualityState={preparation:{dateContext:{source:'reviewer',meetingDate:saved.details.meetingDate}}};saved.sourceUnits=V.normaliseSourceUnits(saved.sourceUnits);saved.sourceUnits[0].text+=' I will circulate the equipment report.';saved.reviewFlags[2].message='Cannot verify which independent retained occurrence this refers to.';mutate(saved);patches=[];errors=[];
 const app=express();app.use(express.json({limit:'4mb'}));app.get('/meeting-minutes-agent',(_,res)=>res.type('html').send(fs.readFileSync(root+'/views/meeting-minutes-agent.html','utf8')));app.get('/static/meeting-minutes-timing.js',(_,res)=>res.type('js').send(fs.readFileSync(root+'/utils/meetingMinutesTiming.js','utf8')));app.use('/static',express.static(root+'/public'));
 app.get('/api/meeting-minutes-agent/drafts/:draftId/generation',(_,res)=>res.json({ok:true,generation:null}));
 async function call(method,suffix,req,res){const route=router.stack.find(l=>l.route?.path==='/meeting-minutes-agent/drafts/:draftId'+suffix&&l.route.methods[method]).route;if(method==='patch')patches.push(clone(req.body));req.authUser={userId:'review-workflow'};await route.stack.at(-1).handle(req,res);}
 app.get('/api/meeting-minutes-agent/drafts/:draftId',(req,res)=>call('get','',req,res));app.patch('/api/meeting-minutes-agent/drafts/:draftId',(req,res)=>call('patch','',req,res));for(const op of ['undo','redo'])app.post('/api/meeting-minutes-agent/drafts/:draftId/'+op,(req,res)=>call('post','/'+op,req,res));
 app.use((_,res)=>res.status(404).json({error:'Unexpected fixture request'}));const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),context=await browser.newContext({viewport:mobile?{width:375,height:812}:{width:1280,height:900}}),page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));t.after(async()=>{await context.close();await new Promise(resolve=>server.close(resolve));});await page.goto('http://127.0.0.1:'+server.address().port+'/meeting-minutes-agent?draftId=review-ui');await page.waitForFunction(()=>document.querySelector('#saveStatus')?.dataset.state==='saved');return page;}
const settle=page=>page.waitForFunction(()=>document.querySelector('#saveStatus')?.dataset.state==='saved');

function sharedChecks(d){
 d.reviewFlags=[{id:'addition-a',kind:'possible_missed_follow_up',status:'open',correctionNote:'',message:'Check whether the equipment report needs reviewing.',evidenceIds:['T0001'],reviewDisposition:'not_applied_addition'},
 {id:'addition-b',kind:'possible_missed_follow_up',status:'open',correctionNote:'',message:'Check whether the equipment report needs circulating after approval.',evidenceIds:['T0001'],reviewDisposition:'not_applied_addition'}];
 d.unassignedSupportingDetails=[];d.actions.forEach(a=>a.reviewFlagIds=[]);d.discussion.forEach(t=>['points','decisions','openQuestions'].forEach(k=>(t[k]||[]).forEach(r=>r.reviewFlagIds=[])));
 // Start from the same canonical saved/public shape the UI receives. The base
 // fixture contains orphaned supporting warnings unrelated to these checks.
 Object.assign(d,router.stagedEvaluation.publicMeetingAgentDraft({...d,...router.stagedEvaluation.meetingAgentDraftPayload(d)}));
 d.discussion.forEach(t=>['points','decisions','openQuestions'].forEach(k=>(t[k]||[]).forEach(r=>(r.supportingDetails||[]).forEach(detail=>{
  if (!detail.reviewFlagIds?.length) delete detail.reviewFlagIds;
  if (!detail.supportingDetails?.length) delete detail.supportingDetails;
 }))));
}
function sharedTargetChecks(d){
 d.unassignedSupportingDetails=[];
 d.actions[0].reviewFlagIds=['timing-a','timing-b'];
 d.reviewFlags=[
  {id:'timing-a',kind:'timing',status:'open',correctionNote:'',message:'The source does not establish whether this timing belongs to the action; the timing is retained for review.',evidenceIds:['T0001']},
  {id:'timing-b',kind:'timing',status:'open',correctionNote:'',message:'The source does not establish whether the retained timing belongs to the action owner.',evidenceIds:['T0001']}
 ];
 d.discussion.forEach(t=>['points','decisions','openQuestions'].forEach(k=>(t[k]||[]).forEach(r=>r.reviewFlagIds=[])));
}
async function openChecks(page){await page.locator('#reviewQueueToggle').click();await page.locator('[data-review-category="optional"]>summary').click();}
for(const mobile of [false,true])test('shared source is read once while both decisions and honest counts survive save/reload/undo/redo (mobile='+mobile+')',async t=>{
 const page=await fixture(t,sharedChecks,mobile),before=clone(saved);await openChecks(page);
 const panel=page.locator('[data-review-category="optional"]'),group=page.locator('[data-shared-optional-source]');
 assert.match(await panel.locator(':scope>summary').innerText(),/2 items, 2 checks/);
 assert.equal(await group.locator('blockquote').count(),1);assert.equal(await group.locator('[data-shared-source-evidence]').count(),1);
 assert.equal(await group.locator('.review-queue-item').count(),2);assert.equal(await group.locator('[data-flag-status="confirmed"]').count(),2);
 assert.equal(await page.locator('[data-confirm-identical-flags]').count(),0);
 assert.match(await group.innerText(),/independent checks share this source/);
 assert.match(await group.textContent(),/report needs reviewing/);assert.match(await group.textContent(),/circulating after approval/);
 await group.locator('[data-shared-source-evidence]>summary').click();assert.match(await group.innerText(),/circulate the equipment report/);
 const response=page.waitForResponse(r=>r.request().method()==='PATCH');await group.locator('[data-flag-index="0"][data-flag-status="confirmed"]').click();await response;await settle(page);
 assert.equal(saved.reviewFlags[0].status,'confirmed');assert.equal(saved.reviewFlags[1].status,'open');assert.equal(await page.locator('[data-shared-optional-source]').count(),0);
 assert.equal(await panel.locator('blockquote').count(),1);assert.match(await panel.locator(':scope>summary').innerText(),/1 item, 1 check/);
 await page.reload();await settle(page);assert.equal(saved.reviewFlags[1].status,'open');
 await page.locator('#undoLastDecision').click();await page.waitForFunction(()=>document.querySelector('[data-shared-optional-source]'));assert.ok(saved.reviewFlags.every(f=>f.status==='open'));
 await page.locator('#redoLastDecision').click();await page.waitForFunction(()=>!document.querySelector('[data-shared-optional-source]'));
 assert.equal(saved.reviewFlags[1].status,'open');assert.deepEqual(saved.actions,before.actions);assert.deepEqual(router.stagedEvaluation.meetingAgentPublicationContent(saved).discussion,router.stagedEvaluation.meetingAgentPublicationContent(before).discussion);assert.deepEqual(saved.sourceUnits,before.sourceUnits);
 assert.deepEqual(saved.reviewFlags.map(f=>f.evidenceIds),before.reviewFlags.map(f=>f.evidenceIds));assert.deepEqual(errors,[]);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
});
for(const [name,mutate]of [
 ['partial source overlap',d=>d.reviewFlags[1].evidenceIds=['T0001','T0002']],
 ['missing source',d=>d.reviewFlags.forEach(f=>f.evidenceIds=['absent'])],
 ['ambiguous source ID',d=>d.sourceUnits.push(clone(d.sourceUnits[0]))],
 ['reviewer authored',d=>d.reviewFlags[1].reviewerAuthored=true],
 ['existing reviewer note',d=>d.reviewFlags[1].correctionNote='Keep these separate'],
 ['coverage category',d=>d.reviewFlags[1].reviewDisposition='coverage_unresolved'],
 ['explicit action link',d=>d.actions[0].reviewFlagIds=['addition-b']]
])test(name+' cannot share an optional-source group',async t=>{
 const page=await fixture(t,d=>{sharedChecks(d);mutate(d);});await page.locator('#reviewQueueToggle').click();
 assert.equal(await page.locator('[data-shared-optional-source]').count(),0);assert.equal(await page.locator('#flagList .review-queue-item').count(),2);assert.equal(await page.locator('[data-confirm-identical-flags]').count(),0);assert.deepEqual(errors,[]);
});
test('each shared-source check keeps its own editable review note',async t=>{
 const page=await fixture(t,sharedChecks);await openChecks(page);const group=page.locator('[data-shared-optional-source]');
 await group.locator('[data-flag-correction="1"]').evaluate(n=>n.closest('details').open=true);
 await group.locator('[data-flag-correction="1"]').fill('The circulation condition must remain.');
 const response=page.waitForResponse(r=>r.request().method()==='PATCH');await group.locator('[data-flag-index="1"][data-flag-status="corrected"]').click();await response;await settle(page);
 assert.equal(saved.reviewFlags[0].status,'open');assert.equal(saved.reviewFlags[0].correctionNote,'');assert.equal(saved.reviewFlags[1].status,'corrected');assert.equal(saved.reviewFlags[1].correctionNote,'The circulation condition must remain.');assert.deepEqual(errors,[]);
});
for(const mobile of [false,true])test('uniform-source action checks share evidence without sharing decisions (mobile='+mobile+')',async t=>{
 const page=await fixture(t,sharedTargetChecks,mobile);await page.locator('#reviewQueueToggle').click();
 const group=page.locator('[data-shared-source]');
 assert.equal(await group.count(),1);assert.equal(await group.locator('[data-shared-optional-source]').count(),0);
 assert.equal(await group.locator('blockquote').count(),1);assert.equal(await group.locator('[data-shared-source-evidence]').count(),1);
 assert.equal(await group.locator('.review-queue-item').count(),2);
 assert.equal(await group.locator('[data-flag-status="confirmed"]').count(),2);
 assert.match(await group.innerText(),/independent checks share this source/);assert.deepEqual(errors,[]);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
});
test('legacy summary timing wording is corrected only in the display',async t=>{
 const page=await fixture(t,d=>{
  d.discussion.forEach(topic=>['points','decisions','openQuestions'].forEach(kind=>(topic[kind]||[]).forEach(row=>row.reviewFlagIds=[])));
  d.actions.forEach(action=>action.reviewFlagIds=[]);d.unassignedSupportingDetails=[];
  d.reviewFlags=[{id:'summary-timing',kind:'timing',temporalField:'executiveSummary',status:'open',correctionNote:'',message:'Cannot verify the timing in the executive summary: "The review is due next week." temporal source binding not proved. Confirm it against the approved minutes.',evidenceIds:['T0001']}];
 });
 await page.locator('#reviewQueueToggle').click();
 assert.match(await page.locator('#flagList').innerText(),/Summary timing to check/);
 assert.doesNotMatch(await page.locator('#flagList').innerText(),/approved minutes/);
 await page.locator('.flag-review-reason>summary').click();
 assert.match(await page.locator('#flagList').innerText(),/current Discussion and Actions/);
 assert.match(saved.reviewFlags[0].message,/approved minutes/);
 assert.deepEqual(errors,[]);
});
