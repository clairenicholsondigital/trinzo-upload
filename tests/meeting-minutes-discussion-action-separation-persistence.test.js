'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),JSZip=require('jszip');
const V=require('../utils/meetingMinutesAgentV2'),C=require('../utils/canonicalMinutes/discussionClaimConsolidation'),S=require('../utils/canonicalMinutes/discussionActionSeparation');
const {fixture}=require('./fixtures/discussion-action-separation');
const {meetingAgentStagePersistenceChanges}=require('../utils/meetingMinutesStagePersistence');
const {generateMeetingMinutesAgentDocx}=require('../utils/meetingMinutesAgentDocx'),{generateStagedMinutesPdf}=require('../utils/stagedMinutesPdf');
process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1='0';
const db=require('../utils/db'),oldGet=db.getMeetingMinutesAgentDraft,oldUpdate=db.updateMeetingMinutesAgentDraft;
let saved,original,writes,expected;
db.getMeetingMinutesAgentDraft=async(id,user)=>id===saved.draftId&&user==='reviewer'?structuredClone(saved):null;
db.updateMeetingMinutesAgentDraft=async(id,user,revision,changes)=>{assert.equal(user,'reviewer');assert.equal(revision,saved.revision);saved={...V.migrateDraftPayload(structuredClone(changes.payload)),draftId:id,revision:revision+1,status:'draft'};writes++;return structuredClone(saved);};
const router=require('../routes/api'),A=router.stagedEvaluation;
test.after(()=>{db.getMeetingMinutesAgentDraft=oldGet;db.updateMeetingMinutesAgentDraft=oldUpdate;});
async function reset(paired=false){const f=paired?require('./fixtures/discussion-action-separation').pairedFixture():fixture();f.sourceUnits=V.normaliseSourceUnits(f.sourceUnits);original=structuredClone(f.discussion);
 const r=await S.separate(f.discussion,f.actions,f.sourceUnits,f.reviewFlags,f.options);assert.equal(r.audit.applied,true);expected=f.output;
 saved={draftId:'separation',revision:1,status:'draft',payloadVersion:V.PAYLOAD_VERSION,fileName:'calibration.txt',details:{meetingTitle:'Calibration',meetingType:'General',meetingDate:'2026-10-24',internalAttendees:['Morgan Taylor','Priya Shah'],clientAttendees:[]},sourceUnits:f.sourceUnits,rawTranscript:f.sourceUnits.map(s=>s.text).join(' '),preparedTranscript:V.preparedTranscriptFromUnits(f.sourceUnits),discussion:r.discussion,actions:r.actions||f.actions,reviewFlags:f.reviewFlags,meetingObjectives:[],executiveSummary:'',currentStep:3,selectedStep:3,staleStages:[],changeHistory:[],redoHistory:[],unassignedSupportingDetails:[],qualityState:{preparation:{dateContext:{meetingDate:'2026-10-24',source:'reviewer'}},discussion:{claimConsolidation:S.combine({discussion:f.discussion,audit:{applied:false}},r,f.sourceUnits).audit,topicArrangementVersion:1}}};writes=0;}
async function request(method,suffix='',body={},user='reviewer'){const route=router.stack.find(x=>x.route?.path==='/meeting-minutes-agent/drafts/:draftId'+suffix&&x.route.methods[method])?.route;assert.ok(route);const res={statusCode:200,status(c){this.statusCode=c;return this;},json(body){this.body=body;return this;}};await route.stack.at(-1).handle({params:{draftId:saved.draftId},authUser:{userId:user},body:{revision:saved.revision,...body}},res);return res;}
test('actual owned save/reopen preserves question, unchanged warning and recovery; request cannot forge proof',async()=>{
 await reset();const before=structuredClone(saved),pub=(await request('get')).body.draft;assert.equal(pub.canRestoreCombinedDiscussion,true);assert.equal(pub.qualityState,undefined);
 assert.equal((await request('patch','',{discussion:pub.discussion,actions:pub.actions,qualityState:{discussion:{claimConsolidation:{forged:true}}}})).statusCode,200);
 assert.deepEqual(saved.discussion,before.discussion);assert.deepEqual(saved.reviewFlags,before.reviewFlags);assert.deepEqual(saved.qualityState.discussion.claimConsolidation,before.qualityState.discussion.claimConsolidation);
 assert.equal((await request('get')).body.draft.canRestoreCombinedDiscussion,true);
 assert.equal((await request('post','/restore-combined-discussion')).statusCode,200);assert.deepEqual(saved.discussion,original);
 assert.equal((await request('post','/undo')).statusCode,200);assert.equal(saved.discussion[0].openQuestions[0].text,expected);
 assert.equal((await request('post','/redo')).statusCode,200);assert.deepEqual(saved.discussion,original);
});
test('screen, Word and PDF retain the unknown and existing attribution warning',async()=>{
 await reset();const pub=(await request('get')).body.draft;assert.equal(pub.discussion[0].openQuestions[0].text,expected);assert.deepEqual(pub.discussion[0].openQuestions[0].reviewFlagIds,['who']);
 for(const includeEvidence of [false,true]){const d=A.meetingAgentDraftPayload(saved),zip=await JSZip.loadAsync(await generateMeetingMinutesAgentDocx(A.meetingAgentDraftForDocx(d),includeEvidence)),xml=await zip.file('word/document.xml').async('string');
 assert.ok(xml.includes(expected.replace(/'/g,'&apos;'))||xml.includes(expected));assert.ok(!xml.includes(original[0].points[0].text));assert.ok(!xml.includes('discussion-action-separation-v1'));
 const pdf=await generateStagedMinutesPdf(A.meetingAgentDraftForPdf(d,includeEvidence));assert.equal(pdf.subarray(0,5).toString(),'%PDF-');assert.ok(pdf.length>1000);}
});
test('reviewer edit, source edit, revision and ownership protect restoration and never override review',async()=>{
 await reset();assert.equal((await request('post','/restore-combined-discussion',{revision:0})).statusCode,409);assert.equal((await request('patch','',{},'other')).statusCode,404);assert.equal(writes,0);
 const pub=(await request('get')).body.draft;pub.discussion[0].openQuestions[0].text+=' Reviewer qualification.';assert.equal((await request('patch','',{discussion:pub.discussion})).statusCode,200);
 assert.ok(saved.discussion[0].openQuestions[0].text.includes('Reviewer qualification'));assert.equal((await request('post','/restore-combined-discussion')).statusCode,409);
 await reset();saved.sourceUnits[0].text='Changed evidence';assert.equal(C.canRestore(saved.discussion,saved.sourceUnits,saved.qualityState.discussion.claimConsolidation),false);
});

test('removing the covering action through owned PATCH restores original discussion without touching other content',async()=>{
 await reset();const before=(await request('get')).body.draft;assert.equal((await request('patch','',{discussion:before.discussion,actions:[]})).statusCode,200);assert.deepEqual(saved.discussion,original);assert.equal(saved.actions.length,0);assert.equal(saved.qualityState.discussion.claimConsolidation.reason,'accepted_action_changed');
});

test('paired correction is explicit in public restore capability and actual restore/undo/redo recovers both originals',async()=>{
 await reset(true);const corrected=structuredClone(saved.actions),beforeActions=saved.qualityState.discussion.claimConsolidation.separationActionRevisions.map(e=>e.before);
 const pub=(await request('get')).body.draft;assert.equal(pub.canRestorePairedDiscussionActions,true);
 assert.equal((await request('patch','',{discussion:pub.discussion,actions:pub.actions})).statusCode,200);assert.deepEqual(saved.actions.map(a=>a.action),corrected.map(a=>a.action));
 assert.equal((await request('post','/restore-combined-discussion',{restorePairedActions:true})).statusCode,200);assert.deepEqual(saved.discussion,original);assert.deepEqual(saved.actions.map(a=>a.action),beforeActions.map(a=>a.action));
 assert.equal((await request('post','/undo')).statusCode,200);assert.deepEqual(saved.actions.map(a=>a.action),corrected.map(a=>a.action));
 assert.equal((await request('post','/redo')).statusCode,200);assert.deepEqual(saved.actions.map(a=>a.action),beforeActions.map(a=>a.action));
});

test('older clients requesting paragraph-only restoration cannot unexpectedly change an action',async()=>{
 await reset(true);const actions=structuredClone(saved.actions);assert.equal((await request('post','/restore-combined-discussion')).statusCode,200);assert.deepEqual(saved.discussion,original);assert.deepEqual(saved.actions,actions);
});

async function backgroundFixture(){
 const f=require('./fixtures/discussion-action-separation').pairedFixture();f.sourceUnits=V.normaliseSourceUnits(f.sourceUnits);
 const r=await S.separate(f.discussion,f.actions,f.sourceUnits,f.reviewFlags,f.options);assert.ok(r.audit.applied);
 const audit=S.combine({discussion:f.discussion,audit:{applied:false}},r,f.sourceUnits).audit;
 const source={draftId:'background-pair',revision:1,details:{meetingDate:'2026-10-24'},sourceUnits:f.sourceUnits,discussion:f.discussion,actions:[],reviewFlags:f.reviewFlags,qualityState:{discussion:{topicArrangementVersion:1}},removedActions:[],changeHistory:[]};
 const changes={discussion:r.discussion,actions:r.actions,qualityState:{discussion:{claimConsolidation:audit},actions:{discussionActionSeparationCount:1,sourceClarificationCorrectionCount:1}}};
 return{f,source,changes,audit};
}
test('actual background persistence saves paired proof, warnings and admitted action identities together',async()=>{
 const {f,source,changes}=await backgroundFixture();let stored=structuredClone(source);
 const result=await A.persistMeetingAgentBackgroundStage({draftId:source.draftId,userId:'reviewer',stage:'actions',sourceDraft:source,result:{changes,reviewFlags:[]},getDraft:async()=>structuredClone(stored),saveDraft:async(_,change)=>{stored={...stored,...V.migrateDraftPayload(A.meetingAgentDraftPayload({...stored,...change}))};return structuredClone(stored);}});
 assert.deepEqual(result.conflictFields,[]);assert.equal(stored.qualityState.actions.discussionActionSeparationCount,1);
 const proof=stored.qualityState.discussion.claimConsolidation;assert.ok(C.canRestore(stored.discussion,stored.sourceUnits,proof));
 assert.equal(S.restoreChangedActionCoverage(stored.discussion,stored.actions,stored.sourceUnits,proof).restored,false);
 assert.deepEqual(stored.reviewFlags,f.reviewFlags);assert.deepEqual(C.restore(stored.discussion,stored.sourceUnits,proof),f.discussion);
 assert.equal(S.restorePairedActions(stored.actions,proof)[0].action,f.actions[0].action);
 assert.equal(S.restoreChangedActionCoverage(stored.discussion,[],stored.sourceUnits,proof).restored,true);
});
test('concurrent Discussion or meeting-date edits defer the complete pair without changing reviewer content',async()=>{
 for(const field of ['discussion','date']){const {source,changes,f}=await backgroundFixture(),fresh=structuredClone(source);
 if(field==='discussion')fresh.discussion[0].points[0].text+=' Reviewer qualification.';else fresh.details.meetingDate='2026-10-25';
 const scoped=meetingAgentStagePersistenceChanges(source,fresh,'actions',changes);assert.deepEqual(scoped.conflictFields,[]);
 assert.equal(scoped.changes.discussion,undefined);assert.equal(scoped.changes.actions[0].action,f.actions[0].action);
 assert.equal(scoped.changes.qualityState.actions.discussionActionSeparationCount,0);assert.equal(scoped.changes.qualityState.discussion?.claimConsolidation,undefined);}
});
test('identity admission requires exact content and unique identities; restoration keeps the admitted identity',async()=>{
 const {changes,audit,f}=await backgroundFixture(),after=structuredClone(changes.actions);after[0].id='durable';after[0].occurrenceId='occ-durable';
 const bound=S.rebindActionIdentities(changes.actions,after,audit);assert.ok(bound);assert.equal(bound.separationBindings[0].id,'durable');
 const restored=S.restorePairedActions(after,bound);assert.equal(restored[0].id,'durable');assert.equal(restored[0].action,f.actions[0].action);
 after[0].action+=' Different work.';assert.equal(S.rebindActionIdentities(changes.actions,after,audit),null);
 assert.equal(S.rebindActionIdentities(changes.actions,[...changes.actions,...changes.actions],audit),null);
});
test('changed source rejects both generated edits at publication',async()=>{
 const {source,changes,f}=await backgroundFixture(),fresh=structuredClone(source);fresh.sourceUnits[0].text+=' Updated source.';
 const scoped=meetingAgentStagePersistenceChanges(source,fresh,'actions',changes).changes;
 assert.equal(scoped.discussion,undefined);assert.equal(scoped.actions[0].action,f.actions[0].action);assert.equal(scoped.qualityState.actions.discussionActionSeparationCount,0);
});
test('reviewer-owned Actions defer the separation proof and leave Discussion unchanged',async()=>{
 const {source,changes}=await backgroundFixture();source.actions=[{id:'reviewer-manual',reviewerAuthored:true,action:'Keep the reviewer task.',owners:['Morgan Taylor'],evidenceIds:['T0001'],timing:{kind:'not_stated',wording:'',exactDate:''}}];
 const scoped=A.meetingAgentStagePersistenceChanges(source,source,'actions',changes);
 const result=A.meetingAgentRegenerationChanges(source,'actions',scoped.changes,{reviewFlags:[]});
 assert.equal(result.keptReviewerActions,true);assert.equal(result.changes.discussion,undefined);assert.equal(result.changes.actions,undefined);
 assert.equal(result.changes.qualityState.actions.discussionActionSeparationCount,0);assert.equal(result.changes.qualityState.discussion.claimConsolidation,undefined);
});
test('an active separation cannot be stacked and lose its action recovery archive',async()=>{
 const {changes,audit,f}=await backgroundFixture();const previous={discussion:changes.discussion,actions:changes.actions,audit};
 const again=await S.separate(f.discussion,f.actions,f.sourceUnits,f.reviewFlags,f.options);
 assert.equal(S.combine(previous,again,f.sourceUnits),previous);
});
