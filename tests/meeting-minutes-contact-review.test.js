'use strict';
process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1='0';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../utils/canonicalMinutes/contactParaphrase'),R=require('../utils/canonicalMinutes/actionSemanticReconciliation');
const S=require('../utils/meetingMinutesSemanticStage');
const {captureSemanticPolicy}=require('../utils/meetingMinutesSemanticPolicy');
const response=require('./helpers/meeting-minutes-contained-response');
const row=(id,action)=>({id,action,owners:['Maya Patel'],timing:{kind:'not_stated',wording:'',exactDate:''},evidenceIds:['T0001'],reviewFlagIds:[]});
const parent=row('parent','Follow up with Morgan and obtain a review of the battery calibration standards material.');
const child=row('child','Follow up with Morgan to review the battery calibration standard.');
const sourceUnits=require('../utils/meetingMinutesAgentV2').normaliseSourceUnits([{id:'T0001',speaker:'Maya Patel',text:'I will follow up with Morgan to get a review of the battery calibration standard.'}]);
const policy=captureSemanticPolicy({MEETING_MINUTES_AGENT_CONTACT_REVIEW_V1:'1',MEETING_MINUTES_AGENT_ACTION_PROOF_CONTRACT_V2:'1'});
function answer(packet){const r=response({...packet,selectedSurvivor:'A'});r.decisions[2].relation='same_obligation';r.decisions[0].rows.forEach(row=>row.basis='commitment');return r;}

for(const reverse of [false,true])test(`review arrangement receives two independent assessments and exact recovery (reverse=${reverse})`,async()=>{
 const A=require('../routes/api').stagedEvaluation,actions=reverse?[child,parent]:[parent,child],original=structuredClone(actions);let calls=0;
 const out=await S.reconcileGeneratedSemanticStage({changes:{actions}},{sourceUnits},'actions',{policy,verifySurvival:A.reconcileFinalApprovedActions,
  ask:async prompt=>{calls++;const packet=JSON.parse(prompt.split('\nDATA\n')[1]);assert.equal(packet.instructionComparison,'contact_review');return {result:answer(packet)};}});
 assert.equal(calls,2);assert.equal(out.changes.actions.length,1,JSON.stringify(out.changes.qualityState.actions.semanticReconciliation.unresolved));
 assert.equal(out.changes.actions[0].action,parent.action,'existing wording stays unchanged');assert.deepEqual(actions,original);
 const admitted=A.admitMeetingAgentGeneratedActionChanges({sourceUnits},out.changes,'contact-review-test');
 const saved=JSON.parse(JSON.stringify({sourceUnits,...admitted}));
 assert.deepEqual(require('../utils/meetingMinutesEnquiryRecovery').originalEnquiryActions(saved),actions);
 const persisted=A.meetingAgentDraftPayload(saved);
 assert.deepEqual(require('../utils/meetingMinutesEnquiryRecovery').originalEnquiryActions(persisted),actions,'save normalization preserves exact recovery');
 assert.equal(require('../utils/meetingMinutesEnquiryRecovery').originalEnquiryActions({...saved,actions:[{...saved.actions[0],action:saved.actions[0].action+' Extra reviewer text.'}]}),null,'recovery never overwrites a subsequent edit');
 const q=saved.qualityState.actions.semanticReconciliation;
 for(const receipt of q.receipts)assert.ok(R.validateReconciliationReceipt(receipt,receipt.original,saved.actions[0],sourceUnits));
 assert.ok(q.receipts.length,'survival is certified for each original');
});

for(const [label,change]of [
 ['owner',r=>r.owners=['Other Person']],['warning',r=>r.reviewFlagIds=['warning']],['reviewer edit',r=>r.reviewerAuthored=true],
 ['extra metadata',r=>r.notes='Keep this'],['date',r=>r.timing={kind:'target',wording:'Friday',exactDate:''}],
 ['rejected date',r=>r.timingDecision={status:'rejected',rejectedWordings:['Friday']}],['recipient',r=>r.action=r.action.replace('Morgan','Taylor')],
 ['different standard',r=>r.action=r.action.replace('battery calibration','security management')],
 ['different quantity',r=>r.action=r.action.replace('standard','2 standards')],
 ['condition',r=>r.action+=' after approval'],['compound',r=>r.action+=' and send the report'],
 ['alternative',r=>r.action+=' or the security standard'],['second recipient',r=>r.action+=' with Taylor'],
 ['separate execution',r=>r.action='Review the battery calibration standard.'],
 ['separate delivery',r=>r.action='Send Morgan the battery calibration standard.'],
 ['separate completion',r=>r.action='Complete the review of the battery calibration standard.']
])test('review arrangement excludes '+label,()=>{const other=structuredClone(child);change(other);assert.equal(C.direction(parent,other,[parent,other],true),null);});

test('disabled snapshots do not nominate review arrangements; enabled policy is frozen with unchanged pair cap',()=>{
 assert.equal(C.direction(parent,child),null);
 const legacy=captureSemanticPolicy({MEETING_MINUTES_AGENT_CONTACT_PARAPHRASE_V1:'1'});
 assert.equal(legacy.contactReviews,undefined);
 assert.equal(R.prepareActionReconciliation({actions:[parent,child],sourceUnits,...legacy}).candidates.length,0);
 const env={MEETING_MINUTES_AGENT_CONTACT_REVIEW_V1:'1',MEETING_MINUTES_AGENT_CONTACT_ENQUIRY_DEDUPE_V1:'1',MEETING_MINUTES_AGENT_BOUNDED_SURVIVOR_DEDUPE_V1:'1'};
 const captured=captureSemanticPolicy(env);env.MEETING_MINUTES_AGENT_CONTACT_REVIEW_V1='0';
 assert.equal(captured.contactReviews,true);assert.ok(Object.isFrozen(captured));assert.equal(captured.maxCandidates,2);
 assert.equal(captureSemanticPolicy(env).contactReviews,undefined);
 assert.equal(R.prepareActionReconciliation({actions:[parent,child],sourceUnits,...captured}).candidates.length,1);
});

test('ambiguous existing survivors and reviewer-protected occurrences remain untouched',()=>{
 const alternate={...parent,id:'alternate'};
 assert.equal(C.direction(parent,child,[parent,child,alternate],true),null);
 const actions=[{...parent,occurrenceId:'protected'},child];
 assert.equal(R.prepareActionReconciliation({actions,sourceUnits,...policy,protectedOccurrenceIds:['protected']}).candidates.length,0);
});

test('qualified legacy contact comparisons retain nomination priority within the shared one-contact cap',()=>{
 const oldParent=row('legacy-parent','Discuss with Taylor the supplier registration activities and obtain clarity on the associated plan, timeline and responsibilities.');
 const oldChild=row('legacy-child','Follow up with Taylor to obtain clarity on the supplier registration activities, plan, timeline, and responsibilities.');
 const actions=[parent,child,oldParent,oldChild],packet=R.prepareActionReconciliation({actions,sourceUnits,...policy});
 assert.equal(packet.candidates.length,1);
 const chosen=packet.candidates[0];assert.equal(packet.rows.find(r=>r.ref===chosen.contactParaphrase.survivorRef).action.id,oldParent.id);
});

for(const [name,mutate]of [
 ['distinct referent',r=>r.decisions[2].relation='distinct_work'],
 ['uncertain referent',r=>r.decisions[2].relation='unclear'],
 ['unsupported stronger outcome',r=>r.decisions[0].rows[0].checks[0].status='unsupported'],
 ['not a commitment',r=>r.decisions[0].rows[1].basis='required_component'],
 ['incomplete retention',r=>r.decisions[1].checks=[]]
])for(const challenge of [false,true])test(`${name} at ${challenge?'challenge':'proposal'} retains both rows`,async()=>{
 let calls=0;const actions=[parent,child];const out=await S.reconcileGeneratedSemanticStage({changes:{actions}},{sourceUnits},'actions',{policy,ask:async prompt=>{
  calls++;const packet=JSON.parse(prompt.split('\nDATA\n')[1]),r=answer(packet);if(packet.reviewPurpose===(challenge?'independent_challenge':'proposal'))mutate(r);return {result:r};}});
 assert.deepEqual(out.changes.actions,actions);assert.equal(calls,challenge?2:1);
 assert.equal(out.changes.qualityState.actions.semanticReconciliation.stats.merged,0);
});

test('withdrawn, removed and missing source context cannot certify a contact-review merge',()=>{
 assert.throws(()=>C.reviewPacket(parent,child,[{...sourceUnits[0],text:sourceUnits[0].text+' That instruction is cancelled.'}],['T0001'],false),/withdrawal/);
 const a=C.reviewPacket(parent,child,sourceUnits,['T0001'],false),b=C.reviewPacket(parent,child,sourceUnits,['T0001'],true);
 const certificate=C.certify(parent,child,sourceUnits,['T0001'],answer(a),answer(b));assert.equal(certificate.reviewContact,true);
 assert.throws(()=>C.certify(parent,child,[{...sourceUnits[0],classification:'remove'}],['T0001'],answer(a),answer(b)));
 assert.throws(()=>C.certify(parent,child,[],['T0001'],answer(a),answer(b)));
 const atomic=R.prepareActionReconciliation({actions:[parent,child],sourceUnits});
 const [p,c]=atomic.rows;assert.ok(C.valid(atomic,certificate,c,p));
 assert.equal(C.valid(atomic,{...certificate,reviewContact:false},c,p),false);
 assert.equal(C.valid({...atomic,sourceUnits:[{...sourceUnits[0],text:'Different source.'}]},certificate,c,p),false);
});
