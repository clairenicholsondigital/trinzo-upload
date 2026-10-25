'use strict';const test=require('node:test'),assert=require('node:assert/strict');
const U=require('../utils/meetingMinutesActionUnionRewrite'),B=require('../utils/canonicalMinutes/discussionBoundedRewrite');
const dbBoundary=require('../utils/db'),storageHandlers={get:()=>{throw Error('Unexpected DB read')},update:()=>{throw Error('Unexpected DB write')}};
const originalDbGet=dbBoundary.getMeetingMinutesAgentDraft,originalDbUpdate=dbBoundary.updateMeetingMinutesAgentDraft;
dbBoundary.getMeetingMinutesAgentDraft=(...args)=>storageHandlers.get(...args);dbBoundary.updateMeetingMinutesAgentDraft=(...args)=>storageHandlers.update(...args);
test.after(()=>{dbBoundary.getMeetingMinutesAgentDraft=originalDbGet;dbBoundary.updateMeetingMinutesAgentDraft=originalDbUpdate;});
const output='Review, document and update inspection limits and tolerances in the verification record.';
function fixture(){const units=[{id:'T0001',speaker:'Maya Patel',text:'I will review, document and update inspection limits and tolerances in the verification record.'},{id:'T0002',speaker:'Sam Jones',text:'Yes, those inspection limits and tolerances in the verification record.'}];
 const row=(id,action)=>({id,action,owners:['Maya Patel'],evidenceIds:['T0001','T0002'],reviewFlagIds:[],timing:{kind:'not_stated',wording:'',exactDate:''}});
 return {units,actions:[row('a','Review and document inspection limits and tolerances in the verification record.'),row('b','Review and update inspection limits in the verification record.')]};}
function provider(f,change=()=>{}){return async(prompt)=>{const data=JSON.parse(prompt.split('\nDATA\n').at(-1));let result,part;
 if(prompt.startsWith('ACTION_CRITIC_WORKFLOW_UNION_VERIFICATION')){part='work';result={version:U.VERSION,packetHash:data.packetHash,checks:Object.fromEntries(U.checks.map(k=>[k,true])),assignmentWitnesses:[{sourceId:'T0001',quote:f.units[0].text}]};}
 else {const c=data.candidates[0];
  // The packet hash is in the contract preceding DATA.
  const packetHash=prompt.match(/packetHash:\s*"([a-f0-9]+)"/)?.[1];
  if(prompt.includes('DISCUSSION_CRITIC_BOUNDED_REWRITE_INVENTORY')){part='inventory';result={version:B.VERSION,packetHash,results:[{id:c.id,decision:'inventory',records:c.rows.map((r,i)=>({recordId:r.recordId,claims:[{id:'claim'+i,text:r.originalText,originalQuote:r.originalText,sourceWitnesses:[{sourceId:'T0001',quote:f.units[0].text}]}]}))}]};}
  else if(prompt.includes('DISCUSSION_CRITIC_BOUNDED_REWRITE_PROPOSAL')){part='proposal';result={version:B.VERSION,packetHash,results:[{id:c.id,decision:'rewrite',text:output}]};}
  else {part='verification';result={version:B.VERSION,packetHash,results:[{id:c.id,selectionHash:c.selectionHash,claimChecks:c.inventory.flatMap(r=>r.claims.map(cl=>({claimId:cl.id,supported:true,retained:true,outputQuote:c.text,sourceWitnesses:[{sourceId:'T0001',quote:f.units[0].text}]}))),originalChecks:c.rows.flatMap(r=>r.sentences.map((_,i)=>({recordId:r.recordId,sentenceIndex:i,allClaimsListed:true,supported:true,retained:true,sourceWitnesses:[{sourceId:'T0001',quote:f.units[0].text}]}))),outputChecks:c.outputSentences.map((_,i)=>({sentenceIndex:i,supported:true,noNewClaims:true,sourceWitnesses:[{sourceId:'T0001',quote:f.units[0].text}]}))}]};}
 }
 change(part,result);return {result:part==='work'?{results:[result]}:result};};}
const run=(f,change,extra={})=>U.rewrite(f.actions,f.units,{meetingDate:'2026-10-25',ask:provider(f,change),...extra});
test('verified union retains all operations and scope, with exact receipts and restoration',async()=>{const f=fixture(),before=structuredClone(f);const r=await run(f);assert.equal(r.audit.applied,true,JSON.stringify(r.audit));assert.equal(r.actions.length,1);assert.equal(r.actions[0].action,output);assert.equal(r.audit.calls,4);assert.deepEqual(U.restore(r.actions,r.audit,f.units),f.actions);assert.deepEqual(f,before);for(const a of f.actions)assert.ok(U.valid(r.audit.receipts[0],a,r.actions[0],f.units));const api=require('../routes/api').stagedEvaluation;assert.equal(api.reconcileFinalApprovedActions(r.actions,f.actions,{unionReceipts:r.audit.receipts,sourceUnits:f.units}).restored.length,0);});
for(const [label,part,change]of[
 ['missing original','inventory',r=>r.results[0].records.pop()],['invented source','inventory',r=>r.results[0].records[0].claims[0].sourceWitnesses[0].quote='not in source'],
 ['lost operation','verification',r=>r.results[0].claimChecks[0].retained=false],['unsupported original','verification',r=>r.results[0].originalChecks[0].supported=false],
 ['new assertion','verification',r=>r.results[0].outputChecks[0].noNewClaims=false],['distinct events','work',r=>r.checks.sameWorkEvent=false],
 ['wrong owner','work',r=>r.checks.sameOwners=false],['no acceptance','work',r=>r.checks.explicitOutstandingWork=false],
 ['foreign assignment','work',r=>r.assignmentWitnesses[0].sourceId='unknown']
])test(label+' preserves both originals',async()=>{const f=fixture(),r=await run(f,(p,response)=>{if(p===part)change(response);});assert.equal(r.audit.applied,false);assert.deepEqual(r.actions,f.actions);assert.equal(r.audit.receipts.length,0);});
for(const [label,change]of[
 ['different owner',f=>f.actions[1].owners=['Sam Jones']],['manual row',f=>f.actions[1].reviewerAuthored=true],
 ['warning',f=>f.actions[1].reviewFlagIds=['warn']],['dated work',f=>f.actions[1].timing={kind:'target',wording:'next week',exactDate:''}],
 ['rejected timing history',f=>f.actions[1].timingDecision={status:'rejected',rejectedWordings:['Friday']}],
 ['unknown fields',f=>f.actions[1].privateNote='keep'],['duplicate identities',f=>f.actions[1].id='a'],['different recipients',f=>{f.actions[0].action+=' Send it to Jo.';f.actions[1].action+=' Send it to Lee.';}]
])test(label+' is outside automatic nomination',()=>{const f=fixture();change(f);assert.equal(U.prepare(f.actions,f.units,'2026-10-25'),null);});
test('proofs bind source, date, original metadata and final occurrence, and rebind only identity changes',async()=>{const f=fixture(),r=await run(f),p=r.audit.receipts[0],a=r.actions[0];assert.ok(p);for(const changed of [{...a,action:a.action+' Extra.'},{...a,owners:['Sam Jones']},{...a,reviewFlagIds:['new']}])assert.equal(U.valid(p,f.actions[0],changed,f.units),false);assert.equal(U.valid(p,f.actions[0],a,[...f.units,{id:'T3',speaker:'Sam Jones',text:'Changed.'}]),false);assert.equal(U.valid(p,f.actions[0],a,f.units,'2026-10-26'),false);assert.equal(U.valid(p,{...f.actions[0],id:'another-occurrence'},a,f.units),false);const allocated={...a,id:'new-id',occurrenceId:'action-occurrence-new'};const bound=U.rebind(p,a,allocated,f.units);assert.ok(U.valid(bound,f.actions[0],allocated,f.units));assert.equal(U.rebind(p,a,{...allocated,action:'Review something else.'},f.units),null);});
test('provider failure and protected occurrences preserve original work',async()=>{const f=fixture();const r=await U.rewrite(f.actions,f.units,{ask:async()=>{throw Error('unavailable')}});assert.deepEqual(r.actions,f.actions);const protectedRows=f.actions.map(a=>({...a,occurrenceId:'protected'}));assert.equal(U.prepare(protectedRows,f.units,'', ['protected']),null);});
test('generation admission, unchanged owned save and public serialization retain the verified union without accepting client proof injection',async()=>{
 const A=require('../routes/api').stagedEvaluation,router=require('../routes/api'),V=require('../utils/meetingMinutesAgentV2'),db=require('../utils/db');
 const f=fixture(),units=V.normaliseSourceUnits(f.units);f.units=units;
 const originalFlag=process.env.MEETING_MINUTES_AGENT_WORKFLOW_UNION_V1;process.env.MEETING_MINUTES_AGENT_WORKFLOW_UNION_V1='1';
 const draft=V.migrateDraftPayload({details:{meetingTitle:'Verification review',meetingType:'General',meetingDate:'2026-10-25',internalAttendees:['Maya Patel','Sam Jones']},sourceUnits:units,actions:[],discussion:[],reviewFlags:[],qualityState:{preparation:{dateContext:{source:'reviewer',meetingDate:'2026-10-25'}}}});
 const oldGet=storageHandlers.get,oldUpdate=storageHandlers.update;
 try{
  const generated=await A.finishMeetingAgentGeneratedStage({changes:{actions:f.actions},reviewFlags:[]},draft,'actions',{unionAsk:provider(f)});
  assert.equal(generated.changes.actions.length,1,JSON.stringify(generated.changes.qualityState.actions.actionUnionRewrite));
  const admitted=A.admitMeetingAgentGeneratedActionChanges(draft,generated.changes,'union-test');
  let stored={...A.meetingAgentDraftPayload({...draft,...admitted}),draftId:'union-save',revision:1};
  let receipt=stored.qualityState.actions.actionUnionRewrite.receipts[0];assert.ok(U.valid(receipt,f.actions[0],stored.actions[0],stored.sourceUnits,'2026-10-25'));
  const pub=A.publicMeetingAgentDraft(stored);assert.equal(pub.qualityState,undefined);assert.equal(pub.actions.length,1);
  storageHandlers.get=async()=>structuredClone(stored);storageHandlers.update=async(_id,_user,_revision,changes)=>{stored={...A.meetingAgentDraftPayload(changes.payload),draftId:'union-save',revision:stored.revision+1};return stored;};
  const route=router.stack.find(x=>x.route?.path==='/meeting-minutes-agent/drafts/:draftId'&&x.route.methods.patch).route;
  const res={statusCode:200,status(c){this.statusCode=c;return this;},json(body){this.body=body;return this;}};
  await route.stack.at(-1).handle({params:{draftId:stored.draftId},authUser:{userId:'reviewer'},body:{revision:1,actions:pub.actions,qualityState:{actions:{actionUnionRewrite:{applied:true,receipts:[]}}}}},res);
  assert.equal(res.statusCode,200,JSON.stringify(res.body));assert.equal(stored.actions.length,1);assert.equal(stored.actions[0].action,output);
  receipt=stored.qualityState.actions.actionUnionRewrite.receipts[0];assert.ok(U.valid(receipt,f.actions[0],stored.actions[0],stored.sourceUnits,'2026-10-25'));
  const invalid=A.admitMeetingAgentGeneratedActionChanges({...draft,sourceUnits:[...units,{id:'T3',speaker:'Sam Jones',text:'A different source version.'}]},generated.changes,'changed-source');
  assert.equal(invalid.actions.length,2);assert.equal(invalid.qualityState.actions.actionUnionRewrite.applied,false);
 }finally{storageHandlers.get=oldGet;storageHandlers.update=oldUpdate;if(originalFlag===undefined)delete process.env.MEETING_MINUTES_AGENT_WORKFLOW_UNION_V1;else process.env.MEETING_MINUTES_AGENT_WORKFLOW_UNION_V1=originalFlag;}
});
test('even unanimous model approvals cannot introduce editing instructions or new work vocabulary',async()=>{const f=fixture(),r=await run(f,(part,response)=>{if(part==='proposal')response.results[0].text='Review for a rewrite, document and update inspection limits and tolerances in the verification record.';});assert.equal(r.audit.applied,false);assert.deepEqual(r.actions,f.actions);});
test('claim labels are record-scoped, but ambiguous duplicates within an original record are rejected',async()=>{const f=fixture(),r=await run(f,(part,response)=>{if(part==='inventory')for(const record of response.results[0].records)record.claims[0].id='c1';});assert.equal(r.audit.applied,true);const rejected=await run(f,(part,response)=>{if(part==='inventory')response.results[0].records[0].claims.push(structuredClone(response.results[0].records[0].claims[0]));});assert.equal(rejected.audit.applied,false);});
test('stored JSON object-key order cannot invalidate source-bound receipts',async()=>{const f=fixture(),r=await run(f),reverse=v=>Array.isArray(v)?v.map(reverse):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).reverse().map(([k,x])=>[k,reverse(x)])):v;assert.ok(U.valid(reverse(r.audit.receipts[0]),reverse(f.actions[0]),reverse(r.actions[0]),reverse(f.units),'2026-10-25'));});
test('approved alternatives cannot replace two mandatory operations',async()=>{const f=fixture(),r=await run(f,(part,response)=>{if(part==='proposal')response.results[0].text='Review and document or update inspection limits and tolerances in the verification record.';});assert.equal(r.audit.applied,false);assert.deepEqual(r.actions,f.actions);});
test('conditional or alternative review workflows remain outside this bounded class',()=>{for(const tail of [' if approved.',' after inspection.',' or record a summary.']){const f=fixture();f.actions[1].action+=tail;assert.equal(U.prepare(f.actions,f.units,''),null);}});
test('independent discoveries cannot use matching local IDs to concatenate or suppress separate scope',()=>{
 const A=require('../routes/api').stagedEvaluation,f=fixture();
 const first={...f.actions[0],id:'A1'},second={...f.actions[1],id:'A1'};
 const r=A.unionActionDiscoveryResults({actions:[first]},{actions:[second]});
 assert.equal(r.actions.length,2);assert.deepEqual(r.actions.map(a=>a.action),[first.action,second.action]);
 const identical=A.unionActionDiscoveryResults({actions:[first]},{actions:[structuredClone(first)]});assert.equal(identical.actions.length,1);
});
