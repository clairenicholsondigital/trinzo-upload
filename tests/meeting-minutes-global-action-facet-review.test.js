'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const P=require('../scripts/research/globalActionRegister'),F=require('../scripts/research/globalActionFacetReview');
const Q=require('../scripts/research/globalActionRegisterQualification'),cases=require('../scripts/research/globalActionRegisterCases');
function fixture(index=0,survivorIndex=0){
 const {packet}=Q.blindCase(cases[index],index),pair=packet.comparisons[0];
 return F.prepare(packet,pair.comparisonId,[pair.leftRef,pair.rightRef][survivorIndex]);
}
function supportedResponse(packet){
 const survivor=packet.rows.find(row=>row.ref===packet.survivorRef);
 return {version:F.VERSION,packetHash:packet.packetHash,comparisonId:packet.comparisonId,survivorRef:packet.survivorRef,survivorHash:packet.survivorHash,
 decisions:packet.checks.map(check=>({facetId:check.facetId,originalRef:check.originalRef,originalHash:check.originalHash,
 source:{status:'supported',reason:'Synthetic contract fixture only, not a semantic proof.',sourceSpans:packet.sourceUnits.map(unit=>({unitId:unit.id,field:'text',quote:unit.text}))},
 ...(!check.exactSelfRetention?{retention:{status:'retained',reason:'Synthetic contract fixture.',survivorSpans:check.field==='owners'?[{field:'owners',quote:JSON.stringify(survivor.action.owners)}]:check.field==='timing'?[{field:'timing.wording',quote:survivor.action.timing.wording}]:[{field:'instruction',quote:survivor.action.action}]}}:{})}))};
}
test('one explicit pair retains global inventory and unassessed comparisons without labelling them distinct',()=>{
 const first=cases[0],third={...structuredClone(first.actions[0]),id:'unrelated',action:'Inspect the ventilation unit.'};
 const global=P.prepare({actions:[...first.actions,third],sourceUnits:first.sourceUnits,unresolvedContext:[{id:'unmapped-group'}]});
 const packet=F.prepare(global,global.comparisons[0].comparisonId,global.rows[0].ref);
 assert.equal(packet.rows.length,2);assert.equal(packet.globalInventory.length,3);assert.equal(packet.unassessedComparisonIds.length,2);
 assert.equal(Object.isFrozen(packet.rows[0].action),true);
 const result=F.assess(packet,supportedResponse(packet));assert.deepEqual(result.actions,first.actions);assert.equal(result.unassessedComparisonIds.length,2);assert.deepEqual(result.unresolvedContext,[{id:'unmapped-group'}]);
});
test('exact self-retention never approves unsupported source content',()=>{
 const packet=fixture(),response=supportedResponse(packet),self=packet.checks.find(c=>c.exactSelfRetention);
 const check=response.decisions.find(c=>c.facetId===self.facetId);check.source.status='unsupported';check.source.reason='No commitment in the source.';
 const result=F.assess(packet,response);assert.equal(result.assessment,'vetoed');assert.equal(result.checks.find(c=>c.facetId===self.facetId).retention.method,'exact_same_record');
 assert.equal(result.productionQualified,false);assert.equal(result.appliedEdits,0);
});
test('a model cannot override exact record identity with a false self-retention veto or approval',()=>{
 const packet=fixture(),response=supportedResponse(packet),self=packet.checks.find(c=>c.exactSelfRetention);
 response.decisions.find(c=>c.facetId===self.facetId).retention={status:'not_retained',reason:'Mistake',survivorSpans:[]};
 assert.equal(F.error(packet,response),'model_overrode_exact_self_retention');
});
test('every facet, original hash and selected survivor are bound without relying on row order',()=>{
 const packet=fixture(),valid=supportedResponse(packet);valid.decisions.reverse();assert.equal(F.error(packet,valid),'');
 for(const [mutate,expected] of [
  [r=>r.decisions.pop(),'incomplete_facet_accounting'],
  [r=>r.decisions[0]=r.decisions[1],'wrong_or_duplicate_facet_binding'],
  [r=>r.survivorRef='other-row','stale_or_wrong_bound_pair'],
  [r=>r.decisions[0].originalHash='changed','wrong_or_duplicate_facet_binding'],
  [r=>r.comparisonId='other-pair','stale_or_wrong_bound_pair'],
  [r=>r.packetHash='stale','stale_or_wrong_bound_pair']
 ]){const r=structuredClone(valid);mutate(r);assert.equal(F.error(packet,r),expected);}
 const changed=structuredClone(packet);changed.rows[0].action.action='New instruction';assert.equal(F.error(changed,valid),'changed_facet_packet');
});
test('unsupported or unclear judgments remain vetoes, never repair requests',()=>{
 for(const status of ['unsupported','unclear']){
  const packet=fixture(),response=supportedResponse(packet);response.decisions[0].source.status=status;
  const result=F.assess(packet,response);assert.equal(result.contractError,'');assert.equal(result.modelPassed,false);
 }
 const packet=fixture(),response=supportedResponse(packet),check=response.decisions.find(c=>c.retention);
 check.retention={status:'not_retained',reason:'Required recipient omitted.',survivorSpans:[]};assert.equal(F.assess(packet,response).assessment,'vetoed');
});
test('invented source or survivor text and missing owner witnesses fail closed',()=>{
 const packet=fixture(),valid=supportedResponse(packet);
 let r=structuredClone(valid);r.decisions[0].source.sourceSpans[0].quote='Invented quote';assert.equal(F.error(packet,r),'invalid_source_quote');
 r=structuredClone(valid);r.decisions[0].source.sourceSpans=[];assert.equal(F.error(packet,r),'supported_without_source');
 r=structuredClone(valid);r.decisions.find(c=>c.retention).retention.survivorSpans=[{field:'instruction',quote:'Invented survivor'}];assert.equal(F.error(packet,r),'invalid_survivor_quote');
 r=structuredClone(valid);r.decisions.find(c=>c.retention).retention.survivorSpans=[];assert.equal(F.error(packet,r),'retained_without_survivor_text');
 const altered=structuredClone(cases[0]);altered.sourceUnits[0].speaker='Unknown';const global=Q.blindCase(altered,0).packet;const unowned=F.prepare(global,global.comparisons[0].comparisonId,global.rows[0].ref);
 assert.equal(F.error(unowned,supportedResponse(unowned)),'missing_source_owner_witness');
});
test('even invented perfect model judgments cannot bypass quantity, owner, separate-operation or reviewer safeguards',()=>{
 for(const index of [5,10,14,18,21]){
  const packet=fixture(index),result=F.assess(packet,supportedResponse(packet));
  assert.equal(result.modelPassed,true,'deliberately adversarial model fixture');assert.ok(result.guards.length);assert.equal(result.productionQualified,false);assert.equal(result.appliedEdits,0);
  assert.deepEqual(result.actions,cases[index].actions.map((a,i)=>({...a,id:`G${index+1}A${i+1}`,evidenceIds:a.evidenceIds.map(id=>`G${index+1}S${cases[index].sourceUnits.findIndex(s=>s.id===id)+1}`)})));
 }
});
test('timing and qualification facets are explicit while timing history remains in the complete record',()=>{
 const packet=fixture(3);assert.ok(packet.checks.some(c=>c.field==='timing'));assert.ok(packet.checks.some(c=>c.field==='conditions'));
 assert.match(F.prompt(packet),/effective date is not a task deadline/);assert.match(F.prompt(packet),/No top-level positive verdict/);
});
test('a quotation from the wrong survivor field cannot substantiate a facet',()=>{
 const packet=fixture(),response=supportedResponse(packet);
 const ownerFacet=packet.checks.find(c=>c.field==='owners'&&!c.exactSelfRetention);
 response.decisions.find(c=>c.facetId===ownerFacet.facetId).retention.survivorSpans=[{field:'instruction',quote:packet.rows.find(r=>r.ref===packet.survivorRef).action.action}];
 assert.equal(F.error(packet,response),'invalid_survivor_quote');
});
test('held-out rejected history survives as a blocker even when the model says every action facet matches',()=>{
 const extended=require('../scripts/research/globalActionFacetCases'),item=extended.at(-1),global=Q.blindCase(item,25).packet;
 const packet=F.prepare(global,global.comparisons[0].comparisonId,global.rows[item.survivorIndex].ref);
 const result=F.assess(packet,supportedResponse(packet));
 assert.equal(result.modelPassed,true);assert.ok(result.guards.some(g=>g.reason==='timing_history_requires_preservation'));
 assert.equal(result.productionQualified,false);assert.deepEqual(result.actions[0].timingDecision,item.actions[0].timingDecision);
});
test('speaker metadata is a typed owner witness, never fabricated transcript text',()=>{
 const packet=fixture(),response=supportedResponse(packet),owner=packet.checks.find(c=>c.field==='owners');
 const check=response.decisions.find(c=>c.facetId===owner.facetId),unit=packet.sourceUnits[0];
 check.source.sourceSpans=[{unitId:unit.id,field:'speaker',quote:unit.speaker}];assert.equal(F.error(packet,response),'');
 check.source.sourceSpans[0].field='text';assert.equal(F.error(packet,response),'invalid_source_quote');
});
test('an unrelated full-name owner turn outside the existing citations cannot replace the task witness',()=>{
 const base=Q.blindCase(cases[0],0).packet;
 const global=P.prepare({actions:base.rows.map(r=>r.action),sourceUnits:[...base.sourceUnits,{id:'other-owner-turn',speaker:'Sam Lee',text:'I will inspect the unrelated ventilation unit.'}]});
 const packet=F.prepare(global,global.comparisons[0].comparisonId,global.rows[0].ref),response=supportedResponse(packet);
 const instruction=packet.checks.find(c=>c.field==='instruction');
 response.decisions.find(c=>c.facetId===instruction.facetId).source.sourceSpans=[{unitId:'other-owner-turn',field:'text',quote:'I will inspect the unrelated ventilation unit.'}];
 assert.equal(F.error(packet,response),'missing_source_owner_witness');
});
