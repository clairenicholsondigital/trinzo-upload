'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const S=require('../utils/canonicalMinutes/discussionActionSeparation'),C=require('../utils/canonicalMinutes/discussionClaimConsolidation');
const {fixture}=require('./fixtures/discussion-action-separation');
const run=f=>S.separate(f.discussion,f.actions,f.sourceUnits,f.reviewFlags,f.options);
test('source-verified separation retains unknown, attribution warning and exact sources while Actions remain immutable',async()=>{
 const f=fixture(),before=structuredClone(f.discussion),actions=JSON.stringify(f.actions),flags=JSON.stringify(f.reviewFlags);
 const result=await run(f);assert.equal(result.audit.applied,true,JSON.stringify(result.audit));
 assert.equal(result.discussion[0].points.length,0);const row=result.discussion[0].openQuestions[0];assert.equal(row.text,f.output);
 assert.equal(row.id,'mixed');assert.deepEqual(row.reviewFlagIds,['who']);assert.deepEqual(row.evidenceIds,['T0001','T0002']);
 assert.equal(JSON.stringify(f.actions),actions);assert.equal(JSON.stringify(f.reviewFlags),flags);assert.deepEqual(f.discussion,before);
 assert.deepEqual(C.restore(result.discussion,f.sourceUnits,result.audit),f.discussion);
});
for(const[name,change]of[
 ['missing accepted action',f=>f.actions=[]],['wrong action source',f=>f.actions[0].evidenceIds=['missing']],
 ['unowned action',f=>f.actions[0].owners=[]],['warned action',f=>f.actions[0].reviewFlagIds=['action-warning']],
 ['duplicate action identity',f=>f.actions.push(structuredClone(f.actions[0]))],
 ['reviewer discussion',f=>f.discussion[0].points[0].reviewerAuthored=true],
 ['reviewer descendant',f=>f.discussion[0].points[0].supportingDetails.push({id:'child',text:'Preserve this.',evidenceIds:['T0001'],reviewerAuthored:true})],
 ['unknown metadata',f=>f.discussion[0].points[0].unrecognised=true],
 ['unknown descendant metadata',f=>f.discussion[0].points[0].supportingDetails.push({id:'child',text:'Preserve this.',evidenceIds:['T0001'],unrecognised:true})],
 ['duplicate record identity',f=>f.discussion[0].points.push(structuredClone(f.discussion[0].points[0]))],
 ['duplicate source identity',f=>f.sourceUnits.push(structuredClone(f.sourceUnits[0]))],
 ['fidelity warning',f=>f.reviewFlags[0].kind='uncertain_fact'],['missing warning definition',f=>f.reviewFlags=[]],
 ['duplicate warning definition',f=>f.reviewFlags.push(structuredClone(f.reviewFlags[0]))],
])test('nomination safety: '+name,async()=>{const f=fixture();change(f);assert.equal(S.prepare(f.discussion,f.actions,f.sourceUnits,f.reviewFlags).candidates.length,0);assert.equal((await run(f)).audit.applied,false);});
test('generated supporting children and their warnings survive byte-exactly',async()=>{
 const f=fixture();f.discussion[0].points[0].supportingDetails=[{id:'child',text:'The instrument has two independent modes.',evidenceIds:['T0001'],reviewFlagIds:['child-warning'],originalTopic:'Calibration'}];
 const r=await run(f);assert.equal(r.audit.applied,true);assert.deepEqual(r.discussion[0].openQuestions[0].supportingDetails,f.discussion[0].points[0].supportingDetails);
});
for(const[name,edit]of[
 ['fabricated source quote',r=>r.results[0].claims[0].sourceWitnesses[0].quote='invented'],
 ['quote from transcript instead of original minutes',r=>r.results[0].claims.forEach(c=>c.originalQuote='Please contact Sam')],
 ['missing original inventory coverage',r=>r.results[0].claims.forEach(c=>c.originalQuote='calibration codes')],
 ['missing follow-up claim',r=>r.results[0].claims.pop()],
 ['missing independent discussion',r=>r.results[0].claims[0].kind='follow_up'],
 ['invented action',r=>r.results[0].claims[1].actionId='invented'],
 ['removed warned name',r=>r.results[0].text='The calibration codes remain unclear.'],
 ['new decision',r=>r.results[0].outputKind='decisions'],
 ['false answered state',r=>r.results[0].text='Morgan Taylor and Priya Shah confirmed the calibration codes with Sam Jones.'],
 ['contradictory extra fields',r=>r.unsupportedClaims=['missing source']],
])test('proposal safety: '+name,async()=>{const f=fixture(),propose=f.options.propose;f.options.propose=async(...args)=>{const r=await propose(...args);edit(r);return r;};const result=await run(f);assert.equal(result.audit.applied,false);assert.deepEqual(result.discussion,f.discussion);});
for(const[name,edit]of[
 ['different task',r=>r.results[0].claimChecks[1].correctKind=false],
 ['lost condition or purpose',r=>r.results[0].claimChecks[1].retained=false],
 ['unsupported original',r=>r.results[0].claimChecks[0].supported=false],
 ['missing inventory assertion',r=>r.results[0].originalChecks[0].allClaimsListed=false],
 ['invented output',r=>r.results[0].outputChecks[0].noNewClaims=false],
 ['remaining task recap',r=>r.results[0].outputChecks[0].noTaskRecap=false],
 ['warning no longer applies',r=>r.results[0].warningChecks[0].stillApplicable=false],
 ['warning changed scope',r=>r.results[0].warningChecks[0].sameMeaning=false],
 ['missing warning check',r=>r.results[0].warningChecks=[]],
 ['invented retained quote',r=>r.results[0].claimChecks[0].retainedQuote='invented'],
 ['duplicate output check',r=>r.results[0].outputChecks.push(r.results[0].outputChecks[0])],
])test('independent verification safety: '+name,async()=>{const f=fixture(),verify=f.options.verify;f.options.verify=async(...args)=>{const r=await verify(...args);edit(r);return r;};const result=await run(f);assert.equal(result.audit.applied,false);assert.deepEqual(result.discussion,f.discussion);});
test('provider failure, stale action input and shadow mode retain original discussion',async()=>{
 for(const mode of ['failure','stale','shadow']){const f=fixture();if(mode==='failure')f.options.verify=async()=>{throw Error('timeout');};
 if(mode==='stale'){const verify=f.options.verify;f.options.verify=async(...args)=>{const r=await verify(...args);f.actions[0].action='Different work';return r;};}
 if(mode==='shadow')f.options.shadow=true;
 const r=await run(f);assert.equal(r.audit.applied,false);assert.deepEqual(r.discussion,f.discussion);}
});
test('bounded witness retrieval finds explicit subject/name recap without donating it as a citation',()=>{
 const f=fixture();f.sourceUnits.push(...Array.from({length:25},(_,i)=>({id:'filler-'+i,speaker:'Other',text:'Unrelated production discussion.'})),
 {id:'recap',speaker:'Morgan Taylor',text:'The calibration codes are for Sam Jones to clarify before documentation.'});
 const p=S.prepare(f.discussion,f.actions,f.sourceUnits,f.reviewFlags);assert.equal(p.candidates.length,1);assert.ok(p.candidates[0].sourceUnits.some(s=>s.id==='recap'));
 assert.deepEqual(p.candidates[0].record.evidenceIds,['T0001','T0002']);assert.ok(p.candidates[0].sourceUnits.length<=24);
});
test('general person overlap does not retrieve an unrelated remote witness',()=>{
 const f=fixture();f.sourceUnits.push(...Array.from({length:25},(_,i)=>({id:'filler-'+i,speaker:'Other',text:'Unrelated production discussion.'})),
 {id:'unrelated',speaker:'Morgan Taylor',text:'Sam Jones will contact the supplier to arrange the delivery.'});
 const p=S.prepare(f.discussion,f.actions,f.sourceUnits,f.reviewFlags);assert.equal(p.candidates.length,1);assert.ok(!p.candidates[0].sourceUnits.some(s=>s.id==='unrelated'));
});
test('an attribution warning with no identifiable original name remains outside automatic editing',()=>{
 const f=fixture();f.reviewFlags[0].message='Confirm who is responsible.';assert.equal(S.prepare(f.discussion,f.actions,f.sourceUnits,f.reviewFlags).candidates.length,0);
});
test('changed or removed bound action restores only separation; unchanged semantic actions keep the edit',async()=>{
 const f=fixture(),next=await run(f),combined=S.combine({discussion:f.discussion,audit:{applied:false}},next,f.sourceUnits);
 assert.equal(S.restoreChangedActionCoverage(combined.discussion,f.actions,f.sourceUnits,combined.audit).restored,false);
 const changed=structuredClone(f.actions);changed[0].action='Unrelated work.';
 const restored=S.restoreChangedActionCoverage(combined.discussion,changed,f.sourceUnits,combined.audit);assert.equal(restored.restored,true);assert.deepEqual(restored.discussion,f.discussion);
 assert.equal(S.restoreChangedActionCoverage(combined.discussion,[],f.sourceUnits,combined.audit).restored,true);
 const reviewer=structuredClone(combined.discussion);reviewer[0].openQuestions[0].text+=' Reviewer qualification.';
 assert.equal(S.restoreChangedActionCoverage(reviewer,[],f.sourceUnits,combined.audit).restored,false);
});
test('information questions are not mistaken for a new temporal condition; actual timing constraints stay protected',()=>{
 assert.equal(S.retainsTiming('The engineer needs clarification of the calibration codes.','The engineer needs clarification on when the calibration codes are used.'),true);
 assert.equal(S.retainsTiming('The engineer needs clarification of the calibration codes.','The engineer will contact the supplier when approval arrives.'),false);
 assert.equal(S.retainsTiming('The engineer will contact the supplier by Friday.','The engineer will contact the supplier by Monday.'),false);
 assert.equal(S.retainsTiming('The engineer will contact the supplier after approval.','The engineer will contact the supplier.'),false);
});
test('paired source correction fixes unsupported communication intent while preserving owner, recipient and timing',async()=>{
 const f=require('./fixtures/discussion-action-separation').pairedFixture(),original=structuredClone(f.actions);const r=await run(f);assert.equal(r.audit.applied,true,JSON.stringify(r.audit));
 assert.equal(r.actions.length,original.length);assert.equal(r.actions[0].action,f.correctedAction);assert.deepEqual(r.actions[0].owners,original[0].owners);assert.deepEqual(r.actions[0].timing,original[0].timing);assert.deepEqual(f.actions,original);
 const combined=S.combine({discussion:f.discussion,audit:{applied:false}},r,f.sourceUnits);assert.deepEqual(S.restorePairedActions(combined.actions,combined.audit),original);
 const edited=structuredClone(combined.actions);edited[0].action+=' Reviewer qualification.';assert.deepEqual(S.restorePairedActions(edited,combined.audit),edited);
});
for(const[name,edit]of[
 ['unsupported new action',r=>r.results[0].actionOutputCheck.supported=false],
 ['additional work',r=>r.results[0].actionOutputCheck.noNewWork=false],
 ['different source work',r=>r.results[0].actionOutputCheck.sameWork=false],
 ['changed recipient direction',r=>r.results[0].actionOutputCheck.sameRoles=false],
 ['supported claim wrongly labelled correction',r=>r.results[0].actionClaimChecks.find(ch=>ch.claimId==='intent').originalSupported=true],
 ['lost original supported assertion',r=>r.results[0].actionClaimChecks[0].retainedOrCorrected=false],
])test('paired correction safety: '+name,async()=>{
 const f=require('./fixtures/discussion-action-separation').pairedFixture(),verify=f.options.verify;f.options.verify=async(...args)=>{const r=await verify(...args);edit(r);return r;};const r=await run(f);assert.equal(r.audit.applied,false);assert.deepEqual(r.discussion,f.discussion);
});
test('an identical previously vetoed proposal cannot be approved by sampling the verifier again',async()=>{
 const f=fixture();let checks=0;const verify=f.options.verify;f.options.verify=async(...args)=>{checks++;const r=await verify(...args);r.results[0].claimChecks[0].retained=false;return r;};const r=await run(f);assert.equal(checks,1);assert.equal(r.audit.reason,'unchanged_rejected_proposal');assert.equal(r.audit.rejectedAttempts.length,1);
});
test('only unchanged server-verified corrected actions retain exact witnesses through save normalization',async()=>{
 const f=require('./fixtures/discussion-action-separation').pairedFixture(),r=await run(f),combined=S.combine({discussion:f.discussion,audit:{applied:false}},r,f.sourceUnits);
 const normalised=structuredClone(r.actions);normalised[0].evidenceIds=['T0002'];const published=structuredClone(r.actions);
 assert.deepEqual(S.preserveUnchangedPairedActions(normalised,r.actions,published,published,combined.audit),r.actions);
 const edited=structuredClone(published);edited[0].action='Reviewer changed the task.';
 assert.deepEqual(S.preserveUnchangedPairedActions(normalised,r.actions,edited,published,combined.audit),normalised);
});
test('unfamiliar action or timing metadata cannot be silently rewritten',()=>{
 for(const extra of ['action','timing']){const f=require('./fixtures/discussion-action-separation').pairedFixture();if(extra==='action')f.actions[0].customConstraint='Preserve this';else f.actions[0].timing.customConstraint='Preserve this';assert.equal(S.prepare(f.discussion,f.actions,f.sourceUnits,f.reviewFlags).candidates.length,0);}
});
for(const[name,change]of[
 ['extra work quantity',r=>r.results[0].actionRevision.text='Contact Sam Jones to clarify two calibration codes before the maintenance procedure can be documented.'],
 ['dropped dependency',r=>r.results[0].actionRevision.text='Contact Sam Jones to clarify the calibration codes.'],
 ['new unsupported condition',r=>r.results[0].actionRevision.text+=' Only if the supplier agrees.'],
 ['owner edit in revision schema',r=>r.results[0].actionRevision.owners=['Priya Shah']],
])test('paired proposal cannot change '+name,async()=>{
 const f=require('./fixtures/discussion-action-separation').pairedFixture(),propose=f.options.propose;f.options.propose=async(...args)=>{const r=await propose(...args);change(r);return r;};assert.equal((await run(f)).audit.applied,false);
});
test('malformed client action rows cannot authorise witness preservation or crash a verified save',async()=>{
 const f=require('./fixtures/discussion-action-separation').pairedFixture(),r=await run(f),combined=S.combine({discussion:f.discussion,audit:{applied:false}},r,f.sourceUnits);
 assert.deepEqual(S.preserveUnchangedPairedActions(r.actions,r.actions,[null],r.actions,combined.audit),r.actions);
});
test('legacy source dispositions are archived but never supplied as evidence of task validity',async()=>{
 const f=fixture();f.actions[0].disposition='status_only';f.discussion[0].points[0].discoveryDisposition='core';
 const p=S.prepare(f.discussion,f.actions,f.sourceUnits,f.reviewFlags);assert.equal(p.candidates.length,1);
 const sent=JSON.parse(S.proposalPrompt(p).split('\nDATA\n')[1]).candidates[0];
 assert.equal(sent.acceptedActions[0].disposition,undefined);assert.equal(sent.acceptedActions[0].timingDecision,undefined);assert.equal(sent.record.discoveryDisposition,undefined);
 const r=await run(f);assert.equal(r.audit.applied,true);assert.equal(r.audit.ledger[0].sourceActionSnapshot[0].disposition,'status_only');
});
test('a rejected or unresolved action timing assessment cannot certify cross-section coverage',()=>{
 for(const status of ['rejected','unresolved','needs_rebind']){const f=fixture();f.actions[0].timingDecision={status};assert.equal(S.prepare(f.discussion,f.actions,f.sourceUnits,f.reviewFlags).candidates.length,0);}
});
test('paired action correction requires explicit independent completeness of the entire original action',async()=>{
 const f=require('./fixtures/discussion-action-separation').pairedFixture(),verify=f.options.verify;f.options.verify=async(...args)=>{const r=await verify(...args);r.results[0].actionOutputCheck.allOriginalClaimsListed=false;return r;};const r=await run(f);assert.equal(r.audit.applied,false);assert.deepEqual(r.discussion,f.discussion);
});

test('indirect reported contact planning is nominated generically but factual discussion is not',()=>{
 const f=fixture();f.discussion[0].points[0].text="Morgan Taylor and Priya Shah discuss reaching out to Sam Jones to clarify the calibration codes before the maintenance procedure can be documented.";
 assert.equal(S.prepare(f.discussion,f.actions,f.sourceUnits,f.reviewFlags).candidates.length,1);
 f.discussion[0].points[0].text='Morgan Taylor and Priya Shah discuss the calibration codes and documentation.';
 assert.equal(S.prepare(f.discussion,f.actions,f.sourceUnits,f.reviewFlags).candidates.length,0);
});
