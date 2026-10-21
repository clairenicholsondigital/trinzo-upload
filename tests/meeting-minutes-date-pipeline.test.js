'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const V = require('../utils/meetingMinutesAgentV2');
const T = require('../utils/meetingMinutesTiming');
const { mergeCommitmentDuplicates } = require('../utils/canonicalMinutes/commitmentDuplicates');
const { generateMeetingMinutesAgentDocx } = require('../utils/meetingMinutesAgentDocx');

function assertWorkAndTimingPreservedForReview(result, original, message) {
  const content = ({ reviewFlagIds: _flags, timingDecision: _decision, ...row }) => row;
  assert.deepEqual(result.actions.map(content), [content(original)], message);
  assert.ok(result.flags.length, 'an invalid checker result must now be visible rather than a silent no-op');
  assert.equal(result.accounting.complete, false);
}

// Exercise the real persistence and review handlers against a JSON round-trip
// store. The provider boundary throws if this offline test ever reaches it.
process.env.MEETING_MINUTES_AGENT_SPECULATIVE_PIPELINE_V1 = '0';
const fetchModule = require.resolve('node-fetch');
require(fetchModule);
const originalFetch = require.cache[fetchModule].exports;
let providerCalls = 0;
require.cache[fetchModule].exports = async () => {
  providerCalls += 1;
  throw new Error('Provider calls are forbidden in the date pipeline regression');
};
const db = require('../utils/db');
const originalGet = db.getMeetingMinutesAgentDraft;
const originalUpdate = db.updateMeetingMinutesAgentDraft;
let saved;
let writes = 0;
const roundTrip = value => JSON.parse(JSON.stringify(value));
db.getMeetingMinutesAgentDraft = async () => roundTrip(saved);
db.updateMeetingMinutesAgentDraft = async (id, userId, revision, updates) => {
  assert.equal(id, saved.draftId);
  assert.equal(userId, 'date-reviewer');
  assert.equal(revision, saved.revision);
  saved = roundTrip({ ...saved, ...V.migrateDraftPayload(updates.payload),
    revision: revision + 1, status: updates.status || saved.status });
  writes += 1;
  return roundTrip(saved);
};
const router = require('../routes/api');
const api = router.stagedEvaluation;
db.getMeetingMinutesAgentDraft = originalGet;
db.updateMeetingMinutesAgentDraft = originalUpdate;
require.cache[fetchModule].exports = originalFetch;

const options = { meetingDate: '2026-10-21' };
const action = (id, wording, evidenceIds, timing, owners = ['Sam']) => ({
  id, action: wording, owners, evidenceIds, timing, reviewFlagIds: []
});
const friday = { kind: 'deadline', wording: 'Friday', exactDate: '2026-10-23' };
async function request(method, path, body = {}) {
  const route = router.stack.find(layer => layer.route?.path === path && layer.route.methods[method])?.route;
  assert.ok(route, `missing ${method} ${path}`);
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; } };
  await route.stack.at(-1).handle({ params: { draftId: saved.draftId }, authUser: { userId: 'date-reviewer' }, body }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body;
}

test('date decisions survive the action lifecycle, actual proposal/save/reload handlers and Word publication', async () => {
  const sourceUnits = [
    { id: 'T0001', speaker: 'Sam', text: 'The planning call is Friday.' },
    { id: 'T0002', speaker: 'Sam', text: 'I will send the inspection report after the planning call.' },
    { id: 'T0003', speaker: 'Chair', text: 'Sam to review the access policy Friday, Jordan to write the supplier letter Monday.' },
    { id: 'T0004', speaker: 'Riley', text: 'I will ship the replacement sensor Saturday.' },
    { id: 'T0005', speaker: 'Riley', text: 'I will update the calibration register.' }
  ];
  saved = { draftId: 'date-lifecycle', revision: 1, status: 'draft', payloadVersion: V.PAYLOAD_VERSION,
    details: { meetingTitle: 'Equipment planning', meetingType: 'General', meetingDate: options.meetingDate },
    sourceUnits, preparedTranscript: V.preparedTranscriptFromUnits(sourceUnits),
    discussion: [], actions: [], reviewFlags: [], changeHistory: [], redoHistory: [], staleStages: [],
    qualityState: { preparation: { dateContext: { source: 'reviewer', meetingDate: options.meetingDate } } } };
  const sourceDraft = roundTrip(saved);
  writes = 0;
  const normalised = V.normaliseAgentResult({ actions: [
    action('file', 'Send the inspection report.', ['T0001', 'T0002'], friday),
    action('shared', 'Review the access policy and write the supplier letter.', ['T0003'], friday, ['Sam', 'Jordan']),
    action('ship', 'Ship the replacement sensor.', ['T0004'], { kind: 'deadline', wording: 'Saturday', exactDate: '' }, ['Riley'])
  ] }, sourceUnits, 'actions', { ...options, dedupeActions: false });
  assert.equal(normalised.actions.length, 3);
  assert.equal(normalised.actions.find(row => row.id === 'file').timing.kind, 'not_stated');
  const timingItems = V.timingCheckItems(normalised.actions, sourceUnits, options);
  const shipItem = timingItems.find(item => item.action === 'Ship the replacement sensor.');
  assert.ok(shipItem, 'the source-supported Saturday must reach the real timing checker');
  const reviewed = V.applyTimingCheckResults(normalised.actions, timingItems, [{ id: shipItem.id,
    verdict: 'correct', timingQuote: 'Saturday', stepQuote: 'ship the replacement sensor' }], options);
  const split = V.splitExplicitMultiOwnerActions(reviewed.actions, sourceUnits, options);
  assert.equal(split.split, 1);
  assert.equal(split.actions.find(row => row.action === 'Review the access policy.').timing.exactDate, '2026-10-23');
  assert.equal(split.actions.find(row => row.action === 'Write the supplier letter.').timing.exactDate, '2026-10-26');

  // A later discovery copy must not revive a rejected timing merely because
  // another pass returned the original, pre-review candidate again.
  const staleCopy = action('file-copy', 'Send the inspection report.', ['T0001', 'T0002'], friday);
  const siblings = V.reconcileSiblingTimingDecisions([...split.actions, staleCopy], sourceUnits, options);
  assert.equal(siblings.actions.at(-1).timing.kind, 'not_stated');
  const merged = mergeCommitmentDuplicates(siblings.actions).actions;
  const survival = api.reconcileFinalApprovedActions(merged, split.actions);
  const final = V.finaliseActionTimings(survival.actions, sourceUnits, options);
  const file = final.actions.find(row => row.action === 'Send the inspection report.');
  assert.ok(file.timingDecision.rejectedExactDates.includes(friday.exactDate));
  assert.equal(file.timing.kind, 'not_stated');
  assert.equal(final.actions.filter(row => row.action === 'Send the inspection report.').length, 1);
  assert.equal(final.actions.find(row => row.id === 'ship').timing.exactDate, '2026-10-24');

  const proposalAfter = { ...file, action: 'Send the inspection report after the planning call.', timing: friday };
  const proposalSiblings = V.reconcileSiblingTimingDecisions([...final.actions, proposalAfter], sourceUnits, options);
  const checkedProposal = V.finaliseActionTimings([proposalSiblings.actions.at(-1)], sourceUnits,
    { ...options, assessments: final.assessments });
  assert.equal(checkedProposal.actions[0].timing.kind, 'not_stated');
  const proposal = api.preselectActionProposal({ id: 'clarify', stage: 'actions', changes: [{
    id: 'clarify-report', type: 'modify', before: file, after: checkedProposal.actions[0],
    beforeIndex: final.actions.indexOf(file), index: final.actions.indexOf(file), selected: true
  }] }, final.actions, sourceUnits);
  const flags = [...normalised.reviewFlags, ...reviewed.flags, ...split.flags,
    ...siblings.flags, ...final.flags, ...proposalSiblings.flags, ...checkedProposal.flags];
  const persisted = await api.persistMeetingAgentBackgroundStage({ draftId: saved.draftId, userId: 'date-reviewer',
    stage: 'actions', sourceDraft, result: { changes: { actions: final.actions, pendingProposal: proposal,
      qualityState: { ...saved.qualityState, actions: { timingPolicyVersion: T.TIMING_POLICY_VERSION,
        timingAssessments: [...final.assessments, ...checkedProposal.assessments] } } }, reviewFlags: flags } });
  assert.deepEqual(persisted.conflictFields, []);
  let loaded = (await request('get', '/meeting-minutes-agent/drafts/:draftId')).draft;
  assert.equal(loaded.actions.find(row => row.id === file.id).timing.kind, 'not_stated');
  await request('post', '/meeting-minutes-agent/drafts/:draftId/proposal',
    { revision: saved.revision, decision: 'accept', acceptAll: true });
  loaded = (await request('get', '/meeting-minutes-agent/drafts/:draftId')).draft;
  const applied = loaded.actions.find(row => row.id === file.id);
  assert.match(applied.action, /after the planning call/);
  assert.equal(applied.timing.kind, 'not_stated');
  assert.ok(applied.timingDecision.rejectedExactDates.includes(friday.exactDate));

  // The real reviewer-save boundary must permit a deliberate date-only entry
  // that the source itself does not supply, then protect it on reprocessing.
  const manual = action('reviewer-register', 'Update the calibration register.', ['T0005'],
    { kind: 'target', wording: '', exactDate: '2026-11-04' }, ['Riley']);
  await request('patch', '/meeting-minutes-agent/drafts/:draftId',
    { revision: saved.revision, actions: [...loaded.actions, manual] });
  loaded = (await request('get', '/meeting-minutes-agent/drafts/:draftId')).draft;
  assert.ok(loaded.actions.find(row => row.id === file.id).timingDecision?.rejectedExactDates.includes(friday.exactDate),
    'an unrelated reviewer save must retain the generated row source-rejection decision');
  const reviewer = loaded.actions.find(row => row.id === manual.id);
  assert.equal(reviewer.reviewerAuthored, true);
  assert.equal(reviewer.timing.exactDate, manual.timing.exactDate);
  const rerun = V.finaliseActionTimings(V.backfillActionCommitmentEvidence(loaded.actions, sourceUnits, options), sourceUnits,
    { ...options, assessments: saved.qualityState.actions.timingAssessments });
  assert.equal(rerun.actions.find(row => row.id === file.id).timing.kind, 'not_stated');
  assert.equal(rerun.actions.find(row => row.id === manual.id).timing.exactDate, manual.timing.exactDate);
  const xml = await (await JSZip.loadAsync(await generateMeetingMinutesAgentDocx(api.meetingAgentDraftForDocx(saved), false)))
    .file('word/document.xml').async('string');
  const reportRow = xml.match(/<w:tr>(?:(?!<\/w:tr>)[\s\S])*Send the inspection report(?:(?!<\/w:tr>)[\s\S])*<\/w:tr>/)?.[0];
  assert.ok(reportRow);
  assert.doesNotMatch(reportRow, /23 Oct(?:ober)?|Friday/);
  assert.match(xml, /Saturday \(24 Oct 2026\)/);
  assert.match(xml, /4 Nov 2026/);
  assert.equal(writes, 3, 'generation, selected proposal and reviewer edit each used the actual save boundary');
  assert.equal(providerCalls, 0);
});

test('a source-valid qualification cannot donate another task or owner timing', () => {
  const sourceUnits = [
    { id: 'T0001', speaker: 'Sam', text: 'I will send the inspection report Friday.' },
    { id: 'T0002', speaker: 'Jordan', text: 'For the training pack, ideally Monday, but Wednesday is the hard stop.' }
  ];
  const original = action('report', 'Send the inspection report.', ['T0001'], friday);
  const items = V.timingCheckItems([original], sourceUnits, options);
  const result = V.applyTimingCheckResults([original], items, [{ id: items[0].id, verdict: 'qualified', timingQuote: 'Friday',
    stepQuote: 'training pack', qualificationQuote: 'ideally Monday, but Wednesday is the hard stop',
    preferredTiming: 'ideally Monday', fallbackTiming: 'Wednesday' }], options);
  assertWorkAndTimingPreservedForReview(result, original);
  assert.equal(result.rejected[0].reason, 'qualification_not_bound_to_action');
  const sameOwnerUnits = sourceUnits.map(unit => ({ ...unit, speaker: 'Sam' }));
  const sameOwnerItems = V.timingCheckItems([original], sameOwnerUnits, options);
  const sameOwner = V.applyTimingCheckResults([original], sameOwnerItems, [{ id: sameOwnerItems[0].id,
    verdict: 'qualified', timingQuote: 'Friday',
    qualificationQuote: 'ideally Monday, but Wednesday is the hard stop',
    preferredTiming: 'ideally Monday', fallbackTiming: 'Wednesday' }], options);
  assertWorkAndTimingPreservedForReview(sameOwner, original, 'the same speaker can introduce a different task');
  const singleTurnUnits = [sourceUnits[0], { id: 'T0002', speaker: 'Sam',
    text: 'I will send the inspection report Friday, and for the training pack, ideally Monday, but Wednesday is the hard stop.' }];
  const singleTurnItems = V.timingCheckItems([original], singleTurnUnits, options);
  for (const stepQuote of ['training pack', '']) {
    const singleTurn = V.applyTimingCheckResults([original], singleTurnItems, [{ id: singleTurnItems[0].id,
      verdict: 'qualified', timingQuote: 'Friday', stepQuote,
      qualificationQuote: 'ideally Monday, but Wednesday is the hard stop',
      preferredTiming: 'ideally Monday', fallbackTiming: 'Wednesday' }], options);
    assertWorkAndTimingPreservedForReview(singleTurn, original, 'one transcript turn can contain separate work and timing');
  }
  for (const [speaker, work] of [['Jordan', 'the training pack'], ['Sam', 'that training pack'], ['Jordan', 'the inspection report']]) {
    const suffixUnits = [{ id: 'T0001', speaker: 'Chair', text: 'Sam will send the inspection report Friday.' },
      { id: 'T0002', speaker, text: `Before Friday, ideally Monday, is when I will send ${work}.` }];
    const suffixItems = V.timingCheckItems([original], suffixUnits, options);
    const suffix = V.applyTimingCheckResults([original], suffixItems, [{ id: suffixItems[0].id,
      verdict: 'qualified', timingQuote: 'Friday', stepQuote: 'inspection report',
      qualificationQuote: 'Before Friday, ideally Monday', preferredTiming: 'ideally Monday', fallbackTiming: '' }], options);
    assertWorkAndTimingPreservedForReview(suffix, original, 'work or a different assignee after the quoted prefix must remain in scope');
  }
  const deicticUnits = [{ id: 'T0001', speaker: 'Sam', text: 'I will send the inspection report Friday.' },
    { id: 'T0002', speaker: 'Sam', text: 'Ideally before Friday, but Monday is the hard stop if needed.' }];
  const deicticItems = V.timingCheckItems([original], deicticUnits, options);
  const positive = V.applyTimingCheckResults([original], deicticItems, [{ id: deicticItems[0].id, verdict: 'qualified',
    timingQuote: 'Friday', qualificationQuote: deicticUnits[1].text.slice(0, -1),
    preferredTiming: 'before Friday', fallbackTiming: 'Monday' }], options);
  assert.equal(positive.actions[0].timing.kind, 'target');
  assert.match(positive.actions[0].timing.wording, /Preferred: before Friday; fallback: Monday/);
  assert.deepEqual(positive.rejected, []);
  const switchedUnits = [deicticUnits[0],
    { id: 'T0002', speaker: 'Sam', text: 'I will prepare the training pack Friday.' },
    { ...deicticUnits[1], id: 'T0003' }];
  const switchedItems = V.timingCheckItems([original], switchedUnits, options);
  const switched = V.applyTimingCheckResults([original], switchedItems, [{ id: switchedItems[0].id,
    verdict: 'qualified', timingQuote: 'Friday', qualificationQuote: deicticUnits[1].text.slice(0, -1),
    preferredTiming: 'before Friday', fallbackTiming: 'Monday' }], options);
  assertWorkAndTimingPreservedForReview(switched, original, 'a date reference after a new owned task does not prove which task it qualifies');
});

test('source-scoped rejection blocks an old sibling but permits explicitly restated new timing evidence', () => {
  const units = [
    { id: 'T0001', speaker: 'Chair', text: 'The inspection report needs a final review.' },
    { id: 'T0002', speaker: 'Sam', text: 'The briefing is Friday. I will review the inspection report after that briefing.' },
    { id: 'T0003', speaker: 'Sam', text: 'Actually, I will review the inspection report Friday morning before the briefing.' }
  ];
  const original = action('old', 'Review the inspection report.', ['T0001', 'T0002'], friday);
  const rejected = T.rejectActionTiming(original, units, { ...options, reason: 'belongs_to_other_step' });
  const oldCopy = { ...original, id: 'copy' };
  const restated = { ...original, id: 'restated', evidenceIds: ['T0001', 'T0003'] };
  const result = V.reconcileSiblingTimingDecisions([rejected, oldCopy, restated], units, options);
  assert.equal(result.actions[1].timing.kind, 'not_stated');
  assert.deepEqual(result.actions[2].timing, friday);
  assert.equal(V.finaliseActionTimings([result.actions[2]], units, options).actions[0].timing.exactDate, friday.exactDate);
});

test('a verbatim non-calendar replacement still needs the same owned task', () => {
  const sourceUnits = [
    { id: 'T0001', speaker: 'Sam', text: 'I will send the inspection report Friday.' },
    { id: 'T0002', speaker: 'Jordan', text: 'I will send the training pack after approval.' }
  ];
  const original = action('report', 'Send the inspection report.', ['T0001'], friday);
  const items = V.timingCheckItems([original], sourceUnits, options);
  const result = V.applyTimingCheckResults([original], items, [{ id: items[0].id, verdict: 'misread',
    timingQuote: 'Friday', correctTiming: 'after approval' }], options);
  assertWorkAndTimingPreservedForReview(result, original);
  assert.equal(result.rejected[0].reason, 'replacement_not_bound_to_action');
  const validUnits = [sourceUnits[0], { id: 'T0002', speaker: 'Sam',
    text: 'I will send the inspection report after approval.' }];
  const validItems = V.timingCheckItems([original], validUnits, options);
  const positive = V.applyTimingCheckResults([original], validItems, [{ id: validItems[0].id, verdict: 'misread',
    timingQuote: 'Friday', correctTiming: 'after approval' }], options);
  assert.equal(positive.actions[0].timing.kind, 'dependency');
  assert.equal(positive.actions[0].timing.wording, 'after approval');
  assert.ok(positive.actions[0].evidenceIds.includes('T0002'));
});

test('automatic acceptance of a legacy saved proposal cannot revive a source-rejected date', async () => {
  const sourceUnits = [
    { id: 'T0001', speaker: 'Sam', text: 'The planning call is Friday.' },
    { id: 'T0002', speaker: 'Sam', text: 'I will file the inspection report after the planning call.' },
    { id: 'T0003', speaker: 'Riley', text: 'I will send the equipment checklist Saturday.' }
  ];
  const proposed = action('legacy-file', 'File the inspection report.', ['T0001', 'T0002'], friday);
  const rejected = T.rejectActionTiming(proposed, sourceUnits, { ...options, reason: 'belongs_to_other_step' });
  const saturday = action('checklist', 'Send the equipment checklist.', ['T0003'],
    { kind: 'deadline', wording: 'Saturday', exactDate: '2026-10-24' }, ['Riley']);
  saved = { draftId: 'legacy-timing-proposal', revision: 1, status: 'draft', payloadVersion: V.PAYLOAD_VERSION,
    details: { meetingTitle: 'Equipment planning', meetingDate: options.meetingDate, meetingType: 'General' },
    sourceUnits, actions: [saturday], discussion: [], reviewFlags: [], changeHistory: [], redoHistory: [], staleStages: [],
    qualityState: { actions: { timingAssessments: [rejected.timingDecision] } },
    pendingProposal: { id: 'legacy', stage: 'actions', changes: [{ id: 'legacy-add', type: 'add', before: null,
      after: proposed, beforeIndex: 1, index: 1, selected: true }] } };
  await request('post', '/meeting-minutes-agent/drafts/:draftId/proposal',
    { revision: saved.revision, decision: 'accept', automatic: true });
  const loaded = (await request('get', '/meeting-minutes-agent/drafts/:draftId')).draft;
  assert.equal(loaded.actions.length, 2, 'date validation must retain the real outstanding work');
  const accepted = loaded.actions.find(row => row.id === proposed.id);
  assert.equal(accepted.action, proposed.action);
  assert.equal(accepted.timing.kind, 'not_stated');
  assert.ok(accepted.timingDecision.rejectedExactDates.includes(friday.exactDate));
  assert.deepEqual(loaded.actions.find(row => row.id === saturday.id).timing, saturday.timing);
  assert.equal(loaded.pendingProposal, null);
  assert.equal(providerCalls, 0);
});

test('meeting-date confirmation undo and redo restore the effective anchor without rolling back newer generation metadata', async () => {
  const conflictContext = { meetingDate: options.meetingDate, source: 'transcript_header', conflict: true, invalid: [],
    candidates: [{ source: 'transcript_header', date: options.meetingDate }, { source: 'filename', date: '2026-10-22' }] };
  const flag = { id: 'meeting-date-source-check', kind: 'timing', status: 'open', evidenceIds: [],
    message: 'The transcript and filename give different meeting dates. Confirm the meeting date before relying on relative timing.' };
  saved = { draftId: 'meeting-anchor-history', revision: 1, status: 'draft', payloadVersion: V.PAYLOAD_VERSION,
    details: { meetingTitle: 'Equipment planning', meetingDate: options.meetingDate, meetingType: 'General' },
    sourceUnits: [], actions: [], discussion: [], reviewFlags: [flag], changeHistory: [], redoHistory: [], staleStages: [],
    qualityState: { preparation: { dateContext: conflictContext, sourceUnitCount: 0 },
      actions: { backgroundReceipt: 'before-confirmation' }, discussion: { arrangementVersion: 8 } } };
  assert.equal(api.meetingAgentTimingAnchor(saved), '');
  await request('patch', '/meeting-minutes-agent/drafts/:draftId', { revision: saved.revision,
    reviewFlags: [{ ...flag, status: 'confirmed' }], reviewDecisionLabel: 'Confirm meeting date' });
  assert.equal(api.meetingAgentTimingAnchor(saved), options.meetingDate);
  assert.equal(saved.reviewFlags.find(row => row.id === flag.id).status, 'confirmed');
  const sourceDraft = roundTrip(saved);
  await api.persistMeetingAgentBackgroundStage({ draftId: saved.draftId, userId: 'date-reviewer',
    stage: 'actions', sourceDraft, result: { changes: { qualityState: { actions: { backgroundReceipt: 'after-confirmation' } } },
      reviewFlags: [] } });
  await request('post', '/meeting-minutes-agent/drafts/:draftId/undo', { revision: saved.revision });
  assert.equal(api.meetingAgentTimingAnchor(saved), '');
  assert.equal(saved.reviewFlags.find(row => row.id === flag.id).status, 'open');
  assert.deepEqual(saved.qualityState.preparation.dateContext, conflictContext);
  assert.equal(saved.qualityState.actions.backgroundReceipt, 'after-confirmation');
  assert.equal(saved.qualityState.preparation.sourceUnitCount, 0);
  assert.equal(saved.qualityState.discussion.arrangementVersion, 8);
  await request('post', '/meeting-minutes-agent/drafts/:draftId/redo', { revision: saved.revision });
  assert.equal(api.meetingAgentTimingAnchor(saved), options.meetingDate);
  assert.equal(saved.reviewFlags.find(row => row.id === flag.id).status, 'confirmed');
  assert.equal(saved.qualityState.preparation.dateContext.source, 'reviewer');
  assert.equal(saved.qualityState.actions.backgroundReceipt, 'after-confirmation');
  assert.equal(saved.qualityState.discussion.arrangementVersion, 8);
  assert.equal(providerCalls, 0);
});
