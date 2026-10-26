'use strict';
process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1='0';
const test=require('node:test'),assert=require('node:assert/strict'),JSZip=require('jszip');
const F=require('../utils/meetingMinutesActionPhaseCorrection'),V=require('../utils/meetingMinutesAgentV2');
const fixture=require('./helpers/action-phase-fixture'),provider=require('./helpers/action-phase-provider');
const db=require('../utils/db'),oldGet=db.getMeetingMinutesAgentDraft,oldUpdate=db.updateMeetingMinutesAgentDraft;
let saved,writes=0,originals;
db.getMeetingMinutesAgentDraft=async(id,user)=>id===saved.draftId&&user==='reviewer'?structuredClone(saved):null;
db.updateMeetingMinutesAgentDraft=async(id,user,revision,change)=>{
 assert.equal(user,'reviewer');assert.equal(revision,saved.revision);
 saved={...V.migrateDraftPayload(structuredClone(change.payload)),draftId:id,revision:revision+1,status:change.status||'draft'};writes++;
 return structuredClone(saved);
};
const router=require('../routes/api'),A=router.stagedEvaluation;
test.after(()=>{db.getMeetingMinutesAgentDraft=oldGet;db.updateMeetingMinutesAgentDraft=oldUpdate;});
async function reset(){
 const f=fixture();originals=structuredClone(f.actions);
 const draft={draftId:'phase-draft',revision:1,payloadVersion:V.PAYLOAD_VERSION,status:'draft',
 details:{meetingTitle:'Quality review',meetingDate:'2026-06-15',internalAttendees:['Morgan Lee'],clientAttendees:[]},
 sourceUnits:f.units,rawTranscript:f.units.map(u=>u.text).join('\n'),preparedTranscript:V.preparedTranscriptFromUnits(f.units),
 actions:f.actions,discussion:[],meetingObjectives:[],executiveSummary:'Review preparations.',staleStages:[],
 reviewFlags:f.actions.flatMap(a=>a.reviewFlagIds.map(id=>({id,kind:'timing',status:'open',message:'Timing requires review.',evidenceIds:['T0003']}))),
 qualityState:{preparation:{dateContext:{source:'reviewer',meetingDate:'2026-06-15'}}}};
 const result=await F.correct(f.actions,f.units,{meetingDate:'2026-06-15',ask:provider(f)});
 assert.equal(result.audit.applied,true);
 const changes=A.admitMeetingAgentGeneratedActionChanges(draft,{actions:result.actions,qualityState:{...draft.qualityState,actions:{actionPhaseCorrection:result.audit}}},'phase-proof');
 saved={...A.meetingAgentDraftPayload({...draft,...changes}),draftId:draft.draftId,revision:1,status:'draft'};writes=0;
}
async function request(method,suffix='',body={},userId='reviewer'){
 const route=router.stack.find(l=>l.route?.path==='/meeting-minutes-agent/drafts/:draftId'+suffix&&l.route.methods[method])?.route;assert.ok(route);
 const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
 await route.stack.at(-1).handle({params:{draftId:saved.draftId},authUser:{userId},body:{revision:saved.revision,...body}},res);return res;
}
test('admission, owned save/reload, Word and PDF retain the two distinct phases and private proof',async()=>{
 await reset();const audit=structuredClone(saved.qualityState.actions.actionPhaseCorrection);
 assert.equal(F.valid(audit.receipts[0],saved.actions,saved.sourceUnits,'2026-06-15'),true);
 const first=await request('get');assert.equal(first.statusCode,200);
 assert.equal(first.body.draft.canRestorePhaseActions,true);assert.equal(first.body.draft.qualityState,undefined);
 assert.match(first.body.draft.actions[0].action,/^Tidy and share/);
 assert.equal(A.reconcileFinalApprovedActions(saved.actions,originals,{phaseReceipts:audit.receipts,sourceUnits:saved.sourceUnits,meetingDate:'2026-06-15'}).restored.length,0);
 const patch=await request('patch','',{actions:first.body.draft.actions});assert.equal(patch.statusCode,200,JSON.stringify(patch.body));
 assert.deepEqual(saved.qualityState.actions.actionPhaseCorrection,audit);
 assert.equal(patch.body.draft.canRestorePhaseActions,true);
 assert.equal(saved.actions[0].timing.wording,'hoping done for Tuesday');assert.equal(saved.actions[1].timing.kind,'not_stated');
 assert.ok(saved.actions.every(a=>a.timingDecision.status==='rejected'));assert.equal(saved.reviewFlags.filter(f=>f.status==='open').length,6);
 const reloaded=(await request('get')).body.draft;
 for(const includeEvidence of [false,true]){
  const zip=await JSZip.loadAsync(await require('../utils/meetingMinutesAgentDocx').generateMeetingMinutesAgentDocx(reloaded,includeEvidence));
  const xml=await zip.file('word/document.xml').async('string');
  assert.ok(xml.includes('Tidy and share'));assert.ok(xml.includes('Add thermal and flow-control'));
  assert.ok(!xml.includes('Complete the quality review checklist updates'));
  const pdf=A.meetingAgentDraftForPdf(reloaded,includeEvidence);
  assert.ok(JSON.stringify(pdf).includes('Tidy and share'));assert.ok(JSON.stringify(pdf).includes('Add thermal and flow-control'));
 }
});
test('owned restoration recovers original work, warnings, citations and timing histories',async()=>{
 await reset();const res=await request('post','/restore-combined-actions');assert.equal(res.statusCode,200,JSON.stringify(res.body));
 assert.deepEqual(saved.actions,originals);assert.equal(saved.qualityState.actions.actionPhaseCorrection.restored,true);
 assert.equal(res.body.draft.canRestorePhaseActions,false);assert.equal(writes,1);
 assert.equal(saved.reviewFlags.filter(f=>f.status==='open').length,6);
});
test('stale revision, another owner, active generation, altered source/date and reviewer edits block restoration',async()=>{
 for(const [label,change,body,user,status] of [
  ['revision',()=>{},{revision:0},'reviewer',409],
  ['owner',()=>{},{},'other-user',404],
  ['generation',()=>saved.generation={status:'running'}, {},'reviewer',409],
  ['source',()=>saved.sourceUnits[0].text+=' Changed.',{},'reviewer',409],
  ['date',()=>{saved.details.meetingDate='2026-06-16';saved.qualityState.preparation.dateContext.meetingDate='2026-06-16';},{},'reviewer',409],
  ['reviewer',()=>saved.actions[0].action+=' Reviewer correction.',{},'reviewer',409]
 ]){
  await reset();change();const before=structuredClone(saved),res=await request('post','/restore-combined-actions',body,user);
  assert.equal(res.statusCode,status,label+JSON.stringify(res.body));assert.equal(writes,0);assert.deepEqual(saved,before);
 }
});
test('reviewer changes are saved without silently restoring generated wording',async()=>{
 await reset();const visible=(await request('get')).body.draft;
 visible.actions[0].action+=' Reviewer qualification.';
 const res=await request('patch','',{actions:visible.actions});assert.equal(res.statusCode,200,JSON.stringify(res.body));
 assert.ok(saved.actions.some(a=>a.action.includes('Reviewer qualification.')));assert.equal(res.body.draft.canRestorePhaseActions,false);
});
test('recovery prompt separates source facts from existing timing assessments',()=>{
 const f=fixture(),before=structuredClone(f.actions);
 const prompt=A.meetingMinutesAgentAnchoredActionPrompt({transcript:'Full transcript remains present.',details:{},mode:'recovery',currentActions:f.actions,candidates:[]});
 const data=JSON.parse(prompt.split('\n').slice(1).join('\n'));
 assert.equal(data.preparedTranscript,'Full transcript remains present.');
 assert.match(data.writingRules.join(' '),/distinct work phases/);
 assert.match(data.writingRules.join(' '),/genuinely uncovered work/);
 assert.equal(data.currentActions[0].timingProvenance.source,'application_assessment_not_source_evidence');
 assert.deepEqual(data.currentActions[0].timingProvenance.rejectedExactDates,['2026-06-16']);
 assert.deepEqual(f.actions,before);
});
test('flag is frozen per run, absent legacy policy stays off and private proof bypasses glossary normalisation',()=>{
 const P=require('../utils/meetingMinutesSemanticPolicy'),env={MEETING_MINUTES_AGENT_CONTACT_REVIEW_V1:'1',MEETING_MINUTES_AGENT_PHASE_CLARIFICATION_V1:'1'};
 const policy=P.captureSemanticPolicy(env);assert.equal(policy.phaseClarifications,true);env.MEETING_MINUTES_AGENT_PHASE_CLARIFICATION_V1='0';
 assert.equal(policy.phaseClarifications,true);assert.equal(P.captureSemanticPolicy(env).phaseClarifications,undefined);assert.equal(P.semanticPolicyForRun({}).phaseClarifications,undefined);
 const audit={version:F.VERSION,original:[{action:'Original source spelling'}]};
 assert.strictEqual(A.normaliseMeetingAgentQualityState({actions:{actionPhaseCorrection:audit}}).actions.actionPhaseCorrection,audit);
});

test('actual stage hook applies only to an enabled frozen policy, never legacy/off/shadow work',async()=>{
 await reset();const f=fixture(),draft={...saved,actions:[],qualityState:{preparation:saved.qualityState.preparation}};
 const P=require('../utils/meetingMinutesSemanticPolicy'),on=P.captureSemanticPolicy({MEETING_MINUTES_AGENT_CONTACT_REVIEW_V1:'1',MEETING_MINUTES_AGENT_PHASE_CLARIFICATION_V1:'1'});
 const prior=process.env.MEETING_MINUTES_AGENT_WORKFLOW_UNION_V1;process.env.MEETING_MINUTES_AGENT_WORKFLOW_UNION_V1='0';
 try{
  const result=await A.finishMeetingAgentGeneratedStage({changes:{actions:f.actions},reviewFlags:[]},draft,'actions',
   {semanticPolicy:on,phaseAsk:provider(f),semanticAsk:async()=>{throw Error('No unrelated semantic calls expected');}});
  assert.equal(result.changes.qualityState.actions.actionPhaseCorrection.applied,true);
  assert.match(result.changes.actions[0].action,/^Tidy and share/);
  for(const policy of [undefined,{...on,mode:'off'},{...on,mode:'shadow'},{...on,phaseClarifications:false}]){
   let calls=0;
   const unchanged=await A.finishMeetingAgentGeneratedStage({changes:{actions:f.actions},reviewFlags:[]},draft,'actions',
    {semanticPolicy:policy,phaseAsk:async()=>{calls++;throw Error('Unexpected phase request');},semanticAsk:async()=>{throw Error('No unrelated semantic calls expected');}});
   assert.equal(calls,0);assert.equal(unchanged.changes.qualityState?.actions?.actionPhaseCorrection?.applied,undefined);
  }
 }finally{if(prior===undefined)delete process.env.MEETING_MINUTES_AGENT_WORKFLOW_UNION_V1;else process.env.MEETING_MINUTES_AGENT_WORKFLOW_UNION_V1=prior;}
});
test('phase restoration leaves earlier independently proved contact consolidation recoverable',async()=>{
 await reset();const f=fixture();
 f.units=V.normaliseSourceUnits([...f.units,{id:'T0005',speaker:'Morgan Lee',text:'I will follow up with Casey to get a review of the battery calibration standard.'}]);
 const contact=(id,action)=>({id,action,owners:['Morgan Lee'],timing:{kind:'not_stated',wording:'',exactDate:''},evidenceIds:['T0005'],reviewFlagIds:[]});
 const originals=[...f.actions,contact('contact-parent','Follow up with Casey and obtain a review of the battery calibration standards material.'),contact('contact-child','Follow up with Casey to review the battery calibration standard.')];
 const semantic=require('../utils/meetingMinutesSemanticStage'),policy=require('../utils/meetingMinutesSemanticPolicy').captureSemanticPolicy({MEETING_MINUTES_AGENT_CONTACT_REVIEW_V1:'1',MEETING_MINUTES_AGENT_ACTION_PROOF_CONTRACT_V2:'1'});
 const draft={...saved,sourceUnits:f.units,actions:originals};
 const contactResult=await semantic.reconcileGeneratedSemanticStage({changes:{actions:originals}},draft,'actions',{policy,verifySurvival:A.reconcileFinalApprovedActions,ask:async prompt=>{
  const packet=JSON.parse(prompt.split('\nDATA\n')[1]),result=require('./helpers/meeting-minutes-contained-response')({...packet,selectedSurvivor:'A'});
  result.decisions[2].relation='same_obligation';result.decisions[0].rows.forEach(row=>row.basis='commitment');return {result};
 }});
 assert.equal(contactResult.changes.actions.length,3);
 const phase=await F.correct(contactResult.changes.actions,f.units,{meetingDate:'2026-06-15',ask:provider(f)});assert.equal(phase.audit.applied,true);
 const changes={...contactResult.changes,actions:phase.actions,qualityState:{...draft.qualityState,actions:{...contactResult.changes.qualityState.actions,actionPhaseCorrection:phase.audit}}};
 saved={...A.meetingAgentDraftPayload({...draft,...A.admitMeetingAgentGeneratedActionChanges(draft,changes,'stacked-proof')}),draftId:draft.draftId,revision:1,status:'draft'};
 assert.equal(A.publicMeetingAgentDraft(saved).canRestorePhaseActions,true);
 const first=await request('post','/restore-combined-actions');assert.equal(first.statusCode,200,JSON.stringify(first.body));
 assert.equal(first.body.draft.canRestoreCombinedActions,true);assert.equal(first.body.draft.canRestorePhaseActions,false);assert.equal(saved.actions.length,3);
 const second=await request('post','/restore-combined-actions');assert.equal(second.statusCode,200,JSON.stringify(second.body));
 assert.equal(second.body.draft.canRestoreCombinedActions,false);assert.deepEqual(saved.actions,originals);
});
