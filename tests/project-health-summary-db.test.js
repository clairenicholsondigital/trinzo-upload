'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{spawnSync}=require('node:child_process'),{Pool}=require('pg'),express=require('express'),{chromium}=require('playwright');
const url=process.env.PROJECT_REPORT_TEST_DATABASE_URL;
if(!url)test('health summary round trip requires an explicit disposable database',{skip:'Set PROJECT_REPORT_TEST_DATABASE_URL (trinzo_tasks_test only)'},()=>{});
else {
 const parsed=new URL(url);assert.equal(parsed.pathname,'/trinzo_tasks_test');parsed.searchParams.set('options','-c search_path=ai004_health_test');process.env.DATABASE_URL=parsed.toString();process.env.PGIDLE_TIMEOUT_MS='100';
 const pool=new Pool({connectionString:parsed.toString()}),db=require('../utils/db'),router=require('../routes/api'),root=path.resolve(__dirname,'..');
 const patch=router.stack.find(l=>l.route?.path==='/project-update-test/reports/:reportId'&&l.route.methods.patch).route.stack.at(-1).handle;
 let server,browser,origin;
 test.before(async()=>{
  await pool.query(`DROP SCHEMA IF EXISTS ai004_health_test CASCADE;CREATE SCHEMA ai004_health_test;
  CREATE TABLE projects(id BIGINT PRIMARY KEY,project_name TEXT);
  CREATE TABLE project_reporting_periods(id BIGINT PRIMARY KEY,period_label TEXT);
  CREATE TABLE project_reports(id BIGINT PRIMARY KEY,project_id BIGINT,reporting_period_id BIGINT,file_name TEXT,report_status TEXT,approved_at TIMESTAMPTZ,approved_by TEXT,approved_version_id BIGINT,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW());
  CREATE TABLE project_report_versions(id BIGSERIAL PRIMARY KEY,report_id BIGINT,version_number INTEGER,change_type TEXT,change_summary TEXT,saved_by TEXT,report_payload JSONB,created_at TIMESTAMPTZ DEFAULT NOW(),UNIQUE(report_id,version_number));
  CREATE TABLE project_report_sources(id BIGSERIAL PRIMARY KEY,report_id BIGINT,source_type TEXT,file_name TEXT,transcript_text TEXT,transcript_length INTEGER,transcript_sha256 TEXT);
  INSERT INTO projects VALUES(19,'Synthetic AI project');`);
  const app=express();app.use(express.json());app.use('/static',express.static(root+'/public'));
  app.get('/project-update-test/reports/:reportId',(_,res)=>res.sendFile('views/project-update-reports.html',{root}));
  app.get('/api/project-update-test/reports/:reportId',async(req,res)=>res.json({ok:true,report:await db.getProjectReportDetail(req.params.reportId)}));app.patch('/api/project-update-test/reports/:reportId',patch);
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));origin='http://127.0.0.1:'+server.address().port;browser=await chromium.launch({headless:true});
 });
 test.after(async()=>{await browser?.close();if(server)await new Promise(r=>server.close(r));await pool.query('DROP SCHEMA IF EXISTS ai004_health_test CASCADE');await pool.end();});
 const cases=[['unknown','Team: Let us reschedule this project review call.'],['amber','Team: Project delivery is slipping behind schedule.'],['red','Team: A major regression completely blocks our release.']];
 for(const [index,[expected,transcript]] of cases.entries())test('generated '+expected+' health/summary persist and reviewer corrections survive refresh',async()=>{
  const py="import json,sys\nfrom scripts.project_update_minilm import build_project_update_output\nprint(json.dumps(build_project_update_output(sys.stdin.read(),use_minilm=False,use_rewrite=True)['projectReport']))";
  const result=spawnSync(process.env.PROJECT_HISTORY_TEST_PYTHON||'/srv/m365-agent-test/.venv/bin/python',['-c',py],{cwd:root,input:transcript,encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'},timeout:30000});assert.equal(result.status,0,result.stderr);const generated=JSON.parse(result.stdout.trim());assert.equal(generated.overallHealthRag,expected);assert(generated.summary.includes(expected==='unknown'?'Not yet assessed':expected[0].toUpperCase()+expected.slice(1)));assert(!generated.summary.toLowerCase().includes('most milestones'));
  const id=index+1;await pool.query("INSERT INTO project_reports(id,project_id,file_name,report_status) VALUES($1,19,'Generated health fixture','draft')",[id]);await pool.query("INSERT INTO project_report_versions(report_id,version_number,change_type,report_payload) VALUES($1,1,'ai_generated',$2)",[id,JSON.stringify({projectReport:generated})]);
  const context=await browser.newContext({viewport:index===0?{width:390,height:844}:{width:1280,height:900}});try{const page=await context.newPage();page.setDefaultTimeout(10000);await page.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());await page.goto(origin+'/project-update-test/reports/'+id);assert.equal(await page.inputValue('#reportSummaryEditor'),generated.summary);if(expected==='unknown')assert(await page.getByText('Not yet assessed',{exact:true}).first().isVisible());await page.click('#saveReportBtn');await page.waitForFunction(()=>!document.querySelector('#saveReportBtn').disabled);await page.reload();assert.equal(await page.inputValue('#reportSummaryEditor'),generated.summary);assert.equal((await db.getProjectReportDetail(id)).versions[0].payload.projectReport.overallHealthRag,expected);
   const corrected=generated.summary+' Reviewer qualification retained.';await page.fill('#reportSummaryEditor',corrected);await page.waitForFunction(()=>document.querySelector('#reportSaveStatus').textContent.includes('Autosaved server draft at'));await page.reload();assert.equal(await page.inputValue('#reportSummaryEditor'),corrected);const saved=await db.getProjectReportDetail(id);assert.deepEqual(saved.versions.at(-1).payload.projectReport,generated);assert.equal(saved.versions[0].payload.projectReport.summary,corrected);assert.equal(saved.reportStatus,'draft');
  }finally{await context.close();}
 });
}
