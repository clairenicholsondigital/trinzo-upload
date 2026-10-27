'use strict';
process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1='0';
const test=require('node:test'),assert=require('node:assert/strict');
const V=require('../utils/meetingMinutesAgentV2');
const A=require('../routes/api').stagedEvaluation;
const source=()=>V.normaliseSourceUnits([
 {id:'T0001',speaker:'Maya Patel',text:'The standard is 74216, covering portable pump requirements.'},
 {id:'T0002',speaker:'Maya Patel',text:'We can maybe get an assessment of that standard to see if it is applicable to the portable pump.'}
]);
const row=(action='Assess whether ISO 74216 is applicable to the portable pump.')=>({id:'assessment',action,owners:['Maya Patel'],timing:{kind:'not_stated',wording:'',exactDate:''},evidenceIds:['T0002'],reviewFlagIds:[]});
const notice=()=>({type:'unsupported_ownership',detail:'Assessment work is requested, but acceptance and responsible owner are not explicitly confirmed.',evidenceIds:['T0002']});

test('an unstated prefix remains a warned proposal with original wording, not a verified identity',()=>{
 const input=row(),before=structuredClone(input),units=source();
 const proposals=A.normaliseAgentDeclaredProposals({actionProposals:[input]},units);
 assert.equal(proposals.length,1);assert.equal(proposals[0].action,input.action);
 assert.deepEqual(input,before);
 const recovered=V.reconcileRecordFlags({actions:proposals},[]);
 const flag=recovered.flags.find(f=>f.documentReferenceContext);
 assert.equal(flag.documentReferenceContext.unstatedPrefix,'ISO');
 assert.match(flag.message,/prefix is not stated/);assert.equal(flag.status,'open');
 assert.equal(A.safeAgentProposalPromotion(proposals[0],[],units),false);
});

test('a selected bit cannot automatically adopt an unverified document reference or multiply its warning',()=>{
 const units=source(),proposals=A.normaliseAgentDeclaredProposals({actionProposals:[row()]},units);
 const flag=V.reconcileRecordFlags({actions:proposals},[]).flags.find(f=>f.documentReferenceContext);
 const proposal=V.buildProposal('actions',[],proposals);proposal.changes.forEach(change=>change.selected=true);
 for(let run=0;run<3;run++){
  const review=A.automaticMeetingAgentProposalReview(proposal,[flag],[],units);
  assert.deepEqual(review.acceptedIds,[]);
  assert.equal(review.reviewFlags.length,1);
  assert.equal(review.reviewFlags[0].id,flag.id);
  assert.equal(review.reviewFlags[0].kind,'possible_missed_follow_up');
  assert.deepEqual(review.reviewFlags[0].documentReferenceContext,flag.documentReferenceContext);
 }
 // The existing explicit human acceptance mechanism still functions.
 assert.equal(V.applyProposal([],proposal,[proposal.changes[0].id]).length,1);
});

test('commitment verification does not override a document-reference warning',()=>{
 const action=row();action.reviewFlagIds=['flag-document-reference-test'];
 const items=[{id:'c1',index:0,passage:'Maya Patel: I will assess the standard.'}];
 const replies=[{id:'c1',verdict:'commitment',commitmentQuote:'I will assess the standard.',ownerSupported:true}];
 assert.deepEqual(V.applyCommitmentCheckResults([action],items,replies),[]);
 const ordinary={...action,reviewFlagIds:[]};
 assert.equal(V.applyCommitmentCheckResults([ordinary],items,replies).length,1);
});

test('a source-backed ownership notice remains one question and creates no action or owner',()=>{
 let candidate={actions:[],reviewFlags:[notice()]};
 for(let repeat=0;repeat<3;repeat++){
  const output=V.normaliseAgentResult(candidate,source(),'actions');
  assert.equal(output.actions.length,0);assert.equal(output.reviewFlags.length,1);
  const flag=output.reviewFlags[0];assert.equal(flag.kind,'possible_missed_follow_up');
  assert.equal(flag.sourceReviewContext.originalMessage,notice().detail);
  assert.deepEqual(flag.evidenceIds,['T0002']);assert.equal(flag.status,'open');
  candidate=output;
 }
});

for(const [label,mutate] of [
 ['unknown source',f=>{f.evidenceIds=['T9999'];}],
 ['no source',f=>{f.evidenceIds=[];}],
 ['unsupported notice topic',f=>{f.detail='Confirm the owner of the invoice.';}]
])test('does not manufacture an assessment question from '+label,()=>{
 const f=notice();mutate(f);
 const out=V.normaliseAgentResult({reviewFlags:[f]},source(),'actions');
 assert.ok(out.reviewFlags.every(flag=>!flag.sourceReviewContext));
});

test('completed or explicitly declined source work does not gain a new assessment review item',()=>{
 for(const text of ['We already completed the assessment of that standard.','I am not committing to review that standard.']){
  const units=source();units[1].text=text;
  const output=V.normaliseAgentResult({reviewFlags:[notice()]},units,'actions');
  assert.ok(output.reviewFlags.every(f=>!f.sourceReviewContext));
 }
});

test('document context provenance survives a human note and JSON round trip',()=>{
 const proposals=A.normaliseAgentDeclaredProposals({actionProposals:[row()]},source());
 const flag=V.reconcileRecordFlags({actions:proposals},[]).flags.find(f=>f.documentReferenceContext);
 const reviewed={...flag,status:'corrected',correctionNote:'Confirmed the document number; prefix needs correction.'};
 assert.deepEqual(V.normaliseFlag(JSON.parse(JSON.stringify(reviewed))),reviewed);
 const output=V.normaliseAgentResult({reviewFlags:[notice()]},source(),'actions');
 const question={...output.reviewFlags[0],status:'confirmed',correctionNote:'Discussed with the meeting owner.'};
 assert.deepEqual(V.normaliseFlag(JSON.parse(JSON.stringify(question))),question);
});

test('withholding a candidate later still retains exactly one source question with its provenance',()=>{
 const candidates=A.normaliseAgentDeclaredProposals({actionProposals:[row()]},source());
 const flags=A.retainedDocumentReferenceReviewFlags([...candidates,...candidates]);
 assert.equal(flags.length,1);assert.equal(flags[0].kind,'possible_missed_follow_up');
 assert.equal(flags[0].documentReferenceContext.unstatedPrefix,'ISO');
 assert.match(flags[0].message,/Possible assessment to review/);
 const again=A.retainedDocumentReferenceReviewFlags(candidates,flags);
 assert.equal(again.length,1);assert.equal(again[0].message,flags[0].message);
});

test('removal proposals and malformed absent records do not become document-review additions',()=>{
 for(const record of [null,undefined,{}, {reviewFlagIds:'not-an-array'}])assert.equal(V.requiresDocumentReferenceReview(record),false);
});

test('an ordinal action ID on an unrelated delivery does not suppress the source assessment question',()=>{
 const f={...notice(),actionId:'A1'};
 const out=V.normaliseAgentResult({actions:[{...row('Send the portable pump documentation.'),id:'A1'}],reviewFlags:[f]},source(),'actions',{enforceEvidence:false});
 assert.ok(out.reviewFlags.some(flag=>flag.sourceReviewContext?.kind==='assessment_ownership_notice'));
});

test('independent replies reusing an ordinal ID keep each assessment linked to its own source',()=>{
 const units=V.normaliseSourceUnits([
  {id:'T0001',speaker:'Maya Patel',text:'The standard is 74216, covering portable pump requirements.'},
  {id:'T0002',speaker:'Maya Patel',text:'We can maybe get an assessment of that standard to see if it is applicable to the portable pump.'},
  {id:'T0003',speaker:'Maya Patel',text:'The standard is 89531, covering cardiac monitor requirements.'},
  {id:'T0004',speaker:'Maya Patel',text:'We can maybe get an assessment of that standard to see if it is applicable to the cardiac monitor.'}
 ]);
 const one={...row('Assess whether standard 74216 is applicable to the portable pump.'),id:'A1'};
 const two={...row('Assess whether standard 89531 is applicable to the cardiac monitor.'),id:'A1',evidenceIds:['T0004']};
 const output=A.normaliseAgentDeclaredProposals({actionProposals:[one,two]},units);
 assert.equal(output.length,2);
 assert.deepEqual(output.find(r=>/89531/.test(r.action)).evidenceIds,['T0003','T0004']);
 assert.deepEqual(output.find(r=>/74216/.test(r.action)).evidenceIds,['T0001','T0002']);
});
