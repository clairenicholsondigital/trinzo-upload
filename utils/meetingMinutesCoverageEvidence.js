'use strict';
const {createHash}=require('node:crypto');
// Restore only the known eight-reference truncation of an audited group notice.
// This is provenance recovery, never an action-coverage or rejection verdict.
function coverageEvidenceFlags(draft,flags){
 const list=value=>Array.isArray(value)?value:[];
 const sourceCounts=new Map();for(const unit of list(draft.sourceUnits))if(unit&&typeof unit.id==='string')sourceCounts.set(unit.id,(sourceCounts.get(unit.id)||0)+1);
 const groups=new Map();for(const group of list(draft.candidateLedger))if(group&&typeof group.candidateId==='string')groups.set(group.candidateId,groups.has(group.candidateId)?null:group);
 const issues=new Map();for(const issue of list(draft.qualityState?.actions?.refereeMaterialization?.unresolved))if(issue&&typeof issue.candidateId==='string')issues.set(issue.candidateId,issues.has(issue.candidateId)?null:issue);
 return flags.map(flag=>{
  if(!flag||flag.reviewDisposition!=='coverage_unresolved'||flag.kind!=='possible_missed_follow_up'||flag.reviewerAuthored||flag.evidenceIds?.length!==8)return flag;
  const matches=[...issues.values()].filter(issue=>issue&&flag.id==='action-materialization-'+createHash('sha256').update(String(issue.candidateId)).digest('hex').slice(0,20));
  if(matches.length!==1)return flag;
  const issue=matches[0],group=groups.get(issue.candidateId),ids=issue.evidenceIds;
  if(!group||!['action_thread','action_chain'].includes(group.recordType)||issue.recordType!==group.recordType
   ||issue.reason!=='group_requires_atomic_action_mapping'||!Array.isArray(ids)||ids.length<=8||ids.length>20
   ||new Set(ids).size!==ids.length||ids.some(id=>sourceCounts.get(id)!==1)
   ||JSON.stringify(ids)!==JSON.stringify(group.evidenceIds)
   ||!flag.evidenceIds.every((id,index)=>id===ids[index]))return flag;
  return {...flag,evidenceIds:[...ids]};
 });
}
module.exports={coverageEvidenceFlags};
