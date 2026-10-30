'use strict';

const C = require('./discussionClaimConsolidationState');

const VERSION = 'discussion-action-separation-v1';
const clone = value => JSON.parse(JSON.stringify(value));
const actionBinding = action => C.hash({ id: action.id, action: action.action, owners: [...(action.owners || [])].sort(),
  timing: action.timing, evidenceIds: action.evidenceIds });

function restoreChangedActionCoverage(discussion,actions,sourceUnits,audit){
  const unchanged={discussion,audit,restored:false};
  if(audit?.method!==VERSION||audit.applied!==true||audit.sourceHash!==C.hash(sourceUnits)
    ||!Array.isArray(audit.separationOriginal)||audit.separationOriginalHash!==C.hash(audit.separationOriginal)
    ||!Array.isArray(audit.separationBindings)||!audit.separationBindings.length
    ||!Array.isArray(audit.separationAffectedTopics)||!audit.separationAffectedTopics.length
    ||!audit.separationAffectedTopics.every(t=>t&&Number.isInteger(t.index)&&discussion[t.index]
      &&audit.separationOriginal[t.index]&&C.hash(discussion[t.index])===t.finalHash))return unchanged;
  const valid=audit.separationBindings.every(binding=>{
    if(!binding||typeof binding.id!=='string'||typeof binding.hash!=='string')return false;
    const matches=actions.filter(a=>a?.id===binding.id);return matches.length===1&&actionBinding(matches[0])===binding.hash;
  });
  if(valid)return unchanged;
  const restored=clone(discussion);for(const topic of audit.separationAffectedTopics)restored[topic.index]=clone(audit.separationOriginal[topic.index]);
  const prior=audit.priorAudit;
  return {discussion:restored,restored:true,audit:prior&&C.canRestore(restored,sourceUnits,prior)?clone(prior)
    :{...clone(audit),applied:false,reason:'accepted_action_changed',coverageRestored:true}};
}
function rebindActionIdentities(before,after,audit){
  if(audit?.method!==VERSION||!audit.applied||!Array.isArray(audit.separationBindings)||!audit.separationBindings.length
    ||before.length!==after.length)return null;
  const content=a=>C.hash({action:a.action,owners:[...(a.owners||[])].sort(),timing:a.timing,evidenceIds:a.evidenceIds});
  if(before.some((a,i)=>content(a)!==content(after[i])))return null;
  const mapping=new Map();
  for(const binding of audit.separationBindings){
    const indices=before.map((a,i)=>a.id===binding.id?i:-1).filter(i=>i>=0);
    if(indices.length!==1||actionBinding(before[indices[0]])!==binding.hash)return null;
    const next=after[indices[0]];
    if(after.filter(a=>a.id===next.id).length!==1)return null;
    mapping.set(binding.id,next);
  }
  const result=clone(audit);
  result.identityAdmission={method:'exact_action_content',mappings:[...mapping].map(([id,row])=>({beforeId:id,afterId:row.id,occurrenceId:row.occurrenceId||''}))};
  result.separationBindings=result.separationBindings.map(b=>({id:mapping.get(b.id).id,hash:actionBinding(mapping.get(b.id))}));
  result.separationActionRevisions=(result.separationActionRevisions||[]).map(entry=>{
    const next=mapping.get(entry.before.id);if(!next)return entry;
    return{...entry,beforeAdmission:clone(entry.before),before:{...entry.before,id:next.id,...(next.occurrenceId?{occurrenceId:next.occurrenceId}:{})},afterHash:actionBinding(next)};
  });
  return result;
}
function revertGeneratedPair(changes,audit){
  const next={...changes,actions:restorePairedActions(changes.actions||[],audit)};
  if(Array.isArray(audit?.separationOriginal)&&audit.separationOriginalHash===C.hash(audit.separationOriginal)
    &&Array.isArray(changes.discussion)&&Array.isArray(audit.separationAffectedTopics)){
    next.discussion=clone(changes.discussion);
    for(const topic of audit.separationAffectedTopics)if(next.discussion[topic.index]&&audit.separationOriginal[topic.index])next.discussion[topic.index]=clone(audit.separationOriginal[topic.index]);
  }
  return next;
}
function preserveUnchangedPairedActions(normalised,stored,submitted,published,audit){
  if(!Array.isArray(audit?.separationBindings))return normalised;
  const preserved=new Map();
  for(const binding of audit.separationBindings){
    if(!binding||typeof binding.id!=='string'||typeof binding.hash!=='string')continue;
    const id=binding.id,original=stored.filter(a=>a?.id===id);
    if(original.length!==1||actionBinding(original[0])!==binding.hash)continue;
    if(Array.isArray(submitted)){
      const sent=submitted.filter(a=>a?.id===id),shown=published.filter(a=>a?.id===id);
      if(sent.length!==1||shown.length!==1||C.hash(sent[0])!==C.hash(shown[0]))continue;
    }
    if(normalised.filter(a=>a.id===id).length===1)preserved.set(id,original[0]);
  }
  return normalised.map(a=>preserved.has(a.id)?clone(preserved.get(a.id)):a);
}
function restorePairedActions(actions,audit){
  if(!Array.isArray(audit?.separationActionRevisions)||!audit.separationActionRevisions.length)return actions;
  const restored=actions.map(action=>{const entry=audit.separationActionRevisions.find(e=>e?.before?.id===action.id&&e.afterHash===actionBinding(action));return entry?clone(entry.before):action;});
  return restored.some((action,i)=>action!==actions[i])?restored:actions;
}

module.exports = { VERSION, clone, actionBinding, restoreChangedActionCoverage, rebindActionIdentities, revertGeneratedPair, preserveUnchangedPairedActions, restorePairedActions };
