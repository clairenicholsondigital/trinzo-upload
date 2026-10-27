'use strict';const test=require('node:test'),assert=require('node:assert/strict'),P=require('../utils/meetingMinutesSemanticPolicy'),R=require('../utils/meetingMinutesActionReferenceReview');
const packet={requestId:'test',qualifiedDependency:true,reviewPurpose:'proposal',base:{rows:[{ref:'s'}],survivorRef:'s',globalInventory:[],unassessedComparisonIds:[]},sourceRows:[{rowId:'A',originalRef:'s',ownerWitnesses:[{owner:'Nora Patel',refs:['T0001']}],requests:[{id:'sA1'}]},{rowId:'B',ownerWitnesses:[{owner:'Nora Patel',refs:['T0001']}],requests:[{id:'sB1'}]}],retentionRequests:[{id:'r1'}],sourceCatalog:[],survivorCatalog:[]};
test('qualified-dependency contract spells out every source and retention check as unclear',()=>{const text=R.prompt(packet,{completeContract:true}),data=JSON.parse(text.split('\nDATA\n')[1]);assert.deepEqual(data.outputShape.decisions[0].rows.map(r=>r.checks.map(c=>c.id)),[['sA1'],['sB1']]);assert.equal(data.outputShape.decisions[0].rows[0].checks[0].status,'unclear');assert.deepEqual(data.outputShape.decisions[0].rows[0].checks[0].refs,[]);assert.equal(data.outputShape.decisions[1].checks[0].id,'r1');assert.match(text,/EVERY ownerWitnesses group/);});
test('off keeps the existing prompt and other independent classes receive complete contracts only when enabled',()=>{assert.equal(R.prompt(packet),R.prompt(packet,{completeContract:false}));assert.ok(JSON.parse(R.prompt({...packet,qualifiedDependency:undefined},{completeContract:true}).split('\nDATA\n')[1]).outputShape);assert.equal(JSON.parse(R.prompt(packet).split('\nDATA\n')[1]).outputShape,undefined);});
test('response-contract policy is captured without enabling any semantic class or changing budgets',()=>{const env={MEETING_MINUTES_AGENT_QUALIFIED_DEPENDENCY_DEDUPE_V1:'1'},off=P.captureSemanticPolicy(env),on=P.captureSemanticPolicy({...env,MEETING_MINUTES_AGENT_ACTION_PROOF_CONTRACT_V2:'1'});assert.deepEqual({...on,referenceContracts:undefined},{...off,referenceContracts:undefined});assert.equal(on.referenceContracts,true);assert.equal(P.semanticPolicyForRun({}).referenceContracts,undefined);assert.ok(Object.isFrozen(on));assert.equal(P.captureSemanticPolicy({MEETING_MINUTES_AGENT_ACTION_PROOF_CONTRACT_V2:'1'}).mode,'off');});
const N=require('../utils/meetingMinutesNumericTokens');
test('versioned proof units distinguish grammatical as while shared parser stays unchanged',()=>{for(const text of ['Frame the change as helping the group.','Describe the change as a benefit.']){assert.ok(N.unitTokens(text).includes('as'));assert.ok(!N.proofUnitTokens(text).includes('as'));}for(const text of ['Measure 15 as.','Measure 15as.','Measure one as.','Measure in as using this tool.','Use attoseconds as a unit.','Use as as the unit.','Record the as unit.','as','Unknown as symbol.','Record 3 ms, 2 mA and 1 W.'])assert.deepEqual(N.proofUnitTokens(text),N.unitTokens(text),text);});
test('new proof packets still request real attosecond measurements and legacy packets remain byte-identical by default',()=>{const C=require('../utils/canonicalMinutes/containedRequirement'),timing={kind:'not_stated',wording:'',exactDate:''},parent={id:'p',action:'Draft the device instructions including a pulse duration of 15 as.',owners:['Nora Patel'],timing,evidenceIds:['T0001'],reviewFlagIds:[]},child={...parent,id:'c',action:'Include a pulse duration of 15 as in the device instructions.'},sources=[{id:'T0001',speaker:'Nora Patel',text:'I will draft the device instructions including a pulse duration of 15 as.'}];const old=C.reviewPacket(parent,child,sources,['T0001'],false),explicitOff=C.reviewPacket(parent,child,sources,['T0001'],false,{contextualUnits:false}),current=C.reviewPacket(parent,child,sources,['T0001'],false,{contextualUnits:true});assert.deepEqual(old,explicitOff);assert.equal(old.base.unitContextVersion,undefined);assert.equal(current.base.unitContextVersion,1);for(const row of current.sourceRows)assert.ok(row.requests.some(r=>r.field==='units'&&r.value.includes('as')));});

test('enquiry classification guidance preserves neutral evidence accounting and stays exclusive to enquiries',()=>{
 const contact={...packet,qualifiedDependency:undefined,instructionComparison:'contact_paraphrase'};
 for(const reviewPurpose of ['proposal','independent_challenge']){
  const input={...contact,reviewPurpose},before=structuredClone(input),text=R.prompt(input,{completeContract:true});
  assert.deepEqual(input,before);
  assert.match(text,/narrower description of the SAME enquiry is same_obligation only when the source establishes ONE commitment/);
  assert.match(text,/selected existing record retains the complete narrower requirement/);
  assert.match(text,/independently actionable request, outcome, responsibility or occurrence, use distinct_work or partial_overlap/);
  assert.match(text,/retention is unproved, use unclear or a negative check/);
  const data=JSON.parse(text.split('\nDATA\n')[1]);
  assert.deepEqual(data.sourceRows,input.sourceRows);assert.deepEqual(data.retentionRequests,input.retentionRequests);
  assert.deepEqual(data.outputShape.decisions[0].rows.map(row=>row.basis),['unclear','unclear']);
  assert.equal(data.outputShape.decisions[2].relation,'unclear');
 }
 for(const instructionComparison of [undefined,'issue_paraphrase','content_instruction','list_deliverable','contact_review'])
  assert.doesNotMatch(R.prompt({...packet,instructionComparison},{completeContract:true}),/CONTACT RELATIONSHIP RULE/);
});

test('enquiry clarification never authorises the deliverable-content category in either independent review',()=>{
 const C=require('../utils/canonicalMinutes/contactParaphrase'),V=require('../utils/meetingMinutesAgentV2'),respond=require('./helpers/meeting-minutes-contained-response');
 const action=(id,text)=>({id,action:text,owners:['Nora Patel'],timing:{kind:'not_stated',wording:'',exactDate:''},evidenceIds:['T0001'],reviewFlagIds:[]});
 const parent=action('parent','Follow up with Morgan regarding supplier activities, responsibilities, status, and plan relating to product registration and compliance work.');
 const child=action('child',"Speak to Morgan to clarify the supplier's role and avoid duplication in product registration activities.");
 const units=V.normaliseSourceUnits([{id:'T0001',speaker:'Nora Patel',text:'I will follow up with Morgan regarding supplier registration responsibilities and the work plan.'}]);
 const replies=[false,true].map(challenge=>{const p=C.reviewPacket(parent,child,units,['T0001'],challenge),r=respond({...p,selectedSurvivor:'A'});r.decisions[2].relation='same_obligation';r.decisions[0].rows.forEach(row=>row.basis='commitment');return r;});
 assert.ok(C.certify(parent,child,units,['T0001'],...replies));
 for(const index of [0,1]){const changed=structuredClone(replies);changed[index].decisions[2].relation='discarded_requirement_of_survivor';assert.throws(()=>C.certify(parent,child,units,['T0001'],...changed),/contact_independent_veto/);}
});
