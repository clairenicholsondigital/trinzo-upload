
'use strict';
process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1='0';
const test=require('node:test'),assert=require('node:assert/strict'),V=require('../utils/meetingMinutesAgentV2');
const db=require('../utils/db'),oldGet=db.getMeetingMinutesAgentDraft,oldUpdate=db.updateMeetingMinutesAgentDraft;
let saved,writes=0;
db.getMeetingMinutesAgentDraft=async(id,user)=>id===saved.draftId&&user==='reviewer'?structuredClone(saved):null;
db.updateMeetingMinutesAgentDraft=async(id,user,revision,changes)=>{assert.equal(revision,saved.revision);writes++;saved={...V.migrateDraftPayload(structuredClone(changes.payload)),draftId:id,revision:revision+1,status:'draft'};return structuredClone(saved);};
const router=require('../routes/api'),api=router.stagedEvaluation;
const {reconcileGeneratedSemanticStage}=require('../utils/meetingMinutesSemanticStage'),response=require('./helpers/meeting-minutes-dependency-response');
const policy=require('../utils/meetingMinutesSemanticPolicy').captureSemanticPolicy({MEETING_MINUTES_AGENT_QUALIFIED_DEPENDENCY_DEDUPE_V1:'1'});
const {sourceUnits,original}=require('./helpers/meeting-minutes-dependency-fixture');
const run=()=>reconcileGeneratedSemanticStage({changes:{actions:original()}},{sourceUnits},'actions',{policy,ask:async prompt=>({result:response(JSON.parse(prompt.split('\nDATA\n')[1]))})});
test('owned restore endpoint restores both dependency originals and records reversible history',async()=>{
 const output=await run();saved={draftId:'dependency-restore',revision:1,payloadVersion:V.PAYLOAD_VERSION,sourceUnits,
  ...api.admitMeetingAgentGeneratedActionChanges({sourceUnits},output.changes,'dependency-restore'),discussion:[],reviewFlags:[],changeHistory:[],redoHistory:[],staleStages:[],details:{meetingTitle:'Membership',meetingDate:'2026-10-25'}};
 const before=structuredClone(saved);writes=0;
 try{
  const route=router.stack.find(layer=>layer.route?.path==='/meeting-minutes-agent/drafts/:draftId/restore-combined-actions'&&layer.route.methods.post).route;
  const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
  await route.stack.at(-1).handle({params:{draftId:saved.draftId},authUser:{userId:'reviewer'},body:{revision:saved.revision}},res);
  assert.equal(res.statusCode,200,JSON.stringify(res.body));assert.equal(writes,1);assert.deepEqual(saved.actions,original());assert.equal(saved.qualityState.actions.semanticReconciliation.restored,true);
  assert.equal(saved.changeHistory.at(-1).label,'Restore separate actions');assert.deepEqual(saved.changeHistory.at(-1).beforeState.actions,before.actions);
 }finally{db.getMeetingMinutesAgentDraft=oldGet;db.updateMeetingMinutesAgentDraft=oldUpdate;}
});
