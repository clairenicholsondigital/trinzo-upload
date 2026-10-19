'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hybridCandidateMatchesRecord,
  hybridCandidateCoveredByRecord,
  hybridCandidateDispositions,
  publishedActionCoversProposal,
  removePublishedActionProposalDuplicates,
  dedupeHybridActionRecords,
  dedupeHybridActionProposals
} = require('../routes/api').stagedEvaluation;

const action = (wording, extra = {}) => ({
  id: 'shared-id', action: wording, owners: ['Alex Green'],
  evidenceIds: ['T0001'], timing: { kind: 'not_stated', wording: '', exactDate: '' }, ...extra
});
const candidate = (record) => ({
  candidateId: 'candidate', sourcePass: 'primary', recordType: 'action',
  text: record.action, evidenceIds: record.evidenceIds, record
});
const dated = (day) => ({ kind: 'deadline', wording: `${day} November`, exactDate: `2026-11-${day}` });

test('relationship matching cannot claim that a different dated occurrence was published', () => {
  const later = action('Review the weekly safety report.', { timing: dated('10') });
  const earlier = action(later.action, { timing: dated('03') });
  assert.equal(hybridCandidateMatchesRecord(candidate(later), earlier), true,
    'the broad matcher may still identify related records for source corroboration');
  assert.equal(hybridCandidateCoveredByRecord(candidate(later), earlier), false);
  assert.equal(hybridCandidateDispositions([candidate(later)], [earlier])[0].disposition, 'reject');
});

test('candidate accounting requires all work, scope, responsibility and timing to survive', () => {
  const cases = [
    [action('Review the safety report and send the receipt.'), action('Review the safety report.')],
    [action('Send the safety report to Morgan.'), action('Review the safety report to Morgan.')],
    [action('Send three attendance lists to Morgan.'), action('Send four attendance lists to Morgan.')],
    [action('Send 3 attendance lists to Morgan.'), action('Send 4 attendance lists to Morgan.')],
    [action('Do not send the safety report to Morgan.'), action('Send the safety report to Morgan.')],
    [action('Send the safety report if approval arrives.'), action('Send the safety report.')],
    [action('Send the safety report to Morgan.'), action('Send the safety report to Casey.')],
    [action('Send the safety report.'), action('Send the safety report.', { owners: ['Alex Green', 'Casey Lee'] })],
    [action('Send the safety report.', { timing: dated('10') }), action('Send the safety report.')]
  ];
  for (const [required, retained] of cases) {
    const row = candidate(required);
    assert.equal(hybridCandidateCoveredByRecord(row, retained), false, required.action);
    assert.equal(publishedActionCoversProposal(retained, required), false, required.action);
    const proposal = { changes: [{ id: 'preserve', type: 'add', after: required }] };
    assert.deepEqual(removePublishedActionProposalDuplicates(proposal, [retained]), proposal,
      `proposal suppression must preserve ${required.action}`);
    for (const [published, proposed, supporting] of [[[retained], [], []], [[], [retained], []], [[], [], [retained]]]) {
      assert.equal(hybridCandidateDispositions([row], published, proposed, supporting)[0].disposition,
        'reject', `partial coverage cannot become publication, proposal or supporting credit: ${required.action}`);
    }
  }
});

test('coverage is directional when a complete independent clause survives in a compound', () => {
  const part = action('Send the attendance list to Morgan.');
  const whole = action('Notify Casey about the room change and send the attendance list to Morgan.');
  assert.equal(hybridCandidateCoveredByRecord(candidate(part), whole), true);
  assert.equal(hybridCandidateCoveredByRecord(candidate(whole), part), false);
  assert.equal(hybridCandidateDispositions([candidate(part)], [whole])[0].disposition, 'publish');
});

test('identical complete work retains existing accounting outcomes and known timing', () => {
  const required = action('Send the safety report.');
  const retained = action(required.action, { id: 'retained', timing: dated('10') });
  assert.equal(hybridCandidateCoveredByRecord(candidate(required), retained), true);
  assert.equal(hybridCandidateDispositions([candidate(required)], [], [retained])[0].disposition, 'proposal');
  assert.equal(hybridCandidateDispositions([candidate(required)], [], [], [retained])[0].disposition, 'supporting');
  assert.equal(hybridCandidateDispositions([candidate(required)], [retained])[0].matchedRecordId, 'retained');
});

test('discussion relationship matching and accounting are unchanged by action coverage rules', () => {
  const row = {
    candidateId: 'discussion', sourcePass: 'primary', recordType: 'discussion_point',
    text: 'The launch remains blocked by supplier approval.', evidenceIds: ['T0001']
  };
  const retained = { id: 'point', text: row.text, evidenceIds: row.evidenceIds };
  assert.equal(hybridCandidateCoveredByRecord(row, retained), hybridCandidateMatchesRecord(row, retained));
  assert.equal(hybridCandidateDispositions([row], [retained])[0].disposition, 'publish');
});

test('hybrid action and proposal merges preserve conflicting quantities, negation and conditions', () => {
  const pairs = [
    ['Send the budget report to Morgan and send the safety report to Casey.',
      'Send the budget report to Casey and send the safety report to Morgan.'],
    ['Install three replacement filters.', 'Install four replacement filters.'],
    ['Install 3 replacement filters and 5 valves.', 'Install 4 replacement filters and 5 valves.'],
    ['Send the completed safety report to Morgan.', 'Do not send the completed safety report to Morgan.'],
    ['Send the safety report if approval arrives.', 'Send the safety report unless approval arrives.'],
    ['Send the safety report after approval arrives.', 'Send the safety report before approval arrives.']
  ];
  for (const wording of pairs) {
    for (const rows of [wording, [...wording].reverse()]) {
      const records = rows.map((value, index) => action(value, { id: `row-${index}` }));
      for (const dedupe of [dedupeHybridActionRecords, dedupeHybridActionProposals]) {
        const kept = dedupe(structuredClone(records));
        assert.equal(kept.length, 2, `${dedupe.name}: ${rows.join(' / ')}`);
        assert.deepEqual(new Set(kept.map(row => row.action)), new Set(rows));
      }
    }
  }
});
