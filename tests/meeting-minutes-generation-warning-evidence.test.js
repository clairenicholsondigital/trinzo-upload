'use strict';
process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1='0';
const test=require('node:test'),assert=require('node:assert/strict');
const A=require('../routes/api').stagedEvaluation,V=require('../utils/meetingMinutesAgentV2');
const units=V.normaliseSourceUnits([{id:'T0001',speaker:'Morgan Lee',text:'Review the inspection report.'},
 {id:'T0002',speaker:'Morgan Lee',text:'Send the supplier statement.'}]);
const flag=(id,evidenceIds=['T0001'],extra={})=>V.normaliseFlag({id,kind:'ownership',message:'Confirm the owner of this action.',evidenceIds,status:'open',...extra});
const action=(id,evidenceIds,flagId)=>({id,action:id==='inspection'?'Review the inspection report.':'Send the supplier statement.',owners:['Morgan Lee'],
 timing:{kind:'not_stated',wording:'',exactDate:''},evidenceIds,reviewFlagIds:[flagId]});
const base=()=>({draftId:'warning-evidence',revision:1,sourceUnits:units,actions:[],discussion:[],reviewFlags:[],qualityState:{},changeHistory:[],redoHistory:[],staleStages:[]});

for(const reverse of [false,true])test('background generation preserves same-message warning identities and evidence '+reverse,async()=>{
 const actions=[action('inspection',['T0001'],'f1'),action('supplier',['T0002'],'f2')],flags=[flag('f1',['T0001']),flag('f2',['T0002'])];
 let saved={...base(),actions,reviewFlags:reverse?[...flags].reverse():flags};
 for(let pass=0;pass<2;pass++){
  await A.persistMeetingAgentBackgroundStage({draftId:saved.draftId,userId:1,stage:'actions',sourceDraft:structuredClone(saved),
   result:{changes:{actions:structuredClone(saved.actions)},reviewFlags:reverse?[...flags].reverse():flags},wait:async()=>{},getDraft:async()=>structuredClone(saved),
   saveDraft:async(fresh,changes)=>{saved=JSON.parse(JSON.stringify({...fresh,...changes,revision:fresh.revision+1}));return structuredClone(saved);}});
  assert.equal(saved.reviewFlags.length,2);
  for(const input of flags)assert.deepEqual(saved.reviewFlags.find(f=>f.id===input.id),input);
  for(const a of saved.actions)for(const id of a.reviewFlagIds)assert.ok(saved.reviewFlags.some(f=>f.id===id));
  assert.equal(A.publicMeetingAgentDraft(A.meetingAgentDraftPayload(saved)).reviewFlags.length,2);
 }
});

test('summary persistence retains warning links on nested discussion and pending proposal records',()=>{
 const f=base();f.discussion=[{topic:'Equipment',points:[{text:'Inspection',supportingDetails:[{text:'Check the report.',reviewFlagIds:['f1']}]}]}];
 f.pendingProposal={stage:'actions',changes:[{id:'p1',type:'add',after:action('supplier',['T0001'],'f2')}]};f.reviewFlags=[flag('f1'),flag('f2')];
 const out=A.meetingAgentRegenerationChanges(f,'summary',{executiveSummary:'Review outstanding work.'},{});
 assert.deepEqual(out.reviewFlags.map(f=>f.id),['f1','f2']);
});

test('unlinked warnings with different evidence or checked wording are not identical',()=>{
 for(const second of [flag('f2',['T0002']),flag('f2',['T0001'],{actionWordingAtCheck:'Send the supplier statement.'})]){
  const f={...base(),reviewFlags:[flag('f1')]};
  assert.equal(A.meetingAgentRegenerationChanges(f,'summary',{}, {reviewFlags:[second]}).reviewFlags.length,2);
 }
});

test('unlinked exact automatic duplicates still collapse while human decisions and notes remain',()=>{
 const f={...base(),reviewFlags:[flag('f1'),flag('reviewed',['T0001'],{status:'corrected',correctionNote:'Checked the recipient.'})]};
 const out=A.meetingAgentRegenerationChanges(f,'summary',{}, {reviewFlags:[flag('f2')]});
 assert.deepEqual(out.reviewFlags.map(f=>f.id),['f1','reviewed']);assert.equal(out.reviewFlags[1].correctionNote,'Checked the recipient.');
});

test('distinct referenced IDs are preserved even when their evidence and display wording match',()=>{
 const f={...base(),actions:[action('inspection',['T0001'],'f1'),action('supplier',['T0001'],'f2')],reviewFlags:[flag('f1'),flag('f2')]};
 const out=A.meetingAgentRegenerationChanges(f,'summary',{},{});assert.deepEqual(out.reviewFlags.map(f=>f.id),['f1','f2']);
});
