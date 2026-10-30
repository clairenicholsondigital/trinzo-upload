'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { foldLiteralParentSupportingRepeats: fold } = require('../utils/meetingMinutesSupportingDetails');
const js = fs.readFileSync(path.join(__dirname, '../public/meeting-minutes-agent.js'), 'utf8');
function between(start, end) {
  const a = js.indexOf(start), b = js.indexOf(end, a + start.length);
  assert(a >= 0 && b > a); return js.slice(a, b);
}
function client(draft = {}) {
  const context = vm.createContext({ state:{ draft }, Map, Set, Array, Number, String,
    window: { MeetingMinutesFilingOrder: require('../public/meeting-minutes-filing-order') } });
  vm.runInContext(between('  function preserveDiscussionMergeHistory(', '  function topicSupportingDetails('), context);
  vm.runInContext(between('  function findFinalDiscussionRecord(', '  function applyFinalEdit('), context);
  return context;
}
const row = (id, text, extra = {}) => ({ id, text, evidenceIds:['T1'], reviewFlagIds:[], ...extra });
const claim = 'The supplier has not attended the warehouse after about three weeks';
function fixture(detailExtra = {}, parentExtra = {}, topicExtra = {}) {
  return [{ id:'topic', topic:'Warehouse review', points:[row('parent', claim + ', and a loading panel was damaged.', {
    supportingDetails:[row('child', claim + '.', { mergedFromIds:['earlier-child'], ...detailExtra })], ...parentExtra
  })], decisions:[], openQuestions:[], ...topicExtra }];
}
test('literal parent/support repetition folds without changing the main claim or input', () => {
  const input=fixture(), before=structuredClone(input), result=fold(input), parent=result.discussion[0].points[0];
  assert.equal(result.foldedCount,1); assert.deepEqual(parent.supportingDetails,[]);
  assert.equal(parent.text,input[0].points[0].text);
  assert.deepEqual(parent.evidenceIds,['T1']);
  assert.deepEqual(parent.mergedFromIds,['child','earlier-child']);
  assert.deepEqual(input,before);
  assert.deepEqual(fold(result.discussion),{discussion:result.discussion,foldedCount:0});
});
for (const [name,extra] of [
  ['unique words',{text:claim + ' despite repeated reminders.'}],
  ['additional source',{evidenceIds:['T1','T2']}],
  ['no evidence',{evidenceIds:[]}],
  ['warning',{reviewFlagIds:['review-needed']}],
  ['descendant',{supportingDetails:[row('nested','An independent insurance review is required.')]}],
  ['reviewer text',{reviewerAuthored:true}],
  ['confirmed text',{confirmedTopic:true}],
  ['manual identity',{id:'manual-child'}],
  ['extra review metadata',{correctionNote:'Check the supplier response.'}]
]) test('retain supporting detail with '+name, () => {
  const input=fixture(extra); assert.deepEqual(fold(input),{discussion:input,foldedCount:0});
});
for (const [name,topic,parent] of [
  ['reviewer topic',{reviewerAuthored:true},{}],
  ['manual topic',{id:'manual-topic'},{}],
  ['reviewer parent',{}, {reviewerAuthored:true}],
  ['parent warning',{}, {reviewFlagIds:['parent-check']}]
]) test('respect '+name, () => {
  const input=fixture({},parent,topic); assert.deepEqual(fold(input),{discussion:input,foldedCount:0});
});
test('a qualification/negation following the claim prevents folding', () => {
  for (const tail of [', but this is unconfirmed.', ', and this was not confirmed.']) {
    const input=fixture({}, {text:claim+tail});assert.equal(fold(input).foldedCount,0);
  }
});
test('a supporting claim embedded in a question or an introductory condition is retained', () => {
  for (const text of ['If the account is correct, '+claim+'.','Did the supplier attend the warehouse?']) {
    assert.equal(fold(fixture({}, {text})).foldedCount,0);
  }
  const input=fixture();input[0].openQuestions=input[0].points;input[0].points=[];
  assert.equal(fold(input).foldedCount,0);
});
test('existing predecessor history cannot be truncated to remove a repetition', () => {
  const input=fixture({}, {mergedFromIds:Array.from({length:1000},(_,i)=>'old-'+i)});
  assert.deepEqual(fold(input),{discussion:input,foldedCount:0});
});
test('literal cleanup is wired only into the generated meeting-agent discussion boundary', () => {
  const source=fs.readFileSync(path.join(__dirname,'../routes/api.js'),'utf8');
  const discussion=fs.readFileSync(path.join(__dirname,'../utils/meetingMinutesOriginalDiscussion.js'),'utf8');
  const stages=fs.readFileSync(path.join(__dirname,'../utils/meetingMinutesOriginalStages.js'),'utf8');
  const edits=fs.readFileSync(path.join(__dirname,'../utils/meetingMinutesOriginalEdits.js'),'utf8');
  assert.match(discussion,/foldLiteralParentSupportingRepeats\(discussionFlagState.content.discussion\)/);
  assert.match(source,/const generateOriginalMinutesStage = createOriginalMinutesStages\(originalMinutesStageServices\)/);
  assert.match(stages,/const discussion = createOriginalDiscussionStage\(services\)/);
  assert.match(stages,/if \(stage === 'discussion'\) return discussion\(discovered\)/);
  assert.match(source,/return instruction \? cleanGeneratedMeetingAgentResult\(result, stage\)\s*: finishMeetingAgentGeneratedStage\(result, draft, stage\)/);
  assert.doesNotMatch(edits,/foldLiteralParentSupportingRepeats\(/);
});

test('generated unfiled rows use source order and retain backing indices without mutating the pool', () => {
  const c=client(), pool=[row('late','Late detail.',{evidenceIds:['T9']}),row('early','Early detail.',{evidenceIds:['T1']})];
  const before=structuredClone(pool);c.pool=pool;c.units=[{id:'T9',sequence:9},{id:'T1',sequence:1}];
  const entries=vm.runInContext('orderedUnassignedSupportingDetails(pool,units)',c);
  assert.deepEqual(Array.from(entries,e=>e.index),[1,0]);
  assert.equal(entries[0].detail,pool[1]);assert.deepEqual(pool,before);
});
test('manual and reviewer entries keep their slots while generated ties remain stable', () => {
  const c=client();c.pool=[row('late','Late.',{evidenceIds:['T9']}),row('manual-one','Reviewer.',{reviewerAuthored:true}),
    row('early1','Early one.',{evidenceIds:['T1']}),row('early2','Early two.',{evidenceIds:['T1']}),row('unknown','Unknown.',{evidenceIds:['missing']})];
  c.units=[{id:'T1'},{id:'T9'}];
  assert.deepEqual(Array.from(vm.runInContext('orderedUnassignedSupportingDetails(pool,units)',c),e=>e.index),[2,1,3,0,4]);
});
test('unknown or absent source positions remain stable', () => {
  const c=client();c.pool=[row('b','B.'),row('a','A.')];
  assert.deepEqual(Array.from(vm.runInContext('orderedUnassignedSupportingDetails(pool,[])',c),e=>e.index),[0,1]);
});
test('filing a retained version assigns only the new occurrence a unique identity', () => {
  const main=row('shared','The shipment passed inspection.');const detail=row('shared','The shipment passed inspection with additional qualifications.',{mergedFromIds:['older'],reviewFlagIds:['warning']});
  const draft={discussion:[{points:[main]}],unassignedSupportingDetails:[detail]}, c=client(draft);c.detail=detail;
  const filed=vm.runInContext('uniqueDiscussionDetail(detail)',c);
  assert.notEqual(filed.id,main.id);assert.equal(main.id,'shared');
  assert.deepEqual(Array.from(filed.mergedFromIds),['older','shared']);
  assert.deepEqual(filed.evidenceIds,detail.evidenceIds);assert.deepEqual(filed.reviewFlagIds,detail.reviewFlagIds);
  assert.equal(detail.id,'shared');
});
test('unique identities remain stable and already used nested/pool/DOM identities are avoided', () => {
  const detail=row('same','New occurrence.');
  const c=client({discussion:[{points:[row('same','Existing.',{supportingDetails:[row('same-occurrence-1','Nested.')]})]}],
    unassignedSupportingDetails:[detail,row('same-occurrence-2','Pool.') ]});c.detail=detail;
  assert.equal(vm.runInContext('uniqueDiscussionDetail(detail).id',c),'same-occurrence-3');
  c.detail=row('different','Unique.');assert.equal(vm.runInContext('uniqueDiscussionDetail(detail).id',c),'different');
  c.state.draft.discussion=[{points:[row('some-id','Existing DOM key.')]}];c.detail=row('some id','Another DOM key.');
  assert.notEqual(vm.runInContext('uniqueDiscussionDetail(detail).id',c),'some id');
});
test('promotion preserves nested content while assigning a collision-free occurrence', () => {
  const nested=row('nested','The independent insurance qualification remains unresolved.',{reviewFlagIds:['nested-warning']});
  const detail=row('shared','The retained version.',{supportingDetails:[nested]});
  const parent=row('parent','The main inspection outcome.',{supportingDetails:[detail]});
  const draft={discussion:[{points:[row('shared','The earlier sentence.'),parent]}],unassignedSupportingDetails:[]};
  const c=client(draft);c.promote={dataset:{topicIndex:'0',parentField:'points',itemIndex:'1',promoteSupporting:'0'}};
  vm.runInContext(between('    if(promote){','    if(moveNew){'),c);
  const promoted=draft.discussion[0].points.at(-1);
  assert.notEqual(promoted.id,'shared');assert.equal(promoted.supportingDetails[0],nested);
  assert.deepEqual(promoted.supportingDetails[0].reviewFlagIds,['nested-warning']);
  assert.deepEqual(parent.supportingDetails,[]);
});
test('collision repair preserves a full bounded predecessor history', () => {
  const detail=row('shared','Separate retained version.',{mergedFromIds:Array.from({length:1000},(_,i)=>'history-'+i)});
  const c=client({discussion:[{points:[row('shared','Earlier sentence.')]}],unassignedSupportingDetails:[detail]});c.detail=detail;
  const next=vm.runInContext('uniqueDiscussionDetail(detail)',c);
  assert.notEqual(next.id,'shared');
  assert.deepEqual(Array.from(next.mergedFromIds),detail.mergedFromIds);
});
test('a promoted occurrence cannot shadow the earlier final-editor target', () => {
  const main=row('shared','The earlier sentence.');const detail=row('shared','The separate retained version.');
  const draft={discussion:[{points:[main]}],unassignedSupportingDetails:[detail]},c=client(draft);c.detail=detail;
  const promoted=vm.runInContext('uniqueDiscussionDetail(detail)',c);draft.discussion[0].points.push(promoted);
  c.id=promoted.id;const selected=vm.runInContext('findFinalDiscussionRecord(id)',c);
  assert.equal(selected.text,detail.text);selected.text='Edited retained version.';
  assert.equal(main.text,'The earlier sentence.');
});
