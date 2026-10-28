'use strict';
// Integration only: no extraction, semantic repair, merging, or extra model calls.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {STAGES, hash, runSpecialists} = require('./meetingMinutesParallelEngine');
const PROVIDER = 'parallel-specialists-v1';
const isParallel = draft => draft?.generationProvider === PROVIDER;
const clone = value => structuredClone(value);
const problem = (message, statusCode = 422) => Object.assign(new Error(message), {statusCode});
const PAYLOAD_FIELDS = [
  'schemaVersion','payloadVersion','transcriptSha256','uploadSizeBytes','denoise','sourceUnits',
  'preparedTranscript','salientDetails','details','discussion','actions','reviewFlags','pendingProposal',
  'changeHistory','redoHistory','staleStages','steer','executiveSummary','meetingObjectives',
  'candidateLedger','passProvenance','passCache','qualityState','generation','currentStep','selectedStep',
  'includeSections','keptActionIds','keptActionOccurrenceIds','removedActions','unassignedSupportingDetails',
  'excludedSupportingDetails','parallelActionProposals','executiveSummaryEvidenceIds'
];
function payload(draft) {
  const result = {generationProvider:PROVIDER, schemaVersion:1, payloadVersion:5};
  for (const field of PAYLOAD_FIELDS) if (draft[field] !== undefined) result[field] = clone(draft[field]);
  return result;
}
function publicDraft(draft, options = {}) {
  const result = {draftId:draft.draftId, revision:draft.revision, status:draft.status,
    title:draft.title, fileName:draft.fileName, createdAt:draft.createdAt, updatedAt:draft.updatedAt,
    linkedProjectId:draft.linkedProjectId, ...payload(draft)};
  for (const key of ['preparedTranscript','salientDetails','candidateLedger','passProvenance','passCache','qualityState','changeHistory','redoHistory']) delete result[key];
  const generation = draft.generation;
  const staleRun = generation?.status === 'running' && Date.now() - Date.parse(generation.startedAt) > 240000;
  result.generation = generation ? {stage:generation.stage, status:staleRun?'failed':generation.status,
    startedAt:generation.startedAt, error:staleRun?'Generation was interrupted. Try again.':generation.error || '',
    message:generation.message || '', completedPasses:[], callTimings:[]} : null;
  result.generatedStages = Object.fromEntries(STAGES.map(stage=>[stage,draft.qualityState?.[stage]?.completedAt || '']));
  result.actionsPrewarm = null; result.speculation = null; result.qualityNotice = '';
  result.stageLabel = ['Upload','Focus','Discussion','Actions','Summary','Review'][draft.currentStep || 0];
  result.changeHistoryCount = draft.changeHistory?.length || 0;
  const last = draft.changeHistory?.at(-1), redo = draft.redoHistory?.at(-1);
  result.lastUndo = last ? {id:last.id,label:last.label,createdAt:last.createdAt} : null;
  result.lastRedo = redo ? {id:redo.id,label:redo.label,createdAt:redo.createdAt} : null;
  result.canRestoreCombinedActions = false; result.canRestoreCombinedDiscussion = false;
  result.filingReview = {occurrences:[]};
  if (options.summary) return {draftId:result.draftId,revision:result.revision,status:result.status,
    title:result.details?.meetingTitle || result.title,fileName:result.fileName,currentStep:result.currentStep,
    stageLabel:result.stageLabel,generation:result.generation,
    openFlagCount:(result.reviewFlags || []).filter(f=>f.status==='open').length,
    createdAt:result.createdAt,updatedAt:result.updatedAt,
    resumeUrl:'/meeting-minutes-agent?draftId='+encodeURIComponent(result.draftId)};
  return result;
}
function publication(draft) {
  return clone({details:draft.details || {}, executiveSummary:draft.executiveSummary || '',
    meetingObjectives:draft.meetingObjectives || [], discussion:draft.discussion || [],
    actions:draft.actions || [], reviewFlags:draft.reviewFlags || []});
}
function configuration() {
  const filename = process.env.MEETING_MINUTES_PARALLEL_CONFIG;
  if (!filename) throw problem('The parallel minutes service is not configured.',503);
  let config;
  try { config = JSON.parse(fs.readFileSync(filename,'utf8')); }
  catch { throw problem('The parallel minutes service configuration could not be loaded.',503); }
  for (const stage of STAGES) {
    const instructionFile = stage === 'discussion' && config[stage]?.format === 'flat-v1' ? 'discussion-flat.txt' : stage+'.txt';
    const expected = hash(fs.readFileSync(path.join(__dirname,'../config/meeting-minutes-parallel',instructionFile),'utf8'));
    if (config[stage]?.instructionsSha256 !== expected || !config[stage]?.published)
      throw problem('The parallel minutes instruction version has not been verified.',503);
    let url; try { url = new URL(config[stage].webhookUrl); } catch {}
    if (url?.protocol !== 'https:') throw problem('The parallel minutes service is not configured.',503);
  }
  return config;
}
function chooseProvider(req) {
  const requested = req.body?.generationProvider;
  if (requested && !['legacy',PROVIDER].includes(requested)) throw problem('Unknown minutes generation method.',400);
  if (requested === PROVIDER && req.authUser?.role !== 'admin') throw problem('The minutes preview is available to administrators.',403);
  const useParallel = requested ? requested === PROVIDER : process.env.MEETING_MINUTES_AGENT_GENERATOR === 'parallel';
  if (useParallel) configuration(); // fail before creating a draft, never silently fall back
  return useParallel ? PROVIDER : 'legacy';
}
// Deployment-controlled source retention, applied only when preparing a new Beta draft.
function preserveMeaningfulShortAnswers(provider, env = process.env) {
  return provider === PROVIDER
    && /^(?:1|true|yes|on)$/i.test(String(env.MEETING_MINUTES_BETA_SHORT_ANSWERS_V1 || '0'));
}
function packet(draft) {
  return {schemaVersion:1,meetingDetails:clone(draft.details),evidence:(draft.sourceUnits || [])
    .filter(unit=>unit.classification!=='remove' || unit.restored)
    .map(({id,speaker,timestamp,text})=>({id,speaker,timestamp,text}))};
}
function inputHash(draft) {
  return hash({packet:packet(draft),steer:draft.steer || '',discussion:draft.discussion || [],
    actions:draft.actions || [],executiveSummary:draft.executiveSummary || '',meetingObjectives:draft.meetingObjectives || []});
}
function initialPayload(draft) {
  return payload({...draft,discussion:[],actions:[],executiveSummary:'',executiveSummaryEvidenceIds:[],meetingObjectives:[],
    parallelActionProposals:[],pendingProposal:null,changeHistory:[],redoHistory:[],
    keptActionIds:[],keptActionOccurrenceIds:[],removedActions:[],unassignedSupportingDetails:[],
    excludedSupportingDetails:[],currentStep:0,selectedStep:0,staleStages:[],generation:null,
    reviewFlags:(draft.reviewFlags || []).filter(f=>f.id==='meeting-date-source-check'),
    qualityState:{preparation:clone(draft.qualityState?.preparation || {})}});
}
function resultChanges(draft, result) {
  if (result.status!=='completed') throw problem('One or more minutes sections could not be generated. Your saved content is unchanged. Try again.',502);
  const completedAt = new Date().toISOString();
  const qualityState = {...draft.qualityState,parallel:{completedAt,packetHash:result.packetHash,
    branches:result.branches,parallelElapsedMs:result.parallelElapsedMs}};
  for (const stage of STAGES) qualityState[stage] = {completedAt,stageElapsedMs:result.branches[stage].elapsedMs,provider:PROVIDER};
  const flags = result.minutes.reviewFlags.map((f,index)=>({id:'parallel-flag-'+index,kind:f.kind,
    message:f.message,evidenceIds:f.evidenceIds,status:'open',note:'',stage:f.specialist}));
  const proposals = result.minutes.actionProposals.map((a,index)=>({...a,id:'parallel-proposal-'+index,status:'open'}));
  return {discussion:result.minutes.discussion,actions:result.minutes.actions,
    executiveSummary:result.minutes.executiveSummary,executiveSummaryEvidenceIds:result.minutes.executiveSummaryEvidenceIds,
    meetingObjectives:result.minutes.meetingObjectives,
    parallelActionProposals:proposals,reviewFlags:[...(draft.reviewFlags || []),...flags],
    qualityState,pendingProposal:null,generation:null,staleStages:[],currentStep:Math.max(2,draft.currentStep || 0)};
}
const active = new Map();
function createRunner({getDraft,saveDraft,execute=runSpecialists,config=configuration,bootId='parallel'}) {
  async function run(source,userId) {
    const requestId = source.generation.requestId, startedHash = inputHash(source);
    let result = null, failure = null;
    try { result = await execute(packet(source),config(),{requestId}); }
    catch { failure = problem('The minutes service could not complete this request. Your saved content is unchanged. Try again.',502); }
    // Revision retries concern database contention only; they never rerun Microsoft.
    for (let attempt=0;attempt<4;attempt++) {
      const fresh = await getDraft(source.draftId,userId,{includeTranscript:true});
      if (!fresh || fresh.generation?.requestId!==requestId) return;
      let changes;
      if (failure || result?.status!=='completed' || inputHash(fresh)!==startedHash) {
        changes = {generation:{...fresh.generation,status:'failed',
          error:inputHash(fresh)!==startedHash
            ? 'The meeting content changed during generation. Your edits were kept. Generate a new draft to use them.'
            : failure?.message || 'One or more sections failed. Your saved content is unchanged. Try again.'},
          qualityState:{...fresh.qualityState,parallelAttempt:{requestId,result}}};
      } else changes = resultChanges(fresh,result);
      try { return await saveDraft(fresh,userId,changes); }
      catch (error) { if (error.statusCode!==409 || attempt===3) throw error; }
    }
  }
  async function start(draft,userId) {
    if (active.has(String(draft.draftId))) return getDraft(draft.draftId,userId,{includeTranscript:true});
    // Save is optimistic: only one request may claim this revision.
    const generation = {stage:'discussion',status:'running',bootId,requestId:crypto.randomUUID(),
      startedAt:new Date().toISOString(),message:'Preparing your meeting minutes…',error:''};
    const saved = await saveDraft(draft,userId,{generation});
    const task = new Promise(resolve=>setImmediate(resolve)).then(()=>run(saved,userId))
      .catch(()=>{}).finally(()=>active.delete(String(draft.draftId)));
    active.set(String(draft.draftId),task);
    return saved;
  }
  return {start,run,active};
}
const EDIT_FIELDS = ['discussion','actions','meetingObjectives','executiveSummary','steer','unassignedSupportingDetails',
  'keptActionIds','keptActionOccurrenceIds','removedActions','includeSections','currentStep','selectedStep','status'];
function reviewChanges(draft,body,{sanitiseDetails,historyEntry}={}) {
  const changes = {};
  for (const key of EDIT_FIELDS) if (Object.hasOwn(body,key)) changes[key] = clone(body[key]);
  if (body.details) changes.details = sanitiseDetails ? sanitiseDetails(body.details) : clone(body.details);
  const next = {...draft,...changes};
  const ids = new Set((draft.sourceUnits || []).map(e=>e.id));
  const boundedText = (value,limit=12000) => typeof value==='string' && value.length<=limit;
  function record(item,textKey='text') {
    if (!item || !boundedText(item[textKey]) || !boundedText(item.id,180)) throw problem('An edited minutes record is invalid.');
    if (!Array.isArray(item.evidenceIds) || item.evidenceIds.some(id=>!ids.has(id))) throw problem('An edited record cites an unknown source.');
    if (item.supportingDetails) item.supportingDetails.forEach(r=>record(r));
  }
  if (!boundedText(next.executiveSummary || '') || !boundedText(next.steer || '',4000)) throw problem('The edited text is too long.');
  for (const key of ['discussion','actions','meetingObjectives','removedActions','unassignedSupportingDetails','keptActionIds','keptActionOccurrenceIds']) {
    if (!Array.isArray(next[key] || []) || (next[key] || []).length>500) throw problem('The edited minutes contain too many records.');
  }
  for (const topic of next.discussion || []) {
    if (!boundedText(topic.topic,1000)) throw problem('An edited topic is invalid.');
    for (const kind of ['points','decisions','openQuestions']) {
      if (!Array.isArray(topic[kind])) throw problem('An edited discussion section is invalid.');
      topic[kind].forEach(r=>record(r));
    }
  }
  for (const a of next.actions || []) {
    record(a,'action');
    if (!Array.isArray(a.owners) || a.owners.some(o=>!boundedText(o,240))) throw problem('An action owner is invalid.');
    if (!a.timing || !['deadline','target','dependency','not_stated','stated'].includes(a.timing.kind)
      || !boundedText(a.timing.wording,1000) || !boundedText(a.timing.exactDate,20)) throw problem('An action timing field is invalid.');
  }
  (next.meetingObjectives || []).forEach(r=>record(r));
  // Warning provenance/message is immutable; reviewer status and notes are editable.
  if (body.reviewFlags) {
    if (!Array.isArray(body.reviewFlags)) throw problem('Review checks are invalid.');
    const submitted = new Map(body.reviewFlags.map(f=>[f.id,f]));
    changes.reviewFlags = (draft.reviewFlags || []).map(f=>{
      const edit = submitted.get(f.id);
      if (!edit) return f;
      if (!['open','confirmed','corrected','dismissed','resolved','rejected'].includes(edit.status)
        || !boundedText(edit.note || '',4000) || !boundedText(edit.correctionNote || '',4000)) throw problem('A review decision is invalid.');
      return {...f,status:edit.status,note:edit.note || '',correctionNote:edit.correctionNote || ''};
    });
  }
  changes.currentStep = Math.max(draft.currentStep || 0,Math.min(5,Math.max(0,Number(next.currentStep)||0)));
  changes.selectedStep = Math.min(changes.currentStep,Math.max(0,Number(next.selectedStep)||0));
  changes.staleStages = [...(draft.staleStages || [])];
  if (hash(next.details)!==hash(draft.details) || (next.steer || '')!==(draft.steer || ''))
    changes.staleStages = STAGES.filter(stage=>draft.qualityState?.[stage]?.completedAt);
  // Independent sections are not invalidated by an edit to another section.
  if (body.reviewDecisionLabel && historyEntry) {
    changes.changeHistory = [...(draft.changeHistory || []),historyEntry(draft,body.reviewDecisionLabel)].slice(-30);
    changes.redoHistory = [];
  }
  return changes;
}
module.exports = {PROVIDER,isParallel,payload,publicDraft,publication,configuration,chooseProvider,preserveMeaningfulShortAnswers,
  packet,inputHash,initialPayload,resultChanges,createRunner,reviewChanges};
