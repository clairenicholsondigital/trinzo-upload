'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {nominateDiscussionPlacement:nominate}=require('../utils/canonicalMinutes/discussionPlacementNomination');
const make=()=>({sourceUnits:[{id:'T1',speaker:'Morgan',text:'The compressor casing is cracked. Supplier certification expires on Tuesday. Delivery insurance covers transport only. There are four replacement valves in storage.'}],
  discussion:[{id:'t',topic:'Workshop',points:[{id:'p',text:'The compressor casing is cracked. Supplier certification expires on Tuesday. Delivery insurance covers transport only. There are four replacement valves in storage.',evidenceIds:['T1']}],decisions:[],openQuestions:[]}],
  unassignedSupportingDetails:[{id:'d',text:'The compressor casing is cracked.',evidenceIds:['T1']}]});
test('clause nomination is immutable, bounded and never a placement approval',()=>{
  const d=make(),saved=structuredClone(d),p=nominate(d);assert.equal(p.nominations.length,1);
  assert.equal(p.mode,'shadow_only');assert.equal(p.nominations[0].automaticPlacementAllowed,false);
  assert.equal(p.nominations[0].matchedClause,'The compressor casing is cracked. ');assert.deepEqual(d,saved);
});
for(const [name,edit]of [
  ['unresolved explicit target',d=>{d.unassignedSupportingDetails[0].placementReason='explicit_target_missing';}],
  ['archived explicit target',d=>{d.unassignedSupportingDetails[0].filingOrigins=[{placementReason:'ambiguous_explicit_target'}];}],
  ['reviewer detail',d=>{d.unassignedSupportingDetails[0].reviewerAuthored=true;}],
  ['reviewer parent',d=>{d.discussion[0].points[0].reviewerAuthored=true;}],
  ['missing detail source',d=>{d.unassignedSupportingDetails[0].evidenceIds=['missing'];}],
  ['duplicate source',d=>{d.sourceUnits.push(d.sourceUnits[0]);}],
  ['duplicate parent identity',d=>{d.discussion[0].points.push({...d.discussion[0].points[0]});}],
  ['duplicate detail identity',d=>{d.unassignedSupportingDetails.push({...d.unassignedSupportingDetails[0]});}]
])test(name+' cannot acquire a proposed parent',()=>{const d=make();edit(d);assert.equal(nominate(d).nominations.length,0);});
test('warned material stays explicitly protected even in a diagnostic nomination',()=>{
  const d=make();d.discussion[0].points[0].reviewFlagIds=['warning'];const p=nominate(d);
  assert.equal(p.nominations[0].warningProtected,true);assert.equal(p.nominations[0].automaticPlacementAllowed,false);
});
test('zero diagnostic budget yields no nominations',()=>{assert.equal(nominate(make(),{limit:0}).nominations.length,0);});
test('a rationale-only citation never becomes automatic approval for a proposed plan',()=>{
 const d=make();d.sourceUnits=[{id:'T1',speaker:'Morgan',text:'This allows us to use your software expertise.'}];
 d.discussion[0].points[0].text='A separate software track is being considered. Focused software expertise would help.';
 d.unassignedSupportingDetails[0]={...d.unassignedSupportingDetails[0],text:'A separate software track allows focused software expertise.',filingOrigins:[{id:'origin',generatedRecord:{text:'A separate software track allows focused software expertise.',evidenceIds:['T1']}}]};
 const saved=structuredClone(d),p=nominate(d);assert.equal(p.mode,'shadow_only');assert.ok(p.nominations.every(n=>n.automaticPlacementAllowed===false));assert.deepEqual(d,saved);
});
test('a facility question cannot acquire confirmed-location status through filing',()=>{
 const d=make();d.sourceUnits=[{id:'T1',speaker:'Morgan',text:'Is that storage facility in North Quay?'}];
 d.discussion[0].points[0].text='The final storage arrangement and storage facility were discussed. Other transport requirements remain open.';
 d.unassignedSupportingDetails[0].text='The storage facility is in North Quay.';
 const saved=structuredClone(d),p=nominate(d);assert.ok(p.nominations.every(n=>n.automaticPlacementAllowed===false));assert.deepEqual(d,saved);
});
