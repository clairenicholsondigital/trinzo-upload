'use strict';
// Source and retention diagnostics; returns unchanged originals, never edits.
const R={prepareActionReconciliation:(...args)=>require('./canonicalMinutes/actionSemanticReconciliation').prepareActionReconciliation(...args),mechanicalCoverage:(...args)=>require('./canonicalMinutes/actionSemanticReconciliation').mechanicalCoverage(...args)};
const { isReviewerAuthored } = require('./canonicalMinutes/state');
const { ownerWitness } = require('./meetingMinutesSemanticSourceVerification');
const { hash } = require('./meetingMinutesProofHash');
const VERSION = 'action-facet-review-v1';
const clone = value => structuredClone(value);
function freeze(value) {
 if (value && typeof value === 'object' && !Object.isFrozen(value)) {
  Object.values(value).forEach(freeze); Object.freeze(value);
 }
 return value;
}
function assertRegister(register) {
 const {packetHash,...body}=register;
 if(hash(body)!==packetHash) throw Error('changed_global_register');
}
function facets(row,options={}) {
 const result=[{field:'instruction',value:row.action.action},{field:'owners',value:row.action.owners||[]}];
 if(/\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(row.action.action))result.push({field:'contentTiming',value:row.action.action});
 const timing=row.action.timing;
 if(timing && (timing.kind!=='not_stated'||timing.wording||timing.exactDate)) result.push({field:'timing',value:timing});
 for(const [field,raw] of Object.entries(row.facets)) {
  const value=field==='units'&&options.contextualUnits===true?require('./meetingMinutesNumericTokens').proofUnitTokens(row.action.action):raw;
  if(['owners','timing','timingStatus'].includes(field))continue;
  if(Array.isArray(value)?value.length:Boolean(value))result.push({field,value});
 }
 return result.map(f=>({...f,facetId:hash([row.ref,f.field,f.value]).slice(0,24)}));
}
function prepare(register,comparisonId,survivorRef,options={}) {
 assertRegister(register);
 const comparison=register.comparisons.find(c=>c.comparisonId===comparisonId);
 if(!comparison||![comparison.leftRef,comparison.rightRef].includes(survivorRef))throw Error('invalid_bound_pair_or_survivor');
 const refs=[comparison.leftRef,comparison.rightRef];
 const originals=refs.map(ref=>register.rows.find(row=>row.ref===ref));
 if(originals.some(row=>!row))throw Error('missing_original_record');
 const sourceIds=new Set(register.sourceUnits.map(s=>s.id));
 if(sourceIds.size!==register.sourceUnits.length)throw Error('ambiguous_source_ids');
 const prepared=R.prepareActionReconciliation({actions:originals.map(row=>row.action),sourceUnits:register.sourceUnits});
 const rows=prepared.rows.map((row,i)=>({ref:originals[i].ref,recordHash:row.recordHash,action:clone(row.action),
  facets:facets({...row,ref:originals[i].ref},options),unresolvedSourceIds:clone(originals[i].unresolvedSourceIds),
  ownerWitnesses:(row.action.owners||[]).map(owner=>({owner,sourceIds:register.sourceUnits.filter(unit=>row.action.evidenceIds?.includes(unit.id)&&ownerWitness(unit,owner)).map(unit=>unit.id)}))}));
 const survivor=rows.find(row=>row.ref===survivorRef);
 const checks=rows.flatMap(row=>row.facets.map(f=>({...f,originalRef:row.ref,originalHash:row.recordHash,
  ownershipWitnessRequired:['instruction','owners'].includes(f.field),exactSelfRetention:row.ref===survivorRef&&row.recordHash===survivor.recordHash})));
 const body={version:VERSION,...(options.contextualUnits===true?{unitContextVersion:1}:{}),registerHash:register.packetHash,comparisonId,
  survivorRef,survivorHash:survivor.recordHash,rows,checks,sourceUnits:clone(register.sourceUnits),
  // Context stays global, but only this explicitly bound pair is adjudicated.
  globalInventory:register.rows.map(row=>({ref:row.ref,recordHash:hash(row.action),action:clone(row.action)})),
  unassessedComparisonIds:register.comparisons.filter(c=>c.comparisonId!==comparisonId).map(c=>c.comparisonId),
  unresolvedContext:clone(register.unresolvedContext)};
 return freeze({...body,packetHash:hash(body)});
}
const FIELDS = new Set(['instruction','owners','timing.kind','timing.wording','timing.exactDate']);
function fieldText(action,field){
 if(field==='instruction')return String(action.action||'');
 if(field==='owners')return JSON.stringify(action.owners||[]);
 return String(action.timing?.[field.slice(7)]||'');
}
function validSurvivorSpan(original,survivor,span){
 return FIELDS.has(span?.field) && (original.field!=='owners'||span.field==='owners')
  && (original.field!=='timing'||span.field.startsWith('timing.'))
  && (['owners','timing'].includes(original.field)||['instruction','timing.wording'].includes(span.field))
  && typeof span.quote==='string' && Boolean(span.quote.trim())
  && fieldText(survivor.action,span.field).includes(span.quote);
}
function error(packet,response) {
 const {packetHash,...body}=packet;
 if(hash(body)!==packetHash)return 'changed_facet_packet';
 if(!response||response.version!==VERSION||response.packetHash!==packetHash||response.comparisonId!==packet.comparisonId
  ||response.survivorRef!==packet.survivorRef||response.survivorHash!==packet.survivorHash)return 'stale_or_wrong_bound_pair';
 if(!Array.isArray(response.decisions)||response.decisions.length!==packet.checks.length)return 'incomplete_facet_accounting';
 const required=new Map(packet.checks.map(check=>[check.facetId,check])),seen=new Set();
 const sources=new Map(packet.sourceUnits.map(source=>[source.id,source]));
 const survivor=packet.rows.find(row=>row.ref===packet.survivorRef);
 for(const check of response.decisions){
  const original=required.get(check?.facetId);
  if(!original||seen.has(check.facetId)||check.originalRef!==original.originalRef||check.originalHash!==original.originalHash)return 'wrong_or_duplicate_facet_binding';
  seen.add(check.facetId);
  if(!['supported','unsupported','unclear'].includes(check.source?.status)||!String(check.source.reason||'').trim()||!Array.isArray(check.source.sourceSpans))return 'invalid_source_facet';
  for(const span of check.source.sourceSpans){
   const source=sources.get(span?.unitId);
   if(!source||!['text','speaker'].includes(span.field)||typeof span.quote!=='string'||!span.quote.trim()
    ||!String(source[span.field]||'').includes(span.quote) || (span.field==='speaker'&&original.field!=='owners'))return 'invalid_source_quote';
  }
  if(check.source.status==='supported'){
   // An owner-name facet may quote exact speaker metadata. The complete
   // instruction must independently cite spoken assignment/acceptance text.
   if(!check.source.sourceSpans.length || (original.field!=='owners'
    && !check.source.sourceSpans.some(span=>span.field==='text')))return 'supported_without_source';
   const row=packet.rows.find(row=>row.ref===original.originalRef);
   if(original.ownershipWitnessRequired && (!row.ownerWitnesses.length || row.ownerWitnesses.some(witness=>!check.source.sourceSpans.some(span=>
    witness.sourceIds.includes(span.unitId) && ownerWitness(sources.get(span.unitId),witness.owner)))))return 'missing_source_owner_witness';
  }
  if(original.exactSelfRetention){
   if(check.retention!==undefined)return 'model_overrode_exact_self_retention';
  }else{
   if(!['retained','not_retained','unclear'].includes(check.retention?.status)||!String(check.retention.reason||'').trim()||!Array.isArray(check.retention.survivorSpans))return 'invalid_retention_facet';
   for(const span of check.retention.survivorSpans){
    if(!validSurvivorSpan(original,survivor,span))return 'invalid_survivor_quote';
   }
   if(check.retention.status==='retained'&&!check.retention.survivorSpans.length)return 'retained_without_survivor_text';
  }
 }
 return '';
}
function assess(packet,response){
 const contractError=error(packet,response);
 if(contractError)return {contractError,assessment:'unqualified',productionQualified:false,appliedEdits:0};
 const byId=new Map(response.decisions.map(check=>[check.facetId,check]));
 const checks=packet.checks.map(required=>{
  const check=byId.get(required.facetId);
  return {...clone(check),field:required.field,retention:required.exactSelfRetention
   ?{status:'retained',method:'exact_same_record',reason:'This identical original record is the selected survivor.'}:clone(check.retention)};
 });
 const survivor=packet.rows.find(row=>row.ref===packet.survivorRef);
 const guards=packet.rows.flatMap(row=>{
  const coverage=R.mechanicalCoverage(row.action,survivor.action);
  const reasons=[...coverage.reasons];
  if(isReviewerAuthored(row.action))reasons.push('reviewer_authored');
  if(row.action.reviewFlagIds?.length)reasons.push('review_warnings_present');
  if(row.unresolvedSourceIds.length)reasons.push('missing_cited_source');
  if(['rejectedExactDates','rejectedWordings'].some(field=>(row.action.timingDecision?.[field]||[])
   .some(value=>!(survivor.action.timingDecision?.[field]||[]).includes(value))))reasons.push('timing_history_requires_preservation');

  if(row.action.occurrenceId&&survivor.action.occurrenceId&&row.action.occurrenceId!==survivor.action.occurrenceId)reasons.push('occurrence_identity_requires_independent_proof');
  return reasons.map(reason=>({originalRef:row.ref,reason}));
 });
 const modelPassed=checks.every(check=>check.source.status==='supported'&&check.retention.status==='retained');
 return {contractError:'',assessment:modelPassed?'source_and_retention_passed':'vetoed',modelPassed,
  checks,guards,productionQualified:false,appliedEdits:0,
  actions:packet.rows.map(row=>clone(row.action)),unassessedComparisonIds:clone(packet.unassessedComparisonIds),unresolvedContext:clone(packet.unresolvedContext)};
}
module.exports={VERSION,prepare,error,assess,validSurvivorSpan,fieldText};
