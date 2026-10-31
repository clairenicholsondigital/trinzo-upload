'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../utils/canonicalMinutes/discussionClaimConsolidation');
const B=require('../utils/canonicalMinutes/discussionBoundedRewrite');
const P=require('../utils/canonicalMinutes/discussionPointDecisionCoverage');
const MinutesResultNormalization = require('../utils/meetingMinutesResultNormalization');
function fixture(){
 const row=(id,text)=>({id,text,evidenceIds:['T0001'],reviewFlagIds:[],supportingDetails:[]});
 const sources=[{id:'T0001',speaker:'Chair',text:'The committee approved the onboarding policy for suppliers.'}];
 const discussion=MinutesResultNormalization.normaliseAgentResult({discussion:[{id:'topic',topic:'Onboarding',points:[row('point','Supplier policy was approved.')],decisions:[row('decision',sources[0].text)],openQuestions:[]}]},sources,'discussion',{enforceEvidence:false}).discussion;
 return {discussion,sources};
}
function options(veto=false){return {encode:async values=>values.map(()=>[1,0]),
 assess:async(_prompt,p)=>({version:C.VERSION,packetHash:p.packetHash,results:p.candidates.map(c=>({id:c.id,relation:'covered',survivorId:'decision'}))}),
 verify:async(_prompt,p,selected)=>({version:C.VERSION,packetHash:p.packetHash,results:selected.map(c=>({id:c.id,survivorId:'decision',checks:c.rows.flatMap(r=>r.clauses.map((_,clauseIndex)=>({recordId:r.record.id,clauseIndex,supported:!veto,retained:!veto,sourceIds:['T0001']})))}))})};}
test('the separate pass reaches a normalized point/decision pair excluded by the point-only writer',async()=>{
 const f=fixture(),before=structuredClone(f.discussion);assert.equal(f.discussion[0].points.length,1);
 assert.equal((await B.prepare(f.discussion,f.sources,options())).candidates.length,0);
 const r=await P.consolidate(f.discussion,f.sources,options());
 assert.equal(r.audit.applied,true);assert.equal(r.audit.method,P.VERSION);assert.equal(r.discussion[0].points.length,0);
 assert.equal(r.discussion[0].decisions[0].text,before[0].decisions[0].text);assert.deepEqual(C.restore(r.discussion,f.sources,r.audit),before);
});
for(const [name,mutate]of[
 ['genuine decision warning',f=>f.discussion[0].decisions[0].reviewFlagIds=['timing-warning']],
 ['reviewer point',f=>f.discussion[0].points[0].reviewerAuthored=true],
 ['unique supporting child',f=>f.discussion[0].points[0].supportingDetails=[{id:'unique',text:'Keep the implementation rationale.',evidenceIds:['T0001']}]],
 ['unanswered question',f=>{f.discussion[0].openQuestions=f.discussion[0].points;f.discussion[0].points=[];}],
 ['proposal rather than approval',f=>f.discussion[0].points[0].text='The supplier policy was only proposed.'],
 ['condition difference',f=>f.discussion[0].points[0].text+=' Subject to funding.']
])test('point/decision boundaries preserve '+name,async()=>{
 const f=fixture();mutate(f);let calls=0;
 const r=await P.consolidate(f.discussion,f.sources,{...options(),assess:async()=>{calls++;throw Error('unexpected');}});
 assert.equal(calls,0);assert.equal(r.audit.applied,false);assert.deepEqual(r.discussion,f.discussion);
});
test('independent rejection preserves rationale even when a proposer selects the decision',async()=>{
 const f=fixture();f.discussion[0].points[0].text+=' The supplier warranty remains unresolved.';
 const r=await P.consolidate(f.discussion,f.sources,options(true));assert.equal(r.audit.applied,false);assert.deepEqual(r.discussion,f.discussion);
});
test('cross-role filtering precedes the one-pair budget, rather than being crowded out by same-kind pairs',async()=>{
 const f=fixture();f.discussion[0].points.push({...f.discussion[0].points[0],id:'another-point'});
 const packet=await C.prepare(f.discussion,f.sources,{...options(),pointDecisionOnly:true,maxCandidates:1});
 assert.equal(packet.candidates.length,1);assert.deepEqual(packet.candidates[0].rows.map(r=>r.kind),['points','decisions']);
 assert.deepEqual(packet.candidates[0].allowedSurvivors,['decision']);
});
test('a different selected survivor, source edit or reviewer edit invalidates recovery instead of replacing user content',async()=>{
 const f=fixture(),r=await P.consolidate(f.discussion,f.sources,options());
 const changed=structuredClone(r.discussion);changed[0].decisions[0].text+=' Reviewer qualification.';
 assert.equal(C.canRestore(changed,f.sources,r.audit),false);
 assert.equal(C.canRestore(r.discussion,[{...f.sources[0],text:'Changed source.'}],r.audit),false);
 const altered=options(),base=altered.assess;altered.assess=async(...args)=>{const reply=await base(...args);reply.results[0].survivorId='point';return reply;};
 assert.deepEqual((await P.consolidate(f.discussion,f.sources,altered)).discussion,f.discussion);
});
