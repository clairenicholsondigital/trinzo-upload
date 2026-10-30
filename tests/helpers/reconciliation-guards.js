'use strict';
const test=require('node:test'),assert=require('node:assert/strict');

// The same review protections, exercised with each feature's own data/policy.
function registerBounds({name,parent,child,C,S,policy,sourceUnits,answer}, recipient) {
const cases = [
 ['warning',r=>r.reviewFlagIds=['warning']],['owner',r=>r.owners=['Other Person']],['reviewer',r=>r.reviewerAuthored=true],['extra metadata',r=>r.notes='keep'],
 ['dated',r=>r.timing={kind:'target',wording:'tomorrow',exactDate:''}],['condition',r=>r.action+=' if approved'],['history',r=>r.timingDecision={status:'rejected',rejectedWordings:['tomorrow']}],
 ['recipient',recipient],['separate work',r=>r.action='Send the completed notice to the regional team.']
];
for (const [label,change] of cases) test(name+': excludes '+label,()=>{const other=structuredClone(child);change(other);assert.equal(C.direction(parent,other),null);});
}
function registerVeto({name,parent,child,C,S,policy,sourceUnits,answer}) {
test(name+': independent veto or withdrawal never authorizes a merge',async()=>{
  for(const challenge of [false,true]){let calls=0;const out=await S.reconcileGeneratedSemanticStage({changes:{actions:[parent,child]}},{sourceUnits},'actions',{policy,ask:async prompt=>{calls++;const data=JSON.parse(prompt.split('\nDATA\n')[1]),r=answer(data);if(data.reviewPurpose===(challenge?'independent_challenge':'proposal'))r.decisions[2].relation='distinct_work';return {result:r};}});assert.equal(calls,challenge?2:1);assert.deepEqual(out.changes.actions,[parent,child]);}
  assert.throws(()=>C.reviewPacket(parent,child,[{...sourceUnits[0],text:sourceUnits[0].text+' That instruction is cancelled.'}],['T0001'],false),/withdrawal/);
 });
}
function registerAccounting({name,parent,child,C,S,policy,sourceUnits,answer}) {
test(name+': malformed/missing independent accounting cannot certify',()=>{
  const p=C.reviewPacket(parent,child,sourceUnits,['T0001'],false),q=C.reviewPacket(parent,child,sourceUnits,['T0001'],true),a=answer(p),b=answer(q);b.decisions[1].checks=[];
  assert.throws(()=>C.certify(parent,child,sourceUnits,['T0001'],a,b));
 });
}
module.exports={registerBounds,registerVeto,registerAccounting};
