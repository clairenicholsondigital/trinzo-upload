'use strict';
// Never inherit the application's database. An explicit disposable DB is required.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process'),{Pool}=require('pg');
const url=process.env.PROJECT_REPORT_TEST_DATABASE_URL;
if(!url)test('approved history needs an explicit disposable database',{skip:'Set PROJECT_REPORT_TEST_DATABASE_URL (trinzo_tasks_test only)'},()=>{});
else {
 const parsed=new URL(url);assert.equal(parsed.pathname,'/trinzo_tasks_test');parsed.searchParams.set('options','-c search_path=ai003_history_test,public');
 process.env.DATABASE_URL=parsed.toString();process.env.PGIDLE_TIMEOUT_MS='100';
 const pool=new Pool({connectionString:parsed.toString()}),db=require('../utils/db'),root=path.resolve(__dirname,'..');
 let reportId, approvedId, workingId;
 const report=summary=>({reportStatus:'draft',summary,overallHealth:'at_risk',overallHealthRag:'amber',milestones:[{milestoneId:201,milestone:'Migration',delivery_status:'blocked',normalised_evidence_summary:summary,forecast_finish_date:'',transcript_update_status:'updated_from_transcript',evidence:['Source retained']}],healthAreas:{schedule:{status:'at_risk',evidenceNotes:summary,evidence:[]}},risks:[{riskTitle:'Delivery risk',description:summary}],actions:[]});
 const context=()=>db.getProjectContext({projectId:19});
 async function current(){return db.getProjectReportDetail(reportId);}
 async function save(data){const latest=(await current()).versions[0];return db.saveProjectReportDetail(reportId,{baseVersionId:latest.versionId,...data});}
 test.before(async()=>{
  await pool.query('DROP SCHEMA IF EXISTS ai003_history_test CASCADE; CREATE SCHEMA ai003_history_test');
  for(const name of ['20260603_add_project_reporting_schema.sql','20260617_add_project_context_snapshots.sql','20260617_add_project_context_official_flags.sql','20260703_add_project_knowledge_schema.sql'])await pool.query(fs.readFileSync(root+'/sql/migrations/'+name,'utf8'));
  await pool.query(`ALTER TABLE project_report_versions DROP CONSTRAINT IF EXISTS project_report_versions_change_type_check;
   ALTER TABLE project_report_versions ADD CHECK (change_type IN ('ai_generated','user_edit','approved','revision','autosave'));
   INSERT INTO projects(id,project_name) VALUES(19,'Synthetic AI project'),(20,'Other project');
   INSERT INTO project_core_milestones(id,project_id,category,milestone_name,baseline_finish_date,forecast_finish_date) VALUES(201,19,'Configured','Migration','2026-01-01','2026-02-01');
   INSERT INTO project_core_risks(project_id,risk_title,description) VALUES(19,'Manual risk','Independent context');`);
  const r=await pool.query("INSERT INTO project_reports(project_id,file_name) VALUES(19,'Synthetic report') RETURNING id");reportId=r.rows[0].id;
  const v=await pool.query("INSERT INTO project_report_versions(report_id,version_number,change_type,report_payload) VALUES($1,1,'ai_generated',$2) RETURNING id",[reportId,JSON.stringify({untouchedWrapper:{keep:true},projectReport:report('Unreviewed generated')})]);
  await pool.query("INSERT INTO project_report_milestone_assessments(report_version_id,milestone_id,status,summary) VALUES($1,201,'on_track','Stale generated assessment')",[v.rows[0].id]);
  await db.createProjectKnowledgeItem({projectId:19,title:'Manual background',content:'Migration background independent of report approval',itemType:'background_doc'});
 });
 test.after(async()=>{await pool.query('DROP SCHEMA IF EXISTS ai003_history_test CASCADE');await pool.end();});
 test('draft and archived assessments do not enter baseline; manual project context remains',async()=>{
  const c=await context();assert.equal(c.activeMilestones[0].latestAssessment,null);assert.equal(c.healthHistory.length,0);assert.equal(c.recentReports.length,0);assert.equal(c.activeRisks.length,1);assert.equal(c.activeMilestones[0].baselineFinishDate,'2026-01-01');
  const generated=(await current()).versions[0].versionId;
  await pool.query("INSERT INTO project_context_snapshots(project_id,source_report_version_id,summary) VALUES(19,$1,'Unreviewed snapshot')",[generated]);assert.equal((await context()).latestSnapshot,null);
  await pool.query("INSERT INTO project_context_snapshots(project_id,snapshot_type,summary) VALUES(19,'manual','Independent manual context')");assert.equal((await context()).latestSnapshot.summary,'Independent manual context');
 });
 test('new draft extraction cannot overwrite configured milestone dates',async()=>{
  await db.saveProjectUpdateDraft({projectId:19,projectName:'Synthetic AI project',periodLabel:'Q4 2026',transcriptText:'Synthetic migration update for date isolation.',result:{projectReport:{...report('Draft date change'),milestones:[{...report('Draft date change').milestones[0],baseline_finish_date:'2030-01-01',forecast_finish_date:'2030-02-01'}]}}});
  const m=(await context()).activeMilestones[0];assert.equal(m.baselineFinishDate,'2026-01-01');assert.equal(m.forecastFinishDate,'2026-02-01');assert.equal(m.latestAssessment,null);
 });
 test('status alone or autosave cannot approve; explicit approval propagates reviewed JSON without old generated rows',async()=>{
  await save({reportStatus:'approved',projectReport:report('Manual save is not approval')});assert.equal((await current()).reportStatus,'draft');
  await save({reportStatus:'approved',autosave:true,approve:true,projectReport:report('Autosaved unreviewed')});assert.equal((await current()).reportStatus,'draft');assert.equal((await context()).recentReports.length,0);
  const reviewed=await save({approve:true,reportStatus:'approved',projectReport:report('Reviewed correction')});approvedId=reviewed.approvedVersionId;assert.equal(reviewed.reportStatus,'approved');assert.equal(reviewed.knowledgeIngestion.ok,true);
  const c=await context();assert.equal(c.recentReports[0].reportVersionId,Number(approvedId));assert.equal(c.activeMilestones[0].latestAssessment.summary,'Reviewed correction');assert.equal(c.activeMilestones[0].latestAssessment.status,'blocked');assert.equal(c.activeMilestones[0].latestAssessment.forecastFinishDate,'');assert.equal(c.healthHistory[0].rationale,'Reviewed correction');assert.equal(c.riskSuggestions[0].description,'Reviewed correction');assert.equal((await current()).versions[0].payload.untouchedWrapper.keep,true);
 });
 test('the next generated report carries the exact reviewed baseline, including a cleared forecast',async()=>{
  const c=await context();
  const py="import json,sys\nfrom scripts.project_update_minilm import build_project_update_output\nr=build_project_update_output('Team: No milestone update today.',use_minilm=False,use_rewrite=False,project_context=json.load(sys.stdin))\nprint(json.dumps(r['projectReport']['milestones']))";
  const r=spawnSync(process.env.PROJECT_HISTORY_TEST_PYTHON||'/srv/m365-agent-test/.venv/bin/python',['-c',py],{cwd:root,input:JSON.stringify(c),encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'},timeout:30000});assert.equal(r.status,0,r.stderr);const rows=JSON.parse(r.stdout.trim());assert.equal(rows[0].delivery_status,'blocked');assert.equal(rows[0].normalised_evidence_summary,'Reviewed correction.');assert.equal(rows[0].forecast_finish_date,'');assert.equal(rows[0].previous_report_version_id,Number(approvedId));
 });
 test('editing and repeated autosaves preserve immutable approved baseline and reject stale approval',async()=>{
  const before=await current(),frozen=before.versions[0].payload;
  await save({autosave:true,reportStatus:'approved',projectReport:report('Unreviewed later edit')});const first=await current();workingId=first.versions[0].versionId;assert.equal(first.reportStatus,'draft');assert.equal(first.approvedVersionId,approvedId);
  assert.equal((await context()).activeMilestones[0].latestAssessment.summary,'Reviewed correction');
  await save({autosave:true,projectReport:report('Second unsaved review')});assert.notEqual((await current()).versions[0].versionId,workingId);
  await assert.rejects(db.saveProjectReportDetail(reportId,{approve:true,baseVersionId:workingId,projectReport:report('Stale')}),e=>e.statusCode===409);
  assert.deepEqual((await current()).versions.find(v=>String(v.versionId)===String(approvedId)).payload,frozen);
 });
 test('simultaneous saves are serialised and a stale approval ingestion cannot reactivate knowledge',async()=>{
  const base=(await current()).versions[0].versionId;
  const results=await Promise.allSettled([1,2].map(n=>db.saveProjectReportDetail(reportId,{baseVersionId:base,autosave:true,projectReport:report('Concurrent '+n)})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.statusCode,409);
  const stale=(await current()).versions.at(-1).versionId;
  const rejected=await db.ingestApprovedProjectReportVersion({projectId:19,reportId,reportVersionId:stale,payload:{projectReport:report('Stale ingestion')}});assert.equal(rejected.ok,false);
 });
 test('approval rejects foreign or duplicate milestone IDs without changing the last approval',async()=>{
  for(const milestones of [[{milestoneId:999,milestone:'Migration'}],[{milestoneId:201},{milestoneId:201}]])await assert.rejects(save({approve:true,projectReport:{...report('Invalid target'),milestones}}),e=>e.statusCode===400);
  assert.equal((await current()).approvedVersionId,approvedId);
 });
 test('reapproval replaces baseline and retires old report knowledge, not independent documents',async()=>{
  const next=await save({approve:true,projectReport:report('Second reviewed correction')});assert.equal(next.knowledgeIngestion.ok,true);assert.notEqual(next.approvedVersionId,approvedId);approvedId=next.approvedVersionId;
  const c=await context();assert.equal(c.activeMilestones[0].latestAssessment.summary,'Second reviewed correction');
  const old=await pool.query("SELECT count(*) FROM project_knowledge_items WHERE source_report_id=$1 AND source_report_version_id<>$2 AND status='active'",[reportId,approvedId]);assert.equal(old.rows[0].count,'0');
  assert.equal((await pool.query("SELECT status FROM project_knowledge_items WHERE title='Manual background'")).rows[0].status,'active');
 });
 test('real browser autosave, explicit approval and reload preserve the approval boundary',async()=>{
  const express=require('express'),{chromium}=require('playwright'),router=require('../routes/api');
  const patch=router.stack.find(l=>l.route?.path==='/project-update-test/reports/:reportId'&&l.route.methods.patch).route.stack.at(-1).handle;
  const app=express();app.use(express.json());app.use('/static',express.static(root+'/public'));
  app.get('/project-update-test/reports/:reportId',(_,res)=>res.sendFile(root+'/views/project-update-reports.html'));
  app.get('/api/project-update-test/reports/:reportId',async(req,res)=>res.json({ok:true,report:await db.getProjectReportDetail(req.params.reportId)}));
  app.patch('/api/project-update-test/reports/:reportId',(req,res,next)=>{req.authUser={email:'reviewer@example.invalid'};next();},patch);
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const origin='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({headless:true});try{
   const page=await browser.newPage();page.setDefaultTimeout(10000);await page.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
   await page.goto(origin+'/project-update-test/reports/'+reportId);await page.fill('#reportSummaryEditor','Migration browser reviewed summary');await page.waitForFunction(()=>document.querySelector('#reportSaveStatus').textContent.includes('Autosaved server draft at'));
   assert.equal((await current()).reportStatus,'draft');assert.equal((await current()).approvedVersionId,approvedId);assert.equal((await context()).recentReports[0].summary,'Second reviewed correction');
   await page.reload();assert.equal(await page.inputValue('#reportSummaryEditor'),'Migration browser reviewed summary');assert.equal(await page.inputValue('#reportStatusEditor'),'draft');
   const response=page.waitForResponse(r=>r.request().method()==='PATCH'&&r.request().postDataJSON()?.approve===true);await page.click('#approveReportBtn');assert.equal((await response).status(),200);await page.waitForFunction(()=>!document.querySelector('#saveReportBtn').disabled);await page.reload();
   assert.equal(await page.inputValue('#reportStatusEditor'),'approved');const currentReport=await current();approvedId=currentReport.approvedVersionId;assert.equal(currentReport.approvedBy,'reviewer@example.invalid');assert.equal((await context()).recentReports[0].summary,'Migration browser reviewed summary');
  }finally{await browser.close();await new Promise(r=>server.close(r));}
 });
 async function retrieval(semantic){
  const py=`import json\nimport project_knowledge_retrieval as r\nr.embed_texts=lambda texts: ({texts[0]:[1.0]+[0.0]*383}, {}) if ${semantic?'True':'False'} else ({}, {})\nprint(json.dumps(r.retrieve(19,'migration',25),default=str))`;
  const result=spawnSync(process.env.PROJECT_HISTORY_TEST_PYTHON||'/srv/m365-agent-test/.venv/bin/python',['-c',py],{cwd:root,encoding:'utf8',env:{...process.env,DATABASE_URL:parsed.toString().replace(/\+/g,'%20'),PYTHONPATH:root+'/scripts',PYTHONDONTWRITEBYTECODE:'1',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'},timeout:30000});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout.trim());
 }
 test('semantic and keyword retrieval exclude stale/draft/foreign sources while retaining current approval and manual background',async()=>{
  const versions=(await current()).versions;const stale=versions.find(v=>v.changeType==='approved'&&String(v.versionId)!==String(approvedId)).versionId;
  for(const [title,sourceId,versionId] of [['Stale migration',reportId,stale],['Wrong project migration',reportId,approvedId]]){
   const target=title.startsWith('Wrong')?20:19;
   const item=await pool.query("INSERT INTO project_knowledge_items(project_id,title,content,item_type,source_report_id,source_report_version_id) VALUES($1,$2,'migration source','report_summary',$3,$4) RETURNING id",[target,title,sourceId,versionId]);
   await pool.query("INSERT INTO project_knowledge_chunks(item_id,project_id,chunk_index,chunk_text,embedding_status) VALUES($1,19,0,'migration source','queued')",[item.rows[0].id]);
  }
  const vector=JSON.stringify([1,...Array(383).fill(0)]);await pool.query("UPDATE project_knowledge_chunks SET embedding=$1::vector,embedding_status='embedded'",[vector]);
  for(const semantic of [false,true]){const r=await retrieval(semantic);assert.equal(r.ok,true);assert.equal(r.retrieval_mode,semantic?'semantic':'keyword_fallback');assert(r.chunks.some(x=>x.title==='Manual background'));assert(r.chunks.some(x=>x.item_type==='report_summary'));assert(!r.chunks.some(x=>/Stale|Wrong project/.test(x.title)));}
 });
 test('archiving withdraws all report history and report-derived retrieval; approval cannot resurrect an archived report',async()=>{
  await db.deleteProjectReport(reportId);const c=await context();assert.equal(c.recentReports.length,0);assert.equal(c.activeMilestones[0].latestAssessment,null);assert.equal(c.healthHistory.length,0);assert.equal(c.riskSuggestions.length,0);assert.equal(c.activeRisks.length,1);
  await assert.rejects(save({approve:true,projectReport:report('Cannot approve archived')}),e=>e.statusCode===409);
  const r=await retrieval(false);assert(r.chunks.length>0);assert(r.chunks.every(x=>x.title==='Manual background'));
 });
}
