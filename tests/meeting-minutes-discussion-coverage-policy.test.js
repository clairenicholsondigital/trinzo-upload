'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const P=require('../utils/meetingMinutesDiscussionCoveragePolicy');
const {createEvaluationSession}=require('../scripts/lib/meetingMinutesEvaluationSession');
const StageProtocol = require('../utils/meetingMinutesStageProtocol');
test('new Discussion capabilities default off and legacy/resumed work cannot adopt current flags',()=>{
 const enabled=P.captureDiscussionCoveragePolicy({MEETING_MINUTES_AGENT_DISCUSSION_MAIN_POINT_COVERAGE_V1:'1',MEETING_MINUTES_AGENT_DISCUSSION_POINT_DECISION_COVERAGE_V1:'1'});
 assert.ok(Object.isFrozen(enabled));assert.equal(enabled.mainPoint,true);assert.equal(enabled.pointDecision,true);
 for(const draft of [{},{generation:{status:'running'}},{generation:{status:'failed'}},{_discussionCoveragePolicy:{version:0,mainPoint:true}}])assert.deepEqual(P.discussionCoveragePolicyForRun(draft),{version:1,mainPoint:false,pointDecision:false});
 assert.deepEqual(P.discussionCoveragePolicyForRun({generation:{status:'running',discussionCoveragePolicy:enabled}}),enabled);
});
test('private evaluations capture both Discussion switches once and paired comparisons keep the saved policy',async()=>{
 const env={MEETING_MINUTES_AGENT_DISCUSSION_MAIN_POINT_COVERAGE_V1:'1'},session=createEvaluationSession({env});
 env.MEETING_MINUTES_AGENT_DISCUSSION_MAIN_POINT_COVERAGE_V1='0';
 await session.generateStage(async draft=>{assert.equal(P.discussionCoveragePolicyForRun(draft).mainPoint,true);}, {},'discussion');
 const paired=createEvaluationSession({env:{},referencePolicy:session.semanticPolicy,referenceDiscussionCoveragePolicy:session.discussionCoveragePolicy});
 assert.deepEqual(paired.discussionCoveragePolicy,session.discussionCoveragePolicy);
 assert.equal(createEvaluationSession({env,referencePolicy:null}).discussionCoveragePolicy.mainPoint,false);
 assert.throws(()=>session.generateStage(()=>{}, {},'discussion',{discussionCoveragePolicy:{}}),/session policy/);
});
test('speculative fingerprints separate changed Discussion configuration and preserve active snapshots',()=>{
 const off={version:1,mainPoint:false,pointDecision:false},on={version:1,mainPoint:true,pointDecision:false};
 const draft={details:{meetingDate:'2026-10-21'},sourceUnits:[],preparedTranscript:'Source',generation:{status:'running',discussionCoveragePolicy:off}};
 const a=StageProtocol.meetingAgentStageInputFingerprint({...draft,_discussionCoveragePolicy:off},'discussion');
 const b=StageProtocol.meetingAgentStageInputFingerprint({...draft,_discussionCoveragePolicy:on},'discussion');assert.notEqual(a,b);
 assert.deepEqual(P.discussionCoveragePolicyForFingerprint(draft),off);
});
