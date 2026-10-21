'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../utils/meetingMinutesTemporalReview');
const V = require('../utils/meetingMinutesAgentV2');
const source = 'Report writing is scheduled for Tuesday and supplier training will begin Friday.';
const claim = 'Report preparation is scheduled for Tuesday.';
const record = { id: 'T1', type: 'discussion', text: source };
const evidence = { schemaVersion: 1, claimText: claim, sourceId: 'T1', sourceQuote: 'Report writing is scheduled for Tuesday',
  workSourceQuote: 'Report writing', workClaimQuote: 'Report preparation', qualificationQuotes: [] };
const assess = (row = claim, records = [record], mapping = evidence, options = {}) => R.validateTemporalEvidence(row, records, mapping, options);

test('an identified complete phase proves a generic nominalized work paraphrase without changing source', () => {
  const before = structuredClone({ record, evidence });
  assert.equal(R.supportedByApprovedRecord(claim, record), false);
  const result = assess();
  assert.equal(result.supported, true);
  assert.equal(result.binding.claimText, claim);
  assert.equal(record.text.slice(result.binding.start, result.binding.end), evidence.sourceQuote);
  assert.deepEqual({ record, evidence }, before);
  assert.deepEqual(assess(claim, JSON.parse(JSON.stringify([record])), JSON.parse(JSON.stringify(evidence))), result);
});

test('an attested shared condition can be retained while independently validating the phase duration', () => {
  const text = 'If access is approved, the inspection is scheduled for five days and report preparation will begin Monday.';
  const row = 'If access is approved, the inspection will last five days.';
  const mapping = { schemaVersion: 1, claimText: row, sourceId: 'T1', sourceQuote: 'the inspection is scheduled for five days',
    workSourceQuote: 'inspection', workClaimQuote: 'inspection', qualificationQuotes: ['If access is approved'] };
  assert.equal(assess(row, [{ ...record, text }], mapping).supported, true);
  const unconditional = 'The inspection will last five days.';
  for (const qualificationQuotes of [[], mapping.qualificationQuotes]) {
    assert.equal(assess(unconditional, [{ ...record, text }], { ...mapping, claimText: unconditional, qualificationQuotes }).supported, false);
  }
});

test('condition relocation preserves exact meaning without treating the model quote as authority', () => {
  const text = 'The inspection is scheduled for five days, if access is approved.';
  const row = 'If access is approved, the inspection will last five days.';
  const mapping = { schemaVersion: 1, claimText: row, sourceId: 'T1', sourceQuote: 'The inspection is scheduled for five days',
    workSourceQuote: 'inspection', workClaimQuote: 'inspection', qualificationQuotes: ['if access is approved'] };
  // Case is part of the exact source span, while prose comparison is case-insensitive.
  assert.equal(assess(row, [{ ...record, text }], mapping).supported, true);
});

for (const [name, change] of [
  ['wrong schema version', { schemaVersion: 2 }], ['unknown key', { trusted: true }],
  ['stale claim', { claimText: claim + ' ' }], ['unknown source', { sourceId: 'T9' }],
  ['fabricated quote', { sourceQuote: 'Report writing is scheduled for Monday' }],
  ['non-contiguous work', { workSourceQuote: 'Report Tuesday' }],
  ['invented claim work', { workClaimQuote: 'Supplier training' }],
  ['missing qualification collection', { qualificationQuotes: undefined }],
  ['duplicate qualification', { qualificationQuotes: ['if approved', 'if approved'] }],
  ['non-string qualification', { qualificationQuotes: [true] }]
]) test(`structured evidence rejects ${name}`, () => assert.equal(assess(claim, [record], { ...evidence, ...change }).supported, false));

test('repeated source IDs or repeated quote offsets cannot establish an identity', () => {
  assert.equal(assess(claim, [record, record]).supported, false);
  assert.equal(assess(claim, [{ ...record, text: `${source} ${source}` }]).supported, false);
});

const phaseCase = (row, phase, work = 'The inspection', extra = {}) => {
  const sourceText = `${phase} and report preparation will begin Friday.`;
  return assess(row, [{ ...record, text: sourceText }], { schemaVersion: 1, claimText: row, sourceId: 'T1', sourceQuote: phase,
    workSourceQuote: work, workClaimQuote: work, qualificationQuotes: [], ...extra });
};

for (const [name, row, phase, work] of [
  ['changed duration', 'The inspection will last seven days.', 'The inspection will last five days', 'The inspection'],
  ['changed start', 'The inspection will begin Tuesday.', 'The inspection will begin Monday', 'The inspection'],
  ['invented month', 'The inspection will begin on the 20th of July.', 'The inspection will begin on the 20th', 'The inspection'],
  ['end becoming start', 'The inspection will begin Monday.', 'The inspection will end Monday', 'The inspection'],
  ['duration becoming delay', 'The inspection will begin in five days.', 'The inspection will last five days', 'The inspection'],
  ['past becoming future', 'The inspection is scheduled for Monday.', 'The inspection was scheduled for Monday', 'The inspection'],
  ['capability becoming commitment', 'The inspection will last five days.', 'The inspection can last five days', 'The inspection'],
  ['upper bound becoming exact', 'The inspection will last five days.', 'The inspection will last up to five days', 'The inspection'],
  ['lower bound becoming exact', 'The inspection will last five days.', 'The inspection will last at least five days', 'The inspection'],
  ['lost season', 'The inspection will begin on the 20th.', 'The inspection will begin on the 20th in summer', 'The inspection'],
  ['lost uncertainty', 'The inspection is scheduled for Monday.', 'The inspection is probably scheduled for Monday', 'The inspection'],
  ['lost negation', 'The inspection will begin Monday.', 'The inspection will not begin Monday', 'The inspection'],
  ['recipient direction', 'Morgan will send the permit pack from Casey Monday.', 'Morgan will send the permit pack to Casey Monday', 'Morgan'],
  ['sequence reversal', 'Morgan will delete and then enter the permit pack Monday.', 'Morgan will enter and then delete the permit pack Monday', 'Morgan'],
  ['operation-object rebinding', 'Morgan will approve the permit pack and upload the release Monday.', 'Morgan will upload the permit pack and approve the release Monday', 'Morgan'],
  ['unresolved dependency', 'The inspection is scheduled for Monday after that is completed.', 'The inspection is scheduled for Monday after that is completed', 'The inspection']
]) test(`a real complete source quote cannot approve ${name}`, () => {
  const result = phaseCase(row, phase, work);
  assert.equal(result.supported, false, JSON.stringify(result));
  assert.notEqual(result.reason, 'malformed_temporal_evidence');
  assert.notEqual(result.reason, 'temporal_evidence_quote_not_unique');
});

test('an actor mentioned as recipient cannot become the independently quoted actor', () => {
  const row = 'Casey will send the permit pack Monday.';
  const phase = 'Morgan will send the permit pack to Casey Monday';
  const result = phaseCase(row, phase, 'send the permit pack');
  assert.equal(result.supported, false);
});

test('arbitrary fragments, date lists and embedded proposals are not complete source phases', () => {
  const row = 'The inspection will begin Monday.';
  const phase = 'The inspection will begin Monday';
  const mapping = { schemaVersion: 1, claimText: row, sourceId: 'T1', sourceQuote: phase,
    workSourceQuote: 'inspection', workClaimQuote: 'inspection', qualificationQuotes: [] };
  for (const text of [`The proposal that ${phase} was rejected.`, `${phase} and Tuesday.`, `The report says that ${phase}.`, `Will ${phase}?`]) {
    assert.equal(assess(row, [{ ...record, text }], mapping).supported, false, text);
  }
});

test('a later source correction or external same-work qualification remains part of the assessment', () => {
  assert.equal(assess(claim, [{ ...record, text: `${source} Report writing is scheduled for Thursday.` }]).supported, false);
  for (const text of ['These dates are tentative.', 'Report writing is conditional on approval.', 'Report writing is scheduled for Thursday.']) {
    assert.equal(assess(claim, [record], evidence, { contextRecords: [record, { id: 'T2', text }] }).supported, false, text);
  }
});

test('the complete established action authority remains compatible while action fragments cannot gain authority', () => {
  const text = 'Send the permit pack. Owners: Morgan. Timing: Deadline: Friday.';
  const row = 'Send the permit pack by Friday.';
  assert.equal(R.supportedByApprovedRecord(row, { type: 'action', text }), true);
  const mapping = { schemaVersion: 1, claimText: row, sourceId: 'A1', sourceQuote: text,
    workSourceQuote: 'Send the permit pack', workClaimQuote: 'Send the permit pack', qualificationQuotes: [] };
  assert.equal(assess(row, [{ id: 'A1', type: 'action', text }], mapping).supported, true);
  assert.equal(assess(row, [{ id: 'A1', type: 'action', text }], { ...mapping, sourceQuote: 'Send the permit pack.' }).supported, false);
});

test('summary and objectives use the same optional contract and preserve failed claims for review', () => {
  const current = { discussion: [{ points: [{ text: source, evidenceIds: ['T1'] }] }], actions: [] };
  for (const field of ['executiveSummary', 'meetingObjectives']) {
    const values = field === 'executiveSummary' ? { executiveSummary: claim, meetingObjectives: [] }
      : { executiveSummary: '', meetingObjectives: [claim] };
    const items = R.summaryTemporalCheckItems(values, current);
    const mapping = { ...evidence, sourceId: items[0].authorityRecords[0].id };
    const replies = [{ id: items[0].id, verdict: 'supported', evidenceQuote: evidence.sourceQuote, temporalEvidence: mapping }];
    const result = R.applySummaryTemporalCheckResults(values, items, replies);
    assert.equal(result.accounting.complete, true);
    assert.deepEqual(result.values, values);
    assert.equal(result.flags.length, 0);
    const invalid = R.applySummaryTemporalCheckResults(values, items, [{ ...replies[0], temporalEvidence: { ...mapping, sourceId: 'D999' } }]);
    assert.equal(invalid.accounting.complete, false);
    assert.deepEqual(invalid.values, values);
    assert.equal(invalid.flags.length, 1);
    assert.match(R.summaryTemporalCheckPrompt(items), /sourceRecords/);
  }
});

test('season-only timing reaches verification while ordinary falling remains a non-temporal verb', () => {
  assert.equal(R.temporalClaim('The inspection is planned for summer.'), true);
  assert.equal(R.temporalClaim('The inspection is planned for winter.'), true);
  assert.equal(R.temporalClaim('The inspection is planned for fall.'), true);
  assert.equal(R.temporalClaim('The equipment could fall.'), false);
  assert.equal(R.temporalClaim('The equipment will fall into the container.'), false);
  assert.equal(R.temporalClaim('The spring latch is ready for inspection.'), false);
  assert.equal(R.temporalClaim('Summer Lane approved the inspection.'), false);
  assert.equal(R.temporalClaim('The spring latch is ready for inspection in summer.'), true);
  assert.equal(R.temporalClaim('The inspection is scheduled for summer 2027.'), true);
  assert.equal(R.temporalClaim('Summer 2027 is the inspection period.'), true);
});

for (const [name, row, original, expected] of [
  ['unchanged season', 'The inspection is scheduled for summer.', 'The inspection is scheduled for summer.', true],
  ['changed season', 'The inspection is scheduled for winter.', 'The inspection is scheduled for summer.', false],
  ['lost season', 'The inspection is scheduled.', 'The inspection is scheduled for summer.', false],
  ['invented month', 'The inspection is scheduled for July.', 'The inspection is scheduled for summer.', false],
  ['relative season', 'The inspection is scheduled for next summer.', 'The inspection is scheduled for this summer.', false],
  ['season year', 'The inspection is scheduled for summer 2028.', 'The inspection is scheduled for summer 2027.', false],
  ['lost seasonal phase', 'The inspection is scheduled for summer.', 'The inspection is scheduled for early summer.', false],
  ['season spelling equivalent', 'The inspection is scheduled for autumn.', 'The inspection is scheduled for fall.', true]
]) test(`temporal meaning preserves ${name}`, () => assert.equal(R.temporalMeaningRetained(row, original), expected));

test('an engineering spring noun does not turn an ordinary supported row into a timing failure', () => {
  const text = 'The spring latch is ready for inspection.';
  const units = [{ id: 'T1', speaker: 'Chair', text }];
  const discussion = [{ id: 'topic', topic: 'Equipment', points: [{ id: 'latch', text, evidenceIds: ['T1'], supportingDetails: [] }], decisions: [], openQuestions: [] }];
  const items = V.discussionFidelityCheckItems(discussion, units);
  const result = V.applyDiscussionFidelityResults(discussion, items, [{ id: items[0].id, verdict: 'supported' }]);
  assert.equal(result.accounting.complete, true);
  assert.equal(result.flags.filter(flag => flag.kind === 'timing').length, 0);
  assert.equal(result.discussion[0].points[0].text, text);
});

test('season-only summary errors retain their source warning through the legacy result contract', () => {
  const current = { discussion: [{ points: [{ text: 'The inspection is scheduled for summer.', evidenceIds: ['T1'] }] }] };
  const values = { executiveSummary: 'The inspection is scheduled for winter.', meetingObjectives: [] };
  const items = R.summaryTemporalCheckItems(values, current);
  assert.equal(items.length, 1);
  const result = R.applySummaryTemporalCheckResults(values, items, [{ id: items[0].id, verdict: 'supported', evidenceQuote: 'The inspection is scheduled for summer.' }]);
  assert.equal(result.accounting.complete, false);
  assert.equal(result.flags.length, 1);
  assert.deepEqual(result.values, values);
});

for (const [name, row, original, expected] of [
  ['unchanged historical schedule', 'The inspection was scheduled for Monday.', 'The inspection was scheduled for Monday.', true],
  ['historical to current schedule', 'The inspection is scheduled for Monday.', 'The inspection was scheduled for Monday.', false],
  ['current to historical schedule', 'The inspection was scheduled for Monday.', 'The inspection is scheduled for Monday.', false],
  ['historical plan to current plan', 'The inspection is planned for Monday.', 'The inspection had been planned for Monday.', false],
  ['unchanged capability', 'The inspection can last five days.', 'The inspection can last five days.', true],
  ['capability to commitment', 'The inspection will last five days.', 'The inspection can last five days.', false],
  ['capability to different uncertainty', 'The inspection may last five days.', 'The inspection can last five days.', false],
  ['unchanged upper duration bound', 'The inspection will last up to five days.', 'The inspection will last up to five days.', true],
  ['lost upper duration bound', 'The inspection will last five days.', 'The inspection will last up to five days.', false],
  ['reversed duration bound', 'The inspection will last at least five days.', 'The inspection will last up to five days.', false],
  ['unchanged lower duration bound', 'The inspection will last at least five days.', 'The inspection will last at least five days.', true],
  ['lost lower duration bound', 'The inspection will last five days.', 'The inspection will last at least five days.', false],
  ['inclusive to exclusive upper bound', 'The inspection will last less than five days.', 'The inspection will last at most five days.', false],
  ['inclusive to exclusive lower bound', 'The inspection will last more than five days.', 'The inspection will last at least five days.', false],
  ['same inclusive upper equivalent', 'The inspection will last at most five days.', 'The inspection will last up to five days.', true],
  ['bound remains attached to its own quantity', 'The inspection will last at least five days and at most three hours.', 'The inspection will last at most five days and at least three hours.', false]
]) test(`legacy temporal meaning preserves ${name}`, () => assert.equal(R.temporalMeaningRetained(row, original), expected));

test('legacy source binding cannot bypass historical and scalar qualification checks when no new contract was supplied', () => {
  for (const [row, text] of [
    ['The inspection is scheduled for Monday.', 'The inspection was scheduled for Monday.'],
    ['The inspection will last five days.', 'The inspection will last up to five days.'],
    ['The inspection will last five days.', 'The inspection will last at least five days.']
  ]) {
    assert.equal(R.supportedByApprovedRecord(row, { type: 'discussion', text }), false);
    const values = { executiveSummary: row, meetingObjectives: [] };
    const items = R.summaryTemporalCheckItems(values, { discussion: [{ points: [{ text, evidenceIds: ['T1'] }] }] });
    const result = R.applySummaryTemporalCheckResults(values, items, [{ id: items[0].id, verdict: 'supported', evidenceQuote: text }]);
    assert.equal(result.accounting.complete, false);
    assert.equal(result.flags.length, 1);
    assert.deepEqual(result.values, values);
  }
});

test('an exact full-record question or attribution retains its own modality rather than becoming a new fact', () => {
  for (const text of ['Will the inspection begin Monday?', 'The team proposed that the inspection will begin Monday.']) {
    const mapping = { schemaVersion: 1, claimText: text, sourceId: 'T1', sourceQuote: text,
      workSourceQuote: 'inspection', workClaimQuote: 'inspection', qualificationQuotes: [] };
    assert.equal(assess(text, [{ ...record, text }], mapping).supported, true);
    const changed = 'The inspection will begin Monday.';
    assert.equal(assess(changed, [{ ...record, text }], { ...mapping, claimText: changed }).supported, false);
  }
  const text = 'The inspection will begin Monday?';
  const changed = 'The inspection will begin Monday.';
  const mapping = { schemaVersion: 1, claimText: changed, sourceId: 'T1', sourceQuote: text,
    workSourceQuote: 'inspection', workClaimQuote: 'inspection', qualificationQuotes: [] };
  assert.equal(assess(changed, [{ ...record, text }], mapping).supported, false);
});

const reportPhase = 'Report preparation is scheduled for Tuesday';
const reportClaim = reportPhase + '.';
function assessReportPhase(text, options = {}) {
  return assess(reportClaim, [{ ...record, text }], { schemaVersion: 1, claimText: reportClaim, sourceId: 'T1', sourceQuote: reportPhase,
    workSourceQuote: 'Report preparation', workClaimQuote: 'Report preparation', qualificationQuotes: [] }, options);
}

for (const other of [
  'The inspection may last five days',
  'The inspection will last five days in summer',
  'The inspection may last five days in summer',
  'The inspection could last five days during next winter',
  'The inspection can last five days in the summer 2027'
]) test(`an explicitly independent phase keeps its local qualifiers: ${other}`, () => {
  for (const text of [`${other} and ${reportPhase}.`, `${reportPhase} and ${other}.`]) {
    assert.equal(assessReportPhase(text).supported, true, text);
  }
});

for (const [name, text] of [
  ['shared prefix hedge', `Probably the inspection will last five days and ${reportPhase}.`],
  ['short shared prefix hedge', `Probably inspection will last five days and ${reportPhase}.`],
  ['shared prefix seasonal scope', `In summer the inspection will last five days and ${reportPhase}.`],
  ['bare prefix seasonal scope', `Summer inspection will last five days and ${reportPhase}.`],
  ['condition', `If access is approved, the inspection may last five days in summer and ${reportPhase}.`],
  ['shared trailing hedge', `The inspection will last five days and ${reportPhase}. Both phases may change.`],
  ['shared trailing season', `The inspection will last five days and ${reportPhase}. Both phases are in summer.`],
  ['unpunctuated trailing hedge', `The inspection will last five days and ${reportPhase} probably.`],
  ['shared trailing condition', `The inspection may last five days in summer and ${reportPhase}, approval permitting.`],
  ['same work', `Report preparation may last five days in summer and ${reportPhase}.`],
  ['same work morphology', `Report writing may last five days in summer and ${reportPhase}.`],
  ['overlapping work subject', `Report inspection may last five days in summer and ${reportPhase}.`],
  ['unresolved pronominal subject', `It may last five days in summer and ${reportPhase}.`],
  ['unknown qualification', `The inspection may last five days in summer under an assumption of approval and ${reportPhase}.`],
  ['unknown suffix', `The inspection may last five days in summer with dates to be agreed and ${reportPhase}.`],
  ['uncertainty outside the modal slot', `The inspection is probably scheduled for five days in summer and ${reportPhase}.`],
  ['multiple uncertainty markers', `The inspection may last approximately five days in summer and ${reportPhase}.`],
  ['sequence', `The inspection may last five days in summer and then ${reportPhase}.`],
  ['alternative', `The inspection may last five days in summer or ${reportPhase}.`],
  ['negation', `The inspection may not last five days in summer and ${reportPhase}.`],
  ['unknown extra date in phase', `The inspection may last five days and Monday and ${reportPhase}.`]
]) test(`partitioning cannot remove ${name}`, () => assert.equal(assessReportPhase(text).supported, false, text));

test('phase partitioning retains the selected phase own hedge and season', () => {
  for (const [row, target] of [
    ['Report preparation will begin Tuesday.', 'Report preparation may begin Tuesday'],
    [reportClaim, reportPhase + ' in summer']
  ]) {
    const text = `The inspection may last five days in summer and ${target}.`;
    const result = assess(row, [{ ...record, text }], { schemaVersion: 1, claimText: row, sourceId: 'T1', sourceQuote: target,
      workSourceQuote: 'Report preparation', workClaimQuote: 'Report preparation', qualificationQuotes: [] });
    assert.equal(result.supported, false, text);
    assert.equal(result.reason, 'temporal_source_qualification_not_retained');
  }
  const text = `The inspection may last five days in summer and ${reportPhase}.`;
  assert.equal(assessReportPhase(text, { contextRecords: [{ ...record, text }, { id: 'T2', text: 'Both phases remain provisional.' }] }).supported, false);
});

for (const prefix of ['Apparently', 'Potentially', 'Provisionally', 'Allegedly', 'Conditionally', 'Suppose', 'Assume', 'Imagine', 'Say', 'Absent']) {
  test(`phase partitioning leaves an unproved prefix in full context: ${prefix}`, () => {
    const text = `${prefix} inspection may last five days in summer and ${reportPhase}.`;
    assert.equal(assessReportPhase(text).supported, false, text);
  });
}

test('ignored source subjects require one bare word or an explicit nominal article', () => {
  const plain = `Inspection may last five days in summer and ${reportPhase}.`;
  const explicit = `The supplier training may last five days in summer and ${reportPhase}.`;
  const bareCompound = `Supplier training may last five days in summer and ${reportPhase}.`;
  assert.equal(assessReportPhase(plain).supported, true);
  assert.equal(assessReportPhase(explicit).supported, true);
  assert.equal(assessReportPhase(bareCompound).supported, false);
  for (const subject of ['The apparently inspection', 'The pending inspection', 'The accepted inspection', 'Given inspection']) {
    assert.equal(assessReportPhase(`${subject} may last five days in summer and ${reportPhase}.`).supported, false, subject);
  }
});

test('non-temporal season nouns in an unrelated source clause do not qualify the selected timing phase', () => {
  for (const other of ['The spring latch is ready', 'Summer Lane approved the inspection']) {
    const text = `${other} and ${reportPhase}.`;
    assert.equal(assessReportPhase(text).supported, true, text);
  }
  for (const text of [
    `The spring latch is ready in summer and ${reportPhase}.`,
    `The spring latch is ready and ${reportPhase} in summer.`
  ]) {
    const selected = text.includes(`${reportPhase} in summer`) ? `${reportPhase} in summer` : reportPhase;
    const result = assess(reportClaim, [{ ...record, text }], { schemaVersion: 1, claimText: reportClaim, sourceId: 'T1', sourceQuote: selected,
      workSourceQuote: 'Report preparation', workClaimQuote: 'Report preparation', qualificationQuotes: [] });
    assert.equal(result.supported, false, text);
    assert.equal(result.reason, 'temporal_source_qualification_not_retained');
  }
});

test('three or four independently proved article-prefixed event subjects can retain local phase qualifiers', () => {
  for (const others of [
    ['The inspection may last five days in summer', 'The audit will begin Monday'],
    ['The inspection may last five days in summer', 'The audit will begin Monday', 'The supplier training will begin Friday']
  ]) {
    for (const phases of [[...others, reportPhase], [reportPhase, ...others]]) {
      assert.equal(assessReportPhase(phases.join(' and ') + '.').supported, true);
    }
  }
  const bareCompound = `The inspection may last five days in summer and supplier training will begin Friday and ${reportPhase}.`;
  assert.equal(assessReportPhase(bareCompound).supported, false);
});
