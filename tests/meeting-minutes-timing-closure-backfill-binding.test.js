'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');
const empty = () => ({ kind: 'not_stated', wording: '', exactDate: '' });
const options = { meetingDate: '2026-03-10' };
const source = rows => V.normaliseSourceUnits(rows.map(([speaker,text])=>({speaker,text})));
const action = (value, ids, timing=empty(), owners=['Morgan']) => ({id:'work',action:value,owners,timing,evidenceIds:ids,reviewFlagIds:[]});
function recovered(row, units) { return V.backfillActionCommitmentEvidence([row], units, options)[0]; }

test('an untimed owned task cannot inherit a separate cited task date', () => {
  const units=source([
    ['Morgan', "I will draft the stock report."],
    ['Chair', 'Please attach a diagram.'],
    ['Morgan', "I will draw one tomorrow."],
    ['Morgan', "I will draft the stock report this week."]
  ]);
  const row=action('Draft the stock report.',units.map(x=>x.id));
  const result=recovered(row,units);
  assert.equal(result.timing.wording,'this week');
  assert.equal(result.timing.exactDate,'');
});

test('same-turn work clauses choose their own date, not first or longest', () => {
  const units=source([['Morgan', 'I will call the courier tomorrow morning and I will draft the stock report Friday.']]);
  const row=action('Draft the stock report.',['T0001']);
  assert.equal(recovered(row,units).timing.wording,'friday');
  assert.equal(V.normaliseAgentResult({actions:[row]},units,'actions',options).actions[0].timing.wording,'friday');
});

test('cited timing inference needs the actual owner and preserves work when unproved', () => {
  const units=source([['Morgan', 'I will draft the stock report.'],['Casey','I will draft the stock report Friday.']]);
  const result=recovered(action('Draft the stock report.',['T0001','T0002']),units);
  assert.equal(result.timing.kind,'not_stated');
  assert.equal(result.action,'Draft the stock report.');
  const checked=V.finaliseActionTimings([result],units,options);
  assert.ok(checked.flags.some(flag=>flag.kind==='timing'));
});

test('separate unsettled timings for the same work are not arbitrarily selected', () => {
  const units=source([['Morgan','I will draft the stock report Friday.'],['Morgan','I will draft the stock report Monday.']]);
  assert.equal(recovered(action('Draft the stock report.',['T0001','T0002']),units).timing.kind,'not_stated');
});

test('source hedge, period and bounds survive inferred timing without a fabricated day', () => {
  for (const [text,wording] of [
    ['I will draft the stock report probably next week.','probably next week'],
    ['I will draft the stock report by Friday.','by friday'],
    ['I will draft the stock report Friday if possible.','friday if possible']
  ]) {
    const result=recovered(action('Draft the stock report.',['T0001']),source([['Morgan',text]]));
    assert.equal(result.timing.wording,wording,text);
    if (/probably|if possible/.test(wording)) assert.equal(result.timing.exactDate,'');
  }
});

test('when replies require their own task and owner, not merely nearby questions', () => {
  const cases=[
    [['Morgan','I will draft the stock report.'],['Morgan','I will call the courier.'],['Chair','When can you do that?'],['Morgan','Friday.']],
    [['Morgan','I will draft the stock report.'],['Chair','When can you do that?'],['Casey','Friday.']]
  ];
  for (const rows of cases) {
    const units=source(rows);
    assert.equal(recovered(action('Draft the stock report.',['T0001']),units).timing.kind,'not_stated');
  }
});

test('an owned bare when-answer and acknowledgement continuation still recover their date', () => {
  for (const rows of [
    [['Morgan','I will draft the stock report.'],['Chair','When can you do that?'],['Morgan','Friday.']],
    [['Morgan','I will draft the stock report.'],['Chair','Thank you.'],['Morgan','Friday.']]
  ]) assert.equal(recovered(action('Draft the stock report.',['T0001']),source(rows)).timing.wording,'friday');
});

test('an unrelated date choice cannot resolve the current task offer', () => {
  const units=source([
    ['Morgan', 'I will hold the stock review on the ninth or the tenth of July.'],
    ['Morgan', 'I will call the courier on the tenth of July.']
  ]);
  const timing={kind:'target',wording:'ninth or tenth of July',exactDate:''};
  const result=V.resolveOfferedDateChoice(timing,units,['T0001'],{...options,action:'Hold the stock review.',owners:['Morgan']});
  assert.deepEqual(result,timing);
});

test('a settled own-task date choice survives, without choosing its missing month', () => {
  const units=source([
    ['Morgan', 'I will hold the stock review on the ninth or the tenth.'],
    ['Morgan', 'The tenth suits better.'],
    ['Chair', 'Tenth it is.']
  ]);
  const timing={kind:'target',wording:'ninth or tenth',exactDate:''};
  const result=V.resolveOfferedDateChoice(timing,units,['T0001'],{...options,action:'Hold the stock review.',owners:['Morgan']});
  assert.equal(result.wording,'tenth');
  assert.equal(result.exactDate,'');
});

test('contextless inference is withheld while existing model and reviewer values remain untouched', () => {
  const units=source([['Morgan','I will draft the stock report.'],['Chair','By when?'],['Morgan','Friday.']]);
  assert.deepEqual(V.backfillAskedTiming(empty(),units,['T0001'],options),empty());
  const stated={kind:'target',wording:'probably next week',exactDate:''};
  assert.deepEqual(recovered(action('Draft the stock report.',['T0001'],stated),units).timing,stated);
  const manual={...action('Draft the stock report.',['T0001']),reviewerAuthored:true};
  assert.deepEqual(recovered(manual,units),manual);
});

test('original unanchored helper examples do not infer an unstated task or actor', () => {
  const reply=source([
    ['Robin', "That'd be me, I have the old contracts."],
    ['Chair','Good.'],['Robin','Ha, yes.'],['Chair','By when?'],['Robin','A fortnight.']
  ]);
  assert.deepEqual(V.backfillAskedTiming(empty(),reply,['T0001'],{...options,action:'Update the supplier list.',owners:['Robin']}),empty());
  const choice=source([
    ['Chair', "Let's put the follow-up in for the ninth or the tenth of July."],
    ['Lee Hart','The tenth suits better.'],['Chair','Tenth it is.']
  ]);
  const timing={kind:'target',wording:'ninth or tenth of July',exactDate:''};
  assert.deepEqual(V.resolveOfferedDateChoice(timing,choice,['T0001'],{...options,action:'Arrange the follow-up.',owners:['Lee Hart']}),timing);
});

test('timing questions for a named different person or operation cannot donate a deadline', () => {
  for (const question of ['When do you think, Casey?', 'When can you send the stock report?', 'When can you call the courier?']) {
    const units=source([['Morgan','I will draft the stock report.'],['Chair',question],['Morgan','Friday.']]);
    assert.equal(recovered(action('Draft the stock report.',['T0001']),units).timing.kind,'not_stated',question);
  }
});

test('readback proof cannot cross a new owned obligation or a different addressee', () => {
  const rows=[['Chair','The packing schedule needs a written justification for the loading sequence.'],['Morgan',"I'll draft that."],['Chair','When do you think, Morgan?'],['Morgan','It is a short document.'],['Chair','Okay so that is the fifteenth.']];
  const own={...options,action:'Draft the justification for the packing schedule and loading sequence.',owners:['Morgan']};
  const units=source(rows);
  assert.equal(V.backfillAskedTiming(empty(),units,['T0001','T0002'],own).wording,'the fifteenth');
  for (const changed of [
    rows.map((row,i)=>i===2?[row[0],'When do you think, Casey?']:row),
    rows.map((row,i)=>i===1?[row[0],"I'll draft the catering brief."]:row),
    ...['I need to call the courier.','I must send the invoice.','I can review the payment log.','I want Casey to repaint the garage.'].map(text=>rows.map((row,i)=>i===3?[row[0],text]:row))
  ]) assert.equal(V.backfillAskedTiming(empty(),source(changed),['T0001','T0002'],own).kind,'not_stated',JSON.stringify(changed));
});

test('named new-output timing does not become the date for sending or reviewing that output', () => {
  const units=source([['Morgan','Those need new inspection cards.'],['Chair','And Morgan, timeline on that?'],['Morgan','The three new inspection cards, this week.']]);
  for (const operation of ['Create','Review','Send']) {
    const result=recovered(action(`${operation} the three new inspection cards.`,['T0001']),units);
    assert.equal(result.timing.wording,operation==='Create'?'this week':'',operation);
  }
});

test('inference warnings are truthful and finalization does not mutate inputs', () => {
  const units=source([['Morgan','I will draft the stock report.'],['Morgan','I will call the courier tomorrow.']]);
  const input=action('Draft the stock report.',['T0001','T0002']);
  const before=structuredClone({input,units});
  const result=V.normaliseAgentResult({actions:[input]},units,'actions',options);
  assert.ok(result.reviewFlags.some(flag=>/not added/.test(flag.message)));
  assert.ok(result.reviewFlags.every(flag=>!/stated date was retained/.test(flag.message)));
  const backed=recovered(input,units), backedBefore=structuredClone(backed);
  const final=V.finaliseActionTimings([backed],units,options);
  assert.ok(final.flags.some(flag=>/not added/.test(flag.message)));
  assert.deepEqual(backed,backedBefore);
  assert.deepEqual({input,units},before);
  assert.ok(!('_timingRecoveryIssues' in final.actions[0]));
  const later={...backed,timing:{kind:'target',wording:'next week',exactDate:''},reviewerAuthored:true};
  assert.ok(V.finaliseActionTimings([later],units,options).flags.every(flag=>!/not added/.test(flag.message)), 'an old inference warning cannot claim a later reviewer value was not added');
});

test('a speaker narrating another actor or an ownerless record does not establish inferred timing', () => {
  for (const text of ['Casey can draft the stock report Friday.','Casey is going to draft the stock report Friday.','Casey will draft the stock report Friday.']) {
    const units=source([['Morgan',text]]);
    assert.equal(recovered(action('Draft the stock report.',['T0001']),units).timing.kind,'not_stated',text);
  }
  const units=source([['Morgan','I will draft the stock report Friday.']]);
  assert.equal(recovered(action('Draft the stock report.',['T0001'],empty(),[]),units).timing.kind,'not_stated');
});


test('a named-output reply cannot bind timing that explicitly names another step', () => {
  const units=source([['Morgan','Those need new inspection cards.'],['Chair','And Morgan, timeline on that?'],['Morgan','The three new inspection cards, Friday to send them.']]);
  assert.equal(recovered(action('Create the three new inspection cards.',['T0001']),units).timing.kind,'not_stated');
});


test('timing recovery preserves supplied evidence order and keeps a newly proved timing anchor within the cap', () => {
  const units=source([['Morgan','I will draft the stock report.'],['Chair','The stock report covers current warehouse quantities.'],...Array.from({length:6},()=>['Chair','The stock report needs all warehouse quantities.']),['Morgan','I will draft the stock report Friday.']]);
  const input=action('Draft the stock report.',['T0002','T0001']);
  assert.deepEqual(recovered({...input,timing:{kind:'target',wording:'next week',exactDate:''}},units).evidenceIds.slice(0,2),input.evidenceIds);
  const inferred=recovered(action('Draft the stock report.',units.slice(0,8).map(unit=>unit.id)),units);
  // This fixture has no cited date or when-answer; do not borrow a later
  // substantive promise merely because it is nearby.
  assert.equal(inferred.timing.kind,'not_stated');
  const asked=source([...Array.from({length:7},()=>['Chair','The stock report covers the warehouse.']),['Morgan','I will draft the stock report.'],['Chair','When can you do that?'],['Morgan','Friday.']]);
  const date=recovered(action(input.action,asked.slice(0,8).map(unit=>unit.id)),asked);
  assert.equal(date.timing.wording,'friday');
  assert.ok(date.evidenceIds.includes('T0010'));
  assert.ok(date.evidenceIds.includes('T0008'));
  assert.ok(date.evidenceIds.length<=8);
});
