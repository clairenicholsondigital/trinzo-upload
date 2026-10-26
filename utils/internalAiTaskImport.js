'use strict';
// Explicit operator tool only; never required by generation, approval or routes.
const crypto=require('node:crypto');
const {PROJECT_ID,fields,problem,actor}=require('./internalAiTasks');
const digest=value=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
function markdownRows(section){return section.split('\n').filter(s=>/^\| AI-\d{3} \|/.test(s)).map(s=>s.trim().slice(1,-1).split('|').map(c=>c.trim()));}
function plain(s){return s.replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/\*\*/g,'').replace(/`/g,'');}
const SNAPSHOT_SHA256='7d8c16a468be2e9bc698931550b839f3c3490c37a57fa25d5e8adb2641c994bc';
function prepare(markdown) {
  if(digest(markdown)!==SNAPSHOT_SHA256)throw problem('Snapshot changed. Review a new import proposal rather than silently reusing the initial mapping.');
  const delivery=markdown.split('### Delivery fields')[1]?.split('### Evidence, ownership and next actions')[0];
  const evidence=markdown.split('### Evidence, ownership and next actions')[1]?.split('## 11.')[0];
  if(!delivery||!evidence)throw problem('Snapshot register sections were not found.');
  const a=markdownRows(delivery),b=markdownRows(evidence);
  if(!a.length||a.length!==b.length||new Set(a.map(r=>r[0])).size!==a.length||new Set(b.map(r=>r[0])).size!==b.length)throw problem('Ambiguous snapshot register.');
  const tasks=[],excluded=[];
  for(const row of a){const[id,title,area,priority,status,category]=row,detail=b.find(r=>r[0]===id);if(row.length!==7||!detail||detail.length!==7)throw problem('Ambiguous task row.');
    // This decision has been fulfilled by the explicit feature request. Do not
    // create an outstanding task asking for permission already received.
    if(id==='AI-015'){excluded.push({taskId:id,reason:'Separate implementation approval was given in the current request; this decision is satisfied.'});continue;}
    if(status==='Done'){excluded.push({taskId:id,reason:'Already completed in the source.'});continue;}
    const titleText=plain(title),boundary=titleText.indexOf('. '),sourceReferences=[{label:'Project status snapshot',url:'https://github.com/clairenicholsondigital/trinzo-upload/blob/01b292494796bfece62f59ee162d7384c1353f1e/docs/CURRENT_PROJECT_STATUS.md'}];
    for(const match of (detail[1]+' '+detail[2]).matchAll(/\[([^\]]+)\]\((https:\/\/[^)]+|#[^)]+)\)/g)) { const url=match[2].startsWith('#')?sourceReferences[0].url+match[2]:match[2]; if(!sourceReferences.some(ref=>ref.url===url))sourceReferences.push({label:match[1],url}); }
    const description=[titleText,'Area: '+area,'Evidence: '+plain(detail[1]),'Existing work: '+plain(detail[2]),'Dependencies: '+plain(detail[4]),'Next action: '+plain(detail[5]),'External input: '+detail[6],...(status==='Awaiting input'?['Original snapshot status: Awaiting input. Imported as To do; input or a decision is still required.']:[])].join('\n\n');
    const task={taskId:id,...fields({title:boundary<0?titleText:titleText.slice(0,boundary),description,status:status==='Awaiting input'?'To do':status,priority,category,owner:detail[3]==='Unassigned'?'':plain(detail[3]),dueDate:null,sourceReferences})};tasks.push(task);
  }
  return {version:1,projectId:PROJECT_ID,snapshotSha256:digest(markdown),tasks,excluded};
}
function validate(plan){
  if(plan?.version!==1||plan.projectId!==PROJECT_ID||!/^[a-f0-9]{64}$/.test(plan.snapshotSha256)||!Array.isArray(plan.tasks)||!plan.tasks.length)throw problem('Invalid import plan.');
  const seen=new Set();
  for(const task of plan.tasks){if(!/^AI-\d{3,}$/.test(task.taskId)||seen.has(task.taskId))throw problem('Duplicate or invalid import task ID.');seen.add(task.taskId);const{taskId,...body}=task;fields(body);}
}
async function apply(query,plan,user,approvedHash){
  validate(plan);if(approvedHash!==digest(plan))throw problem('The exact import plan hash must be explicitly approved.');
  const a=actor(user);
  // All-or-nothing single statement; reruns skip existing stable IDs and never
  // overwrite descriptions, statuses, owners, guidance or comments.
  const payload=plan.tasks.map(t=>({...t,sourceReferences:JSON.stringify(t.sourceReferences)}));
  const r=await query(`INSERT INTO internal_ai_tasks(project_id,task_key,title,description,status,priority,category,owner,due_date,source_references,created_by,created_by_name,updated_by,updated_by_name,completed_at,import_source)
    SELECT $1,x."taskId",x.title,x.description,x.status,x.priority,x.category,x.owner,x."dueDate"::date,x."sourceReferences"::jsonb,$3,$4,$3,$4,CASE WHEN x.status='Done' THEN NOW() ELSE NULL END,$5
    FROM jsonb_to_recordset($2::jsonb) AS x("taskId" text,title text,description text,status text,priority text,category text,owner text,"dueDate" text,"sourceReferences" text)
    ON CONFLICT(project_id,task_key) DO NOTHING RETURNING task_key`,[PROJECT_ID,JSON.stringify(payload),a.id,a.name,'snapshot:'+plan.snapshotSha256]);
  return {inserted:r.rows.map(x=>x.task_key),skipped:plan.tasks.filter(t=>!r.rows.some(x=>x.task_key===t.taskId)).map(t=>t.taskId)};
}
module.exports={prepare,validate,apply,digest};
