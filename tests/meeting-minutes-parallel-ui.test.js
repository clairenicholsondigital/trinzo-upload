'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),express=require('express'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
function parallelUiDraft(draftId) {
 return {generationProvider:'parallel-specialists-v1',draftId,revision:1,payloadVersion:5,status:'draft',
  details:{meetingTitle:'Parallel review',meetingDate:'2026-10-28',meetingLocation:'Microsoft Teams',internalAttendees:['Alex'],clientAttendees:[]},
  sourceUnits:[{id:'T1',speaker:'Alex',timestamp:'',text:'Review the file only after approval.'}],
  discussion:[],actions:[],meetingObjectives:[],executiveSummary:'',reviewFlags:[],staleStages:[],currentStep:0,selectedStep:0,
  unassignedSupportingDetails:[],removedActions:[],changeHistoryCount:0,
  generation:{stage:'discussion',status:'running',startedAt:new Date().toISOString(),message:'Preparing your meeting minutes…'}};
}
function serveMinutesUi(app) {
 app.get('/meeting-minutes-agent',(_,res)=>res.type('html').send(fs.readFileSync(path.join(root,'views/meeting-minutes-agent.html'),'utf8')));
 app.get('/static/trinzo.js',(_,res)=>res.type('application/javascript').send(''));
 app.get('/static/meeting-minutes-timing.js',(_,res)=>res.type('application/javascript').send(fs.readFileSync(path.join(root,'utils/meetingMinutesTiming.js'),'utf8')));
 app.use('/static',express.static(path.join(root,'public'),{dotfiles:'allow'}));
}
function progressFor(draft,sections,code='validated') {
 const updatedAt=new Date().toISOString();
 return {status:'running',stage:'all',startedAt:draft.generation.startedAt,updatedAt,
  elapsedMs:1000,code,message:code==='saving'?'Saving the generated draft.':'Received sections are being checked.',
  sections:Object.fromEntries(Object.entries(sections).map(([stage,value])=>[stage,{updatedAt,...value}]))};
}
async function resumeGenerationPoll(page) {
 const response=page.waitForResponse(r=>r.url().endsWith('/generation'));
 await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
 await response;
}
test('the editor previews independent Beta sections then adopts the saved result and keeps proposals separate',async t=>{
 const app=express();app.use(express.json());const errors=[],unexpected=[],patches=[],exports=[];
 let progress=null,finished=false;
 const common=parallelUiDraft('parallel-ui');
 const ready={...common,revision:3,currentStep:5,generation:null,
 discussion:[{id:'TOP1',topic:'File review',points:[{id:'P1',text:'Approval is a prerequisite.',evidenceIds:['T1']}],decisions:[],openQuestions:[]}],
 actions:[{id:'A1',action:'Review the file.',owners:['Alex'],timing:{kind:'stated',wording:'only after approval',exactDate:''},evidenceIds:['T1']}],
 executiveSummary:'The file review depends on approval.',executiveSummaryEvidenceIds:['T1'],
 meetingObjectives:[{id:'O1',text:'Review the file.',evidenceIds:['T1']}],
 parallelActionProposals:[{id:'AP1',status:'open',action:'Prepare another review.',owners:[],timing:{kind:'not_stated',wording:'',exactDate:''},reason:'Not accepted.',evidenceIds:['T1']}],
 generatedStages:{discussion:'2026-10-28T12:00:00Z',actions:'2026-10-28T12:00:00Z',summary:'2026-10-28T12:00:00Z'}};
 serveMinutesUi(app);
 app.get('/api/meeting-minutes-agent/drafts/parallel-ui',(_,res)=>res.json({ok:true,draft:common}));
 app.get('/api/meeting-minutes-agent/drafts/parallel-ui/generation',(_,res)=>res.json(finished
  ?{ok:true,generation:null,draft:ready}:{ok:true,generation:common.generation,progress}));
 app.patch('/api/meeting-minutes-agent/drafts/parallel-ui',(req,res)=>{
  patches.push(req.body);res.json({ok:true,draft:{...ready,...req.body,revision:4}});
 });
 app.use((req,res)=>{if(req.method!=='GET')unexpected.push(req.path);res.status(404).json({error:'Unexpected request'});});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));});
 const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
 page.on('request',request=>{if(/\/export(?:\/|\?|$)/.test(new URL(request.url()).pathname))exports.push(request.url());});
 await page.goto('http://127.0.0.1:'+server.address().port+'/meeting-minutes-agent?draftId=parallel-ui');
 await page.waitForSelector('#generationProgress:not([hidden])');
 assert.equal(await page.locator('#generationPhases li').count(),3,'older responses without progress still show three Beta branches');
 const phases=await page.locator('#generationPhases').innerText();
 for(const stage of ['Summary','Discussion','Actions'])assert.match(phases,new RegExp(stage,'i'));
 assert.ok(!/referee|Verify against transcript/.test(phases));
 const sections={actions:{state:'validated',counts:{records:1,proposals:0,flags:0},preview:{actions:[{
  action:'Provisional action only.',owners:['Alex'],timing:{kind:'dependency',wording:'after approval',exactDate:''}
 }]}}};
 progress=progressFor(common,sections);await resumeGenerationPoll(page);
 await page.locator('[data-generation-section="actions"]').getByText('Provisional action only.',{exact:true}).waitFor();
 assert.equal(await page.locator('#executiveSummary').inputValue(),'');
 assert.equal(await page.locator('#actionsBody [data-action]').count(),0,'provisional rows do not become editable actions');
 const quoted='Provisional <img src=x onerror="window.previewExecuted=true"> summary.';
 sections.summary={state:'validated',counts:{records:2,flags:0},preview:{executiveSummary:quoted,meetingObjectives:[{text:'Provisional objective.'}]}};
 progress=progressFor(common,sections);await resumeGenerationPoll(page);
 await page.locator('[data-generation-section="summary"]').getByText(quoted,{exact:true}).waitFor();
 assert.match(await page.locator('[data-generation-section="actions"]').innerText(),/Provisional action only/,'a later Summary response retains the earlier Actions branch');
 assert.equal(await page.locator('#generationSections img').count(),0);
 assert.equal(await page.evaluate(()=>window.previewExecuted),undefined);
 sections.discussion={state:'validated',counts:{records:3,flags:0},preview:{discussion:[{
  topic:'Provisional topic',hideHeading:false,points:[{text:'Provisional discussion.'}],decisions:[{text:'Provisional decision.'}],openQuestions:[{text:'Provisional question?'}]
 }]}};
 progress=progressFor(common,sections,'saving');await resumeGenerationPoll(page);
 await page.locator('[data-generation-section="discussion"]').getByText('Provisional discussion.',{exact:true}).waitFor();
 for(const text of ['Provisional decision.','Provisional question?'])assert.match(await page.locator('[data-generation-section="discussion"]').innerText(),new RegExp(text.replace(/[.?]/g,'\\$&')));
 assert.equal(await page.locator('#generationSections input,#generationSections textarea,#generationSections select,#generationSections button,#generationSections [contenteditable="true"]').count(),0);
 assert.equal(await page.locator('#downloadDraft').isDisabled(),true);
 assert.equal(await page.locator('#finaliseMinutes').isVisible(),false);
 assert.ok(await page.locator('#saveMinutes').isHidden()||await page.locator('#saveMinutes').isDisabled());
 assert.ok(await page.locator('#createProjectUpdateFromMinutes').isHidden()||await page.locator('#createProjectUpdateFromMinutes').isDisabled());
 await page.locator('#downloadDraft').dispatchEvent('click');
 assert.equal(await page.locator('#executiveSummary').inputValue(),'');
 assert.equal(await page.locator('#discussionList [data-record-field]').count(),0);
 assert.equal(await page.locator('#saveStatus').getAttribute('data-state'),'generating','validated sections are not saved results');
 assert.deepEqual(patches,[]);assert.deepEqual(exports,[]);
 for(const width of [320,1280]){
  await page.setViewportSize({width,height:900});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  for(const stage of ['summary','discussion','actions']){
   const bounds=await page.locator('[data-generation-section="'+stage+'"]').boundingBox();
   assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=width+1,JSON.stringify({width,stage,bounds}));
  }
  await page.emulateMedia({media:'print'});
  assert.equal(await page.locator('#generationProgress').isVisible(),false,'provisional text is excluded from phone and desktop print');
  await page.emulateMedia({media:'screen'});
 }
 finished=true;await resumeGenerationPoll(page);
 await page.waitForFunction(()=>document.querySelector('#executiveSummary')?.value==='The file review depends on approval.');
 assert.ok(!(await page.locator('#generationSections').textContent()).includes('Provisional'),'saved result clears every provisional section');
 assert.equal(await page.locator('[data-action]').count(),1);
 assert.equal(await page.locator('[data-parallel-proposal]').count(),2);
 assert.equal(await page.locator('#discussionInstruction').evaluate(e=>e.closest('details').hidden),true);
 assert.equal(await page.locator('#actionsInstruction').evaluate(e=>e.closest('details').hidden),true);
 // A processed draft opens as one document; the beta label is gone and the
 // step screens sit behind Edit structure.
 assert.equal(await page.locator('#generationMethod').isVisible(),false);
 await page.waitForSelector('body.doc-mode');
 await page.click('#editStructureToggle');
 await page.locator('[data-step="2"]').click();
 await page.locator('[data-record-field]').first().fill('Reviewer clarification.');
 await page.waitForFunction(()=>document.querySelector('#saveStatus')?.dataset.state==='saved');
 assert.equal(await page.locator('#staleNotice').isVisible(),false);
 await page.locator('[data-step="3"]').click();
 assert.match(await page.locator('[data-edit-timing]').innerText(),/Timing: only after approval/);
 await page.locator('[data-edit-timing]').click();
 assert.equal(await page.locator('[data-timing-kind]').inputValue(),'stated');
 assert.equal(await page.locator('[data-timing-kind] option:checked').innerText(),'As stated');
 await page.locator('[data-timing-wording]').fill('on the day; throughout');
 await page.locator('[data-finish-timing-edit]').click();
 await page.waitForFunction(()=>document.querySelector('#saveStatus')?.dataset.state==='saved');
 assert.match(await page.locator('[data-edit-timing]').innerText(),/Timing: on the day; throughout/);
 await page.locator('[data-step="5"]').click();
 await page.locator('[data-final-edit][data-field="timing"]').click();
 assert.equal(await page.locator('[data-final-timing-kind]').inputValue(),'stated');
 await page.locator('[data-final-cancel]').click();
 await page.locator('[data-step="3"]').click();
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.locator('#generationMethod').isVisible(),false,'the beta label is retired');
 const box=await page.locator('.parallel-proposal-row [data-label="Action"]').boundingBox();
 assert.ok(box.width>250,'suggestion text uses the full mobile card width');
 assert.equal(await page.locator('.parallel-proposal-row [data-label="Owners"]').isVisible(),true);
 assert.equal(await page.locator('#betaFlowControl').isVisible(),false,'saved drafts keep their provider');
 assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
});

test('Beta partial sections recover after polling errors and reload, reject stale snapshots and clear on failure',async t=>{
 const app=express();app.use(express.json());serveMinutesUi(app);
 const common=parallelUiDraft('parallel-recovery');common.currentStep=common.selectedStep=2;
 const errors=[],writes=[];let mode='healthy';
 const emptyActions=progressFor(common,{actions:{state:'validated',counts:{records:0,proposals:0,flags:0},preview:{actions:[]}}});
 app.get('/api/meeting-minutes-agent/drafts/parallel-recovery',(_,res)=>res.json({ok:true,draft:common}));
 app.get('/api/meeting-minutes-agent/drafts/parallel-recovery/generation',(_,res)=>{
  if(mode==='unavailable')return res.status(503).json({ok:false,error:'Temporary poll failure.'});
  if(mode==='failed'){
   const generation={...common.generation,status:'failed',error:'The Actions service did not complete. Saved content was kept.'};
   return res.json({ok:true,generation,draft:{...common,revision:2,generation},progress:{...emptyActions,status:'failed',code:'failed'}});
  }
  const progress=mode==='stale'?{...emptyActions,startedAt:'2000-01-01T00:00:00.000Z'}:emptyActions;
  res.json({ok:true,generation:common.generation,progress});
 });
 app.use((req,res)=>{if(req.method!=='GET')writes.push({method:req.method,path:req.path,body:req.body});res.status(404).json({error:'Unexpected request'});});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));});
 const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
 const url='http://127.0.0.1:'+server.address().port+'/meeting-minutes-agent?draftId=parallel-recovery';
 const actions=page.locator('[data-generation-section="actions"]');
 const waitForEmptyActions=()=>actions.getByText(/no (confirmed )?actions/i).waitFor();
 await page.goto(url);await waitForEmptyActions();
 assert.equal(await page.locator('#meetingTitle').isDisabled(),true,'Beta inputs stay read-only while section previews arrive');
 assert.equal(await page.locator('#actionsBody [data-action]').count(),0);
 mode='unavailable';await resumeGenerationPoll(page);
 await page.waitForFunction(()=>!document.getElementById('reloadDraft').hidden);
 assert.match(await page.locator('#generationProgressMessage').innerText(),/Progress could not be checked/);
 assert.equal(await page.locator('#generationPhases li').count(),3);
 assert.equal(await page.locator('#saveStatus').getAttribute('data-state'),'generating');
 assert.equal(await page.locator('#generationSections').isVisible(),false,'a failed poll cannot leave stale preview content visible');
 mode='healthy';await page.locator('#reloadDraft').click();await waitForEmptyActions();
 assert.equal(await page.locator('#reloadDraft').isHidden(),true);
 await page.reload();await waitForEmptyActions();
 assert.equal(await page.locator('#downloadDraft').isDisabled(),true);
 mode='stale';await resumeGenerationPoll(page);
 await page.waitForFunction(()=>document.getElementById('generationSections').hidden);
 assert.equal(await page.locator('#generationPhases li').count(),3,'a mismatched snapshot does not complete the current run');
 mode='healthy';await resumeGenerationPoll(page);await waitForEmptyActions();
 mode='failed';await resumeGenerationPoll(page);
 await page.waitForFunction(()=>!document.body.classList.contains('generation-active'));
 assert.equal(await page.locator('#generationSections').isVisible(),false);
 assert.equal(await page.locator('#generationSections').textContent(),'','failed attempts discard provisional output');
 assert.match(await page.locator('#workflowStatus').innerText(),/Actions service did not complete/);
 assert.equal(await page.locator('#executiveSummary').inputValue(),'');
 assert.equal(await page.locator('#discussionList [data-record-field]').count(),0);
 assert.equal(await page.locator('#actionsBody [data-action]').count(),0);
 assert.equal(await page.locator('#downloadDraft').isDisabled(),true);
 assert.equal(await page.locator('#finaliseMinutes').isVisible(),false);
 assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
});

test('Beta switch selects the upload provider, supports keyboard/mobile and preserves access rules',async t=>{
 const app=express();app.use(express.json());let role='admin';const uploads=[];
 app.get('/api/auth/me',(_,res)=>res.json({success:true,user:{role,userId:'switch-reviewer'}}));
 app.get('/meeting-minutes-agent',(_,res)=>res.type('html').send(fs.readFileSync(path.join(root,'views/meeting-minutes-agent.html'),'utf8')));
 app.get('/static/trinzo.js',(_,res)=>res.type('application/javascript').send(''));
 app.get('/static/meeting-minutes-timing.js',(_,res)=>res.type('application/javascript').send(fs.readFileSync(path.join(root,'utils/meetingMinutesTiming.js'),'utf8')));
 app.use('/static',express.static(path.join(root,'public'),{dotfiles:'allow'}));
 app.post('/api/meeting-minutes-agent/check-duplicate',(_,res)=>res.json({duplicates:[]}));
 app.post('/api/meeting-minutes-agent/prepare',express.raw({type:'multipart/form-data'}),(req,res)=>{
  uploads.push(req.body.toString());res.status(422).json({error:'Upload captured for test'});
 });
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));});
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const base='http://127.0.0.1:'+server.address().port;
 await page.goto(base+'/meeting-minutes-agent?projectId=19');
 const toggle=page.getByRole('switch',{name:'Beta: streamlined flow'});
 await toggle.waitFor({state:'visible'});assert.equal(await toggle.isChecked(),false);
 async function upload(){
  const count=uploads.length;
  await page.locator('#transcriptFile').setInputFiles({name:'test.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:Buffer.from('capture only')});
  await page.waitForFunction(()=>document.querySelector('#workflowStatus').textContent==='Upload captured for test'&&!document.body.classList.contains('busy'));
  assert.equal(uploads.length,count+1);return uploads.at(-1);
 }
 assert.ok(!(await upload()).includes('name="generationProvider"'));
 await toggle.focus();await page.keyboard.press('Space');assert.equal(await toggle.isChecked(),true);
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('trinzo.projectMinutesBeta.switch-reviewer')),'parallel');
 assert.equal(new URL(page.url()).searchParams.get('projectId'),'19');
 assert.match(await upload(),/parallel-specialists-v1/);
 await page.reload();await toggle.waitFor({state:'visible'});assert.equal(await toggle.isChecked(),true);
 await page.setViewportSize({width:390,height:844});
 assert.ok(await toggle.isVisible());assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 await toggle.uncheck();assert.equal(new URL(page.url()).searchParams.has('engine'),false);
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('trinzo.projectMinutesBeta.switch-reviewer')),'original');
 assert.ok(!(await upload()).includes('name="generationProvider"'));
 role='member';await page.reload();await page.waitForLoadState('networkidle');
 assert.equal(await page.locator('#betaFlowControl').isVisible(),false);
 assert.deepEqual(errors,[]);
});

test('project Beta journey keeps the provider through upload, reload, saved review and return to Reports', async t => {
 const app = express(); app.use(express.json());
 const uploads = [], queued = [], saved = new Map(), errors = [], unexpected = [];
 let nextId = 501;
 const project = { projectId: 17, projectName: 'Fixture delivery', status: 'active' };
 const draftFor = id => ({
  draftId: String(id), revision: 1, status: 'draft', payloadVersion: 5,
  generationProvider: 'parallel-specialists-v1', title: 'Fixture meeting',
  details: { meetingTitle: 'Fixture meeting', meetingDate: '2026-10-29', meetingLocation: 'Microsoft Teams', internalAttendees: ['Alex'], clientAttendees: [] },
  sourceUnits: [{ id: 'T1', speaker: 'Alex', timestamp: '', text: 'Review the file only after approval.' }],
  discussion: [{ id: 'flat', topic: 'Discussion', hideHeading: true, points: [{ id: 'DI1', text: 'File review remains conditional on approval.', evidenceIds: ['T1'] }], decisions: [], openQuestions: [] }],
  actions: [{ id: 'A1', action: 'Review the file.', owners: ['Alex'], timing: { kind: 'dependency', wording: 'only after approval', exactDate: '' }, evidenceIds: ['T1'] }],
  executiveSummary: 'The file review depends on approval.', executiveSummaryEvidenceIds: ['T1'],
  meetingObjectives: [{ id: 'O1', text: 'Review the file.', evidenceIds: ['T1'] }],
  reviewFlags: [], staleStages: [], parallelActionProposals: [], unassignedSupportingDetails: [], removedActions: [],
  currentStep: 5, selectedStep: 5, changeHistoryCount: 0, generation: null,
  generatedStages: { discussion: '2026-10-29T12:00:00Z', actions: '2026-10-29T12:00:00Z', summary: '2026-10-29T12:00:00Z' }
 });
 for (const [url, filename] of [['/project-update-test', 'project-update-workspace.html'], ['/meeting-minutes-agent', 'meeting-minutes-agent.html']]) {
  app.get(url, (_, res) => res.type('html').send(fs.readFileSync(path.join(root, 'views', filename), 'utf8')));
 }
 app.get('/static/trinzo.js', (_, res) => res.type('application/javascript').send(''));
 app.get('/static/meeting-minutes-timing.js', (_, res) => res.type('application/javascript').send(fs.readFileSync(path.join(root, 'utils/meetingMinutesTiming.js'), 'utf8')));
 app.use('/static', express.static(path.join(root, 'public')));
 app.get('/api/auth/me', (_, res) => res.json({ success: true, user: { userId: 'fixture-reviewer', role: 'admin' } }));
 app.get('/api/project-update-test/projects', (_, res) => res.json({ ok: true, projects: [project] }));
 app.get('/api/project-update-test/context', (_, res) => res.json({ ok: true, context: { activeMilestones: [], activeRisks: [] } }));
 app.get('/api/project-update-test/reports', (_, res) => res.json({ ok: true, reports: queued.length ? [{ reportId: 88, reportName: 'Fixture project update', reportStatus: 'draft' }] : [] }));
 app.get('/api/meeting-minutes-agent/drafts', (_, res) => res.json({ ok: true, drafts: [...saved.values()] }));
 app.post('/api/meeting-minutes-agent/check-duplicate', (_, res) => res.json({ duplicates: [] }));
 app.post('/api/meeting-minutes-agent/prepare', express.raw({ type: 'multipart/form-data' }), (req, res) => {
  uploads.push(req.body.toString());
  const draft = draftFor(nextId++); saved.set(draft.draftId, draft);
  res.json({ ok: true, draft, resumeUrl: '/meeting-minutes-agent?draftId=' + draft.draftId });
 });
 app.get('/api/meeting-minutes-agent/drafts/:id', (req, res) => res.json({ ok: true, draft: saved.get(req.params.id) }));
 app.patch('/api/meeting-minutes-agent/drafts/:id', (req, res) => {
  const old = saved.get(req.params.id), draft = { ...old, ...req.body, revision: old.revision + 1 };
  saved.set(req.params.id, draft); res.json({ ok: true, draft });
 });
 app.post('/api/meeting-minutes-agent/drafts/:id/project-link', (_, res) => res.json({ ok: true }));
 app.post('/api/project-update-test/from-minutes', (req, res) => {
  queued.push(req.body); res.status(202).json({ ok: true, jobId: 'fixture-job' });
 });
 app.use((req, res) => { if (req.method !== 'GET') unexpected.push(req.method + ' ' + req.path); res.status(404).json({ error: 'Unexpected fixture request' }); });
 const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
 t.after(() => new Promise(resolve => server.close(resolve)));
 const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
 const page = await browser.newPage(); page.on('pageerror', e => errors.push(e.message));
 await page.route('https://**', route => route.fulfill({ status: 200, body: '' }));
 const base = 'http://127.0.0.1:' + server.address().port;
 await page.goto(base + '/project-update-test?stage=process&projectId=17');
 const toggle = page.getByRole('switch', { name: 'Beta meeting minutes' });
 await page.locator('#projectBetaControl:not([hidden])').waitFor();
 await page.locator('label[for="projectBetaFlow"]').click();
 await page.click('#openMinutesAgent');
 assert.equal(new URL(page.url()).searchParams.get('engine'), 'parallel');
 assert.equal(new URL(page.url()).searchParams.get('projectId'), '17');
 await page.locator('#transcriptFile').setInputFiles({ name: 'fixture.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('fixture only') });
 await page.waitForURL(/draftId=501/);
 assert.match(uploads[0], /parallel-specialists-v1/);
 assert.equal(new URL(page.url()).searchParams.get('engine'), 'parallel', 'upload resume retains next-upload preference');
 assert.equal(new URL(page.url()).searchParams.get('projectId'), '17');
 await page.reload();
 await page.locator('#editStructureToggle').waitFor({ state: 'visible' });
 if (await page.locator('body.doc-mode').count()) await page.click('#editStructureToggle');
 await page.locator('[data-step="2"]').click();
 await page.locator('[data-record-field]').first().fill('File review is still conditional on written approval.');
 await page.click('#createProjectUpdateFromMinutes');
 const reports = page.getByRole('link', { name: 'go to the project reports' });
 await reports.waitFor();
 assert.equal(queued.length, 1);
 assert.equal(queued[0].projectId, '17');
 assert.equal(queued[0].draftId, '501');
 assert.equal(queued[0].revision, saved.get('501').revision);
 assert.equal(saved.get('501').discussion[0].points[0].text, 'File review is still conditional on written approval.');
 assert.equal(saved.get('501').generationProvider, 'parallel-specialists-v1');
 await reports.click();
 await page.getByRole('link', { name: 'Fixture project update', exact: true }).waitFor();
 assert.equal(new URL(page.url()).searchParams.get('engine'), 'parallel');
 await page.locator('[data-project-nav="process"]').click();
 await toggle.waitFor(); assert.equal(await toggle.isChecked(), true);
 await page.locator('[data-minutes-draft="501"] .badge').waitFor();
 await page.locator('label[for="projectBetaFlow"]').click();
 const oldMinutes = page.locator('[data-minutes-draft="501"] [data-open-minutes-draft]');
 await oldMinutes.click();
 await page.locator('#editStructureToggle').waitFor({ state: 'visible' });
 assert.equal(new URL(page.url()).searchParams.get('engine'), 'original');
 assert.equal(saved.get('501').generationProvider, 'parallel-specialists-v1', 'turning Beta off does not convert existing minutes');
 await page.click('#backToProject');
 await toggle.waitFor(); assert.equal(await toggle.isChecked(), false);
 await page.click('#openMinutesAgent');
 await page.getByRole('switch', { name: 'Beta: streamlined flow' }).waitFor();
 await page.locator('#transcriptFile').setInputFiles({ name: 'another.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('fixture only') });
 await page.waitForURL(/draftId=502/);
 assert.ok(!uploads[1].includes('name="generationProvider"'), 'next upload uses the original provider when Beta is off');
 assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
});
