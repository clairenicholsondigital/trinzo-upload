'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const L=require('../utils/meetingMinutesLiteralWording'),R=require('../utils/canonicalMinutes/actionSemanticReconciliation'),T=require('../utils/meetingMinutesSemanticProofTransport'),V=require('../utils/meetingMinutesSemanticSourceVerification');
const row=(id,action)=>({id,action,owners:['Nora Patel'],evidenceIds:['T1'],reviewFlagIds:[],timing:{kind:'not_stated',wording:'',exactDate:''}});
function proof(actions,sourceText){
 const sourceUnits=[{id:'T1',speaker:'Nora Patel',text:sourceText}],p=R.prepareActionReconciliation({actions,sourceUnits}),c=p.candidates[0],survivor=p.rows[1];
 assert.ok(c,'The unrestricted diagnostic packet should preserve the comparison');
 const response={version:p.version,packetHash:p.packetHash,sourceHash:p.sourceHash,inputHash:p.inputHash,decisions:[{candidateId:c.candidateId,relation:'equivalent',survivorRef:survivor.ref,coverage:[c.leftRef,c.rightRef].map(originalRef=>({originalRef,survivorRef:survivor.ref,sourceIds:['T1'],clauseMap:[{originalClauseIndex:0,survivorClauseIndex:0,sourceIds:['T1']}]}))}]};
 const expanded=T.materializeSemanticDecisions(p,response,'actions'),review={version:V.VERSION,packetHash:p.packetHash,sourceHash:p.sourceHash,inputHash:p.inputHash,sourceStatusMethod:V.SOURCE_STATUS_METHOD,selfRetentionMethod:V.SELF_RETENTION_METHOD,decisions:[{candidateId:c.candidateId,relation:'equivalent',survivorRef:survivor.ref,checks:[c.leftRef,c.rightRef].map(originalRef=>({originalRef,clauseIndex:0,supported:true,sourceStatus:'outstanding',...(originalRef===survivor.ref?{}:{retained:true}),sourceIds:['T1']}))}]};
 const bound=V.bindSourceVerification(p,expanded,review,{requireSourceStatus:true});assert.equal(bound.error,'');
 return {p,bound:bound.envelope,sourceUnits};
}
test('explicit words and quoted phrases are identified without topic-specific vocabulary',()=>{
 for(const text of ['Use the word caution.','Write the note using the word caution in it.','Include the term caution.','Write the note including the word “caution”.'])assert.deepEqual(L.requiredLiteralWording(text),['caution']);
 assert.deepEqual(L.requiredLiteralWording('Use the phrase “inspection complete” in the report.'),['inspection complete']);
 assert.deepEqual(L.requiredLiteralWording("Use the term 'can't' in the example."),["can't"]);
 assert.deepEqual(L.requiredLiteralWording('Use the phrase "--dry-run".'),['--dry-run']);
 assert.deepEqual(L.requiredLiteralWording('Use the word caution and use the word caution.'),['caution']);
});
test('unknown phrase boundaries, pronoun references, prohibitions and ordinary Word usage stay outside this positive guard',()=>{
 for(const text of ['Use the phrase we discussed.','Use the term quality assurance in the letter.','Use the word that we agreed.','Do not use the word caution.','Write without using the word caution.','Avoid using the word caution.','Use Word to write the letter.','Use the phrase "an unfinished quotation.'])assert.deepEqual(L.requiredLiteralWording(text),[],text);
});
test('target presence respects Unicode boundaries and literal phrase content rather than substrings',()=>{
 for(const text of ['cautionary','precaution','caution\u0301','caution_2'])assert.equal(L.containsLiteralWording(text,'caution'),false,text);
 assert.equal(L.containsLiteralWording('State: CAUTION.','caution'),true);
 assert.equal(L.containsLiteralWording('Say inspection complete.','inspection complete'),true);
 assert.equal(L.containsLiteralWording('Say inspection is complete.','inspection complete'),false);
 assert.equal(L.containsLiteralWording('Use --dry-running.','--dry-run'),false);
 assert.equal(L.containsLiteralWording('Use “café”.','cafe\u0301'),true);
});
test('a supported model equivalence cannot merge away an explicit required word',()=>{
 const actions=[row('a','Write the council letter using the word caution.'),row('b','Write the council letter using the word warning.')],{p,bound,sourceUnits}=proof(actions,'I will write the council letter using the word caution.');
 const result=R.applyActionReconciliation(p,bound,{sourceUnits});assert.deepEqual(result.actions,actions);assert.equal(result.receipts.length,0);
 assert.ok(result.ledger.some(entry=>entry.reasons.some(reason=>reason.includes('required_literal_wording_would_be_lost'))));
 assert.equal(R.prepareActionReconciliation({actions,sourceUnits,scope:'bounded_existing_survivors'}).candidates.length,0);
});
test('a phrase lost inside one quoted clause is blocked without changing the complete-clause packet format',()=>{
 const actions=[row('a','Write the report using the phrase “inspection complete”.'),row('b','Write the report.')],{p,bound,sourceUnits}=proof(actions,'I will write the report using the phrase “inspection complete”.');
 assert.deepEqual(R.applyActionReconciliation(p,bound,{sourceUnits}).actions,actions);
 assert.ok(R.mechanicalCoverage(actions[0],actions[1]).reasons.includes('required_literal_wording_would_be_lost'));
});
test('same explicit word under a genuine paraphrase remains mergeable with valid receipts',()=>{
 const actions=[row('a','Write the council letter using the word caution.'),row('b','Write the council letter using the term caution.')],{p,bound,sourceUnits}=proof(actions,'I will write the council letter using the word caution.');
 const result=R.applyActionReconciliation(p,bound,{sourceUnits});assert.equal(result.actions.length,1);assert.equal(result.receipts.length,1);
 assert.ok(result.receipts.every(receipt=>R.validateReconciliationReceipt(receipt,receipt.original,result.actions[0],sourceUnits)));
 assert.equal(R.prepareActionReconciliation({actions,sourceUnits,scope:'bounded_existing_survivors'}).candidates.length,1);
});
test('presence is only a veto guard, never proof that qualified or separately assigned work can merge',()=>{
 const a=row('a','Write the letter using the word caution.'),b={...row('b','Write the letter without using the word caution.'),owners:['Sam Patel']};
 assert.deepEqual(L.missingRequiredLiteralWording(a.action,b.action),[]);
 assert.equal(R.mechanicalCoverage(a,b).covered,false);
 assert.ok(R.mechanicalCoverage(a,b).reasons.includes('different_or_missing_owners'));
});
