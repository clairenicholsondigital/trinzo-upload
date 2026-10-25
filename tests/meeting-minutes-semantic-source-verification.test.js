'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const action=require('../utils/canonicalMinutes/actionSemanticReconciliation');
const {materializeSemanticDecisions}=require('../utils/meetingMinutesSemanticProofTransport');
const verify=require('../utils/meetingMinutesSemanticSourceVerification');
function fixture(repeatedClauses=false){
 const sourceUnits=[{id:'T1',speaker:'Coordinator',text:'Maya will ensure Sam gets the archive metadata.'},
  {id:'T2',speaker:'Maya',text:"I'll handle that."}];
 const rows=['Send the archive metadata to Sam.','Provide Sam with the archive metadata.']
  .map(text=>repeatedClauses?`${text}; ${text}`:text)
  .map((text,index)=>({id:'a'+index,action:text,owners:['Maya'],evidenceIds:['T1','T2'],reviewFlagIds:[],timing:{kind:'not_stated',wording:'',exactDate:''}}));
 const packet=action.prepareActionReconciliation({actions:rows,sourceUnits});
 const candidate=packet.candidates[0],survivor=packet.rows.find(row=>row.ref===candidate.leftRef);
 const primary={version:packet.version,packetHash:packet.packetHash,sourceHash:packet.sourceHash,inputHash:packet.inputHash,
  decisions:[{candidateId:candidate.candidateId,relation:'equivalent',survivorRef:survivor.ref,
   coverage:[candidate.leftRef,candidate.rightRef].map(ref=>({originalRef:ref,survivorRef:survivor.ref,sourceIds:['T1','T2'],
    clauseMap:packet.rows.find(row=>row.ref===ref).clauses.map((_clause,index)=>({originalClauseIndex:index,survivorClauseIndex:index,sourceIds:['T1','T2']}))}))}]};
 const expanded=materializeSemanticDecisions(packet,primary,'actions');
 const review={version:verify.VERSION,packetHash:packet.packetHash,sourceHash:packet.sourceHash,inputHash:packet.inputHash,
  decisions:[{candidateId:candidate.candidateId,survivorRef:survivor.ref,relation:'equivalent',
   checks:[candidate.leftRef,candidate.rightRef].flatMap(ref=>packet.rows.find(row=>row.ref===ref).clauses
    .map((_clause,clauseIndex)=>({originalRef:ref,clauseIndex,supported:true,retained:true,sourceIds:['T1','T2']})))}]};
 return {sourceUnits,rows,packet,candidate,survivor,primary,expanded,review};
}

test('a source paraphrase needs a separate complete source review before the literal-verb fallback permits it',()=>{
 const {packet,expanded,review,sourceUnits}=fixture();
 assert.equal(action.applyActionReconciliation(packet,expanded,{sourceUnits}).actions.length,2);
 assert.equal(verify.verificationError(packet,packet.candidates,review),'');
 const bound=verify.bindSourceVerification(packet,expanded,review);
 assert.equal(bound.error,'');
 const result=action.applyActionReconciliation(packet,bound.envelope,{sourceUnits});
 assert.equal(result.actions.length,1);
 assert.ok(result.receipts.every(receipt=>action.validateReconciliationReceipt(receipt,receipt.original,result.actions[0],sourceUnits)));
});

test('repeated identical clauses bind each independently checked original occurrence once',()=>{
 const {packet,expanded,review,sourceUnits}=fixture(true);
 assert.ok(packet.rows.every(row=>row.clauses.length===2));
 assert.equal(action.applyActionReconciliation(packet,expanded,{sourceUnits}).actions.length,2);
 const bound=verify.bindSourceVerification(packet,expanded,review);
 assert.equal(bound.error,'');
 for(const proof of bound.envelope.decisions[0].coverage){
  assert.deepEqual(proof.semanticProof.clauses.map(mapping=>mapping.sourceOperationReview.clauseIndex),[0,1]);
 }
 const result=action.applyActionReconciliation(packet,bound.envelope,{sourceUnits});
 assert.equal(result.actions.length,1);
 assert.ok(result.receipts.every(receipt=>action.validateReconciliationReceipt(receipt,receipt.original,result.actions[0],sourceUnits)));
 const missing=structuredClone(review);missing.decisions[0].checks.pop();
 assert.equal(verify.bindSourceVerification(packet,expanded,missing).envelope,null);
});

test('unknown, missing, duplicated and stale source-review accounting cannot authorize a merge',()=>{
 const {packet,expanded,review,sourceUnits}=fixture();
 for(const mutate of [
  value=>value.decisions[0].checks.pop(),
  value=>value.decisions[0].checks.push({...value.decisions[0].checks[0]}),
  value=>value.decisions[0].checks[0].originalRef='unknown',
  value=>value.decisions[0].checks[0].sourceIds=['unknown'],
  value=>value.decisions[0].checks[0].clauseIndex=99,
  value=>value.decisions[0].checks[0].supported=false,
  value=>value.sourceHash='stale',
  value=>value.decisions=[]
 ]){
  const bad=structuredClone(review);mutate(bad);
  assert.ok(verify.verificationError(packet,packet.candidates,bad));
  assert.equal(verify.bindSourceVerification(packet,expanded,bad).envelope,null);
  assert.equal(action.applyActionReconciliation(packet,expanded,{sourceUnits}).actions.length,2);
 }
});

test('independent review lists every exact required clause check including the elected survivor',()=>{
 const {packet,candidate,survivor}=fixture();
 const prompt=verify.verificationPrompt(packet,[{...candidate,survivorRef:survivor.ref}],packet.rows,packet.sourceUnits,{});
 const data=JSON.parse(prompt.slice(prompt.indexOf('\nDATA\n')+6));
 assert.deepEqual(data.candidates[0].requiredChecks,[candidate.leftRef,candidate.rightRef]
  .flatMap(ref=>packet.rows.find(row=>row.ref===ref).clauses.map((_clause,clauseIndex)=>({originalRef:ref,clauseIndex}))));
 assert.ok(data.candidates[0].requiredChecks.some(check=>check.originalRef===survivor.ref));
 assert.ok(data.candidates[0].requiredChecks.every(check=>!Object.hasOwn(check,'supported')&&!Object.hasOwn(check,'retained')));
 assert.match(prompt,/speaker exactly matches that full name or whose text contains that full name/);
 assert.match(prompt,/first-name-only mention in another speaker/);
});

test('source review clause indices must be exact integers rather than coercible labels',()=>{
 const {packet,expanded,review}=fixture();
 for(const index of ['0',0.5,null,undefined,-1,Infinity]){
  const bad=structuredClone(review);bad.decisions[0].checks[0].clauseIndex=index;
  assert.equal(verify.verificationError(packet,packet.candidates,bad),'invalid_source_clause_result');
  assert.equal(verify.bindSourceVerification(packet,expanded,bad).envelope,null);
 }
 assert.equal(verify.verificationError(packet,packet.candidates,review),'');
});

test('a bound source certificate rejects a changed packet input while receipt revalidation remains supported',()=>{
 const {packet,expanded,review}=fixture();
 const bound=verify.bindSourceVerification(packet,expanded,review).envelope;
 const proof=bound.decisions[0].coverage[0],mapping=proof.semanticProof.clauses[0];
 const original=packet.rows.find(row=>row.ref===proof.originalRef);
 const survivor=packet.rows.find(row=>row.ref===proof.survivorRef);
 assert.equal(verify.sourceOperationReviewValid(mapping.sourceOperationReview,packet,original,survivor,mapping,0),true);
 assert.equal(verify.sourceOperationReviewValid(mapping.sourceOperationReview,{...packet,inputHash:'changed-register'},original,survivor,mapping,0),false);
 assert.equal(verify.sourceOperationReviewValid(mapping.sourceOperationReview,{sourceUnits:packet.sourceUnits},original,survivor,mapping,0),true);
});

test('source support alone cannot approve a survivor that loses an original claim',()=>{
 const {packet,expanded,review,sourceUnits}=fixture();
 review.decisions[0].relation='unresolved';review.decisions[0].checks[0].retained=false;
 assert.equal(review.decisions[0].checks[0].supported,true);
 const bound=verify.bindSourceVerification(packet,expanded,review);
 assert.equal(bound.error,'');
 assert.equal(action.applyActionReconciliation(packet,bound.envelope,{sourceUnits}).actions.length,2);
 review.decisions[0].relation='equivalent';
 assert.equal(verify.verificationError(packet,packet.candidates,review),'contradictory_source_verdict');
});

test('independent coverage assessment is bound to the actual chosen survivor',()=>{
 const {packet,expanded,review}=fixture();
 review.decisions[0].survivorRef=packet.rows.find(row=>row.ref!==review.decisions[0].survivorRef).ref;
 assert.equal(verify.bindSourceVerification(packet,expanded,review).envelope,null);
});

test('a coherent uncertain independent verdict retains both originals',()=>{
 const {packet,expanded,review,sourceUnits}=fixture();
 review.decisions[0].relation='unresolved';review.decisions[0].checks[0].supported=false;
 const bound=verify.bindSourceVerification(packet,expanded,review);
 assert.equal(bound.error,'');
 assert.equal(action.applyActionReconciliation(packet,bound.envelope,{sourceUnits}).actions.length,2);
});

test('primary model output cannot supply its own independent source-operation certificate',()=>{
 const {packet,expanded,review,sourceUnits}=fixture();
 const bound=verify.bindSourceVerification(packet,expanded,review).envelope;
 const stripped=materializeSemanticDecisions(packet,bound,'actions');
 assert.equal(action.applyActionReconciliation(packet,stripped,{sourceUnits}).actions.length,2);
 assert.ok(bound.decisions[0].coverage[0].semanticProof.clauses[0].sourceOperationReview);
 assert.ok(!stripped.decisions[0].coverage[0].semanticProof.clauses[0].sourceOperationReview);
});

test('source reviews bind exact source, original clause and survivor instead of only a positive label',()=>{
 const {packet,expanded,review,sourceUnits}=fixture();
 const bound=verify.bindSourceVerification(packet,expanded,review).envelope;
 for(const mutate of [
  value=>value.decisions[0].coverage[0].semanticProof.clauses[0].sourceOperationReview.sourceHash='stale',
  value=>value.decisions[0].coverage[0].semanticProof.clauses[0].sourceOperationReview.originalClause='Different work.',
  value=>value.decisions[0].coverage[0].semanticProof.clauses[0].sourceOperationReview.survivorRef='another',
  value=>value.decisions[0].coverage[0].semanticProof.clauses[0].sourceOperationReview.verdict='supported elsewhere',
  value=>value.decisions[0].coverage[0].semanticProof.clauses[0].sourceOperationReview.sourceIds=[]
 ]){
  const bad=structuredClone(bound);mutate(bad);
  assert.equal(action.applyActionReconciliation(packet,bad,{sourceUnits}).actions.length,2);
 }
});

test('bounded independent witness allocation archives tentative citations but never removes original action evidence',()=>{
 const f=fixture(),extra={id:'T3',speaker:'Coordinator',text:'Unrelated administrative chatter.'};
 const units=[...f.sourceUnits,extra],packet=action.prepareActionReconciliation({actions:f.rows,sourceUnits:units});
 const expanded=structuredClone(f.expanded),review=structuredClone(f.review);
 for(const value of [expanded,review]){value.packetHash=packet.packetHash;value.sourceHash=packet.sourceHash;}
 const span={unitId:'T3',start:0,end:extra.text.length,quote:extra.text};
 for(const proof of expanded.decisions[0].coverage){
  proof.sourceSpans.push(span);
  for(const mapping of proof.semanticProof.clauses)for(const facet of ['operation','object'])mapping.facets[facet].sourceSpans.push(span);
 }
 const legacy=verify.bindSourceVerification(packet,expanded,review);
 assert.equal(legacy.error,'');
 assert.ok(action.applyActionReconciliation(packet,legacy.envelope,{sourceUnits:units}).actions[0].evidenceIds.includes('T3'));
 const allocated=verify.bindSourceVerification(packet,expanded,review,{independentWitnessCandidateIds:[f.candidate.candidateId]});
 assert.equal(allocated.error,'');
 const proof=allocated.envelope.decisions[0].coverage[0];
 assert.equal(proof.sourceAllocation.method,'independent-action-witnesses-v1');
 assert.deepEqual(proof.sourceAllocation.proposedSourceIds,['T1','T2','T3']);
 assert.deepEqual(proof.sourceAllocation.verifiedSourceIds,['T1','T2']);
 const result=action.applyActionReconciliation(packet,allocated.envelope,{sourceUnits:units});
 assert.equal(result.actions.length,1);assert.deepEqual(result.actions[0].evidenceIds,['T1','T2']);
 assert.ok(result.receipts.every(r=>action.validateReconciliationReceipt(r,r.original,result.actions[0],units)));
});
test('source-owner validation rejects name substrings and preserves explicit unresolved outcomes',()=>{
 assert.equal(verify.ownerWitness({speaker:'Coordinator',text:'Morgan Leeds will review it.'},'Morgan Lee'),false);
 assert.equal(verify.ownerWitness({speaker:'Morgan Lee',text:'No, I will not take that on.'},'Morgan Lee'),true,'identity presence alone is never an ownership decision');
 const f=fixture(),missing=structuredClone(f.review);missing.decisions[0].checks.forEach(check=>check.sourceIds=[]);
 assert.equal(verify.verificationError(f.packet,f.packet.candidates,missing),'invalid_source_clause_result');
 const veto=structuredClone(f.review);veto.decisions[0].relation='unresolved';veto.decisions[0].checks.forEach(check=>{check.supported=false;check.retained=false;check.sourceIds=[];});
 assert.equal(verify.verificationError(f.packet,f.packet.candidates,veto),'');
 assert.equal(action.applyActionReconciliation(f.packet,verify.bindSourceVerification(f.packet,f.expanded,veto).envelope,{sourceUnits:f.sourceUnits}).actions.length,2);
});
