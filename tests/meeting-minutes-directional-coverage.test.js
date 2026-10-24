'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const D = require('../utils/canonicalMinutes/discussionDirectionalCoverage');
const C = require('../utils/canonicalMinutes/discussionClaimConsolidation');
const copy = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const sourceUnits = Array.from({ length: 20 }, (_, i) => ({ id: `T${i}`, text: i === 10
    ? 'The seal fault caused alarms. The maintenance interval was reduced as mitigation.' : 'Source exchange context.' }));
  const row = (id, text, evidenceIds) => ({ id, text, evidenceIds, primaryEvidenceIds: evidenceIds,
    reviewFlagIds: [], supportingDetails: [] });
  const parent = row('fuller', 'The seal fault caused alarms and the maintenance interval was reduced as mitigation, with an outstanding documentation check.', sourceUnits.slice(1, 9).map(s => s.id));
  parent.supportingDetails.push({ ...row('child', 'An earlier review also covered the seal fault.', ['T9']), originalTopic: 'Maintenance', reviewFlagIds: ['child-warning'] });
  const leaf = row('short', 'The maintenance interval was reduced.', ['T10']);
  return { discussion: [{ topic: 'Maintenance', points: [parent, leaf], decisions: [], openQuestions: [] }], sourceUnits };
}
function responses(veto = false) {
  return {
    nominationMode: 'directional',
    assess: async (_, p) => ({ version: C.VERSION, packetHash: p.packetHash, results: p.candidates.map(c => ({ id: c.id, relation: 'covered', survivorId: c.allowedSurvivors[0] })) }),
    verify: async (_, p, selected) => ({ version: C.VERSION, packetHash: p.packetHash, results: selected.map(c => ({ id: c.id, survivorId: c.survivorId,
      checks: c.rows.flatMap(r => r.clauses.map((_, clauseIndex) => ({ recordId: r.record.id, clauseIndex,
        supported: !veto, retained: true, sourceIds: ['T10'] }))) })) })
  };
}
test('directional nomination supplies the bounded exchange across disjoint citations and preserves generated children', async () => {
  const f = fixture(), original = copy(f.discussion), packet = D.prepare(f.discussion, f.sourceUnits);
  assert.equal(packet.candidates.length, 1);
  assert.deepEqual(packet.candidates[0].allowedSurvivors, ['fuller']);
  assert.ok(packet.candidates[0].sourceUnits.some(s => s.id === 'T9'));
  const r = await C.consolidate(f.discussion, f.sourceUnits, responses());
  assert.equal(r.audit.method, D.VERSION); assert.equal(r.audit.applied, true);
  assert.equal(r.discussion[0].points.length, 1);
  assert.equal(r.discussion[0].points[0].text, original[0].points[0].text);
  assert.deepEqual(r.discussion[0].points[0].supportingDetails, original[0].points[0].supportingDetails);
  assert.equal(r.discussion[0].points[0].evidenceIds.length, 9);
  assert.ok(!r.discussion[0].points[0].evidenceIds.includes('T9'), 'context is not automatically cited');
  assert.deepEqual(C.restore(r.discussion, f.sourceUnits, r.audit), original);
  assert.deepEqual(f.discussion, original);
});
for (const [name, change] of [
  ['own warning', f => f.discussion[0].points[1].reviewFlagIds.push('warning')],
  ['removable child', f => f.discussion[0].points[1].supportingDetails.push(copy(f.discussion[0].points[0].supportingDetails[0]))],
  ['reviewer descendant', f => f.discussion[0].points[0].supportingDetails[0].id = 'reviewer-note'],
  ['unknown descendant metadata', f => f.discussion[0].points[0].supportingDetails[0].unrecognised = true],
  ['unknown parent metadata', f => f.discussion[0].points[0].unrecognised = true],
  ['duplicate identity', f => f.discussion[0].points[0].supportingDetails[0].id = 'short'],
  ['duplicate source identity', f => f.sourceUnits.push(copy(f.sourceUnits[1]))],
  ['blank duplicate source', f => f.sourceUnits.unshift({ id: 'T1', text: '' })],
  ['missing source', f => f.sourceUnits.splice(1, 1)],
  ['unbounded exchange', f => { f.sourceUnits.push(...Array.from({length:30},(_,i)=>({id:'extra'+i,text:'context'})), {id:'far',text:'Maintenance interval reduced.'}); f.discussion[0].points[1].evidenceIds=['far']; f.discussion[0].points[1].primaryEvidenceIds=['far']; }],
  ['different timeframe', f => f.discussion[0].points[1].text = 'The maintenance interval will be reduced next month.'],
  ['distinct amount', f => f.discussion[0].points[1].text = 'The maintenance interval was reduced to 17 days.'],
  ['uncertainty', f => f.discussion[0].points[1].text = 'The maintenance interval might be reduced.'],
  ['condition', f => f.discussion[0].points[1].text = 'The maintenance interval was reduced only if alarms persisted.'],
  ['question', f => f.discussion[0].points[1].text = 'Was the maintenance interval reduced?'],
  ['different topic', f => { const leaf=f.discussion[0].points.pop();f.discussion.push({topic:'Other',points:[leaf]}); }],
]) test('protected nomination: ' + name, () => { const f=fixture();change(f);assert.equal(D.prepare(f.discussion,f.sourceUnits).candidates.length,0); });
test('similar words cannot override verifier rejection of different work or referents', async () => {
  const f=fixture();f.discussion[0].points[1].text='Another seal had a reduced maintenance interval.';
  const r=await C.consolidate(f.discussion,f.sourceUnits,responses(true));
  assert.equal(r.audit.applied,false);assert.deepEqual(r.discussion,f.discussion);
});
test('provider failure and malformed coverage retain both rows', async () => {
  for(const override of [{assess:async()=>{throw Error('timeout');}},{verify:async()=>({results:[]})}]) {
    const f=fixture(),r=await C.consolidate(f.discussion,f.sourceUnits,{...responses(),...override});
    assert.equal(r.audit.applied,false);assert.deepEqual(r.discussion,f.discussion);
  }
});
test('one candidate maximum, shadow mode and chained recovery remain bounded', async () => {
  const f=fixture();const other=copy(f.discussion[0]);other.topic='Other';other.points.forEach(r=>{r.id+='-2';r.supportingDetails?.forEach(c=>c.id+='-2');});f.discussion.push(other);
  assert.equal(D.prepare(f.discussion,f.sourceUnits,{maxCandidates:99}).candidates.length,1);
  const shadow=await C.consolidate(f.discussion,f.sourceUnits,{...responses(),shadow:true});assert.deepEqual(shadow.discussion,f.discussion);assert.equal(shadow.audit.applied,false);
  const first=await C.consolidate(f.discussion,f.sourceUnits,responses());
  const second=await C.consolidate(first.discussion,f.sourceUnits,responses());
  const combined=D.combine(first,second,f.sourceUnits);
  assert.deepEqual(C.restore(combined.discussion,f.sourceUnits,combined.audit),f.discussion);
  const stale=copy(second);stale.audit.inputHash='invalid';assert.deepEqual(D.combine(first,stale,f.sourceUnits),first);
});
test('contradictory or extra provider fields fail closed instead of ignoring unsupported claims', async () => {
  for(const stage of ['assess','verify']) {
    const f=fixture(),options=responses(),original=options[stage];
    options[stage]=async(...args)=>({...await original(...args),unsupportedClaims:['The interval claim is unsupported.']});
    const r=await C.consolidate(f.discussion,f.sourceUnits,options);assert.equal(r.audit.applied,false);assert.deepEqual(r.discussion,f.discussion);
  }
});
test('malformed recovery proof is ineligible without throwing or authorising preservation', async () => {
  const f=fixture(),r=await C.consolidate(f.discussion,f.sourceUnits,responses());
  for(const changed of [{original:undefined},{ledger:'not-an-array'},{affectedTopics:[null]},{affectedTopics:[{index:-1}]},{affectedTopics:[...r.audit.affectedTopics,...r.audit.affectedTopics]}]) {
    assert.equal(C.canRestore(r.discussion,f.sourceUnits,{...r.audit,...changed}),false);
  }
});
