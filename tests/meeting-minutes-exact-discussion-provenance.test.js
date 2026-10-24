'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { carryExactDiscussionProvenance: carry } = require('../utils/meetingMinutesExactDiscussionProvenance');
const { discussionPublicationCoverage } = require('../utils/meetingMinutesDiscussionCoverage');
const row = (id, extra = {}) => ({id, text:'The filter replacement was approved.', evidenceIds:['T0001'], supportingDetails:[], ...extra});
const topic = points => [{id:'topic',topic:'Filter',points,decisions:[],openQuestions:[]}];
test('exact compatible duplicates retain accepted identity without changing prose or sources', () => {
  const before=topic([row('primary'),row('recovery')]), after=topic([row('recovery')]);
  const saved=structuredClone({before,after}), actual=carry(before,after);
  assert.deepEqual(actual[0].points[0].mergedFromIds,['primary']);
  assert.deepEqual({...actual[0].points[0],mergedFromIds:undefined},{...after[0].points[0],mergedFromIds:undefined});
  assert.deepEqual({before,after},saved);
  const audit=discussionPublicationCoverage(actual,[{candidateId:'primary',disposition:'core'},{candidateId:'recovery',disposition:'core'}]);
  assert.equal(audit.complete,true); assert.equal(audit.visibleCoreTargetCount,2);
});
for(const [name,change] of [
  ['changed qualification',(b,a)=>{a[0].points[0].text+=' Probably.';}],
  ['missing source',(b,a)=>{b[0].points[0].evidenceIds.push('T0002');}],
  ['invalid primary source',(b,a)=>{b[0].points[0].primaryEvidenceIds=['T0002'];}],
  ['missing warning',(b,a)=>{b[0].points[0].reviewFlagIds=['warning'];}],
  ['reviewer',(b,a)=>{b[0].points[0].reviewerAuthored=true;}],
  ['unknown metadata',(b,a)=>{b[0].points[0].notes='keep';}],
  ['ambiguous survivor',(b,a)=>{a[0].points.push(row('other'));}],
  ['duplicate input identity',(b,a)=>{b[0].points.push(row('primary'));}],
  ['different record kind',(b,a)=>{a[0].decisions=a[0].points;a[0].points=[];}],
  ['live predecessor elsewhere',(b,a)=>{a[0].openQuestions=[row('primary')];}],
  ['existing conflicting alias',(b,a)=>{a[0].points.push(row('other',{text:'A different matter.',mergedFromIds:['primary']}));}],
  ['child tree',(b,a)=>{b[0].points[0].supportingDetails=[row('child')];}],
  ['history overflow',(b,a)=>{a[0].points[0].mergedFromIds=Array.from({length:1000},(_,i)=>'prior-'+i);}]
]) test('no new coverage for '+name,()=>{
  const b=topic([row('primary')]),a=topic([row('recovery')]);change(b,a);
  const actual=carry(b,a);assert.deepEqual(actual,a);
});
test('a historical approximate alias cannot become an exact-claim proof',()=>{
  const actual=carry(topic([row('primary',{mergedFromIds:['unproved']})]),topic([row('recovery')]));
  assert.deepEqual(actual[0].points[0].mergedFromIds,['primary']);
});
test('surviving generated children and primary ownership are kept unchanged',()=>{
  const b=topic([row('primary',{primaryEvidenceIds:['T0001']})]);
  const a=topic([row('recovery',{supportingDetails:[row('child',{originalTopic:'Filter detail'})]})]);
  const actual=carry(b,a);
  assert.deepEqual(actual[0].points[0].supportingDetails,a[0].points[0].supportingDetails);
  assert.equal(actual[0].points[0].primaryEvidenceIds,undefined);
  assert.deepEqual(actual[0].points[0].mergedFromIds,['primary']);
});
