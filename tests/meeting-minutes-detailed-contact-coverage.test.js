'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {reconcileDetailedContacts:reconcile}=require('../utils/canonicalMinutes/detailedContactCoverage');
const A=require('../routes/api').stagedEvaluation;
const row=(id,action)=>({id,action,owners:['Morgan Lee'],evidenceIds:['T0001'],reviewFlagIds:[],timing:{kind:'not_stated',wording:'',exactDate:''}});
const pair=()=>[row('one','Discuss with Nora Patel the supplier registration activities and obtain clarity on responsibilities, status and planning.'),row('two','Speak to Nora Patel about the supplier registration activities and obtain clarity on responsibilities, status and planning.')];
test('complete contact instruction merges consistently through final preservation',()=>{
 const [a,b]=pair(),saved=structuredClone([a,b]);const forward=A.dedupeHybridActionRecords([a,b]),reverse=A.dedupeHybridActionRecords([b,a]);
 assert.equal(forward.length,1);assert.deepEqual(forward,reverse);assert.equal(forward[0].action,a.action);
 const final=A.reconcileFinalApprovedActions(forward,[a,b]);assert.equal(final.actions.length,1);assert.deepEqual(final.restored,[]);
 assert.deepEqual(A.dedupeHybridActionRecords(final.actions),final.actions);assert.deepEqual([a,b],saved);
});
for(const [name,change]of [
 ['owner',b=>b.owners=['Other Person']],['recipient',b=>b.action=b.action.replace('Nora Patel','Nora Smith')],
 ['quantity',b=>b.action=b.action.replace('activities','two activities')],['purpose',b=>b.action=b.action.replace('planning','approval')],
 ['source',b=>b.evidenceIds=['T0002']],['condition',b=>b.action+=' If approved.'],['repeat',b=>b.action=b.action.replace('activities','activities again')],
 ['timing',b=>b.timing={kind:'target',wording:'Friday',exactDate:''}],['unresolved',b=>b.timingDecision={status:'unresolved'}],
 ['warning',b=>b.reviewFlagIds=['flag']],['manual',b=>b.reviewerAuthored=true],['unknown',b=>b.extra='preserve'],
 ['occurrence',b=>b.occurrenceId='other'],['disposition',b=>b.disposition='status_only']
])test(name+' cannot acquire a contact-equivalence proof',()=>{const[a,b]=pair();change(b);assert.equal(reconcile(a,b),null);});
test('colliding IDs never suppress an unrelated approved task',()=>{const[a,b]=pair(),c=row(a.id,'Review the supplier invoice.');const r=A.reconcileFinalApprovedActions(A.dedupeHybridActionRecords([a,b]),[a,b,c]);assert.equal(r.actions.length,2);assert.ok(r.actions.some(x=>x.action===c.action));});
test('a later purpose edit restores distinct work',()=>{const[a,b]=pair();const merged=A.dedupeHybridActionRecords([a,b]);merged[0]={...merged[0],action:merged[0].action.replace('planning','invoicing')};assert.equal(A.reconcileFinalApprovedActions(merged,[b]).actions.length,2);});
test('Unicode names are literal, not aliases',()=>{const[a,b]=pair().map(r=>({...r,action:r.action.replace('Nora Patel',"Nóra O’Neill")}));assert.ok(reconcile(a,b));b.action=b.action.replace('Nóra', 'Nora');assert.equal(reconcile(a,b),null);});
test('canonical payload and Word/PDF export retain one complete existing contact instruction',async()=>{
 const V=require('../utils/meetingMinutesAgentV2'),JSZip=require('jszip');const[a,b]=pair();const actions=A.reconcileFinalApprovedActions(A.dedupeHybridActionRecords([a,b]),[a,b]).actions;
 const draft={draftId:'contact-export',details:{meetingTitle:'Supplier review',meetingDate:'2026-10-24'},sourceUnits:V.normaliseSourceUnits([{id:'T0001',speaker:'Morgan Lee',text:'I will discuss the supplier registration activities with Nora Patel and obtain clarity on responsibilities, status and planning.'}]),actions,discussion:[],reviewFlags:[],meetingObjectives:[],executiveSummary:''};
 const saved=V.migrateDraftPayload(JSON.parse(JSON.stringify(A.meetingAgentDraftPayload(draft))));assert.equal(saved.actions.length,1);assert.equal(saved.actions[0].action,a.action);
 const docx=await require('../utils/meetingMinutesAgentDocx').generateMeetingMinutesAgentDocx(A.meetingAgentDraftForDocx(saved),false),zip=await JSZip.loadAsync(docx),xml=await zip.file('word/document.xml').async('string');assert.ok(xml.includes(a.action));assert.ok(!xml.includes(b.action));
 const pdf=await require('../utils/stagedMinutesPdf').generateStagedMinutesPdf(A.meetingAgentDraftForPdf(saved,false));assert.equal(pdf.subarray(0,5).toString(),'%PDF-');
});
test('different timing rejection histories cannot disappear behind an untimed duplicate',()=>{const[a,b]=pair();a.timingDecision={status:'unverified',rejectedWordings:['Friday']};b.timingDecision={status:'unverified',rejectedWordings:[]};assert.equal(reconcile(a,b),null);});
