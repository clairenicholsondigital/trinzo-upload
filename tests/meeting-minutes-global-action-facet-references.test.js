'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),P=require('../scripts/research/globalActionRegister'),Q=require('../scripts/research/globalActionRegisterQualification'),F=require('../scripts/research/globalActionFacetReview'),X=require('../scripts/research/globalActionFacetReferences');
function fixture(status='not_retained'){
 const base=Q.blindCase(require('../scripts/research/globalActionRegisterCases')[0],0).packet,packet=F.prepare(base,base.comparisons[0].comparisonId,base.rows[0].ref),survivor=packet.rows[0];
 const original={version:F.VERSION,packetHash:packet.packetHash,comparisonId:packet.comparisonId,survivorRef:packet.survivorRef,survivorHash:packet.survivorHash,decisions:packet.checks.map(c=>({facetId:c.facetId,originalRef:c.originalRef,originalHash:c.originalHash,source:{status:'supported',reason:'Fixture only.',sourceSpans:packet.sourceUnits.map(s=>({unitId:s.id,field:'text',quote:s.text}))},...(!c.exactSelfRetention?{retention:{status,reason:'Locked fixture verdict.',survivorSpans:[{field:'invented-field',quote:'invented'}]}}:{})}))};
 const repair=X.prepare(packet,original),response={version:X.VERSION,repairHash:repair.repairHash,decisions:repair.repairs.map(r=>({facetId:r.facetId,selectionIds:status==='retained'?[r.selections[0].selectionId]:[]}))};return {packet,original,repair,response};
}
test('reference selection repairs format while preserving a negative semantic veto',()=>{
 const {packet,original,repair,response}=fixture(),before=structuredClone(original),out=X.apply(packet,original,repair,response);
 assert.equal(out.assessment.contractError,'');assert.equal(out.assessment.modelPassed,false);assert.equal(out.semanticVerdictsUnchanged,true);assert.deepEqual(original,before);
 assert.equal(out.assessment.productionQualified,false);assert.equal(out.assessment.appliedEdits,0);
});
test('positive references materialize only exact existing survivor fields',()=>{
 const {packet,original,repair,response}=fixture('retained'),out=X.apply(packet,original,repair,response);
 assert.equal(out.assessment.contractError,'');assert.equal(out.assessment.modelPassed,true);
 for(const d of out.response.decisions)if(d.retention)for(const span of d.retention.survivorSpans)assert.ok(F.fieldText(packet.rows[0].action,span.field).includes(span.quote));
});
test('a repair cannot supply verdicts, guessed IDs, another response or empty positive evidence',()=>{
 for(const mutate of [r=>r.decisions[0].status='retained',r=>r.decisions[0].selectionIds=['invented'],r=>r.repairHash='old',r=>r.decisions[0].selectionIds=[]]){
  const {packet,original,repair,response}=fixture('retained');mutate(response);assert.throws(()=>X.apply(packet,original,repair,response));
 }
 const {packet,original,repair,response}=fixture();const changed=structuredClone(original);changed.decisions[0].source.status='unsupported';assert.throws(()=>X.apply(packet,changed,repair,response));
});
test('source failures, incomplete accounting and semantic vetoes alone are not repairable reference errors',()=>{
 const {packet,original}=fixture();const missing=structuredClone(original);missing.decisions.pop();assert.throws(()=>X.prepare(packet,missing));
 const wrongSource=structuredClone(original);wrongSource.decisions[0].source.sourceSpans[0].quote='not in source';assert.throws(()=>X.prepare(packet,wrongSource));
 const binding=structuredClone(original);binding.comparisonId='wrong';assert.throws(()=>X.prepare(packet,binding));
});
