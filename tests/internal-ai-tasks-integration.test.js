'use strict';
// Run only against an explicitly supplied disposable database. Never fall back
// to DATABASE_URL or the application's production database.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),express=require('express'),{Pool}=require('pg'),{chromium}=require('playwright');
const T=require('../utils/internalAiTasks'),I=require('../utils/internalAiTaskImport'),router=require('../routes/internalAiTasks');
const url=process.env.INTERNAL_AI_TASK_TEST_DATABASE_URL;
const root=path.resolve(__dirname,'..');
if(!url){test('internal AI Tasks PostgreSQL/browser integration requires a disposable database',{skip:'Set INTERNAL_AI_TASK_TEST_DATABASE_URL; production DATABASE_URL is deliberately ignored.'},()=>{});}else{
 const parsed=new URL(url);if(parsed.pathname!=='/trinzo_tasks_test')throw Error('Use only the disposable trinzo_tasks_test database.');
 const pool=new Pool({connectionString:url}),store=T.createStore(pool.query.bind(pool));let server,origin,browser;
 const admin={userId:1,fullName:'Nora Patel',email:'nora@example.test',role:'admin'};
 const headers={'Content-Type':'application/json','x-fixture-user':'admin'};
 async function req(path='',options={}){const r=await fetch(origin+'/api/project-update-test/projects/19/tasks'+path,{...options,headers:{...headers,...options.headers}});return{status:r.status,body:await r.json()};}
 const p0=I.prepare(fs.readFileSync(root+'/docs/CURRENT_PROJECT_STATUS.md','utf8'));
 test.before(async()=>{
  await pool.query('DROP TABLE IF EXISTS internal_ai_task_comments,internal_ai_tasks,projects,auth_users CASCADE; DROP SEQUENCE IF EXISTS internal_ai_task_number_seq; CREATE TABLE projects(id BIGINT PRIMARY KEY, project_name TEXT NOT NULL); CREATE TABLE auth_users(id BIGINT PRIMARY KEY, full_name TEXT); INSERT INTO projects VALUES(19,\'Renamed internal project\'),(20,\'AI Team Development\'); INSERT INTO auth_users VALUES(1,\'Nora Patel\'),(2,\'Client\');');
  const sql=fs.readFileSync(root+'/sql/migrations/20261026_add_internal_ai_tasks.sql','utf8');await pool.query(sql);await pool.query(sql); // migration is safe to rerun
  await pool.query("INSERT INTO internal_ai_tasks(project_id,task_key,title,description,source_references,ai_implementation_guidance,created_by_name,updated_by_name) VALUES(19,'AI-999','Existing task','Keep original description','[{\"url\":\"https://example.test/source\",\"label\":\"Evidence\"}]','{\"problem\":\"Retain private guidance\"}','Nora','Nora')");
  const detailsSql=fs.readFileSync(root+'/sql/migrations/20261026_add_internal_ai_task_details.sql','utf8');await pool.query(detailsSql);await pool.query(detailsSql);
  const nextActionSql=fs.readFileSync(root+'/sql/migrations/20261026_add_internal_ai_task_next_action.sql','utf8');await pool.query(nextActionSql);await pool.query(nextActionSql);
  const causeToolSql=fs.readFileSync(root+'/sql/migrations/20261026_add_internal_ai_task_cause_tool.sql','utf8');await pool.query(causeToolSql);await pool.query(causeToolSql);
  const workSql=fs.readFileSync(root+'/sql/migrations/20261026_add_internal_ai_task_work_requirement.sql','utf8');await pool.query(workSql);await pool.query(workSql);
  const legacy=(await pool.query("SELECT * FROM internal_ai_tasks WHERE task_key='AI-999'")).rows[0];
  assert.equal(legacy.description,'Keep original description');assert.equal(legacy.source_references[0].label,'Evidence');assert.equal(legacy.ai_implementation_guidance.problem,'Retain private guidance');
  for(const field of ['current_implications','plan_to_fix','fix_details','next_action','affected_tool','root_cause'])assert.equal(legacy[field],'');
  assert.equal(legacy.work_requirement,'Unclassified');
  const app=express();app.use(express.json());
  // Fixture identity stands in for server.js's real requireAuth middleware.
  app.use('/api',(req,res,next)=>{const who=req.get('x-fixture-user');if(!who)return res.status(401).json({ok:false});req.authUser=who==='admin'?admin:{userId:2,fullName:'Client',role:'client'};next();});
  app.get('/api/project-update-test/projects',async(_,res)=>res.json({ok:true,projects:(await pool.query('SELECT id AS "projectId",project_name AS "projectName" FROM projects ORDER BY id')).rows}));
  app.use('/api/project-update-test/projects/:projectId/tasks',router(store));
  app.get('/project-update-test',(_,res)=>res.sendFile('views/project-update-workspace.html',{root}));
  app.get('/static/trinzo.js',(_,res)=>res.type('js').send(''));
  app.use('/static',express.static(root+'/public'));
  app.get('/api/project-update-test/context',(_,res)=>res.json({ok:true,context:{activeMilestones:[],activeRisks:[],healthHistory:[],recentReports:[]}}));
  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true});
 });
 test.after(async()=>{await browser?.close();if(server)await new Promise(r=>server.close(r));await pool.end();});
 test.beforeEach(async()=>{await pool.query('TRUNCATE internal_ai_task_comments,internal_ai_tasks RESTART IDENTITY CASCADE');});
 test('work requirement is persisted, filtered independently, and rejects invalid values',async()=>{
  const first=(await req('',{method:'POST',body:JSON.stringify({title:'Local fix',workRequirement:'Code only'})})).body.task;
  const second=(await req('',{method:'POST',body:JSON.stringify({title:'Pilot decision',workRequirement:'Needs input'})})).body.task;
  const unset=(await req('',{method:'POST',body:JSON.stringify({title:'Unreviewed'})})).body.task;
  assert.equal(unset.workRequirement,'Unclassified');
  assert.deepEqual((await req('?workRequirement=Code%20only')).body.tasks.map(t=>t.taskId),[first.taskId]);
  assert.deepEqual((await req('?workRequirement=Needs%20input')).body.tasks.map(t=>t.taskId),[second.taskId]);
  assert.deepEqual((await req('?workRequirement=Unclassified')).body.tasks.map(t=>t.taskId),[unset.taskId]);
  assert.equal((await req('?workRequirement=Anything')).status,400);
  assert.equal((await req('/'+first.taskId,{method:'PATCH',body:JSON.stringify({revision:first.revision,workRequirement:'Needs input'})})).status,200);
  assert.deepEqual((await req('?workRequirement=Code%20only')).body.tasks,[]);
  assert.deepEqual((await req('?workRequirement=Needs%20input')).body.tasks.map(t=>t.taskId).sort(),[first.taskId,second.taskId].sort());
  assert.equal((await req('/'+first.taskId,{method:'PATCH',body:JSON.stringify({revision:first.revision,workRequirement:'Code only'})})).status,409);
  assert.equal((await req('',{method:'POST',body:JSON.stringify({title:'Bad',workRequirement:'Automatic'})})).status,400);
 });
 test('HTTP access denies unauthenticated, client and cross-project calls including forged identity',async()=>{
  assert.equal((await req('/access',{headers:{'x-fixture-user':''}})).status,401);
  assert.equal((await req('/access',{headers:{'x-fixture-user':'client'}})).status,403);
  for(const method of['GET','POST','PATCH']){const r=await fetch(origin+'/api/project-update-test/projects/20/tasks',{method,headers,body:method==='GET'?undefined:JSON.stringify({title:'Forbidden',projectId:19})});assert.equal(r.status,404);}
  assert.equal((await req('/access')).status,200);
  assert.equal((await req('',{method:'POST',body:JSON.stringify({title:'X',createdBy:'Forged'})})).status,400);
  assert.equal((await req('',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'title=Forbidden'})).status,415);
  await assert.rejects(pool.query("INSERT INTO internal_ai_tasks(project_id,task_key,title,created_by_name,updated_by_name) VALUES(20,'AI-999','No','X','X')"),e=>e.code==='23514');
 });
 test('create, field-safe updates, concurrent revisions, completion/reopen and comments persist with real authorship',async()=>{
  const created=await req('',{method:'POST',body:JSON.stringify({title:'Keep qualifiers',description:'Original description',nextAction:'Confirm original evidence',affectedTool:'Project updates',currentImplications:'User cannot finish',planToFix:'Preserve saved evidence',fixDetails:'Verified by reviewer',sourceReferences:[{url:'https://example.test/source',label:'Evidence'}],priority:'P0',owner:'Reviewer',dueDate:'2026-11-10'})});assert.equal(created.status,201);
  const t=created.body.task;assert.match(t.taskId,/^AI-\d{3,}$/);assert.equal(t.createdBy,'Nora Patel');
  const c=await req('/'+t.taskId+'/comments',{method:'POST',body:JSON.stringify({body:'Check the source.'})});assert.equal(c.body.task.comments[0].author,'Nora Patel');
  assert.equal((await req('/'+t.taskId+'/comments',{method:'POST',body:JSON.stringify({body:'X',author:'Forged'})})).status,400);
  const concurrent=await Promise.all(['In progress','Blocked'].map(status=>req('/'+t.taskId,{method:'PATCH',body:JSON.stringify({revision:t.revision,status})})));
  assert.deepEqual(concurrent.map(x=>x.status).sort(),[200,409]);let fresh=(await req('/'+t.taskId)).body.task;
  assert.equal(fresh.affectedTool,'Project updates');assert.equal(fresh.nextAction,'Confirm original evidence');assert.equal(fresh.description,'Original description');assert.equal(fresh.currentImplications,'User cannot finish');assert.equal(fresh.planToFix,'Preserve saved evidence');assert.equal(fresh.fixDetails,'Verified by reviewer');assert.equal(fresh.sourceReferences[0].label,'Evidence');assert.equal(fresh.owner,'Reviewer');assert.equal(fresh.dueDate,'2026-11-10');
  let done=await req('/'+t.taskId,{method:'PATCH',body:JSON.stringify({revision:fresh.revision,status:'Done'})});assert(done.body.task.completedAt);
  assert.equal((await req()).body.tasks.length,0);assert.equal((await req('?showCompleted=true')).body.tasks.length,1);
  assert.equal((await req('?status=Done')).body.counts.Done,1);
  const reopen=await req('/'+t.taskId,{method:'PATCH',body:JSON.stringify({revision:done.body.task.revision,status:'To do'})});assert.equal(reopen.body.task.completedAt,null);assert.equal(reopen.body.task.comments.length,1);assert.equal(reopen.body.task.fixDetails,'Verified by reviewer');assert.equal(reopen.body.task.nextAction,'Confirm original evidence');assert.equal(reopen.body.task.affectedTool,'Project updates');
  assert.equal((await req('/'+t.taskId)).body.task.status,'To do');
 });
 test('guidance survives completion and ordinary updates but cannot be read or written via task APIs',async()=>{
  const t=(await req('',{method:'POST',body:JSON.stringify({title:'Private planning'})})).body.task;assert(!Object.hasOwn(t,'root_cause'));assert(!Object.hasOwn(t,'rootCause'));
  await pool.query('UPDATE internal_ai_tasks SET ai_implementation_guidance=$1,root_cause=$2 WHERE task_key=$3',[JSON.stringify({problem:'PRIVATE_GUIDANCE_SENTINEL'}),'PRIVATE_ROOT_CAUSE_SENTINEL',t.taskId]);
  for(const path of['','/'+t.taskId,'?showCompleted=true']){const json=JSON.stringify((await req(path)).body);for(const forbidden of ['PRIVATE_GUIDANCE','PRIVATE_ROOT_CAUSE','root_cause','rootCause'])assert(!json.includes(forbidden));}
  for(const key of ['root_cause','rootCause']){assert.equal((await req('',{method:'POST',body:JSON.stringify({title:'Private field write',[key]:'Forbidden'})})).status,400);assert.equal((await req('/'+t.taskId,{method:'PATCH',body:JSON.stringify({revision:t.revision,[key]:'Forbidden'})})).status,400);}
  assert.equal((await req('/'+t.taskId,{method:'PATCH',body:JSON.stringify({revision:t.revision,ai_implementation_guidance:{problem:'Forged'}})})).status,400);
  const commented=await req('/'+t.taskId+'/comments',{method:'POST',body:JSON.stringify({body:'Public comment'})});assert.equal(commented.status,201);assert(!JSON.stringify(commented.body).includes('PRIVATE_'));assert(!Object.hasOwn(commented.body.task,'root_cause'));
  const edited=await req('/'+t.taskId,{method:'PATCH',body:JSON.stringify({revision:t.revision,title:'Public edit',affectedTool:'Shared'})});assert.equal(edited.status,200);
  const done=await req('/'+t.taskId,{method:'PATCH',body:JSON.stringify({revision:edited.body.task.revision,status:'Done'})});assert(!JSON.stringify(done.body).includes('PRIVATE_'));
  const reopened=await req('/'+t.taskId,{method:'PATCH',body:JSON.stringify({revision:done.body.task.revision,status:'To do'})});assert.equal(reopened.status,200);
  assert.equal((await pool.query('SELECT root_cause FROM internal_ai_tasks WHERE task_key=$1',[t.taskId])).rows[0].root_cause,'PRIVATE_ROOT_CAUSE_SENTINEL');
  assert.equal((await pool.query('SELECT ai_implementation_guidance FROM internal_ai_tasks WHERE task_key=$1',[t.taskId])).rows[0].ai_implementation_guidance.problem,'PRIVATE_GUIDANCE_SENTINEL');
 });
 test('approved import is idempotent and never overwrites manual status, owner, comments or guidance',async()=>{
  const manual=await store.create({title:'Manual task before import'},admin);assert(!p0.tasks.some(t=>t.taskId===manual.taskId));
  const first=await I.apply(pool.query.bind(pool),p0,admin,I.digest(p0));assert.equal(first.inserted.length,14);
  const task=await store.get('AI-001');await store.update(task.taskId,{revision:task.revision,title:'Manually revised',owner:'Human',status:'Done'},admin);await store.comment(task.taskId,{body:'Keep this comment.'},admin);
  await pool.query("UPDATE internal_ai_tasks SET ai_implementation_guidance='{\"problem\":\"retained\"}',root_cause='retained private research' WHERE task_key='AI-001'");
  const second=await I.apply(pool.query.bind(pool),p0,admin,I.digest(p0));assert.equal(second.inserted.length,0);assert.equal(second.skipped.length,14);
  const after=await store.get('AI-001');assert.equal(after.title,'Manually revised');assert.equal(after.owner,'Human');assert.equal(after.status,'Done');assert.equal(after.comments[0].body,'Keep this comment.');
  assert.equal((await pool.query("SELECT ai_implementation_guidance->>'problem' p FROM internal_ai_tasks WHERE task_key='AI-001'")).rows[0].p,'retained');
  assert.equal((await pool.query("SELECT root_cause FROM internal_ai_tasks WHERE task_key='AI-001'")).rows[0].root_cause,'retained private research');assert.equal((await pool.query('SELECT count(*) FROM internal_ai_tasks')).rows[0].count,'15');assert.equal((await store.get(manual.taskId)).title,'Manual task before import');
 });
 // A previous 'Saved.' label can remain while a new write is pending. Wait
 // for this exact mutation, its fresh detail state and the list refresh that
 // completes the save handler before starting another edit or querying the DB.
 async function saveTask(page,button='#saveAiTask',expectedStatus){
  const id=await page.locator('#aiTaskDetail h2').innerText(),creating=id==='Create task';
  const method=creating?'POST':'PATCH',pathname='/api/project-update-test/projects/19/tasks'+(creating?'':'/'+id);
  const status=expectedStatus||await page.locator('[name="status"]').inputValue();
  const saved=page.waitForResponse(response=>response.request().method()===method&&new URL(response.url()).pathname===pathname&&response.request().postDataJSON()?.status===status);
  await page.click(button);const response=await saved;assert.equal(response.status(),creating?201:200);
  await page.waitForFunction(status=>document.querySelector('#aiTaskDetailStatus')?.textContent==='Saved.'&&document.querySelector('#aiTaskForm [name="status"]')?.value===status,status);
  await page.waitForLoadState('networkidle');
 }
 async function pageFor(t,project=19,role='admin',mobile=false){const context=await browser.newContext({extraHTTPHeaders:{'x-fixture-user':role},viewport:mobile?{width:390,height:844}:{width:1280,height:900}});t.after(()=>context.close());const page=await context.newPage();page.setDefaultTimeout(15000);await page.route('**/*',r=>new URL(r.request().url()).origin!==origin?r.abort():r.continue());await page.goto(origin+'/project-update-test?projectId='+project+'&stage=tasks');await page.waitForSelector('.project-nav');return page;}
 test('browser navigation is exclusive to persistent project 19 and internal users, including direct task URLs',async t=>{
  const a=await pageFor(t);assert.equal(await a.locator('[data-project-nav="tasks"]').count(),1);assert.match(await a.locator('h1').innerText(),/Tasks/);
  const other=await pageFor(t,20);assert.equal(await other.locator('[data-project-nav="tasks"]').count(),0);assert.equal(await other.locator('#aiTaskList').count(),0);
  const client=await pageFor(t,19,'client');assert.equal(await client.locator('[data-project-nav="tasks"]').count(),0);assert.equal(await client.locator('#aiTaskList').count(),0);
 });
 test('unsaved task/comment warnings and pending comments survive ordinary task edits',async t=>{
  const page=await pageFor(t);await page.click('#newAiTask');await page.locator('[name="title"]').fill('Unsaved task');
  page.once('dialog',dialog=>dialog.dismiss());await page.click('[data-project-nav="overview"]');assert.equal(await page.locator('#aiTaskForm').count(),1);
  assert.equal(await page.locator('[name="sources"]').count(),0);await saveTask(page);
  const taskId=await page.locator('#aiTaskDetail h2').innerText();
  await pool.query('UPDATE internal_ai_tasks SET source_references=$1 WHERE task_key=$2',[JSON.stringify([{url:'https://example.test/source',label:'Retained reference'}]),taskId]);
  await page.locator('#aiTaskCommentForm textarea').fill('Unsent but preserved');await page.locator('[name="title"]').fill('Saved with comment still pending');await saveTask(page);assert.equal(await page.locator('#aiTaskCommentForm textarea').inputValue(),'Unsent but preserved');assert.equal((await store.get(taskId)).sourceReferences[0].label,'Retained reference');
  page.once('dialog',dialog=>dialog.dismiss());await page.click('#closeAiTask');assert.equal(await page.locator('#aiTaskCommentForm textarea').inputValue(),'Unsent but preserved');
 });
 for(const mobile of[false,true])test('browser create/edit/comment/complete/reopen/filter survives refresh (mobile='+mobile+')',async t=>{
  const page=await pageFor(t,19,'admin',mobile);await page.click('#newAiTask');await page.locator('[name="title"]').fill('A useful pilot task');await page.locator('[name="description"]').fill('Review the minutes.');await page.locator('[name="nextAction"]').fill('Check <source> evidence.');await page.locator('[name="currentImplications"]').fill('Review is currently slow.');await page.locator('[name="planToFix"]').fill('Check and simplify the review.');await page.selectOption('[name="affectedTool"]','Meeting minutes');await page.selectOption('[name="workRequirement"]','Code only');await page.selectOption('[name="priority"]','P0');await saveTask(page);
  const id=await page.locator('#aiTaskDetail h2').innerText();assert.equal(await page.locator('.task-next-action').innerText(),'Next action: Check <source> evidence.');assert.equal(await page.locator('.task-next-action source').count(),0);assert.equal(await page.locator('.task-tool').innerText(),'Meeting minutes');await page.selectOption('#aiTaskWorkRequirement','Needs input');await page.waitForFunction(()=>document.querySelector('#aiTaskList').textContent.includes('No tasks match'));await page.selectOption('#aiTaskWorkRequirement','Code only');await page.waitForSelector('[data-open-task="'+id+'"]');await page.locator('#aiTaskCommentForm textarea').fill('<script>not executable</script>');await page.locator('#aiTaskCommentForm button').click();await page.waitForFunction(()=>document.querySelector('#aiTaskCommentStatus').textContent==='Comment added.');assert.match(await page.locator('#aiTaskComments').innerText(),/Nora Patel/);assert.equal(await page.locator('#aiTaskComments script').count(),0);
  await page.reload();await page.click('[data-open-task="'+id+'"]');await page.waitForSelector('#aiTaskForm');assert.equal(await page.locator('[name="description"]').inputValue(),'Review the minutes.');assert.equal(await page.locator('[name="nextAction"]').inputValue(),'Check <source> evidence.');assert.equal(await page.locator('[name="affectedTool"]').inputValue(),'Meeting minutes');assert.equal(await page.locator('[name="workRequirement"]').inputValue(),'Code only');assert.equal(await page.locator('[name="currentImplications"]').inputValue(),'Review is currently slow.');assert.equal(await page.locator('[name="planToFix"]').inputValue(),'Check and simplify the review.');assert.match(await page.locator('#aiTaskComments').innerText(),/not executable/);
  await page.selectOption('[name="affectedTool"]','Shared');await page.locator('[name="nextAction"]').fill('Confirm the reviewed result.');await page.locator('[name="title"]').fill('Changed after refresh');await page.selectOption('[name="category"]','Validation');await page.selectOption('[name="status"]','In progress');await saveTask(page);
  await page.selectOption('#aiTaskPriority','P1');await page.waitForFunction(()=>document.querySelector('#aiTaskList').textContent.includes('No tasks match'));await page.selectOption('#aiTaskPriority','P0');await page.waitForSelector('[data-open-task]');await page.selectOption('#aiTaskCategory','Validation');await page.selectOption('#aiTaskStatus','In progress');await page.waitForSelector('[data-open-task]');
  await page.locator('[name="fixDetails"]').fill('Review simplified and checked.');await saveTask(page,'#completeAiTask','Done');assert.equal((await store.get(id)).status,'Done');assert((await store.get(id)).completedAt);
  await page.reload();await page.selectOption('#aiTaskStatus','Done');await page.waitForSelector('[data-open-task="'+id+'"]');await page.click('[data-open-task="'+id+'"]');await page.waitForSelector('#aiTaskForm');assert.equal(await page.locator('[name="fixDetails"]').inputValue(),'Review simplified and checked.');assert.equal(await page.locator('[name="affectedTool"]').inputValue(),'Shared');assert.equal(await page.locator('[name="nextAction"]').inputValue(),'Confirm the reviewed result.');await saveTask(page,'#completeAiTask','To do');assert.equal((await store.get(id)).status,'To do');assert.equal((await store.get(id)).completedAt,null);
  await page.selectOption('#aiTaskStatus','');await page.uncheck('#aiTaskCompleted');await page.waitForSelector('[data-complete-task="'+id+'"]');await page.check('[data-complete-task="'+id+'"]');await page.waitForFunction(()=>!document.querySelector('[data-open-task]'));await page.selectOption('#aiTaskStatus','');await page.check('#aiTaskCompleted');await page.waitForSelector('[data-complete-task]:checked');await page.uncheck('[data-complete-task="'+id+'"]');await page.waitForSelector('[data-complete-task]:not(:checked)');await page.reload();await page.click('[data-open-task="'+id+'"]');await page.waitForSelector('#aiTaskComments');assert.match(await page.locator('#aiTaskComments').innerText(),/not executable/);assert.equal(await page.locator('[name="status"]').inputValue(),'To do');
  assert.equal(await page.locator('[name="ai_implementation_guidance"]').count(),0);assert.equal(await page.locator('[name="root_cause"],[name="rootCause"]').count(),0);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 });
}
