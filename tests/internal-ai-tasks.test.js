'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const T=require('../utils/internalAiTasks'),I=require('../utils/internalAiTaskImport');
const snapshot=fs.readFileSync(path.join(__dirname,'../docs/CURRENT_PROJECT_STATUS.md'),'utf8');
test('scope uses the immutable ID and existing internal role, not names or supplied ownership',()=>{
 assert.doesNotThrow(()=>T.scope('19'));
 for(const id of [18,20,'019','19 OR true',undefined])assert.throws(()=>T.scope(id),e=>e.statusCode===404);
 assert.throws(()=>T.actor(null),e=>e.statusCode===401);
 assert.throws(()=>T.actor({userId:2,role:'client',fullName:'AI Team Development'}),e=>e.statusCode===403);
 assert.deepEqual(T.actor({userId:'1',role:'admin',fullName:'Actual Reviewer'}),{id:1,name:'Actual Reviewer'});
});
test('task forms reject guidance, identity, authorship and invalid enums/dates/links',()=>{
 for(const bad of [{title:'X',ai_implementation_guidance:{problem:'private'}},{title:'X',aiImplementationGuidance:{}},{title:'X',taskId:'AI-001'},{title:'X',projectId:20},{title:'X',createdBy:'Forged'},{title:'X',status:'Awaiting input'},{title:'X',priority:'P9'},{title:'X',category:'Meeting action'},{title:'X',dueDate:'2026-02-30'},{title:'X',sourceReferences:[{url:'javascript:alert(1)'}]},{title:'X',sourceReferences:[{url:'https://name:secret@example.test'}]}])assert.throws(()=>T.fields(bad));
 assert.throws(()=>T.fields({title:'X'},true));
 assert.deepEqual(T.fields({title:' Test ',owner:'',dueDate:'2026-02-28'}),{title:'Test',owner:'',dueDate:'2026-02-28'});
});
test('snapshot import proposal is exact, deduplicated, explicit about status mapping and no automatic synchronisation',()=>{
 const p=I.prepare(snapshot),stored=JSON.parse(fs.readFileSync(path.join(__dirname,'../docs/internal-ai-task-import-proposal.json')));
 assert.throws(()=>I.prepare(snapshot+'\nChanged after review'),/Snapshot changed/);
 assert.deepEqual(stored.plan,p);assert.equal(stored.approvalHash,I.digest(p));assert.equal(p.projectId,19);assert.equal(p.tasks.length,14);
 assert.deepEqual(p.tasks.map(t=>t.taskId),Array.from({length:14},(_,i)=>'AI-'+String(i+1).padStart(3,'0')));
 assert.deepEqual(p.tasks.reduce((a,t)=>(a[t.priority]=(a[t.priority]||0)+1,a),{}),{P0:4,P2:8,P3:2});
 assert.match(p.tasks.find(t=>t.taskId==='AI-005').description,/Original snapshot status: Awaiting input/);
 assert.equal(p.excluded[0].taskId,'AI-015');assert(!JSON.stringify(p).includes('ai_implementation_guidance'));
 const duplicate=structuredClone(p);duplicate.tasks.push(duplicate.tasks[0]);assert.throws(()=>I.validate(duplicate));
});
test('import requires exact reviewed plan approval before any database operation',async()=>{
 let calls=0;await assert.rejects(I.apply(async()=>{calls++;},I.prepare(snapshot),{userId:1,role:'admin'},'wrong'),/explicitly approved/);assert.equal(calls,0);
});
test('server wires existing authentication and SQL enforces project isolation independently of UI',()=>{
 const server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8'),sql=fs.readFileSync(path.join(__dirname,'../sql/migrations/20261026_add_internal_ai_tasks.sql'),'utf8');
 assert.match(server,/app\.use\('\/api\/project-update-test\/projects\/:projectId\/tasks', authRoutes\.requireAuth/);
 assert.match(sql,/CHECK \(project_id = 19\)/);assert.match(sql,/ai_implementation_guidance JSONB/);
});
