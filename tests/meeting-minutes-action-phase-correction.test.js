'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const F=require('../utils/meetingMinutesActionPhaseCorrection'),ProposalTiming = require('../utils/meetingMinutesProposalTiming'),T=require('../utils/meetingMinutesTiming');
const provider=require('./helpers/action-phase-provider');
const fixture=require('./helpers/action-phase-fixture');
const run=(f,mutate,extra={})=>F.correct(f.actions,f.units,{meetingDate:'2026-06-15',ask:provider(f,mutate),...extra});
for(const reverse of [false,true])test('source-proven two-phase correction preserves all warnings and rejected timing (reverse='+reverse+')',async()=>{
 const f=fixture();if(reverse)f.actions.reverse();const before=structuredClone(f),r=await run(f);
 assert.equal(r.audit.applied,true,JSON.stringify(r.audit));assert.equal(r.actions.length,2);assert.equal(r.audit.calls,2);
 const initial=r.actions.find(a=>a.id==='b'),later=r.actions.find(a=>a.id==='a');
 assert.match(initial.action,/Tidy and share/);assert.match(later.action,/^Add .* afterwards\.$/);
 assert.equal(initial.timing.wording,'hoping done for Tuesday');assert.deepEqual(later.timing,{kind:'not_stated',wording:'',exactDate:''});
 for(const a of r.actions){assert.equal(a.timingDecision.status,'rejected');assert.equal(a.timingDecision.checkerStatus,'rejected');assert.deepEqual(a.timingDecision.rejectedExactDates,['2026-06-16']);}
 assert.deepEqual(new Set(r.actions.flatMap(a=>a.reviewFlagIds)),new Set(f.actions.flatMap(a=>a.reviewFlagIds)));
 assert.equal(F.valid(r.audit.receipts[0],r.actions,f.units,'2026-06-15'),true);
 assert.deepEqual(F.restore(r.actions,r.audit,f.units,'2026-06-15'),f.actions);assert.deepEqual(f,before);
 const final=ProposalTiming.finaliseActionTimings(r.actions,f.units,{meetingDate:'2026-06-15'}).actions;
 assert.equal(final.find(a=>a.id==='a').timing.exactDate,'');assert.equal(final.find(a=>a.id==='b').timing.exactDate,'');
 assert.ok(final.every(a=>a.timingDecision.status==='rejected'));
});
for(const [label,part,mutate] of [
 ['decline','proposal',r=>r.decision='decline'],['missing row','proposal',r=>r.rows.pop()],
 ['lost technical scope','proposal',r=>r.rows[0].action=r.rows[0].action.replace('thermal and ','')],
 ['new obligation','proposal',r=>r.rows[0].action+=' Purchase an engine.'],
 ['handoff repeated','proposal',r=>r.rows[0].action='Add the considerations and share the checklist afterwards.'],
 ['unknown source','proposal',r=>r.claims[0].sourceWitnesses[0].sourceId='T9999'],
 ['clipped witness','proposal',r=>r.claims[0].sourceWitnesses[0].quote='I will add those considerations.'],
 ['missing original claim','proposal',r=>r.claims.splice(2,1)],
 ['wrong ordering','verification',r=>r.checks.sourceOrderRetained=false],
 ['timing donated','verification',r=>r.checks.noTimingDonated=false],
 ['wrong recipient','verification',r=>r.checks.sameRecipientPurpose=false],
 ['incomplete output checks','verification',r=>r.outputChecks.pop()],
 ['unsupported phase','verification',r=>r.claimChecks[0].sourceSupportsPhase=false],
 ['false ownership','verification',r=>r.assignmentWitnesses[0].quote='Someone else will do this.']
])test(label+' retains the originals, without retrying a veto',async()=>{
 const f=fixture(),r=await run(f,(p,v)=>{if(p===part)mutate(v);});assert.equal(r.audit.applied,false);
 assert.deepEqual(r.actions,f.actions);assert.equal(r.audit.receipts.length,0);assert.equal(r.audit.calls,part==='proposal'?1:2);
});
for(const [label,change] of [
 ['reviewer edit',f=>f.actions[0].reviewerAuthored=true],['kept metadata',f=>f.actions[0].note='keep'],
 ['different owner',f=>f.actions[1].owners=['Casey Green']],['different target',f=>f.actions[1].timing.wording='hoping done for Friday'],
 ['conflicting rejected history',f=>f.actions[1].timingDecision.rejectedExactDates=['2026-06-19']],
 ['exact date',f=>f.actions[1].timing.exactDate='2026-06-16'],['missing source',f=>f.units.pop()],
 ['removed source',f=>f.units[0].classification='remove'],['duplicate identity',f=>f.actions[1].id='a'],
 ['ambiguous source identity',f=>f.units.push({...f.units[0]})]
])test(label+' is outside the bounded class',()=>{const f=fixture();change(f);assert.equal(F.prepare(f.actions,f.units,'2026-06-15'),null);});
test('kept legacy and occurrence identities protect the work',()=>{const f=fixture();f.actions[0].occurrenceId='occ-a';
 for(const id of ['a','occ-a'])assert.equal(F.prepare(f.actions,f.units,'2026-06-15',[id]),null);
});
test('stale source/date/output and forged warnings invalidate collective coverage and restoration',async()=>{
 const f=fixture(),r=await run(f),receipt=r.audit.receipts[0];
 for(const mutate of [v=>v[0].action+=' Extra work.',v=>v[0].reviewFlagIds=[],v=>v[0].timingDecision.status='verified',v=>v[1].evidenceIds=[]]){
  const changed=structuredClone(r.actions);mutate(changed);assert.equal(F.valid(receipt,changed,f.units,'2026-06-15'),false);assert.equal(F.restore(changed,r.audit,f.units,'2026-06-15'),null);
 }
 assert.equal(F.valid(receipt,r.actions,f.units,'2026-06-16'),false);
 const units=structuredClone(f.units);units[2].text+=' Different.';assert.equal(F.valid(receipt,r.actions,units,'2026-06-15'),false);
 const allocated=r.actions.map(a=>({...a,id:'allocated-'+a.id,occurrenceId:'occ-'+a.id}));
 const rebound=F.rebind(r.audit,r.actions,allocated,f.units,'2026-06-15');assert.ok(rebound);
 for(const original of f.actions)assert.equal(F.covers(rebound.receipts[0],original,allocated,f.units,'2026-06-15'),true);
});
test('provider outage preserves both original instructions and complete warning history',async()=>{
 const f=fixture(),r=await F.correct(f.actions,f.units,{meetingDate:'2026-06-15',ask:async()=>{throw Error('provider unavailable');}});
 assert.equal(r.audit.applied,false);assert.equal(r.audit.calls,1);assert.deepEqual(r.actions,f.actions);assert.deepEqual(r.audit.receipts,[]);
});
test('three competing instructions are ambiguous and remain unchanged',()=>{const f=fixture();
 f.actions.push({...structuredClone(f.actions[1]),id:'c'});assert.equal(F.prepare(f.actions,f.units,'2026-06-15'),null);
});
test('initial review precedes later additions in either input order',async()=>{for(const reversed of [false,true]){
 const f=fixture();if(reversed)f.actions.reverse();const r=await run(f);assert.match(r.actions[0].action,/^Tidy and share/);assert.match(r.actions[1].action,/^Add/);
}});
