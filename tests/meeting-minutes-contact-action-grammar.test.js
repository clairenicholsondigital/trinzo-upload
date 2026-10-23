'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {contactActionFrame}=require('../utils/canonicalMinutes/contactActionGrammar');
const {conflictingRecipients,conflictingDestinations,commitmentDuplicate,commitmentCanBeRepresented,mergeCommitmentDuplicates}=require('../utils/canonicalMinutes/commitmentDuplicates');
const R=require('../utils/canonicalMinutes/actionSemanticReconciliation');
const row=(id,action,extra={})=>({id,action,owners:['Morgan Lee'],evidenceIds:['T0001'],reviewFlagIds:[],
  timing:{kind:'not_stated',wording:'',exactDate:''},...extra});

test('purpose clauses cannot create a different delivery destination',()=>{
  const a='Speak to Alex to clarify supplier responsibilities.';
  const b='Discuss with Alex the supplier responsibilities to avoid duplication.';
  assert.equal(conflictingDestinations(a,b),false);
  assert.equal(conflictingRecipients(a,b),false);
});
test('recipient extraction ends before purpose and task descriptions',()=>{
  const a='Speak to Alex Smith to clarify responsibilities and timelines.';
  const b='Discuss with Alex Smith the supplier registration activities and obtain the project plan to avoid duplication.';
  assert.equal(contactActionFrame(a).recipient,'alex smith');
  assert.equal(contactActionFrame(b).recipient,'alex smith');
  assert.equal(conflictingRecipients(a,b),false);
});
test('shared objectives cannot hide different explicit recipients',()=>{
  assert.equal(conflictingRecipients('Speak to Alex to clarify supplier responsibilities.',
    'Speak to Priya to clarify supplier responsibilities.'),true);
});
test('a common first name does not equate different full names or invent a short-name alias',()=>{
  assert.equal(conflictingRecipients('Speak to Alex Smith to clarify responsibilities.',
    'Speak to Alex Patel to clarify responsibilities.'),true);
  assert.equal(conflictingRecipients('Speak to Alex to clarify responsibilities.',
    'Speak to Alex Patel to clarify responsibilities.'),true);
});
test('source spelling variants and whitespace do not invent recipient differences',()=>{
  assert.equal(conflictingRecipients('Speak to Nora O’Neill to clarify responsibilities.',
    "Talk with Nora O'Neill to clarify responsibilities."),false);
  assert.equal(conflictingRecipients('Speak to Alex   Smith to clarify responsibilities.',
    'Talk with Alex Smith to clarify responsibilities.'),false);
});
test('explicit names longer than three words are not truncated',()=>{
  assert.equal(contactActionFrame('Speak to Alex Jordan Morgan Taylor Reed to clarify responsibilities.').recipient,
    'alex jordan morgan taylor reed');
});
test('unfamiliar recipient grammar stays on its established path',()=>{
  for(const value of [
    'Speak to Alex and Priya to clarify responsibilities.',
    'Speak to Alex, Priya and Morgan to clarify responsibilities.',
    'Speak to Dr. Alex Smith to clarify responsibilities.',
    'Speak to Alex van Buren to clarify responsibilities.',
    'Speak to the supplier team to clarify responsibilities.',
    'Speak to Alex To Clarify Responsibilities.',
    'Discuss with Alex System Alpha.',
    'Speak to Alex Smith.',
    'Speak to Alex about "the London plan".',
    'Could Alex clarify responsibilities?',
    'Do not speak to Alex to clarify responsibilities.'
  ]) assert.equal(contactActionFrame(value),null,value);
});
test('real spatial destinations survive alongside a purpose',()=>{
  for(const [a,b] of [
    ['Speak to Alex to clarify supplier responsibilities in London.','Speak to Alex to clarify supplier responsibilities in Paris.'],
    ['Speak to Alex to clarify supplier responsibilities at North Warehouse.','Speak to Alex to clarify supplier responsibilities at South Warehouse.'],
    ['Speak to Alex to clarify data entry into System Alpha.','Speak to Alex to clarify data entry into System Beta.'],
    ['Discuss with Alex the route to Check Point.','Discuss with Alex the route to Loading Bay.']
  ]) assert.equal(conflictingDestinations(a,b),true,`${a} / ${b}`);
});
test('purpose parsing does not change ordinary delivery instructions',()=>{
  assert.equal(conflictingDestinations('Send the report to London.','Send the report to Paris.'),true);
  assert.equal(conflictingDestinations('Place the report into the technical file.','Upload the report onto the document portal.'),true);
});
test('corrected parser inputs are not permission to merge separate contact objectives',()=>{
  const a=row('responsibilities','Speak to Alex to clarify responsibilities and timelines for supplier registration and data entry into the register.');
  const b=row('plan','Discuss with Alex the supplier registration activities and obtain visibility of the project plan or task list to avoid duplication and understand timelines.');
  assert.equal(conflictingRecipients(a.action,b.action),false);
  assert.equal(conflictingDestinations(a.action,b.action),false);
  assert.equal(commitmentCanBeRepresented(a,b),false);
  assert.equal(commitmentCanBeRepresented(b,a),false);
  assert.equal(commitmentDuplicate(a,b,{cosine:1}).duplicate,false);
  assert.deepEqual(mergeCommitmentDuplicates([a,b],{cosines:new Map([['0|1',1]])}).actions,[a,b]);
});
test('wrong recipients, destinations, owners and dates remain separate even with perfect similarity',()=>{
  const base=row('a','Speak to Alex Smith to clarify supplier responsibilities in London.');
  const variants=[
    row('b',base.action.replace('Alex Smith','Alex Patel')),
    row('c',base.action.replace('London','Paris')),
    row('d',base.action,{owners:['Priya Shah']})
  ];
  for(const other of variants){
    assert.equal(commitmentDuplicate(base,other,{cosine:1}).duplicate,false);
    assert.deepEqual(mergeCommitmentDuplicates([base,other],{cosines:new Map([['0|1',1]])}).actions,[base,other]);
  }
  const dated={...base,timing:{kind:'deadline',wording:'Friday',exactDate:'2026-10-30'}};
  const other=row('e',base.action,{timing:{kind:'deadline',wording:'Monday',exactDate:'2026-11-02'}});
  assert.equal(commitmentDuplicate(dated,other,{cosine:1}).duplicate,false);
  assert.deepEqual(mergeCommitmentDuplicates([dated,other],{cosines:new Map([['0|1',1]])}).actions,[dated,other]);
});
test('the reconciliation packet removes only the false destination reason for different objectives',()=>{
  const a=row('a','Speak to Alex to clarify supplier registration responsibilities.');
  const b=row('b','Discuss with Alex the supplier registration project plan to avoid duplication.');
  const packet=R.prepareActionReconciliation({actions:[a,b],sourceUnits:[{id:'T0001',speaker:'Morgan',text:'The supplier registration responsibilities and project plan require discussion.'}]});
  assert.equal(packet.candidates.length,1);
  for(const check of [packet.candidates[0].leftIntoRight,packet.candidates[0].rightIntoLeft]) {
    assert.equal(check.covered,false);
    assert.ok(!check.reasons.includes('different_destination'));
    assert.ok(check.reasons.includes('different_operation'));
  }
});
test('a fully retained literal contact instruction still merges with complete metadata',()=>{
  const a=row('a','Speak to Alex to clarify supplier registration responsibilities.');
  const b=row('b',a.action,{evidenceIds:['T0001','T0002'],reviewFlagIds:['review-check']});
  const out=mergeCommitmentDuplicates([a,b]);
  assert.equal(out.actions.length,1);
  assert.deepEqual(new Set(out.actions[0].evidenceIds),new Set(['T0001','T0002']));
  assert.deepEqual(out.actions[0].reviewFlagIds,['review-check']);
});
test('reviewer-authored contact actions retain their independent records',()=>{
  const a=row('a','Speak to Alex to clarify supplier responsibilities.',{reviewerAuthored:true});
  const b=row('b',a.action);
  assert.deepEqual(mergeCommitmentDuplicates([a,b]).actions,[a,b]);
});
