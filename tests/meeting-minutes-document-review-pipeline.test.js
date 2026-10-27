'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

Object.assign(process.env, {
  POWER_AUTOMATE_AGENT_WEBHOOK_URL: 'https://document-review.fixture.invalid',
  MEETING_MINUTES_AGENT_CORRECTNESS_V1: '1',
  MEETING_MINUTES_AGENT_CALL_START_GAP_MS: '1000',
  MEETING_MINUTES_AGENT_MAX_ACTIVE_CALLS: '4',
  MEETING_MINUTES_AGENT_ACTION_REFEREE_BATCH_SIZE: '8',
  MEETING_MINUTES_AGENT_PRIMARY_UNION_V1: '1',
  POWER_AUTOMATE_ACTION_DISCOVERY_WEBHOOK_URL: 'https://document-review-secondary.fixture.invalid',
  POWER_AUTOMATE_ACTION_DISCOVERY_ROUTE: 'second-leg',
  MEETING_MINUTES_AGENT_COMMITMENT_DEDUPE_V1: '0',
  MEETING_MINUTES_AGENT_FAST_ACTION_PATH_V1: '1',
  MEETING_MINUTES_AGENT_TIMING_CHECK_V1: '0',
  MEETING_MINUTES_AGENT_COMMITMENT_CHECK_V1: '0',
  MEETING_MINUTES_AGENT_ANSWERED_CHECK_V1: '0',
  MEETING_MINUTES_AGENT_DECISION_CHECK_V1: '0',
  MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1: '0',
  MEETING_MINUTES_AGENT_REPLAY_PASS_CACHE: '0',
  MEETING_MINUTES_AGENT_MINUTE_INSTRUCTION_V1: '1',
  MEETING_MINUTES_AGENT_SEMANTIC_RECONCILIATION_V1: 'off'
});
const forbidden = [];
const deny = label => () => { forbidden.push(label); throw new Error('Offline routine-minutes test forbids ' + label); };
for (const name of ['http', 'https', 'net', 'tls', 'dgram']) {
  const instance = require(name);
  for (const key of ['request', 'get', 'connect', 'createConnection', 'createServer', 'createSocket']) {
    if (typeof instance[key] === 'function') instance[key] = deny(name + '.' + key);
  }
}
global.fetch = deny('fetch');
let transport = deny('unexpected provider stub request');
const originalLoad = Module._load;
let router;
Module._load = function (name) {
  if (name === 'node-fetch') return (...args) => transport(...args);
  if (name === 'pg') return { Pool: class { constructor() { deny('pg.Pool')(); } } };
  if (name === 'child_process') return new Proxy({}, { get: (_, key) => deny('child_process.' + String(key)) });
  return originalLoad.apply(this, arguments);
};
try { router = require('../routes/api'); }
finally { Module._load = originalLoad; }
const A = router.stagedEvaluation;
const V = require('../utils/meetingMinutesAgentV2');
const copy = value => JSON.parse(JSON.stringify(value));
const units=V.normaliseSourceUnits([
 {id:'T0001',speaker:'Maya Patel',text:'The standard is 74216, covering portable pump requirements.'},
 {id:'T0002',speaker:'Maya Patel',text:'We can maybe get an assessment of that standard to see if it is applicable to the portable pump.'},
 {id:'T0003',speaker:'Maya Patel',text:'I will send the documents to Jo.'}
]);
const delivery={id:'delivery',action:'Send the documents to Jo.',owners:['Maya Patel'],evidenceIds:['T0003'],reviewFlagIds:[],timing:{kind:'not_stated',wording:'',exactDate:''}};
const assessment={...copy(delivery),id:'assessment',action:'Assess whether ISO 74216 is applicable to the portable pump.',evidenceIds:['T0002']};
for(const kind of ['prefix','warning'])for(const unavailable of ['primary','secondary']){
 test(`full offline generation/persistence/publication retains ${kind} with ${unavailable} unavailable`,{timeout:120000},async()=>{
  const requests=[];
  transport=async(url,options)=>{
   const prompt=JSON.parse(options.body).input.prompt;requests.push({url,marker:prompt.split('\n')[0]});
   let result;
   if(prompt.startsWith('ACTION_DISCOVERY')){
    const leg=url===process.env.POWER_AUTOMATE_ACTION_DISCOVERY_WEBHOOK_URL?'secondary':'primary';
    if(leg===unavailable)return{ok:false,status:503,text:async()=>JSON.stringify({error:'Fixture discovery unavailable'})};
    result={discussion:[],actions:[delivery],actionProposals:kind==='prefix'?[assessment]:[],reviewFlags:kind==='warning'?[{type:'unsupported_ownership',detail:'Assessment work is requested but acceptance and responsible owner are not explicitly confirmed.',evidenceIds:['T0002']}]:[]};
   }else if(prompt.startsWith('[ACTION_REFEREE]')){
    const p=JSON.parse(prompt.split('refereePayload:\n')[1]);
    const dispositions=p.candidateEnsemble.map(c=>({candidateId:c.candidateId,disposition:c.recordType==='action'&&(/send.*documents/i.test(c.text||c.record?.action||'')||(kind==='prefix'&&/assess.*74216/i.test(c.text||c.record?.action||'')))?'publish':'reject',reason:'Fixture deliberately publishes the assessment to exercise the app review boundary; delivery is explicit.',evidenceIds:c.evidenceIds}));
    result={requestId:p.requestId,stage:p.stage,expectedCandidateCount:p.expectedCandidateCount,returnedDispositionCount:dispositions.length,candidateDispositions:dispositions,discussion:[],actions:[],actionProposals:[]};
   }else result={discussion:[],actions:[],actionProposals:[],candidateDispositions:[],results:[]};
   return{ok:true,status:200,text:async()=>JSON.stringify(result)};
  };
  const draft={draftId:`document-pipeline-${kind}-${unavailable}`,revision:1,payloadVersion:V.PAYLOAD_VERSION,status:'draft',currentStep:2,
   details:{meetingTitle:`Document assessment ${kind} ${unavailable}`,meetingType:'Review',meetingDate:'2026-10-27',internalAttendees:['Maya Patel'],clientAttendees:[]},
   sourceUnits:copy(units),preparedTranscript:V.preparedTranscriptFromUnits(units),discussion:[],actions:[],reviewFlags:[],qualityState:{},passCache:[],candidateLedger:[],staleStages:[],changeHistory:[],redoHistory:[]};
  draft.candidateLedger=[{candidateId:'cached-delivery',sourcePass:'staged',recordType:'action',text:delivery.action,evidenceIds:delivery.evidenceIds,record:copy(delivery),timingInferenceVersion:V.TIMING_INFERENCE_POLICY_VERSION,timingInferenceInputKey:A.privateStagedCandidateCacheKey(draft,'actions')}];
  const generated=await A.generateHybridMeetingAgentStage(copy(draft),'actions');
  const key=kind==='prefix'?'documentReferenceContext':'sourceReviewContext';
  assert.ok(generated.reviewFlags.some(flag=>flag[key]),'generation must actually carry the source question');
  let saved=copy(draft);
  await A.persistMeetingAgentBackgroundStage({draftId:draft.draftId,userId:'fixture-reviewer',stage:'actions',sourceDraft:draft,result:generated,getDraft:async()=>copy(saved),saveDraft:async(_before,changes)=>{saved=copy({...saved,...changes,revision:saved.revision+1});return copy(saved);}});
  const visible=A.publicMeetingAgentDraft(copy(saved));
  assert.ok(visible.reviewFlags.some(flag=>flag[key]),'question survives background persistence and public projection');
  assert.ok(!visible.actions.some(row=>/ISO 74216/.test(row.action)),'unstated identity must not become an automatically published fact');
  if(kind==='prefix'){
   const original=saved.pendingProposal;
   if(original){
    original.changes.forEach(change=>{change.selected=true;});
    const auto=A.automaticMeetingAgentProposalReview(original,saved.reviewFlags,saved.actions,units);
    const accepted=V.applyProposal(saved.actions,original,auto.acceptedIds);
    assert.ok(!accepted.some(row=>/ISO 74216/.test(row.action)));
    assert.ok(auto.reviewFlags.some(flag=>flag.documentReferenceContext));
   }
  }
  assert.ok(requests.some(r=>r.marker==='ACTION_DISCOVERY'&&r.url===process.env.POWER_AUTOMATE_ACTION_DISCOVERY_WEBHOOK_URL));
  assert.ok(requests.some(r=>r.marker==='ACTION_DISCOVERY'&&r.url===process.env.POWER_AUTOMATE_AGENT_WEBHOOK_URL));
  assert.deepEqual(forbidden,[]);
 });
}
