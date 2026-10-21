'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../utils/meetingMinutesTemporalReview');
const V = require('../utils/meetingMinutesAgentV2');
const options = { meetingDate: '2026-06-22' };
const visit = 'The compliance visit is scheduled for five days.';
const reporting = 'Report preparation will follow during the next month.';
const compound = `${visit.slice(0, -1)} and ${reporting[0].toLowerCase()}${reporting.slice(1)}`;
const supported = (claim, source, type = 'discussion') => R.supportedByApprovedRecord(claim, { type, text: source }, options);

test('independent compound phases have the same temporal support as separate complete sentences', () => {
  for (const source of [compound, `${visit} ${reporting}`]) {
    assert.equal(supported(visit, source), true, source);
    assert.equal(supported(reporting, source), true, source);
  }
});

test('phase clips retain exact source offsets, complete subjects and original source text', () => {
  const source = `Chair: ${compound}`;
  const before = source;
  const clips = R.independentSourcePhaseClips(source);
  assert.equal(clips.length, 2);
  for (const clip of clips) assert.equal(source.slice(clip.start, clip.end), clip.text);
  assert.equal(clips[0].text, visit.slice(0, -1));
  assert.equal(clips[1].text, `${reporting[0].toLowerCase()}${reporting.slice(1)}`);
  assert.equal(source, before);
  assert.deepEqual(R.independentSourcePhaseClips(JSON.parse(JSON.stringify(source))), clips);
});

test('phase extraction remains bounded and leaves unfinished coordinated work unresolved', () => {
  assert.deepEqual(R.independentSourcePhaseClips(compound.repeat(30)), []);
  assert.deepEqual(R.independentSourcePhaseClips('The audit lasts five days and the review lasts two days and the testing lasts three days and the drafting lasts four days and the approval lasts six days.'), []);
  assert.deepEqual(R.independentSourcePhaseClips('The compliance visit is scheduled for five days and will resume next month.'), []);
});

for (const [name, claim, source] of [
  ['false date', 'The compliance visit is scheduled for Monday.', compound],
  ['false duration', visit.replace('five', 'seven'), compound],
  ['other work', visit.replace('compliance visit', 'safety training'), compound],
  ['sibling duration', visit.replace('five days', 'the next month'), compound],
  ['changed named actor', 'Casey will review the inspection report Friday.', 'Morgan will review the inspection report Friday and the supplier training will begin Monday.'],
  ['recipient as actor', 'Casey will send the inspection report Friday.', 'Morgan will send the inspection report to Casey Friday and the supplier training will begin Monday.'],
  ['speaker label as actor', 'Morgan will review the inspection report Friday.', 'Morgan: The team will review the inspection report Friday and the supplier training will begin Monday.'],
  ['shared pronoun', 'The inspection review will finish Friday.', 'The inspection review will finish Friday and it will resume Monday.'],
  ['same work multiple days', 'The inspection review will finish Monday.', 'The inspection review will finish Monday and Tuesday.'],
  ['same work alternative days', 'The inspection review will finish Monday.', 'The inspection review will finish Monday or Tuesday.'],
  ['range endpoint', 'The inspection review will finish within three weeks.', 'The inspection review will finish within two to three weeks and the supplier training will begin Monday.'],
  ['lost recurrence', 'The inspection review is scheduled Friday.', 'The inspection review is scheduled every Friday and the supplier training will begin Monday.'],
  ['lost upper bound', 'The inspection review will finish on Friday.', 'The inspection review will finish by Friday and the supplier training will begin Monday.'],
  ['clock conversion', 'The inspection review is scheduled Friday at 09:00 UTC.', 'The inspection review is scheduled Friday at 10:00 BST and the supplier training will begin Monday.']
]) {
  test(`phase separation cannot validate ${name}`, () => assert.equal(supported(claim, source), false));
}

for (const [name, source] of [
  ['prefix if', `If approval arrives, ${compound[0].toLowerCase()}${compound.slice(1)}`],
  ['prefix unless', `Unless approval is refused, ${compound[0].toLowerCase()}${compound.slice(1)}`],
  ['prefix only after', `Only after approval, ${compound[0].toLowerCase()}${compound.slice(1)}`],
  ['sequential phases', compound.replace(' and ', ' and then ')],
  ['trailing provided', `${compound.slice(0, -1)}, provided approval arrives.`],
  ['trailing subject to', `${compound.slice(0, -1)}, subject to approval.`],
  ['trailing as long as', `${compound.slice(0, -1)}, as long as approval arrives.`],
  ['pending approval', `${compound.slice(0, -1)}, pending approval.`],
  ['approval permitting', `${compound.slice(0, -1)}, approval permitting.`],
  ['condition of approval', `${compound.slice(0, -1)}, on condition of approval.`],
  ['assumed approval', `${compound.slice(0, -1)}, under an assumption of approval.`],
  ['draft plan', `${compound.slice(0, -1)}, in the draft plan.`],
  ['unapproved plan', `${compound.slice(0, -1)}, according to an unapproved plan.`],
  ['cancelled phases', `${compound.slice(0, -1)}, though both phases are cancelled.`],
  ['unpunctuated permission', `${compound.slice(0, -1)} approval permitting.`],
  ['unpunctuated condition', `${compound.slice(0, -1)} on condition of approval.`],
  ['unpunctuated assumption', `${compound.slice(0, -1)} under an assumption of approval.`],
  ['unpunctuated plan', `${compound.slice(0, -1)} in the draft plan.`],
  ['unpunctuated cancellation', `${compound.slice(0, -1)} though both phases are cancelled.`],
  ['parenthetical scope', `${compound.slice(0, -1)} (approval permitting).`],
  ['intervening scope', compound.replace('will follow during', 'will follow under an assumption of approval during')],
  ['unpunctuated permitting prefix', compound.replace('and report preparation', 'and approval permitting report preparation')],
  ['unpunctuated granted prefix', compound.replace('and report preparation', 'and approval granted report preparation')],
  ['unpunctuated given prefix', compound.replace('and report preparation', 'and given approval report preparation')],
  ['unpunctuated given suffix', compound.replace('and report preparation', 'and approval given report preparation')],
  ['short given prefix', compound.replace('and report preparation', 'and given approval training')],
  ['short given suffix', compound.replace('and report preparation', 'and approval given training')],
  ['prepositional prefix', compound.replace('and report preparation', 'and upon approval training')],
  ['bare conditional prefix', compound.replace('and report preparation', 'and absent approval training')],
  ['bare conditional suffix', compound.replace('and report preparation', 'and approval absent training')],
  ['capitalized conditional prefix', compound.replace('and report preparation', 'and Absent approval training')],
  ['prior sentence qualification', `This is subject to approval. ${compound}`],
  ['later sentence qualification', `${compound} This is subject to approval.`],
  ['conditional dates', `${compound} These dates remain conditional on approval.`],
  ['pending phases', `${compound} Both phases are pending approval.`],
  ['contingent phases', `${compound} Both phases are contingent on approval.`],
  ['tentative phases', `${compound} Both phases are tentative.`],
  ['contracted confirmation', `${compound} These dates aren’t confirmed.`],
  ['prior sentence uncertainty', `These dates are provisional. ${compound}`],
  ['trailing uncertainty', `${compound} Both phases may change.`],
  ['later shared date', `${compound} Both phases start Monday.`],
  ['prior shared clock', `Both phases start at 09:00 UTC. ${compound}`],
  ['local negation', compound.replace('is scheduled', 'is not scheduled')],
  ['contracted negation', compound.replace('is scheduled', "isn't scheduled")],
  ['local hedge', compound.replace('is scheduled', 'is probably scheduled')],
  ['dependency', compound.replace('for five days', 'for five days after panel approval')]
]) {
  test(`ambiguous ${name} cannot be dropped by clipping a quote`, () => {
    assert.equal(supported(visit, source), false);
    assert.deepEqual(R.independentSourcePhaseClips(source), []);
  });
}

test('independent clauses keep recurrence, full ranges, bounds, clock and zone constraints', () => {
  for (const timing of ['every Friday', 'within two to three weeks', 'by Friday', 'Friday at 10:00 BST']) {
    const claim = `The inspection review is scheduled ${timing}.`;
    const source = `${claim.slice(0, -1)} and the supplier training will begin Monday.`;
    assert.equal(supported(claim, source), true, timing);
  }
});

test('complete named event subjects remain attached to their own simple timing predicates', () => {
  const claim = 'Morgan Smith will begin Friday.';
  const source = `${claim.slice(0, -1)} and Casey Taylor will begin Monday.`;
  assert.equal(supported(claim, source), true);
  assert.equal(supported(claim.replace('Morgan', 'Casey'), source), false);
  assert.equal(supported('Morgan inspection review will begin Friday.', 'Morgan inspection review will begin Friday and Casey supplier training will begin Monday.'), false);
  const gerunds = 'Report writing will begin Monday and supplier training will begin Friday.';
  assert.equal(supported('Report writing will begin Monday.', gerunds), true);
  assert.equal(supported('Supplier training will begin Friday.', gerunds), true);
});

test('new phase acceptance cannot turn a qualified or extended source clause into a shorter claim', () => {
  for (const extra of [' at least', ' approximately', ' with a contingency', ' in the provisional plan']) {
    const source = compound.replace('for five days', `for${extra} five days`);
    assert.equal(supported(visit, source), false, source);
  }
});

test('full action timing labels never use the source phase fallback', () => {
  assert.equal(supported(visit, compound, 'action'), false);
  assert.equal(supported(visit, visit, 'action'), true);
  assert.equal(supported('Review the inspection report by Friday.', 'Review the inspection report. Owners: Morgan. Timing: Target: Friday.', 'action'), false);
  assert.equal(supported(visit, compound, 'unrecognised'), false);
});

test('real discussion fidelity removes a false timing warning only for a clean independently stated phase', () => {
  const units = [{ id: 'T0001', speaker: 'Chair', text: compound }];
  const discussion = [{ id: 'topic', topic: 'Review schedule', points: [{ id: 'visit', text: visit, evidenceIds: ['T0001'], supportingDetails: [], reviewFlagIds: [] }], decisions: [], openQuestions: [] }];
  const before = structuredClone(discussion);
  const items = V.discussionFidelityCheckItems(discussion, units, options);
  const replies = [{ id: items[0].id, verdict: 'supported', evidenceQuote: visit.slice(0, -1) }];
  const result = V.applyDiscussionFidelityResults(discussion, items, replies);
  assert.equal(result.accounting.complete, true);
  assert.equal(result.accounting.items[0].status, 'supported');
  assert.equal(result.flags.filter(flag => flag.kind === 'timing').length, 0);
  assert.deepEqual(result.discussion, before);
  assert.deepEqual(discussion, before);
  const normalized = V.normaliseAgentResult(JSON.parse(JSON.stringify(result)), units, 'discussion', options);
  assert.equal(normalized.discussion[0].points[0].text, visit);
  assert.deepEqual(normalized.discussion[0].points[0].evidenceIds, ['T0001']);
});

test('summary and objective verification use full approved records, retaining ambiguous conditions outside the quote', () => {
  for (const field of ['executiveSummary', 'meetingObjectives']) for (const qualified of [false, true]) {
    const source = qualified ? `This is subject to approval. ${compound}` : compound;
    const values = { executiveSummary: field === 'executiveSummary' ? visit : '', meetingObjectives: field === 'meetingObjectives' ? [{ id: 'objective', text: visit }] : [] };
    const current = { discussion: [{ points: [{ id: 'phases', text: source, evidenceIds: ['T0001'] }] }] };
    const items = R.summaryTemporalCheckItems(values, current);
    assert.equal(items.length, 1);
    const result = R.applySummaryTemporalCheckResults(values, items, [{ id: items[0].id, verdict: 'supported', evidenceQuote: visit.slice(0, -1) }], options);
    assert.equal(result.accounting.complete, !qualified);
    assert.equal(result.flags.length, qualified ? 1 : 0);
    assert.deepEqual(result.values, values);
  }
});

const Module = require('node:module');
let externalCalls = 0;
const forbidden = () => { externalCalls += 1; throw new Error('Source-phase publication tests prohibit external calls'); };
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'node-fetch') return forbidden;
  if (/(?:^|\/)utils\/(?:db|copilot|knowledge)$/.test(request)) return new Proxy({}, { get: () => forbidden });
  return originalLoad.call(this, request, parent, isMain);
};
const A = require('../routes/api').stagedEvaluation;
Module._load = originalLoad;
test.after(() => assert.equal(externalCalls, 0));

test('a verified clean phase survives repeated normalization and public/Word/PDF boundaries without invented content', () => {
  const units = [{ id: 'T0001', speaker: 'Chair', text: compound }];
  let draft = { draftId: 'source-phase', details: { meetingTitle: 'Review schedule', meetingDate: options.meetingDate },
    sourceUnits: units, discussion: [{ id: 'schedule', topic: 'Review schedule', points: [{ id: 'visit', text: visit, evidenceIds: ['T0001'], reviewFlagIds: [], supportingDetails: [] }], decisions: [], openQuestions: [] }], actions: [], reviewFlags: [], qualityState: {} };
  for (let repeat = 0; repeat < 3; repeat += 1) {
    const before = JSON.parse(JSON.stringify(draft));
    const items = V.discussionFidelityCheckItems(draft.discussion, units, options);
    const checked = V.applyDiscussionFidelityResults(draft.discussion, items, [{ id: items[0].id, verdict: 'supported', evidenceQuote: visit.slice(0, -1) }]);
    assert.equal(checked.accounting.complete, true);
    assert.deepEqual(checked.flags, []);
    const normalised = V.normaliseAgentResult(JSON.parse(JSON.stringify(checked)), units, 'discussion', options);
    const next = { ...draft, discussion: normalised.discussion, reviewFlags: normalised.reviewFlags };
    for (const output of [A.publicMeetingAgentDraft(next), A.meetingAgentDraftForDocx(next)]) {
      const row = output.discussion.flatMap(topic => topic.points).find(row => row.id === 'visit');
      assert.equal(row.text, visit);
      assert.deepEqual(row.evidenceIds, ['T0001']);
    }
    const pdf = A.meetingAgentDraftForPdf(next, true);
    assert.ok(pdf.discussion.some(topic => topic.points.includes(visit)));
    assert.deepEqual(pdf.evidenceAppendix.map(unit => unit.id), ['T0001']);
    assert.deepEqual(draft, before);
    draft = JSON.parse(JSON.stringify(next));
  }
});
