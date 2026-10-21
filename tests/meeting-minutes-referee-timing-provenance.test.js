'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../routes/api').stagedEvaluation;
const Timing = require('../utils/meetingMinutesTiming');
const V2 = require('../utils/meetingMinutesAgentV2');

const meetingDate = '2026-10-21';
const units = V2.normaliseSourceUnits([
  { speaker: 'Morgan', text: 'I will review the permit pack next month.' },
  { speaker: 'Casey', text: 'I will send the supplier checklist.' },
  { speaker: 'Chair', text: 'I will arrange the training call next week.' }
]);
const transcript = V2.preparedTranscriptFromUnits(units);
const action = (timing, extra = {}) => ({
  id: 'permit', action: 'Review the permit pack.', owners: ['Morgan'],
  timing, evidenceIds: ['T0001'], ...extra
});
const payload = (contract, repair = false) => JSON.parse(
  (repair ? api.meetingMinutesAgentRefereeRepairPrompt : api.meetingMinutesAgentRefereePrompt)({
    stage: 'actions', transcript, sourceUnits: units, details: { meetingDate }, contract
  }).split('refereePayload:\n')[1]
);
const contractFor = (rows, requestId = 'timing-scope') => {
  const ledger = api.hybridCandidateLedgerFromResult({ actions: rows }, 'recovery');
  const candidates = api.meetingAgentRefereeCandidates('actions', ledger);
  return api.meetingMinutesAgentRefereeContract('actions', candidates, requestId, { selected: true });
};

for (const scenario of [
  {
    name: 'date-only rejection retains independently supported broad timing',
    row: action({ kind: 'target', wording: 'next month', exactDate: '2026-10-23' }),
    rejectedExactDates: ['2026-10-23'], rejectedWordings: [],
    retainedTiming: { kind: 'target', wording: 'next month', exactDate: '' }
  },
  {
    name: 'wording-only rejection identifies only the removed wording',
    row: action({ kind: 'target', wording: 'next week', exactDate: '' }, {
      id: 'checklist', action: 'Send the supplier checklist.', owners: ['Casey'], evidenceIds: ['T0002', 'T0003']
    }),
    rejectedExactDates: [], rejectedWordings: ['next week'],
    retainedTiming: { kind: 'not_stated', wording: '', exactDate: '' }
  },
  {
    name: 'combined rejection identifies the removed date and wording',
    row: action({ kind: 'target', wording: 'next week', exactDate: '2026-10-28' }, {
      id: 'checklist', action: 'Send the supplier checklist.', owners: ['Casey'], evidenceIds: ['T0002', 'T0003']
    }),
    rejectedExactDates: ['2026-10-28'], rejectedWordings: ['next week'],
    retainedTiming: { kind: 'not_stated', wording: '', exactDate: '' }
  }
]) {
  test(`assessment scope reaches normal and repair referee payloads: ${scenario.name}`, () => {
    const checked = Timing.assessActionTiming(scenario.row, units, { meetingDate });
    assert.equal(checked.assessment.status, 'rejected');
    assert.deepEqual(checked.assessment.rejectedExactDates, scenario.rejectedExactDates);
    assert.deepEqual(checked.assessment.rejectedWordings, scenario.rejectedWordings);
    const contract = contractFor([checked.action]);
    const before = structuredClone(contract);
    for (const repair of [false, true]) {
      const submitted = payload(contract, repair);
      const packed = submitted.candidateEnsemble[0];
      assert.deepEqual(packed.timingProvenance, {
        status: 'rejected', policyVersion: Timing.TIMING_POLICY_VERSION,
        source: 'application_assessment_not_source_evidence',
        rejectedExactDates: scenario.rejectedExactDates, rejectedWordings: scenario.rejectedWordings
      });
      assert.deepEqual(packed.timing, scenario.retainedTiming);
      assert.equal(packed.text, scenario.row.action);
      assert.deepEqual(packed.owners, scenario.row.owners);
      assert.deepEqual(packed.evidenceIds, scenario.row.evidenceIds);
      assert.equal(packed.timingDecision, undefined, 'private assessment details are not source evidence');
      assert.deepEqual(submitted.expectedCandidateIds, contract.expectedCandidateIds);
      assert.equal(submitted.expectedCandidateCount, 1);
      assert.equal(submitted.preparedTranscript,
        api.meetingAgentRefereeEvidencePacket(units, contract.candidates, transcript).preparedTranscript);
      assert.match(submitted.writingRules[0], /a rejected or uncertain date does not reject an otherwise supported action/);
      if (repair) assert.equal(submitted.repairAttempt, true);
    }
    assert.deepEqual(contract, before, 'prompt submission does not mutate the assessment or contract');
  });
}

test('a supported broad assessment carries empty rejection scope without changing its qualified status', () => {
  const checked = Timing.assessActionTiming(action({ kind: 'target', wording: 'next month', exactDate: '' }), units, { meetingDate });
  assert.equal(checked.assessment.status, 'qualified');
  const packed = payload(contractFor([checked.action])).candidateEnsemble[0];
  assert.deepEqual(packed.timingProvenance, {
    status: 'qualified', policyVersion: Timing.TIMING_POLICY_VERSION,
    source: 'application_assessment_not_source_evidence', rejectedExactDates: [], rejectedWordings: []
  });
  assert.equal(packed.timing.wording, 'next month');
});

test('an unassessed candidate does not acquire application timing provenance', () => {
  const row = action({ kind: 'target', wording: 'next month', exactDate: '' });
  const contract = contractFor([row]);
  for (const repair of [false, true]) {
    assert.equal(payload(contract, repair).candidateEnsemble[0].timingProvenance, undefined);
  }
  assert.equal(api.meetingAgentActionAuditCandidates(contract.candidates)[0].timingProvenance, undefined);
});

test('legacy or malformed scope is empty and cannot override application status or source', () => {
  for (const timingDecision of [
    { status: 'rejected' },
    { status: 'unresolved', rejectedExactDates: '2026-10-23', rejectedWordings: { value: 'next week' } }
  ]) {
    const packed = payload(contractFor([action({ kind: 'target', wording: 'next month', exactDate: '' }, { timingDecision })]))
      .candidateEnsemble[0];
    assert.deepEqual(packed.timingProvenance, {
      status: timingDecision.status, policyVersion: Timing.TIMING_POLICY_VERSION,
      source: 'application_assessment_not_source_evidence', rejectedExactDates: [], rejectedWordings: []
    });
  }
});

test('scope lists bound count and text length while preserving their recorded order', () => {
  const rejectedExactDates = [null, {}, 20261023, '  ', ...Array.from({ length: 30 }, (_, i) => `  ${i}-date-${'x'.repeat(60)}  `)];
  const rejectedWordings = [null, { value: 'next week' }, false, '', ...Array.from({ length: 30 }, (_, i) => `  ${i} next\n month ${'x'.repeat(500)}  `)];
  const contract = contractFor([action({ kind: 'target', wording: 'next month', exactDate: '' }, {
    timingDecision: { status: 'rejected', rejectedExactDates, rejectedWordings }
  })]);
  const original = structuredClone(contract);
  const expected = (values, maxLength) => values.filter(value => typeof value === 'string').map(value => value.replace(/\s+/g, ' ').trim().slice(0, maxLength)).filter(Boolean).slice(0, 8);
  for (const repair of [false, true]) {
    const provenance = payload(contract, repair).candidateEnsemble[0].timingProvenance;
    assert.deepEqual(provenance.rejectedExactDates, expected(rejectedExactDates, 20));
    assert.deepEqual(provenance.rejectedWordings, expected(rejectedWordings, 220));
    assert.equal(provenance.rejectedExactDates.length, 8);
    assert.equal(provenance.rejectedWordings.length, 8);
    assert.ok(JSON.stringify(provenance).length < 2200);
  }
  assert.deepEqual(contract, original);
});

test('action audit, critic and salvage retain the same bounded assessment scope', () => {
  const checked = Timing.assessActionTiming(action({ kind: 'target', wording: 'next month', exactDate: '2026-10-23' }), units, { meetingDate });
  const contract = contractFor([checked.action]);
  const packed = payload(contract).candidateEnsemble[0];
  const audit = api.meetingAgentActionAuditCandidates(contract.candidates);
  assert.deepEqual(audit, [packed]);
  for (const [buildPrompt, marker] of [
    [api.meetingMinutesAgentCriticPrompt, 'REMAINING CANDIDATES:\n'],
    [api.meetingMinutesAgentSalvagePrompt, 'STRONG UNRESOLVED CANDIDATES:\n']
  ]) {
    const prompt = buildPrompt({ transcript, details: { meetingDate }, discussion: [], actions: [], candidates: contract.candidates });
    const submitted = JSON.parse(prompt.split(marker)[1].split('\n\n')[0]);
    assert.deepEqual(submitted, audit);
  }
});

test('scope leaves candidate identity, ordering, evidence and referee disposition authority intact', () => {
  const checked = Timing.assessActionTiming(action({ kind: 'target', wording: 'next month', exactDate: '2026-10-23' }), units, { meetingDate });
  const sibling = action({ kind: 'not_stated', wording: '', exactDate: '' }, {
    id: 'checklist', action: 'Send the supplier checklist.', owners: ['Casey'], evidenceIds: ['T0002']
  });
  const contract = contractFor([checked.action, sibling]);
  const reversed = api.meetingMinutesAgentRefereeContract('actions', [...contract.candidates].reverse(), 'timing-scope-reversed', { selected: true });
  for (const current of [contract, reversed]) {
    const submitted = payload(current);
    assert.deepEqual(submitted.candidateEnsemble.map(candidate => candidate.candidateId), current.expectedCandidateIds);
    for (const candidate of current.candidates) {
      const packed = submitted.candidateEnsemble.find(row => row.candidateId === candidate.candidateId);
      assert.equal(packed.text, candidate.text);
      assert.deepEqual(packed.owners, candidate.owners);
      assert.deepEqual(packed.evidenceIds, candidate.evidenceIds);
      assert.deepEqual(packed.timing, candidate.timing);
    }
    const dispositions = current.candidates.map(candidate => ({
      candidateId: candidate.candidateId, disposition: 'publish',
      reason: 'Synthetic publication control.', evidenceIds: candidate.evidenceIds
    }));
    const response = {
      schemaVersion: 4, requestId: current.requestId, stage: 'ACTION_REFEREE',
      expectedCandidateCount: 2, returnedDispositionCount: 2, candidateDispositions: dispositions
    };
    assert.equal(api.meetingAgentDispositionError(response, current.candidates, current), null);
    for (const invalid of [dispositions.slice(1), [...dispositions, dispositions[0]],
      [...dispositions.slice(1), { ...dispositions[0], candidateId: 'unknown' }]]) {
      assert.ok(api.meetingAgentDispositionError({ ...response, candidateDispositions: invalid }, current.candidates, current));
    }
    const published = api.reconstructRefereeActions(dispositions, current.candidates, units, { meetingDate });
    assert.equal(published.actions.length, 2);
    const permit = published.actions.find(row => row.action === checked.action.action);
    assert.deepEqual(permit.owners, checked.action.owners);
    assert.deepEqual(permit.timing, checked.action.timing);
    const rejected = api.reconstructRefereeActions(dispositions.map(row => row.candidateId === contract.expectedCandidateIds[0]
      ? { ...row, disposition: 'reject' } : row), current.candidates, units, { meetingDate });
    assert.equal(rejected.actions.length, 1);
    assert.equal(rejected.actions[0].action, sibling.action, 'a rejected candidate cannot consume its sibling');
    assert.deepEqual(rejected.actionProposals, []);
  }
});

function auditPackingFixture() {
  const candidate = (candidateId, priority, sequence, timingDecision) => ({
    candidateId, sourcePass: 'recovery', recordType: 'action',
    text: 'Review the permit pack.', owners: ['Morgan'], evidenceIds: ['T0001'],
    timing: { kind: 'target', wording: 'next month', exactDate: '' },
    priority, sequence, timingDecision
  });
  const candidates = [
    candidate('audit-large-scope', 30, 30, {
      status: 'rejected', rejectedExactDates: ['2026-10-23'],
      rejectedWordings: Array.from({ length: 8 }, (_, i) => `Earlier wording ${i}: ${'x'.repeat(220)}`)
    }),
    candidate('audit-small-scope', 20, 10, {
      status: 'rejected', rejectedExactDates: ['2026-10-23'], rejectedWordings: []
    }),
    candidate('audit-extra', 10, 20)
  ];
  const contract = api.meetingMinutesAgentRefereeContract('actions', candidates, 'audit-packing', { selected: true });
  const full = payload(contract).candidateEnsemble;
  const withoutScope = row => {
    const copy = structuredClone(row);
    if (copy.timingProvenance) {
      delete copy.timingProvenance.rejectedExactDates;
      delete copy.timingProvenance.rejectedWordings;
    }
    return copy;
  };
  const legacy = full.map(withoutScope);
  // Admission historically reserved one extra separator character. At this
  // boundary both higher-priority rows fit; the third row does not.
  const legacyPair = [legacy[1], legacy[0]];
  const boundaryBudget = JSON.stringify(legacyPair).length + 1;
  assert.ok(JSON.stringify(full[0]).length > boundaryBudget,
    'the long scope must be large enough to displace an action if charged during selection');
  return { candidates, full, legacyPair, boundaryBudget, withoutScope };
}

test('near the audit limit rejection scope cannot displace baseline candidates or change their order', () => {
  const { candidates, legacyPair, boundaryBudget, withoutScope } = auditPackingFixture();
  const original = structuredClone(candidates);
  const out = api.meetingAgentActionAuditCandidates(candidates, boundaryBudget);
  assert.deepEqual(out.map(row => row.candidateId), ['audit-small-scope', 'audit-large-scope']);
  assert.deepEqual(out.map(withoutScope), legacyPair, 'work, owners, timing and evidence remain unchanged');
  assert.deepEqual(out, legacyPair, 'with no scope room, retain the legacy application provenance');
  assert.ok(JSON.stringify(out).length <= boundaryBudget);
  assert.deepEqual(candidates, original, 'budget fallback must not mutate the source assessments');
});

test('audit enrichment uses available characters while retaining a larger row without scope', () => {
  const { candidates, full, legacyPair, withoutScope } = auditPackingFixture();
  const smallScopeChars = JSON.stringify(full[1]).length - JSON.stringify(legacyPair[0]).length;
  const budget = JSON.stringify(legacyPair).length + smallScopeChars;
  const out = api.meetingAgentActionAuditCandidates(candidates, budget);
  assert.deepEqual(out.map(row => row.candidateId), ['audit-small-scope', 'audit-large-scope']);
  assert.deepEqual(out.map(withoutScope), legacyPair);
  assert.deepEqual(out[0], full[1], 'the smaller scope fits exactly into the remaining characters');
  assert.deepEqual(out[1], legacyPair[1], 'the larger scope falls back atomically without losing its action');
  assert.equal(JSON.stringify(out).length, budget, 'the final serialized array stays within the original budget');
});

test('an audit with scope room preserves the candidate cap and includes complete bounded scope', () => {
  const { candidates, full } = auditPackingFixture();
  const expected = [full[1], full[0]];
  const budget = JSON.stringify(expected).length + 1;
  const out = api.meetingAgentActionAuditCandidates(candidates, budget, 2);
  assert.deepEqual(out.map(row => row.candidateId), ['audit-small-scope', 'audit-large-scope']);
  assert.deepEqual(out, expected);
  assert.ok(JSON.stringify(out).length <= budget);
  assert.equal(out[1].timingProvenance.rejectedWordings.length, 8);
  assert.ok(out[1].timingProvenance.rejectedWordings.every(value => value.length === 220));
});
