'use strict';
process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1 = '0';
const test = require('node:test'), assert = require('node:assert/strict');
const D = require('../utils/meetingMinutesActionDiagnostics');
const R = require('../utils/canonicalMinutes/actionSemanticReconciliation');
const V = require('../utils/meetingMinutesAgentV2');
const A = require('../routes/api').stagedEvaluation;
const { captureSemanticPolicy } = require('../utils/meetingMinutesSemanticPolicy');
const { reconcileGeneratedSemanticStage } = require('../utils/meetingMinutesSemanticStage');
const { inspect } = require('../utils/meetingMinutesActionInspection');
const policy = captureSemanticPolicy({ MEETING_MINUTES_AGENT_CONTACT_ENQUIRY_DEDUPE_V1: '1',
  MEETING_MINUTES_AGENT_BOUNDED_SURVIVOR_DEDUPE_V1: '1', MEETING_MINUTES_AGENT_CONTAINED_REQUIREMENTS_V1: '1',
  MEETING_MINUTES_AGENT_CONTACT_PARAPHRASE_V1: '1', MEETING_MINUTES_AGENT_CONTACT_REVIEW_V1: '1', MEETING_MINUTES_AGENT_ACTION_PROOF_CONTRACT_V2: '1' });
const row = (id, action, extra = {}) => ({ id, action, owners: ['Maya Patel'], evidenceIds: ['T0001'],
  timing: { kind: 'not_stated', wording: '', exactDate: '' }, reviewFlagIds: [], ...extra });
const units = V.normaliseSourceUnits([{ id: 'T0001', speaker: 'Maya Patel', text: 'I will send the validation documents to Jo Lee for review.' }]);
const packet = actions => R.prepareActionReconciliation({ actions, sourceUnits: units, ...policy });
const cases = [
  ['bundle and handoff', [row('b', 'Provide Jo Lee with the training pack; and the risk analysis after approval.'), row('s', 'Send the training pack to Jo Lee for signature.', { owners: ['Maya Patel', 'Jo Lee'] })]],
  ['bundle and dependency', [row('b', 'Provide Jo Lee with the training pack; and the risk analysis after approval.'), row('r', 'Share the risk analysis with Jo Lee after approval.', { timing: { kind: 'dependency', wording: 'after approval', exactDate: '' } })]],
  ['conditional access', [row('a', 'Arrange a method to access or receive audit documents, including portal access if required.'), row('b', 'Arrange portal access and upload audit documents.')]],
  ['contact grammar', [row('a', 'Follow up with Jo regarding supplier activities, responsibilities and registration work.'), row('b', 'Speak to Jo to clarify supplier responsibilities and avoid duplication in registration work.')]],
  ['flagged assessment', [row('a', 'Assess the applicability of the referenced standard and determine whether any action is required.', { reviewFlagIds: ['owner-check'] }), row('b', 'Review the standards provided to determine whether any action or assessment is required.')]],
  ['different delivery descriptions', [row('a', 'Send the purchased documents by email.', { evidenceIds: ['T0001'], reviewFlagIds: ['owner-check'] }), row('b', 'Send the purchased documents to the team for assessment.', { evidenceIds: ['T0002'] })]]
];
for (const [name, actions] of cases) test(name + ': diagnostics preserve exact packet, local output and input', async () => {
  const before = structuredClone(actions), expectedPacket = packet(actions), expectedActions = A.dedupeHybridActionRecords(actions, { sourceUnits: units });
  const { value, audit } = await D.capture(() => ({ packet: packet(actions), actions: A.dedupeHybridActionRecords(actions, { sourceUnits: units }) }), { targeted: true });
  assert.deepEqual(value.packet, expectedPacket); assert.deepEqual(value.actions, expectedActions); assert.deepEqual(actions, before);
  assert.ok(audit.events.some(e => e.kind === 'nomination' && e.reason)); assert.equal(audit.errors, 0);
});

test('same local ID in concurrent passes has qualified origins and isolated run storage', async () => {
  const a = row('A7', 'Send the validation documents to Jo Lee.'), b = row('A7', 'Review the maintenance document.');
  const [one, two] = await Promise.all([D.capture(async () => {
    await Promise.all([D.scoped('primary', async () => { await new Promise(r => setTimeout(r, 5)); D.origin('primary', [a]); }),
      D.scoped('recovery', async () => D.origin('recovery', [b]))]);
  }), D.capture(() => D.origin('other', [row('A7', 'Buy the replacement valve.')]))]);
  assert.equal(one.audit.nodes.length, 2); assert.equal(two.audit.nodes.length, 1);
  assert.deepEqual(one.audit.events.map(e => e.origin.pass).sort(), ['primary', 'recovery']);
  assert.ok(one.audit.events.every(e => e.pass === e.origin.pass));
  assert.equal(new Set(one.audit.events.map(e => e.outputs[0])).size, 2);
});

test('bundles retain exact constituent links and no diagnostic properties enter actions', async () => {
  const actions = [row('a', 'Send the validation report to Jo Lee.'), row('b', 'Send the training pack to Jo Lee.')];
  const expected = A.bundleSameRecipientDeliveries(actions), { value, audit } = await D.capture(() => A.bundleSameRecipientDeliveries(actions));
  assert.deepEqual(value, expected); const bundled = audit.events.find(e => e.kind === 'bundled');
  assert.equal(bundled.inputs.length, 2); assert.equal(bundled.outputs.length, 1);
  assert.ok(value.every(r => !Object.keys(r).some(k => /diagnostic|lineage/i.test(k))));
});

test('normalisation records citation decisions and owner checks without changing output', async () => {
  const action = row('a', 'Send the validation documents to Jo Lee.', { owners: ['Tomas Vale'] });
  const expected = V.normaliseAgentResult({ actions: [action] }, units, 'actions');
  const { value, audit } = await D.capture(() => V.normaliseAgentResult({ actions: [action] }, units, 'actions'));
  assert.deepEqual(value, expected); assert.ok(audit.events.some(e => e.kind === 'evidence_selected'));
  assert.ok(audit.events.some(e => e.kind === 'normalised'));
  assert.ok(audit.events.some(e => e.kind === 'owner_removed'));
});

test('restoration records the preserved original and does not suppress it', async () => {
  const actions = [row('a', 'Send the validation documents to Jo Lee.')];
  const expected = A.reconcileFinalApprovedActions([], actions, { sourceUnits: units });
  const { value, audit } = await D.capture(() => A.reconcileFinalApprovedActions([], actions, { sourceUnits: units }));
  assert.deepEqual(value, expected); assert.equal(audit.events.filter(e => e.kind === 'restored').length, 1);
});

test('owner borrowing retains donor identity without changing the proposed owner', async () => {
  const selected = { candidateId: 'selected', recordType: 'action', sourcePass: 'recovery', text: 'Send the validation documents to Jo Lee.', evidenceIds: ['T0001'], record: row('s', 'Send the validation documents to Jo Lee.', { owners: [] }) };
  const donor = { candidateId: 'donor', sourcePass: 'primary', recordType: 'action', text: selected.text, evidenceIds: ['T0001'], record: row('d', selected.text) };
  const expected = A.borrowOwnersFromTwin(selected, [donor]);
  const { value, audit } = await D.capture(() => A.borrowOwnersFromTwin(selected, [donor]));
  assert.deepEqual(value, expected); assert.equal(audit.events[0].donorCandidate, 'donor'); assert.equal(audit.events[0].donorPass, 'primary');
});

test('reconstruction, accepted recovery and tracing share the real diagnostics context', async (t) => {
  const Recovery = require('../utils/meetingMinutesRefereeActionRecovery');
  const Promotion = require('../utils/meetingMinutesActionPromotion');
  const Tracing = require('../utils/meetingMinutesOriginalTracing');
  const selected = { candidateId: 'selected', recordType: 'action', sourcePass: 'recovery',
    text: 'Send the validation documents to Jo Lee.', evidenceIds: ['T0001'],
    record: row('selected-action', 'Send the validation documents to Jo Lee.', { owners: [] }) };
  const donor = { candidateId: 'donor', recordType: 'action', sourcePass: 'primary',
    text: selected.text, evidenceIds: ['T0001'], record: row('donor-action', selected.text) };
  const candidates = [selected, donor], before = structuredClone(candidates);
  const priorTrace = process.env.MEETING_MINUTES_AGENT_TRACE_OWNERS;
  process.env.MEETING_MINUTES_AGENT_TRACE_OWNERS = '0';
  t.after(() => { if (priorTrace === undefined) delete process.env.MEETING_MINUTES_AGENT_TRACE_OWNERS;
    else process.env.MEETING_MINUTES_AGENT_TRACE_OWNERS = priorTrace; });
  t.mock.method(console, 'info', () => {});
  const run = (reconstruct, reconcile) => {
    const recovered = reconstruct([{ candidateId: 'selected', disposition: 'publish' }], candidates, units);
    const accepted = reconcile([], recovered.actions, [], candidates, units);
    Tracing.traceOwners('accepted-recovery', accepted.actions, 'shared-owner-context');
    return accepted;
  };
  const expected = run(Recovery.reconstructRefereeActions, Promotion.reconcileAcceptedRefereeActions);
  const owned = await D.capture(() => run(Recovery.reconstructRefereeActions, Promotion.reconcileAcceptedRefereeActions));
  const facade = await D.capture(() => run(A.reconstructRefereeActions, A.reconcileAcceptedRefereeActions));
  assert.equal(A.borrowOwnersFromTwin, Recovery.borrowOwnersFromTwin);
  assert.equal(A.reconstructRefereeActions, Recovery.reconstructRefereeActions);
  assert.equal(A.reconcileAcceptedRefereeActions, Promotion.reconcileAcceptedRefereeActions);
  assert.deepEqual(owned.value, expected);
  assert.deepEqual(facade.value, expected);
  assert.deepEqual(owned.audit, facade.audit);
  assert.deepEqual(owned.value.actions[0].owners, ['Maya Patel']);
  assert.deepEqual(owned.value.restored, owned.value.actions);
  assert.equal(owned.value.eligibleCount, 1);
  assert.deepEqual(owned.audit.events.filter(event =>
    ['owner_borrow_proposed', 'owner_borrowed', 'restored', 'checkpoint'].includes(event.kind))
    .map(event => event.kind), ['owner_borrow_proposed', 'owner_borrowed', 'restored', 'checkpoint']);
  const restored = owned.audit.events.find(event => event.kind === 'restored');
  const checkpoint = owned.audit.events.at(-1);
  assert.equal(checkpoint.checkpoint, 'accepted-recovery');
  assert.deepEqual(checkpoint.outputs, restored.outputs);
  assert.deepEqual(owned.audit.nodes.find(node => node.ref === checkpoint.outputs[0]).record, owned.value.actions[0]);
  assert.equal(owned.audit.errors, 0);
  assert.deepEqual(candidates, before);
  assert.doesNotMatch(JSON.stringify(owned.value), /diagnostic|lineage/i);
});

test('budget exhaustion is distinguished from never nominated', async () => {
  const actions = [row('a', 'Send the validation documents to Jo Lee.'), row('b', 'Send the validation documents to Jo Lee.')];
  const { value, audit } = await D.capture(() => R.prepareActionReconciliation({ actions, sourceUnits: units, maxCandidates: 0 }));
  assert.equal(value.candidates.length, 0); assert.equal(value.unresolved[0].reason, 'candidate_budget_exhausted');
  assert.ok(audit.events.some(e => e.reason === 'candidate_budget_exhausted'));
});

function listFixture() {
  const sourceUnits = V.normaliseSourceUnits([{ id: 'T0001', speaker: 'Maya Patel', text: 'I will prepare and provide one list of all branches receiving shipments for language assessment purposes.' }]);
  return { sourceUnits, actions: [row('prepare', 'Prepare a list of all branches that equipment is shipped to for language assessment purposes.'), row('provide', 'Provide a list of all branches that receive shipments for language assessment purposes.')] };
}
for (const mode of ['merge', 'veto', 'failure', 'malformed']) test('semantic ' + mode + ' is observable without changing decisions or provider calls', async () => {
  const f = listFixture(); let calls = 0;
  const ask = async prompt => {
    calls++; if (mode === 'failure') throw Object.assign(Error('not stored'), { code: 'test_provider_failure' });
    if (mode === 'malformed') return { result: {} };
    const data = JSON.parse(prompt.split('\nDATA\n')[1]), result = require('./helpers/meeting-minutes-contained-response')(data);
    result.decisions[0].rows.forEach(r => { r.basis = 'commitment'; });
    result.decisions[2].relation = mode === 'veto' ? 'distinct_work' : 'same_obligation'; return { result };
  };
  const run = () => reconcileGeneratedSemanticStage({ changes: { actions: f.actions } }, { sourceUnits: f.sourceUnits }, 'actions', { policy, ask });
  const plain = await run(), expectedCalls = calls; calls = 0;
  const { value, audit } = await D.capture(run);
  assert.deepEqual(value.changes.actions, plain.changes.actions); assert.equal(calls, expectedCalls);
  assert.equal(value.changes.qualityState.actions.semanticReconciliation.stats.merged, mode === 'merge' ? 1 : 0);
  const event = audit.events.find(e => e.kind === 'semantic_outcome'); assert.ok(event); assert.equal(event.providerAttempted, true);
  if (mode === 'veto') assert.ok(event.failures.length);
  if (mode === 'failure') assert.match(JSON.stringify(event), /test_provider_failure/);
});

test('private audit persists unaltered through payload and JSON, and stays out of ordinary responses', async () => {
  const action = row('a', 'Send the validation documents to Jo Lee.');
  const value = await D.generate({ sourceUnits: units }, 'actions', {}, async () => {
    D.origin('primary', [action]); return { changes: { actions: [action], qualityState: {} } };
  });
  const original = value.changes.qualityState.actions.actionDiagnostics;
  const draft = { ...value.changes, sourceUnits: units, discussion: [], reviewFlags: [], details: {}, draftId: 'diagnostic-test' };
  const stored = JSON.parse(JSON.stringify(A.meetingAgentDraftPayload(draft)));
  assert.deepEqual(stored.qualityState.actions.actionDiagnostics, original);
  const browser = A.publicMeetingAgentDraft(stored); assert.equal(browser.qualityState, undefined);
  assert.doesNotMatch(JSON.stringify(browser), /action-diagnostics-v1|nominationCounts|owner_borrow_proposed/);
  const disabled = await D.generate({}, 'actions', { actionDiagnostics: false }, async () => ({ changes: { actions: [action] } }));
  assert.equal(disabled.changes.qualityState, undefined);
});

test('limits and recording failures are explicit and never affect the processing result', async () => {
  const action = row('a', 'Send the validation documents to Jo Lee.');
  const { value, audit } = await D.capture(() => { D.event('bad', [], [], { uncloneable: Symbol('x') }); D.origin('primary', [action]); return 'unchanged'; }, { maxNodes: 0, maxEvents: 1, maxBytes: 400 });
  assert.equal(value, 'unchanged'); assert.equal(audit.truncated, true); assert.equal(audit.errors, 1);
});

test('historical inspection labels missing lineage and makes no model request', async () => {
  const actions = cases[3][1], input = { actions, sourceUnits: units, qualityState: { actions: { semanticReconciliation: { policy } } } };
  const before = structuredClone(input), report = await inspect(input, [1, 2], { localDedupe: A.dedupeHybridActionRecords });
  assert.deepEqual(input, before); assert.equal(report.lineage.availability, 'historical_not_captured');
  assert.equal(report.providerCalls, 0); assert.equal(report.productionWrites, 0);
  assert.ok(report.nominationTrace.events.some(e => e.reason === 'nominated' && e.nominationClass === 'contact_paraphrases'));
  assert.equal(report.assessment.candidates.length, 1);
  await assert.rejects(() => inspect(input, [1, 1]), /different/);
});

test('identity admission links the final published row to its exact preceding snapshot', async () => {
  const actions = [row('A7', 'Send the validation documents to Jo Lee.')];
  const result = await D.generate({ sourceUnits: units }, 'actions', {}, async () => { D.origin('primary', actions); return { changes: { actions } }; });
  const admitted = A.admitMeetingAgentGeneratedActionChanges({ sourceUnits: units }, result.changes, 'diagnostic-identity');
  assert.ok(admitted.actions[0].occurrenceId);
  const trace = admitted.qualityState.actions.actionDiagnostics;
  const bound = trace.events.find(e => e.kind === 'identity_admitted'); assert.ok(bound);
  assert.equal(trace.nodes.find(n => n.ref === bound.outputs[0]).record.occurrenceId, admitted.actions[0].occurrenceId);
  const report = await inspect({ ...admitted, sourceUnits: units, actions: [...admitted.actions, row('other', 'Buy the replacement valve.')] }, [1, 2]);
  assert.ok(report.lineage.events.some(e => e.kind === 'created'));
  assert.ok(report.lineage.events.some(e => e.kind === 'identity_admitted'));
});

test('diagnostic snapshots never enter the generated Word document', async () => {
  const action = row('a', 'Send the validation documents to Jo Lee.');
  const draft = { actions: [action], sourceUnits: units, discussion: [], details: {}, reviewFlags: [],
    qualityState: { actions: { actionDiagnostics: { marker: 'PRIVATE_DIAGNOSTIC_SENTINEL' } } } };
  const docx = await require('../utils/meetingMinutesAgentDocx').generateMeetingMinutesAgentDocx(A.meetingAgentDraftForDocx(draft), false);
  const archive = await require('jszip').loadAsync(docx);
  for (const name of Object.keys(archive.files).filter(n => n.endsWith('.xml'))) assert.doesNotMatch(await archive.file(name).async('string'), /PRIVATE_DIAGNOSTIC_SENTINEL/);
});

test('register checkpoints do not invent continuity for duplicated local IDs', async () => {
  const a = row('A7', 'Send the validation documents.'), b = row('A7', 'Buy the replacement valve.');
  const { audit } = await D.capture(() => { D.checkpoint('first', [a, b]); D.checkpoint('second', [a]); });
  assert.equal(audit.events.filter(e => e.kind === 'checkpoint_unresolved').length, 2);
  assert.equal(audit.events.at(-1).inputs.length, 0);
});

test('inspection distinguishes source edits from the source used for the captured trace', async () => {
  const actions = [row('a', 'Send the validation documents.'), row('b', 'Review the document.')];
  const result = await D.generate({ sourceUnits: units }, 'actions', {}, async () => ({ changes: { actions } }));
  const report = await inspect({ ...result.changes, sourceUnits: [...units, { id: 'T0002', text: 'Changed source.' }] }, [1, 2]);
  assert.equal(report.lineage.availability, 'source_changed');
});

test('inspection follows an explicit candidate namespace handoff and rejects unmatched snapshots', async () => {
  const original = row('A7', 'Send the validation documents.'), published = { ...original, id: 'qualified-candidate' };
  const result = await D.generate({ sourceUnits: units }, 'actions', {}, async () => {
    D.origin('recovery', [original], { candidateId: 'qualified-candidate' });
    D.transition('referee_materialised', [published], [published], { candidateId: 'qualified-candidate' });
    return { changes: { actions: [published, row('other', 'Buy the replacement valve.')] } };
  });
  const report = await inspect({ ...result.changes, sourceUnits: units }, [1, 2]);
  assert.ok(report.lineage.events.some(e => e.origin?.pass === 'recovery'));
  const edited = { ...result.changes, sourceUnits: units, actions: result.changes.actions.map(r => ({ ...r, action: r.action + ' Edited.' })) };
  assert.equal((await inspect(edited, [1, 2])).lineage.availability, 'snapshot_not_matched');
});


test('disabled Original tracing still records the real checkpoint without console or filesystem writes', async t => {
  const tracing = require('../utils/meetingMinutesOriginalTracing');
  const fs = require('fs');
  const keys = ['MEETING_MINUTES_AGENT_TRACE_OWNERS', 'MEETING_MINUTES_AGENT_TRACE_OWNERS_PROBE',
    'MEETING_MINUTES_AGENT_TRACE_OWNERS_FILE', 'MEETING_MINUTES_AGENT_TRACE_PROPOSALS'];
  const saved = keys.map(key => [key, process.env[key]]);
  t.after(() => saved.forEach(([key, value]) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; }));
  process.env.MEETING_MINUTES_AGENT_TRACE_OWNERS = '0';
  process.env.MEETING_MINUTES_AGENT_TRACE_OWNERS_PROBE = '';
  process.env.MEETING_MINUTES_AGENT_TRACE_OWNERS_FILE = '/trace-fixture-must-not-be-written.log';
  process.env.MEETING_MINUTES_AGENT_TRACE_PROPOSALS = '';
  const info = t.mock.method(console, 'info', () => {});
  const append = t.mock.method(fs, 'appendFileSync', () => {});
  const actions = [row('trace-disabled', 'Send the validation documents to Jo Lee.')];
  const before = structuredClone(actions);
  const { value, audit } = await D.capture(() => {
    tracing.traceOwners('disabled', actions, 'trace-journey');
    tracing.traceProposals('disabled', actions, 'trace-journey');
    return actions;
  });
  assert.equal(value, actions);
  assert.deepEqual(actions, before);
  assert.deepEqual(audit.events.filter(event => event.kind === 'checkpoint').map(event => event.checkpoint), ['disabled']);
  assert.equal(audit.errors, 0);
  assert.equal(info.mock.callCount(), 0);
  assert.equal(append.mock.callCount(), 0);
});

test('enabled Original tracing preserves filtered logs, file payloads and suppressed write failures', async t => {
  const tracing = require('../utils/meetingMinutesOriginalTracing');
  const fs = require('fs');
  const keys = ['MEETING_MINUTES_AGENT_TRACE_OWNERS', 'MEETING_MINUTES_AGENT_TRACE_OWNERS_PROBE',
    'MEETING_MINUTES_AGENT_TRACE_OWNERS_FILE', 'MEETING_MINUTES_AGENT_TRACE_PROPOSALS'];
  const saved = keys.map(key => [key, process.env[key]]);
  t.after(() => saved.forEach(([key, value]) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; }));
  process.env.MEETING_MINUTES_AGENT_TRACE_OWNERS = 'true';
  process.env.MEETING_MINUTES_AGENT_TRACE_OWNERS_PROBE = 'validation';
  process.env.MEETING_MINUTES_AGENT_TRACE_OWNERS_FILE = '/trace-fixture-controlled.log';
  process.env.MEETING_MINUTES_AGENT_TRACE_PROPOSALS = 'VALIDATION';
  const logs = [];
  t.mock.method(console, 'info', message => logs.push(JSON.parse(message)));
  let failAppend = false;
  const append = t.mock.method(fs, 'appendFileSync', () => { if (failAppend) throw Error('controlled trace write failure'); });
  const actions = [row('trace-owned', 'Send the validation documents to Jo Lee.'),
    row('trace-other', 'Buy the replacement valve.', { owners: [] })];
  const before = structuredClone(actions);
  const { value, audit } = await D.capture(() => {
    tracing.traceOwners('enabled', actions, 'trace-journey');
    tracing.traceProposals('filtered', [{ after: actions[0] }, actions[1]], 'trace-journey');
    failAppend = true;
    assert.doesNotThrow(() => tracing.traceOwners('write-failure', actions, 'trace-journey'));
    return actions;
  });
  assert.equal(value, actions);
  assert.deepEqual(actions, before);
  assert.deepEqual(logs.map(log => log.event), ['owner_trace', 'meeting_agent_proposal_trace', 'owner_trace']);
  assert.deepEqual(logs[0].probe, { owners: ['Maya Patel'], evidence: ['T0001'] });
  assert.equal(logs[0].total, 2);
  assert.equal(logs[0].owned, 1);
  assert.equal(logs[1].step, 'filtered');
  assert.equal(logs[1].count, 1);
  assert.deepEqual(logs[1].rows, ['Send the validation documents to Jo Lee. | ["Maya Patel"] | ["T0001"]']);
  assert.equal(append.mock.callCount(), 2);
  assert.equal(append.mock.calls[0].arguments[0], '/trace-fixture-controlled.log');
  assert.ok(append.mock.calls[0].arguments[1].endsWith('\n'));
  const written = JSON.parse(append.mock.calls[0].arguments[1]);
  assert.equal(written.journeyId, 'trace-journey');
  assert.equal(written.step, 'enabled');
  assert.deepEqual(written.actions[0], { id: 'trace-owned', action: 'Send the validation documents to Jo Lee.',
    owners: ['Maya Patel'], evidenceIds: ['T0001'], reviewFlagIds: [] });
  assert.equal(written.actions.length, 2);
  assert.deepEqual(audit.events.filter(event => event.kind === 'checkpoint').map(event => event.checkpoint), ['enabled', 'enabled', 'write-failure', 'write-failure']);
  assert.equal(audit.errors, 0);
});
