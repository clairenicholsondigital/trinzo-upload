'use strict';
const enabled=value=>/^(?:1|true|yes|on)$/i.test(String(value||'0'));
function normaliseDiscussionCoveragePolicy(value){
  return Object.freeze({version:1,mainPoint:value?.version===1&&value.mainPoint===true,
    pointDecision:value?.version===1&&value.pointDecision===true,
    ...(value?.version===1&&value.supportingSubjects===true?{supportingSubjects:true}:{}),
    ...(value?.version===1&&value.filingAliases===true?{filingAliases:true}:{}),
    ...(value?.version===1&&value.citedFilingAliases===true?{citedFilingAliases:true}:{}),
    ...(value?.version===1&&value.presentConsideration===true?{presentConsideration:true}:{}),
    ...(value?.version===1&&value.warnedOwnParent===true?{warnedOwnParent:true}:{}),
    ...(value?.version===1&&value.corePriority===true?{corePriority:true}:{})});
}
function captureDiscussionCoveragePolicy(env=process.env){
  return normaliseDiscussionCoveragePolicy({version:1,
    mainPoint:enabled(env.MEETING_MINUTES_AGENT_DISCUSSION_MAIN_POINT_COVERAGE_V1),
    pointDecision:enabled(env.MEETING_MINUTES_AGENT_DISCUSSION_POINT_DECISION_COVERAGE_V1),
    supportingSubjects:enabled(env.MEETING_MINUTES_AGENT_SUPPORTING_SUBJECT_V2),
    filingAliases:enabled(env.MEETING_MINUTES_AGENT_FILING_ALIASES_V1),
    citedFilingAliases:enabled(env.MEETING_MINUTES_AGENT_CITED_FILING_ALIASES_V1),
    presentConsideration:enabled(env.MEETING_MINUTES_AGENT_OWN_PARENT_CONSIDERATION_V1),
    warnedOwnParent:enabled(env.MEETING_MINUTES_AGENT_WARNED_OWN_PARENT_V1),
    corePriority:enabled(env.MEETING_MINUTES_AGENT_REFEREED_CORE_PRIORITY_V1)});
}
function discussionCoveragePolicyForRun(draft={}){
  return normaliseDiscussionCoveragePolicy(draft._discussionCoveragePolicy??draft.generation?.discussionCoveragePolicy);
}
function discussionCoveragePolicyForFingerprint(draft={}){
  return draft.generation?.status==='running'||draft._discussionCoveragePolicy
    ?discussionCoveragePolicyForRun(draft):captureDiscussionCoveragePolicy();
}
module.exports={normaliseDiscussionCoveragePolicy,captureDiscussionCoveragePolicy,discussionCoveragePolicyForRun,discussionCoveragePolicyForFingerprint};
