'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Pool}=require('pg');
const url=process.env.PROJECT_REPORT_TEST_DATABASE_URL;
if(!url)test('milestone binding PostgreSQL checks require an explicit disposable database',{skip:'Set PROJECT_REPORT_TEST_DATABASE_URL (trinzo_tasks_test only)'},()=>{});
else {
 const parsed=new URL(url);assert.equal(parsed.pathname,'/trinzo_tasks_test');parsed.searchParams.set('options','-c search_path=ai016_milestone_test');process.env.DATABASE_URL=parsed.toString();process.env.PGIDLE_TIMEOUT_MS='100';const pool=new Pool({connectionString:url}),db=require('../utils/db');
 test.before(async()=>{await pool.query(`DROP SCHEMA IF EXISTS ai016_milestone_test CASCADE; CREATE SCHEMA ai016_milestone_test;
 CREATE TABLE ai016_milestone_test.projects(id BIGINT PRIMARY KEY,project_name TEXT);
 CREATE TABLE ai016_milestone_test.project_reporting_periods(id BIGSERIAL PRIMARY KEY,project_id BIGINT,period_type TEXT,period_label TEXT,start_date DATE,end_date DATE,UNIQUE(project_id,period_type,period_label));
 CREATE TABLE ai016_milestone_test.project_reports(id BIGSERIAL PRIMARY KEY,project_id BIGINT,reporting_period_id BIGINT,file_name TEXT,report_status TEXT,include_in_global_analysis BOOLEAN,updated_at TIMESTAMPTZ);
 CREATE TABLE ai016_milestone_test.project_report_versions(id BIGSERIAL PRIMARY KEY,report_id BIGINT REFERENCES ai016_milestone_test.project_reports,version_number INT,change_type TEXT,change_summary TEXT,saved_by TEXT,report_payload JSONB);
 CREATE TABLE ai016_milestone_test.project_report_sources(id BIGSERIAL PRIMARY KEY,report_id BIGINT REFERENCES ai016_milestone_test.project_reports,source_type TEXT,file_name TEXT,transcript_text TEXT,transcript_length INT,transcript_sha256 TEXT);
 CREATE TABLE ai016_milestone_test.project_core_milestones(id BIGSERIAL PRIMARY KEY,project_id BIGINT,reporting_period_id BIGINT,category TEXT,milestone_name TEXT,baseline_finish_date DATE,forecast_finish_date DATE,sort_order INT,is_active BOOLEAN);
 CREATE TABLE ai016_milestone_test.project_report_health(id BIGSERIAL PRIMARY KEY,report_version_id BIGINT REFERENCES ai016_milestone_test.project_report_versions,area TEXT,status TEXT,trend TEXT,confidence NUMERIC,rationale TEXT);
 CREATE TABLE ai016_milestone_test.project_report_milestone_assessments(id BIGSERIAL PRIMARY KEY,report_version_id BIGINT REFERENCES ai016_milestone_test.project_report_versions,milestone_id BIGINT REFERENCES ai016_milestone_test.project_core_milestones,status TEXT CHECK(status IN ('completed','on_track','at_risk','blocked','delayed','not_started','unknown')),trend TEXT,confidence NUMERIC,summary TEXT,forecast_finish_date DATE);
 CREATE TABLE ai016_milestone_test.project_report_evidence(id BIGSERIAL PRIMARY KEY,report_version_id BIGINT REFERENCES ai016_milestone_test.project_report_versions,linked_type TEXT,linked_id BIGINT,evidence_text TEXT,speaker TEXT,turn_index INT,confidence NUMERIC);
 INSERT INTO ai016_milestone_test.projects VALUES(7,'Fixture'),(8,'Other project');
 INSERT INTO ai016_milestone_test.project_reporting_periods(project_id,period_type,period_label,start_date,end_date) VALUES(7,'quarter','Q4 2026','2026-10-01','2026-12-31');
 INSERT INTO ai016_milestone_test.project_core_milestones(id,project_id,milestone_name,is_active,baseline_finish_date) VALUES(201,7,'Data migration phase 1',TRUE,'2026-10-01'),(202,7,'Training',TRUE,'2026-11-01'),(301,8,'Data migration phase 1',TRUE,'2026-09-01');`);});
 test.after(async()=>{await pool.query('DROP SCHEMA IF EXISTS ai016_milestone_test CASCADE');await pool.end();});
 async function save(milestones,segments,tag){return db.saveProjectUpdateDraft({projectId:7,projectName:'Fixture',periodLabel:'Q4 2026',sourceType:'text',transcriptText:'Synthetic fixture '+tag,result:{segments,projectReport:{milestones}}});}
 const row=extra=>({milestoneId:201,milestone:'Data migration phase 1',comparison_key:'data_migration_phase_1',...extra});
 const other={milestone:'Unrelated area',delivery_status:'blocked',semantic_evidence:[{text:'Other area is blocked',score:.9}]};
 test('real persistence stores no carried-forward assessment/evidence and no wrong foreign key',async()=>{const r=await save([row({transcript_update_status:'carried_forward',delivery_status:'on_track'})],[other],'carried');assert.equal((await pool.query('SELECT count(*) FROM ai016_milestone_test.project_report_milestone_assessments WHERE report_version_id=$1',[r.reportVersionId])).rows[0].count,'0');assert.equal((await pool.query('SELECT count(*) FROM ai016_milestone_test.project_report_evidence WHERE report_version_id=$1',[r.reportVersionId])).rows[0].count,'0');});
 test('accepted semantic source stays attached to the canonical project ID, with zero confidence and null turn preserved',async()=>{const r=await save([row({milestone:'Cutover label',matchedBy:'semantic',transcript_update_status:'updated_from_transcript',delivery_status:'on_track',delivery_status_confidence:0,normalised_evidence_summary:'Cutover ready',semantic_evidence:[{text:'Cutover ready',score:0,turnIndex:null}]})],[other,{milestone:'Phase 1 data cutover',delivery_status:'on_track'}],'semantic');const a=(await pool.query('SELECT * FROM ai016_milestone_test.project_report_milestone_assessments WHERE report_version_id=$1',[r.reportVersionId])).rows[0],e=(await pool.query('SELECT * FROM ai016_milestone_test.project_report_evidence WHERE report_version_id=$1',[r.reportVersionId])).rows[0];assert.equal(a.milestone_id,'201');assert.equal(a.status,'on_track');assert.equal(Number(a.confidence),0);assert.equal(e.linked_id,'201');assert.equal(e.evidence_text,'Cutover ready');assert.equal(e.turn_index,null);assert.equal(Number(e.confidence),0);assert.equal((await pool.query('SELECT count(*) FROM ai016_milestone_test.project_core_milestones')).rows[0].count,'3');});
 test('cross-project ID is rejected without creating a report/version',async()=>{const before=(await pool.query('SELECT count(*) FROM ai016_milestone_test.project_reports')).rows[0].count;await assert.rejects(save([row({milestoneId:301,transcript_update_status:'updated_from_transcript',delivery_status:'blocked',evidence:['Source']})],[],'foreign'),/project/);assert.equal((await pool.query('SELECT count(*) FROM ai016_milestone_test.project_reports')).rows[0].count,before);});
 test('legacy named segments preserve their own source when report rows are absent',async()=>{const r=await save([],[{milestone:'Training',delivery_status:'complete',evidence:['Training delivered']}],'legacy');const a=(await pool.query('SELECT * FROM ai016_milestone_test.project_report_milestone_assessments WHERE report_version_id=$1',[r.reportVersionId])).rows[0];assert.equal(a.milestone_id,'202');assert.equal(a.status,'completed');});
 test('descriptive labels are retained as source, never tracked or presented as milestones',async()=>{
   const text='The files are "scattered across folders" and need tidying.';
   const segment={milestone:'Scattered across folders',excerpt:text,evidence:[text],delivery_status:'unknown'};
   const result={segments:[segment],projectReport:{milestones:[{...segment,transcript_update_status:'updated_from_transcript'}],keyUpdates:[text]}};
   const before=(await pool.query('SELECT count(*) FROM ai016_milestone_test.project_core_milestones')).rows[0].count;
   const saved=await db.saveProjectUpdateDraft({projectId:7,periodLabel:'Q4 2026',transcriptText:text,result});
   assert.equal((await pool.query('SELECT count(*) FROM ai016_milestone_test.project_core_milestones')).rows[0].count,before);
   const payload=(await pool.query('SELECT report_payload FROM ai016_milestone_test.project_report_versions WHERE id=$1',[saved.reportVersionId])).rows[0].report_payload;
   assert.deepEqual(payload.projectReport.milestones,[]);assert.deepEqual(payload.segments,[segment]);
   assert.deepEqual(payload.projectReport.keyUpdates,[text]);
   assert.equal(payload.projectReport.milestoneAdmission[0].reason,'no_source_creation_intent');
   assert.deepEqual(result.projectReport.milestones,[]);
   assert.equal((await pool.query('SELECT transcript_text FROM ai016_milestone_test.project_report_sources WHERE report_id=$1',[saved.reportId])).rows[0].transcript_text,text);
   assert.equal((await pool.query('SELECT count(*) FROM ai016_milestone_test.project_report_milestone_assessments WHERE report_version_id=$1',[saved.reportVersionId])).rows[0].count,'0');
 });
 test('actual Python generation and PostgreSQL reload preserve a genuine new milestone with unknown progress',async()=>{
   const {execFileSync}=require('node:child_process');
   const text='Alex: Add a new milestone called "Security sign-off".';
   const result=JSON.parse(execFileSync('python3',['-c','import sys,json; from scripts.project_update_minilm import build_project_update_output; print(json.dumps(build_project_update_output(sys.stdin.read(), use_minilm=False, use_rewrite=False)))'],{input:text,encoding:'utf8',cwd:require('node:path').resolve(__dirname,'..')}));
   assert.equal(result.projectReport.milestones.length,1);
   const saved=await db.saveProjectUpdateDraft({projectId:7,periodLabel:'Q4 2026',transcriptText:text,result});
   const a=(await pool.query('SELECT a.*,m.milestone_name,m.is_active FROM ai016_milestone_test.project_report_milestone_assessments a JOIN ai016_milestone_test.project_core_milestones m ON m.id=a.milestone_id WHERE a.report_version_id=$1',[saved.reportVersionId])).rows[0];
   assert.equal(a.milestone_name.toLowerCase().replace(/[^a-z0-9]+/g,' '),'security sign off');assert.equal(a.status,'unknown');assert.equal(a.is_active,true);
   const repeat=await db.saveProjectUpdateDraft({projectId:7,periodLabel:'Q4 2026',transcriptText:text,result});
   assert.equal(repeat.saved,false);
   assert.equal((await pool.query("SELECT count(*) FROM ai016_milestone_test.project_core_milestones WHERE regexp_replace(lower(milestone_name), '[^a-z0-9]+', ' ', 'g')='security sign off'")).rows[0].count,'1');
 });
 test('inactive names and separator variants cannot be recreated, assessed or reactivated',async()=>{
   await pool.query("INSERT INTO ai016_milestone_test.project_core_milestones(id,project_id,milestone_name,is_active) VALUES(401,7,'Validation phase 1',FALSE)");
   for(const name of ['Validation phase 1','Validation_phase_1']){
     const text='Add a milestone called "'+name+'".';
     const segment={milestone:name,evidence:[text],delivery_status:'in_progress'};
     const result={segments:[segment],projectReport:{milestones:[{...segment,transcript_update_status:'updated_from_transcript'}]}};
     const saved=await db.saveProjectUpdateDraft({projectId:7,periodLabel:'Q4 2026',transcriptText:text,result});
     assert.deepEqual(result.projectReport.milestones,[]);
     assert.equal(result.projectReport.milestoneAdmission[0].reason,'inactive_milestone');
     assert.equal((await pool.query('SELECT count(*) FROM ai016_milestone_test.project_report_milestone_assessments WHERE report_version_id=$1',[saved.reportVersionId])).rows[0].count,'0');
   }
   assert.equal((await pool.query('SELECT is_active FROM ai016_milestone_test.project_core_milestones WHERE id=401')).rows[0].is_active,false);
   assert.equal((await pool.query("SELECT count(*) FROM ai016_milestone_test.project_core_milestones WHERE milestone_name LIKE 'Validation%'")).rows[0].count,'1');
 });
 test('inactive IDs are rejected before creating report/version records',async()=>{
   const before=(await pool.query('SELECT count(*) FROM ai016_milestone_test.project_reports')).rows[0].count;
   await assert.rejects(save([{milestoneId:401,milestone:'Validation phase 1',evidence:['Source'],transcript_update_status:'updated_from_transcript'}],[],'inactive id'),/active milestone/);
   assert.equal((await pool.query('SELECT count(*) FROM ai016_milestone_test.project_reports')).rows[0].count,before);
 });
 test('inactive names are project-scoped and distinct work stays distinct',async()=>{
   const name='Validation phase 2',text='Add a new milestone called "'+name+'".',segment={milestone:name,evidence:[text]};
   await pool.query('INSERT INTO ai016_milestone_test.project_core_milestones(id,project_id,milestone_name,is_active) VALUES(402,8,$1,FALSE)',[name]);
   const saved=await db.saveProjectUpdateDraft({projectId:7,periodLabel:'Q4 2026',transcriptText:text,result:{segments:[segment],projectReport:{milestones:[{...segment,transcript_update_status:'updated_from_transcript'}]}}});
   assert.equal((await pool.query('SELECT count(*) FROM ai016_milestone_test.project_report_milestone_assessments WHERE report_version_id=$1',[saved.reportVersionId])).rows[0].count,'1');
   assert.equal((await pool.query('SELECT is_active FROM ai016_milestone_test.project_core_milestones WHERE id=402')).rows[0].is_active,false);
 });
 test('fabricated evidence and flags cannot authorise creation absent from the transcript',async()=>{
   const segment={milestone:'Fabricated milestone',creation_intent:true,evidence:['Add a milestone called "Fabricated milestone".']};
   const result={segments:[segment],projectReport:{milestones:[{...segment,transcript_update_status:'updated_from_transcript'}]}};
   await db.saveProjectUpdateDraft({projectId:7,periodLabel:'Q4 2026',transcriptText:'The team discussed file organisation.',result});
   assert.deepEqual(result.projectReport.milestones,[]);
   assert.equal((await pool.query("SELECT count(*) FROM ai016_milestone_test.project_core_milestones WHERE milestone_name='Fabricated milestone'")).rows[0].count,'0');
 });

 test('deactivation after preflight prevents recreation and removes the row from the saved report',async()=>{
   await pool.query("INSERT INTO ai016_milestone_test.project_core_milestones(id,project_id,milestone_name,is_active) VALUES(403,7,'Retire during save',TRUE)");
   await pool.query("CREATE FUNCTION ai016_milestone_test.retire_target() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN UPDATE ai016_milestone_test.project_core_milestones SET is_active=FALSE WHERE id=403; RETURN NEW; END $body$; CREATE TRIGGER retire_target BEFORE INSERT ON ai016_milestone_test.project_report_versions FOR EACH ROW EXECUTE FUNCTION ai016_milestone_test.retire_target()");
   try{
     const segment={milestoneId:403,milestone:'Retire during save',evidence:['Existing work is progressing.'],transcript_update_status:'updated_from_transcript'};
     const result={segments:[segment],projectReport:{milestones:[segment]}};
     const saved=await db.saveProjectUpdateDraft({projectId:7,periodLabel:'Q4 2026',transcriptText:'Existing work is progressing during concurrent deactivation.',result});
     assert.deepEqual(result.projectReport.milestones,[]);
     const payload=(await pool.query('SELECT report_payload FROM ai016_milestone_test.project_report_versions WHERE id=$1',[saved.reportVersionId])).rows[0].report_payload;
     assert.deepEqual(payload.projectReport.milestones,[]);
     assert.equal(payload.projectReport.milestoneAdmission[0].reason,'milestone_became_inactive');
     assert.equal((await pool.query('SELECT count(*) FROM ai016_milestone_test.project_report_milestone_assessments WHERE report_version_id=$1',[saved.reportVersionId])).rows[0].count,'0');
     assert.equal((await pool.query("SELECT count(*) FROM ai016_milestone_test.project_core_milestones WHERE milestone_name='Retire during save'")).rows[0].count,'1');
   }finally{await pool.query('DROP TRIGGER retire_target ON ai016_milestone_test.project_report_versions; DROP FUNCTION ai016_milestone_test.retire_target()');}
 });
 test('new admission decisions never rewrite an earlier approved report or its source',async()=>{
   const original=(await pool.query('SELECT id,report_id,report_payload FROM ai016_milestone_test.project_report_versions ORDER BY id LIMIT 1')).rows[0];
   await pool.query("UPDATE ai016_milestone_test.project_reports SET report_status='approved' WHERE id=$1",[original.report_id]);
   const source=(await pool.query('SELECT * FROM ai016_milestone_test.project_report_sources WHERE report_id=$1',[original.report_id])).rows;
   const text='Do not create a milestone called "Final approval".',segment={milestone:'Final approval',evidence:[text]};
   await db.saveProjectUpdateDraft({projectId:7,periodLabel:'Q4 2026',transcriptText:text,result:{segments:[segment],projectReport:{milestones:[{...segment,transcript_update_status:'updated_from_transcript'}]}}});
   assert.deepEqual((await pool.query('SELECT id,report_id,report_payload FROM ai016_milestone_test.project_report_versions WHERE id=$1',[original.id])).rows[0],original);
   assert.equal((await pool.query('SELECT report_status FROM ai016_milestone_test.project_reports WHERE id=$1',[original.report_id])).rows[0].report_status,'approved');
   assert.deepEqual((await pool.query('SELECT * FROM ai016_milestone_test.project_report_sources WHERE report_id=$1',[original.report_id])).rows,source);
 });
}
