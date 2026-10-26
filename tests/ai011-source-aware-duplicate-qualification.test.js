'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  dedupeHybridActionRecords,
  reconcileFinalApprovedActions,
  isUnownedActionFragment,
  sourceBoundSoftwareTraceabilityActions
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

function assertSingleSourceBoundSurvivor(result, expectedParts) {
  for (const stage of [result.commitment, result.hybrid, result.final]) {
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

test('document-review email paraphrases consolidate without inventing a recipient', () => {
  const sources = [
    source('AI011-DOC-01', 'Claire will send an email requesting review of the revised documents after completing the rewrites and responses to feedback.', 'Claire Nicholson'),
    source('AI011-DOC-02', 'Claire will send an email requesting review after completing the document rewrites and responses to feedback comments.', 'Claire Nicholson')
  ];
  const evidenceIds = sources.map(item => item.id);
  const rows = [
    row('doc-a', 'Send an email requesting review of the revised documents after completing the rewrites and responses to feedback.', ['Claire Nicholson'], untimed(), evidenceIds),
    row('doc-b', 'Send an email requesting review after completing the document rewrites and responses to feedback comments.', ['Claire Nicholson'], untimed(), evidenceIds)
  ];
  assertSingleSourceBoundSurvivor(qualify(rows, sources), ['email', 'review', 'rewrites', 'feedback']);
});

test('software-change compilation paraphrases consolidate while retaining the reviewed quantity', () => {
  const sources = [
    source('AI011-SW-01', 'Claire will compile the referenced software changes into the summary report as part of the design and technical file change documentation.', 'Claire Nicholson'),
    source('AI011-SW-02', 'Claire will compile the reviewed software changes into the design and technical file summary reporting using the output from the review of the 17 changes.', 'Claire Nicholson')
  ];
  const evidenceIds = sources.map(item => item.id);
  const rows = [
    row('sw-a', 'Compile the referenced software changes into the summary report as part of the design and technical file change documentation.', ['Claire Nicholson'], untimed(), evidenceIds),
    row('sw-b', 'Compile the reviewed software changes into the design and technical file summary reporting using the output from the review of the 17 changes.', ['Claire Nicholson'], untimed(), evidenceIds)
  ];
  assertSingleSourceBoundSurvivor(qualify(rows, sources), ['compile', 'software changes', 'design', 'technical file', '17']);
});

test('Colm standards-review paraphrases consolidate with the referenced standard retained', () => {
  const sources = [
    source('AI011-COLM-01', 'Claire will follow up with Colm to review the referenced standard.', 'Claire Nicholson'),
    source('AI011-COLM-02', 'Claire will follow up with Colm and obtain a review of the standards material.', 'Claire Nicholson')
  ];
  const evidenceIds = sources.map(item => item.id);
  const rows = [
    row('colm-a', 'Follow up with Colm to review the referenced standard.', ['Claire Nicholson'], untimed(), evidenceIds),
    row('colm-b', 'Follow up with Colm and obtain a review of the standards material.', ['Claire Nicholson'], untimed(), evidenceIds)
  ];
  assertSingleSourceBoundSurvivor(qualify(rows, sources), ['Colm', 'review', 'standard']);
});

test('the IEC 60601-1/MDD paraphrase pair consolidates at the final approved boundary', () => {
  const sources = [
    source('AI011-IEC-01', 'Andrew is progressing the review of IEC 60601-1 against the MDD documentation and defining the electrical compliance testing.', 'Andrew Kane'),
    source('AI011-IEC-02', 'Andrew is progressing the MDD documentation review against IEC 60601-1 and defining the electrical compliance testing requirements.', 'Andrew Kane')
  ];
  const rows = [
    row('iec-a', 'Progress the review of the IEC 60601-1 standard against the MDD documentation and define the required electrical compliance testing.', ['Andrew Kane'], untimed(), ['AI011-IEC-01', 'AI011-IEC-02']),
    row('iec-b', 'Progress the review of the MDD documentation against IEC 60601-1 and define the electrical compliance testing requirements.', ['Andrew Kane'], untimed(), ['AI011-IEC-02', 'AI011-IEC-01'])
  ];
  const result = qualify(rows, sources);
  assert.equal(result.final.length, 1);
  assert.match(result.final[0].action, /IEC 60601-1/i);
  assert.match(result.final[0].action, /electrical compliance testing/i);
  assert.deepEqual(result.restored, []);
});

test('the Eakin acknowledgement fragment is recognised as an unowned action fragment', () => {
  assert.equal(isUnownedActionFragment({ action: 'Add a bit of clarity.Yeah.', owners: [] }), true);
  assert.equal(isUnownedActionFragment({ action: 'Add clarity to the risk management plan.', owners: [] }), false);
  assert.equal(isUnownedActionFragment({ action: 'Add a bit of clarity.Yeah.', owners: ['Rebecca Gill'] }), false);
});

test('the narrative 17-change traceability task is recovered only from its source-bound wording', () => {
  const sources = [
    source('AI011-SW-TRACE', 'Jacqui: David has been working through tracing the software changes between version 101 to 102 of those 17 listed ones to document them. They are his priority action for the remainder of this week.', 'Jacqui Fox'),
    source('AI011-SW-OWNER', 'David is the software change owner.', 'David Didsbury')
  ];
  const recovered = sourceBoundSoftwareTraceabilityActions(sources, []);
  assert.equal(recovered.length, 1);
  assert.deepEqual(recovered[0].owners, ['David Didsbury']);
  assert.equal(recovered[0].evidenceIds.length, 1);
  assert.equal(recovered[0].evidenceIds[0], 'T0001');
  assert.match(recovered[0].action, /17 software changes from version 1\.01 to 1\.02/i);
  assert.equal(sourceBoundSoftwareTraceabilityActions(sources, recovered).length, 0);
  assert.equal(sourceBoundSoftwareTraceabilityActions([
    source('AI011-SW-WEAK', 'The software traceability topic includes version 101 to 102 and 17 changes.')
  ], []).length, 0);
});
