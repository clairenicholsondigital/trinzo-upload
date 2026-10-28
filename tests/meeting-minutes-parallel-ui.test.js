'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),express=require('express'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
test('the editor adopts all three parallel results, keeps proposals separate and does not expose legacy AI phases',async t=>{
 const app=express();app.use(express.json());let polls=0;const errors=[],unexpected=[];
 const common={generationProvider:'parallel-specialists-v1',draftId:'parallel-ui',revision:1,payloadVersion:5,status:'draft',
 details:{meetingTitle:'Parallel review',meetingDate:'2026-10-28',meetingLocation:'Microsoft Teams',internalAttendees:['Alex'],clientAttendees:[]},
 sourceUnits:[{id:'T1',speaker:'Alex',timestamp:'',text:'Review the file only after approval.'}],
 discussion:[],actions:[],meetingObjectives:[],executiveSummary:'',reviewFlags:[],staleStages:[],currentStep:0,selectedStep:0,
 unassignedSupportingDetails:[],removedActions:[],changeHistoryCount:0,
 generation:{stage:'discussion',status:'running',startedAt:new Date().toISOString(),message:'Preparing your meeting minutes…'}};
 const ready={...common,revision:3,currentStep:5,generation:null,
 discussion:[{id:'TOP1',topic:'File review',points:[{id:'P1',text:'Approval is a prerequisite.',evidenceIds:['T1']}],decisions:[],openQuestions:[]}],
 actions:[{id:'A1',action:'Review the file.',owners:['Alex'],timing:{kind:'dependency',wording:'only after approval',exactDate:''},evidenceIds:['T1']}],
 executiveSummary:'The file review depends on approval.',executiveSummaryEvidenceIds:['T1'],
 meetingObjectives:[{id:'O1',text:'Review the file.',evidenceIds:['T1']}],
 parallelActionProposals:[{id:'AP1',status:'open',action:'Prepare another review.',owners:[],timing:{kind:'not_stated',wording:'',exactDate:''},reason:'Not accepted.',evidenceIds:['T1']}],
 generatedStages:{discussion:'2026-10-28T12:00:00Z',actions:'2026-10-28T12:00:00Z',summary:'2026-10-28T12:00:00Z'}};
 app.get('/meeting-minutes-agent',(_,res)=>res.type('html').send(fs.readFileSync(path.join(root,'views/meeting-minutes-agent.html'),'utf8')));
 app.get('/static/trinzo.js',(_,res)=>res.type('application/javascript').send(''));
 app.get('/static/meeting-minutes-timing.js',(_,res)=>res.type('application/javascript').send(fs.readFileSync(path.join(root,'utils/meetingMinutesTiming.js'),'utf8')));
 app.use('/static',express.static(path.join(root,'public'),{dotfiles:'allow'}));
 app.get('/api/meeting-minutes-agent/drafts/parallel-ui',(_,res)=>res.json({ok:true,draft:common}));
 app.get('/api/meeting-minutes-agent/drafts/parallel-ui/generation',(_,res)=>{
  polls++;res.json({ok:true,generation:polls<2?common.generation:null,draft:polls<2?common:ready});
 });
 app.patch('/api/meeting-minutes-agent/drafts/parallel-ui',(req,res)=>res.json({ok:true,draft:{...ready,...req.body,revision:4}}));
 app.use((req,res)=>{if(req.method!=='GET')unexpected.push(req.path);res.status(404).json({error:'Unexpected request'});});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));});
 const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
 await page.goto('http://127.0.0.1:'+server.address().port+'/meeting-minutes-agent?draftId=parallel-ui');
 await page.waitForSelector('#generationProgress:not([hidden])');
 assert.equal(await page.locator('#generationPhases li').count(),1);
 assert.match(await page.locator('#generationPhases').innerText(),/summary, discussion and actions together/);
 assert.ok(!/referee|Verify against transcript/.test(await page.locator('#generationPhases').innerText()));
 await page.waitForFunction(()=>document.querySelector('#executiveSummary')?.value==='The file review depends on approval.');
 assert.equal(await page.locator('[data-action]').count(),1);
 assert.equal(await page.locator('[data-parallel-proposal]').count(),2);
 assert.equal(await page.locator('#discussionInstruction').evaluate(e=>e.closest('details').hidden),true);
 assert.equal(await page.locator('#actionsInstruction').evaluate(e=>e.closest('details').hidden),true);
 assert.equal(await page.locator('#generationMethod').isVisible(),true);
 await page.locator('[data-step="2"]').click();
 await page.locator('[data-record-field]').first().fill('Reviewer clarification.');
 await page.waitForFunction(()=>document.querySelector('#saveStatus')?.dataset.state==='saved');
 assert.equal(await page.locator('#staleNotice').isVisible(),false);
 await page.locator('[data-step="3"]').click();
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.locator('#generationMethod').isVisible(),true);
 const box=await page.locator('.parallel-proposal-row [data-label="Action"]').boundingBox();
 assert.ok(box.width>250,'suggestion text uses the full mobile card width');
 assert.equal(await page.locator('.parallel-proposal-row [data-label="Owners"]').isVisible(),true);
 assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
});
