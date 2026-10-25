'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),JSZip=require('jszip');
const V=require('../utils/meetingMinutesAgentV2'),C=require('../utils/canonicalMinutes/discussionClaimConsolidation');
const M=require('../utils/canonicalMinutes/discussionMainPointCoverage'),P=require('../utils/canonicalMinutes/discussionPointDecisionCoverage');
const {generateMeetingMinutesAgentDocx}=require('../utils/meetingMinutesAgentDocx');
process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1='0';
const db=require('../utils/db'),oldGet=db.getMeetingMinutesAgentDraft,oldUpdate=db.updateMeetingMinutesAgentDraft;
const copy=value=>structuredClone(value);let saved,originals,writes;
db.getMeetingMinutesAgentDraft=async(id,user)=>id===saved.draftId&&user==='coverage-reviewer'?copy(saved):null;
db.updateMeetingMinutesAgentDraft=async(id,user,revision,changes)=>{
 assert.equal(id,saved.draftId);assert.equal(user,'coverage-reviewer');assert.equal(revision,saved.revision);
 saved={...V.migrateDraftPayload(copy(changes.payload)),draftId:id,revision:revision+1,status:'draft'};writes++;return copy(saved);
};
const router=require('../routes/api'),api=router.stagedEvaluation;
test.after(()=>{db.getMeetingMinutesAgentDraft=oldGet;db.updateMeetingMinutesAgentDraft=oldUpdate;});
async function reset(mode){
 const row=(id,text)=>({id,text,evidenceIds:['T0001'],primaryEvidenceIds:['T0001'],reviewFlagIds:[],supportingDetails:[]});
 let sources,result;
 if(mode==='main'){
  const full='The core issue is overloaded storage racks; the paint proposal does not address the problem.';
  sources=V.normaliseSourceUnits([{id:'T0001',speaker:'Chair',text:'The core issue is overloaded storage racks.'},{id:'T0002',speaker:'Chair',text:full}]);
  originals=[{id:'topic',topic:'Storage',points:[row('full',full),row('short','The core issue is overloaded storage racks.')],decisions:[],openQuestions:[]}];
  const witnesses=[{sourceId:'T0002',quote:full}];
  result=await M.consolidate(originals,sources,{
   inventory:async(_,p)=>({version:M.VERSION,packetHash:p.packetHash,results:p.candidates.map(c=>({id:c.id,decision:'covered',claims:[{id:'claim',text:c.original.text,originalQuote:c.original.text,survivorSpanIndex:0,sourceWitnesses:witnesses}]}))}),
   verify:async(_,p,selected)=>({version:M.VERSION,packetHash:p.packetHash,results:selected.map(c=>({id:c.id,survivorSupported:true,survivorWitnesses:witnesses,sameOccurrence:true,noContradiction:true,claimChecks:[{claimId:'claim',supported:true,retained:true,survivorSpanIndex:0,sourceWitnesses:witnesses}],sentenceChecks:[{sentenceIndex:0,allClaimsListed:true,supported:true,retained:true,survivorSpanIndex:0,sourceWitnesses:witnesses}]}))})});
 }else{
  sources=V.normaliseSourceUnits([{id:'T0001',speaker:'Chair',text:'The committee approved the onboarding policy for suppliers.'}]);
  originals=[{id:'topic',topic:'Onboarding',points:[row('point','Supplier policy was approved.')],decisions:[row('decision',sources[0].text)],openQuestions:[]}];
  result=await P.consolidate(originals,sources,{encode:async values=>values.map(()=>[1,0]),
   assess:async(_,p)=>({version:C.VERSION,packetHash:p.packetHash,results:p.candidates.map(c=>({id:c.id,relation:'covered',survivorId:'decision'}))}),
   verify:async(_,p,selected)=>({version:C.VERSION,packetHash:p.packetHash,results:selected.map(c=>({id:c.id,survivorId:'decision',checks:c.rows.flatMap(r=>r.clauses.map((_,clauseIndex)=>({recordId:r.record.id,clauseIndex,supported:true,retained:true,sourceIds:['T0001']})))}))})});
 }
 assert.equal(result.audit.applied,true,result.audit.reason);
 saved={draftId:'coverage-draft',revision:1,status:'draft',details:{meetingTitle:'Coverage review',meetingType:'General',meetingDate:'2026-10-21',internalAttendees:['Chair']},
  sourceUnits:sources,preparedTranscript:V.preparedTranscriptFromUnits(sources),discussion:result.discussion,actions:[],reviewFlags:[],unassignedSupportingDetails:[],meetingObjectives:[],executiveSummary:'',currentStep:2,selectedStep:2,staleStages:[],changeHistory:[],redoHistory:[],qualityState:{preparation:{dateContext:{meetingDate:'2026-10-21',source:'reviewer'}},discussion:{claimConsolidation:result.audit}}};
 saved={...api.meetingAgentDraftPayload(saved),draftId:saved.draftId,revision:1,status:'draft'};writes=0;
}
async function request(method,suffix='',body={},userId='coverage-reviewer'){
 const route=router.stack.find(layer=>layer.route?.path==='/meeting-minutes-agent/drafts/:draftId'+suffix&&layer.route.methods[method])?.route;assert.ok(route);
 const res={statusCode:200,status(code){this.statusCode=code;return this;},json(value){this.body=value;return this;}};
 await route.stack.at(-1).handle({params:{draftId:saved.draftId},authUser:{userId},body:{revision:saved.revision,...body}},res);return res;
}
for(const mode of ['main','point-decision']){
 test(mode+': private proof and exact source allocation survive real owned PATCH/GET and Word/PDF projections',async()=>{
  await reset(mode);const archive=copy(saved.qualityState.discussion.claimConsolidation),initial=copy(saved.discussion);
  assert.equal(C.canRestore(saved.discussion,saved.sourceUnits,archive),true);
  const before=(await request('get')).body.draft;assert.equal(before.qualityState,undefined);assert.equal(before.canRestoreCombinedDiscussion,true);
  assert.equal((await request('patch','',{discussion:before.discussion,actions:[]})).statusCode,200);
  const after=(await request('get')).body.draft;assert.deepEqual(after.discussion,initial);assert.equal(after.canRestoreCombinedDiscussion,true);
  assert.deepEqual(saved.qualityState.discussion.claimConsolidation,archive);
  if(mode==='main')assert.deepEqual(after.discussion[0].points[0].evidenceIds,['T0001','T0002']);
  const survivor=mode==='main'?initial[0].points[0]:initial[0].decisions[0];
  for(const includeEvidence of [false,true]){
   const doc=await generateMeetingMinutesAgentDocx(after,includeEvidence),zip=await JSZip.loadAsync(doc),xml=await zip.file('word/document.xml').async('string');
   assert.ok(xml.includes(survivor.text));
   const pdf=api.meetingAgentDraftForPdf(after,includeEvidence);assert.ok(JSON.stringify(pdf.discussion).includes(survivor.text));
  }
 });
 test(mode+': owned restoration recovers every original row and citation; revision/account/generation checks remain intact',async()=>{
  await reset(mode);assert.equal((await request('post','/restore-combined-discussion',{revision:0})).statusCode,409);
  assert.equal((await request('post','/restore-combined-discussion',{},'someone-else')).statusCode,404);
  saved.generation={status:'running',stage:'actions'};assert.equal((await request('post','/restore-combined-discussion')).statusCode,409);delete saved.generation;
  assert.equal((await request('post','/restore-combined-discussion')).statusCode,200);assert.deepEqual(saved.discussion,originals);
  assert.equal(saved.changeHistory.at(-1).label,'Restore combined paragraphs');assert.equal(writes,1);
 });
 test(mode+': reviewer edits keep their content and invalidate automatic restoration',async()=>{
  await reset(mode);const before=(await request('get')).body.draft,row=mode==='main'?before.discussion[0].points[0]:before.discussion[0].decisions[0];row.text+=' Reviewer qualification.';
  assert.equal((await request('patch','',{discussion:before.discussion})).statusCode,200);
  const after=(await request('get')).body.draft;assert.equal(after.canRestoreCombinedDiscussion,false);assert.ok(JSON.stringify(after.discussion).includes('Reviewer qualification.'));
  assert.equal((await request('post','/restore-combined-discussion')).statusCode,409);
 });
}
