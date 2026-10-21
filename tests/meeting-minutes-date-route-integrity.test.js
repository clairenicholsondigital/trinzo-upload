'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../routes/api').stagedEvaluation;

const sourceUnits = [{ id: 'T0001', speaker: 'Robin Taylor', text: 'I will send the report on 12 November 2026.' }];
const action = (exactDate = '2026-11-12', extra = {}) => ({
  id: 'report', action: 'Send the report.', owners: ['Robin Taylor'],
  timing: { kind: 'deadline', wording: '12 November 2026', exactDate },
  evidenceIds: ['T0001'], reviewFlagIds: [], ...extra
});

test('a date-only action correction is visible and changes the editable fingerprint', () => {
  const before = action(); const after = action('2026-11-13');
  assert.notEqual(api.meetingAgentActionsFingerprint([before]), api.meetingAgentActionsFingerprint([after]));
  assert.equal(api.meetingAgentProposalChangeIsVisible({ type: 'modify', before, after }), true);
  assert.equal(api.meetingAgentProposalChangeIsVisible({ type: 'modify', before, after: { ...before, evidenceIds: ['T0001', 'T0002'] } }), false);
});

test('regeneration cannot replace a reviewer-only date edit or automatically propose undoing it', () => {
  const generated = action();
  const baseline = { sourceUnits, actions: [generated], reviewFlags: [], qualityState: { actions: {} } };
  const first = api.meetingAgentRegenerationChanges(baseline, 'actions', { actions: [generated], qualityState: { actions: {} } }, { reviewFlags: [] });
  const fresh = { ...baseline, actions: [action('2026-11-13', { reviewerAuthored: true })], qualityState: first.changes.qualityState };
  const next = api.meetingAgentRegenerationChanges(fresh, 'actions', { actions: [generated], qualityState: { actions: {} } }, { reviewFlags: [] });
  assert.equal(next.keptReviewerActions, true);
  assert.equal(Object.hasOwn(next.changes, 'actions'), false);
  assert.ok(!(next.changes.pendingProposal?.changes || []).some(change => change.before?.id === 'report'), 'the reviewer date must not be changed back by a suggestion');
});

test('date-anchor and timing policy participate in the derived staged cache identity', () => {
  const draft = { preparedTranscript: 'Robin: I will send the report tomorrow.', transcriptSha256: 'source', details: { meetingType: 'General', meetingDate: '2026-11-12' } };
  const key = api.privateStagedCandidateCacheKey(draft, 'actions');
  assert.notEqual(key, api.privateStagedCandidateCacheKey({ ...draft, details: { ...draft.details, meetingDate: '2026-11-13' } }, 'actions'));
  assert.equal(key, api.privateStagedCandidateCacheKey(structuredClone(draft), 'actions'));
  assert.notEqual(key, api.privateStagedCandidateCacheKey(draft, 'discussion'));
});

test('both referee request modes carry the same confirmed meeting-date context', () => {
  const details = { meetingDate: '2026-11-12', meetingTitle: 'Project planning', meetingType: 'General' };
  const candidate = { candidateId: 'report', recordType: 'action', text: 'Send the report.', owners: ['Robin Taylor'], timing: { kind: 'target', wording: 'tomorrow', exactDate: '2026-11-13' }, evidenceIds: ['T0001'] };
  for (const builder of [api.meetingMinutesAgentRefereePrompt, api.meetingMinutesAgentRefereeRepairPrompt]) {
    const prompt = builder({ stage: 'actions', transcript: '[T0001] Robin Taylor: I will send the report tomorrow.', sourceUnits, details, candidates: [candidate], requestId: 'date-contract' });
    const payload = JSON.parse(prompt.split('refereePayload:\n')[1]);
    assert.equal(payload.meetingDetails.meetingDate, details.meetingDate);
    assert.ok(payload.timingPolicyVersion);
    assert.equal(payload.candidateEnsemble[0].timing.exactDate, '2026-11-13');
  }
});

test('referee nomination retains conflicting structured dates under unique candidate identities', () => {
  const friday = action('2026-10-23', { id: 'friday',
    timing: { kind: 'deadline', wording: 'Friday', exactDate: '2026-10-23' } });
  const monday = action('2026-10-26', { id: 'monday',
    timing: { kind: 'deadline', wording: 'Monday', exactDate: '2026-10-26' } });
  const ledger = api.hybridCandidateLedgerFromResult({ actions: [friday, monday] }, 'primary');
  assert.equal(new Set(ledger.map(row => row.candidateId)).size, 2,
    'date-only candidate differences must not collide before the referee sees them');
  const selected = api.meetingAgentRefereeCandidates('actions', ledger);
  assert.equal(selected.length, 2);
  assert.deepEqual(selected.map(row => row.timing.exactDate).sort(), ['2026-10-23', '2026-10-26']);
  const duplicates = api.hybridCandidateLedgerFromResult({ actions: [friday, { ...friday, id: 'copy' }] }, 'primary');
  assert.equal(api.meetingAgentRefereeCandidates('actions', duplicates).length, 1,
    'an identical timing still allows the original duplicate nomination rule');
});

test('anchored discovery and later action recovery retain the date-precision contract', () => {
  const input = { stage: 'actions', transcript: '[T0001] Robin: I will send the report early next week.',
    details: { meetingDate: '2026-11-12' }, candidates: [], anchors: [], actions: [], discussion: [] };
  for (const builder of [api.meetingMinutesAgentAnchoredDiscussionPrompt, api.meetingMinutesAgentAnchoredActionPrompt,
    api.meetingMinutesAgentRecoveryPrompt, api.meetingMinutesAgentCriticPrompt, api.meetingMinutesAgentSalvagePrompt]) {
    const prompt = builder(input);
    assert.match(prompt, /Do not select a range endpoint or invent a day for this\/next week/);
    assert.match(prompt, /preferred timing and its fallback/);
    assert.match(prompt, /2026-11-12/);
  }
});

test('invalid reviewer calendar dates fail at the save boundary instead of rolling or crashing export', () => {
  for (const meetingDate of ['2026-02-30', '2026-13-01', '2026-04-31', '2026-02-29']) {
    assert.throws(() => api.assertMeetingAgentDateInput({ meetingDate }), error => error.statusCode === 400 && error.code === 'invalid_meeting_agent_date');
  }
  assert.doesNotThrow(() => api.assertMeetingAgentDateInput({ meetingDate: '2028-02-29' }));
  assert.doesNotThrow(() => api.assertMeetingAgentDateInput({ meetingDate: '' }));
  assert.throws(() => api.assertMeetingAgentDateInput({}, [action('2026-11-31')]), error => error.statusCode === 400);
  const historical = action('2026-11-31');
  assert.doesNotThrow(() => api.assertMeetingAgentDateInput({}, [historical], { actions: [historical] }), 'an unrelated save must not trap a legacy draft');
  assert.throws(() => api.assertMeetingAgentDateInput({}, [action('2026-11-32')], { actions: [historical] }), error => error.statusCode === 400);
});

test('date-only reviewer changes stale the summary and cannot adopt a stale speculative stage', () => {
  const before = { details: { meetingDate: '2026-11-10' }, preparedTranscript: 'Robin will send the report on 12 November.', sourceUnits,
    actions: [action()], executiveSummary: 'The report will be sent on 12 November.' };
  const after = { ...before, actions: [action('2026-11-13')] };
  assert.deepEqual(api.meetingAgentDerivedStaleStages(before, after), ['summary']);
  assert.notEqual(api.meetingAgentStageInputFingerprint(before, 'summary'), api.meetingAgentStageInputFingerprint(after, 'summary'));
});

test('meeting-date provenance retains source conflicts without changing transcript or inventing a date', () => {
  const transcript = 'Planning transcript\n12 November 2026\nRobin Taylor: We will send the report tomorrow.';
  const context = api.meetingAgentDateContext(transcript, 'planning_20261113.txt', { meetingDate: '2026-11-12' });
  assert.equal(context.meetingDate, '2026-11-12');
  assert.equal(context.source, 'transcript_header');
  assert.equal(context.conflict, true);
  assert.deepEqual(context.invalid, []);
  const invalid = api.meetingAgentDateContext('Planning transcript\n30 February 2026', '', { meetingDate: '2026-02-30' });
  assert.equal(invalid.meetingDate, '');
  assert.ok(invalid.invalid.length > 0);
  assert.equal(api.meetingAgentTimingAnchor({ details: { meetingDate: '2026-11-12' }, qualityState: { preparation: { dateContext: context } } }), '');
  assert.equal(api.meetingAgentTimingAnchor({ details: { meetingDate: '2026-11-12' }, qualityState: { preparation: { dateContext: { source: 'reviewer' } } } }), '2026-11-12');
});

test('discussion with a derived date becomes stale when its meeting anchor changes', () => {
  const before = { details: { meetingDate: '2026-11-12' }, sourceUnits: [{ id: 'T0001', speaker: 'Robin', text: 'The inspection starts tomorrow.' }],
    discussion: [{ topic: 'Inspection', points: [{ text: 'The inspection starts on 13 November 2026.', evidenceIds: ['T0001'] }], decisions: [], openQuestions: [] }] };
  const after = { ...before, details: { meetingDate: '2026-11-13' } };
  assert.deepEqual(api.meetingAgentDerivedStaleStages(before, after), ['discussion']);
  assert.deepEqual(api.meetingAgentStaleStagesAfterGeneration(after, before, 'discussion', { discussion: before.discussion }), ['discussion']);
  const absolute = { ...before, sourceUnits: [{ id: 'T0001', speaker: 'Robin', text: 'The inspection starts on 13 November 2026.' }] };
  assert.deepEqual(api.meetingAgentDerivedStaleStages(absolute, { ...absolute, details: after.details }), []);
});

test('weekday and yearless calendar discussion dates retain their meeting-anchor dependency', () => {
  for (const item of [
    { source: 'The inspection starts Saturday.', text: 'The inspection starts on 24 October 2026.', from: '2026-10-21', to: '2026-10-25' },
    { source: 'The inspection starts on 12 November.', text: 'The inspection starts on 12 November 2026.', from: '2026-10-21', to: '2027-10-21' },
    { source: 'The inspection starts November 12.', text: 'The inspection starts on 12 November 2026.', from: '2026-10-21', to: '2027-10-21' },
    { source: 'The review is on 12 November 2026; the inspection starts Saturday.', text: 'The inspection starts on 24 October 2026.', from: '2026-10-21', to: '2026-10-25' }
  ]) {
    const before = { details: { meetingDate: item.from }, sourceUnits: [{ id: 'T0001', speaker: 'Robin', text: item.source }],
      discussion: [{ topic: 'Inspection', points: [{ text: item.text, evidenceIds: ['T0001'] }], decisions: [], openQuestions: [] }] };
    const after = { ...before, details: { meetingDate: item.to } };
    assert.equal(api.meetingAgentDiscussionUsesDateAnchor(before), true, item.source);
    assert.deepEqual(api.meetingAgentDerivedStaleStages(before, after), ['discussion'], item.source);
    assert.deepEqual(api.meetingAgentStaleStagesAfterGeneration(after, before, 'discussion', { discussion: before.discussion }), ['discussion'], item.source);
  }
  for (const source of ['The inspection starts on 12 November 2026.',
    'The inspection starts Saturday, 24 October 2026.', 'The inspection starts on 24 October 2026 (Saturday).']) {
    const before = { details: { meetingDate: '2026-10-21' }, sourceUnits: [{ id: 'T0001', speaker: 'Robin', text: source }],
      discussion: [{ topic: 'Inspection', points: [{ text: source, evidenceIds: ['T0001'] }], decisions: [], openQuestions: [] }] };
    assert.equal(api.meetingAgentDiscussionUsesDateAnchor(before), false, source);
    assert.deepEqual(api.meetingAgentDerivedStaleStages(before, { ...before, details: { meetingDate: '2027-10-21' } }), [], source);
  }
});

test('confirming a conflicting anchor invalidates relative-date caches even without changing its selected day', () => {
  const before = { details: { meetingDate: '2026-11-12' }, preparedTranscript: 'Robin: I will send the report tomorrow.', sourceUnits,
    actions: [action()], executiveSummary: 'The report will be sent tomorrow.', qualityState: { preparation: { dateContext: { source: 'transcript_header', conflict: true } } } };
  const after = { ...before, qualityState: { preparation: { dateContext: { source: 'reviewer' } } } };
  assert.notEqual(api.privateStagedCandidateCacheKey(before, 'actions'), api.privateStagedCandidateCacheKey(after, 'actions'));
  assert.notEqual(api.meetingAgentStageInputFingerprint(before, 'actions'), api.meetingAgentStageInputFingerprint(after, 'actions'));
  assert.notEqual(api.meetingAgentActionPrimaryPromptForDraft(before), api.meetingAgentActionPrimaryPromptForDraft(after));
  assert.deepEqual(api.meetingAgentDerivedStaleStages(before, after), ['actions', 'summary']);
  assert.equal(api.meetingAgentPromptDetails(before).timingContext.meetingDate, '');
  assert.equal(api.meetingAgentPromptDetails(before).meetingDate, '', 'the primary date field must not bypass an unconfirmed anchor');
  assert.equal(api.meetingAgentPromptDetails(before).timingContext.unconfirmedSelectedDate, '2026-11-12');
  assert.equal(api.meetingAgentPromptDetails(after).timingContext.meetingDate, '2026-11-12');
});
