'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
let V;
try {
  Module._load = function (request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    assert.ok(!/[\\/]routes[\\/]api(?:\.js)?$/.test(resolved), 'review flag ownership must not load the API');
    assert.ok(!/[\\/]meetingMinutesAgentV2(?:\.js)?$/.test(resolved), 'review flag ownership must not load V2');
    return originalLoad.apply(this, arguments);
  };
  V = require('../utils/meetingMinutesReviewFlags');
} finally {
  Module._load = originalLoad;
}
const { normaliseFlag, isUsefulReviewFlag } = V;

test('review flags distinguish extraction uncertainty from ordinary pending meeting content', () => {
  const pending = normaliseFlag({ kind: 'uncertain_fact', message: 'Document access had not yet been confirmed.' });
  const ambiguous = normaliseFlag({ kind: 'uncertain_fact', message: 'The language count contains unclear wording and could not be verified.' });
  const corrected = normaliseFlag({ ...pending, status: 'corrected', correctionNote: 'Access was confirmed later.' });
  assert.equal(isUsefulReviewFlag(pending), false);
  assert.equal(isUsefulReviewFlag(ambiguous), true);
  assert.equal(isUsefulReviewFlag(corrected), true, 'a reviewer correction remains part of the audit trail');
  assert.equal(isUsefulReviewFlag(normaliseFlag({
    kind: 'ownership', message: 'Confirm or correct unsupported action owner “Alex”; it has been removed.'
  })), false);
  assert.equal(isUsefulReviewFlag(normaliseFlag({
    kind: 'timing', message: 'The exact date 23 June was not supported by the cited evidence and has been removed.'
  })), false);
  assert.equal(isUsefulReviewFlag(normaliseFlag({
    kind: 'ownership', message: 'The transcript contains conflicting ownership between Alex and Priya.'
  })), true);

  assert.equal(normaliseFlag({ type: 'timing_uncertain', text: 'Confirm the target.' }).kind, 'timing');
  assert.equal(normaliseFlag({ type: 'ownership_uncertain', text: 'Confirm the owner.' }).kind, 'ownership');
  assert.equal(normaliseFlag({ type: 'unresolved_decision', text: 'A decision remains open.' }).kind, 'unresolved_decision');
});

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

