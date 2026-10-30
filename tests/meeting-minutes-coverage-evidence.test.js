'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {coverageEvidenceFlags}=require('../utils/meetingMinutesCoverageEvidence'),V=require('../utils/meetingMinutesReviewFlags');
function fixture(){const ids=Array.from({length:12},(_,i)=>'T'+i),candidateId='group';return{sourceUnits:ids.map(id=>({id,speaker:'Nora Patel',text:'A distinct passage.'})),candidateLedger:[{candidateId,recordType:'action_chain',evidenceIds:ids}],qualityState:{actions:{refereeMaterialization:{unresolved:[{candidateId,recordType:'action_chain',reason:'group_requires_atomic_action_mapping',evidenceIds:ids}]}}},reviewFlags:[{id:'action-materialization-'+createHash('sha256').update(candidateId).digest('hex').slice(0,20),kind:'possible_missed_follow_up',reviewDisposition:'coverage_unresolved',status:'open',evidenceIds:ids.slice(0,8)}]};}
test('audited group provenance repairs only the known truncation without mutating draft or status',()=>{const d=fixture(),before=structuredClone(d),out=coverageEvidenceFlags(d,d.reviewFlags);assert.equal(out[0].evidenceIds.length,12);assert.equal(out[0].status,'open');assert.deepEqual(d,before);assert.deepEqual(coverageEvidenceFlags(d,out),out);});
for(const [label,change]of[
 ['changed flag source',d=>d.reviewFlags[0].evidenceIds.reverse()],
 ['missing group',d=>d.candidateLedger=[]],
 ['duplicate group',d=>d.candidateLedger.push({...d.candidateLedger[0]})],
 ['duplicate issue',d=>d.qualityState.actions.refereeMaterialization.unresolved.push({...d.qualityState.actions.refereeMaterialization.unresolved[0]})],
 ['unknown source',d=>d.sourceUnits.pop()],
 ['duplicate source',d=>d.sourceUnits.push({...d.sourceUnits[0]})],
 ['conflicting group evidence',d=>d.candidateLedger[0].evidenceIds=d.candidateLedger[0].evidenceIds.slice(0,9)],
 ['different issue reason',d=>d.qualityState.actions.refereeMaterialization.unresolved[0].reason='unknown'],
 ['reviewer authored',d=>d.reviewFlags[0].reviewerAuthored=true]
])test('uncertain provenance cannot expand warning sources: '+label,()=>{const d=fixture();change(d);assert.deepEqual(coverageEvidenceFlags(d,d.reviewFlags),d.reviewFlags);});
test('coverage flags keep their twenty-anchor budget while ordinary flags retain eight',()=>{const ids=Array.from({length:25},(_,i)=>'T'+i),flag={kind:'possible_missed_follow_up',evidenceIds:ids,reviewDisposition:'coverage_unresolved'};assert.equal(V.normaliseFlag(flag).evidenceIds.length,20);assert.equal(V.normaliseFlag({...flag,reviewDisposition:undefined}).evidenceIds.length,8);});

test('malformed legacy audit metadata cannot break projection or expand sources',()=>{for(const value of [null,{},[null,{}]]){const d=fixture();d.candidateLedger=value;d.qualityState.actions.refereeMaterialization.unresolved=value;assert.deepEqual(coverageEvidenceFlags(d,d.reviewFlags),d.reviewFlags);}});
