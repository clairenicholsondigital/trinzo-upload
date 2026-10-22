'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {captureSemanticPolicy}=require('../utils/meetingMinutesSemanticPolicy');
const {reconcileGeneratedSemanticStage,semanticAccountingError,semanticReconciliationPrompt}=require('../utils/meetingMinutesSemanticStage');
const {materializeSemanticDecisions}=require('../utils/meetingMinutesSemanticProofTransport');
const actions=require('../utils/canonicalMinutes/actionSemanticReconciliation');
const policy=mode=>captureSemanticPolicy({MEETING_MINUTES_AGENT_SEMANTIC_RECONCILIATION_V1:mode});
const sourceUnits=[{id:'T1',speaker:'Maya',text:'I will send the report to Alex.'}];
const row=(id,action='Send the report to Alex.')=>({id,action,owners:['Maya'],evidenceIds:['T1'],reviewFlagIds:[],timing:{kind:'not_stated',wording:'',exactDate:''}});
const result=items=>({changes:{actions:items},reviewFlags:[]});

test('off and legacy work return the exact result without external calls or metadata changes',async()=>{
 const input=result([row('a'),row('b')]);
 const ask=()=>{throw new Error('must not call');};
 assert.equal(await reconcileGeneratedSemanticStage(input,{},'actions',{ask}),input);
 assert.equal(await reconcileGeneratedSemanticStage(input,{},'actions',{policy:policy('off'),ask}),input);
});

test('shadow records a lossless proposal while preserving actual content and other-stage date context',async()=>{
 const original=[row('a'),row('b')],input=result(original);
 const draft={sourceUnits,qualityState:{preparation:{dateContext:{meetingDate:'2026-08-05'}},discussion:{reviewed:true}}};
 const output=await reconcileGeneratedSemanticStage(input,draft,'actions',{policy:policy('shadow')});
 assert.deepEqual(output.changes.actions,original);
 assert.equal(output.changes.qualityState.actions.semanticReconciliation.stats.merged,1);
 assert.equal(output.changes.qualityState.actions.semanticReconciliation.applied,false);
 assert.deepEqual(output.changes.qualityState.preparation,draft.qualityState.preparation);
 assert.deepEqual(output.changes.qualityState.discussion,draft.qualityState.discussion);
 assert.deepEqual(input,result(original));
});

test('on applies a proved existing survivor and exact receipts prevent survival restoration',async()=>{
 const api=require('../routes/api').stagedEvaluation;
 const original=[row('a'),row('b')];
 const output=await reconcileGeneratedSemanticStage(result(original),{sourceUnits},'actions',{
  policy:policy('on'),verifySurvival:api.reconcileFinalApprovedActions});
 const q=output.changes.qualityState.actions.semanticReconciliation;
 assert.equal(q.stats.merged,1);assert.equal(output.changes.actions.length,1);
 const checked=api.reconcileFinalApprovedActions(output.changes.actions,original,{receipts:q.receipts,sourceUnits});
 assert.equal(checked.restored.length,0);
 assert.ok(q.receipts.every(receipt=>actions.validateReconciliationReceipt(receipt,receipt.original,output.changes.actions[0],sourceUnits)));
});

function semanticFixture(){
 const records=[row('a','Send the report to Alex.'),row('b','Provide Alex with the report.')];
 const packet=actions.prepareActionReconciliation({actions:records,sourceUnits});
 const candidate=packet.candidates[0],byRef=new Map(packet.rows.map(item=>[item.ref,item]));
 const survivor=byRef.get(candidate.leftRef);
 const response={version:packet.version,packetHash:packet.packetHash,inputHash:packet.inputHash,sourceHash:packet.sourceHash,
  decisions:[{candidateId:candidate.candidateId,relation:'equivalent',survivorRef:survivor.ref,
   coverage:[candidate.leftRef,candidate.rightRef].map(ref=>({originalRef:ref,survivorRef:survivor.ref,sourceIds:['T1'],
    clauseMap:[{originalClauseIndex:0,survivorClauseIndex:0,sourceIds:['T1']}]}))}]};
 return {records,packet,candidate,survivor,response};
}

test('compact provider choices materialize exact existing text, facets and whole source spans',()=>{
 const {packet,response,survivor}=semanticFixture();
 const expanded=materializeSemanticDecisions(packet,response,'actions');
 assert.equal(semanticAccountingError(packet,packet.candidates,response),null);
 const output=actions.applyActionReconciliation(packet,expanded,{sourceUnits});
 assert.equal(output.actions.length,1);assert.equal(output.actions[0].action,survivor.action.action);
 assert.equal(expanded.decisions[0].coverage[0].sourceSpans[0].quote,sourceUnits[0].text);
 assert.ok(output.receipts.length);
});

test('structural validation requests correction for incomplete source/clause maps before adjudication',()=>{
 const {packet,response}=semanticFixture();
 const {semanticPrimaryStructureError}=require('../utils/meetingMinutesSemanticStage');
 assert.equal(semanticPrimaryStructureError(packet,packet.candidates,response),null);
 const missing=structuredClone(response);delete missing.decisions[0].coverage[0].clauseMap;
 const error=semanticPrimaryStructureError(packet,packet.candidates,missing);
 assert.equal(error.code,'invalid_semantic_reconciliation_structure');
 assert.equal(error.retryable,true);
 const duplicates=structuredClone(response);duplicates.decisions.push({...duplicates.decisions[0]});
 assert.equal(semanticPrimaryStructureError(packet,packet.candidates,duplicates).code,'invalid_semantic_reconciliation_accounting');
});

test('compact expansion never infers missing original coverage, clauses, unknown sources or missing decisions',()=>{
 const {packet,response}=semanticFixture();
 for(const mutate of [
  value=>value.decisions[0].coverage.pop(),
  value=>value.decisions[0].coverage[0].clauseMap.pop(),
  value=>value.decisions[0].coverage[0].clauseMap[0].sourceIds=['unknown'],
  value=>value.decisions[0].coverage[0].sourceIds=['unknown'],
  value=>value.decisions[0].coverage[0].clauseMap[0].survivorClauseIndex=99,
  value=>value.decisions.push({...value.decisions[0]})
 ]){
  const bad=structuredClone(response);mutate(bad);
  const expanded=materializeSemanticDecisions(packet,bad,'actions');
  assert.equal(actions.applyActionReconciliation(packet,expanded,{sourceUnits}).actions.length,2);
 }
});

test('provider failure preserves the full incoming register and every independent date/quality record',async()=>{
 const {records}=semanticFixture();
 const draft={sourceUnits,qualityState:{preparation:{dateContext:{confirmedByReviewer:true}}}};
 const output=await reconcileGeneratedSemanticStage(result(records),draft,'actions',{policy:policy('on'),
  ask:async()=>{throw Object.assign(new Error('unavailable'),{code:'provider_test_failure'});}});
 assert.deepEqual(output.changes.actions,records);
 assert.equal(output.changes.qualityState.actions.semanticReconciliation.applied,false);
 assert.ok(output.changes.qualityState.actions.semanticReconciliation.unresolved.some(item=>item.reason==='provider_test_failure'));
 assert.deepEqual(output.changes.qualityState.preparation,draft.qualityState.preparation);
});

test('failed independent source review retains its raw response separately from the successful comparison',async()=>{
 const {records}=semanticFixture();
 const rawReview={version:'invalid-review',decisions:[]};
 const output=await reconcileGeneratedSemanticStage(result(records),{sourceUnits},'actions',{
  policy:policy('on'),ask:async(prompt,options)=>{
   let response;
   if(prompt.startsWith('ACTION_CRITIC_SEMANTIC_SOURCE_VERIFICATION')) response=rawReview;
   else {
    const data=JSON.parse(prompt.slice(prompt.indexOf('\nDATA\n')+6));
    const survivor=data.rows.find(item=>item.action.action.startsWith('Send'));
    response={version:data.version,packetHash:data.packetHash,sourceHash:data.sourceHash,inputHash:data.inputHash,
     decisions:data.candidates.map(candidate=>({candidateId:candidate.candidateId,relation:'equivalent',survivorRef:survivor.ref,
      coverage:[candidate.leftRef,candidate.rightRef].map(originalRef=>({originalRef,survivorRef:survivor.ref,
       sourceIds:['T1'],clauseMap:[{originalClauseIndex:0,survivorClauseIndex:0,sourceIds:['T1']}]}))}))};
   }
   options.onResult(response,{attempt:1});
   const error=options.validateResult(response);
   if(error) throw Object.assign(error,{callTimings:[{pass:options.pass,ok:false,elapsedMs:1}]});
   return {result:response,timings:[{pass:options.pass,ok:true,elapsedMs:1}]};
  }});
 const q=output.changes.qualityState.actions.semanticReconciliation;
 assert.deepEqual(output.changes.actions,records);
 assert.equal(q.applied,false);assert.equal(q.calls.length,2);
 assert.equal(q.calls[0].failed,undefined);
 assert.equal(q.calls[1].failed,true);
 assert.deepEqual(q.calls[1].responses,[{attempt:1,result:rawReview}]);
 assert.equal(q.calls[1].timings[0].pass,'actions:semantic-source-verification-1');
 assert.equal(q.cache.length,0);
});

test('mechanically blocked candidates are never reported as provider-assessed',async()=>{
 const rows=[row('a','Review the report to Alex.'),row('b','Send the report to Alex.')];
 let calls=0;
 const output=await reconcileGeneratedSemanticStage(result(rows),{sourceUnits},'actions',{
  policy:policy('on'),ask:async()=>{calls++;throw Error('must not call for contradictory duties');}});
 const q=output.changes.qualityState.actions.semanticReconciliation;
 assert.equal(calls,0);assert.deepEqual(output.changes.actions,rows);
 assert.equal(q.stats.candidateCount,1);assert.equal(q.stats.assessed,0);
 assert.deepEqual(q.assessment,{nominatedCandidates:1,deterministicAssessed:0,providerAttempted:0,
  providerAssessed:0,mechanicallyBlocked:1,notAssessed:1});
});

test('source references cannot cite real transcript units omitted from the supplied request context',()=>{
 const {semanticSuppliedSourceError}=require('../utils/meetingMinutesSemanticStage');
 const allowed=[{id:'visible',text:'The supplied passage.'}];
 assert.equal(semanticSuppliedSourceError({decisions:[{checks:[{sourceIds:['visible']}]}]},allowed),null);
 for(const response of [
  {decisions:[{checks:[{sourceIds:['real-but-not-supplied']}]}]},
  {decisions:[{coverage:[{sourceSpans:[{unitId:'real-but-not-supplied',quote:'A real omitted passage.'}]}]}]}
 ]) assert.equal(semanticSuppliedSourceError(response,allowed).code,'semantic_source_not_supplied');
});

test('prompt uses a stable existing Microsoft route and presents sources solely as immutable evidence',()=>{
 const {packet}=semanticFixture();
 const prompt=semanticReconciliationPrompt(packet,packet.candidates,'actions',policy('shadow'),{meetingDate:'2026-08-05'});
 assert.equal(prompt.split('\n')[0],'ACTION_CRITIC_SEMANTIC_RECONCILIATION');
 const data=JSON.parse(prompt.slice(prompt.indexOf('\nDATA\n')+6));
 assert.equal(data.packetHash,packet.packetHash);
 assert.ok(data.candidates[0].eligibleSurvivorRefs.length);
 assert.ok(data.rows.every(item=>packet.rows.some(original=>original.ref===item.ref)));
});
