'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const {
  sanitiseDetails,
  normaliseSourceUnits,
  preparedTranscriptFromUnits,
  salientDetailInventory,
  normaliseAgentResult,
  buildProposal,
  applyProposal,
  migrateDraftPayload,
  PAYLOAD_VERSION,
  SCHEMA_VERSION,
  isIdeaOnlyContemplation,
  normaliseKnownTerms,
  normaliseColloquialTimes,
  normaliseKnownTermsDeep,
  isAutomaticTerminologyFlag
} = require('../utils/meetingMinutesAgentV2');
const { generateMeetingMinutesAgentDocx, timingLabel } = require('../utils/meetingMinutesAgentDocx');

const sourceUnits = normaliseSourceUnits([
  { id: 'T0001', speaker: 'Alex', timestamp: '00:01:02', text: 'We need to test all three alarms before approval.', classification: 'keep', confidence: 0.98 },
  { id: 'T0002', speaker: 'Priya', timestamp: '00:01:12', text: 'I will send the report to Alex by Friday.', classification: 'keep', confidence: 0.97 },
  { id: 'T0003', speaker: 'Alex', timestamp: '00:01:30', text: 'Maybe it is standard 60601 something; I am not sure.', classification: 'keep', confidence: 0.72 },
  { id: 'T0004', speaker: 'System', timestamp: '00:01:45', text: 'Recording stopped.', classification: 'remove', confidence: 0.99 }
]);

test('agent details omit organisation and prepared transcript has stable source references', () => {
  assert.deepEqual(sanitiseDetails({
    meetingTitle: 'Review', organisation: 'Must disappear', organization: 'Also disappear',
    meetingDate: '2026-06-23', allAttendees: ['Alex', 'Alex', 'Priya']
  }), {
    meetingTitle: 'Review', meetingDate: '2026-06-23', meetingLocation: '', meetingType: '',
    clientAttendeeLabel: 'Client', internalAttendees: [], clientAttendees: ['Alex', 'Priya'], allAttendees: ['Alex', 'Priya']
  });
  const prepared = preparedTranscriptFromUnits(sourceUnits);
  assert.match(prepared, /^\[T0001\] Alex 00:01:02:/);
  assert.doesNotMatch(prepared, /Recording stopped/);
  assert.match(prepared, /\[T0003\]/);
});

test('MDSAP spoken variants are corrected before generation and never become review flags', () => {
  const terminologyUnits = normaliseSourceUnits([
    { id: 'T0100', speaker: 'Alex', timestamp: '00:04:00', text: 'The Meds app audit is next month.', classification: 'keep', confidence: 0.96 }
  ]);
  assert.equal(terminologyUnits[0].text, 'The MDSAP audit is next month.');
  assert.match(preparedTranscriptFromUnits(terminologyUnits), /MDSAP audit/);
  assert.doesNotMatch(preparedTranscriptFromUnits(terminologyUnits), /Meds app/i);

  const result = normaliseAgentResult({
    discussion: [{
      topic: 'Meds app programme',
      points: [{ text: 'The Meds-app audit is next month.', evidenceIds: ['T0100'] }]
    }],
    reviewFlags: [{
      kind: 'uncertain_fact',
      message: "The programme reference was spoken as 'Meds app' and has been preserved without correction.",
      evidenceIds: ['T0100']
    }]
  }, terminologyUnits, 'discussion');

  assert.equal(result.discussion[0].topic, 'MDSAP programme');
  assert.equal(result.discussion[0].points[0].text, 'The MDSAP audit is next month.');
  assert.equal(result.reviewFlags.length, 0);
  assert.equal(normaliseKnownTerms('medsapp and meds app'), 'MDSAP and MDSAP');
  assert.deepEqual(normaliseKnownTermsDeep({ label: 'Meds-app' }), { label: 'MDSAP' });
  const savedAt = new Date('2026-09-08T12:34:00.000Z');
  assert.equal(normaliseKnownTermsDeep(savedAt), savedAt);
  assert.equal(JSON.stringify(normaliseKnownTermsDeep({ updatedAt: savedAt })), '{"updatedAt":"2026-09-08T12:34:00.000Z"}');
  assert.equal(isAutomaticTerminologyFlag({ message: 'Confirm Meds app.' }), true);
});

test('UK half-hour wording is parsed and does not create a false uncertainty flag', () => {
  const timeUnits = normaliseSourceUnits([
    { id: 'T0200', speaker: 'Priya', timestamp: '00:08:00', text: 'The warm-up rehearsal is at half eight tomorrow.', classification: 'keep', confidence: 0.98 }
  ]);
  assert.equal(timeUnits[0].text, 'The warm-up rehearsal is at 8:30 tomorrow.');
  assert.equal(normaliseColloquialTimes('Half past eleven today and half 7 on Friday.'), '11:30 today and 7:30 on Friday.');

  const result = normaliseAgentResult({
    discussion: [{ topic: 'Rehearsal', points: [{ text: 'The rehearsal is at half eight tomorrow.', evidenceIds: ['T0200'] }] }],
    reviewFlags: [{
      kind: 'uncertain_fact',
      message: "A rehearsal at 'half eight tomorrow' was referenced without a fully specified timestamp.",
      evidenceIds: ['T0200']
    }]
  }, timeUnits, 'discussion');

  assert.equal(result.discussion[0].points[0].text, 'The rehearsal is at 8:30 tomorrow.');
  assert.equal(result.reviewFlags.length, 0);
});

test('legacy attendee lists classify known Trinzo people as internal and retain an editable external label', () => {
  assert.deepEqual(sanitiseDetails({
    allAttendees: ['Jacqui Fox', 'Stuart Smith', 'Niamh Lynch'], clientAttendeeLabel: 'External'
  }), {
    meetingTitle: '', meetingDate: '', meetingLocation: '', meetingType: '', clientAttendeeLabel: 'External',
    internalAttendees: ['Jacqui Fox', 'Stuart Smith'], clientAttendees: ['Niamh Lynch'],
    allAttendees: ['Jacqui Fox', 'Stuart Smith', 'Niamh Lynch']
  });
});

test('restoring a removed source unit preserves order', () => {
  const restored = sourceUnits.map((unit) => unit.id === 'T0004' ? { ...unit, restored: true } : unit);
  const prepared = preparedTranscriptFromUnits(restored);
  assert.ok(prepared.indexOf('[T0003]') < prepared.indexOf('[T0004]'));
});

test('salient inventory catches quantities, alarms, approval and uncertain standards', () => {
  const inventory = salientDetailInventory(sourceUnits);
  assert.ok(inventory.some((item) => item.evidenceIds.includes('T0001')));
  assert.ok(inventory.some((item) => item.kind === 'standard_reference' && item.evidenceIds.includes('T0003')));
});

test('expanded result supports decisions, questions, joint owners, targets and evidence flags', () => {
  const result = normaliseAgentResult({
    discussion: [{
      topic: 'Alarm testing',
      points: [{ text: 'Three alarms require testing.', evidenceIds: ['T0001'] }],
      decisions: [{ text: 'Approval follows alarm testing.', evidenceIds: ['T0001'] }],
      openQuestions: [{ text: 'Confirm the standard reference.', evidenceIds: ['T0003'] }]
    }],
    actions: [{
      action: 'Send the report to Alex.', owners: ['Priya', 'Alex'],
      timing: { kind: 'target', wording: 'Friday', exactDate: '' }, evidenceIds: ['T0002']
    }]
  }, sourceUnits, 'discussion');
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.discussion[0].decisions.length, 1);
  assert.equal(result.discussion[0].openQuestions.length, 1);
  assert.deepEqual(result.actions[0].owners, ['Priya', 'Alex']);
  assert.equal(result.actions[0].timing.kind, 'target');
  assert.ok(result.reviewFlags.some((flag) => flag.kind === 'unclear_reference'));
});

test('unsupported evidence IDs are removed and visibly flagged', () => {
  const result = normaliseAgentResult({ actions: [{
    action: 'Send the report to Alex.', owner: 'Priya', deadline: 'Friday', evidenceIds: ['T9999']
  }] }, sourceUnits, 'actions');
  assert.ok(!result.actions[0].evidenceIds.includes('T9999'));
  assert.ok(result.reviewFlags.some((flag) => flag.kind === 'missing_evidence' && /unsupported source T9999/.test(flag.message)));
  assert.ok(result.actions[0].reviewFlagIds.length);
});

test('unsupported owners and timing are blanked and flagged without requiring participant membership', () => {
  const result = normaliseAgentResult({ actions: [{
    action: 'Send the report to Alex.', owners: ['Priya', 'Morgan'],
    timing: { kind: 'deadline', wording: 'next Tuesday', exactDate: '' }, evidenceIds: ['T0002']
  }] }, sourceUnits, 'actions');
  assert.deepEqual(result.actions[0].owners, ['Priya']);
  assert.deepEqual(result.actions[0].timing, { kind: 'not_stated', wording: '', exactDate: '' });
  assert.ok(result.reviewFlags.some((flag) => flag.kind === 'ownership'));
  assert.ok(result.reviewFlags.some((flag) => flag.kind === 'timing'));
});

test('actions deduplicate only compatible owners and retain distinct deliverables', () => {
  const result = normaliseAgentResult({ actions: [
    { action: 'Send the completed report to Alex', owner: 'Priya', evidenceIds: ['T0002'] },
    { action: 'Send completed report to Alex', owner: 'Priya', evidenceIds: ['T0002'] },
    { action: 'Review the completed report', owner: 'Alex', evidenceIds: ['T0001'] }
  ] }, sourceUnits, 'actions');
  assert.equal(result.actions.length, 2);
});

test('idea-only contemplation is not promoted but a concrete recommendation remains', () => {
  assert.equal(isIdeaOnlyContemplation('Think about the parking issue and come back with a best idea.'), true);
  assert.equal(isIdeaOnlyContemplation('Consider the evidence and provide a written recommendation.'), false);
  const result = normaliseAgentResult({ actions: [
    { action: 'Think about the parking issue and come back with a best idea.', owner: 'Trevor', evidenceIds: ['T0001'] },
    { action: 'Consider the evidence and provide a written recommendation.', owner: 'Alex', evidenceIds: ['T0001'] }
  ] }, sourceUnits, 'actions');
  assert.equal(result.actions.length, 1);
  assert.match(result.actions[0].action, /written recommendation/);
});

test('proposal changes can be partially accepted without altering unselected records', () => {
  const before = [{ id: 'a', action: 'First' }, { id: 'b', action: 'Second' }];
  const after = [{ id: 'a', action: 'First revised' }, { id: 'b', action: 'Second' }, { id: 'c', action: 'Third' }];
  const proposal = buildProposal('actions', before, after);
  const addition = proposal.changes.find((change) => change.type === 'add');
  assert.deepEqual(applyProposal(before, proposal, [addition.id]), [...before, after[2]]);
});

test('Word export uses UK dates, timing labels and contains no organisation field', async () => {
  assert.equal(timingLabel({ kind: 'deadline', exactDate: '2026-06-23' }), 'Deadline: 23 Jun 2026');
  const buffer = await generateMeetingMinutesAgentDocx({
    title: 'Review', details: { meetingTitle: 'Review', meetingDate: '2026-06-23', organisation: 'Hidden' },
    discussion: [], actions: [], sourceUnits, reviewFlags: []
  }, true);
  const zip = await JSZip.loadAsync(buffer);
  const documentXml = await zip.file('word/document.xml').async('string');
  assert.match(documentXml, /23 Jun 2026/);
  assert.match(documentXml, /Internal attendees:/);
  assert.match(documentXml, /Client attendees:/);
  assert.doesNotMatch(documentXml, /Organisation|Hidden/);
  assert.match(documentXml, /Evidence appendix/);
});

test('an inserted row is one change, and any subset of changes applies correctly', () => {
  const first = { id: 'a', action: 'Re-issue the alarm verification report.' };
  const second = { id: 'b', action: 'Chase the vendor for the translation files.' };
  const inserted = { id: 'x', action: 'Book the notified body audit slot.' };
  const edited = { id: 'b', action: 'Chase the vendor for the Polish translation files.' };

  // a pure insertion must not read as "edit every row after it"
  const insertion = buildProposal('actions', [first, second], [first, inserted, second]);
  assert.equal(insertion.changes.length, 1);
  assert.equal(insertion.changes[0].type, 'add');
  assert.deepEqual(applyProposal([first, second], insertion, [insertion.changes[0].id]), [first, inserted, second]);
  assert.deepEqual(applyProposal([first, second], insertion, []), [first, second]);

  // an insertion alongside an edit: each is independently acceptable
  const mixed = buildProposal('actions', [first, second], [first, inserted, edited]);
  const add = mixed.changes.find((change) => change.type === 'add');
  const modify = mixed.changes.find((change) => change.type === 'modify');
  assert.ok(add && modify);
  assert.deepEqual(applyProposal([first, second], mixed, [add.id]), [first, inserted, second]);
  assert.deepEqual(applyProposal([first, second], mixed, [modify.id]), [first, edited]);
  assert.deepEqual(applyProposal([first, second], mixed, [add.id, modify.id]), [first, inserted, edited]);

  // a removal, accepted and rejected
  const removal = buildProposal('actions', [first, inserted, second], [first, second]);
  assert.equal(removal.changes.length, 1);
  assert.equal(removal.changes[0].type, 'remove');
  assert.deepEqual(applyProposal([first, inserted, second], removal, [removal.changes[0].id]), [first, second]);
  assert.deepEqual(applyProposal([first, inserted, second], removal, []), [first, inserted, second]);

  // a proposal persisted before beforeIndex existed still applies
  const legacy = { stage: 'actions', changes: [{ id: 'L1', type: 'add', before: null, after: inserted, index: 2 }] };
  assert.deepEqual(applyProposal([first, second], legacy, ['L1']), [first, second, inserted]);
});

test('a reviewer edit is flagged against the evidence but never stripped', () => {
  const supplied = {
    actions: [{
      id: 'a1',
      action: 'Send the report to Alex by Friday.',
      owners: ['Orla Skally'],
      timing: { kind: 'deadline', wording: 'before the notified body visit', exactDate: '' },
      evidenceIds: ['T0002']
    }]
  };

  // agent output stays enforced: unsupported owners and timing are removed
  const fromAgent = normaliseAgentResult(supplied, sourceUnits, 'actions');
  assert.deepEqual(fromAgent.actions[0].owners, []);
  assert.equal(fromAgent.actions[0].timing.kind, 'not_stated');

  // the reviewer's own save keeps what they typed, and still raises the flags
  const fromReviewer = normaliseAgentResult(supplied, sourceUnits, '', { enforceEvidence: false });
  assert.deepEqual(fromReviewer.actions[0].owners, ['Orla Skally']);
  assert.equal(fromReviewer.actions[0].timing.wording, 'before the notified body visit');
  assert.ok(fromReviewer.reviewFlags.some((flag) => flag.kind === 'ownership'));
  assert.ok(fromReviewer.reviewFlags.some((flag) => flag.kind === 'timing'));

  // same flag identities either way, so an existing draft gains no duplicates
  assert.deepEqual(
    fromReviewer.reviewFlags.map((flag) => flag.id).sort(),
    fromAgent.reviewFlags.map((flag) => flag.id).sort()
  );
});

test('a draft saved before the flow gained two screens opens where its owner left it', () => {
  // 0 details, 1 focus, 2 discussion, 3 actions, 4 summary, 5 review.
  // Old numbering had no focus or summary screen, so 1/2/3 mean 2/3/5 now.
  const cases = [[0, 0], [1, 2], [2, 3], [3, 5]];
  for (const [stored, expected] of cases) {
    const once = migrateDraftPayload({ currentStep: stored });
    assert.equal(once.currentStep, expected);
    assert.equal(once.payloadVersion, PAYLOAD_VERSION);
    // Idempotent: a read that is never saved must not shift the step again.
    assert.equal(migrateDraftPayload(once).currentStep, expected);
    assert.equal(migrateDraftPayload({ currentStep: stored, payloadVersion: 0 }).currentStep, expected);
  }
  // An empty payload (the column default) must migrate, not be skipped.
  assert.equal(migrateDraftPayload({}).currentStep, 0);
  // A draft already at the current version is left exactly as it is.
  const current = { payloadVersion: PAYLOAD_VERSION, currentStep: 5 };
  assert.equal(migrateDraftPayload(current), current);
});

test('the wire contract version is not the storage version', () => {
  // SCHEMA_VERSION is interpolated into the prompt sent to Power Automate, so it
  // must not move when only the stored payload shape changes.
  assert.equal(SCHEMA_VERSION, 2);
  assert.equal(PAYLOAD_VERSION, 3);
});

test('meeting admin is never inventoried as a detail to check', () => {
  const inventoried = (text) => salientDetailInventory([{ id: 'T0001', speaker: 'X', text }]).length > 0;
  // The reported false positive: a colleague's calendar clash read as a standard.
  assert.equal(inventoried('Okay.I do have a hard stop at 1130, Jacqui.'), false);
  assert.equal(inventoried('You are on mute, we cannot hear you.'), false);
  assert.equal(inventoried('Let me share my screen for this bit.'), false);
  // The standards prefix is required, so a bare number is not a reference...
  assert.equal(inventoried('See page 214 of the technical file.'), false);
  assert.equal(inventoried('Could you turn your volume up, you are quiet.'), false);
  // ...while every genuine form still is.
  assert.equal(inventoried('We tested against BS EN 60601-1-8 and it passed.'), true);
  assert.equal(inventoried('ISO 13485 clause 7.3 applies to this change.'), true);
  assert.equal(inventoried('Maybe it is standard 60601 something; I am not sure.'), true);
  assert.equal(inventoried('The alarm must be audible at three metres.'), true);
  assert.equal(inventoried('We shipped 1200 units last quarter.'), true);
});

test('summary and objectives normalise alongside the rest of the draft', () => {
  const result = normaliseAgentResult({
    executiveSummary: '  The meeting closed out   MDSAP readiness. ',
    objectives: [{ text: 'Close out the MDSAP readiness pack.' }, { text: '' }, null],
    discussion: [],
    actions: []
  }, sourceUnits, 'summary');
  assert.equal(result.executiveSummary, 'The meeting closed out MDSAP readiness.');
  assert.equal(result.objectives.length, 1);
  assert.ok(Array.isArray(result.objectives[0].evidenceIds));
  // Objectives are a synthesis, so they stay out of the missing-evidence sweep
  // and must not leak its internal bookkeeping into the stored payload.
  assert.ok(!('_unsupportedEvidenceIds' in result.objectives[0]));
});
