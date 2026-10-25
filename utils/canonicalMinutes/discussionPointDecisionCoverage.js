'use strict';
const C=require('./discussionClaimConsolidation');
const auditChain=require('./discussionCoverageAudit');
const VERSION='discussion-point-decision-coverage-v1';
async function consolidate(discussion,sourceUnits,options={}){
  const result=await C.consolidate(discussion,sourceUnits,{...options,nominationMode:'point_decision',pointDecisionOnly:true,maxCandidates:1});
  return {...result,audit:{...result.audit,method:VERSION}};
}
module.exports={VERSION,consolidate,combine:(previous,next,sources)=>auditChain.combine(previous,next,sources,'pointDecisionAssessment')};
