'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');
const { correctionMeaningIssue } = require('../utils/meetingMinutesFidelityMeaning');
const A = require('../routes/api').stagedEvaluation;

const original = 'The supplier checklist describes the upload process and project responsibilities.';
function fixture(sourceText, options = {}) {
  const sources = [
    { id: 'T0001', speaker: 'Chair', text: original },
    { id: 'T0002', speaker: 'Morgan Lee', text: sourceText }
  ];
  const record = { id: 'supplier', text: original, evidenceIds: ['T0001'], reviewFlagIds: [], ...options };
  const discussion = [{ topic: 'Supplier', points: [record], decisions: [], openQuestions: [] }];
  const items = V.discussionFidelityCheckItems(discussion, sources);
  return { discussion, items, sources };
}
function apply(f, correctedText, quote = f.sources[1].text) {
  return V.applyDiscussionFidelityResults(f.discussion, f.items, [{
    id: f.items[0].id, verdict: 'corrected', issue: '', problemQuote: original,
    evidenceQuote: quote, correctedText, reason: 'The source gives the follow-up.'
  }]);
}

for (const verb of ['agreed', 'planned', 'committed', 'promised', 'decided']) {
  test(`an offer cannot become ${verb} work through paragraph word overlap`, () => {
    const f = fixture('I can ask Alex about the supplier checklist and upload process and project responsibilities.');
    const result = apply(f, `Morgan Lee ${verb} to ask Alex about the supplier checklist and upload process and project responsibilities.`);
    assert.equal(result.corrected, 0);
    assert.equal(result.discussion[0].points[0].text, original);
    assert.equal(result.accounting.items[0].reason, 'correction_assertion_strength_not_proved');
    assert.ok(result.flags.some(V.isUsefulReviewFlag));
  });
}
test('a source-bound named first-person commitment can still be corrected', () => {
  const f = fixture('I agreed to ask Alex about the supplier checklist and upload process and project responsibilities.',
    {evidenceIds:['T0001','T0002']});
  const result = apply(f, 'Morgan Lee agreed to ask Alex about the supplier checklist and upload process and project responsibilities.');
  assert.equal(result.corrected, 1);
  assert.deepEqual(result.discussion[0].points[0].evidenceIds, ['T0001', 'T0002']);
  assert.equal(result.flags.filter(V.isUsefulReviewFlag).length, 0, 'a verified correction notice is not an unresolved warning');
});
test('source contractions can report an explicit commitment without inventing agreement', () => {
  const source = { id: 'T0002', speaker: 'Morgan Lee', text: "I'll ask Alex about the supplier checklist." };
  assert.deepEqual(correctionMeaningIssue(original, 'Morgan Lee will ask Alex about the supplier checklist.', [source]), {sourceIds:['T0002']});
});
test('a bare offer cannot become an unconditional will assertion', () => {
  assert.equal(correctionMeaningIssue('Morgan can ask Alex about the checklist.',
    'Morgan will ask Alex about the checklist.', [{id:'T1',speaker:'Morgan',text:'I can ask Alex about the checklist.'}]).reason,
  'correction_assertion_strength_not_proved');
});
test('regulatory obligations, document plans and approval/completion reporting retain their separate validation', () => {
  assert.deepEqual(correctionMeaningIssue(original,
    'The importer must verify registration; the supplier has a plan of action; the team approved the completed report.', []), {sourceIds:[]});
});
test('an equally worded nearby source cannot displace an existing own-source witness', () => {
  const text='Morgan Lee agreed to ask Alex about the supplier checklist and upload process and project responsibilities.';
  const f=fixture(text,{evidenceIds:['T0003']});
  f.sources=[...f.sources,{id:'T0003',speaker:'Morgan Lee',text}];
  f.items=V.discussionFidelityCheckItems(f.discussion,f.sources);
  const result=apply(f,text);
  assert.equal(result.corrected,1);
  assert.deepEqual(result.discussion[0].points[0].evidenceIds,['T0003']);
});
for (const [label, source, correction] of [
  ['different work', 'Morgan Lee agreed to review the safety manual.', 'Morgan Lee agreed to review the supplier checklist.'],
  ['different person', 'Priya agreed to review the supplier checklist.', 'Morgan Lee agreed to review the supplier checklist.'],
  ['negation', 'Morgan Lee did not agree to review the supplier checklist.', 'Morgan Lee agreed to review the supplier checklist.'],
  ['question', 'Morgan Lee agreed to review the supplier checklist?', 'Morgan Lee agreed to review the supplier checklist.'],
  ['reported speech', 'Priya said Morgan Lee agreed to review the supplier checklist.', 'Morgan Lee agreed to review the supplier checklist.'],
  ['quoted speech', '"Morgan Lee agreed to review the supplier checklist."', 'Morgan Lee agreed to review the supplier checklist.'],
  ['condition', 'Morgan Lee agreed to review the supplier checklist if funding is approved.', 'Morgan Lee agreed to review the supplier checklist.'],
  ['semicolon scope', 'If funding is approved; Morgan Lee agreed to review the supplier checklist.', 'Morgan Lee agreed to review the supplier checklist.'],
  ['additional obligation', 'Morgan Lee agreed to review the supplier checklist.', 'Morgan Lee agreed to review the supplier checklist and confirm the upload process.']
]) test(`a ${label} cannot supply a new assertion`, () => {
  assert.equal(correctionMeaningIssue(original, correction, [{id:'T0001',speaker:'Morgan Lee',text:source}]).reason,
    'correction_assertion_strength_not_proved');
});
test('a phase word in an unchanged sibling cannot authorise a new agreement', () => {
  assert.equal(correctionMeaningIssue('The supplier approved the checklist; Morgan can ask Alex.',
    'The supplier approved the checklist; Morgan agreed to ask Alex.', [] ).reason, 'correction_assertion_strength_not_proved');
});
test('existing unchanged assertions do not turn other editorial corrections into new commitments', () => {
  assert.deepEqual(correctionMeaningIssue('Morgan agreed to review the checklist; the upload folder is blue.',
    'Morgan agreed to review the checklist; the upload folder is green.', []), {sourceIds:[]});
});
test('duplicate source IDs cannot certify a new assertion', () => {
  const text = 'Morgan agreed to review the supplier checklist.';
  assert.equal(correctionMeaningIssue(original,text,[{id:'T1',text},{id:'T1',text}]).reason, 'correction_assertion_strength_not_proved');
});
test('source comparison preserves numeric signs, decimals and units', () => {
  for(const [source,claim] of [
    ['Morgan will pay £15.', 'Morgan will pay 15.'],
    ['Morgan will reduce the setting to -5.', 'Morgan will reduce the setting to 5.'],
    ['Morgan will use 1.5 mg.', 'Morgan will use 1 5 mg.'],
    ['Morgan will reduce the rate by 5%.', 'Morgan will reduce the rate by 5.']
  ]) assert.equal(correctionMeaningIssue(original,claim,[{id:'T1',text:source}]).reason,'correction_assertion_strength_not_proved');
});
test('nearby witnesses cannot silently donate an assertion absent from the saved citations', () => {
  const f = fixture('I agreed to ask Alex about the supplier checklist and upload process and project responsibilities.');
  const result=apply(f,'Morgan Lee agreed to ask Alex about the supplier checklist and upload process and project responsibilities.');
  assert.equal(result.corrected,0);
  assert.equal(result.accounting.items[0].reason,'correction_assertion_source_not_cited');
  assert.deepEqual(result.discussion[0].points[0].evidenceIds,['T0001']);
});
test('general unresolved fidelity warnings survive normalisation and flag reconciliation', () => {
  const f=fixture('The supplier checklist describes the upload process and project responsibilities.');
  const result=V.applyDiscussionFidelityResults(f.discussion,f.items,[{id:f.items[0].id,verdict:'uncertain',
    problemQuote:original,evidenceQuote:'',reason:'The source does not establish the responsibility.'}]);
  assert.equal(result.uncertain,1);
  const flag=V.normaliseFlag(result.flags[0]);
  assert.equal(V.isUsefulReviewFlag(flag),true);
  const restored=V.reconcileRecordFlags({discussion:result.discussion},[],V.isUsefulReviewFlag);
  assert.equal(restored.recovered,1);
  assert.deepEqual(restored.content.discussion[0].points[0].reviewFlagIds,[flag.id]);
});
test('reviewer-authored discussion is unchanged', () => {
  const f=fixture('I can ask Alex.',{reviewerAuthored:true});
  assert.equal(f.items.length,0);
  const result=V.applyDiscussionFidelityResults(f.discussion,f.items,[]);
  assert.deepEqual(result.discussion,f.discussion);
});
test('invalid referee targets are contract failures, independently of upstream status', () => {
  for(const statusCode of [0,400,502]) assert.equal(A.meetingAgentFailureClass({code:'invalid_referee_target',statusCode}),'response_contract');
  assert.equal(A.meetingAgentFailureClass({code:'network_timeout',statusCode:502}),'transport');
  assert.equal(A.meetingAgentFailureClass({code:'rate_limited',statusCode:429}),'rate_limit');
});
