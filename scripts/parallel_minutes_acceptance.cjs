'use strict';
// Explicit integration acceptance runner. Uses a NEW disposable database, never production drafts.
// Microsoft calls require --microsoft; production credentials are loaded only to create this isolated database.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..');
if(!process.argv.includes('--microsoft')) throw Error('Run explicitly with --microsoft to authorise three Microsoft calls per transcript.');
const output=process.env.PARALLEL_ACCEPTANCE_OUTPUT;
if(!output || !path.isAbsolute(output) || output.startsWith(root+path.sep))throw Error('Choose an absolute private artifact directory outside this checkout.');
fs.mkdirSync(output,{recursive:true,mode:0o700});
require('dotenv').config({path:process.env.PARALLEL_ACCEPTANCE_ENV || '/srv/m365-agent-test/.env',quiet:true});
const {Pool}=require('pg');
const pools=new Set(),connect=Pool.prototype.connect;
Pool.prototype.connect=function(...args){if(!pools.has(this)){pools.add(this);this.on('error',()=>{});}return connect.apply(this,args);};
const original=process.env.DATABASE_URL?new URL(process.env.DATABASE_URL):(()=>{
 const u=new URL('postgresql://localhost');u.hostname=process.env.PGHOST || '127.0.0.1';u.port=process.env.PGPORT || '5432';
 u.username=process.env.PGUSER;u.password=process.env.PGPASSWORD;u.pathname='/'+process.env.PGDATABASE;return u;
})();
const database='trinzo_parallel_test_'+crypto.randomBytes(6).toString('hex');
const admin=new Pool({connectionString:original.toString()});
let created=false,server,browser,appPool,origin,child,page;
const browserErrors=[];
const artifacts=[];
function save(file,data){fs.writeFileSync(path.join(output,file),typeof data==='string' || Buffer.isBuffer(data)?data:JSON.stringify(data,null,2),{mode:0o600});}
async function main(){
 await admin.query('CREATE DATABASE "'+database+'"');created=true;
 const isolated=new URL(original);isolated.pathname='/'+database;isolated.searchParams.delete('options');
 process.env.DATABASE_URL=isolated.toString();process.env.PGIDLE_TIMEOUT_MS='100';
 process.env.MEETING_MINUTES_AGENT_GENERATOR='legacy';
 process.env.MEETING_MINUTES_PARALLEL_CONFIG=process.env.MEETING_MINUTES_PARALLEL_CONFIG || '/root/.openclaw/secrets/trinzo-parallel-specialists.json';
 process.env.PYTHON_BIN=process.env.PYTHON_BIN || '/srv/m365-agent-test/.venv/bin/python';
 process.env.STAGED_SIMPLIFIED_MINILM_MODEL='/srv/m365-agent-test/artifacts/meeting-minutes-usefulness-v3/classifier.joblib';
 appPool=new Pool({connectionString:isolated.toString()});
 for(const file of ['20260506_add_meeting_minutes_schema.sql','20260512_add_auth_schema.sql','20260729_add_persistent_auth_sessions.sql','20260817_add_auth_user_roles.sql'])
  await appPool.query(fs.readFileSync(path.join(root,'sql/migrations',file),'utf8'));
 await appPool.query("INSERT INTO auth_users(id,email,full_name,password_hash,password_salt,role) VALUES (1,'preview@fixture.invalid','Preview reviewer','unused','unused','admin'),(2,'other@fixture.invalid','Other reviewer','unused','unused','admin')");
 const db=require('../utils/db'),token=crypto.randomUUID();
 await db.createAuthSession({tokenHash:crypto.createHash('sha256').update(token).digest('hex'),userId:1,expiresAt:new Date(Date.now()+3600000)});
 const express=require('express'),app=express();app.use(express.json({limit:'10mb'}));
 app.get('/static/meeting-minutes-timing.js',(_,res)=>res.type('application/javascript').sendFile(path.join(root,'utils/meetingMinutesTiming.js'),{dotfiles:'allow'}));
 app.use('/static',express.static(path.join(root,'public'),{dotfiles:'allow'}));
 app.use(express.static(path.join(root,'public'),{dotfiles:'allow'}));
 app.get('/meeting-minutes-agent',require('../routes/auth').requireAuth,(_,res)=>res.sendFile(path.join(root,'views/meeting-minutes-agent.html'),{dotfiles:'allow'}));
 app.use('/api',require('../routes/api'));
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));origin='http://127.0.0.1:'+server.address().port;
 const request=async(route,{method='GET',body,headers={}}={})=>{
  const res=await fetch(origin+'/api'+route,{method,headers:{Cookie:'auth_session='+token,...(body && !(body instanceof FormData)?{'Content-Type':'application/json'}:{}),...headers},
   body:body instanceof FormData?body:body?JSON.stringify(body):undefined});
  return {status:res.status,data:res.headers.get('content-type')?.includes('application/json')?await res.json():Buffer.from(await res.arrayBuffer())};
 };
 const {chromium}=require('playwright');browser=await chromium.launch({headless:true});
 const context=await browser.newContext();await context.addCookies([{name:'auth_session',value:token,url:origin}]);
 page=await context.newPage();const errors=browserErrors;page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 let cases=[
  ['T733','scripts/meeting-minutes-core-golden/human_benchmarks/T733_eakin_tech_file/transcript.docx'],
  ['DITA-internal','scripts/meeting-minutes-core-golden/human_benchmarks/T819_dita_internal/transcript.docx'],
  ['Conditional-dates','scripts/meeting-minutes-core-golden/cases/07_deadline_torture/transcript.docx']
 ];
 if(process.env.PARALLEL_ACCEPTANCE_CASES) cases=cases.filter(([name])=>process.env.PARALLEL_ACCEPTANCE_CASES.split(',').includes(name));
 for(const [name,relative]of cases){
  const prior=process.env.PARALLEL_ACCEPTANCE_REPLAY_DIR && path.join(process.env.PARALLEL_ACCEPTANCE_REPLAY_DIR,name+'-original.json');
  const replayed=Boolean(prior && fs.existsSync(prior));
  const start=Date.now();
  if(replayed){
    const old=JSON.parse(fs.readFileSync(prior,'utf8'));
    const restored=await db.createMeetingMinutesAgentDraft({userId:1,title:old.title,fileName:old.fileName,rawTranscript:old.rawTranscript,payload:require('../utils/meetingMinutesParallel').payload(old)});
    await page.goto(origin+'/meeting-minutes-agent?draftId='+restored.draftId);
  }else{
  await page.goto(origin+'/meeting-minutes-agent?engine=parallel');
  await page.locator('#transcriptFile').setInputFiles(path.join(root,relative));
  await page.waitForFunction(()=>window.location.search.includes('draftId='),{timeout:180000});
  }
  const id=new URL(page.url()).searchParams.get('draftId');assert(id);
  let result;
  for(let count=0;count<180;count++){
   result=await request('/meeting-minutes-agent/drafts/'+id);
   if(result.data.draft?.generatedStages?.summary)break;
   if(result.data.draft?.generation?.status==='failed')throw Error(name+': '+result.data.draft.generation.error);
   await new Promise(r=>setTimeout(r,1000));
  }
  assert(result.data.draft.generatedStages.summary,name+' did not complete');
  let draft=result.data.draft;
  assert.equal(draft.generationProvider,'parallel-specialists-v1');
  const privateDraft=await db.getMeetingMinutesAgentDraft(id,1,{includeTranscript:true});
  assert.deepEqual(draft.discussion,privateDraft.discussion);
  assert.deepEqual(draft.actions,privateDraft.actions);
  assert.deepEqual(Object.keys(privateDraft.qualityState.parallel.branches).sort(),['actions','discussion','summary']);
  save(name+'-original.json',privateDraft);
  // Wait for the browser to adopt ALL three results, not just its active stage.
  await page.waitForFunction(()=>document.querySelector('#saveStatus')?.dataset.state==='saved',{timeout:30000});
  await page.reload();await page.waitForFunction(()=>document.querySelector('#saveStatus')?.dataset.state==='saved',{timeout:30000});
  await page.screenshot({path:path.join(output,name+'-editor.png'),fullPage:true});
  const suffix=' Reviewer acceptance check.';
  draft.executiveSummary+=suffix;
  let patched=await request('/meeting-minutes-agent/drafts/'+id,{method:'PATCH',body:{
   revision:draft.revision,executiveSummary:draft.executiveSummary,discussion:draft.discussion,actions:draft.actions,reviewFlags:draft.reviewFlags
  }});
  assert.equal(patched.status,200,JSON.stringify(patched.data));
  draft=patched.data.draft;
  const reopened=await request('/meeting-minutes-agent/drafts/'+id);assert.equal(reopened.data.draft.executiveSummary,draft.executiveSummary);
  assert.deepEqual(reopened.data.draft.discussion,privateDraft.discussion);
  const stale=await request('/meeting-minutes-agent/drafts/'+id,{method:'PATCH',body:{revision:1,executiveSummary:'Stale overwrite'}});
  assert.equal(stale.status,409);
  const other=await db.getMeetingMinutesAgentDraft(id,2);assert.equal(other,null);
  for(const ext of ['docx','pdf']){
   const res=await request('/meeting-minutes-agent/drafts/'+id+'/export.'+ext,{method:'POST',body:{includeEvidence:true}});
   assert.equal(res.status,200,JSON.stringify(res.data));assert(res.data.length>100);
   save(name+'.'+ext,res.data);
  }
  await page.goto(origin+'/meeting-minutes-agent?draftId='+id);await page.waitForFunction(()=>document.querySelector('#saveStatus')?.dataset.state==='saved');
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(output,name+'-mobile.png'),fullPage:true});await page.setViewportSize({width:1280,height:900});
  const flagsBefore=structuredClone(draft.reviewFlags);
  const suggestion=draft.parallelActionProposals?.find(a=>a.status==='open');
  if(suggestion){
   const accepted=await request('/meeting-minutes-agent/drafts/'+id+'/parallel-proposals/'+suggestion.id,{method:'POST',body:{revision:draft.revision,decision:'accept'}});
   assert.equal(accepted.status,200,JSON.stringify(accepted.data));assert.equal(accepted.data.draft.actions.length,draft.actions.length+1);
   const undo=await request('/meeting-minutes-agent/drafts/'+id+'/undo',{method:'POST',body:{revision:accepted.data.draft.revision}});
   assert.equal(undo.status,200);assert.deepEqual(undo.data.draft.actions,draft.actions);assert.deepEqual(undo.data.draft.reviewFlags,flagsBefore);
   draft=undo.data.draft;
  }
  save(name+'-final.json',await db.getMeetingMinutesAgentDraft(id,1,{includeTranscript:true}));
  artifacts.push({name,draftId:id,replayedSavedGeneration:replayed,totalElapsedMs:Date.now()-start,generationMs:privateDraft.qualityState.parallel.parallelElapsedMs,
   actionCount:draft.actions.length,topicCount:draft.discussion.length,proposalCount:draft.parallelActionProposals?.length || 0,
   sources:privateDraft.sourceUnits.length,allThreeSucceeded:true,saveReopen:true,exports:['docx','pdf'],mobile:true,ownership:true,staleRevision:true});
  save('progress.json',artifacts);console.log(JSON.stringify(artifacts.at(-1)));
 }
 assert.deepEqual(errors,[]);
 save('REPORT.json',{completedAt:new Date().toISOString(),databaseIsolated:true,productionDraftsWritten:0,
  cases:artifacts,browserErrors:errors,architecture:'Exactly three concurrent Microsoft calls per draft; no repair or legacy generation',defaultProvider:'legacy'});
 await context.close();
}
(async()=>{
 let failure;
 try{await main();}catch(e){failure=e;save('failure.json',{error:e.message,browserErrors});if(page){save('failure-page.txt',await page.locator('body').innerText().catch(()=>''));await page.screenshot({path:path.join(output,'failure-page.png'),fullPage:true}).catch(()=>{});}console.error(e.message);}
 finally{
  await browser?.close();if(server)await new Promise(r=>server.close(r));
  await Promise.allSettled([...pools].filter(pool=>pool!==admin).map(pool=>pool.end()));
  if(created)await admin.query('DROP DATABASE "'+database+'"');
  await admin.end();
 }
 process.exit(failure?1:0);
})();
