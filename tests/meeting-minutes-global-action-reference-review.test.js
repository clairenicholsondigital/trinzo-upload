'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),P=require('../scripts/research/globalActionRegister'),Q=require('../scripts/research/globalActionRegisterQualification'),N=require('../scripts/research/globalActionReferenceReview'),cases=require('../scripts/research/globalActionRequirementCases');
function fixture(index=0){const global=Q.blindCase(cases[index],index).packet;return N.prepare(global,global.comparisons[0].comparisonId,global.rows[cases[index].survivorIndex].ref);}
function response(packet){return {requestId:packet.requestId,decisions:[
 {kind:'source',rows:packet.sourceRows.map(row=>({rowId:row.rowId,basis:'commitment',checks:row.requests.map(request=>({id:request.id,status:'supported',reason:'Contract fixture only.',refs:packet.sourceCatalog.filter(ref=>ref.field==='text').map(ref=>ref.id)}))}))},
 {kind:'retention',checks:packet.retentionRequests.map(request=>({id:request.id,status:'retained',reason:'Contract fixture only.',refs:[request.allowedRefs[0]]}))},
 {kind:'relationship',relation:'same_obligation',reason:'Contract fixture only.',refs:packet.sourceCatalog.filter(ref=>ref.field==='text').map(ref=>ref.id)}]};}
test('both original source lists and only non-self retention have independent exact accounting',()=>{
 const packet=fixture(),r=response(packet);assert.equal(N.validate(packet,r),'');
 const omitSelf=structuredClone(r);omitSelf.decisions[0].rows[0].checks=[];assert.equal(N.validate(packet,omitSelf),'source_incomplete_check_accounting');
 const omitRetention=structuredClone(r);omitRetention.decisions[1].checks=[];assert.equal(N.validate(packet,omitRetention),'retention_incomplete_check_accounting');
 const omitRow=structuredClone(r);omitRow.decisions[0].rows.pop();assert.equal(N.validate(packet,omitRow),'incomplete_original_source_accounting');
});
test('short response references materialize immutable original and selected-survivor data only',()=>{
 const packet=fixture(),r=response(packet),out=N.assess(packet,r);
 assert.equal(out.modelPassed,true);assert.equal(out.productionQualified,false);assert.equal(out.appliedEdits,0);
 assert.deepEqual(out.actions,packet.base.rows.map(row=>row.action));
 assert.ok(out.checks.every(c=>c.source.sourceSpans.every(s=>packet.base.sourceUnits.some(unit=>unit.id===s.unitId&&unit[s.field]===s.quote))));
 assert.ok(out.checks.filter(c=>c.retention.method!=='exact_same_record').every(c=>c.retention.survivorSpans.length));
});
test('wrong request tokens, changed packets and cross-check reference IDs fail closed',()=>{
 const packet=fixture(),r=response(packet);r.requestId='other';assert.equal(N.validate(packet,r),'wrong_request_binding');
 const changed=structuredClone(packet);changed.base.rows[0].action.action='Changed';assert.equal(N.validate(changed,response(packet)),'changed_reference_packet');
 const wrongSource=response(packet);wrongSource.decisions[0].rows[0].checks[0].refs=['other-source'];assert.equal(N.validate(packet,wrongSource),'source_invalid_check_accounting');
 const wrongRecord=response(packet);wrongRecord.decisions[1].checks[0].refs=['other-survivor'];assert.equal(N.validate(packet,wrongRecord),'retention_invalid_check_accounting');
 const owner=response(packet);const index=packet.retentionRequests.findIndex(c=>c.field==='owners');owner.decisions[1].checks[index].refs=['v1'];assert.equal(N.validate(packet,owner),'invalid_survivor_field_reference');
});
test('contained requirements can be supported without declaring a new standalone assignment',()=>{
 const packet=fixture(1),r=response(packet);r.decisions[0].rows[1].basis='required_component';r.decisions[2].relation='discarded_requirement_of_survivor';
 assert.equal(N.assess(packet,r).modelPassed,true);
 r.decisions[0].rows[1].checks[0].status='unsupported';assert.equal(N.assess(packet,r).modelPassed,false);
});
test('role and retention vetoes remain vetoes even if other source checks pass',()=>{
 for(const relation of ['distinct_work','partial_overlap','unclear']){const p=fixture(),r=response(p);r.decisions[2].relation=relation;assert.equal(N.assess(p,r).modelPassed,false);}
 const p=fixture(),r=response(p);r.decisions[1].checks[0]={...r.decisions[1].checks[0],status:'not_retained',refs:[]};assert.equal(N.assess(p,r).assessment,'vetoed');
 const s=response(p);s.decisions[0].rows[0].basis='unclear';assert.equal(N.assess(p,s).assessment,'vetoed');
});
test('perfect model answers do not bypass deterministic preservation guards',()=>{
 for(const index of [5,10,14,18,21,25]){const p=fixture(index),out=N.assess(p,response(p));assert.equal(out.contractError,'');assert.ok(out.guards.length);assert.equal(out.productionQualified,false);}
});
test('all source requests still need actual spoken instruction evidence and cited ownership witnesses',()=>{
 const p=fixture(),r=response(p);r.decisions[0].rows[0].checks[0].refs=[p.sourceCatalog.find(ref=>ref.field==='speaker').id];assert.equal(N.validate(p,r),'invalid_source_quote');
 const global=Q.blindCase(cases[0],0).packet;
 const added=P.prepare({actions:global.rows.map(row=>row.action),sourceUnits:[...global.sourceUnits,{id:'other',speaker:'Sam Lee',text:'I will check the unrelated unit.'}]});
 const packet=N.prepare(added,added.comparisons[0].comparisonId,added.rows[0].ref),s=response(packet);s.decisions[0].rows[0].checks[0].refs=['other'];assert.equal(N.validate(packet,s),'missing_source_owner_witness');
});
test('new content/independent-work holdouts remain hidden from the model',()=>{
 assert.equal(cases.length,32);const held=cases.filter(c=>c.newRequirementHoldout);assert.equal(held.length,6);assert.equal(held.filter(c=>c.expectedModelPass).length,3);
 for(let i=26;i<32;i++){const p=fixture(i),text=N.prompt(p);assert.ok(!text.includes(cases[i].id));assert.ok(!text.includes('expectedModelPass'));assert.match(text,/Source-row basis required_component does not excuse missing evidence/);}
});
test('canonical source IDs are used directly and metadata namespace collisions fail closed',()=>{
 const packet=fixture();assert.ok(packet.sourceCatalog.some(ref=>ref.id===packet.base.sourceUnits[0].id&&ref.field==='text'));
 const global=Q.blindCase(cases[0],0).packet,unit=global.sourceUnits[0];
 const collision=P.prepare({actions:global.rows.map(row=>row.action),sourceUnits:[...global.sourceUnits,{id:unit.id+'@speaker',speaker:'Other',text:'Unrelated.'}]});
 assert.throws(()=>N.prepare(collision,collision.comparisons[0].comparisonId,collision.rows[0].ref),/ambiguous_source_reference_namespace/);
});
test('legacy wire aliases resolve only the exact unique canonical source, never a guessed source or changed verdict',()=>{
 const packet=fixture(),r=response(packet),legacy=structuredClone(packet);
 // Emulate the previous alias representation while preserving exact source units.
 const text=legacy.sourceCatalog.find(ref=>ref.field==='text');const canonical=text.unitId;const alias='legacy-text-ref';text.id=alias;
 const adapted=N.resolveCanonicalSourceRefs(legacy,r);
 assert.ok(adapted.resolutions.length>0);assert.ok(adapted.resolutions.every(item=>item.provided===canonical&&item.resolved===alias));
 const strip=reply=>{const c=structuredClone(reply);c.decisions.forEach(section=>{if(section.kind==='source')section.rows.forEach(row=>row.checks.forEach(check=>delete check.refs));if(section.kind==='relationship')delete section.refs;});return c;};
 assert.deepEqual(strip(adapted.response),strip(r));assert.deepEqual(r,response(packet));
 const unknown=response(packet);unknown.decisions[0].rows[0].checks[0].refs=['unknown-source'];assert.deepEqual(N.resolveCanonicalSourceRefs(packet,unknown).response,unknown);
});
test('a canonical source token that also names different metadata is not silently translated',()=>{
 const packet=structuredClone(fixture()),r=response(packet),unit=packet.base.sourceUnits[0].id;
 packet.sourceCatalog.push({id:unit,unitId:'other',field:'speaker',quote:'Other'});
 assert.throws(()=>N.resolveCanonicalSourceRefs(packet,r),/ambiguous_canonical_source_reference/);
});
test('malformed reference envelopes remain invalid without crashing normalization',()=>{
 const packet=fixture();for(const value of [null,{}, {decisions:{}},{decisions:[{kind:'source',rows:{}},{kind:'retention'},{kind:'relationship'}]}]){
  const out=N.resolveCanonicalSourceRefs(packet,value);assert.deepEqual(out.response,value);assert.notEqual(N.validate(packet,out.response),'');
 }
});
