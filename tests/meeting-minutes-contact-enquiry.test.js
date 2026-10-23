'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { enquiryFrame, sameEnquiryPair } = require('../utils/canonicalMinutes/contactEnquiry');
const { commitmentScopeConflict } = require('../utils/canonicalMinutes/commitmentDuplicates');
const R = require('../utils/canonicalMinutes/actionSemanticReconciliation');
const { captureSemanticPolicy, normaliseSemanticPolicy } = require('../utils/meetingMinutesSemanticPolicy');
const { reconcileGeneratedSemanticStage } = require('../utils/meetingMinutesSemanticStage');
const row = (id, action, extra = {}) => ({ id, action, owners: ['Morgan Lee'], evidenceIds: ['T0001'],
  reviewFlagIds: [], timing: { kind: 'not_stated', wording: '', exactDate: '' }, ...extra });
const pair = () => [row('a', 'Check with Alex regarding supplier documentation.'),
  row('b', 'Speak to Alex to check on supplier documentation and certification requirements.')];
const policy = () => captureSemanticPolicy({ MEETING_MINUTES_AGENT_CONTACT_ENQUIRY_DEDUPE_V1: '1' });
const sources = require('../utils/meetingMinutesAgentV2').normaliseSourceUnits([
  { id: 'T0001', speaker: 'Morgan Lee', text: 'I need to check with Alex about supplier documentation and certification requirements.' }]);

test('enquiry topic prepositions do not invent a condition; actual days remain protected', () => {
  const [a,b] = pair();
  assert.equal(commitmentScopeConflict(a,b), false);
  assert.equal(commitmentScopeConflict(row('a','Check with Alex on Monday.'), row('b','Check with Alex on Tuesday.')), true);
  assert.deepEqual(enquiryFrame(a.action).recipient, enquiryFrame(b.action).recipient);
});

test('scoped nomination recognises the enquiry carrier without proving purpose retention', () => {
  const actions = pair(), frozen = structuredClone(actions);
  const packet = R.prepareActionReconciliation({ actions, sourceUnits: sources, scope: 'contact_enquiries' });
  assert.equal(packet.candidates.length, 1);
  assert.deepEqual(packet.candidates[0].leftIntoRight.reasons, ['directional_wording_not_proved']);
  assert.equal(R.buildDeterministicEnvelope(packet).decisions[0].relation, 'unresolved');
  assert.deepEqual(actions, frozen);
});

for (const [name, mutate] of [
  ['different contact', rows => { rows[1].action = rows[1].action.replace('Alex','Sam'); }],
  ['different owner', rows => { rows[1].owners = ['Robin West']; }],
  ['different purpose', rows => { rows[1].action = 'Speak to Alex to check on payment invoices.'; }],
  ['missing source overlap', rows => { rows[1].evidenceIds = ['T2']; }],
  ['reviewer content', rows => { rows[1].reviewerAuthored = true; }],
  ['reviewer notes', rows => { rows[1].notes = 'Keep both'; }],
  ['warning', rows => { rows[1].reviewFlagIds = ['flag']; }],
  ['dated occurrence', rows => { rows[1].timing = { kind:'target', wording:'Monday', exactDate:'2026-10-26' }; }],
  ['additional operation', rows => { rows[1].action += ' and send the certification.'; }],
  ['conditional work', rows => { rows[1].action += ' after approval.'; }],
  ['modality', rows => { rows[1].action = 'Maybe '+rows[1].action; }],
  ['alternative', rows => { rows[1].action += ' or pricing.'; }],
  ['quantity', rows => { rows[1].action += ' for 12 suppliers.'; }],
  ['enquiry versus execution', rows => { rows[1].action = 'Prepare supplier documentation for Alex.'; }]
]) test('enquiry scope preserves '+name, () => {
  const rows=pair();mutate(rows);
  assert.equal(sameEnquiryPair(...rows),false);
  assert.equal(R.prepareActionReconciliation({actions:rows,sourceUnits:sources,scope:'contact_enquiries'}).candidates.length,0);
});

test('kept occurrence cannot become an enquiry candidate', () => {
  const rows=pair();rows[0].occurrenceId='action-occurrence-111111111111111111111111';
  assert.equal(R.prepareActionReconciliation({actions:rows,sourceUnits:sources,scope:'contact_enquiries',
    protectedOccurrenceIds:[rows[0].occurrenceId]}).candidates.length,0);
});

test('enquiry opt-in is frozen, bounded and does not enable discussion reconciliation', async () => {
  const p=policy();assert.equal(p.mode,'on');assert.equal(p.scope,'contact_enquiries');assert.equal(p.maxCandidates,2);
  assert.deepEqual(normaliseSemanticPolicy(p),p);
  assert.equal(captureSemanticPolicy({}).mode,'off');
  const input={changes:{discussion:[{topic:'Keep',points:[]}]}};
  assert.equal(await reconcileGeneratedSemanticStage(input,{},'discussion',{policy:p,ask:()=>{throw Error('no');}}),input);
});

test('unavailable or rejected source verification retains both complete actions', async () => {
  const actions=pair(),input={changes:{actions}};
  const output=await reconcileGeneratedSemanticStage(input,{sourceUnits:sources},'actions',{
    policy:policy(),ask:async()=>{throw Error('unavailable');}});
  assert.deepEqual(output.changes.actions,actions);
  assert.equal(output.changes.qualityState.actions.semanticReconciliation.applied,false);
});

function response(prompt, negative=false) {
  const data=JSON.parse(prompt.slice(prompt.indexOf('\nDATA\n')+6));
  const verify=prompt.startsWith('ACTION_CRITIC_SEMANTIC_SOURCE_VERIFICATION');
  return {version:data.version,packetHash:data.packetHash,inputHash:data.inputHash,sourceHash:data.sourceHash,
    decisions:data.candidates.map(c=>{
      const survivor=verify ? c.survivorRef : data.rows.find(r=>r.action.action.includes('certification')).ref;
      return verify ? {candidateId:c.candidateId,survivorRef:survivor,relation:negative?'unresolved':'equivalent',
        checks:c.requiredChecks.map(check=>({...check,supported:!negative,retained:!negative,sourceIds:['T0001']}))}
        : {candidateId:c.candidateId,survivorRef:survivor,relation:'equivalent',
          coverage:[c.leftRef,c.rightRef].map(ref=>({originalRef:ref,survivorRef:survivor,sourceIds:['T0001'],
            clauseMap:[{originalClauseIndex:0,survivorClauseIndex:0,sourceIds:['T0001']}]}))};
    })};
}
for(const negative of [false,true]) test('independent verification '+(negative?'vetoes':'authorises')+' source-bound enquiry coverage',async()=>{
  const api=require('../routes/api').stagedEvaluation,actions=pair();let calls=0;
  const output=await reconcileGeneratedSemanticStage({changes:{actions}},{sourceUnits:sources},'actions',{
    policy:policy(),verifySurvival:api.reconcileFinalApprovedActions,ask:async(prompt,opts)=>{
      calls++;const result=response(prompt,negative);const error=opts.validateResult(result);if(error)throw error;return {result,timings:[]};
    }});
  const q=output.changes.qualityState.actions.semanticReconciliation;
  assert.equal(calls,2);
  assert.equal(output.changes.actions.length,negative?2:1);
  if(!negative){
    assert.equal(output.changes.actions[0].action,actions[1].action);
    assert.equal(api.reconcileFinalApprovedActions(output.changes.actions,actions,{receipts:q.receipts,sourceUnits:sources}).restored.length,0);
    assert.ok(q.receipts.every(receipt=>R.validateReconciliationReceipt(receipt,receipt.original,output.changes.actions[0],sources)));
    const changed=structuredClone(output.changes.actions[0]);changed.action+=' Extra work.';
    assert.equal(R.validateReconciliationReceipt(q.receipts[0],q.receipts[0].original,changed,sources),false);
    const { originalEnquiryActions }=require('../utils/meetingMinutesEnquiryRecovery');
    const admitted=api.admitMeetingAgentGeneratedActionChanges({sourceUnits:sources},output.changes,'enquiry-test');
    const saved={sourceUnits:sources,...admitted};
    assert.deepEqual(originalEnquiryActions(saved),actions);
    const edited=structuredClone(saved);edited.actions[0].action+=' Edited.';
    assert.equal(originalEnquiryActions(edited),null);
    const correctedSource=structuredClone(saved);correctedSource.sourceUnits[0].text+=' Correction.';
    assert.equal(originalEnquiryActions(correctedSource),null);
    assert.equal(originalEnquiryActions({...saved,keptActionIds:[saved.actions[0].id]}),null);
  }else assert.deepEqual(output.changes.actions,actions);
});

test('reviewer can restore separate actions from the Actions screen', async () => {
  const H=require('./helpers/meeting-minutes-review-browser');
  const initial=H.draft();initial.selectedStep=3;initial.canRestoreCombinedActions=true;
  const f=await H.fixture(initial);let requests=0;
  try {
    await f.page.route('**/restore-combined-actions',async route=>{
      requests++;assert.equal(route.request().method(),'POST');
      assert.ok(Number.isInteger(route.request().postDataJSON().revision));
      await route.fulfill({json:{ok:true,draft:{...initial,revision:2,canRestoreCombinedActions:false,
        actions:[...initial.actions,{...initial.actions[0],id:'separate-original',occurrenceId:'separate-occurrence',action:'Check the separate qualification.'}]}}});
    });
    await f.page.getByRole('button',{name:'Restore separate actions',exact:true}).click();
    await f.page.waitForFunction(()=>document.querySelectorAll('#actionsBody tr.action-row').length===2)
      .catch(async error=>{throw new Error(error.message+' '+JSON.stringify({requests,errors:f.errors,
        status:await f.page.locator('#saveStatus').textContent(),unexpected:f.requests}));});
    assert.equal(requests,1);assert.equal(await f.page.locator('[data-restore-combined-actions]').count(),0);
    assert.deepEqual(f.errors,[]);
  } finally { await f.close(); }
});
