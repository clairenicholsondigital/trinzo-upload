'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');
const R = require('../utils/canonicalMinutes/actionSemanticReconciliation');
const P = require('../utils/meetingMinutesSemanticPolicy');
const S = require('../utils/meetingMinutesSemanticStage');
const api = require('../routes/api').stagedEvaluation;
const row = (id, action, extra = {}) => ({id, action, owners:['Morgan Lee'],
  timing:{kind:'not_stated',wording:'',exactDate:''},evidenceIds:['T0001'],reviewFlagIds:[],...extra});
const actions = () => [row('a','Sign the supplier process and supplier programme guidance training documents required for this review.'),
  row('b','Sign the supplier process documents and supplier programme guidance training documents for this review.')];
const sources = V.normaliseSourceUnits([{id:'T0001',speaker:'Morgan Lee',text:'I will sign the supplier process documents and supplier programme guidance training documents for this review.'}]);
const policy = () => P.captureSemanticPolicy({MEETING_MINUTES_AGENT_BOUNDED_SURVIVOR_DEDUPE_V1:'1',MEETING_MINUTES_AGENT_CONTACT_ENQUIRY_DEDUPE_V1:'1'});

test('bounded policy is frozen, action-only, opt-in, fingerprint-distinct and unknown scopes fail closed',async()=>{
  const p=policy();assert.equal(p.scope,'contact_and_existing_survivors');assert.equal(p.maxCandidates,2);
  assert.equal(P.captureSemanticPolicy({}).mode,'off');assert.equal(P.semanticPolicyForRun({}).mode,'off');
  assert.deepEqual(P.normaliseSemanticPolicy(p),p);assert.ok(Object.isFrozen(p));
  assert.notDeepEqual(p,P.captureSemanticPolicy({MEETING_MINUTES_AGENT_CONTACT_ENQUIRY_DEDUPE_V1:'1'}));
  assert.equal(P.normaliseSemanticPolicy({...p,scope:'typo'}).mode,'off');
  assert.equal(P.captureSemanticPolicy({MEETING_MINUTES_AGENT_BOUNDED_SURVIVOR_DEDUPE_V1:'1'}).scope,'bounded_existing_survivors');
  const input={changes:{discussion:[{topic:'Keep',points:[]}]}};
  assert.equal(await S.reconcileGeneratedSemanticStage(input,{},'discussion',{policy:p,ask:()=>{throw Error('unexpected');}}),input);
  assert.equal(R.prepareActionReconciliation({actions:actions(),sourceUnits:sources,scope:'typo'}).candidates.length,0);
});
test('reordered same-operation objects are nominated without authorizing a deterministic merge',()=>{
  const packet=R.prepareActionReconciliation({actions:actions(),sourceUnits:sources,scope:policy().scope});
  assert.equal(packet.candidates.length,1);
  assert.equal(R.buildDeterministicEnvelope(packet).decisions[0].relation,'unresolved');
  assert.equal(R.prepareActionReconciliation({actions:actions(),sourceUnits:sources,scope:'contact_enquiries'}).candidates.length,0);
});
for(const [label,mutate] of [
  ['different owners',r=>r[1].owners=['Robin West']],['missing owner',r=>r[1].owners=[]],
  ['warning',r=>r[1].reviewFlagIds=['unresolved']],['reviewer row',r=>r[1].reviewerAuthored=true],
  ['unknown metadata',r=>r[1].unknownState=true],['reviewer note',r=>r[1].notes='Keep both'],
  ['structured date',r=>r[1].timing={kind:'target',wording:'Monday',exactDate:'2026-10-26'}],
  ['hidden timing',r=>r[1].timing.wording='next week'],['inline timing',r=>r[1].action+=' tomorrow'],
  ['condition',r=>r[1].action+=' after approval'],['modality',r=>r[1].action='Maybe '+r[1].action],
  ['additional work',r=>r[1].action+=' and send the final documents'],
  ['different object',r=>r[1].action='Sign the purchase agreement.'],
  ['no shared source',r=>r[1].evidenceIds=['T0002']],
  ['unresolved timing history',r=>r[1].timingDecision={status:'unresolved',rejectedExactDates:['2026-10-26']}]
])test('bounded nomination protects '+label,()=>{
  const rows=actions();mutate(rows);
  assert.equal(R.prepareActionReconciliation({actions:rows,sourceUnits:sources,scope:policy().scope}).candidates.length,0);
});
test('contact candidates keep priority within the unchanged two-pair budget',()=>{
  const rows=[...actions(),row('e1','Check with Alex regarding supplier documentation.'),row('e2','Speak to Alex to check on supplier documentation and certification requirements.')];
  const packet=R.prepareActionReconciliation({actions:rows,sourceUnits:sources,scope:policy().scope,maxCandidates:1});
  assert.equal(packet.candidates.length,1);
  const ids=[packet.candidates[0].leftRef,packet.candidates[0].rightRef].map(ref=>packet.rows.find(r=>r.ref===ref).action.id).sort();
  assert.deepEqual(ids,['e1','e2']);assert.ok(packet.unresolved.length);
});
function answer(prompt,negative=false) {
  const data=JSON.parse(prompt.slice(prompt.indexOf('\nDATA\n')+6)),verify=prompt.startsWith('ACTION_CRITIC_SEMANTIC_SOURCE_VERIFICATION');
  return {version:data.version,packetHash:data.packetHash,inputHash:data.inputHash,sourceHash:data.sourceHash,...(verify?{sourceStatusMethod:data.sourceStatusMethod,selfRetentionMethod:data.selfRetentionMethod}:{}),decisions:data.candidates.map(c=>{
    const survivor=verify?c.survivorRef:data.rows.find(r=>r.action.action.includes('process documents')).ref;
    return verify?{candidateId:c.candidateId,survivorRef:survivor,relation:negative?'unresolved':'equivalent',checks:c.requiredChecks.map(check=>({...check,supported:!negative,sourceStatus:negative?'uncertain':'outstanding',...(check.originalRef===survivor?{}:{retained:!negative}),sourceIds:['T0001']}))}
      :{candidateId:c.candidateId,survivorRef:survivor,relation:'equivalent',coverage:[c.leftRef,c.rightRef].map(ref=>({originalRef:ref,survivorRef:survivor,sourceIds:['T0001'],clauseMap:[{originalClauseIndex:0,survivorClauseIndex:0,sourceIds:['T0001']}]}))};
  })};
}
for(const negative of [false,true])test('source verifier '+(negative?'vetoes':'authorizes')+' bounded survivors through admission/save/restore',async()=>{
  const rows=actions();let calls=0;
  const out=await api.finishMeetingAgentGeneratedStage({changes:{actions:rows},reviewFlags:[]},{sourceUnits:sources,_semanticPolicy:policy()},'actions',{
    semanticAsk:async(prompt,opts)=>{calls++;const result=answer(prompt,negative);const error=opts.validateResult(result);if(error)throw error;return {result,timings:[]};}
  });
  assert.equal(calls,2);assert.equal(out.changes.actions.length,negative?2:1);
  const q=out.changes.qualityState.actions.semanticReconciliation;
  assert.ok(q.calls.every(call=>!call.failed),'Must exercise a valid semantic verdict rather than a contract failure');
  assert.equal(q.receipts.length,negative?0:1);
  if(!negative){
    assert.equal(out.changes.actions[0].action,rows[1].action);
    const admitted=api.admitMeetingAgentGeneratedActionChanges({sourceUnits:sources},out.changes,'bounded-test');
    const saved=JSON.parse(JSON.stringify({sourceUnits:sources,...admitted}));
    const audit=saved.qualityState.actions.semanticReconciliation;
    assert.equal(api.reconcileFinalApprovedActions(saved.actions,rows,{receipts:audit.receipts,sourceUnits:sources}).restored.length,0);
    assert.deepEqual(require('../utils/meetingMinutesEnquiryRecovery').originalEnquiryActions(saved),rows);
    assert.equal(require('../utils/meetingMinutesEnquiryRecovery').originalEnquiryActions({...saved,keptActionIds:[saved.actions[0].id]}),null);
    saved.actions[0].action+=' Reviewer edit.';
    assert.equal(require('../utils/meetingMinutesEnquiryRecovery').originalEnquiryActions(saved),null);
  }else assert.deepEqual(out.changes.actions,rows);
});

test('bounded source selection keeps the complete nearby owner exchange instead of crowding it out by keyword rank',()=>{
  const units=Array.from({length:50},(_,i)=>({id:'T'+String(i+1).padStart(4,'0'),speaker:'Chair',text:'Supplier guidance documents and process context '+i}));
  units[7]={...units[7],speaker:'Morgan Lee',text:'I understand those documents need my signature.'};
  const packet=R.prepareActionReconciliation({actions:actions(),sourceUnits:units,scope:policy().scope});
  const context=S.promptContext(packet,packet.candidates);
  assert.equal(context.contextFailure,undefined);assert.ok(context.sourceUnits.length<=32);
  assert.ok(units.slice(0,8).every(unit=>context.sourceUnits.some(source=>source.id===unit.id)));
  assert.equal(context.sourceUnits.find(unit=>unit.id==='T0008').text,units[7].text);
});
test('combined policy preserves the exact contact-only source packet for contact candidates',()=>{
  const rows=[row('e1','Check with Alex regarding supplier documentation.'),row('e2','Speak to Alex to check on supplier documentation and certification requirements.')];
  const units=Array.from({length:30},(_,i)=>({id:'T'+String(i+1).padStart(4,'0'),speaker:'Chair',text:'Supplier documentation context '+i}));
  rows.forEach(r=>r.evidenceIds=['T0014','T0015']);
  const old=R.prepareActionReconciliation({actions:rows,sourceUnits:units,scope:'contact_enquiries'});
  const next=R.prepareActionReconciliation({actions:rows,sourceUnits:units,scope:policy().scope});
  assert.deepEqual(S.promptContext(next,next.candidates),S.promptContext(old,old.candidates));
  assert.equal(S.promptContext(next,next.candidates).sourceUnits.length,8);
});
for(const [label,change]of[
 ['owner witness too far',units=>{units[0].speaker='Chair';units[20].speaker='Morgan Lee';}],
 ['ambiguous source identity',units=>units.push({...units[0]})],
 ['mandatory context too large',units=>{units[0].text='x'.repeat(48001);}]
])test('unusable bounded source context preserves originals without provider calls: '+label,async()=>{
 const units=Array.from({length:40},(_,i)=>({id:'T'+String(i+1).padStart(4,'0'),speaker:i===0?'Morgan Lee':'Chair',text:'Supplier guidance documents and process context '+i}));
 change(units);const rows=actions();let calls=0;
 const out=await S.reconcileGeneratedSemanticStage({changes:{actions:rows}},{sourceUnits:units},'actions',{policy:policy(),ask:async()=>{calls++;throw Error('unexpected');}});
 assert.equal(calls,0);assert.deepEqual(out.changes.actions,rows);assert.equal(out.changes.qualityState.actions.semanticReconciliation.applied,false);
});
test('a positive independent verdict lacking its required owner witness fails once without weakening final grounding',async()=>{
 const units=[{id:'T0001',speaker:'Chair',text:'Sign the supplier process and supplier programme guidance training documents.'},
 {id:'T0002',speaker:'Morgan Lee',text:'I will sign those documents.'}];
 let calls=0;
 const out=await S.reconcileGeneratedSemanticStage({changes:{actions:actions()}},{sourceUnits:units},'actions',{policy:policy(),ask:async(prompt,opts)=>{
  calls++;if(prompt.startsWith('ACTION_CRITIC_SEMANTIC_SOURCE_VERIFICATION'))assert.equal(opts.maxAttempts,1);
  const result=answer(prompt,false),error=opts.validateResult(result);
  if(error){assert.equal(error.code,'missing_source_owner_witness');throw error;}return {result,timings:[]};
 }});
 assert.equal(calls,2);assert.deepEqual(out.changes.actions,actions());assert.equal(out.changes.qualityState.actions.semanticReconciliation.receipts.length,0);
});

test('malformed scopes fail closed and explicit new-scope policies cannot exceed the bounded limits',()=>{
 for(const scope of ['',0,null,true,'unknown']){
  assert.equal(P.normaliseSemanticPolicy({...policy(),scope}).mode,'off');
  assert.equal(R.prepareActionReconciliation({actions:actions(),sourceUnits:sources,scope}).candidates.length,0);
 }
 const p=P.normaliseSemanticPolicy({...policy(),maxCandidates:128,budgetMs:180000,attemptTimeoutMs:90000});
 assert.equal(p.maxCandidates,2);assert.equal(p.budgetMs,90000);assert.equal(p.attemptTimeoutMs,60000);
});

test('repeating the same operation twice is still a compound instruction and stays outside the new class',()=>{
 const rows=actions();rows.forEach(row=>{row.action+=' and sign the separate certification.';});
 assert.equal(R.prepareActionReconciliation({actions:rows,sourceUnits:sources,scope:policy().scope}).candidates.length,0);
});
