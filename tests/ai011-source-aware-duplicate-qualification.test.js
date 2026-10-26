'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  dedupeHybridActionRecords,
  reconcileFinalApprovedActions
} = require('../routes/api').stagedEvaluation;
const { mergeCommitmentDuplicates } = require('../utils/canonicalMinutes/commitmentDuplicates');

const timing = (wording, kind = 'dependency') => ({ kind, wording, exactDate: '' });
const untimed = () => ({ kind: 'not_stated', wording: '', exactDate: '' });

function source(id, text, speaker = 'Morgan Lee') {
  return { id, speaker, text };
}

function row(id, action, owners, timingValue, evidenceIds) {
  return {
    id,
    action,
    owners,
    timing: timingValue,
    evidenceIds,
    reviewFlagIds: []
  };
}

function assertSourceBound(rows, sourceUnits) {
  const known = new Set(sourceUnits.map(unit => unit.id));
  for (const record of rows) {
    assert.ok(record.evidenceIds.length, `${record.id} must cite source evidence`);
    assert.ok(record.evidenceIds.every(id => known.has(id)), `${record.id} cites an unknown source`);
  }
}

function qualify(rows, sourceUnits) {
  assertSourceBound(rows, sourceUnits);
  const commitment = mergeCommitmentDuplicates(structuredClone(rows), { sourceUnits }).actions;
  const hybrid = dedupeHybridActionRecords(structuredClone(rows), { sourceUnits });
  const final = reconcileFinalApprovedActions(hybrid, structuredClone(rows), { sourceUnits });
  const published = dedupeHybridActionRecords(final.actions, { sourceUnits });
  return { commitment, hybrid, final: final.actions, published, restored: final.restored };
}

test('marketing-plan drafting keeps narrower and broader source-bound scope separate', () => {
  const sources = [
    source('AI011-M01', 'Morgan will draft the campaign overview.'),
    source('AI011-M02', 'Morgan will draft the campaign overview and the email copy.')
  ];
  const rows = [
    row('marketing-short', 'Draft the campaign overview.', ['Morgan Lee'], timing('by Friday'), ['AI011-M01']),
    row('marketing-rich', 'Draft the campaign overview and email copy.', ['Morgan Lee'], timing('by Friday'), ['AI011-M01', 'AI011-M02'])
  ];
  const result = qualify(rows, sources);
  assert.equal(result.commitment.length, 2);
  assert.equal(result.hybrid.length, 2);
  assert.equal(result.final.length, 2);
});

test('marketing-plan review keeps source-bound Wednesday timing variants separate', () => {
  const sources = [
    source('AI011-R01', 'Morgan will review the marketing plan on Wednesday.'),
    source('AI011-R02', 'Morgan will review the marketing plan by Wednesday.')
  ];
  const rows = [
    row('review-on', 'Review the marketing plan.', ['Morgan Lee'], timing('on Wednesday', 'deadline'), ['AI011-R01']),
    row('review-by', 'Review the marketing plan.', ['Morgan Lee'], timing('by Wednesday', 'deadline'), ['AI011-R02'])
  ];
  const result = qualify(rows, sources);
  assert.equal(result.commitment.length, 2);
  assert.equal(result.hybrid.length, 2);
  assert.equal(result.final.length, 2);
});

test('same review with an explicitly sourced later-meeting context has one complete row', () => {
  const sources = [source('REVIEW-01', 'You review on Wednesday, and then we go into the meeting on Thursday.')];
  const rows = [
    row('review-short', 'Review the draft before the meeting.', ['Morgan Lee'], timing('on Wednesday', 'target'), ['REVIEW-01']),
    row('review-context', 'Review the draft before the meeting.', ['Morgan Lee'], timing('Wednesday before the Thursday meeting', 'target'), ['REVIEW-01'])
  ];
  rows[0].reviewFlagIds = ['first-review'];
  rows[1].reviewFlagIds = ['second-review'];
  const result = qualify(rows, sources);
  assert.equal(result.hybrid.length, 1);
  assert.equal(result.final.length, 1);
  assert.equal(result.published.length, 1);
  assert.equal(result.published[0].timing.wording, 'Wednesday before the Thursday meeting');
  assert.deepEqual(new Set(result.published[0].reviewFlagIds), new Set(['first-review', 'second-review']));
  assert.deepEqual(result.restored, []);
  for (const [published, approved] of [[rows[0], rows[1]], [rows[1], rows[0]]]) {
    const reconciled = reconcileFinalApprovedActions([published], [approved], { sourceUnits: sources });
    assert.equal(reconciled.actions.length, 1);
    assert.equal(reconciled.actions[0].timing.wording, 'Wednesday before the Thursday meeting');
    assert.deepEqual(new Set(reconciled.actions[0].reviewFlagIds), new Set(['first-review', 'second-review']));
  }
});

test('review timing context cannot hide a distinct occurrence or unsupported meeting', () => {
  const sourceText = 'You review on Wednesday, and then we go into the meeting on Thursday.';
  const first = row('review-a', 'Review the draft before the meeting.', ['Morgan Lee'], timing('on Wednesday', 'target'), ['REVIEW-01']);
  const context = row('review-b', first.action, first.owners, timing('Wednesday before the Thursday meeting', 'target'), ['REVIEW-01']);
  const variants = [
    { ...context, owners: ['Casey Green'] },
    { ...context, evidenceIds: ['REVIEW-02'] },
    { ...context, timing: timing('Wednesday before the Friday meeting', 'target') },
    { ...context, timing: timing('Wednesday before the Thursday meeting', 'deadline') },
    { ...context, timing: { ...context.timing, exactDate: '2026-10-28' } },
    { ...context, reviewerAuthored: true },
    { ...context, action: 'Review the other draft before the meeting.' }
  ];
  for (const variant of variants) {
    assert.equal(dedupeHybridActionRecords([first, variant], { sourceUnits: [source('REVIEW-01', sourceText)] }).length, 2);
  }
  assert.equal(dedupeHybridActionRecords([first, context], {
    sourceUnits: [source('REVIEW-01', 'You review on Wednesday, and meet the client on Thursday.')]
  }).length, 2);
});

test('webinar invitations keep different source-bound prerequisites separate', () => {
  const sources = [
    source('AI011-W01', 'Morgan will send the webinar invitations once the attendee list is approved.'),
    source('AI011-W02', 'Morgan will send the webinar invitations after the speaker confirms availability.')
  ];
  const rows = [
    row('webinar-list', 'Send webinar invitations once the attendee list is approved.', ['Morgan Lee'], timing('before the webinar'), ['AI011-W01']),
    row('webinar-speaker', 'Send webinar invitations after the speaker confirms availability.', ['Morgan Lee'], timing('before the webinar'), ['AI011-W02'])
  ];
  const result = qualify(rows, sources);
  assert.equal(result.commitment.length, 2);
  assert.equal(result.hybrid.length, 2);
  assert.equal(result.final.length, 2);
});

test('Olympus agenda short wording is safely consolidated into the source-supported detailed instruction', () => {
  const sources = [
    source('AI011-O01', 'Morgan will prepare the Olympus agenda.'),
    source('AI011-O02', 'Morgan will prepare the Olympus agenda, including the risk review and decision log.')
  ];
  const rows = [
    row('olympus-short', 'Prepare the Olympus agenda.', ['Morgan Lee'], timing('for Thursday', 'target'), ['AI011-O01']),
    row('olympus-rich', 'Prepare the Olympus agenda, including the risk review and decision log.', ['Morgan Lee'], timing('for Thursday', 'target'), ['AI011-O01', 'AI011-O02'])
  ];
  const result = qualify(rows, sources);
  assert.equal(result.commitment.length, 1);
  assert.equal(result.hybrid.length, 1);
  assert.equal(result.final.length, 1);
  assert.equal(result.final[0].id, 'olympus-rich');
  assert.match(result.final[0].action, /risk review and decision log/);
});

test('Zimmer responsibility rows remain separate when source-bound owners differ', () => {
  const sources = [
    source('AI011-Z01', 'Morgan will coordinate the Zimmer follow-up.'),
    source('AI011-Z02', 'Casey will coordinate the Zimmer follow-up.', 'Casey Green')
  ];
  const rows = [
    row('zimmer-morgan', 'Coordinate the Zimmer follow-up.', ['Morgan Lee'], timing('next week', 'target'), ['AI011-Z01']),
    row('zimmer-casey', 'Coordinate the Zimmer follow-up.', ['Casey Green'], timing('next week', 'target'), ['AI011-Z02'])
  ];
  const result = qualify(rows, sources);
  assert.equal(result.commitment.length, 2);
  assert.equal(result.hybrid.length, 2);
  assert.equal(result.final.length, 2);
});

test('source-bound responsibility paraphrase with the same work and weekday has one published row', () => {
  const sources = [source('ROLE-01', 'Morgan will clarify who is in charge of the renewal and determine the next steps.')];
  const rows = [
    row('role-a', 'Clarify who is responsible for the renewal and determine the next steps.', [], timing('Tuesday', 'target'), ['ROLE-01']),
    row('role-b', 'Clarify who is in charge of the renewal and determine the next steps.', [], timing('on Tuesday', 'target'), ['ROLE-01'])
  ];
  rows[0].reviewFlagIds = ['flag-a'];
  rows[1].reviewFlagIds = ['flag-b'];
  rows[0]._weakEvidenceIds = ['old-source'];
  const result = qualify(rows, sources);
  assert.equal(result.hybrid.length, 1);
  assert.equal(result.final.length, 1);
  assert.equal(result.published.length, 1);
  assert.match(result.published[0].action, /in charge of/);
  assert.deepEqual(new Set(result.published[0].reviewFlagIds), new Set(['flag-a', 'flag-b']));
  assert.deepEqual(result.published[0]._weakEvidenceIds, ['old-source']);
});

test('responsibility wording cannot merge distinct owners, dates, work or unsupported citations', () => {
  const sources = [source('ROLE-01', 'Morgan will clarify who is in charge of the renewal and determine the next steps.')];
  const base = row('role-a', 'Clarify who is in charge of the renewal and determine the next steps.', ['Morgan Lee'], timing('on Tuesday', 'target'), ['ROLE-01']);
  const variants = [
    row('owner', 'Clarify who is responsible for the renewal and determine the next steps.', ['Casey Green'], timing('Tuesday', 'target'), ['ROLE-01']),
    row('date', 'Clarify who is responsible for the renewal and determine the next steps.', ['Morgan Lee'], timing('Wednesday', 'target'), ['ROLE-01']),
    row('work', 'Clarify who is responsible for the contract and determine the next steps.', ['Morgan Lee'], timing('Tuesday', 'target'), ['ROLE-01']),
    row('source', 'Clarify who is responsible for the renewal and determine the next steps.', ['Morgan Lee'], timing('Tuesday', 'target'), ['ROLE-02'])
  ];
  for (const variant of variants) {
    assert.equal(dedupeHybridActionRecords([base, variant], { sourceUnits: sources }).length, 2, variant.id);
  }
  const reviewer = { ...variants[0], id: 'reviewer', owners: ['Morgan Lee'], reviewerAuthored: true };
  assert.equal(dedupeHybridActionRecords([base, reviewer], { sourceUnits: sources }).length, 2);
});

test('Canva webinar discussion remains separate when the source-bound owner scope expands', () => {
  const sources = [
    source('AI011-C01', 'Morgan will update the Canva webinar slides.'),
    source('AI011-C02', 'Morgan and Casey will update the Canva webinar slides.')
  ];
  const rows = [
    row('canva-morgan', 'Update the Canva webinar slides.', ['Morgan Lee'], timing('before the webinar'), ['AI011-C01']),
    row('canva-team', 'Update the Canva webinar slides.', ['Morgan Lee', 'Casey Green'], timing('before the webinar'), ['AI011-C02'])
  ];
  const result = qualify(rows, sources);
  assert.equal(result.commitment.length, 2);
  assert.equal(result.hybrid.length, 2);
  assert.equal(result.final.length, 2);
});

function assertSingleSourceBoundSurvivor(result, expectedParts) {
  for (const stage of [result.commitment, result.hybrid, result.final, result.published]) {
    assert.equal(stage.length, 1);
    for (const part of expectedParts) assert.match(stage[0].action, new RegExp(part, 'i'));
  }
  assert.deepEqual(result.restored, []);
}

test('GSOP review follow-up paraphrases consolidate with reviewer and procedure context retained', () => {
  const sources = [
    source('AI011-GSOP-01', "Claire will follow up on Louise's review of the GSOP procedure documentation.", 'Claire Nicholson'),
    source('AI011-GSOP-02', 'Claire will follow up on the GSOP procedure review with Louise.', 'Claire Nicholson')
  ];
  const evidenceIds = sources.map(item => item.id);
  const rows = [
    row('gsop-a', "Follow up on Louise's review of the GSOP procedure documentation.", ['Claire Nicholson'], untimed(), evidenceIds),
    row('gsop-b', 'Follow up on the GSOP procedure review with Louise.', ['Claire Nicholson'], untimed(), evidenceIds)
  ];
  assertSingleSourceBoundSurvivor(qualify(rows, sources), ['GSOP', 'Louise', 'review']);
});

test('source-aware paraphrases with identical explicit timing consolidate without losing timing or review history', () => {
  const sources = [source('TRAIN-01', 'Morgan will teach Casey to build projects in Asana using the same approach Morgan currently uses.')];
  const rows = [
    row('teach-a', 'Teach Casey to build projects in Asana using the same approach currently being used.', ['Morgan Lee'], timing('one week after Casey returns'), ['TRAIN-01']),
    row('teach-b', 'Teach Casey to build projects in Asana using the same approach currently used by Morgan Lee.', ['Morgan Lee'], timing('one week after Casey returns'), ['TRAIN-01'])
  ];
  rows[0].reviewFlagIds = ['timing-a'];
  rows[1].reviewFlagIds = ['timing-b'];
  rows[0]._timingConflicts = ['old-conflict'];
  const result = qualify(rows, sources);
  assert.equal(result.hybrid.length, 1);
  assert.equal(result.final.length, 1);
  assert.equal(result.published.length, 1);
  assert.match(result.published[0].action, /Morgan Lee/);
  assert.equal(result.published[0].timing.wording, 'one week after Casey returns');
  assert.deepEqual(new Set(result.published[0].reviewFlagIds), new Set(['timing-a', 'timing-b']));
  assert.deepEqual(result.published[0]._timingConflicts, ['old-conflict']);
});

test('source-aware timed paraphrases keep different timing kinds, dates and qualifications separate', () => {
  const sources = [source('TRAIN-01', 'Morgan will teach Casey to build projects in Asana using the same approach Morgan currently uses.')];
  const original = row('teach-a', 'Teach Casey to build projects in Asana using the same approach currently being used.', ['Morgan Lee'], timing('one week after Casey returns'), ['TRAIN-01']);
  const variation = value => row('teach-b', 'Teach Casey to build projects in Asana using the same approach currently used by Morgan Lee.', ['Morgan Lee'], value, ['TRAIN-01']);
  for (const value of [timing('two weeks after Casey returns'), timing('one week after Casey returns', 'deadline'),
    timing('one week after Casey returns, if training is ready'), untimed(),
    { ...timing('one week after Casey returns'), exactDate: '2026-11-04' }]) {
    assert.equal(dedupeHybridActionRecords([original, variation(value)], { sourceUnits: sources }).length, 2);
  }
});

test('document-review email paraphrases stay separate when full detail coverage is unproved', () => {
  const sources = [
    source('AI011-DOC-01', 'Claire will send an email requesting review of the revised documents after completing the rewrites and responses to feedback.', 'Claire Nicholson'),
    source('AI011-DOC-02', 'Claire will send an email requesting review after completing the document rewrites and responses to feedback comments.', 'Claire Nicholson')
  ];
  const evidenceIds = sources.map(item => item.id);
  const rows = [
    row('doc-a', 'Send an email requesting review of the revised documents after completing the rewrites and responses to feedback.', ['Claire Nicholson'], untimed(), evidenceIds),
    row('doc-b', 'Send an email requesting review after completing the document rewrites and responses to feedback comments.', ['Claire Nicholson'], untimed(), evidenceIds)
  ];
  const result = qualify(rows, sources);
  assert.equal(result.commitment.length, 2);
  assert.equal(result.hybrid.length, 2);
  assert.equal(result.final.length, 2);
  assert.equal(result.published.length, 2);
});

test('software-change compilation paraphrases stay separate when either version has unique detail', () => {
  const sources = [
    source('AI011-SW-01', 'Claire will compile the referenced software changes into the summary report as part of the design and technical file change documentation.', 'Claire Nicholson'),
    source('AI011-SW-02', 'Claire will compile the reviewed software changes into the design and technical file summary reporting using the output from the review of the 17 changes.', 'Claire Nicholson')
  ];
  const evidenceIds = sources.map(item => item.id);
  const rows = [
    row('sw-a', 'Compile the referenced software changes into the summary report as part of the design and technical file change documentation.', ['Claire Nicholson'], untimed(), evidenceIds),
    row('sw-b', 'Compile the reviewed software changes into the design and technical file summary reporting using the output from the review of the 17 changes.', ['Claire Nicholson'], untimed(), evidenceIds)
  ];
  const result = qualify(rows, sources);
  assert.equal(result.commitment.length, 2);
  assert.equal(result.hybrid.length, 2);
  assert.equal(result.final.length, 2);
  assert.match(result.final.map(item=>item.action).join(' '), /17/);
});

test('same source and owner do not erase different approval conditions', () => {
  const sources = [source('AUDIT-01','Alex will send the revised audit pack after legal approval and with the client review note.','Alex Morgan')];
  const rows = [
    row('legal','Send the revised audit pack after legal approval.',['Alex Morgan'],untimed(),['AUDIT-01']),
    row('client','Send the revised audit pack with the client review note.',['Alex Morgan'],untimed(),['AUDIT-01'])
  ];
  const result = qualify(rows,sources);
  assert.equal(result.commitment.length,2);
  assert.equal(result.hybrid.length,2);
  assert.equal(result.final.length,2);
  assert.equal(result.published.length,2);
});

test('Colm standards-review paraphrases stay separate when the material scope is unproved', () => {
  const sources = [
    source('AI011-COLM-01', 'Claire will follow up with Colm to review the referenced standard.', 'Claire Nicholson'),
    source('AI011-COLM-02', 'Claire will follow up with Colm and obtain a review of the standards material.', 'Claire Nicholson')
  ];
  const evidenceIds = sources.map(item => item.id);
  const rows = [
    row('colm-a', 'Follow up with Colm to review the referenced standard.', ['Claire Nicholson'], untimed(), evidenceIds),
    row('colm-b', 'Follow up with Colm and obtain a review of the standards material.', ['Claire Nicholson'], untimed(), evidenceIds)
  ];
  const result = qualify(rows, sources);
  assert.equal(result.commitment.length, 2);
  // Existing hybrid dedupe prefers one wording, but final preservation
  // correctly restores the uncovered referenced-standard detail.
  assert.equal(result.hybrid.length, 1);
  assert.equal(result.final.length, 2);
});
