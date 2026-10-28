'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const cases=require('../scripts/research/globalActionRegisterCases');
const Q=require('../scripts/research/globalActionRegisterQualification');
const S=require('../utils/meetingMinutesSemanticSourceVerification');
test('qualification corpus includes positive controls and independent negative boundaries without exposing expected verdicts',()=>{
 assert.equal(cases.length,22);assert.equal(cases.filter(c=>c.expectedConsolidation).length,4);
 cases.forEach((c,i)=>{
  const blinded=Q.blindCase(c,i),text=JSON.stringify(blinded);
  assert.equal(blinded.packet.comparisons.length,1);assert.ok(!text.includes(c.id));assert.ok(!text.includes('expectedConsolidation'));
  assert.deepEqual(blinded.packet.rows.map(r=>r.action.action),c.actions.map(a=>a.action));
 });
});
test('source challenges reuse complete original clauses and require source and owner witnesses',()=>{
 const items=cases.slice(0,4).map(Q.blindCase),packet=Q.verificationPacket(items);
 const response={version:S.VERSION,packetHash:packet.packetHash,sourceHash:packet.sourceHash,inputHash:packet.inputHash,decisions:packet.candidates.map(c=>({candidateId:c.candidateId,survivorRef:c.survivorRef,relation:'equivalent',checks:[c.leftRef,c.rightRef].flatMap(ref=>packet.rows.find(r=>r.ref===ref).clauses.map((_,clauseIndex)=>({originalRef:ref,clauseIndex,supported:true,retained:true,sourceIds:packet.rows.find(r=>r.ref===ref).action.evidenceIds})))}))};
 assert.equal(Q.verify(packet,response),'');
 const missing=structuredClone(response);missing.decisions[0].checks.pop();assert.equal(Q.verify(packet,missing),'incomplete_source_clause_accounting');
 const stale=structuredClone(response);stale.packetHash='old';assert.equal(Q.verify(packet,stale),'invalid_source_verification_envelope');
 const unowned=structuredClone(response);unowned.decisions[0].checks[0].sourceIds=[];assert.notEqual(Q.verify(packet,unowned),'');
 assert.match(Q.verificationPrompt(packet),/timing object and timingDecision/);
});
