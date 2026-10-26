'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  dedupeHybridActionRecords,
  reconcileFinalApprovedActions
} = require('../routes/api').stagedEvaluation;
const { mergeCommitmentDuplicates } = require('../utils/canonicalMinutes/commitmentDuplicates');

const timing = (wording, kind = 'dependency') => ({ kind, wording, exactDate: '' });

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
  const commitment = mergeCommitmentDuplicates(structuredClone(rows)).actions;
  const hybrid = dedupeHybridActionRecords(structuredClone(rows));
  const final = reconcileFinalApprovedActions(hybrid, structuredClone(rows));
  return { commitment, hybrid, final: final.actions, restored: final.restored };
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
