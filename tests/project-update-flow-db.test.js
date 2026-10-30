'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), { Pool } = require('pg'), { chromium } = require('playwright');
const url = process.env.PROJECT_REPORT_TEST_DATABASE_URL;
if (!url) test('project-flow checks need an explicit disposable database', { skip: 'Set PROJECT_REPORT_TEST_DATABASE_URL (trinzo_tasks_test only)' }, () => {});
else {
  const parsed = new URL(url); assert.equal(parsed.pathname, '/trinzo_tasks_test');
  parsed.searchParams.set('options', '-c search_path=ai010_flow_test');
  process.env.DATABASE_URL = parsed.toString(); process.env.PGIDLE_TIMEOUT_MS = '100';
  const pool = new Pool({connectionString: parsed.toString()}), db = require('../utils/db'), root = path.resolve(__dirname,'..');
  let fallbackReportId;
  const queue = (fingerprint, projectId = 19) => db.queueProjectUpdateGeneration({projectId, projectName:'Fixture project', sourceFingerprint:fingerprint.repeat(64), transcriptText:'Sam: No milestone update was provided today.', minutesDraftId:'1', minutesDraftRevision:1, minutesActions:[{action:'Review the report.',owner:'Sam',deadline:'Target: ideally Friday; fallback Monday'}],skipContext:true,skipKnowledge:true,skipStatusDiagnostics:true});
  test.before(async()=>{
    await pool.query('DROP SCHEMA IF EXISTS ai010_flow_test CASCADE; CREATE SCHEMA ai010_flow_test');
    for (const file of ['20260506_add_meeting_minutes_schema.sql','20260603_add_project_reporting_schema.sql','20260617_add_project_context_snapshots.sql','20260617_add_project_context_official_flags.sql']) await pool.query(fs.readFileSync(root+'/sql/migrations/'+file,'utf8'));
    await pool.query("ALTER TABLE project_report_versions DROP CONSTRAINT project_report_versions_change_type_check; ALTER TABLE project_report_versions ADD CHECK (change_type IN ('ai_generated','user_edit','approved','revision','autosave')); CREATE TABLE auth_users(id BIGINT PRIMARY KEY); INSERT INTO auth_users VALUES(1),(2); INSERT INTO projects(id,project_name) VALUES(19,'Fixture project'),(20,'Other project')");
    await db.ensureMeetingJobQueueSchema();
    await db.listMeetingMinutesAgentDraftPage(1);
    await pool.query("INSERT INTO meeting_minutes_agent_drafts(id,user_id,title,payload) VALUES(1,1,'Owned minutes','{\"actions\":[],\"unknown\":{\"keep\":true}}'),(2,2,'Other user minutes','{}')");
  });
  test.after(async()=>{await pool.query('DROP SCHEMA IF EXISTS ai010_flow_test CASCADE');await pool.end();});
  test('simultaneous identical submissions create one job and no orphan meetings',async()=>{
    const results = await Promise.all(Array.from({length:6},()=>queue('a')));
    const fresh = results.filter(r=>!r.duplicate); assert.equal(fresh.length,1);
    for(const r of results.filter(r=>r.duplicate)){assert.equal(r.kind,'job');assert.equal(r.jobId,fresh[0].jobId);}
    assert.equal((await pool.query('SELECT count(*) FROM meeting_jobs')).rows[0].count,'1');
    assert.equal((await pool.query('SELECT count(*) FROM meetings')).rows[0].count,'1');
    assert.equal((await pool.query('SELECT count(*) FROM meeting_autosaves')).rows[0].count,'1');
    assert(!(await queue('b')).duplicate,'changed reviewed content can queue');
    assert(!(await queue('a',20)).duplicate,'the other project is independent');
  });
  test('report writes roll back at every save boundary and retries save a complete unique report', async () => {
    const tables = ['project_report_versions', 'project_report_sources', 'project_report_health', 'project_report_milestone_assessments', 'project_report_evidence', 'project_ai_risk_suggestions'];
    await pool.query("INSERT INTO project_core_milestones(id,project_id,category,milestone_name) VALUES(900,19,'Fixture','Atomic checkpoint')");
    await pool.query("CREATE FUNCTION fail_audit_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected audit save failure'; END $$");
    for (const [index, table] of tables.entries()) {
      const before = (await pool.query('SELECT count(*) FROM project_reports')).rows[0].count;
      const fingerprint = String(index + 1).repeat(64);
      const save = () => db.saveProjectUpdateDraft({ projectId: 19, projectName: 'Fixture project', sourceFingerprint: fingerprint,
        transcriptText: 'Atomic checkpoint is in progress.', result: { projectReport: { actions: [],
          milestones: [{ milestoneId: 900, milestone: 'Atomic checkpoint', transcript_update_status: 'updated_from_transcript', delivery_status: 'in_progress', evidence: ['Atomic checkpoint is in progress.'] }],
          risks: [{ riskTitle: 'Fixture risk' }] } } });
      await pool.query(`CREATE TRIGGER audit_failure BEFORE INSERT ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION fail_audit_insert()`);
      try {
        await assert.rejects(save(), /Injected audit save failure/);
        assert.equal((await pool.query('SELECT count(*) FROM project_reports')).rows[0].count, before, table);
        assert.equal((await pool.query('SELECT count(*) FROM project_report_sources WHERE transcript_sha256=$1', [fingerprint])).rows[0].count, '0');
      } finally { await pool.query(`DROP TRIGGER audit_failure ON ${table}`); }
      const retried = await save(); assert.equal(retried.saved, true);
      assert.equal((await pool.query('SELECT count(*) FROM project_report_health WHERE report_version_id=$1', [retried.reportVersionId])).rows[0].count, '5');
      assert.equal((await save()).duplicate, true);
    }
    await pool.query('DROP FUNCTION fail_audit_insert()');
  });
  test('failed/cancelled jobs permit retry; live jobs and non-archived reports refuse duplicates across periods',async()=>{
    const old = await queue('c'); await pool.query("UPDATE meeting_jobs SET status='failed' WHERE id=$1",[old.jobId]);
    const retry = await queue('c'); assert(!retry.duplicate);
    await pool.query("UPDATE meeting_jobs SET status='cancelled' WHERE id=$1",[retry.jobId]);assert(!(await queue('c')).duplicate);
    const saved=await db.saveProjectUpdateDraft({projectId:19,projectName:'Fixture project',periodLabel:'Q3 2026',transcriptText:'Synthetic previously saved minutes.',sourceFingerprint:'d'.repeat(64),result:{projectReport:{summary:'Not assessed.',overallHealth:'unknown',overallHealthRag:'unknown',milestones:[],risks:[],actions:[]}}});
    const duplicate=await queue('d'); assert.equal(duplicate.kind,'report');assert.equal(duplicate.reportId,saved.reportId);
    assert.equal((await db.getProjectReportDetail(saved.reportId)).versions[0].savedBy,'Trinzo AI');
    await pool.query("UPDATE project_reports SET report_status='archived' WHERE id=$1",[saved.reportId]);assert(!(await queue('d')).duplicate);
  });
  test('project tagging and repeated schema checks preserve content, revisions and owner isolation',async()=>{
    const before=(await pool.query('SELECT * FROM meeting_minutes_agent_drafts WHERE id=1')).rows[0];
    assert.equal(await db.linkMeetingMinutesAgentDraftToProject(2,1,19),null);
    assert.deepEqual(await db.linkMeetingMinutesAgentDraftToProject(1,1,19),{draftId:'1',projectId:19});
    await db.listMeetingMinutesAgentDraftPage(1); // repeats additive schema migration
    const after=(await pool.query('SELECT * FROM meeting_minutes_agent_drafts WHERE id=1')).rows[0];
    assert.deepEqual(after,{...before,project_id:'19'});
    assert.deepEqual((await db.listMeetingMinutesAgentDraftPage(1,{projectId:19})).drafts.map(d=>d.draftId),['1']);
    assert.equal((await db.listMeetingMinutesAgentDraftPage(2,{projectId:19})).total,0);
    assert.equal((await db.listMeetingMinutesAgentDraftPage(1,{projectId:20})).total,0);
    assert.equal((await db.listMeetingMinutesAgentDraftPage(1)).total,1,'unfiltered Library still shows owned legacy minutes');
    assert.equal(await db.unlinkMeetingMinutesAgentDraftFromProject(1, 2, 19), null, 'other users cannot unlink');
    assert.equal(await db.unlinkMeetingMinutesAgentDraftFromProject(1, 1, 20), null, 'stale project cannot clear a different link');
    assert.deepEqual(await db.unlinkMeetingMinutesAgentDraftFromProject(1, 1, 19), { draftId: '1', projectId: null });
    const unlinked = (await pool.query('SELECT * FROM meeting_minutes_agent_drafts WHERE id=1')).rows[0];
    assert.deepEqual(unlinked, { ...before, project_id: null });
  });
  test('forced primary failure uses actual offline backup, saves a complete report and warns in the real job record',async()=>{
    const queued=await queue('e');
    const input=(await pool.query('SELECT input_payload FROM meeting_jobs WHERE id=$1',[queued.jobId])).rows[0].input_payload;
    const generatorPath=require.resolve('../utils/projectUpdateGenerator'), load=Module._load;
    Module._load=function(request,parent,isMain){
      if(parent?.filename===generatorPath && request==='./meetingMinutesGenerator'){
        const actual=load.apply(this,arguments);
        return {...actual,runPythonTranscriptScript:async(script,...args)=>{if(script==='project_update_minilm.py')throw Error('Forced primary failure for isolated validation');assert.equal(script,'python_llm.py');return actual.runPythonTranscriptScript(script,...args);}};
      }
      return load.apply(this,arguments);
    };
    let generator;try{delete require.cache[generatorPath];generator=require('../utils/projectUpdateGenerator');}finally{Module._load=load;}
    const output=await generator.processProjectUpdateJob({jobId:queued.jobId,meetingId:queued.meetingId,transcriptText:'Sam: No milestone update was provided today.',inputPayload:input});
    assert.equal(output.ok,true,output.error?.message);
    const result=output.response.result;assert.equal(result.projectReportPersistence.saved,true);fallbackReportId=result.projectReportPersistence.reportId;
    const saved=await db.getProjectReportDetail(fallbackReportId), report=saved.versions[0].payload.projectReport;
    assert(report.summary);assert.equal(report.overallHealth,'unknown');assert.equal(report.healthAreas.schedule.status,'unknown');
    assert.equal(report.analyserFallback.used,true);assert.equal(report.actions[0].deadline,'Target: ideally Friday; fallback Monday');
    assert.equal(saved.reportStatus,'draft');assert.equal(saved.approvedVersionId,null);
    const job=(await pool.query('SELECT status,status_message,result_payload FROM meeting_jobs WHERE id=$1',[queued.jobId])).rows[0];
    assert.equal(job.status,'completed');assert.match(job.status_message,/backup analyser/);assert.equal(job.result_payload.result.projectReport.analyserFallback.used,true);
    assert.equal((await queue('e')).kind,'report');
  });
  test('actual report page shows backup warning and preserves qualified actions through editing and reload',async()=>{
    const browser=await chromium.launch({headless:true});try{const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.route('**/*',async route=>{const r=route.request(),url=new URL(r.url());
        if(url.pathname==='/project-update-test/reports/'+fallbackReportId)return route.fulfill({contentType:'text/html',body:fs.readFileSync(root+'/views/project-update-reports.html','utf8')});
        if(url.pathname==='/api/project-update-test/reports/'+fallbackReportId){
          const report=r.method()==='PATCH'?await db.saveProjectReportDetail(fallbackReportId,{...r.postDataJSON(),savedBy:'Synthetic reviewer'}):await db.getProjectReportDetail(fallbackReportId);
          return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,report})});}
        if(url.pathname.startsWith('/static/')){const file=root+'/public/'+path.basename(url.pathname);if(fs.existsSync(file))return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(file,'utf8')});}
        return route.fulfill({contentType:'application/json',body:'{}'});
      });
      await page.goto('http://isolated.fixture/project-update-test/reports/'+fallbackReportId);await page.waitForSelector('#reportSummaryEditor');
      assert.match(await page.locator('body').innerText(),/Backup analyser used/);
      await page.fill('#reportSummaryEditor','Reviewer checked the backup report; project health is not yet assessed.');
      await page.waitForFunction(()=>document.querySelector('#reportSaveStatus')?.textContent.includes('Autosaved server draft at'),null,{timeout:10000});
      await page.reload();await page.waitForSelector('#reportSummaryEditor');assert.equal(await page.inputValue('#reportSummaryEditor'),'Reviewer checked the backup report; project health is not yet assessed.');
      const report=(await db.getProjectReportDetail(fallbackReportId)).versions[0].payload.projectReport;
      assert.equal(report.actions[0].deadline,'Target: ideally Friday; fallback Monday');assert.equal(report.analyserFallback.used,true);assert.deepEqual(errors,[]);
    }finally{await browser.close();}
  });
  test('a database save failure follows the existing retry path rather than claiming the report is ready',async()=>{
    const queued=await queue('f');
    const input=(await pool.query('SELECT input_payload FROM meeting_jobs WHERE id=$1',[queued.jobId])).rows[0].input_payload;
    const generatorPath=require.resolve('../utils/projectUpdateGenerator'), load=Module._load;
    Module._load=function(request,parent,isMain){
      if(parent?.filename===generatorPath && request==='./db')return {...db,saveProjectUpdateDraft:async()=>{throw Error('Forced isolated storage failure');}};
      if(parent?.filename===generatorPath && request==='./meetingMinutesGenerator'){
        const actual=load.apply(this,arguments);
        return {...actual,runPythonTranscriptScript:async(script,...args)=>{if(script==='project_update_minilm.py')throw Error('Forced primary failure');return actual.runPythonTranscriptScript(script,...args);}};
      }
      return load.apply(this,arguments);
    };
    let generator;try{delete require.cache[generatorPath];generator=require('../utils/projectUpdateGenerator');}finally{Module._load=load;}
    const result=await generator.processProjectUpdateJob({jobId:queued.jobId,meetingId:queued.meetingId,attempts:1,maxAttempts:3,transcriptText:'Sam: No milestone update was provided today.',inputPayload:input});
    assert.equal(result.ok,false);assert.match(result.error.message,/could not be saved/);
    const job=(await pool.query('SELECT status,status_message,result_payload FROM meeting_jobs WHERE id=$1',[queued.jobId])).rows[0];
    assert.equal(job.status,'queued');assert.match(job.status_message,/failed; queued for retry/);assert.deepEqual(job.result_payload,{});
  });
  test('reviewed Beta minutes retain qualified actions through the real analyser, save and explicit approval', async () => {
    const text = "The milestone for 'Data migration' is in progress. Sam and Jordan will send the access report once approval arrives.";
    await pool.query("INSERT INTO project_core_milestones(id,project_id,category,milestone_name) VALUES(901,19,'Fixture','Data migration')");
    const payload = { payloadVersion: 5, generationProvider: 'parallel-specialists-v1',
      details: { meetingTitle: 'Beta integration fixture', meetingDate: '2026-10-30' },
      executiveSummary: 'Migration is in progress. Access approval remains a prerequisite.',
      discussion: [{ id: 'flat', topic: 'Discussion', hideHeading: true, points: [{ id: 'DI1', text: "The milestone for 'Data migration' is in progress.", evidenceIds: ['T0001'] }], decisions: [], openQuestions: [] }],
      actions: [{ id: 'A1', action: 'Send the access report.', owners: ['Sam', 'Jordan'], timing: { kind: 'dependency', wording: 'once approval arrives', exactDate: '' }, evidenceIds: ['T0001'] }],
      sourceUnits: [{ id: 'T0001', speaker: 'Sam', text }], preparedTranscript: text,
      parallelActionProposals: [{ id: 'AP1', action: 'Book an optional workshop.', status: 'open', owners: [], timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0001'] }],
      staleStages: [], reviewFlags: [], qualityState: { parallel: { completedAt: new Date().toISOString() } } };
    await pool.query('INSERT INTO meeting_minutes_agent_drafts(id,user_id,revision,payload,raw_transcript) VALUES(900,1,4,$1,$2)', [JSON.stringify(payload), text]);
    const router = require('../routes/api');
    const handler = router.stack.find(l => l.route?.path === '/project-update-test/from-minutes').route.stack.at(-1).handle;
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ body: { draftId: '900', revision: 4, projectId: 19 }, authUser: { userId: 1, email: 'fixture@example.invalid' } }, response);
    assert.equal(response.statusCode, 202, JSON.stringify(response.body));
    const job = await db.getGenerationJob(response.body.jobId, { includeTranscript: true });
    const generatorPath = require.resolve('../utils/projectUpdateGenerator'); delete require.cache[generatorPath];
    const generator = require('../utils/projectUpdateGenerator');
    const generated = await generator.processProjectUpdateJob({ ...job, inputPayload: { ...job.inputPayload, skipMiniLM: true, skipRewrite: true, skipKnowledge: true, skipStatusDiagnostics: true } });
    assert.equal(generated.ok, true, generated.error?.message);
    const reportId = generated.response.result.projectReportPersistence.reportId;
    const saved = await db.getProjectReportDetail(reportId), report = saved.versions[0].payload.projectReport;
    assert.equal(report.milestones.find(x => x.milestoneId === 901).delivery_status, 'in_progress');
    assert.deepEqual(report.actions.map(x => [x.action, x.meetingActionPointOwner, x.deadline]), [['Send the access report.', 'Sam, Jordan', 'Dependent on: once approval arrives']]);
    assert(!JSON.stringify(report.actions).includes('optional workshop'));
    const beforeApproval = await db.getProjectContext({ projectId: 19 });
    assert(!beforeApproval.recentReports.some(x => Number(x.reportId) === reportId));
    const approved = await db.saveProjectReportDetail(reportId, { approve: true, baseVersionId: saved.versions[0].versionId, projectReport: report, savedBy: 'Fixture reviewer' });
    assert.equal(approved.reportStatus, 'approved');
    const afterApproval = await db.getProjectContext({ projectId: 19 });
    assert(afterApproval.recentReports.some(x => Number(x.reportId) === reportId));
    const draft = (await pool.query('SELECT revision,payload FROM meeting_minutes_agent_drafts WHERE id=900')).rows[0];
    assert.equal(draft.revision, 4); assert.deepEqual(draft.payload, payload);
  });
}
