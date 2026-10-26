'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const L=require('../scripts/lib/minutes_obligation_ledger_research');
function fixture(){
 const input={sourceHash:'frozen-full-source-hash',meetingDate:'2026-10-26',
  sourceUnits:[{id:'T1',speaker:'Lee Chen',text:'Could you send the register to Sam, Nora?'},{id:'T2',speaker:'Nora Patel',text:'Yes, I will.'},{id:'T3',speaker:'Chair',text:'Some neighbouring background.'}],
  members:[{ref:'M1',focusEvidenceId:'T1',text:'A generated interpretation that must not bias the inventory.',candidateId:'private-1'},{ref:'M2',focusEvidenceId:'T2',text:'Another generated interpretation.',candidateId:'private-2'}]};
 const p=L.inventoryPacket(input),e={requestId:p.requestId,decisions:[{kind:'source_obligation_ledger',records:[{ref:'O1',sourceStatus:'outstanding',sourceSpans:[{unitId:'T1',quote:input.sourceUnits[0].text},{unitId:'T2',quote:input.sourceUnits[1].text}],reason:'Request accepted by the assignee.'}]}]};
 const cp=L.reviewPacket(p,e),ce={requestId:cp.requestId,decisions:[{kind:'source_ledger_completeness',memberChecks:p.members.map(m=>({memberRef:m.ref,verdict:'complete',sourceIds:['T1','T2'],reason:'The accepted request is accounted for.'})),recordChecks:[{recordRef:'O1',supported:true,sourceStatusCorrect:true,allQualifications:true,sourceIds:['T1','T2'],reason:'Same obligation and correct final status.'}]}]};
 return {input,p,e,cp,ce};
}
test('one obligation can represent request and acceptance without generated candidate text or duplicate context records',()=>{
 const {input,p,e,cp,ce}=fixture();
 assert.deepEqual(p.members,[{ref:'M1',focusEvidenceId:'T1'},{ref:'M2',focusEvidenceId:'T2'}]);
 assert.ok(!JSON.stringify(p).includes('generated interpretation'));
 assert.equal(L.inventoryError(p,e),'');assert.equal(e.decisions[0].records.length,1);
 assert.equal(L.reviewError(cp,ce),'');assert.equal(L.reviewAccepted(cp,ce),true);
 p.sourceUnits[0].text='Mutated copy';assert.notEqual(p.sourceUnits[0].text,input.sourceUnits[0].text);
});
test('changed source, focus, status or quoted inventory invalidates an existing packet',()=>{
 const {p,e,cp,ce}=fixture();
 for(const mutate of [v=>v.sourceUnits[0].text+=' changed',v=>v.members[0].focusEvidenceId='T2',v=>v.sourceHash='another-source']){
  const bad=structuredClone(p);mutate(bad);assert.equal(L.inventoryError(bad,e),'changed_inventory_packet');
 }
 const stale=structuredClone(cp);stale.inventory.records[0].sourceStatus='not_outstanding';
 assert.equal(L.reviewError(stale,ce),'changed_review_packet');assert.equal(L.reviewAccepted(stale,ce),false);
});
test('ambiguous source IDs, duplicate member refs and missing focus evidence cannot enter the inventory',()=>{
 const {input,e}=fixture();
 for(const mutate of [v=>v.sourceUnits.push(v.sourceUnits[0]),v=>v.members[1].ref='M1',v=>v.members[0].focusEvidenceId='absent']){
  const changed=structuredClone(input);mutate(changed);const p=L.inventoryPacket(changed),response={...e,requestId:p.requestId};
  assert.notEqual(L.inventoryError(p,response),'');
 }
});
test('invented quotes, neighbour-only work and duplicate obligation refs remain blocked',()=>{
 const {p,e}=fixture();
 for(const mutate of [v=>v.decisions[0].records[0].sourceSpans[0].quote='invented',v=>v.decisions[0].records[0].sourceSpans=[{unitId:'T3',quote:'Some neighbouring background.'}],v=>v.decisions[0].records.push(v.decisions[0].records[0]),v=>v.decisions[0].records[0].sourceStatus='committed']){
  const bad=structuredClone(e);mutate(bad);assert.notEqual(L.inventoryError(p,bad),'');assert.throws(()=>L.reviewPacket(p,bad));
 }
});
test('completed and uncertain records retain explicit status for independent review without becoming current commitments',()=>{
 for(const status of ['not_outstanding','uncertain']){
  const {p,e}=fixture();e.decisions[0].records[0].sourceStatus=status;
  assert.equal(L.inventoryError(p,e),'');const review=L.reviewPacket(p,e);
  assert.equal(review.inventory.records[0].sourceStatus,status);
 }
});
test('an empty inventory still requires every original member to be independently checked',()=>{
 const {p,e,ce}=fixture();e.decisions[0].records=[];const cp=L.reviewPacket(p,e),response=structuredClone(ce);
 response.requestId=cp.requestId;response.decisions[0].recordChecks=[];
 assert.equal(L.reviewAccepted(cp,response),true);
 response.decisions[0].memberChecks.pop();assert.equal(L.reviewAccepted(cp,response),false);
});
test('missing, duplicated or foreign member and record checks cannot certify completeness',()=>{
 const {cp,ce}=fixture();
 for(const mutate of [v=>v.decisions[0].memberChecks.pop(),v=>v.decisions[0].memberChecks[1].memberRef='M1',v=>v.decisions[0].recordChecks=[],v=>v.decisions[0].recordChecks[0].recordRef='foreign',v=>v.decisions[0].memberChecks[0].sourceIds=['T2'],v=>v.decisions[0].recordChecks[0].sourceIds=['absent']]){
  const bad=structuredClone(ce);mutate(bad);assert.notEqual(L.reviewError(cp,bad),'');assert.equal(L.reviewAccepted(cp,bad),false);
 }
});
test('valid semantic vetoes stay valid vetoes, not formatting repairs or approval',()=>{
 const {cp,ce}=fixture();
 for(const field of ['supported','sourceStatusCorrect','allQualifications']){
  const veto=structuredClone(ce);veto.decisions[0].recordChecks[0][field]=false;
  assert.equal(L.reviewError(cp,veto),'');assert.equal(L.reviewAccepted(cp,veto),false);
 }
 const unresolved=structuredClone(ce);unresolved.decisions[0].memberChecks[1].verdict='unresolved';
 assert.equal(L.reviewError(cp,unresolved),'');assert.equal(L.reviewAccepted(cp,unresolved),false);
});
test('a neighbour-only record check cannot witness the focused work',()=>{
 const {cp,ce}=fixture();ce.decisions[0].recordChecks[0].sourceIds=['T3'];
 assert.equal(L.reviewError(cp,ce),'bad_record_check');
});
test('packets and evidence survive serialization without changing decisions or granting mutation authority',()=>{
 const {p,e,cp,ce}=fixture(),copy=x=>JSON.parse(JSON.stringify(x));
 assert.equal(L.inventoryError(copy(p),copy(e)),'');assert.equal(L.reviewAccepted(copy(cp),copy(ce)),true);
 assert.ok(!Object.keys(L).some(k=>/apply|merge|close|publish|save|ask/i.test(k)));
});
