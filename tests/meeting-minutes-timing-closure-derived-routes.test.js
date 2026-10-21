'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const V=require('../utils/meetingMinutesAgentV2');
const api=require('../routes/api').stagedEvaluation;
const units=rows=>V.normaliseSourceUnits(rows.map(([speaker,text])=>({speaker,text})));
function visit(offer) {
  const source=units([['Chair','Could someone visit the storage yard?'],['Morgan',offer],['Chair','Check the gate hinge and latch.']]);
  return api.acceptedVisitAssignmentActions(source,[]);
}
function deferred(rows) {
  const source=units(rows);
  const thread={candidateId:'pending',recordType:'action_thread',sourcePass:'deterministic',evidenceIds:source.map(row=>row.id),focusEvidenceId:source.at(-1).id,cueKinds:['commitment','decision_resolution'],dispositionHint:'conditional_commitment',priority:12,sequence:1};
  return api.commitmentThreadBackstopProposals([thread],[],source);
}

test('accepted visits cannot inherit a separate photograph or other work date',()=>{
  for(const offer of ['I can go. I will take a photograph tomorrow.','I can go and I will paint the marker Friday.','I can go; Casey will take a photograph tomorrow.']){
    const out=visit(offer);
    assert.equal(out.length,1,offer);
    assert.equal(out[0].timing.kind,'not_stated',offer);
    assert.deepEqual(out[0].owners,['Morgan']);
  }
});

test('accepted visits keep their own weekday, qualified period and bounds',()=>{
  for(const [offer,wording]of[['I can go tomorrow.','tomorrow'],['I could go Thursday.','Thursday'],['I can go probably next week.','probably next week'],['I can go by Friday.','by Friday'],['I can go Friday if possible.','Friday if possible']]){
    const out=visit(offer);
    assert.equal(out.length,1,offer);
    assert.equal(out[0].timing.wording,wording,offer);
    assert.equal(out[0].timing.exactDate,'');
  }
});

test('an ambiguous compound visit timing is withheld rather than trimmed into a firmer date',()=>{
  const out=visit('I can go Friday after I have collected the keys.');
  assert.equal(out.length,1);
  assert.ok(out[0].timing.kind==='not_stated'||/after I have collected the keys/i.test(out[0].timing.wording));
});

test('deferred proposals do not borrow unrelated earlier dates from another actor or the same owner',()=>{
  for(const speaker of ['Casey','Morgan']){
    const out=deferred([[speaker,'I will paint the garage Friday.'],['Chair','Can you share the pump specifications?'],['Morgan','I will know once I have checked the catalogue.']]);
    assert.equal(out.length,1);
    assert.doesNotMatch(out[0].timing.wording,/Friday/);
    assert.doesNotMatch(out[0].action,/Friday/);
    assert.deepEqual(out[0].owners,['Morgan']);
  }
});

test('deferred proposals cannot borrow a later separate task date in the answer row',()=>{
  const out=deferred([['Chair','Can you share the pump specifications?'],['Morgan','I will know once I have checked the catalogue. I will paint the garage Friday.']]);
  assert.equal(out.length,1);
  assert.doesNotMatch(out[0].timing.wording,/Friday/);
});

test('a deferred answer preserves its own explicit temporal relation and no invented calendar day',()=>{
  for(const [answer,expected] of [['I will know after the review Wednesday.','after the review Wednesday'],["I will know after Wednesday's review.","after Wednesday's review"],['I will know before the review Wednesday.','before the review Wednesday'],['I will know on Wednesday.','on Wednesday'],['I will know by Wednesday.','by Wednesday']]){
    const out=deferred([['Chair','Can you share the pump specifications?'],['Morgan',answer]]);
    assert.equal(out.length,1,answer);
    assert.equal(out[0].timing.wording.toLowerCase(),expected.toLowerCase(),answer);
    assert.equal(out[0].timing.exactDate,'');
  }
});

test('an implicit knowledge event preserves the proposal without inventing a confirmation deadline',()=>{
  const out=deferred([['Chair','Can you share the pump specifications?'],['Morgan',"I have a supplier meeting on Wednesday, so I'll know more then."]]);
  assert.equal(out.length,1);
  assert.deepEqual(out[0].timing,{kind:'not_stated',wording:'',exactDate:''});
  assert.deepEqual(out[0].evidenceIds,['T0001','T0002']);
  assert.deepEqual(out[0].owners,['Morgan']);
});

test('a different actor event or separate same-owner event cannot establish an implicit knowledge date',()=>{
  for(const answer of ["Casey has a supplier meeting Wednesday, so I'll know more then.","I have a supplier meeting Wednesday. I will know once I check the catalogue.","I will paint the garage Wednesday, so I'll know more then."]){
    const out=deferred([['Chair','Can you share the pump specifications?'],['Morgan',answer]]);
    assert.equal(out.length,1,answer);
    assert.doesNotMatch(out[0].timing.wording,/Wednesday/);
  }
});


test('lowercase and curly-contraction source boundaries do not donate a different task date',()=>{
  for(const text of ['i can go and i will take a photograph tomorrow.','I can go and I’ll take a photograph tomorrow.']) assert.equal(visit(text)[0].timing.kind,'not_stated');
  for(const text of ['i will know once i have checked the catalogue and i will paint the garage friday.','I’ll know once I have checked the catalogue and Casey will paint the garage Friday.','I will know once I have checked the catalogue and I need to paint the garage Friday.','I will know once I have checked the catalogue and I am going to paint the garage Friday.']){
    const out=deferred([['Chair','Can you share the pump specifications?'],['Morgan',text]]);
    assert.equal(out.length,1,text);
    assert.doesNotMatch(out[0].timing.wording,/friday/i);
  }
});


test('own visit timing survives source-bound destinations and deictic locations',()=>{
  for(const [offer,wording] of [['I can go down there tomorrow.','tomorrow'],['I can visit the storage yard Thursday.','Thursday'],['I can visit the yard Thursday.','Thursday'],['I can go there probably next week.','probably next week'],['I can go down there by Friday if possible.','by Friday if possible'],['I can go tomorrow to the storage yard.','tomorrow']]) assert.equal(visit(offer)[0].timing.wording,wording,offer);
  for(const offer of ['I can visit the packing room Thursday.','I can go to the old yard Friday.','I can go there and take a photograph tomorrow.']) assert.equal(visit(offer)[0].timing.kind,'not_stated',offer);
});

test('a deferred dependency tail cannot carry a separate coordinate obligation date',()=>{
  for(const answer of ['I will know after checking the catalogue and will paint the garage Friday.','I will know after checking the catalogue, then paint the garage Friday.','I will know after checking the catalogue and I want to paint the garage Friday.']){
    const out=deferred([['Chair','Can you share the pump specifications?'],['Morgan',answer]]);
    assert.equal(out.length,1,answer);
    assert.equal(out[0].timing.kind,'not_stated',answer);
    assert.doesNotMatch(out[0].action,/Friday/);
  }
  const positive=deferred([['Chair','Can you share the pump specifications?'],['Morgan','I will know after the catalogue review and approval.']]);
  assert.match(positive[0].timing.wording,/review and approval/i);
});
