'use strict';
process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1 = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const Source = require('../utils/meetingMinutesSource'),
  EvidenceContext = require('../utils/meetingMinutesEvidenceContext'),
  ReviewFlags = require('../utils/meetingMinutesReviewFlags'),
  AssessmentEvidence = require('../utils/meetingMinutesAssessmentEvidence');
const DiscoveryValidation = require('../utils/meetingMinutesDiscoveryValidation');
const units = () => Source.normaliseSourceUnits([
  { id:'T0001', speaker:'Maya Patel', text:'The standard is 74216, covering portable pump requirements.' },
  { id:'T0002', speaker:'Maya Patel', text:'We can maybe get an assessment of that standard to see if it is applicable to the portable pump.' }
]);
const action = 'Assess whether standard 74216 is applicable to the portable pump.';
const proposal = extra => ({ id:'assessment', action, owners:['Maya Patel'], evidenceIds:['T0002'],
  timing:{kind:'not_stated',wording:'',exactDate:''},reviewFlagIds:[], ...extra });
const normalise = (rows, source=units()) => DiscoveryValidation.normaliseAgentDeclaredProposals({actionProposals:rows},source);

test('proposal-only context retains original citations and requires review without changing work, owners or timing', () => {
  const input=proposal(),source=units(),before=structuredClone([input,source]);
  assert.equal(EvidenceContext.evidenceSupportScore(action,source[1].text),0);
  const result=normalise([input],source);
  assert.equal(result.length,1);
  assert.equal(result[0].action,input.action);
  assert.deepEqual(result[0].owners,input.owners);
  assert.deepEqual(result[0].timing,input.timing);
  assert.deepEqual(result[0].evidenceIds,['T0001','T0002']);
  const recovered=ReviewFlags.reconcileRecordFlags({actions:result},[]);
  const warning=recovered.flags.find(flag=>flag.id.startsWith('flag-document-reference-'));
  assert.ok(warning);
  assert.equal(warning.kind,'unclear_reference');
  assert.equal(warning.status,'open');
  assert.match(warning.message,/have not been verified/);
  assert.deepEqual(warning.documentReferenceContext,{kind:'adjacent_identity_context',originalEvidenceIds:['T0002'],addedEvidenceIds:['T0001'],workEvidenceIds:['T0002']});
  assert.deepEqual([input,source],before);
});

test('review provenance survives normalisation without overwriting a human decision', () => {
  const result=normalise([proposal()]);
  const recovered=ReviewFlags.reconcileRecordFlags({actions:result},[]);
  const warning=recovered.flags.find(flag=>flag.documentReferenceContext);
  const reviewed={...warning,status:'corrected',correctionNote:'Confirmed the reference with the meeting owner.'};
  assert.deepEqual(ReviewFlags.normaliseFlag(JSON.parse(JSON.stringify(reviewed))),reviewed);
});

const negatives = [
 ['nearby unrelated identifier',source=>{source[0].text='The standard is 89531, covering portable pump requirements.';}],
 ['competing identity values',source=>{source[0].text='The standards are 74216 and 89531, covering portable pump requirements.';}],
 ['another identifier in the work',source=>{source[1].text='We can maybe assess that standard, 89531, for applicability to the portable pump.';}],
 ['a second work document without an identifier',source=>{source[1].text='That standard has arrived. I will assess the pressure protocol for applicability to the portable pump.';}],
 ['speaker changes',source=>{source[0].speaker='Leo Chen';}],
 ['unknown speaker',source=>{source.forEach(row=>row.speaker='Speaker');}],
 ['ambiguous reference',source=>{source[1].text='We can maybe assess either standard; we are not sure which one applies to the portable pump.';}],
 ['generic pronoun only',source=>{source[1].text='We can maybe get an assessment of it to see if it is applicable to the portable pump.';}],
 ['different document kind',source=>{source[1].text='We can maybe get an assessment of that protocol to see if it is applicable to the portable pump.';}],
 ['missing source turn',source=>{source[1].id='T0003';}],
 ['intervening topic',source=>{source.splice(1,0,{id:'T0002',speaker:'Maya Patel',text:'The staffing budget is a separate topic.'});source[2].id='T0003';}],
 ['excluded identity',source=>{source[0].classification='remove';}],
 ['excluded work',source=>{source[1].classification='remove';}],
 ['cost mistaken for document identity',source=>{source[0].text='The budget cost is 74216 pounds for the portable pump.';}],
 ['duplicate source ID',source=>{source.push({...source[0]});}],
 ['completed assessment',source=>{source[1].text='We already completed the assessment of that standard for applicability to the portable pump.';}],
 ['unsupported operation',source=>{source[1].text='That standard arrived with the portable pump yesterday.';}]
];
for(const [name,change] of negatives)test('does not add context for '+name,()=>{
 const source=units();change(source);
 assert.equal(AssessmentEvidence.documentReferenceContextEvidence(action,['T0002'],source),null);
});

test('unstated identifier prefix and additional unsupported quantity are not repaired',()=>{
 assert.equal(AssessmentEvidence.documentReferenceContextEvidence(action.replace('standard 74216','ISO 74216'),['T0002'],units()),null);
 assert.equal(AssessmentEvidence.documentReferenceContextEvidence(action+' Complete 12 assessments.', ['T0002'],units()),null);
});

test('a source-stated prefix is permitted, still requiring review',()=>{
 const source=units();source[0].text='The standard is ISO 74216, covering portable pump requirements.';
 const result=normalise([proposal({action:action.replace('standard 74216','ISO 74216')})],source);
 assert.equal(result.length,1);
 assert.ok(result[0].reviewFlagIds.some(id=>id.startsWith('flag-document-reference-')));
});

test('already sufficient evidence takes the existing path without a context warning',()=>{
 const result=normalise([proposal({evidenceIds:['T0001','T0002']})]);
 assert.equal(result.length,1);
 assert.ok(!result[0].reviewFlagIds.some(id=>id.startsWith('flag-document-reference-')));
});

test('unverified source context cannot certify new dates or accept more than the citation budget',()=>{
 assert.equal(AssessmentEvidence.documentReferenceContextEvidence(action,['T0001','T0002'],units()),null);
 assert.equal(AssessmentEvidence.documentReferenceContextEvidence(action,Array.from({length:8},(_,i)=>'T'+String(i+2).padStart(4,'0')),units()),null);
 const malformed=ReviewFlags.normaliseFlag({documentReferenceContext:{kind:'verified',originalEvidenceIds:['T0002'],addedEvidenceIds:['T0001'],workEvidenceIds:['T0002']}});
 assert.equal(Object.hasOwn(malformed,'documentReferenceContext'),false);
});
