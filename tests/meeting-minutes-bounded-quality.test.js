'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');
test('completed correction annotations no longer block cleanup; unresolved and reviewer-resolved warnings survive',()=>{
  const correction=V.normaliseFlag({kind:'uncertain_fact',message:'Wording corrected against the cited passage: "red" → "blue".'});
  const warning=V.normaliseFlag({id:'flag-fidelity-meaning-test',kind:'uncertain_fact',message:'The correction could not be verified.'});
  const resolved=V.normaliseFlag({...correction,id:'reviewed-correction',status:'corrected',correctionNote:'Keep this review history.'});
  const content={discussion:[{topic:'Facilities',points:[{id:'p',text:'The storage enclosure is blue.',evidenceIds:['T0001'],reviewFlagIds:[correction.id,warning.id,resolved.id],supportingDetails:[{id:'c',text:'The enclosure is blue.',evidenceIds:['T0001'],reviewFlagIds:[correction.id]}]}]}]};
  const before=structuredClone(content);
  const cleaned=V.reconcileUsefulRecordFlags(content,[correction,warning,resolved]);
  assert.deepEqual(cleaned.content.discussion[0].points[0].reviewFlagIds,[warning.id,resolved.id]);
  assert.deepEqual(cleaned.content.discussion[0].points[0].supportingDetails[0].reviewFlagIds,[]);
  assert.deepEqual(cleaned.flags.map(f=>f.id),[warning.id,resolved.id]);
  assert.deepEqual(content,before);
  assert.ok(V.reconcileRecordFlags(content,[correction],V.isUsefulReviewFlag).content.discussion[0].points[0].reviewFlagIds.includes(correction.id),'shared legacy behavior is unchanged');
  assert.deepEqual(V.reconcileUsefulRecordFlags(content,[]).content,cleaned.content,'registry recovery uses the same policy');
});

test('completed correction notices expose a covered child to the existing verifier, while a real warning still protects it',()=>{
  const P=require('../utils/canonicalMinutes/discussionOwnParentCoverage');
  const correction=V.normaliseFlag({kind:'uncertain_fact',message:'Wording corrected against the cited passage: "red" → "blue".'});
  const parent={id:'enclosure',text:'The storage enclosure has a blue exterior; its lock needs replacement.',
    evidenceIds:['T0001'],reviewFlagIds:[correction.id],supportingDetails:[{id:'colour',text:'The storage enclosure has a blue exterior.',evidenceIds:['T0001'],reviewFlagIds:[correction.id]}]};
  const content={discussion:[{id:'topic',topic:'Storage',points:[parent],decisions:[],openQuestions:[]}]};
  const sources=[{id:'T0001',speaker:'Chair',text:parent.text}];
  assert.equal(P.prepare(content.discussion,sources).candidates.length,0);
  const cleaned=V.reconcileUsefulRecordFlags(content,[correction]);
  assert.equal(P.prepare(cleaned.content.discussion,sources).candidates.length,1);
  const warning=V.normaliseFlag({id:'flag-fidelity-meaning-enclosure',kind:'uncertain_fact',message:'The colour could not be verified.'});
  parent.supportingDetails[0].reviewFlagIds.push(warning.id);
  const protectedContent=V.reconcileUsefulRecordFlags(content,[correction,warning]);
  assert.equal(P.prepare(protectedContent.content.discussion,sources).candidates.length,0);
});

function fidelity(kind='points') {
  const record={id:'fact',text:'Striped markings and gates were considered too expensive and prevent customer access.',evidenceIds:['T0001'],reviewFlagIds:['existing-warning']};
  const discussion=[{id:'topic',topic:'Access',points:[],decisions:[],openQuestions:[]}];
  if(kind==='child') discussion[0].points=[{id:'parent',text:'Access alternatives were reviewed.',evidenceIds:['T0001'],reviewFlagIds:[],supportingDetails:[record]}];
  else discussion[0][kind]=[record];
  const units=V.normaliseSourceUnits([{id:'T0001',text:'Striped markings, no enforcement.'},{id:'T0002',text:'Gate, costly and customers cannot enter.'}]);
  const items=V.discussionFidelityCheckItems(discussion,units);
  const item=items.find(i=>i.row===record.text);
  const verdict={id:item.id,verdict:'corrected',problemQuote:record.text,evidenceQuote:'Striped markings, no enforcement.',correctedText:'Marked spaces lack effective compliance measures; a physical entrance obstruction has excessive procurement costs and restricts public entry.',reason:'The alternatives have different limitations.'};
  return {discussion,items:[item],verdict,record,item};
}
for(const kind of ['points','decisions','openQuestions','child']) test('rejected factual correction remains visible and warned on '+kind,()=>{
  const f=fidelity(kind),before=structuredClone(f.discussion);
  const result=V.applyDiscussionFidelityResults(f.discussion,f.items,[f.verdict]);
  assert.equal(result.corrected,0);
  assert.equal(result.accounting.items[0].reason,'support_too_low');
  const changed=f.item.path.reduce((v,k)=>v[k],result.discussion);
  assert.equal(changed.text,f.record.text);assert.deepEqual(changed.evidenceIds,f.record.evidenceIds);
  assert.ok(changed.reviewFlagIds.includes('existing-warning'));
  assert.equal(result.flags.length,1);assert.equal(V.isUsefulReviewFlag(result.flags[0]),true);
  assert.ok(changed.reviewFlagIds.includes(result.flags[0].id));
  const saved=V.reconcileUsefulRecordFlags(JSON.parse(JSON.stringify({discussion:result.discussion})),result.flags);
  assert.ok(f.item.path.reduce((v,k)=>v[k],saved.content.discussion).reviewFlagIds.includes(result.flags[0].id));
  assert.deepEqual(f.discussion,before);
  const again=V.applyDiscussionFidelityResults(result.discussion,f.items,[f.verdict]);
  assert.deepEqual(f.item.path.reduce((v,k)=>v[k],again.discussion).reviewFlagIds,changed.reviewFlagIds);
});
test('missing, malformed, stale and manually authored correction targets are never converted to factual verdicts',()=>{
  for(const mode of ['missing','malformed','stale','manual']) {
    const f=fidelity();
    if(mode==='malformed')f.verdict.correctedText={invalid:true};
    if(mode==='stale')f.discussion[0].points[0].text='A reviewer changed the wording.';
    if(mode==='manual')f.discussion[0].points[0].reviewerAuthored=true;
    const before=structuredClone(f.discussion);
    const out=V.applyDiscussionFidelityResults(f.discussion,f.items,mode==='missing'?[]:[f.verdict]);
    assert.deepEqual(out.discussion,before);assert.equal(out.flags.length,0);
  }
});
