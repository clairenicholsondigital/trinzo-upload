'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),express=require('express'),{Pool}=require('pg'),{chromium}=require('playwright'),{spawn,spawnSync}=require('node:child_process'),readline=require('node:readline');
const url=process.env.SETTINGS_TEST_DATABASE_URL;
if(!url)test('Settings integration requires a disposable database',{skip:'Set SETTINGS_TEST_DATABASE_URL (trinzo_tasks_test only)'},()=>{});
else{
 const parsed=new URL(url);assert.equal(parsed.pathname,'/trinzo_tasks_test');parsed.searchParams.set('options','-c search_path=ai013_settings_test');process.env.DATABASE_URL=parsed.toString();process.env.PGIDLE_TIMEOUT_MS='100';
 const root=path.resolve(__dirname,'..'),pool=new Pool({connectionString:parsed.toString()}),db=require('../utils/db'),store=require('../utils/settingsStore'),settingsDb=require('../utils/settingsDb');
 let server,origin,browser,draftId,personId,termId;
 const headers=role=>({'Content-Type':'application/json',...(role?{Cookie:'auth_session=fixture-'+role}:{})});
 async function req(route='',{role='admin',method='GET',body}={}){const r=await fetch(origin+'/api/settings'+route,{method,headers:headers(role),body:body?JSON.stringify(body):undefined});return{status:r.status,data:await r.json()};}
 test.before(async()=>{
  await pool.query('DROP SCHEMA IF EXISTS ai013_settings_test CASCADE; CREATE SCHEMA ai013_settings_test');
  for(const f of ['20260506_add_meeting_minutes_schema.sql','20260603_add_project_reporting_schema.sql','20260512_add_auth_schema.sql','20260729_add_persistent_auth_sessions.sql','20260817_add_auth_user_roles.sql'])await pool.query(fs.readFileSync(root+'/sql/migrations/'+f,'utf8'));
  await pool.query("INSERT INTO projects(id,project_name) VALUES(19,'Isolated worker fixture')");
  await pool.query("INSERT INTO auth_users(id,email,full_name,password_hash,password_salt,role) VALUES(1,'admin@fixture.invalid','Synthetic Admin','unused','unused','admin'),(2,'client@fixture.invalid','Synthetic Client','unused','unused','client')");
  for(const [role,id]of[['admin',1],['client',2]])await db.createAuthSession({tokenHash:crypto.createHash('sha256').update('fixture-'+role).digest('hex'),userId:id,expiresAt:new Date(Date.now()+3600000)});
  const draft=await db.createMeetingMinutesAgentDraft({userId:1,title:'Preserve fixture',payload:{payloadVersion:5,currentStep:0,details:{meetingTitle:'Preserve fixture',meetingDate:'2026-10-26',internalAttendees:['Saki Arimoto','Jacqui Fox'],clientAttendees:[],allAttendees:['Saki Arimoto','Jacqui Fox']},discussion:[],actions:[],reviewFlags:[],sourceUnits:[]}});draftId=draft.draftId;
  const app=express();app.use(express.json());app.use('/static',express.static(root+'/public'));app.get('/settings',(_,res)=>res.sendFile(root+'/views/settings.html'));app.get('/meeting-minutes-agent',(_,res)=>res.sendFile(root+'/views/meeting-minutes-agent.html'));app.use('/api/settings',require('../routes/settings'));app.use('/api',require('../routes/api'));
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));origin='http://127.0.0.1:'+server.address().port;browser=await chromium.launch({headless:true});
 });
 test.after(async()=>{await browser?.close();if(server)await new Promise(r=>server.close(r));await pool.query('DROP SCHEMA IF EXISTS ai013_settings_test CASCADE');await pool.end();});
 async function independentSettingsRead(){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,['-e',"require('./utils/settingsDb').loadSettings().then(x=>{console.log(JSON.stringify(x));process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})"],{cwd:root,env:{...process.env},stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.once('error',reject);child.once('exit',code=>{if(code!==0)reject(Error(err));else resolve(JSON.parse(out));});});}
 test('concurrent fresh processes create and seed settings once, and the reference migration is repeatable',async()=>{
  const results=await Promise.all([independentSettingsRead(),independentSettingsRead()]);
  for(const r of results){assert.equal(r.people.length,27);assert.equal(r.terms.length,86);}
  const sql=fs.readFileSync(root+'/sql/migrations/20261021_add_settings_schema.sql','utf8');await pool.query(sql);await pool.query(sql);
  assert.equal((await pool.query('SELECT count(*) FROM settings_meta')).rows[0].count,'2');
 });
 test('real session authentication, role permissions, one-time seed and audit attribution',async()=>{
  assert.equal((await req('',{role:null})).status,401);
  const client=await req('',{role:'client'});assert.equal(client.status,200);assert.equal(client.data.canEdit,false);
  for(const [route,method,body]of[['/people','POST',{name:'Denied',side:'internal'}],['/people/1','PUT',{name:'Denied',side:'client'}],['/people/1','DELETE'],['/terms','POST',{term:'Denied'}],['/terms/1','PUT',{term:'Denied'}],['/terms/1','DELETE']])assert.equal((await req(route,{role:'client',method,body})).status,403);
  assert.equal((await req('/history',{role:'client'})).status,403);
  const first=await req();assert(first.data.people.length>=27);assert(first.data.terms.length>=80);
  await store.refresh();await store.refresh();const second=await req();assert.equal(second.data.people.length,first.data.people.length);assert.equal(second.data.terms.length,first.data.terms.length);
  const add=await req('/people',{method:'POST',body:{name:'Nora Anne Marie Patel',side:'internal',spellings:['Patel, Nora Anne Marie'],userEmail:'forged@invalid'}});assert.equal(add.status,200,JSON.stringify(add.data));personId=add.data.item.id;
  const term=await req('/terms',{method:'POST',body:{term:'ReviewPack',meaning:'Synthetic meeting review pack',heardAs:['review packet']}});assert.equal(term.status,200,JSON.stringify(term.data));termId=term.data.item.id;
  assert.equal((await req('/terms',{method:'POST',body:{term:'OtherPack',heardAs:['review-packet']}})).status,400);
  const history=await req('/history');assert(history.data.changes.some(c=>c.itemId===personId&&c.userEmail==='admin@fixture.invalid'&&c.action==='added'));
 });
 test('admin browser can edit, refresh, delete and view history on desktop and mobile',async()=>{
  const c=await browser.newContext();await c.addCookies([{name:'auth_session',value:'fixture-admin',url:origin}]);const page=await c.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));try{
   await page.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());await page.goto(origin+'/settings');await page.waitForSelector('#addPerson:not([hidden])');await page.fill('#peopleSearch','Nora Anne Marie Patel');await page.getByRole('button',{name:'Edit Nora Anne Marie Patel (Internal)',exact:true}).click();await page.fill('#peopleForm [name="name"]','Nora Anne Marie Patel');await page.locator('#peopleForm .side-choice label').filter({hasText:'Client'}).click();assert.equal(await page.isChecked('#peopleForm [name="side"][value="client"]'),true);await page.locator('#peopleForm button[type="submit"]').click();await page.waitForSelector('#peopleForm[hidden]',{state:'attached'});await page.reload();await page.fill('#peopleSearch','Nora Anne Marie Patel');await page.getByRole('button',{name:'Edit Nora Anne Marie Patel (Client)',exact:true}).waitFor();
   await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));await page.click('#termsTab');await page.fill('#termsSearch','ReviewPack');await page.getByRole('button',{name:'Edit ReviewPack',exact:true}).click();await page.fill('#termsForm [name="meaning"]','Updated meaning retained after refresh.');await page.locator('#termsForm button[type="submit"]').click();await page.waitForSelector('#termsForm[hidden]',{state:'attached'});await page.reload();await page.fill('#termsSearch','ReviewPack');assert.match(await page.locator('#termsList').innerText(),/Updated meaning retained/);
   await page.click('#peopleTab');await page.fill('#peopleSearch','Nora Anne Marie Patel');await page.getByRole('button',{name:'Edit Nora Anne Marie Patel (Client)',exact:true}).click();page.once('dialog',d=>d.accept());await page.locator('#peopleForm button.delete').click();await page.waitForSelector('#peopleForm[hidden]',{state:'attached'});await page.reload();await page.fill('#peopleSearch','Nora Anne Marie Patel');assert.equal(await page.getByRole('button',{name:/Edit Nora Anne Marie Patel/}).count(),0);
   assert.deepEqual(errors,[]);
  }finally{await c.close();}
  await store.refresh();assert(!store.getPeople().some(p=>p.id===personId),'deleted seeded/custom records must not return');
  const history=await req('/history');assert(history.data.changes.some(c=>c.itemId===personId&&c.action==='deleted'));
 });
 test('client browser can read but cannot open editing controls',async()=>{
  const c=await browser.newContext();await c.addCookies([{name:'auth_session',value:'fixture-client',url:origin}]);try{const page=await c.newPage();await page.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());await page.goto(origin+'/settings');await page.waitForSelector('.settings-row');assert.equal(await page.locator('#addPerson').isVisible(),false);assert.equal(await page.locator('.row-edit').count(),0);assert.equal(await page.locator('#historyPanel').isVisible(),false);}finally{await c.close();}
 });
 test('directory side overrides a reviewer move through actual owned save, refresh and publication',async()=>{
  const r=await fetch(origin+'/api/meeting-minutes-agent/drafts/'+draftId,{headers:headers('admin')});assert.equal(r.status,200);const draft=(await r.json()).draft;
  const response=await fetch(origin+'/api/meeting-minutes-agent/drafts/'+draftId,{method:'PATCH',headers:headers('admin'),body:JSON.stringify({revision:draft.revision,details:{...draft.details,internalAttendees:['Jacqui Fox'],clientAttendees:['Saki Arimoto']}})});const saved=await response.json();assert.equal(response.status,200,JSON.stringify(saved));assert(saved.draft.details.internalAttendees.includes('Saki Arimoto'));assert(!saved.draft.details.clientAttendees.includes('Saki Arimoto'));
  const reread=await(await fetch(origin+'/api/meeting-minutes-agent/drafts/'+draftId,{headers:headers('admin')})).json();assert.deepEqual(reread.draft.details,saved.draft.details);assert((await db.getMeetingMinutesAgentDraft(draftId,1)).details.internalAttendees.includes('Saki Arimoto'));
 });
 test('directory edits control reopening and regenerated attendee extraction without rewriting saved history',async()=>{
  const before=(await pool.query('SELECT * FROM meeting_minutes_agent_drafts WHERE id=$1',[draftId])).rows[0];
  const saki=(await req()).data.people.find(p=>p.name==='Saki Arimoto');
  assert.equal((await req('/people/'+saki.id,{method:'PUT',body:{name:saki.name,side:'client',spellings:saki.spellings}})).status,200);
  const reopened=await(await fetch(origin+'/api/meeting-minutes-agent/drafts/'+draftId,{headers:headers('admin')})).json();
  assert(reopened.draft.details.clientAttendees.includes('Saki Arimoto'));
  const extracted=require('../routes/api').stagedEvaluation.extractStagedDetailsFromTranscript('Review transcript\n\nJacqui Fox   0:05\nWe reviewed the schedule.\n\nSaki Arimoto   0:12\nI will check the report.','fixture.vtt');
  const regenerated=require('../utils/meetingMinutesDraftContext').sanitiseDetails(extracted.screens.details);
  assert(regenerated.clientAttendees.includes('Saki Arimoto'));
  assert.deepEqual((await pool.query('SELECT * FROM meeting_minutes_agent_drafts WHERE id=$1',[draftId])).rows[0],before);
 });
 test('separate worker process refreshes edits and gives Python the current settings snapshot',async()=>{
  const code=`const rl=require('readline').createInterface({input:process.stdin});const s=require('./utils/settingsStore');rl.on('line',async()=>{await s.refresh();console.log(JSON.stringify({people:s.getPeople(),terms:s.getTerms(),snapshot:process.env.TRINZO_SETTINGS_SNAPSHOT}));});`;
  const child=spawn(process.execPath,['-e',code],{cwd:root,env:{...process.env},stdio:['pipe','pipe','pipe']});const lines=readline.createInterface({input:child.stdout});
  const read=()=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Worker refresh timed out')),10000);lines.once('line',line=>{clearTimeout(timer);resolve(JSON.parse(line));});child.stdin.write('refresh\n');});
  try{const first=await read();assert(first.snapshot);const changed=await req('/people',{method:'POST',body:{name:'Morgan Avery Lane West',side:'internal',spellings:[]}});assert.equal(changed.status,200);const second=await read();assert(second.people.some(p=>p.name==='Morgan Avery Lane West'));
   const python=spawnSync(process.env.PROJECT_HISTORY_TEST_PYTHON||'/srv/m365-agent-test/.venv/bin/python',['-c',"import json\nfrom scripts.trinzo_settings_snapshot import apply_people,glossary_or\nprint(json.dumps({'people':apply_people({})['participant_groups'],'terms':glossary_or({})}))"],{cwd:root,env:{...process.env,TRINZO_SETTINGS_SNAPSHOT:second.snapshot,PYTHONDONTWRITEBYTECODE:'1'},encoding:'utf8',timeout:30000});assert.equal(python.status,0,python.stderr);const result=JSON.parse(python.stdout);assert.equal(result.people['Morgan Avery Lane West'],'trinzo');assert.equal(result.terms.ReviewPack,'Updated meaning retained after refresh.');assert.equal(fs.statSync(second.snapshot).mode&0o777,0o600);
  }finally{lines.close();child.kill();await new Promise(r=>child.once('exit',r));}
 });
 test('actual background worker loads newly edited settings before executing an offline project job',async()=>{
  const child=spawn(process.execPath,['scripts/meeting_minutes_final_worker.js'],{cwd:root,env:{...process.env,MEETING_MINUTES_WORKER_POLL_MS:'100'},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>output+=b.toString());child.stderr.on('data',b=>output+=b.toString());
  try{
   for(let i=0;i<100&&!output.includes('meeting_minutes_worker_started');i++)await new Promise(r=>setTimeout(r,50));
   assert(output.includes('meeting_minutes_worker_started'),output);
   const changed=await req('/terms',{method:'POST',body:{term:'WorkerReviewPack',meaning:'A settings change made after worker startup.',heardAs:[]}});assert.equal(changed.status,200);
   const queued=await db.queueProjectUpdateGeneration({transcriptText:'Sam: No milestone update was provided today.',projectId:19,projectName:'Isolated worker fixture',skipMiniLM:true,skipRewrite:true,skipContext:true,skipKnowledge:true,skipStatusDiagnostics:true});
   let job;
   for(let i=0;i<200;i++){job=(await pool.query('SELECT status,result_payload,error_message FROM meeting_jobs WHERE id=$1',[queued.jobId])).rows[0];if(job.status==='completed'||job.status==='failed')break;await new Promise(r=>setTimeout(r,50));}
   assert.equal(job.status,'completed',JSON.stringify({job,output}));
   const snapshot=JSON.parse(fs.readFileSync(require('os').tmpdir()+'/trinzo-settings-'+child.pid+'.json','utf8'));
   assert(snapshot.terms.some(t=>t.term==='WorkerReviewPack'&&t.meaning==='A settings change made after worker startup.'));
   assert.equal(job.result_payload.result.queuedDiagnostics.fallbackUsed,false);
   assert.equal(job.result_payload.result.projectReportPersistence.saved,true);
   assert.equal((await pool.query('SELECT count(*)::int AS count FROM project_reports WHERE project_id=19')).rows[0].count,1);
  }finally{child.kill();if(child.exitCode===null)await new Promise(r=>child.once('exit',r));}
 });
 test('deleting an initially seeded person survives refresh and a new process',async()=>{
  const list=await req();const seeded=list.data.people.find(p=>p.name==='Grace McGroogan');assert(seeded);
  assert.equal((await req('/people/'+seeded.id,{method:'DELETE'})).status,200);await store.refresh();
  assert(!store.getPeople().some(p=>p.name===seeded.name));
  assert(!(await independentSettingsRead()).people.some(p=>p.name===seeded.name));
 });
 test('database failure retains last good settings and recovers without reseeding deleted people',async()=>{
  const previous=structuredClone(store.getPeople());await pool.query('ALTER TABLE settings_people RENAME TO settings_people_unavailable');try{await store.refresh();assert.deepEqual(store.getPeople(),previous);}finally{await pool.query('ALTER TABLE settings_people_unavailable RENAME TO settings_people');}await store.refresh();assert.deepEqual(store.getPeople(),previous);assert(!store.getPeople().some(p=>p.id===personId));
 });
}
