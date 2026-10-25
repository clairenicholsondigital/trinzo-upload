'use strict';
const enabled=value=>/^(?:1|true|yes|on)$/i.test(String(value||'0'));
function normaliseDiscussionCoveragePolicy(value){
  return Object.freeze({version:1,mainPoint:value?.version===1&&value.mainPoint===true,
    pointDecision:value?.version===1&&value.pointDecision===true});
}
function captureDiscussionCoveragePolicy(env=process.env){
  return normaliseDiscussionCoveragePolicy({version:1,
    mainPoint:enabled(env.MEETING_MINUTES_AGENT_DISCUSSION_MAIN_POINT_COVERAGE_V1),
    pointDecision:enabled(env.MEETING_MINUTES_AGENT_DISCUSSION_POINT_DECISION_COVERAGE_V1)});
}
function discussionCoveragePolicyForRun(draft={}){
  return normaliseDiscussionCoveragePolicy(draft._discussionCoveragePolicy??draft.generation?.discussionCoveragePolicy);
}
function discussionCoveragePolicyForFingerprint(draft={}){
  return draft.generation?.status==='running'||draft._discussionCoveragePolicy
    ?discussionCoveragePolicyForRun(draft):captureDiscussionCoveragePolicy();
}
module.exports={normaliseDiscussionCoveragePolicy,captureDiscussionCoveragePolicy,discussionCoveragePolicyForRun,discussionCoveragePolicyForFingerprint};
