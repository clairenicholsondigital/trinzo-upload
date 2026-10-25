'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {prepare,prompt,assess}=require('../scripts/research/globalActionRegister');
const action=(id,wording,extra={})=>({id,action:wording,owners:['Sam'],evidenceIds:['T1'],timing:{kind:'not_stated',wording:'',exactDate:''},...extra});
const sourceUnits=[{id:'T1',speaker:'Sam',text:'I will draft the renewal letter explaining the fee increase effective January.'}];
const actions=[action('draft','Draft the renewal letter explaining the fee increase effective January.'),action('explain','Explain the fee increase in the renewal letter.'),action('send','Send the renewal letter.',{owners:['Riley']})];
const response=p=>({packetHash:p.packetHash,decisions:p.comparisons.map(pair=>({comparisonId:pair.comparisonId,relation:'equivalent',reason:'A nomination for independent review, not proof.'}))});
test('all global pairs remain visible across different verbs, owners and protected timing',()=>{
 const packet=prepare({actions,sourceUnits});assert.equal(packet.comparisons.length,3);
 assert.ok(packet.comparisons.some(p=>p.leftRef===packet.rows[0].ref&&p.rightRef===packet.rows[1].ref));
 assert.match(prompt(packet),/effective dates versus deadlines/);assert.match(prompt(packet),/independent/);
});
test('even unanimous equivalence cannot edit wording, fields, counts, warning history or unresolved groups',()=>{
 const rows=[...actions,action('protected','Review the letter only after approval.',{reviewerAuthored:true,reviewFlagIds:['warning'],timing:{kind:'dependency',wording:'after approval',exactDate:''}})];
 const before=structuredClone(rows),context=[{candidateId:'group',disposition:'unresolved',evidenceIds:['T1']}];
 const packet=prepare({actions:rows,sourceUnits,unresolvedContext:context}),out=assess(packet,response(packet));
 assert.deepEqual(out.actions,before);assert.deepEqual(rows,before);assert.deepEqual(out.unresolvedContext,context);
 assert.equal(out.appliedEdits,0);assert.equal(out.productionQualified,false);
 assert.ok(out.comparisons.every(p=>p.status==='needs_independent_source_verification'));
});
test('stale, incomplete, duplicate and invalid assessments fail closed',()=>{
 const p=prepare({actions,sourceUnits});
 for(const mutate of [r=>r.packetHash='stale',r=>r.decisions.pop(),r=>r.decisions[1]=r.decisions[0],r=>r.decisions[0].relation='merge',r=>r.decisions[0].reason='']){
  const r=response(p);mutate(r);assert.throws(()=>assess(p,r));
 }
 const changed=structuredClone(p);changed.rows[0].action.action='Altered';assert.throws(()=>assess(changed,response(p)));
});
test('missing citations remain explicit and invalid source IDs or oversized registers never truncate silently',()=>{
 const p=prepare({actions:[action('missing','Review the register.',{evidenceIds:['T404']})],sourceUnits});
 assert.deepEqual(p.rows[0].unresolvedSourceIds,['T404']);assert.deepEqual(p.rows[0].sources,[]);
 assert.throws(()=>prepare({actions,sourceUnits:[...sourceUnits,...sourceUnits]}));
 assert.throws(()=>prepare({actions:Array.from({length:101},(_,i)=>action(String(i),'Review the register.')),sourceUnits}));
});
