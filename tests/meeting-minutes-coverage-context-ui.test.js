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
 const app=express();app.use(express.json({limit:'4mb'}));app.get('/meeting-minutes-agent',(_,res)=>res.type('html').send(fs.readFileSync(root+'/views/meeting-minutes-agent.html','utf8')));app.get('/static/meeting-minutes-timing.js',(_,res)=>res.type('js').send(fs.readFileSync(root+'/utils/meetingMinutesTiming.js','utf8')));app.get('/static/meeting-minutes-agent.js',(_,res)=>res.type('js').send(fs.readFileSync(process.env.TRINZO_COVERAGE_FRONTEND_SOURCE||root+'/public/meeting-minutes-agent.js','utf8')));app.use('/static',express.static(root+'/public'));
 app.get('/api/meeting-minutes-agent/drafts/:draftId/generation',(_,res)=>res.json({ok:true,generation:null}));
 async function call(method,suffix,req,res){const route=router.stack.find(l=>l.route?.path==='/meeting-minutes-agent/drafts/:draftId'+suffix&&l.route.methods[method]).route;if(method==='patch')patches.push(clone(req.body));req.authUser={userId:'review-workflow'};await route.stack.at(-1).handle(req,res);}
 app.get('/api/meeting-minutes-agent/drafts/:draftId',(req,res)=>call('get','',req,res));app.patch('/api/meeting-minutes-agent/drafts/:draftId',(req,res)=>call('patch','',req,res));for(const op of ['undo','redo'])app.post('/api/meeting-minutes-agent/drafts/:draftId/'+op,(req,res)=>call('post','/'+op,req,res));
 app.use((_,res)=>res.status(404).json({error:'Unexpected fixture request'}));const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),context=await browser.newContext({viewport:mobile?{width:375,height:812}:{width:1280,height:900}}),page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));t.after(async()=>{await context.close();await new Promise(resolve=>server.close(resolve));});await page.goto('http://127.0.0.1:'+server.address().port+'/meeting-minutes-agent?draftId=review-ui');await page.waitForFunction(()=>document.querySelector('#saveStatus')?.dataset.state==='saved');return page;}
const settle=page=>page.waitForFunction(()=>document.querySelector('#saveStatus')?.dataset.state==='saved');
async function openOptional(page){await page.locator('#omittedDetailsPanel').evaluate(n=>n.open=true);await page.locator('[data-identical-filing-group]>details').evaluateAll(nodes=>nodes.forEach(n=>n.open=true));}

async function openCard(page,id){const card=page.locator('[data-review-flag-id="'+id+'"]');await card.evaluate(n=>{for(let p=n.parentElement;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;});return card;}
function coverage(d){
 function clear(value){if(!value||typeof value!=='object')return;if(Array.isArray(value.reviewFlagIds))value.reviewFlagIds=[];Object.values(value).forEach(v=>{if(Array.isArray(v))v.forEach(clear);});}
 clear(d);d.unassignedSupportingDetails=[];
 d.reviewFlags=[{id:'action-materialization-fixture',kind:'possible_missed_follow_up',reviewDisposition:'coverage_unresolved',status:'open',correctionNote:'',message:'The agent could not establish complete action coverage. Some work may already be present.',evidenceIds:['T0001']}];
}
for(const mobile of [false,true])test('coverage notice gives neutral guidance and read-only source links (mobile='+mobile+')',async t=>{
 const page=await fixture(t,d=>{coverage(d);d.actions.push({...clone(d.actions[0]),id:'separate',occurrenceId:'separate-occurrence',action:'Review the equipment report independently.'});},mobile),before=clone(saved);
 await page.locator('#reviewQueueToggle').click();
 const card=await openCard(page,'action-materialization-fixture');
 assert.ok(!(await card.innerText()).includes('not currently represented'));
 assert.ok(!(await card.innerText()).includes('Nothing in the current minutes'));
 assert.match(await card.innerText(),/Coverage is uncertain/);
 const related=card.locator('[data-coverage-related-actions]');assert.equal(await related.count(),1);
 await related.locator('summary').click();assert.equal(await related.locator('[data-view-coverage-action]').count(),2);
 assert.match(await related.innerText(),/do not establish that the work is covered/);assert.equal(await card.locator('[data-view-flag-target]').count(),0);
 await related.locator('[data-view-coverage-action]').last().click();
 await page.waitForFunction(()=>document.querySelector('.flag-target-highlight'));
 await settle(page);assert.deepEqual(saved.actions,before.actions);assert.deepEqual(saved.reviewFlags,before.reviewFlags);
 assert.deepEqual(saved.sourceUnits,before.sourceUnits);assert.deepEqual(errors,[]);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
});
test('coverage checks with no drafted match stay neutral and open',async t=>{
 const page=await fixture(t,d=>{coverage(d);d.actions=[];});await page.locator('#reviewQueueToggle').click();
 const card=await openCard(page,'action-materialization-fixture');
 assert.equal(await card.locator('[data-coverage-related-actions]').count(),0);
 assert.match(await card.innerText(),/Coverage is uncertain/);assert.equal(saved.reviewFlags[0].status,'open');
});
test('unrelated sources and ordinary missing-work notices get no coverage comparison links',async t=>{
 const page=await fixture(t,d=>{coverage(d);d.sourceUnits.push({id:'T0002',speaker:'Nora Patel',text:'I will review a separate certificate.'});d.actions[0].evidenceIds=['T0002'];d.reviewFlags.push({...clone(d.reviewFlags[0]),id:'ordinary',reviewDisposition:undefined});});
 await page.locator('#reviewQueueToggle').click();assert.equal(await page.locator('[data-coverage-related-actions]').count(),0);
 assert.match(await (await openCard(page,'ordinary')).innerText(),/not currently represented/);
});
test('all group source anchors survive owned load, save and reload',async t=>{
 const page=await fixture(t,d=>{coverage(d);d.sourceUnits=Array.from({length:12},(_,i)=>({id:'T'+String(i+1).padStart(4,'0'),speaker:'Nora Patel',text:'Distinct source passage number '+(i+1)+'.'}));const ids=d.sourceUnits.map(u=>u.id),candidateId='saved-group';d.reviewFlags[0].id='action-materialization-'+require('crypto').createHash('sha256').update(candidateId).digest('hex').slice(0,20);d.reviewFlags[0].evidenceIds=ids.slice(0,8);d.candidateLedger=[{candidateId,recordType:'action_chain',evidenceIds:ids}];d.qualityState.actions={refereeMaterialization:{unresolved:[{candidateId,recordType:'action_chain',reason:'group_requires_atomic_action_mapping',evidenceIds:ids}]}};});
 await page.locator('#reviewQueueToggle').click();const card=await openCard(page,saved.reviewFlags[0].id);
 await card.locator('.review-evidence>summary').click();assert.match(await card.innerText(),/Distinct source passage number 12/);
 await card.getByRole('button',{name:'Mark checked',exact:true}).click();await settle(page);assert.equal(saved.reviewFlags[0].evidenceIds.length,12);
 await page.reload();await settle(page);assert.equal(saved.reviewFlags[0].evidenceIds.length,12);
});

test('comparison labels are escaped and two separate actions remain separate',async t=>{
 const page=await fixture(t,d=>{coverage(d);d.actions[0].action='Share <img id="unsafe-coverage" src=x onerror="window.coverageUnsafe=true"> with the team.';d.actions.push({...clone(d.actions[0]),id:'other',occurrenceId:'other-occurrence',action:'Review the report separately.'});});
 await page.locator('#reviewQueueToggle').click();const card=await openCard(page,'action-materialization-fixture');
 await card.locator('[data-coverage-related-actions]>summary').click();assert.equal(await card.locator('[data-coverage-related-actions] li').count(),2);
 assert.equal(await page.locator('#unsafe-coverage').count(),0);assert.equal(await page.evaluate(()=>Boolean(window.coverageUnsafe)),false);assert.equal(saved.actions.length,2);assert.equal(saved.reviewFlags[0].status,'open');
});

test('unbound timed-step coverage also stays uncertain instead of claiming missing work',async t=>{
 const page=await fixture(t,d=>{coverage(d);d.reviewFlags[0].id='timed-step';delete d.reviewFlags[0].reviewDisposition;d.reviewFlags[0].temporalField='timedStepCoverage';});
 await page.locator('#reviewQueueToggle').click();const card=await openCard(page,'timed-step');assert.match(await card.innerText(),/Coverage is uncertain/);assert.ok(!(await card.innerText()).includes('not currently represented'));
 assert.equal(saved.reviewFlags[0].status,'open');
});
