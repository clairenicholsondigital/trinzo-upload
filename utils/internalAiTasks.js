'use strict';
// Deliberately not a generic task system. The database and every HTTP operation
// are restricted to this persistent project ID, independently of its name.
const PROJECT_ID = 19;
const STATUSES = ['To do', 'In progress', 'Blocked', 'Done'];
const AFFECTED_TOOLS = ['', 'Project updates', 'Meeting minutes', 'Shared'];
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const CATEGORIES = ['Technical', 'Usability', 'Validation', 'Decision', 'External dependency', 'Research'];
function problem(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function actor(user) {
  if (!user || !Number.isSafeInteger(Number(user.userId)) || Number(user.userId) < 1) throw problem('Sign in to use Tasks.', 401);
  if (user.role !== 'admin') throw problem('Tasks are available to internal Trinzo users only.', 403);
  return { id: Number(user.userId), name: String(user.fullName || user.email || 'Trinzo user').slice(0, 240) };
}
function scope(projectId) { if (String(projectId) !== String(PROJECT_ID)) throw problem('Tasks are not available for this project.', 404); }
function text(value, max, label, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw problem(`${label} is required or is too long.`);
  return value.trim();
}
function references(value) {
  if (!Array.isArray(value) || value.length > 20) throw problem('Use at most 20 source links.');
  return value.map(ref => {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref) || Object.keys(ref).some(k => !['label','url'].includes(k))) throw problem('Invalid source link.');
    const url = text(ref.url, 2000, 'Source URL', true);
    let parsed; try { parsed = new URL(url); } catch (_) { throw problem('Source links must be full HTTPS URLs.'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw problem('Source links must be HTTPS URLs without credentials.');
    return { label: text(ref.label || url.slice(0,240), 240, 'Source label', true), url };
  });
}
const editable = ['title','description','nextAction','currentImplications','planToFix','fixDetails','affectedTool','status','priority','category','owner','dueDate','sourceReferences'];
function fields(body, patch = false) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !editable.includes(k) && !(patch && k === 'revision'))) throw problem('Unsupported task fields.');
  if (patch && (!Number.isSafeInteger(body.revision) || body.revision < 1)) throw problem('Reload the task before saving it.');
  const out = {};
  for (const key of editable) {
    if (!Object.hasOwn(body,key)) continue;
    const v = body[key];
    if (key === 'sourceReferences') out[key] = references(v);
    else if (key === 'dueDate') {
      if (v === '' || v === null) out[key] = null;
      else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v) out[key] = v;
      else throw problem('Choose a valid due date.');
    } else if (['status','priority','category','affectedTool'].includes(key)) {
      const allowed = key === 'status' ? STATUSES : key === 'priority' ? PRIORITIES : key === 'affectedTool' ? AFFECTED_TOOLS : CATEGORIES;
      if (!allowed.includes(v)) throw problem(`Choose a valid ${key}.`); out[key] = v;
    } else out[key] = text(v, key === 'nextAction' ? 2000 : ['description','currentImplications','planToFix','fixDetails'].includes(key) ? 20000 : 240, key, key === 'title');
  }
  if (!patch && !out.title) throw problem('Enter a task title.');
  if (patch && !Object.keys(out).length) throw problem('No task changes supplied.');
  return out;
}
// This allowlist, used for every browser-facing query, deliberately excludes
// root cause, implementation guidance and import metadata. Neither private field has an HTTP API.
const PUBLIC_COLUMNS = `task_key AS "taskId", project_id AS "projectId", title, description, next_action AS "nextAction", affected_tool AS "affectedTool", current_implications AS "currentImplications", plan_to_fix AS "planToFix", fix_details AS "fixDetails", status, priority, category, owner,
  due_date::text AS "dueDate", source_references AS "sourceReferences", revision,
  created_by_name AS "createdBy", updated_by_name AS "updatedBy", created_at AS "createdAt", updated_at AS "updatedAt", completed_at AS "completedAt"`;
function createStore(query) {
  async function access() { if (!(await query('SELECT id FROM projects WHERE id = $1', [PROJECT_ID])).rows.length) throw problem('Internal AI project not found.',404); }
  async function get(taskId) {
    if (!/^AI-\d{3,}$/.test(String(taskId))) throw problem('Task not found.',404);
    const task = (await query(`SELECT ${PUBLIC_COLUMNS} FROM internal_ai_tasks WHERE project_id=$1 AND task_key=$2`,[PROJECT_ID,taskId])).rows[0];
    if (!task) throw problem('Task not found.',404);
    const comments = (await query(`SELECT c.id::text, c.body, c.author_name AS author, c.created_at AS "createdAt"
      FROM internal_ai_task_comments c JOIN internal_ai_tasks t ON t.id=c.task_id
      WHERE t.project_id=$1 AND t.task_key=$2 ORDER BY c.created_at,c.id`,[PROJECT_ID,taskId])).rows;
    return { ...task, comments };
  }
  async function list(filters = {}) {
    if (Object.keys(filters).some(k => !['status','priority','category','showCompleted'].includes(k))) throw problem('Unsupported task filter.');
    for (const [key, allowed] of [['status',STATUSES],['priority',PRIORITIES],['category',CATEGORIES]]) if (filters[key] && !allowed.includes(filters[key])) throw problem(`Invalid ${key} filter.`);
    if (filters.showCompleted && !['true','false'].includes(filters.showCompleted)) throw problem('Invalid completed filter.');
    const result = await query(`SELECT ${PUBLIC_COLUMNS} FROM internal_ai_tasks WHERE project_id=$1
      AND ($2::text IS NULL OR status=$2) AND ($3::text IS NULL OR priority=$3) AND ($4::text IS NULL OR category=$4)
      AND ($5::boolean OR status <> 'Done') ORDER BY priority,created_at,task_key`,
      [PROJECT_ID,filters.status||null,filters.priority||null,filters.category||null,filters.showCompleted === 'true' || filters.status === 'Done']);
    const counts = Object.fromEntries(STATUSES.map(s=>[s,0]));
    for (const row of (await query('SELECT status, count(*)::integer AS count FROM internal_ai_tasks WHERE project_id=$1 GROUP BY status',[PROJECT_ID])).rows) counts[row.status] = row.count;
    return { tasks:result.rows, counts };
  }
  async function create(body,user) {
    const a=actor(user),f=fields(body);
    const result=await query(`WITH n AS (SELECT nextval('internal_ai_task_number_seq')::text AS value)
      INSERT INTO internal_ai_tasks(project_id,task_key,title,description,status,priority,category,owner,due_date,source_references,created_by,created_by_name,updated_by,updated_by_name,completed_at,current_implications,plan_to_fix,fix_details,next_action,affected_tool)
      SELECT $1,'AI-'||lpad(n.value,greatest(3,length(n.value)),'0'),$2,$3,$4,$5,$6,$7,$8::date,$9::jsonb,$10,$11,$10,$11,CASE WHEN $4='Done' THEN NOW() ELSE NULL END,$12,$13,$14,$15,$16 FROM n
      RETURNING task_key`,[PROJECT_ID,f.title,f.description||'',f.status||'To do',f.priority||'P2',f.category||'Technical',f.owner||'',f.dueDate||null,JSON.stringify(f.sourceReferences||[]),a.id,a.name,f.currentImplications||'',f.planToFix||'',f.fixDetails||'',f.nextAction||'',f.affectedTool||'']);
    return get(result.rows[0].task_key);
  }
  async function update(taskId,body,user) {
    const a=actor(user),f=fields(body,true),map={affectedTool:'affected_tool',nextAction:'next_action',currentImplications:'current_implications',planToFix:'plan_to_fix',fixDetails:'fix_details',dueDate:'due_date',sourceReferences:'source_references'};
    const params=[PROJECT_ID,taskId,body.revision,a.id,a.name];
    const assignments=Object.entries(f).map(([key,value])=>{params.push(key==='sourceReferences'?JSON.stringify(value):value);return `${map[key]||key}=$${params.length}${key==='sourceReferences'?'::jsonb':key==='dueDate'?'::date':''}`;});
    if (Object.hasOwn(f,'status')) {params.push(f.status);assignments.push(`completed_at=CASE WHEN $${params.length}='Done' THEN COALESCE(completed_at,NOW()) ELSE NULL END`);}
    const r=await query(`UPDATE internal_ai_tasks SET ${assignments.join(',')},updated_at=NOW(),updated_by=$4,updated_by_name=$5,revision=revision+1
      WHERE project_id=$1 AND task_key=$2 AND revision=$3 RETURNING task_key`,params);
    if (!r.rows.length) {await get(taskId);throw problem('This task changed elsewhere. Reload the task, then retry your changes.',409);}
    return get(taskId);
  }
  async function comment(taskId,body,user) {
    const a=actor(user);
    if (!body || Object.keys(body).some(k=>k!=='body')) throw problem('Unsupported comment fields.');
    const value=text(body.body,8000,'Comment',true);
    const r=await query(`INSERT INTO internal_ai_task_comments(task_id,author_id,author_name,body)
      SELECT id,$3,$4,$5 FROM internal_ai_tasks WHERE project_id=$1 AND task_key=$2 RETURNING id`,[PROJECT_ID,taskId,a.id,a.name,value]);
    if (!r.rows.length) throw problem('Task not found.',404);
    return get(taskId);
  }
  return {access,get,list,create,update,comment};
}
module.exports={PROJECT_ID,STATUSES,PRIORITIES,CATEGORIES,AFFECTED_TOOLS,actor,scope,fields,references,problem,createStore};
