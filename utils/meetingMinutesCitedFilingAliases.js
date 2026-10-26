'use strict';
// Identity comes from a preserved generated candidate -> original record link.
// Text similarity, shared citations and the number of warnings are not proof.
const { hash } = require('./meetingMinutesProofHash');
const { generatedFilingRecord,filingOriginsFit } = require('./meetingMinutesFilingProvenance');
const VERSION='cited-filing-alias-v1',clone=x=>structuredClone(x);
const keys=new Set(['id','text','evidenceIds','reviewFlagIds','originalTopic','placementReason','filingOrigins']);
const same=(a,b)=>JSON.stringify([...new Set(a||[])].sort())===JSON.stringify([...new Set(b||[])].sort());
function eligible(row){return row&&typeof row.id==='string'&&!/^(?:manual-|reviewer-)/.test(row.id)
 &&typeof row.text==='string'&&row.text.trim()&&row.text.length<=1600&&Object.keys(row).every(k=>keys.has(k))
 &&Array.isArray(row.evidenceIds)&&row.evidenceIds.length>0&&row.evidenceIds.length<=24
 &&row.evidenceIds.every(id=>typeof id==='string'&&id.trim()===id&&id.length>0)
 &&new Set(row.evidenceIds).size===row.evidenceIds.length
 &&(row.reviewFlagIds===undefined||Array.isArray(row.reviewFlagIds)&&row.reviewFlagIds.every(id=>typeof id==='string'&&id.trim()===id&&id.length>0));}
function reconcile(rows=[],sourceUnits=[],options={}){
 const original=clone(rows),unchanged=reason=>({rows:clone(original),audit:{version:VERSION,applied:false,reason,ledger:[]}});
 if(options.enabled!==true)return unchanged('disabled');
 if(!Array.isArray(rows)||rows.length>500||!Array.isArray(options.priorRows)||!Array.isArray(options.discussion))return unchanged('invalid_context');
 const protectedIds=new Set(options.priorRows.map(r=>r.id));
 const visit=r=>{protectedIds.add(r.id);(r.supportingDetails||[]).forEach(visit);};
 for(const t of options.discussion)for(const field of ['points','decisions','openQuestions'])for(const r of t[field]||[])visit(r);
 const count=id=>rows.filter(r=>r.id===id).length,used=new Set(),replacements=new Map(),removed=new Set(),ledger=[];
 for(const alias of rows){
  if(ledger.length>=10)break;
  if(!eligible(alias)||protectedIds.has(alias.id)||count(alias.id)!==1||used.has(alias.id)||alias.filingOrigins?.length!==1
   ||alias.placementReason!=='explicit_target_subject_mismatch')continue;
  const origin=alias.filingOrigins[0],candidate=origin.generatedRecord;
  if(Object.keys(origin).some(key=>!['id','originalTopic','placementReason','generatedRecord'].includes(key))||origin.placementReason!==alias.placementReason
   ||!candidate||!generatedFilingRecord(candidate)||candidate.id!==alias.id||candidate.candidateId!==alias.id
   ||origin.id!==alias.id||origin.originalTopic!==alias.originalTopic||candidate.topic!==alias.originalTopic
   ||candidate.text!==alias.text||!candidate.record||candidate.record.id===alias.id
   ||!same(candidate.evidenceIds,alias.evidenceIds)||!same(candidate.reviewFlagIds,alias.reviewFlagIds))continue;
  const target=rows.find(r=>r.id===candidate.record.id);
  if(!eligible(target)||count(target.id)!==1||used.has(target.id)||protectedIds.has(target.id)
   ||target.filingOrigins!==undefined||target.placementReason!=='no_subject_match'
   ||target.text!==alias.text||target.originalTopic!==alias.originalTopic||!same(target.reviewFlagIds,alias.reviewFlagIds))continue;
  const evidenceIds=[...new Set([...target.evidenceIds,...alias.evidenceIds])];
  if(evidenceIds.length>24||evidenceIds.some(id=>{const sources=sourceUnits.filter(s=>s.id===id);return sources.length!==1
   ||!String(sources[0].text||'').trim()||sources[0].classification==='remove'&&!sources[0].restored;}))continue;
  const origins=[{id:target.id,originalTopic:target.originalTopic,placementReason:target.placementReason},clone(origin)];
  if(!filingOriginsFit(origins))continue;
  const survivor={...clone(target),evidenceIds,mergedFromIds:[alias.id],filingOrigins:origins,filingMergeProtected:true};
  replacements.set(target.id,survivor);removed.add(alias.id);used.add(alias.id);used.add(target.id);
  ledger.push({aliasId:alias.id,survivorId:target.id,originalAlias:clone(alias),originalSurvivor:clone(target),survivor:clone(survivor)});
 }
 if(!ledger.length)return unchanged('no_proved_aliases');
 const output=rows.filter(r=>!removed.has(r.id)).map(r=>replacements.get(r.id)||clone(r));
 const audit={version:VERSION,applied:true,reason:'proved_candidate_identity',original,ledger,sourceHash:hash(sourceUnits),originalHash:hash(original),finalHash:hash(output)};
 if(Buffer.byteLength(JSON.stringify(audit),'utf8')>256*1024)return unchanged('archive_capacity');
 return {rows:output,audit};
}
function restore(rows,units,audit){return audit?.version===VERSION&&audit.applied===true&&hash(rows)===audit.finalHash
 &&hash(units)===audit.sourceHash&&hash(audit.original)===audit.originalHash?clone(audit.original):null;}
module.exports={VERSION,reconcile,restore};
