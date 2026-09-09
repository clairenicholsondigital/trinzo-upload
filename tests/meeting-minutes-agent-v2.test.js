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
  isAutomaticTerminologyFlag,
  normaliseFlag,
  coverageFlags,
  isSalientCoverageFlag,
  isUsefulReviewFlag,
  evidenceSupportScore,
  actionEvidenceDisposition,
  actionCandidateInventory,
  discussionCandidateInventory,
  candidatePromptPack,
  uncoveredCandidateInventory,
  discussionRecoveryNeeded,
  actionRecoveryNeeded,
  groundedObjectives,
  groundedObjectiveRecords,
  groundedExecutiveSummary,
  relativeExactDate
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
  assert.equal(result.schemaVersion, 4);
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

test('a first-name assignment can resolve to an established full transcript speaker identity', () => {
  const identityUnits = normaliseSourceUnits([
    { id: 'T0300', speaker: 'Smith, Stuart M', text: 'Earlier context.', classification: 'keep' },
    { id: 'T0301', speaker: 'Jacqui Fox', text: 'Stuart will determine the training calendar.', classification: 'keep' }
  ]);
  const supported = normaliseAgentResult({ actions: [{
    action: 'Determine the training calendar.', owners: ['Stuart Smith'], evidenceIds: ['T0301']
  }] }, identityUnits, 'actions');
  assert.deepEqual(supported.actions[0].owners, ['Stuart Smith']);
  assert.ok(!supported.reviewFlags.some((flag) => flag.kind === 'ownership'));

  const inventedSurname = normaliseAgentResult({ actions: [{
    action: 'Determine the training calendar.', owners: ['Stuart Jones'], evidenceIds: ['T0301']
  }] }, identityUnits, 'actions');
  assert.deepEqual(inventedSurname.actions[0].owners, []);
  assert.ok(inventedSurname.reviewFlags.some((flag) => flag.kind === 'ownership'));
});

test('actions deduplicate only compatible owners and retain distinct deliverables', () => {
  const actionUnits = normaliseSourceUnits([
    { id: 'T0400', speaker: 'Priya', text: 'I will send the completed report to Alex.', classification: 'keep' },
    { id: 'T0401', speaker: 'Alex', text: 'I will review the completed report.', classification: 'keep' }
  ]);
  const result = normaliseAgentResult({ actions: [
    { action: 'Send the completed report to Alex', owner: 'Priya', evidenceIds: ['T0400'] },
    { action: 'Send completed report to Alex', owner: 'Priya', evidenceIds: ['T0400'] },
    { action: 'Review the completed report', owner: 'Alex', evidenceIds: ['T0401'] }
  ] }, actionUnits, 'actions');
  assert.equal(result.actions.length, 2);
});

test('idea-only contemplation is not promoted but a concrete recommendation remains', () => {
  assert.equal(isIdeaOnlyContemplation('Think about the parking issue and come back with a best idea.'), true);
  assert.equal(isIdeaOnlyContemplation('Consider the evidence and provide a written recommendation.'), false);
  const contemplationUnits = normaliseSourceUnits([
    { id: 'T0500', speaker: 'Trevor', text: 'Maybe think about the parking issue and come back with a best idea.', classification: 'keep' },
    { id: 'T0501', speaker: 'Alex', text: 'I will consider the evidence and provide a written recommendation.', classification: 'keep' }
  ]);
  const result = normaliseAgentResult({ actions: [
    { action: 'Think about the parking issue and come back with a best idea.', owner: 'Trevor', evidenceIds: ['T0500'] },
    { action: 'Consider the evidence and provide a written recommendation.', owner: 'Alex', evidenceIds: ['T0501'] }
  ] }, contemplationUnits, 'actions');
  assert.equal(result.actions.length, 1);
  assert.match(result.actions[0].action, /written recommendation/);
});

test('valid but unrelated evidence IDs cannot launder an unsupported action', () => {
  const units = normaliseSourceUnits([
    { id: 'T0600', speaker: 'Alex', text: 'The report was discussed as background.', classification: 'keep' },
    { id: 'T0601', speaker: 'Priya', text: 'Maybe we could create a dashboard one day.', classification: 'keep' }
  ]);
  const result = normaliseAgentResult({ actions: [
    { action: 'Send the report to Priya.', owner: 'Alex', evidenceIds: ['T0600'] },
    { action: 'Create a dashboard.', owner: 'Priya', evidenceIds: ['T0601'] }
  ] }, units, 'actions');
  assert.deepEqual(result.actions, []);
});

test('a plausible but weaker citation is remapped to the strongest matching workstream', () => {
  const units = normaliseSourceUnits([
    { id: 'T0090', speaker: 'Stuart', text: 'That is half the battle.', classification: 'keep' },
    { id: 'T0091', speaker: 'Jacqui', text: 'Stuart will determine a calendar of training and preparation activity over the next two weeks.', classification: 'keep' },
    { id: 'T0092', speaker: 'Jacqui', text: 'Niamh needs to plan her preparation time.', classification: 'keep' },
    { id: 'T0093', speaker: 'Jacqui', text: 'That covers the preparation schedule.', classification: 'keep' },
    { id: 'T0300', speaker: 'Jacqui', text: 'Moving to the final audit arrangements.', classification: 'keep' },
    { id: 'T0301', speaker: 'Niamh', text: 'There will be three people there during the third week.', classification: 'keep' },
    { id: 'T0302', speaker: 'Niamh', text: 'Are you going to have three audit tracks?', classification: 'keep' },
    { id: 'T0303', speaker: 'Niamh', text: 'Will everyone support each other?', classification: 'keep' },
    { id: 'T0304', speaker: 'Niamh', text: 'How will that work?', classification: 'keep' },
    { id: 'T0305', speaker: 'Stuart', text: 'That is what I am trying to work out in terms of logistics.', classification: 'keep' },
    { id: 'T0306', speaker: 'Stuart', text: 'I am thinking of having Niamh in a separate audit track, but I have got to work through the logistics and risk analysis.', classification: 'keep' },
    { id: 'T0307', speaker: 'Stuart', text: 'A separate track would give her freedom to focus on the software work.', classification: 'keep' }
  ]);
  const result = normaliseAgentResult({ actions: [{
    action: 'Determine the audit-track structure and logistics for the week when three auditors are participating, including whether Niamh will operate on a separate audit track.',
    owners: ['Stuart'],
    evidenceIds: ['T0091', 'T0092']
  }] }, units, 'actions');

  assert.equal(result.actions.length, 1);
  assert.ok(result.actions[0].evidenceIds.includes('T0302'));
  assert.ok(result.actions[0].evidenceIds.includes('T0306'));
  assert.ok(!result.actions[0].evidenceIds.includes('T0091'));
  assert.ok(!result.actions[0].evidenceIds.includes('T0092'));
  assert.ok(!result.reviewFlags.some((flag) => flag.kind === 'missing_evidence'));
});

test('an accepted request spanning adjacent turns is retained as one action candidate', () => {
  const units = normaliseSourceUnits([
    { id: 'T0700', speaker: 'Alex', text: 'Could you send the test report by Friday?', classification: 'keep' },
    { id: 'T0701', speaker: 'Priya', text: 'Yes, I will do that.', classification: 'keep' }
  ]);
  const result = normaliseAgentResult({ actions: [{
    action: 'Send the test report.', owner: 'Priya', timing: { kind: 'deadline', wording: 'Friday' }, evidenceIds: ['T0700', 'T0701']
  }] }, units, 'actions');
  assert.equal(result.actions.length, 1);
  assert.equal(actionEvidenceDisposition('Send the test report.', 'Could you send it? Yes, I will do that.'), 'accepted_request');
  assert.ok(actionCandidateInventory(units).some((candidate) => candidate.evidenceIds.includes('T0700') && candidate.evidenceIds.includes('T0701')));
});

test('an availability constraint does not reject the planning commitment it explains', () => {
  const units = normaliseSourceUnits([
    { id: 'T0702', speaker: 'Stuart', text: "I won't be available because I'll be carrying out another audit.", classification: 'keep' },
    { id: 'T0703', speaker: 'Stuart', text: 'You might want to review the preparation timeline, Jacqui.', classification: 'keep' },
    { id: 'T0704', speaker: 'Jacqui', text: 'Okay, Niamh, we need to plan through that then.', classification: 'keep' },
    { id: 'T0705', speaker: 'Stuart', text: "I won't be around between the 14th and the 17th.", classification: 'keep' }
  ]);
  const candidate = actionCandidateInventory(units).find((item) => item.focusEvidenceId === 'T0704');
  assert.ok(candidate);
  assert.equal(candidate.dispositionHint, 'accepted_request');
  assert.ok(candidate.cueKinds.includes('acceptance'));
});

test('assigned work to resolve an open decision is a dedicated action candidate', () => {
  const units = normaliseSourceUnits([
    { id: 'T0706', speaker: 'Niamh', text: 'Will this be a separate software track?', classification: 'keep' },
    { id: 'T0707', speaker: 'Stuart', text: "I'm trying to work that out at the moment.", classification: 'keep' },
    { id: 'T0708', speaker: 'Stuart', text: "I've got to work through the logistics and look at the risk analysis before deciding.", classification: 'keep' }
  ]);
  const candidate = actionCandidateInventory(units).find((item) => item.focusEvidenceId === 'T0708');
  assert.ok(candidate);
  assert.equal(candidate.dispositionHint, 'committed');
  assert.ok(candidate.cueKinds.includes('decision_resolution'));
});

test('a polished execution verb can be grounded by an accepted multi-turn commitment chain', () => {
  const units = normaliseSourceUnits([
    { id: 'T0710', speaker: 'Alex', text: 'The way Priya and I are going to approach the proposed lead-generation process is to check it with you first.', classification: 'keep' },
    { id: 'T0711', speaker: 'Alex', text: 'If you agree, what we want to do is take a very small slice and manually do it.', classification: 'keep' },
    { id: 'T0712', speaker: 'Sam', text: 'Yeah, I agree.', classification: 'keep' },
    { id: 'T0713', speaker: 'Alex', text: "Then we're going to test it.", classification: 'keep' }
  ]);
  const supported = normaliseAgentResult({ actions: [{
    action: 'Conduct a small-scale manual test of the proposed lead-generation process after stakeholder review to evaluate whether it produces the desired outcomes.',
    owners: ['Alex', 'Priya'],
    evidenceIds: ['T0710', 'T0711', 'T0712', 'T0713']
  }] }, units, 'actions');
  assert.equal(supported.actions.length, 1);
  assert.deepEqual(supported.actions[0].evidenceIds, ['T0710', 'T0711', 'T0712', 'T0713']);

  const unsupported = normaliseAgentResult({ actions: [{
    action: 'Book the external audit visit.',
    owners: ['Alex'],
    evidenceIds: ['T0710', 'T0711', 'T0712', 'T0713']
  }] }, units, 'actions');
  assert.deepEqual(unsupported.actions, []);
});

test('a compound completion action is grounded by its evidenced concrete signing step', () => {
  const units = normaliseSourceUnits([
    { id: 'T0720', speaker: 'Jacqui', text: 'There are a few audit participation documents that need signing.', classification: 'keep' },
    { id: 'T0721', speaker: 'Niamh', text: 'Okay, I can sign the compliance guidance acknowledgement and code of conduct.', classification: 'keep' },
    { id: 'T0722', speaker: 'Jacqui', text: 'The training attestation is part of that same required package.', classification: 'keep' },
    { id: 'T0723', speaker: 'Niamh', text: 'Yes, I will do all of those before taking part in the audit.', classification: 'keep' }
  ]);
  const result = normaliseAgentResult({ actions: [{
    action: 'Complete and sign the required audit participation documentation, including the compliance acknowledgement, code of conduct and training attestation.',
    owners: ['Niamh'],
    timing: { kind: 'deadline', wording: 'Before taking part in the audit', exactDate: '' },
    evidenceIds: ['T0720', 'T0721', 'T0722', 'T0723']
  }] }, units, 'actions');
  assert.equal(result.actions.length, 1);
  assert.deepEqual(result.actions[0].owners, ['Niamh']);
});

test('hybrid candidate ledgers retain implicit obligations and do not discard long-meeting candidates', () => {
  const units = normaliseSourceUnits(Array.from({ length: 90 }, (_, index) => ({
    id: `T${String(index + 1).padStart(4, '0')}`,
    speaker: index % 2 ? 'Priya' : 'Alex',
    text: index === 89
      ? 'The final validation report is required to be approved once testing finishes.'
      : `We need to review deliverable ${index + 1} and confirm its documented status.`,
    classification: 'keep'
  })));
  const actions = actionCandidateInventory(units);
  assert.ok(actions.length > 60, 'the internal ledger must not silently sample away later candidates');
  assert.ok(actions.some((candidate) => candidate.focusEvidenceId === 'T0090' && candidate.cueKinds.includes('obligation')));

  const packed = candidatePromptPack(actions, { maxCandidates: 20, maxChars: 50000 });
  assert.ok(packed.length <= 20);
  assert.ok(packed.some((candidate) => candidate.sequence > 75), 'bounded prompt packs must retain late-meeting coverage');
});

test('discussion ledger identifies facts, decisions and questions while excluding acknowledgements', () => {
  const units = normaliseSourceUnits([
    { id: 'T0750', speaker: 'Alex', text: 'The test programme covers three alarm configurations.', classification: 'keep' },
    { id: 'T0751', speaker: 'Priya', text: 'We agreed that clinical review will happen before approval.', classification: 'keep' },
    { id: 'T0752', speaker: 'Alex', text: 'Whether the mute behaviour is acceptable remains to be confirmed.', classification: 'keep' },
    { id: 'T0753', speaker: 'Priya', text: 'Okay.', classification: 'keep' }
  ]);
  const candidates = discussionCandidateInventory(units);
  assert.equal(candidates.length, 3);
  assert.ok(candidates.find((candidate) => candidate.focusEvidenceId === 'T0751').kindHints.includes('decision'));
  assert.ok(candidates.find((candidate) => candidate.focusEvidenceId === 'T0752').kindHints.includes('open_question'));
});

test('the completeness audit candidate set excludes represented evidence and keeps uncovered work', () => {
  const candidates = actionCandidateInventory(normaliseSourceUnits([
    { id: 'T0760', speaker: 'Priya', text: 'I will send the report tomorrow.', classification: 'keep' },
    { id: 'T0761', speaker: 'Alex', text: 'I will review the risk file next week.', classification: 'keep' }
  ]));
  const uncovered = uncoveredCandidateInventory(candidates, [{
    action: 'Send the report.', evidenceIds: ['T0760']
  }]);
  assert.ok(!uncovered.some((candidate) => candidate.focusEvidenceId === 'T0760'));
  assert.ok(uncovered.some((candidate) => candidate.focusEvidenceId === 'T0761'));
});

test('adaptive recovery triggers for uncovered high-value discussion and action evidence', () => {
  const discussionCandidates = discussionCandidateInventory(normaliseSourceUnits([
    { id: 'T0770', speaker: 'Alex', text: 'We agreed that approval will follow the three alarm tests.', classification: 'keep' }
  ]));
  assert.equal(discussionRecoveryNeeded(discussionCandidates, []).needed, true);
  const actionCandidates = actionCandidateInventory(normaliseSourceUnits([
    { id: 'T0771', speaker: 'Priya', text: 'I will send the completed report tomorrow.', classification: 'keep' }
  ]));
  assert.equal(actionRecoveryNeeded(actionCandidates, []).needed, true);
  assert.equal(actionRecoveryNeeded(actionCandidates, [{ action: 'Send the completed report.', evidenceIds: ['T0771'] }]).needed, false);
});

test('objective records retain valid source evidence', () => {
  const records = groundedObjectiveRecords([{ text: 'Review the three alarm tests before approval.', evidenceIds: ['T0001'] }], sourceUnits);
  assert.equal(records.length, 1);
  assert.equal(records[0].evidenceIds[0], 'T0001');
});

test('discussion consolidation removes repeated records but preserves distinct decisions', () => {
  const units = normaliseSourceUnits([
    { id: 'T0800', speaker: 'Alex', text: 'The entry fee remains £15.', classification: 'keep' },
    { id: 'T0801', speaker: 'Priya', text: 'We agreed that the closing date is Friday.', classification: 'keep' }
  ]);
  const result = normaliseAgentResult({ discussion: [
    { topic: 'Entry fees', points: [
      { text: 'The entry fee was confirmed as £15.', evidenceIds: ['T0800'] },
      { text: 'The £15 entry fee was confirmed.', evidenceIds: ['T0800'] }
    ] },
    { topic: 'Entry fee', decisions: [{ text: 'The closing date was agreed as Friday.', evidenceIds: ['T0801'] }] }
  ] }, units, 'discussion');
  assert.equal(result.discussion.length, 1);
  assert.equal(result.discussion[0].points.length, 1);
  assert.equal(result.discussion[0].decisions.length, 1);
});

test('one source passage can contribute several salient detail categories', () => {
  const inventory = salientDetailInventory(normaliseSourceUnits([
    { id: 'T0900', speaker: 'Alex', text: 'Three alarm tests remain pending approval before validation can finish.', classification: 'keep' }
  ]));
  assert.ok(inventory.some((item) => item.kind === 'quantity'));
  assert.ok(inventory.some((item) => item.kind === 'alarm_behaviour'));
  assert.ok(inventory.some((item) => item.kind === 'approval_status'));
  assert.ok(inventory.some((item) => item.kind === 'blocker_dependency'));
});

test('relative timing is resolved from the meeting date while dependency timing remains distinct', () => {
  assert.equal(relativeExactDate('tomorrow', '2026-09-09'), '2026-09-10');
  const timingUnits = normaliseSourceUnits([
    { id: 'T1000', speaker: 'Priya', text: 'I will send the report tomorrow.', classification: 'keep' }
  ]);
  const result = normaliseAgentResult({ actions: [{
    action: 'Send the report.', owner: 'Priya', timing: { kind: 'deadline', wording: 'tomorrow' }, evidenceIds: ['T1000']
  }] }, timingUnits, 'actions', { meetingDate: '2026-09-09' });
  assert.equal(result.actions[0].timing.exactDate, '2026-09-10');
  assert.equal(normaliseAgentResult({ actions: [{
    action: 'Send the report.', owner: 'Priya', timing: { kind: 'dependency', wording: 'once approval is received' }, evidenceIds: ['T0002']
  }] }, sourceUnits, 'actions', { enforceEvidence: false }).actions[0].timing.kind, 'dependency');
});

test('unsupported exact dates are removed independently without deleting supported timing wording', () => {
  const units = normaliseSourceUnits([
    { id: 'T1010', speaker: 'Stuart', text: 'We will hold a face-to-face catch-up at the hotel at the weekend before the Monday audit start.', classification: 'keep' }
  ]);
  assert.equal(relativeExactDate('At the weekend before the Monday audit start', '2026-06-22'), '');
  const result = normaliseAgentResult({ actions: [{
    action: 'Hold a face-to-face catch-up at the hotel before the audit starts.',
    owners: ['Stuart'],
    timing: { kind: 'target', wording: 'At the weekend before the Monday audit start', exactDate: '2026-06-29' },
    evidenceIds: ['T1010']
  }] }, units, 'actions', { meetingDate: '2026-06-22' });
  assert.equal(result.actions.length, 1);
  assert.deepEqual(result.actions[0].timing, {
    kind: 'target', wording: 'At the weekend before the Monday audit start', exactDate: ''
  });
  assert.ok(result.reviewFlags.some((flag) => flag.kind === 'timing' && /exact date/i.test(flag.message)));
});

test('summary and objectives are grounded in validated content rather than filled to a quota', () => {
  assert.ok(evidenceSupportScore('Three alarms require testing.', 'We need to test all three alarms before approval.') > 0.2);
  const objectiveUnits = normaliseSourceUnits([
    { id: 'T1100', speaker: 'Alex', text: "Today's objective is to test all three alarms before approval.", classification: 'keep' }
  ]);
  assert.deepEqual(groundedObjectives(['Test all three alarms', 'Plan an unrelated office move'], objectiveUnits), ['Test all three alarms']);
  const summary = groundedExecutiveSummary(
    'Three alarms require testing before approval. The company will open a new office in Paris.',
    [{ topic: 'Testing', points: [{ text: 'Three alarms require testing before approval.' }] }],
    []
  );
  assert.match(summary, /Three alarms/);
  assert.doesNotMatch(summary, /Paris/);
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

test('the hybrid wire and storage contracts are version four', () => {
  assert.equal(SCHEMA_VERSION, 4);
  assert.equal(PAYLOAD_VERSION, 4);
  assert.equal(migrateDraftPayload({ payloadVersion: 3, currentStep: 4 }).currentStep, 4);
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
  // Casual logistics and anecdotes used to account for two Abbott review flags.
  assert.equal(inventoried("We can get an Uber, but it depends on the cost because it's the back end of the World Cup."), false);
  assert.equal(inventoried('I remember wandering around one site and realising they did not make that product there.'), false);
  assert.equal(inventoried('I had a quick look and there were no alarm bells for me.'), false);
  // A dependency attached to real work remains salient.
  assert.equal(inventoried('The audit plan depends on the risk assessment being approved.'), true);
});

test('review flags distinguish extraction uncertainty from ordinary pending meeting content', () => {
  const pending = normaliseFlag({ kind: 'uncertain_fact', message: 'Document access had not yet been confirmed.' });
  const ambiguous = normaliseFlag({ kind: 'uncertain_fact', message: 'The language count contains unclear wording and could not be verified.' });
  const corrected = normaliseFlag({ ...pending, status: 'corrected', correctionNote: 'Access was confirmed later.' });
  assert.equal(isUsefulReviewFlag(pending), false);
  assert.equal(isUsefulReviewFlag(ambiguous), true);
  assert.equal(isUsefulReviewFlag(corrected), true, 'a reviewer correction remains part of the audit trail');

  assert.equal(normaliseFlag({ type: 'timing_uncertain', text: 'Confirm the target.' }).kind, 'timing');
  assert.equal(normaliseFlag({ type: 'ownership_uncertain', text: 'Confirm the owner.' }).kind, 'ownership');
  assert.equal(normaliseFlag({ type: 'unresolved_decision', text: 'A decision remains open.' }).kind, 'unresolved_decision');
});

test('salient coverage flags are stable, whole-draft flags and legacy stage-only flags are retired', () => {
  const inventory = salientDetailInventory(sourceUnits);
  const flags = coverageFlags(inventory, {
    discussion: [{ topic: 'Alarm testing', points: [{ text: 'All three alarms require testing before approval.' }] }],
    actions: [],
    executiveSummary: '',
    meetingObjectives: []
  });
  assert.ok(flags.every((flag) => /^coverage-detail-/.test(flag.id)));
  assert.ok(flags.every(isSalientCoverageFlag));
  assert.ok(flags.every(isUsefulReviewFlag));
  assert.equal(isUsefulReviewFlag({
    id: 'flag-old-stage-check', kind: 'uncertain_fact',
    message: 'Check whether this important transcript detail should appear in the minutes: “old stage-only check”'
  }), false);
  assert.equal(isUsefulReviewFlag({
    id: 'flag-old-stage-check', kind: 'uncertain_fact', status: 'corrected', correctionNote: 'Reviewed by the user.',
    message: 'Check whether this important transcript detail should appear in the minutes: “old stage-only check”'
  }), true);
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
