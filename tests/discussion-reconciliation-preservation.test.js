'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {FACETS,prepareDiscussionReconciliation:prepare,applyDiscussionReconciliation:apply}=require('../utils/canonicalMinutes/discussionReconciliation');

function attemptClaimedMerge(originalText,survivorText){
 const row=(id,text)=>({id,text,evidenceIds:['T1'],reviewFlagIds:[],supportingDetails:[]});
 const discussion=[{id:'topic',topic:'Operations',points:[row('original',originalText),row('survivor',survivorText)],decisions:[],openQuestions:[]}];
 const sourceUnits=[{id:'T1',speaker:'Maya',text:originalText+' '+survivorText}];
 const options={sourceUnits,policyVersion:'preservation-test'};
 const packet=prepare(discussion,options),candidate=packet.candidates[0];
 if(!candidate) return {discussion,result:apply(discussion,packet,null,options)};
 const winner=packet.rows.find(item=>item.original.id==='survivor');
 const span={unitId:'T1',start:0,end:sourceUnits[0].text.length,quote:sourceUnits[0].text};
 const envelope={version:packet.version,packetHash:packet.packetHash,sourceHash:packet.sourceHash,inputHash:packet.inputHash,
  decisions:packet.candidates.map(pair=>({candidateId:pair.candidateId,relation:pair.candidateId===candidate.candidateId?'equivalent':'distinct',
   ...(pair.candidateId===candidate.candidateId?{survivorRef:winner.ref,coverage:[pair.leftRef,pair.rightRef].map(ref=>{
    const original=packet.rows.find(item=>item.ref===ref);
    return {fromRef:ref,toRef:winner.ref,preservedFacets:[...FACETS],protectedFacets:original.protectedFacets,sourceSpans:[span],
     clauseMap:original.clauses.map(clause=>({fromClauseId:clause.clauseId,toClauseIds:winner.clauses.map(item=>item.clauseId),sourceSpans:[span]}))};
   })}:{})}))};
 return {discussion,result:apply(discussion,packet,envelope,options)};
}

for(const [name,original,survivor] of [
 ['consideration is not the final decision','There was discussion of the feasibility of retaining the membership fee at £40.','The committee agreed to increase the membership fee from £40 to £45.'],
 ['packing details remain concrete obligations','Packing involves removing items from protective sleeves and inserting them into branded cases with the warranty booklet.','Packed items include the warranty booklet and are then shipped.'],
 ['purpose and recipient survive','A photograph will be taken and attached to the council letter.','A photograph will be taken.'],
 ['specific material survives','The inspection tray uses sealed sterile bags.','The inspection tray uses bags.'],
 ['document modifiers survive','The revised international supplier report received committee approval.','The committee approved the supplier report.'],
 ['actor and recipient cannot reverse','The supplier notified the committee about the inspection report.','The committee notified the supplier about the inspection report.'],
 ['actor and recipient cannot reverse when a detail is added','The supplier notified the committee about the inspection report.','The committee notified the supplier about the revised inspection report.'],
 ['named participants cannot reverse','Maya sent the inspection report to Oliver.','Oliver sent the inspection report to Maya.'],
 ['source and destination cannot reverse','The pump transfers fluid from the reservoir to the sterile container.','The pump transfers fluid from the sterile container to the reservoir.'],
 ['source and beneficiary are separate roles','Maya received the inspection report from Oliver.','Maya received the inspection report for Oliver.'],
 ['recipient and author are separate roles','The inspection report was sent to Oliver.','The inspection report was sent by Oliver.'],
 ['past and present state are separate occurrences','The inspection report was ready for review.','The inspection report is ready for review.']
]) test('a model coverage claim cannot discard '+name,()=>{
 const {discussion,result}=attemptClaimedMerge(original,survivor);
 assert.deepEqual(result.discussion,discussion);
 assert.equal(result.ledger.length,0);
});

test('a richer existing proposition may retain the same actor, recipient and content in order',()=>{
 const {result}=attemptClaimedMerge('The supplier notified the committee about the inspection report.','The supplier notified the audit committee about the revised inspection report.');
 assert.equal(result.discussion[0].points.length,1);
 assert.equal(result.discussion[0].points[0].id,'survivor');
});

test('bounded passive approval paraphrases still retain the complete subject and object',()=>{
 const {result}=attemptClaimedMerge('The inspection report received committee approval.','The committee approved the inspection report.');
 assert.equal(result.discussion[0].points.length,1);
 assert.equal(result.discussion[0].points[0].id,'survivor');
});
