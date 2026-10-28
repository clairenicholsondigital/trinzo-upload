'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),JSZip=require('jszip');
const E=require('../utils/meetingMinutesParallelEngine'),P=require('../utils/meetingMinutesParallel');
const T=require('../utils/meetingMinutesTiming');
const evidence=[{id:'T0001',speaker:'Alex',timestamp:'0:01',text:'I will monitor questions on the day, throughout the session.'}];
const action=(id,timing)=>({id,action:'Monitor questions.',owners:['Alex'],timing,evidenceIds:['T0001']});
function response(timing={kind:'not_stated',wording:'on the day; throughout',exactDate:''}){
 return {schemaVersion:1,specialist:'actions',actions:[action('A1',timing)],
  actionProposals:[{...action('AP1',{kind:'not_stated',wording:'on the day',exactDate:''}),owners:[],reason:'Owner not agreed.'}],reviewFlags:[]};
}
function replies(actions){return {
 summary:{schemaVersion:1,specialist:'summary',executiveSummary:{text:'Prepare the session.',evidenceIds:['T0001']},meetingObjectives:[],reviewFlags:[]},
 discussion:{schemaVersion:1,specialist:'discussion',discussion:[],reviewFlags:[]},actions};}
function draft(){return {generationProvider:P.PROVIDER,draftId:'timing',details:{meetingTitle:'Session',meetingDate:'2026-10-28'},
 sourceUnits:evidence,discussion:[],actions:[],reviewFlags:[],qualityState:{},currentStep:0};}
test('recorded failure shapes preserve timing words neutrally without dates, source edits or provider-object mutation',()=>{
 for(const wording of ['on the day; throughout','on the day','throughout the session','when the session starts','for thirty minutes']){
  const raw=response({kind:'not_stated',wording,exactDate:''}),original=structuredClone(raw);
  const result=E.validateResult('actions',raw,evidence);
  assert.deepEqual(raw,original,'provider response is immutable');
  const expected=structuredClone(original);
  expected.actions[0].timing.kind='stated';expected.actionProposals[0].timing.kind='stated';
  assert.deepEqual(result,expected,'only the neutral kind is changed');
  assert.equal(result.actions[0].timing.exactDate,'');
 }
});
test('valid supplied dates survive the same contradictory kind without being invented, removed or shifted',()=>{
 for(const wording of ['on the day','']){
  const raw=response({kind:'not_stated',wording,exactDate:'2026-08-07'}),original=structuredClone(raw);
  const result=E.validateResult('actions',raw,evidence);
  assert.deepEqual(result.actions[0].timing,{kind:'stated',wording,exactDate:'2026-08-07'});
  assert.deepEqual(raw,original);
 }
 assert.equal(T.formatTimingLabel({kind:'stated',wording:'',exactDate:'2026-08-07'}),'Timing: 7 Aug 2026');
});
test('valid absent timing and existing deadline/target/dependency types remain unchanged',()=>{
 for(const timing of [
  {kind:'not_stated',wording:'',exactDate:''},
  {kind:'deadline',wording:'by Friday',exactDate:'2026-10-30'},
  {kind:'target',wording:'aiming for Friday',exactDate:''},
  {kind:'dependency',wording:'once approval arrives',exactDate:''},
  {kind:'stated',wording:'throughout the session',exactDate:''}
 ]){
  const raw=response(timing);raw.actionProposals=[];
  assert.deepEqual(E.validateResult('actions',raw,evidence),raw);
 }
});
test('malformed timing and contradictory calendar dates still fail instead of being erased or guessed',()=>{
 for(const timing of [
  {kind:'not_stated',wording:'on the day',exactDate:'not a date'},
  {kind:'not_stated',wording:'',exactDate:'2026-13-01'},
  {kind:'not_stated',wording:'on the day',exactDate:'2026-02-30'},
  {kind:'not_stated',wording:'on the day',exactDate:123},
  {kind:'not_stated',wording:[],exactDate:''},
  {kind:'unknown',wording:'on the day',exactDate:''},
  {kind:'stated',wording:'',exactDate:''},
  {kind:'not_stated',wording:' ',exactDate:''},null
 ]){
  assert.throws(()=>E.validateResult('actions',response(timing),evidence),e=>['INVALID_TIMING','INVALID_DATE'].includes(e.code));
 }
});
test('timing compatibility does not bypass JSON, evidence, ownership, record or required-array validation',()=>{
 const mutations=[
  r=>{r.actions[0].evidenceIds=['UNKNOWN'];},
  r=>{r.actions[0].evidenceIds=[];},
  r=>{r.actions[0].owners='Alex';},
  r=>{r.actions[0].action='';},
  r=>{delete r.actionProposals;},
  r=>{r.actionProposals[0].reason='';}
 ];
 for(const mutate of mutations){const raw=response();mutate(raw);assert.throws(()=>E.validateResult('actions',raw,evidence));}
 assert.throws(()=>E.decodeReply('not json'),e=>e.code==='INVALID_JSON');
});
test('the same three-call engine completes the previously rejected contract and records compatibility provenance',async()=>{
 const raw=response(),values=replies(raw),requests=[];
 const result=await E.runSpecialists(P.packet(draft()),Object.fromEntries(E.STAGES.map(s=>[s,{webhookUrl:'https://'+s+'.example.invalid'}])),{
  fetchImpl:async(url,init)=>{const stage=new URL(url).hostname.split('.')[0];requests.push(init.body);return {ok:true,text:async()=>JSON.stringify(values[stage])};}
 });
 assert.equal(requests.length,3);assert.equal(new Set(requests).size,1);
 assert.equal(result.status,'completed');
 assert.deepEqual(result.branches.actions.timingCompatibility,{version:1,records:[
  {collection:'actions',id:'A1',from:'not_stated',to:'stated'},
  {collection:'actionProposals',id:'AP1',from:'not_stated',to:'stated'}
 ]});
 const changes=P.resultChanges(draft(),result);
 assert.equal(changes.actions[0].timing.kind,'stated');
 assert.equal(changes.parallelActionProposals[0].timing.kind,'stated');
 assert.equal(raw.actions[0].timing.kind,'not_stated');
 const edited=P.reviewChanges({...draft(),...changes},{actions:changes.actions});
 assert.equal(edited.actions[0].timing.wording,'on the day; throughout');
 assert.equal(P.publicDraft({...draft(),...changes}).actions[0].timing.kind,'stated');
});
test('neutral timing survives editor normalisation and Word labels without becoming a target or a date',async()=>{
 const timing={kind:'stated',wording:'on the day; throughout',exactDate:''};
 assert.deepEqual(T.normaliseTimingValue(timing,{mode:'preserve',reviewerAuthored:true}),timing);
 assert.equal(T.formatTimingLabel(timing),'Timing: on the day; throughout');
 const D=require('../utils/meetingMinutesAgentDocx');
 assert.equal(D.timingLabel(timing),'Timing: on the day; throughout');
 const document={...draft(),actions:[action('A1',timing)]};
 const xml=await (await JSZip.loadAsync(await D.generateMeetingMinutesAgentDocx(document,false))).file('word/document.xml').async('string');
 assert.ok(xml.includes('Timing: on the day; throughout'));
 assert.ok(!xml.includes('Target: on the day'));
});
