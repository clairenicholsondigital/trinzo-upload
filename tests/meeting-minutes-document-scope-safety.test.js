'use strict';
process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1='0';
const test=require('node:test'),assert=require('node:assert/strict');
const V=require('../utils/meetingMinutesAgentV2'),A=require('../routes/api').stagedEvaluation;
const input=()=>({source:V.normaliseSourceUnits([
 {id:'T0001',speaker:'Maya Patel',text:'The standard is 74216, covering portable pump requirements.'},
 {id:'T0002',speaker:'Maya Patel',text:'We can maybe get an assessment of that standard to see if it is applicable to the portable pump.'}
]),proposal:{id:'assessment',action:'Assess whether standard 74216 is applicable to the portable pump.',owners:[],evidenceIds:['T0002'],reviewFlagIds:[],timing:{kind:'not_stated',wording:'',exactDate:''}}});
const matrix=[
 ['nearby but unrelated document',f=>{f.source[1].text='That standard is unrelated. I will assess the pressure protocol for applicability to the portable pump.';}],
 ['competing identities',f=>{f.source[0].text='The standard identifiers are 74216 and 89531, covering portable pump requirements.';}],
 ['an identifier that merely contains the requested number',f=>{f.source[0].text='The standard is 742160, covering portable pump requirements.';}],
 ['a neighbouring revision instead of the requested identifier',f=>{f.source[0].text='The standard is 74216-2, covering portable pump requirements.';}],
 ['multiple named proposal documents',f=>{f.proposal.action='Assess whether standard 74216 and standard 89531 are applicable to the portable pump.';}],
 ['a number without identifying language',f=>{f.source[0].text='74216. Portable pump requirements were mentioned.';}],
 ['another speaker identifying the document',f=>{f.source[0].speaker='Sam Reed';}],
 ['an excluded intervening source turn',f=>{f.source.splice(1,0,{id:'T0002',speaker:'Maya Patel',text:'A separate agenda item.',classification:'remove'});f.source[2].id='T0003';f.proposal.evidenceIds=['T0003'];}],
 ['a source date used as an identifier',f=>{f.source[0].text='The standard review date is 2026. Portable pump requirements were mentioned.';f.proposal.action='Assess whether standard 74216 is applicable to the portable pump.';}],
 ['an extra unsupported quantity',f=>{f.proposal.action+=' Complete 12 assessments.';}],
 ['a completed assessment',f=>{f.source[1].text='We already completed the assessment of that standard for the portable pump.';}]
];
for(const [label,mutate] of matrix)test('unsafe context does not enter the proposal through '+label,()=>{
 const f=input();mutate(f);const before=structuredClone(f);
 const result=A.normaliseAgentDeclaredProposals({actionProposals:[f.proposal]},f.source);
 assert.equal(result.length,0);
 assert.deepEqual(f,before);
});

test('adding document context preserves a conditional proposal without finding an owner or a date',()=>{
 const f=input();
 f.source[0].text+=' The demonstration will be on 12 November.';
 f.source[1].text='If legal approves release, we can maybe get an assessment of that standard to see if it is applicable to the portable pump.';
 f.proposal.timing={kind:'dependency',wording:'If legal approves release',exactDate:''};
 const result=A.normaliseAgentDeclaredProposals({actionProposals:[f.proposal]},f.source);
 assert.equal(result.length,1);assert.deepEqual(result[0].owners,[]);
 assert.deepEqual(result[0].timing,f.proposal.timing);
 assert.equal(A.safeAgentProposalPromotion(result[0],[],f.source),false);
});

test('uncertain source classification never turns added context into automatic verification',()=>{
 const f=input();f.source[0].classification='uncertain';f.source[0].confidence=0.1;
 const result=A.normaliseAgentDeclaredProposals({actionProposals:[f.proposal]},f.source);
 assert.equal(result.length,1);
 const flags=A.retainedDocumentReferenceReviewFlags(result);
 assert.equal(flags.length,1);assert.equal(flags[0].status,'open');
 assert.equal(A.safeAgentProposalPromotion(result[0],[],f.source),false);
});

test('no discovery response cannot manufacture a new proposal at the normalisation boundary',()=>{
 const f=input();const combined=A.unionActionDiscoveryResults(null,null);
 assert.equal(combined,null);
 assert.deepEqual(A.normaliseAgentDeclaredProposals(combined||{},f.source),[]);
});

test('a conflicting identifier prefix stays an explicit correction question, never an automatic addition',()=>{
 const f=input();f.source[0].text='The standard is IEC 74216, covering portable pump requirements.';
 f.proposal.action=f.proposal.action.replace('standard 74216','ISO 74216');
 const result=A.normaliseAgentDeclaredProposals({actionProposals:[f.proposal]},f.source);
 assert.equal(result.length,1);assert.equal(result[0].action,f.proposal.action);
 const flags=A.retainedDocumentReferenceReviewFlags(result);
 assert.equal(flags[0].documentReferenceContext.unstatedPrefix,'ISO');
 assert.match(flags[0].message,/ISO identifier prefix is not stated/);
 const p=V.buildProposal('actions',[],result);p.changes.forEach(c=>c.selected=true);
 assert.deepEqual(A.automaticMeetingAgentProposalReview(p,flags,[],f.source).acceptedIds,[]);
});
