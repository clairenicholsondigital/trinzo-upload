'use strict';
// Explicit disposable database only; never use an inherited application URL.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{Pool}=require('pg'),{chromium}=require('playwright'),express=require('express');
const url=process.env.PROJECT_REPORT_TEST_DATABASE_URL;
if(!url)test('project report PostgreSQL round trip requires an explicit disposable database',{skip:'Set PROJECT_REPORT_TEST_DATABASE_URL (trinzo_tasks_test only)'},()=>{});
else {
 const parsed=new URL(url);assert.equal(parsed.pathname,'/trinzo_tasks_test');parsed.searchParams.set('options','-c search_path=ai001_report_test');
 process.env.DATABASE_URL=parsed.toString();process.env.PGIDLE_TIMEOUT_MS='100';
 const pool=new Pool({connectionString:url}),db=require('../utils/db'),router=require('../routes/api');
 const patch=router.stack.find(l=>l.route?.path==='/project-update-test/reports/:reportId'&&l.route.methods.patch).route.stack.at(-1).handle;
 const fixture=require('./fixtures/project_report_editing.json'),root=path.resolve(__dirname,'..');let browser,server,origin;
 test.before(async()=>{
  await pool.query(`DROP SCHEMA IF EXISTS ai001_report_test CASCADE; CREATE SCHEMA ai001_report_test;
  CREATE TABLE ai001_report_test.projects(id BIGINT PRIMARY KEY,project_name TEXT);
  CREATE TABLE ai001_report_test.project_reporting_periods(id BIGINT PRIMARY KEY,period_label TEXT);
  CREATE TABLE ai001_report_test.project_reports(id BIGINT PRIMARY KEY,project_id BIGINT,reporting_period_id BIGINT,file_name TEXT,report_status TEXT,approved_at TIMESTAMPTZ,approved_by TEXT,approved_version_id BIGINT,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW());
  CREATE TABLE ai001_report_test.project_report_versions(id BIGSERIAL PRIMARY KEY,report_id BIGINT,version_number INTEGER,change_type TEXT,change_summary TEXT,saved_by TEXT,report_payload JSONB,created_at TIMESTAMPTZ DEFAULT NOW(),UNIQUE(report_id,version_number));
  CREATE TABLE ai001_report_test.project_report_sources(id BIGSERIAL PRIMARY KEY,report_id BIGINT,source_type TEXT,file_name TEXT,transcript_text TEXT,transcript_length INTEGER,transcript_sha256 TEXT);
  INSERT INTO ai001_report_test.projects VALUES(19,'Internal fixture');
  INSERT INTO ai001_report_test.project_reports(id,project_id,file_name,report_status) VALUES(42,19,'Report fixture','draft');`);
  await pool.query("INSERT INTO ai001_report_test.project_report_versions(report_id,version_number,change_type,report_payload) VALUES(42,1,'ai_generated',$1)",[JSON.stringify(fixture.versions[0].payload)]);
  const app=express();app.use(express.json());app.use('/static',express.static(root+'/public'));app.get('/project-update-test/reports/42',(_,res)=>res.sendFile(root+'/views/project-update-reports.html'));
  app.get('/api/project-update-test/reports/42',async(_,res)=>res.json({ok:true,report:await db.getProjectReportDetail(42)}));
  app.patch('/api/project-update-test/reports/:reportId',patch);
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));origin='http://127.0.0.1:'+server.address().port;browser=await chromium.launch({headless:true});
 });
 test.after(async()=>{await browser?.close();if(server)await new Promise(r=>server.close(r));await pool.query('DROP SCHEMA IF EXISTS ai001_report_test CASCADE');await pool.end();});
 test('actual report route, store and PostgreSQL preserve the edited report and wrapper after autosave/manual save/reload',async()=>{
  const context=await browser.newContext();try{const page=await context.newPage();page.setDefaultTimeout(10000);await page.route('**/*',r=>new URL(r.request().url()).origin!==origin?r.abort():r.continue());await page.goto(origin+'/project-update-test/reports/42');await page.fill('#reportSummaryEditor','Reviewed summary');await page.waitForFunction(()=>document.querySelector('#reportSaveStatus').textContent.includes('Autosaved server draft at'));await page.reload();assert.equal(await page.inputValue('#reportSummaryEditor'),'Reviewed summary');await page.locator('[data-action-edit-row]').first().locator('[data-field="deadline"]').fill('Dependent on: signed approval');const response=page.waitForResponse(r=>r.request().method()==='PATCH');await page.click('#saveReportBtn');assert.equal((await response).status(),200);await page.waitForFunction(()=>!document.querySelector('#saveReportBtn').disabled);await page.reload();assert.equal(await page.locator('[data-action-edit-row]').first().locator('[data-field="deadline"]').inputValue(),'Dependent on: signed approval');
   const saved=await db.getProjectReportDetail(42),latest=saved.versions[0].payload,expected=structuredClone(fixture.versions[0].payload.projectReport);expected.summary='Reviewed summary';expected.actions[0].deadline='Dependent on: signed approval';delete latest.projectReport.updatedAt;assert.deepEqual(latest.projectReport,expected);assert.deepEqual(latest.untouchedWrapper,fixture.versions[0].payload.untouchedWrapper);assert.equal(saved.versions.length,3);assert.deepEqual(saved.versions.at(-1).payload,fixture.versions[0].payload);assert.equal(saved.reportStatus,'draft');
  }finally{await context.close();}
 });
}
