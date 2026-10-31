'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const V = require('../utils/meetingMinutesAgentV2');
const { resolveEvidence } = require('../utils/meetingMinutesEvidenceResolution');
const { reconcileDiscussionClauseSources } = require('../utils/meetingMinutesDiscussionSources');
const { originalEnquiryActions, sameEnquiryActionSnapshot } = require('../utils/meetingMinutesEnquiryRecovery');
const { markMeetingAgentReviewerEdits } = require('../utils/meetingMinutesReviewerEdits');
const { normalizeUnassignedSupportingDetails, withoutRepresentedUnassignedDetails } = require('../utils/meetingMinutesSupportingDetails');
const { mergeMeetingAgentFlags } = require('../utils/meetingMinutesReviewFlags');

const reviewerOptions = {
  enforceEvidence: false, dedupeActions: false, mergeTopics: false, preserveReviewerEdits: true
};

function draftFixture() {
  const sourceUnits = V.normaliseSourceUnits([
    { id: 'T0001', speaker: 'Morgan', text: 'The inspection review remains scheduled for Friday.' },
    { id: 'T0002', speaker: 'Morgan', text: 'The laboratory remains available during the inspection.' },
    { id: 'T0003', speaker: 'Morgan', text: 'The team approved the revised checklist.' },
    { id: 'T0004', speaker: 'Morgan', text: 'Which site will host the assessment?' }
  ]);
  return {
    draftId: 'history-save', revision: 1, payloadVersion: V.PAYLOAD_VERSION,
    currentStep: 2, selectedStep: 2, details: {}, sourceUnits,
    discussion: [{
      id: 'inspection', topic: 'Inspection', mergedTopicIds: ['earlier-inspection'],
      points: [{
        id: 'review', text: sourceUnits[0].text, evidenceIds: ['T0001'],
        mergedFromIds: ['earlier-review'], reviewFlagIds: [],
        supportingDetails: [{
          id: 'laboratory', text: sourceUnits[1].text, evidenceIds: ['T0002'],
          mergedFromIds: ['earlier-laboratory']
        }]
      }],
      decisions: [{
        id: 'checklist', text: sourceUnits[2].text, evidenceIds: ['T0003'],
        mergedFromIds: ['earlier-checklist'], supportingDetails: [], reviewFlagIds: []
      }],
      openQuestions: [{
        id: 'site', text: sourceUnits[3].text, evidenceIds: ['T0004'],
        mergedFromIds: ['earlier-site'], supportingDetails: [], reviewFlagIds: []
      }]
    }],
    actions: [], reviewFlags: [], staleStages: [], meetingObjectives: [], executiveSummary: ''
  };
}

// Evaluate the production PATCH registration alone. This executes its actual
// reviewer-marking/normalization/save flow without importing the application,
// authentication, database, scheduler or any model/provider module.
function patchHarness(initial) {
  const source = fs.readFileSync(path.join(__dirname, '../routes/meetingMinutesReviewer.js'), 'utf8');
  const start = source.indexOf('function registerMeetingMinutesReviewerSave(');
  const closing = source.indexOf('\n}\n', start);
  const end = closing < 0 ? -1 : closing + 2;
  assert.ok(start >= 0 && end > start, 'the production draft PATCH route must be present');
  let stored = structuredClone(initial);
  let handler;
  let saveCount = 0;
  const context = {
    parallelMinutes: require('../utils/meetingMinutesParallel'),
    router: { patch(routePath, auth, callback) { handler = callback; } },
    requireAuth() {},
    loadOwnedMeetingAgentDraft: async () => structuredClone(stored),
    assertMeetingAgentDateInput() {},
    sanitiseMeetingAgentDetails: V.sanitiseDetails,
    TIMING_POLICY_VERSION: 1,
    publicMeetingAgentDraft: value => structuredClone(value),
    meetingAgentSummaryTextHash: value => String(value || ''),
    markMeetingAgentReviewerEdits,
    normalizeUnassignedSupportingDetails,
    withoutRepresentedUnassignedDetails,
    normaliseAgentResult: V.normaliseAgentResult,
    resolveEvidence: resolveEvidence,
    reconcileDiscussionClauseSources,
    originalEnquiryActions,
    sameEnquiryActionSnapshot,
    timingRecovery: require('../utils/meetingMinutesTimingRecovery'),
    actionUnion: require('../utils/meetingMinutesActionUnionRewrite'),
    actionPhase: require('../utils/meetingMinutesActionPhaseCorrection'),
    optionalReview: require('../utils/meetingMinutesOptionalReview'),
    discussionRewrite: require('../utils/canonicalMinutes/discussionBoundedRewrite'),
    discussionClaims: require('../utils/canonicalMinutes/discussionClaimConsolidation'),
    discussionActionSeparation: require('../utils/canonicalMinutes/discussionActionSeparation'),
    meetingAgentTimingAnchor: () => '',
    rebaseMeetingAgentProposal: value => value,
    MEETING_AGENT_PAYLOAD_VERSION: V.PAYLOAD_VERSION,
    MEETING_AGENT_MAX_STEP: 5,
    mergeMeetingAgentFlags,
    reopenFlagsOfReAddedItems: flags => flags,
    reconcileMeetingAgentOrphanFlags: flags => flags,
    meetingMinutesAgentText: V.text,
    meetingAgentReviewHistoryEntry() { throw new Error('Unexpected review history write'); },
    meetingAgentDerivedStaleStages: () => [],
    includedSections: value => value,
    normaliseKeptActionIds: value => value || [],
    normaliseKeptActionOccurrenceIds: value => value || [],
    normaliseRemovedActions: value => value || [],
    saveMeetingAgentDraft: async (previous, req, changes) => {
      saveCount += 1;
      stored = JSON.parse(JSON.stringify({ ...previous, ...changes, revision: previous.revision + 1 }));
      return structuredClone(stored);
    },
    scheduleStageSpeculation() {},
    sendMeetingAgentFailure(res, error) { throw error; }
  };
  vm.runInNewContext(source.slice(start, end), context, { filename: 'draft-patch-history-harness.js' });
  context.registerMeetingMinutesReviewerSave(context.router, context.scheduleStageSpeculation);
  return {
    get stored() { return structuredClone(stored); },
    get saveCount() { return saveCount; },
    async save(edit = () => {}) {
      const body = JSON.parse(JSON.stringify(stored));
      edit(body);
      const response = { json(value) { this.body = value; return this; } };
      await handler({ body, params: { draftId: stored.draftId }, authUser: { userId: 'offline-reviewer' } }, response);
      assert.equal(response.body.ok, true);
      return response.body.draft;
    }
  };
}

function assertMergeHistory(draft) {
  const topic = draft.discussion[0];
  assert.deepEqual(topic.mergedTopicIds, ['earlier-inspection']);
  assert.deepEqual(topic.points[0].mergedFromIds, ['earlier-review']);
  assert.deepEqual(topic.points[0].supportingDetails[0].mergedFromIds, ['earlier-laboratory']);
  assert.deepEqual(topic.decisions[0].mergedFromIds, ['earlier-checklist']);
  assert.deepEqual(topic.openQuestions[0].mergedFromIds, ['earlier-site']);
}

test('a no-op PATCH save retains historical topic IDs after the merged topics have disappeared', async () => {
  const harness = patchHarness(draftFixture());
  const saved = await harness.save();
  assert.deepEqual(saved.discussion[0].mergedTopicIds, ['earlier-inspection']);
  assert.equal(saved.discussion[0].reviewerAuthored, undefined, 'history alone is not a text edit');
  assert.deepEqual(harness.stored.discussion[0].mergedTopicIds, ['earlier-inspection']);
  assert.equal(harness.saveCount, 1, 'the assertion covers the persistence input');
});

test('PATCH retains point, decision and question histories without merging reviewer rows', async () => {
  const harness = patchHarness(draftFixture());
  const saved = await harness.save(body => {
    body.discussion[0].points.push({
      ...structuredClone(body.discussion[0].points[0]), id: 'separate-review', mergedFromIds: ['separate-earlier-review']
    });
  });
  const topic = saved.discussion[0];
  assert.deepEqual(topic.points.map(row => row.id), ['review', 'separate-review']);
  assert.deepEqual(topic.points.map(row => row.mergedFromIds), [['earlier-review'], ['separate-earlier-review']]);
  assert.deepEqual(topic.decisions[0].mergedFromIds, ['earlier-checklist']);
  assert.deepEqual(topic.openQuestions[0].mergedFromIds, ['earlier-site']);
});

test('editing the topic and point wording in PATCH keeps their legitimate historical IDs', async () => {
  const harness = patchHarness(draftFixture());
  const saved = await harness.save(body => {
    body.discussion[0].topic = 'Inspection preparation';
    body.discussion[0].points[0].text = 'The inspection review remains scheduled for Friday afternoon.';
  });
  assertMergeHistory(saved);
  assert.equal(saved.discussion[0].topic, 'Inspection preparation');
  assert.match(saved.discussion[0].points[0].text, /Friday afternoon/);
  assert.equal(saved.discussion[0].points[0].reviewerAuthored, true, 'existing edit attribution still applies');
});

test('PATCH preserves supporting-detail history when the reviewer edits that child', async () => {
  const harness = patchHarness(draftFixture());
  const saved = await harness.save(body => {
    body.discussion[0].points[0].supportingDetails[0].text = 'The laboratory remains available for the full inspection.';
  });
  const child = saved.discussion[0].points[0].supportingDetails[0];
  assert.deepEqual(child.mergedFromIds, ['earlier-laboratory']);
  assert.match(child.text, /full inspection/);
  assert.equal(child.reviewerAuthored, true);
});

test('repeated PATCH saves and JSON round trips retain history without resurrecting deleted records', async () => {
  const harness = patchHarness(draftFixture());
  for (let index = 0; index < 3; index += 1) assertMergeHistory(await harness.save());
  const afterDeletion = await harness.save(body => {
    body.discussion[0].points[0].supportingDetails = [];
    body.discussion[0].decisions = [];
  });
  assert.deepEqual(afterDeletion.discussion[0].points[0].supportingDetails, []);
  assert.deepEqual(afterDeletion.discussion[0].decisions, []);
  const savedAgain = await harness.save();
  assert.deepEqual(savedAgain.discussion[0].points[0].supportingDetails, []);
  assert.deepEqual(savedAgain.discussion[0].decisions, []);
  assert.deepEqual(savedAgain.discussion[0].points[0].mergedFromIds, ['earlier-review']);
  const empty = await harness.save(body => { body.discussion = []; });
  assert.deepEqual(empty.discussion, []);
});

test('reviewer history accepts bounded string IDs, removes duplicates and self references, and never coerces objects', () => {
  const input = draftFixture();
  const exactLimit = 'h'.repeat(220);
  const malformed = [' old-record ', 'old-record', 'review', '', ' ', null, 7, true, {},
    ['nested-id'], 'x'.repeat(221), 'bad\u0000id', exactLimit];
  input.discussion[0].mergedTopicIds = [' inspection ', ...malformed];
  input.discussion[0].points[0].mergedFromIds = malformed;
  input.discussion[0].points[0].supportingDetails[0].mergedFromIds = ['laboratory', ...malformed];
  const original = structuredClone(input);
  const result = V.normaliseAgentResult(input, input.sourceUnits, '', reviewerOptions);
  assert.deepEqual(result.discussion[0].mergedTopicIds, ['old-record', 'review', exactLimit]);
  assert.deepEqual(result.discussion[0].points[0].mergedFromIds, ['old-record', exactLimit]);
  assert.deepEqual(result.discussion[0].points[0].supportingDetails[0].mergedFromIds,
    ['old-record', 'review', exactLimit]);
  assert.deepEqual(input, original, 'normalization leaves editor objects untouched');
  for (const invalid of ['old-record', { 0: 'old-record', length: 1 }, null]) {
    const next = draftFixture();
    next.discussion[0].mergedTopicIds = invalid;
    next.discussion[0].points[0].mergedFromIds = invalid;
    const output = V.normaliseAgentResult(next, next.sourceUnits, '', reviewerOptions);
    assert.equal(output.discussion[0].mergedTopicIds, undefined);
    assert.equal(output.discussion[0].points[0].mergedFromIds, undefined);
  }
});

test('oversized reviewer merge-history arrays have a fixed input and output budget', () => {
  const input = draftFixture();
  input.discussion[0].mergedTopicIds = Array.from({ length: 1200 }, (_, index) => `old-topic-${index}`);
  input.discussion[0].points[0].mergedFromIds = Array.from({ length: 1200 }, (_, index) => `old-point-${index}`);
  input.discussion[0].points[0].supportingDetails[0].mergedFromIds =
    Array.from({ length: 1200 }, (_, index) => `old-child-${index}`);
  const result = V.normaliseAgentResult(input, input.sourceUnits, '', reviewerOptions);
  const topic = result.discussion[0];
  assert.equal(topic.mergedTopicIds.length, 1000);
  assert.equal(topic.points[0].mergedFromIds.length, 1000);
  assert.equal(topic.points[0].supportingDetails[0].mergedFromIds.length, 1000);
  assert.equal(topic.mergedTopicIds.at(-1), 'old-topic-999');
});

test('merge-history IDs confer no authorship, confirmation, evidence or timing proof on reviewer records', () => {
  const input = draftFixture();
  const point = input.discussion[0].points[0];
  point.text = 'The warehouse paint color is turquoise.';
  point.evidenceIds = [];
  point.primaryEvidenceIds = ['earlier-review', 'T9999'];
  point.mergedFromIds = ['T0001', 'T9999', 'stage_2_human_confirmation'];
  point.source = 'stage_2_human_confirmation';
  point.timingDecision = { status: 'confirmed', sourceEvidenceIds: ['T9999'] };
  point.arbitraryClientProperty = { reviewerAuthored: true };
  const result = V.normaliseAgentResult(input, input.sourceUnits, '', reviewerOptions);
  const row = result.discussion[0].points[0];
  assert.deepEqual(row.mergedFromIds, point.mergedFromIds);
  assert.equal(row.reviewerAuthored, undefined);
  assert.equal(row.confirmedTopic, undefined);
  assert.equal(row.source, undefined);
  assert.equal(row.timingDecision, undefined);
  assert.equal(row.arbitraryClientProperty, undefined);
  assert.deepEqual(row.evidenceIds, []);
  assert.deepEqual(row.primaryEvidenceIds, []);
  assert.ok(result.reviewFlags.some(flag => flag.kind === 'missing_evidence' && row.reviewFlagIds.includes(flag.id)));
  const withoutHistory = structuredClone(input);
  delete withoutHistory.discussion[0].mergedTopicIds;
  delete withoutHistory.discussion[0].points[0].mergedFromIds;
  const comparison = V.normaliseAgentResult(withoutHistory, input.sourceUnits, '', reviewerOptions);
  assert.deepEqual(row.evidenceIds, comparison.discussion[0].points[0].evidenceIds);
  assert.deepEqual(result.reviewFlags, comparison.reviewFlags, 'history cannot alter source validation or warning decisions');
});

test('PATCH filing and subsequent saves preserve both exact-duplicate placement origins', async () => {
  const initial = draftFixture();
  const first = { id: 'unfiled-a', text: initial.sourceUnits[1].text,
    evidenceIds: ['T0002'], originalTopic: 'Laboratory', placementReason: 'no_unique_parent' };
  initial.unassignedSupportingDetails = normalizeUnassignedSupportingDetails([first,
    { ...first, id: 'unfiled-b', originalTopic: 'Inspection', placementReason: 'parent_not_publishable' }]);
  const original = structuredClone(initial.unassignedSupportingDetails[0]);
  const harness = patchHarness(initial);
  const saved = await harness.save(body => {
    body.discussion[0].points[0].supportingDetails = [{ ...body.unassignedSupportingDetails[0], reviewerAuthored: true }];
    body.unassignedSupportingDetails = [];
  });
  assert.deepEqual(saved.discussion[0].points[0].supportingDetails[0].filingOrigins, original.filingOrigins);
  assert.deepEqual(saved.discussion[0].points[0].supportingDetails[0].mergedFromIds, ['unfiled-b']);
  const again = await harness.save();
  assert.deepEqual(again.discussion[0].points[0].supportingDetails[0].filingOrigins, original.filingOrigins);
  assert.deepEqual(again.unassignedSupportingDetails, []);
});

test('generated JSON cannot turn merge-history metadata into reviewer exemptions', () => {
  const input = draftFixture();
  const topic = input.discussion[0];
  topic.reviewerAuthored = true;
  topic.confirmedTopic = true;
  topic.points[0].reviewerAuthored = true;
  topic.points[0].confirmedTopic = true;
  topic.points[0].timingDecision = { status: 'confirmed' };
  topic.points[0].supportingDetails[0].reviewerAuthored = true;
  const result = V.normaliseAgentResult(input, input.sourceUnits, 'discussion', { enforceEvidence: false });
  const generated = result.discussion[0];
  assert.equal(generated.mergedTopicIds, undefined);
  assert.equal(generated.reviewerAuthored, undefined);
  assert.equal(generated.confirmedTopic, undefined);
  assert.equal(generated.points[0].mergedFromIds, undefined);
  assert.equal(generated.points[0].reviewerAuthored, undefined);
  assert.equal(generated.points[0].confirmedTopic, undefined);
  assert.equal(generated.points[0].timingDecision, undefined);
  assert.equal(generated.points[0].supportingDetails[0].mergedFromIds, undefined);
  assert.equal(generated.points[0].supportingDetails[0].reviewerAuthored, undefined);
});
