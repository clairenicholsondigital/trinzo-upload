'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { chromium } = require('playwright');

// Row controls live in each row's "…" menu: open the menu, then click the item.
async function clickMenuItem(page, target) {
  const item = typeof target === 'string' ? page.locator(target).first() : target;
  await item.evaluate((node) => { const menu = node.closest('details[data-menu]'); if (menu) menu.open = true; });
  await item.click();
}

const { automaticMeetingAgentProposalReview } = require('../routes/api').stagedEvaluation;

const REPO_ROOT = path.resolve(__dirname, '..');
const PAGE_PATH = path.join(REPO_ROOT, 'views', 'meeting-minutes-agent.html');
const CLIENT_PATH = path.join(REPO_ROOT, 'public', 'meeting-minutes-agent.js');

function baseDraft(id, running = false) {
  return {
    draftId: id,
    revision: 3,
    updatedAt: '2026-09-16T12:00:00.000Z',
    currentStep: 3,
    selectedStep: 3,
    title: 'UI state test',
    details: {
      meetingTitle: 'UI state test', meetingDate: '2026-09-16', meetingLocation: 'Teams',
      meetingType: 'Review', clientAttendeeLabel: 'Client',
      internalAttendees: ['Alex Reed'], clientAttendees: ['Sam Okoro'], allAttendees: ['Alex Reed', 'Sam Okoro']
    },
    steer: '', denoise: {}, staleStages: [], qualityNotice: '',
    sourceUnits: [{ id: 'T0001', speaker: 'Alex Reed', timestamp: '00:10', text: 'Alex will send the revised report.' }],
    discussion: [{
      id: 'topic-1', topic: 'Report review',
      points: [{
        id: 'discussion-1', text: 'The revised report is ready for circulation.', evidenceIds: ['T0001'],
        reviewFlagIds: ['flag-1'],
        supportingDetails: [{ id: 'support-1', text: 'The report incorporates the final comments.', evidenceIds: ['T0001'] }]
      }], decisions: [], openQuestions: []
    }],
    actions: [{
      id: 'action-1', action: 'Send the revised report.', owners: ['Alex Reed'],
      timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0001'], reviewFlagIds: ['flag-action']
    }],
    executiveSummary: '', meetingObjectives: [], pendingProposal: null,
    reviewFlags: [{
      id: 'flag-1', kind: 'missing_evidence', message: 'Check the source support for this generated sentence.',
      evidenceIds: ['T0001'], status: 'open', correctionNote: ''
    }, {
      id: 'flag-action', kind: 'ownership', message: 'Check the owner of this action.',
      evidenceIds: ['T0001'], status: 'open', correctionNote: ''
    }],
    generation: running ? {
      stage: 'actions', status: 'running', startedAt: '2026-09-16T12:00:01.000Z',
      pass: 'critic', message: 'Verifying the draft…',
      completedPasses: ['primary', 'recovery', 'referee-batch-1', 'referee'],
      previewActions: [{
        id: 'preview-action-1', action: 'Send the evidence-checked report.', owners: ['Alex Reed'],
        timing: { kind: 'target', wording: 'this week', exactDate: '' }, evidenceIds: ['T0001'], reviewFlagIds: []
      }],
      previewUpdatedAt: '2026-09-16T12:01:01.000Z', callTimings: [], degradedSources: [], error: ''
    } : null
  };
}

function startStubServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const drafts = new Map([
    ['editor', baseDraft('editor', false)],
    ['running', baseDraft('running', true)]
  ]);
  for (const kind of ['prefix', 'question']) {
    const V = require('../utils/meetingMinutesAgentV2');
    const A = require('../routes/api').stagedEvaluation;
    const id = 'document-review-' + kind;
    const draft = baseDraft(id, false);
    draft.currentStep = 5; draft.selectedStep = 3;
    draft.actions = []; draft.discussion = [];
    draft.sourceUnits = V.normaliseSourceUnits([
      {id:'T0001',speaker:'Maya Patel',text:'The standard is 74216, covering portable pump requirements.'},
      {id:'T0002',speaker:'Maya Patel',text:'We can maybe get an assessment of that standard to see if it is applicable to the portable pump.'}
    ]);
    if (kind === 'prefix') {
      const rows = A.normaliseAgentDeclaredProposals({actionProposals:[{id:'assessment',action:'Assess whether ISO 74216 is applicable to the portable pump.',owners:['Maya Patel'],evidenceIds:['T0002'],reviewFlagIds:[],timing:{kind:'not_stated',wording:'',exactDate:''}}]},draft.sourceUnits);
      draft.reviewFlags = A.retainedDocumentReferenceReviewFlags(rows);
    } else draft.reviewFlags = V.normaliseAgentResult({reviewFlags:[{type:'unsupported_ownership',detail:'Assessment work is requested but acceptance and owner are not confirmed.',evidenceIds:['T0002']}]},draft.sourceUnits,'actions').reviewFlags;
    drafts.set(id,draft);
  }
  const earlierWarning = baseDraft('earlier-warning', false);
  earlierWarning.actions[0].action = 'Follow up with Jo regarding review of the documents.';
  earlierWarning.reviewFlags[1] = {
    id: 'flag-action', kind: 'missing_evidence', status: 'open', correctionNote: '',
    message: 'The linked lines only partly support the earlier instruction. Check against the transcript.',
    evidenceIds: ['T0001'], actionWordingAtCheck: 'Obtain <Jo> review of the documents.'
  };
  drafts.set('earlier-warning', earlierWarning);
  const sameWarning = JSON.parse(JSON.stringify(earlierWarning));
  sameWarning.draftId = 'same-warning';
  sameWarning.reviewFlags[1].actionWordingAtCheck = sameWarning.actions[0].action;
  drafts.set('same-warning', sameWarning);
  const sharedWarning = JSON.parse(JSON.stringify(earlierWarning));
  sharedWarning.draftId = 'shared-warning';
  sharedWarning.actions.push({ ...sharedWarning.actions[0], id:'action-2', action:'Send the documents to Jo.' });
  drafts.set('shared-warning', sharedWarning);
  const phaseDraft = baseDraft('phase-correction', false);
  phaseDraft.canRestoreCombinedActions = true;
  phaseDraft.canRestorePhaseActions = true;
  phaseDraft.actions[0].action = 'Tidy and share the quality review checklist for review.';
  drafts.set('phase-correction', phaseDraft);
  const orderedFiling = baseDraft('ordered-filing', false);
  orderedFiling.currentStep = 5;
  orderedFiling.selectedStep = 2;
  orderedFiling.sourceUnits.push({ id:'T0009', sequence:9, speaker:'Sam Okoro', text:'A later independent qualification was recorded.' });
  orderedFiling.discussion[0].points[0].supportingDetails = [];
  orderedFiling.unassignedSupportingDetails = [
    { id:'late-detail', text:'The later qualification remains available.', evidenceIds:['T0009'] },
    { id:'discussion-1', text:'A distinct earlier retained version needs its own review.', evidenceIds:['T0001'], mergedFromIds:['original-early'], reviewFlagIds:['flag-1'] }
  ];
  drafts.set('ordered-filing', orderedFiling);
  const filingReview = baseDraft('filing-review', false);
  filingReview.currentStep = 5; filingReview.selectedStep = 2;
  filingReview.actions[0].occurrenceId = 'action-occurrence-filing-fixture';
  filingReview.sourceUnits.push({ id:'T0002', speaker:'Sam Okoro', text:'The pressure calibration certificate is available.' });
  filingReview.discussion[0].points[0] = { id:'discussion-1',
    text:'The pressure calibration certificate requires checking before circulation.',
    evidenceIds:['T0001'], reviewFlagIds:[], supportingDetails:[] };
  filingReview.unassignedSupportingDetails = [
    { id:'first-certificate', text:'The pressure calibration certificate is available.', evidenceIds:['T0001','T0002'],
      originalTopic:'Calibration', placementReason:'no_subject_match', filingMergeProtected:true },
    { id:'discussion-1', text:'The pressure calibration certificate is available.', evidenceIds:['T0002'],
      reviewFlagIds:['unavailable-warning'], originalTopic:'Calibration', placementReason:'no_subject_match', mergedFromIds:['old-certificate'] },
    { id:'annual-inspection', text:'The annual inspection remains unresolved.', evidenceIds:['T0002'] }
  ];
  drafts.set('filing-review', filingReview);
  const internalOnly = baseDraft('internal-only', false);
  internalOnly.currentStep = 0;
  internalOnly.selectedStep = 0;
  internalOnly.details.clientAttendees = [];
  internalOnly.details.allAttendees = internalOnly.details.internalAttendees.slice();
  drafts.set('internal-only', internalOnly);
  const topicCleanup = baseDraft('topic-cleanup', false);
  topicCleanup.discussion.push({
    id: 'topic-2', topic: 'Second topic', points: [{
      id: 'discussion-2', text: 'A second generated sentence needs review.', evidenceIds: ['T0001'],
      reviewFlagIds: ['flag-topic'], supportingDetails: []
    }], decisions: [], openQuestions: []
  });
  topicCleanup.reviewFlags.push({
    id: 'flag-topic', kind: 'missing_evidence', message: 'Check the second topic.',
    evidenceIds: ['T0001'], status: 'open', correctionNote: ''
  });
  drafts.set('topic-cleanup', topicCleanup);
  const reviewerProvenance = baseDraft('reviewer-provenance', false);
  reviewerProvenance.currentStep = 5;
  reviewerProvenance.selectedStep = 2;
  reviewerProvenance.qualityState = { discussion: { topicArrangementVersion: 1 } };
  reviewerProvenance.discussion.push({
    id: 'topic-2', topic: 'Annual review', points: [{
      id: 'discussion-2', text: 'The annual review requires a separate report.', evidenceIds: ['T0001'], supportingDetails: []
    }], decisions: [], openQuestions: []
  });
  reviewerProvenance.actions.push({
    id: 'action-2', action: 'Prepare the annual review report.', owners: ['Sam Okoro'],
    timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0001'], reviewFlagIds: []
  });
  drafts.set('reviewer-provenance', reviewerProvenance);
  const staleActions = baseDraft('stale-actions', false);
  staleActions.staleStages = ['actions'];
  staleActions.currentStep = 2;
  staleActions.selectedStep = 2;
  drafts.set('stale-actions', staleActions);

  // The server finishes a stage on its own and writes it into the draft, which
  // advances the revision under an open tab. 'background-conflict' never polls
  // (no speculation), so the tab only learns about the write when it saves.
  ['background-conflict', 'background-poll', 'background-empty'].forEach((id) => {
    const draft = baseDraft(id, false);
    draft.actions = [];
    draft.currentStep = 2;
    draft.selectedStep = 2;
    if (id !== 'background-conflict') draft.speculation = { stage: 'actions', status: 'preparing' };
    drafts.set(id, draft);
  });
  const completedEmptyActions = baseDraft('completed-empty-actions', false);
  completedEmptyActions.actions = [];
  completedEmptyActions.currentStep = 3;
  completedEmptyActions.selectedStep = 3;
  completedEmptyActions.generatedStages = {
    discussion: '2026-09-16T12:00:00.000Z', actions: '2026-09-16T12:03:00.000Z', summary: ''
  };
  drafts.set('completed-empty-actions', completedEmptyActions);
  // The background Actions run found nothing to list (a meeting where nobody
  // takes anything on). It still ran, and the draft says so.
  function finishActionsEmptyInBackground(id) {
    const prior = drafts.get(id);
    const next = {
      ...prior, revision: prior.revision + 1, updatedAt: new Date().toISOString(),
      actions: [], speculation: null,
      generatedStages: { discussion: '2026-09-16T12:00:00.000Z', actions: '2026-09-16T12:03:00.000Z', summary: '' }
    };
    drafts.set(id, next);
    return next;
  }
  const backgroundActions = [{
    id: 'action-background', action: 'Circulate the checked report.', owners: ['Alex Reed'],
    timing: { kind: 'target', wording: 'this week', exactDate: '' }, evidenceIds: ['T0001'], reviewFlagIds: []
  }];
  function fillActionsInBackground(id) {
    const prior = drafts.get(id);
    const next = {
      ...prior, revision: prior.revision + 1, updatedAt: new Date().toISOString(),
      actions: backgroundActions, speculation: { stage: 'actions', status: 'ready' }
    };
    drafts.set(id, next);
    return next;
  }
  // Stands in for persistUntouchedSpeculation landing while the tab is open.
  app.post('/test-fill/:id', (req, res) => res.json({ ok: true, draft: fillActionsInBackground(req.params.id) }));
  // A change the reviewer must arbitrate: another writer edited a stage this
  // tab already has content in.
  app.post('/test-elsewhere/:id', (req, res) => {
    const prior = drafts.get(req.params.id);
    const next = {
      ...prior, revision: prior.revision + 1, updatedAt: new Date().toISOString(),
      discussion: [{ ...prior.discussion[0], topic: 'Renamed by another tab' }]
    };
    drafts.set(req.params.id, next);
    res.json({ ok: true, draft: next });
  });
  const summaryRunning = baseDraft('summary-running', false);
  summaryRunning.currentStep = 4;
  summaryRunning.selectedStep = 3;
  summaryRunning.generation = {
    stage: 'summary', status: 'running', startedAt: '2026-09-16T12:00:01.000Z',
    message: 'Preparing the summary…', completedPasses: [], callTimings: [], degradedSources: [], error: ''
  };
  drafts.set('summary-running', summaryRunning);
  const summaryEmpty = baseDraft('summary-empty', false);
  summaryEmpty.currentStep = 4;
  summaryEmpty.selectedStep = 4;
  summaryEmpty.speculation = null;
  drafts.set('summary-empty', summaryEmpty);
  const prewarming = baseDraft('prewarming', false);
  prewarming.currentStep = 2;
  prewarming.selectedStep = 2;
  prewarming.actions = [];
  prewarming.actionsPrewarm = { status: 'preparing', startedAt: '2026-09-16T12:00:02.000Z', completedAt: '' };
  drafts.set('prewarming', prewarming);
  const discussionReady = baseDraft('discussion-ready', false);
  discussionReady.currentStep = 1;
  discussionReady.selectedStep = 1;
  discussionReady.discussion = [];
  discussionReady.speculation = {
    stage: 'discussion', status: 'ready', startedAt: '2026-09-16T12:00:02.000Z', completedAt: '2026-09-16T12:01:02.000Z'
  };
  drafts.set('discussion-ready', discussionReady);
  const proposals = baseDraft('proposals', false);
  proposals.pendingProposal = {
    stage: 'actions',
    changes: [{
      // The server now states every selection explicitly; unset means unticked.
      id: 'proposal-1', type: 'add', before: null, selected: true,
      after: { id: 'action-2', action: 'Confirm access to the audit folder.', owners: [], timing: { kind: 'not_stated', wording: '', exactDate: '' } },
      reviewContext: { reason: 'The owner still needs confirming.', label: 'agreed, then committed', evidenceIds: ['T0001'] }
    }]
  };
  proposals.reviewFlags.push({
    id: 'proposal-review-proposal-1', kind: 'possible_missed_follow_up',
    message: 'Possible missed action: Confirm access to the audit folder.',
    evidenceIds: ['T0001'], status: 'open', correctionNote: ''
  });
  drafts.set('proposals', proposals);
  const partialProposals = baseDraft('partial-proposals', false);
  partialProposals.pendingProposal = {
    stage: 'actions',
    changes: [{
      id: 'partial-1', type: 'add', before: null, selected: true,
      after: { id: 'partial-action-1', action: 'Confirm folder access.', owners: [], timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0001'] },
      beforeIndex: 1, index: 1
    }, {
      id: 'partial-2', type: 'add', before: null, selected: false,
      after: { id: 'partial-action-2', action: 'Circulate the audit checklist.', owners: ['Alex Reed'], timing: { kind: 'target', wording: 'this week', exactDate: '' }, evidenceIds: ['T0001'] },
      beforeIndex: 1, index: 1
    }]
  };
  partialProposals.reviewFlags.push(
    { id: 'proposal-review-partial-1', kind: 'possible_missed_follow_up', message: 'Possible missed action: Confirm folder access.', evidenceIds: ['T0001'], status: 'open', correctionNote: '' },
    { id: 'proposal-review-partial-2', kind: 'possible_missed_follow_up', message: 'Possible missed action: Circulate the audit checklist.', evidenceIds: ['T0001'], status: 'open', correctionNote: '' }
  );
  drafts.set('partial-proposals', partialProposals);
  const unlinkedWarning = baseDraft('unlinked-warning', false);
  unlinkedWarning.sourceUnits.push({ id: 'T0002', speaker: 'Sam Okoro', timestamp: '00:20', text: 'The training attestation needs to be signed by Friday.' });
  unlinkedWarning.actions = [{
    id: 'training-action', action: 'Complete and sign the training attestation.', owners: ['Sam Okoro'],
    timing: { kind: 'deadline', wording: 'by Friday', exactDate: '2026-09-18' }, evidenceIds: ['T0002'], reviewFlagIds: []
  }];
  unlinkedWarning.reviewFlags = [{
    id: 'training-timing-flag', kind: 'timing', message: 'Confirm the Action timing “by Friday”.',
    evidenceIds: ['T0002'], status: 'open', correctionNote: ''
  }];
  drafts.set('unlinked-warning', unlinkedWarning);
  // A fully processed draft opens as one document.
  const documentDraft = baseDraft('document', false);
  documentDraft.currentStep = 5; documentDraft.selectedStep = 5;
  documentDraft.generatedStages = { discussion: '2026-09-16T12:00:00.000Z', actions: '2026-09-16T12:00:00.000Z', summary: '2026-09-16T12:00:00.000Z' };
  documentDraft.staleStages = ['actions'];
  documentDraft.executiveSummary = 'The team agreed the revised report is ready.';
  drafts.set('document', documentDraft);
  // The same document with enough text to move between and remove.
  const documentEditing = JSON.parse(JSON.stringify(documentDraft));
  documentEditing.draftId = 'document-editing';
  documentEditing.discussion[0].points.push(
    { id: 'discussion-2', text: 'Translations are still outstanding.', evidenceIds: ['T0001'], reviewFlagIds: [] },
    { id: 'discussion-3', text: 'The distributor holds the stock.', evidenceIds: ['T0001'], reviewFlagIds: [] });
  documentEditing.actions.push({ id: 'action-2', action: 'Confirm the distributor.', owners: [], timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0001'], reviewFlagIds: [] });
  documentEditing.meetingObjectives = ['Agree the report'];
  documentEditing.actions[0].timing = { kind: 'target', wording: 'hoping by early July, assuming the printer can turn it around, but it depends on whether the distributor confirms the stock position first', exactDate: '' };
  drafts.set('document-editing', documentEditing);
  const layout = baseDraft('layout', false);
  layout.currentStep = 5;
  layout.selectedStep = 4;
  layout.meetingObjectives = [{ id: 'objective-1', text: 'Rehearse presenter transitions and webinar delivery flow before the live session.' }];
  layout.executiveSummary = 'The team confirmed the main preparation priorities and owners.';
  layout.discussion[0].topic = 'Audit preparation and document access for the upcoming site visit';
  drafts.set('layout', layout);
  const mobileSaveBar = baseDraft('mobile-save-bar', false);
  mobileSaveBar.lastUndo = { id: 'undo-mobile', label: 'edit a long discussion item' };
  drafts.set('mobile-save-bar', mobileSaveBar);
  const objectiveLayout = baseDraft('objective-layout', false);
  objectiveLayout.currentStep = 5;
  objectiveLayout.selectedStep = 5;
  objectiveLayout.meetingObjectives = [
    { id: 'objective-layout-1', text: 'Review risk and software progress.', evidenceIds: ['T0001'] },
    { id: 'objective-layout-2', text: 'Update the minutes table for the new set of minutes.', evidenceIds: ['T0001'] },
    { id: 'objective-layout-3', text: 'Clarify formative study dates and alignment with MDR submission and NB review.', evidenceIds: ['T0001'] },
    { id: 'objective-layout-4', text: 'Confirm the status of operational procedures for electromed medical devices.', evidenceIds: ['T0001'] }
  ];
  drafts.set('objective-layout', objectiveLayout);
  const transcriptDisplay = baseDraft('transcript-display', false);
  transcriptDisplay.sourceUnits = [
    { id: 'T0000', speaker: 'Alex Reed', timestamp: '00:08', text: 'The report has the final comments.' },
    { id: 'T0001', speaker: 'Alex Reed', timestamp: '00:10', text: 'Alex will send the revised report.' },
    { id: 'T0002', speaker: 'Sam Okoro', timestamp: '00:14', text: 'I will check the recipient list.' }
  ];
  drafts.set('transcript-display', transcriptDisplay);
  const minutesFirstWarning = baseDraft('minutes-first-warning', false);
  minutesFirstWarning.sourceUnits = [{
    id: 'T0099', speaker: 'Alex Reed', timestamp: '12:10',
    text: 'The applicable standard may be 27427, subject to confirmation.'
  }];
  minutesFirstWarning.discussion[0].points[0].reviewFlagIds = [];
  minutesFirstWarning.actions[0].reviewFlagIds = [];
  minutesFirstWarning.reviewFlags = [{
    id: 'flag-reference', kind: 'unclear_reference',
    message: 'Confirm the standard reference exactly as spoken: “The applicable standard may be 27427, subject to confirmation.”',
    evidenceIds: ['T0099'], status: 'open', correctionNote: ''
  }, {
    id: 'flag-generic', kind: 'uncertain_fact', message: 'Cannot verify.',
    evidenceIds: ['T0099'], status: 'open', correctionNote: ''
  }];
  drafts.set('minutes-first-warning', minutesFirstWarning);
  const actionsCompleting = baseDraft('actions-completing', true);
  actionsCompleting.selectedStep = 2;
  actionsCompleting.staleStages = ['actions'];
  drafts.set('actions-completing', actionsCompleting);
  const navigation = baseDraft('navigation', false);
  navigation.currentStep = 5;
  navigation.selectedStep = 3;
  navigation.actions = Array.from({ length: 7 }, (_, index) => ({
    id: `navigation-action-${index + 1}`,
    action: `Complete preparation task ${index + 1} and share the outcome with the meeting attendees.`,
    owners: [index % 2 ? 'Sam Okoro' : 'Alex Reed'],
    timing: { kind: 'not_stated', wording: '', exactDate: '' }, evidenceIds: ['T0001'], reviewFlagIds: []
  }));
  drafts.set('navigation', navigation);
  const timingSemantics = baseDraft('timing-semantics', false);
  timingSemantics.reviewFlags = [];
  timingSemantics.actions = [
    { id: 'qualified', action: 'Begin the equipment checks.', owners: ['Alex Reed'], evidenceIds: ['T0001'], reviewFlagIds: [],
      timing: { kind: 'target', wording: 'presumably early next week', exactDate: '2026-09-21' },
      timingDecision: { status: 'qualified', version: 1 } },
    { id: 'fallback', action: 'Complete the briefing.', owners: ['Sam Okoro'], evidenceIds: ['T0001'], reviewFlagIds: [],
      timing: { kind: 'target', wording: 'Preferred: before departure; fallback: by 25 September', exactDate: '2026-09-25' } },
    { id: 'bound', action: 'Circulate the inspection report.', owners: ['Alex Reed'], evidenceIds: ['T0001'], reviewFlagIds: [],
      timing: { kind: 'deadline', wording: 'before 24 September', exactDate: '2026-09-24' } },
    { id: 'invalid', action: 'Review the supplier response.', owners: ['Sam Okoro'], evidenceIds: ['T0001'], reviewFlagIds: [],
      timing: { kind: 'target', wording: 'after approval', exactDate: '2026-02-30' },
      timingDecision: { status: 'invalid_calendar', version: 1 } }
  ];
  drafts.set('timing-semantics', timingSemantics);
  const metadataDateWarning = baseDraft('metadata-date-warning', false);
  metadataDateWarning.details.meetingDate = '2026-02-30';
  metadataDateWarning.reviewFlags = [];
  drafts.set('metadata-date-warning', require('../routes/api').stagedEvaluation.publicMeetingAgentDraft(metadataDateWarning));
  const patchCounts = new Map();
  const patchBodies = new Map();
  const reviewHistory = new Map();
  const redoHistory = new Map();
  let preparedGenerationChecks = 0;
  let actionCompletionChecks = 0;

  app.get('/meeting-minutes-agent', (req, res) => res.type('html').send(fs.readFileSync(PAGE_PATH, 'utf8')));
  app.get('/static/trinzo.css', (req, res) => res.type('text/css').send(fs.readFileSync(path.join(REPO_ROOT, 'public', 'trinzo.css'), 'utf8')));
  app.get('/static/meeting-minutes-timing.js', (req, res) => res.type('application/javascript').send(fs.readFileSync(path.join(REPO_ROOT, 'utils', 'meetingMinutesTiming.js'), 'utf8')));
  app.get('/static/meeting-minutes-filing-order.js', (req, res) => res.type('application/javascript').send(fs.readFileSync(path.join(REPO_ROOT, 'public', 'meeting-minutes-filing-order.js'), 'utf8')));
  app.get('/static/meeting-minutes-agent.js', (req, res) => res.type('application/javascript').send(fs.readFileSync(CLIENT_PATH, 'utf8')));
  app.get('/static/trinzo.js', (req, res) => res.type('application/javascript').send(''));
  app.get('/static/trinzo-fonts.css', (req, res) => res.type('text/css').send(''));
  app.post('/api/meeting-minutes-agent/prepare', async (req, res) => {
    // Leave a visible preparation window so the upload test can prove that
    // the acknowledgement waits for a server-accepted, persisted draft.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const prepared = baseDraft('prepared', false);
    prepared.currentStep = 0;
    prepared.selectedStep = 0;
    prepared.discussion = [];
    prepared.generation = { stage: 'discussion', status: 'running', startedAt: new Date().toISOString(), message: 'Processing the transcript in the background…', completedPasses: [] };
    drafts.set('prepared', prepared);
    res.json({ ok: true, draft: prepared, resumeUrl: '/meeting-minutes-agent?draftId=prepared' });
  });
  function visibleDraft(id, draft) {
    if (id === 'filing-review') draft = { ...draft,
      changeHistory: (reviewHistory.get(id) || []).map((entry, index) => ({ id:'undo-'+(index+1), label:entry.label })),
      redoHistory: (redoHistory.get(id) || []).map((entry, index) => ({ id:'redo-'+(index+1), label:entry.label })) };
    return ['reviewer-provenance', 'filing-review', 'document-review-prefix', 'document-review-question'].includes(id)
      ? require('../routes/api').stagedEvaluation.publicMeetingAgentDraft(draft) : draft;
  }
  app.post('/api/meeting-minutes-agent/drafts/:id/restore-combined-actions', (req,res) => {
    const prior=drafts.get(req.params.id);
    if(req.body.revision!==prior.revision)return res.status(409).json({ok:false,error:'Stale revision'});
    const next={...prior,revision:prior.revision+1,canRestoreCombinedActions:false,canRestorePhaseActions:false,
      actions:baseDraft('original',false).actions};drafts.set(req.params.id,next);res.json({ok:true,draft:next});
  });
  app.get('/api/meeting-minutes-agent/drafts/:id', (req, res) => res.json({ ok: true, draft: visibleDraft(req.params.id, drafts.get(req.params.id)) }));
  app.patch('/api/meeting-minutes-agent/drafts/:id', async (req, res) => {
    if (req.params.id === 'navigation') await new Promise((resolve) => setTimeout(resolve, 250));
    const prior = drafts.get(req.params.id);
    if (Number(req.body.revision) !== Number(prior.revision)) {
      return res.status(409).json({
        ok: false, code: 'DRAFT_REVISION_CONFLICT',
        error: 'This draft was updated elsewhere. Reload it before saving again.',
        currentDraft: prior
      });
    }
    patchBodies.set(req.params.id, req.body);
    const history = reviewHistory.get(req.params.id) || [];
    if (req.body.reviewDecisionLabel) history.push({
      label: req.body.reviewDecisionLabel,
      snapshot: JSON.parse(JSON.stringify(prior))
    });
    reviewHistory.set(req.params.id, history);
    if (req.body.reviewDecisionLabel) redoHistory.set(req.params.id, []);
    const next = {
      ...prior,
      ...req.body,
      lastRedo: req.body.reviewDecisionLabel ? null : (prior.lastRedo || null),
      revision: prior.revision + 1,
      updatedAt: new Date().toISOString(),
      currentStep: Math.max(Number(prior.currentStep || 0), Number(req.body.currentStep || 0)),
      selectedStep: Number(req.body.selectedStep == null ? req.body.currentStep : req.body.selectedStep),
      lastUndo: history.length ? { id: `undo-${history.length}`, label: history[history.length - 1].label } : null,
      // Match production normalisation: incomplete structured rows are not persisted.
      actions: (req.body.actions || prior.actions).filter((action) => String(action.action || '').trim()),
      discussion: (req.body.discussion || prior.discussion).map((topic) => ({
        ...topic,
        points: (topic.points || []).filter((record) => String(record.text || '').trim()),
        decisions: (topic.decisions || []).filter((record) => String(record.text || '').trim()),
        openQuestions: (topic.openQuestions || []).filter((record) => String(record.text || '').trim())
      })).filter((topic) => topic.points.length || topic.decisions.length || topic.openQuestions.length)
    };
    // Exercise the actual save normaliser and read-time publication helpers for
    // the provenance journey; a plain echo server would conceal lost markers.
    if (['reviewer-provenance', 'filing-review', 'document-review-prefix', 'document-review-question'].includes(req.params.id)) {
      const normalised = require('../utils/meetingMinutesAgentV2').normaliseAgentResult({
        discussion: next.discussion, actions: next.actions, reviewFlags: next.reviewFlags
      }, next.sourceUnits, '', { enforceEvidence: false, dedupeActions: false, mergeTopics: false, preserveReviewerEdits: true });
      next.discussion = normalised.discussion;
      next.actions = normalised.actions;
      next.reviewFlags = normalised.reviewFlags;
    }
    drafts.set(req.params.id, next);
    patchCounts.set(req.params.id, (patchCounts.get(req.params.id) || 0) + 1);
    res.json({ ok: true, draft: visibleDraft(req.params.id, next) });
  });
  app.post('/api/meeting-minutes-agent/drafts/:id/generate-background', (req, res) => {
    const prior = drafts.get(req.params.id);
    const generation = {
      stage: req.body.stage, status: 'running', startedAt: new Date().toISOString(),
      pass: 'starting', message: 'Preparing independent quality checks…',
      completedPasses: [], previewActions: [], callTimings: [], degradedSources: [], error: ''
    };
    const next = {
      ...prior, revision: prior.revision + 1, updatedAt: new Date().toISOString(), generation,
      currentStep: Math.max(Number(prior.currentStep || 0), req.body.stage === 'actions' ? 3 : 2),
      selectedStep: Number(req.body.selectedStep)
    };
    drafts.set(req.params.id, next);
    res.status(202).json({ ok: true, generation, draft: next });
  });
  app.post('/api/meeting-minutes-agent/drafts/:id/proposal', (req, res) => {
    const prior = drafts.get(req.params.id);
    const history = reviewHistory.get(req.params.id) || [];
    const proposal = prior.pendingProposal;
    const allIds = (proposal?.changes || []).map((change) => change.id);
    const automaticReview = req.body.automatic ? automaticMeetingAgentProposalReview(proposal, prior.reviewFlags, prior.actions) : null;
    const accepted = req.body.decision === 'accept'
      ? new Set(automaticReview ? automaticReview.acceptedIds : req.body.acceptAll ? allIds : (req.body.changeIds || [])) : new Set();
    const rejected = req.body.decision === 'reject' ? new Set(allIds) : new Set();
    const acceptedAdds = (proposal?.changes || []).filter((change) => accepted.has(change.id) && change.type === 'add').map((change) => change.after);
    const remainingChanges = (proposal?.changes || []).filter((change) => !accepted.has(change.id) && !rejected.has(change.id))
      .map((change) => ({ ...change, selected: false }));
    const label = req.body.decision === 'reject' ? `${allIds.length} suggestions dismissed` : `${accepted.size} suggestion${accepted.size === 1 ? '' : 's'} applied`;
    history.push({ label, snapshot: JSON.parse(JSON.stringify(prior)) });
    reviewHistory.set(req.params.id, history);
    const next = {
      ...prior,
      actions: [...(prior.actions || []), ...acceptedAdds],
      pendingProposal: !automaticReview && remainingChanges.length ? { ...proposal, changes: remainingChanges } : null,
      reviewFlags: automaticReview ? automaticReview.reviewFlags : (prior.reviewFlags || []).map((flag) => {
        const change = (proposal?.changes || []).find((item) => flag.id === `proposal-review-${item.id}`);
        if (!change || (!accepted.has(change.id) && !rejected.has(change.id))) return flag;
        return { ...flag, status: accepted.has(change.id) ? 'confirmed' : 'dismissed' };
      }),
      revision: prior.revision + 1,
      updatedAt: new Date().toISOString(),
      lastUndo: { id: `undo-${history.length}`, label }
    };
    drafts.set(req.params.id, next);
    res.json({ ok: true, draft: next });
  });
  app.post('/api/meeting-minutes-agent/drafts/:id/redo', (req, res) => {
    const prior = drafts.get(req.params.id);
    const redo = redoHistory.get(req.params.id) || [];
    const latest = redo.pop();
    if (!latest) return res.status(409).json({ ok: false, error: 'There is nothing to redo.' });
    redoHistory.set(req.params.id, redo);
    const history = reviewHistory.get(req.params.id) || [];
    history.push({ label: latest.label, snapshot: JSON.parse(JSON.stringify(prior)) });
    reviewHistory.set(req.params.id, history);
    const next = {
      ...latest.snapshot,
      revision: prior.revision + 1,
      updatedAt: new Date().toISOString(),
      lastUndo: { id: `undo-${history.length}`, label: latest.label },
      lastRedo: redo.length ? { id: `redo-${redo.length}`, label: redo[redo.length - 1].label } : null
    };
    drafts.set(req.params.id, next);
    res.json({ ok: true, draft: next });
  });

  app.post('/api/meeting-minutes-agent/drafts/:id/undo', (req, res) => {
    const prior = drafts.get(req.params.id);
    const history = reviewHistory.get(req.params.id) || [];
    const latest = history.pop();
    if (!latest) return res.status(409).json({ ok: false, error: 'There is nothing to undo.' });
    reviewHistory.set(req.params.id, history);
    const redo = redoHistory.get(req.params.id) || [];
    redo.push({ label: latest.label, snapshot: JSON.parse(JSON.stringify(prior)) });
    redoHistory.set(req.params.id, redo);
    const next = {
      ...latest.snapshot,
      revision: prior.revision + 1,
      updatedAt: new Date().toISOString(),
      lastUndo: history.length ? { id: `undo-${history.length}`, label: history[history.length - 1].label } : null,
      lastRedo: { id: `redo-${redo.length}`, label: latest.label }
    };
    drafts.set(req.params.id, next);
    res.json({ ok: true, draft: next });
  });
  app.get('/api/meeting-minutes-agent/drafts/:id/generation', (req, res) => {
    let draft = drafts.get(req.params.id);
    if (req.params.id === 'prepared' && draft.generation) {
      preparedGenerationChecks += 1;
      if (preparedGenerationChecks === 1) {
        return res.status(503).json({ ok: false, error: 'Temporary progress-check failure.' });
      }
      draft = {
        ...draft, revision: draft.revision + 1, updatedAt: new Date().toISOString(),
        generation: null,
        speculation: { stage: 'actions', status: 'preparing' },
        generatedStages: { discussion: new Date().toISOString(), actions: '', summary: '' },
        discussion: baseDraft('prepared-result', false).discussion
      };
      drafts.set(req.params.id, draft);
      return res.json({ ok: true, generation: null, speculation: draft.speculation, draft });
    }
    if (req.params.id === 'actions-completing' && draft.generation) {
      actionCompletionChecks += 1;
      if (actionCompletionChecks === 1) {
        return res.json({ ok: true, generation: draft.generation, actionsPrewarm: null });
      }
      draft = {
        ...draft, revision: draft.revision + 1, updatedAt: new Date().toISOString(),
        generation: null, staleStages: [],
        actions: [{
          id: 'action-final', action: 'Send the final checked report.', owners: ['Alex Reed'],
          timing: { kind: 'target', wording: 'this week', exactDate: '' }, evidenceIds: ['T0001'], reviewFlagIds: []
        }]
      };
      drafts.set(req.params.id, draft);
      return res.json({ ok: true, generation: null, actionsPrewarm: null, draft });
    }
    if (req.params.id === 'summary-running' && draft.generation) {
      draft = {
        ...draft, revision: draft.revision + 1, updatedAt: new Date().toISOString(),
        generation: null, executiveSummary: 'The report was confirmed for circulation.'
      };
      drafts.set(req.params.id, draft);
      return res.json({ ok: true, generation: null, draft });
    }
    if (req.params.id === 'background-poll') {
      const filled = (draft.actions || []).length ? draft : fillActionsInBackground(req.params.id);
      return res.json({
        ok: true, generation: null, actionsPrewarm: null,
        speculation: filled.speculation, draft: filled
      });
    }
    if (req.params.id === 'background-empty') {
      const finished = draft.generatedStages ? draft : finishActionsEmptyInBackground(req.params.id);
      return res.json({
        ok: true, generation: null, actionsPrewarm: null,
        speculation: finished.speculation, draft: finished
      });
    }
    res.json({
      ok: true, generation: draft.generation, actionsPrewarm: draft.actionsPrewarm || null,
      speculation: draft.speculation || null, draft: draft.generation ? undefined : draft
    });
  });
  app.get('/test-state/:id', (req, res) => res.json({
    patches: patchCounts.get(req.params.id) || 0,
    undoLabels: (reviewHistory.get(req.params.id) || []).map((entry) => entry.label),
    draft: drafts.get(req.params.id),
    lastPatch: patchBodies.get(req.params.id) || null
  }));

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function launchPage(port, draftId) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${port}/meeting-minutes-agent?draftId=${draftId}`);
  await page.waitForFunction(() => document.querySelector('#actionsBody tr'));
  return { browser, page, errors };
}

test('filing review groups wording but retains separate controls, warning links and explicit direct promotion', { timeout:120000 }, async () => {
  const { server, port } = await startStubServer(); let browser;
  try {
    const launched = await launchPage(port, 'filing-review'); browser = launched.browser;
    const { page, errors } = launched;
    const stored = () => page.evaluate(async () => (await (await fetch('/test-state/filing-review')).json()).draft);
    await page.click('[data-step="2"]');
    await page.locator('#omittedDetailsPanel > summary').click();
    assert.equal(await page.locator('[data-identical-filing-group]').count(), 1);
    assert.equal(await page.locator('[data-identical-filing-group] > p').textContent(), 'The pressure calibration certificate is available.');
    assert.equal(await page.locator('[data-unassigned-supporting-row]').count(), 3);
    await page.locator('[data-identical-filing-group] > details > summary').click();
    assert.match(await page.locator('[data-unassigned-supporting-row="1"]').textContent(), /explanation.*unavailable/);
    assert.equal(await page.locator('[data-view-flag-target="minutes-unassigned-supporting-discussion-1-1"]').count(),1);
    const before = await stored(), originalMain = before.discussion[0].points[0].text;
    await page.selectOption('[data-unassigned-supporting-row="1"] [data-unassigned-topic]', '0');
    await page.click('[data-promote-unassigned="1"]');
    await page.waitForFunction(() => document.getElementById('saveStatus')?.dataset.state==='saved');
    await page.waitForFunction(async () => (await (await fetch('/test-state/filing-review')).json()).draft.unassignedSupportingDetails.length===2);
    let draft = await stored(), moved = draft.discussion[0].points.find(p => p.text==='The pressure calibration certificate is available.');
    assert.ok(moved, JSON.stringify(await page.evaluate(async () => (await (await fetch('/test-state/filing-review')).json())))); assert.notEqual(moved.id, 'discussion-1');
    assert.deepEqual(moved.mergedFromIds, ['old-certificate','discussion-1']);
    assert.deepEqual(moved.evidenceIds,['T0002']); assert.deepEqual(moved.reviewFlagIds,['unavailable-warning']);
    assert.equal(moved.reviewerAuthored,true);
    assert.equal(moved.filingOrigins[0].originalTopic,'Calibration');
    assert.equal(draft.unassignedSupportingDetails[0].id,'first-certificate');
    assert.equal(draft.discussion[0].points[0].text,originalMain);
    assert.deepEqual(draft.actions,before.actions);
    await page.waitForFunction(() => document.getElementById('saveStatus')?.dataset.state==='saved');
    await page.click('#undoLastDecision');
    await page.waitForFunction(async () => (await (await fetch('/test-state/filing-review')).json()).draft.unassignedSupportingDetails.length===3);
    await page.click('#redoLastDecision');
    await page.waitForFunction(async () => (await (await fetch('/test-state/filing-review')).json()).draft.unassignedSupportingDetails.length===2);
    await page.reload(); await page.waitForSelector('#omittedDetailsPanel');
    await page.locator('#omittedDetailsPanel > summary').click();
    await page.selectOption('[data-unassigned-supporting-row="1"] [data-unassigned-topic]', 'new');
    await page.fill('[data-unassigned-supporting-row="1"] [data-unassigned-new-topic]', 'Annual inspection');
    await page.click('[data-promote-unassigned="1"]');
    await page.waitForFunction(() => document.getElementById('saveStatus')?.dataset.state==='saved');
    await page.waitForFunction(async () => (await (await fetch('/test-state/filing-review')).json()).draft.discussion.length===2);
    draft = await stored();
    assert.equal(draft.discussion[1].topic,'Annual inspection');
    assert.equal(draft.discussion[1].points[0].text,'The annual inspection remains unresolved.');
    assert.equal(draft.unassignedSupportingDetails.length,1);
    assert.deepEqual(errors,[]);
  } finally { if(browser) await browser.close(); await new Promise(resolve=>server.close(resolve)); }
});

test('filing suggestions require a deliberate click and move only the selected retained occurrence', { timeout:120000 }, async () => {
  const { server, port } = await startStubServer(); let browser;
  try {
    const launched = await launchPage(port, 'filing-review'); browser=launched.browser;
    const {page, errors}=launched;
    await page.click('[data-step="2"]'); await page.locator('#omittedDetailsPanel > summary').click();
    await page.locator('[data-identical-filing-group] > details > summary').click();
    assert.equal(await page.locator('[data-use-filing-suggestion]').count(),1);
    const before=await page.evaluate(async () => (await (await fetch('/test-state/filing-review')).json()).draft);
    assert.equal(before.unassignedSupportingDetails.length,3);
    await page.click('[data-use-filing-suggestion="0"]');
    await page.waitForFunction(() => document.getElementById('saveStatus')?.dataset.state==='saved');
    await page.waitForFunction(async () => (await (await fetch('/test-state/filing-review')).json()).draft.unassignedSupportingDetails.length===2);
    const after=await page.evaluate(async () => (await (await fetch('/test-state/filing-review')).json()).draft);
    assert.equal(after.discussion[0].points.length,1);
    assert.equal(after.discussion[0].points[0].text,before.discussion[0].points[0].text);
    assert.ok(after.discussion[0].points[0].supportingDetails[0], JSON.stringify(await page.evaluate(async () => (await (await fetch('/test-state/filing-review')).json()))));
    assert.equal(after.discussion[0].points[0].supportingDetails[0].id,'first-certificate');
    assert.ok(after.unassignedSupportingDetails.some(p=>p.id==='discussion-1'));
    assert.deepEqual(after.actions,before.actions); assert.deepEqual(errors,[]);
  } finally { if(browser)await browser.close(); await new Promise(resolve=>server.close(resolve)); }
});

test('filing controls preserve readable full-width text at desktop and phone widths', { timeout:120000 }, async () => {
  const {server,port}=await startStubServer();let browser;
  try {
    const launched=await launchPage(port,'filing-review');browser=launched.browser;const {page,errors}=launched;
    await page.locator('#omittedDetailsPanel > summary').click();
    for(const width of [1280,390]){
      await page.setViewportSize({width,height:844});
      const box=await page.locator('[data-unassigned-supporting-row="2"]').evaluate(row=>{
        const copy=row.querySelector('.omitted-detail-copy').getBoundingClientRect();
        const bounds=row.getBoundingClientRect();
        return {copyWidth:copy.width,rowWidth:bounds.width,overflow:row.scrollWidth-row.clientWidth,
          controls:[...row.querySelectorAll('select,button,input:not([hidden])')].map(el=>({left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right})),
          left:bounds.left,right:bounds.right};
      });
      assert.ok(box.copyWidth>box.rowWidth*.85,JSON.stringify({width,box}));
      assert.ok(box.overflow<=1,JSON.stringify({width,box}));
      assert.ok(box.controls.every(b=>b.left>=box.left && b.right<=box.right+1),JSON.stringify({width,box}));
    }
    assert.deepEqual(errors,[]);
  } finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
});

test('editing a parent invalidates an older filing suggestion without moving any occurrence', { timeout:120000 }, async () => {
  const {server,port}=await startStubServer(); let browser;
  try {
    const launched=await launchPage(port,'filing-review');browser=launched.browser;
    const {page,errors}=launched;
    await page.click('[data-step="2"]');await page.locator('#omittedDetailsPanel > summary').click();
    await page.locator('[data-identical-filing-group] > details > summary').click();
    assert.equal(await page.locator('[data-use-filing-suggestion]').count(),1);
    await page.fill('[data-record-field="points"][data-topic-index="0"][data-item-index="0"]','The annual report requires separate review.');
    await page.click('[data-use-filing-suggestion="0"]');
    assert.equal(await page.locator('[data-use-filing-suggestion]').count(),0);
    await page.waitForFunction(() => document.getElementById('saveStatus')?.dataset.state==='saved');
    const saved=await page.evaluate(async () => (await (await fetch('/test-state/filing-review')).json()).draft);
    assert.equal(saved.unassignedSupportingDetails.length,3);
    assert.equal(saved.discussion[0].points.length,1);
    assert.deepEqual(saved.discussion[0].points[0].supportingDetails,[]);
    assert.equal(saved.discussion[0].points[0].text,'The annual report requires separate review.');
    assert.deepEqual(errors,[]);
  } finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
});

test('ordered unfiled details file and promote into an independently editable occurrence', { timeout:120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'ordered-filing');
    browser = launched.browser;
    const { page, errors } = launched;
    const stored = () => page.evaluate(async () => (await (await fetch('/test-state/ordered-filing')).json()).draft);
    const settled = () => page.waitForFunction(() => document.getElementById('saveStatus')?.dataset.state === 'saved');
    await page.click('[data-step="2"]');
    await page.click('#omittedDetailsPanel > summary');
    const first = page.locator('[data-needs-filing] [data-unassigned-supporting-row]').first();
    assert.equal(await first.getAttribute('data-unassigned-supporting-row'), '1', 'display order retains the backing index');
    assert.match(await first.textContent(), /distinct earlier retained version/);
    await page.selectOption('[data-unassigned-supporting-row="1"] [data-supporting-destination]', '0:points:0');
    await page.click('[data-file-supporting="1"]');
    await page.waitForFunction(async () => {
      const d=(await (await fetch('/test-state/ordered-filing')).json()).draft;
      return d.unassignedSupportingDetails.length===1 && d.discussion[0].points[0].supportingDetails.length===1;
    });
    await settled();
    let d=await stored(), child=d.discussion[0].points[0].supportingDetails[0];
    const childId=child.id, original=d.discussion[0].points[0].text;
    assert.notEqual(childId,'discussion-1');
    assert.deepEqual(child.mergedFromIds,['original-early','discussion-1']);
    assert.deepEqual(child.reviewFlagIds,['flag-1']);
    assert.equal(d.unassignedSupportingDetails[0].id,'late-detail');

    await page.click('#undoLastDecision');
    await page.waitForFunction(async () => (await (await fetch('/test-state/ordered-filing')).json()).draft.unassignedSupportingDetails.length===2);
    await page.click('#redoLastDecision');
    await page.waitForFunction(async () => (await (await fetch('/test-state/ordered-filing')).json()).draft.unassignedSupportingDetails.length===1);
    await page.reload();
    await page.waitForSelector('#omittedDetailsPanel');
    await page.click('#omittedDetailsPanel > summary');
    await page.click('#omittedDetailsPanel [data-promote-supporting]');
    await page.waitForFunction(async () => (await (await fetch('/test-state/ordered-filing')).json()).draft.discussion[0].points.length===2);
    await settled();
    d=await stored();
    assert.equal(d.discussion[0].points[1].id,childId);
    assert.deepEqual(d.discussion[0].points[1].mergedFromIds,['original-early','discussion-1']);
    assert.equal(d.discussion[0].points[0].text,original);
    await page.click('[data-step="5"]');
    await page.locator('#finalDocument [data-kind="discussion"][data-record-id="'+childId+'"]').click();
    await page.fill('#finalDocument [data-final-editor-value]','The separately retained qualification was reviewed.');
    await page.click('#finalDocument [data-final-save]');
    await page.waitForFunction(async () => (await (await fetch('/test-state/ordered-filing')).json()).draft.discussion[0].points[1].text==='The separately retained qualification was reviewed.');
    await settled();
    d=await stored();
    assert.equal(d.discussion[0].points[0].text,original);
    assert.equal(d.discussion[0].points[1].reviewerAuthored,true);
    await page.reload();
    await page.waitForSelector('#finalDocument [data-record-id="'+childId+'"]');
    await page.click('#undoLastDecision');
    await page.waitForFunction(async () => (await (await fetch('/test-state/ordered-filing')).json()).draft.discussion[0].points[1].text==='A distinct earlier retained version needs its own review.');
    await page.click('#redoLastDecision');
    await page.waitForFunction(async () => (await (await fetch('/test-state/ordered-filing')).json()).draft.discussion[0].points[1].text==='The separately retained qualification was reviewed.');
    assert.equal((await stored()).discussion[0].points[0].text,original);
    assert.deepEqual(errors,[]);
  } finally {
    if(browser) await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
});

test('reviewer wording survives stage editing, final editing, save normalisation and reload', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'reviewer-provenance');
    browser = launched.browser;
    const { page, errors } = launched;
    const savedState = () => page.evaluate(async () => (await (await fetch('/test-state/reviewer-provenance')).json()).draft);
    const saveResponse = () => page.waitForResponse((response) => response.url().endsWith('/api/meeting-minutes-agent/drafts/reviewer-provenance')
      && response.request().method() === 'PATCH');
    const settled = () => page.waitForFunction(() => document.getElementById('saveStatus')?.dataset.state === 'saved');

    // The generated-content filter would discard this sentence. A reviewer
    // deliberately entering it must be able to save and see it again.
    const aside = 'Sam joked about the weekend.';
    let saved = saveResponse();
    await page.fill('#minutes-discussion-discussion-1 [data-record-field]', aside);
    await saved;
    await settled();
    let stored = await savedState();
    assert.equal(stored.discussion[0].points[0].reviewerAuthored, true);
    assert.equal(stored.discussion[0].reviewerAuthored, undefined, 'editing a row does not mark its untouched topic');
    assert.equal(stored.discussion[1].points[0].reviewerAuthored, undefined);
    assert.equal(stored.actions[0].reviewerAuthored, undefined, 'reading hidden editors is not a human edit');

    await page.reload();
    await page.waitForSelector('#minutes-discussion-discussion-1 [data-record-field]');
    assert.equal(await page.inputValue('#minutes-discussion-discussion-1 [data-record-field]'), aside);

    saved = saveResponse();
    await page.fill('[data-topic-index="1"][data-topic]', 'Reviewer context');
    await saved;
    await settled();
    stored = await savedState();
    assert.equal(stored.discussion[1].reviewerAuthored, true);

    await page.click('[data-step="3"]');
    const manualAction = 'I will determine a way to send the updated report.';
    saved = saveResponse();
    await page.fill('#minutes-action-action-1 [data-action]', manualAction);
    await saved;
    await settled();
    stored = await savedState();
    assert.equal(stored.actions[0].reviewerAuthored, true);
    assert.equal(stored.actions[0].action, manualAction, 'save does not run generated-action rewrites on reviewer text');
    assert.equal(stored.actions[1].reviewerAuthored, undefined);

    await page.click('[data-step="5"]');
    await page.locator('#finalDocument [data-kind="discussion"][data-record-id="discussion-2"]').click();
    const finalAside = 'Alex joked about the weather.';
    await page.fill('#finalDocument [data-final-editor-value]', finalAside);
    saved = saveResponse();
    await page.click('#finalDocument [data-final-save]');
    await saved;
    await settled();

    await page.locator('#finalDocument [data-kind="action"][data-record-id="action-2"][data-field="action"]').click();
    const finalAction = 'Consider options for the next review.';
    await page.fill('#finalDocument [data-final-editor-value]', finalAction);
    saved = saveResponse();
    await page.click('#finalDocument [data-final-save]');
    await saved;
    await settled();
    await page.reload();
    await page.waitForSelector('#finalDocument [data-record-id="action-2"]');
    assert.match(await page.textContent('#finalDocument'), /Alex joked about the weather/);
    assert.match(await page.textContent('#finalDocument'), /Consider options for the next review/);
    stored = await savedState();
    assert.equal(stored.discussion[1].points[0].reviewerAuthored, true);
    assert.equal(stored.actions[1].reviewerAuthored, true);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('an internal-only meeting does not reserve an empty client-attendee panel', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'internal-only');
    browser = launched.browser;
    const { page, errors } = launched;

    assert.equal(await page.locator('#clientAttendeeGroup').isHidden(), true);
    assert.equal(await page.locator('#clientAttendeeLabelControl').isHidden(), true);
    assert.equal(await page.locator('#addFirstClientAttendee').isVisible(), true);
    await page.click('#addFirstClientAttendee');
    assert.equal(await page.locator('#clientAttendeeGroup').isVisible(), true);
    assert.equal(await page.locator('#clientAttendeeLabelControl').isVisible(), true);
    assert.equal(await page.locator('#addFirstClientAttendee').isHidden(), true);
    assert.equal(await page.locator('#clientAttendees input').evaluate((node) => node === document.activeElement), true);
    await page.fill('#clientAttendees input', 'Taylor Green');
    await clickMenuItem(page, '#clientAttendees [data-remove-attendee]');
    assert.equal(await page.locator('#clientAttendeeGroup').isHidden(), true, 'removing the only client attendee collapses the empty panel again');
    assert.equal(await page.locator('#addFirstClientAttendee').isVisible(), true);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('action editor keeps blank rows, custom-owner text and linked flag targets across autosave renders', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'editor');
    browser = launched.browser;
    const { page, errors } = launched;

    await page.click('#addAction');
    assert.equal(await page.locator('#actionsBody [data-action-row]').count(), 2);
    assert.match(await page.textContent('#saveStatus'), /kept in this tab/i);

    // Force an autosave which returns a server-normalised draft without the
    // blank row. The local editor row must remain available for entry.
    await page.fill('#actionsBody [data-action-row="0"] [data-action]', 'Send the revised report promptly.');
    await page.waitForFunction(async () => (await (await fetch('/test-state/editor')).json()).patches >= 1);
    assert.equal(await page.locator('#actionsBody [data-action-row]').count(), 2);
    // The autosave succeeded, but the blank row still lives only in this tab:
    // the status must keep saying so and the resume link must stay hidden.
    await page.waitForFunction(() => /stay in this tab/i.test(document.getElementById('saveStatus').textContent));

    await page.click('#actionsBody [data-action-row="0"] [data-edit-timing]');
    await page.click('#actionsBody [data-action-row="0"] [data-edit-owners]');
    await page.selectOption('#actionsBody [data-action-row="0"] [data-add-owner]', '__other');
    const customOwner = page.locator('#actionsBody [data-action-row="0"] [data-owner-other]');
    await customOwner.fill('Jordan Lee');
    // Trigger an unrelated autosave without blurring the custom-owner field.
    await page.evaluate(() => {
      const timing = document.querySelector('#actionsBody [data-action-row="0"] [data-timing-wording]');
      timing.value = 'this week';
      timing.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(async () => (await (await fetch('/test-state/editor')).json()).patches >= 2);
    assert.equal(await customOwner.isVisible(), true);
    assert.equal(await customOwner.inputValue(), 'Jordan Lee');

    await page.click('#reviewQueueToggle');
    assert.match(await page.textContent('.flag-target blockquote'), /revised report is ready/i);
    await page.click('[data-view-flag-target]');
    await page.waitForFunction(() => document.querySelector('[data-screen="2"]').classList.contains('active'));
    assert.equal(await page.locator('#minutes-discussion-discussion-1').count(), 1);
    assert.match(await page.textContent('#omittedDetailsPanel'), /These details are not included in the main minutes/i);
    assert.match(await page.textContent('#omittedDetailsPanel'), /report incorporates the final comments/i);
    assert.equal(await page.locator('#omittedDetailsPanel .omitted-detail-kind').count(), 0, 'the shared panel does not repeat a label above every detail');
    assert.equal(await page.locator('.supporting-context').count(), 0, 'omitted details use one shared review panel');
    assert.equal(await page.locator('#omittedDetailsPanel [data-promote-supporting]').count(), 1);
    assert.equal(await page.locator('#omittedDetailsPanel [data-promote-supporting]').textContent(), 'Add to minutes');
    await page.click('#omittedDetailsPanel > .omitted-details-summary');
    await page.click('#omittedDetailsPanel .evidence-toggle');
    // Opening the nested disclosure can coincide with the autosave re-render
    // above. Measure only after the replacement node has completed layout.
    const desktopOmittedLayoutHandle = await page.waitForFunction(() => {
      const detail = document.querySelector('#omittedDetailsPanel .omitted-detail');
      if (!detail) return null;
      const copy = detail.querySelector('.omitted-detail-copy')?.getBoundingClientRect();
      const button = detail.querySelector('[data-promote-supporting]')?.getBoundingClientRect();
      const disclosure = detail.querySelector('.omitted-detail-actions>details')?.getBoundingClientRect();
      const panel = detail.querySelector('.evidence-panel')?.getBoundingClientRect();
      const outer = detail.getBoundingClientRect();
      if (!copy || !button || !disclosure || !panel || !outer.width) return null;
      const layout = {
        copyUsesRow: copy.width > outer.width * 0.9,
        controlsBelowCopy: button.top >= copy.bottom - 1,
        transcriptUsesRow: disclosure.width > outer.width * 0.9,
        panelInsideCard: panel.left >= outer.left - 1 && panel.right <= outer.right + 1,
        overflow: detail.scrollWidth - detail.clientWidth
      };
      return layout.copyUsesRow && layout.controlsBelowCopy && layout.transcriptUsesRow
        && layout.panelInsideCard && layout.overflow === 0 ? layout : null;
    });
    const desktopOmittedLayout = await desktopOmittedLayoutHandle.jsonValue();
    assert.deepEqual(desktopOmittedLayout, {
      copyUsesRow: true, controlsBelowCopy: true, transcriptUsesRow: true, panelInsideCard: true, overflow: 0
    });
    await page.click('#omittedDetailsPanel [data-promote-supporting]');
    assert.equal(await page.locator('#omittedDetailsPanel').count(), 0, 'adding an omitted detail removes it from the review panel');
    assert.equal(await page.locator('#minutes-discussion-support-1').count(), 1);
    assert.equal(await page.locator('#minutes-discussion-support-1 textarea').inputValue(), 'The report incorporates the final comments.');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('keeping, rejecting and putting back an action, with live counts', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'editor');
    browser = launched.browser;
    const { page, errors } = launched;

    const bar = page.locator('#actionReviewBar');
    assert.equal((await bar.textContent()).trim(), '1 action');

    // Keep marks a row as checked without changing the minutes.
    const checkedSave = page.waitForResponse((response) => response.url().endsWith('/api/meeting-minutes-agent/drafts/editor')
      && response.request().method() === 'PATCH'
      && response.request().postDataJSON().reviewDecisionLabel === 'Action marked as checked');
    await clickMenuItem(page, '#actionsBody [data-action-row="0"] [data-keep-action]');
    await checkedSave;
    assert.equal((await bar.textContent()).trim(), '1 action');
    assert.equal(await page.locator('#actionsBody [data-action-row]').count(), 1, 'keeping removes nothing');
    assert.equal((await page.locator('#undoToastMessage').textContent()).trim(), 'Action marked as checked.');

    const uncheckedSave = page.waitForResponse((response) => response.url().endsWith('/api/meeting-minutes-agent/drafts/editor')
      && response.request().method() === 'PATCH'
      && response.request().postDataJSON().reviewDecisionLabel === 'Action marked as unchecked');
    await clickMenuItem(page, '#actionsBody [data-action-row="0"] [data-keep-action]');
    await uncheckedSave;
    assert.equal((await bar.textContent()).trim(), '1 action');
    assert.equal((await page.locator('#undoToastMessage').textContent()).trim(), 'Action marked as unchecked.');

    // Put it back in the checked state before exercising removal.
    await clickMenuItem(page, '#actionsBody [data-action-row="0"] [data-keep-action]');
    assert.equal((await bar.textContent()).trim(), '1 action');

    // Rejecting moves the row out of the register and into Removed.
    await clickMenuItem(page, '#actionsBody [data-action-row="0"] [data-reject-action]');
    assert.equal(await page.locator('#actionsBody [data-action-row]').count(), 0);
    assert.equal(await page.locator('#removedActionsPanel').isHidden(), false);
    assert.match(await page.textContent('#removedActionsSummary'), /1 removed action/);

    // And it can be put back rather than retyped. The section stays collapsed
    // by default so it does not crowd the register; opening it is one click.
    await page.click('#removedActionsSummary');
    await page.click('#removedActionsList [data-restore-action]');
    assert.equal(await page.locator('#actionsBody [data-action-row]').count(), 1);
    assert.equal(await page.locator('#removedActionsPanel').isHidden(), true);
    const restored = await page.inputValue('#actionsBody [data-action-row="0"] [data-action]');
    assert.ok(restored.length > 0, 'the wording comes back with the row');
    assert.equal((await bar.textContent()).trim(), '1 action');

    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    server.close();
  }
});

test('actions can be reordered from the keyboard, and the order is saved', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'editor');
    browser = launched.browser;
    const { page, errors } = launched;

    await page.click('#addAction');
    await page.fill('#actionsBody [data-action-row="1"] [data-action]', 'Second action text.');
    const first = await page.inputValue('#actionsBody [data-action-row="0"] [data-action]');

    // A drag-only handle cannot be operated without a mouse, so it takes arrows.
    await page.focus('#actionsBody [data-action-row="0"] [data-action-grip]');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.inputValue('#actionsBody [data-action-row="1"] [data-action]'), first);
    assert.equal(await page.inputValue('#actionsBody [data-action-row="0"] [data-action]'), 'Second action text.');

    // Focus follows the row that moved, so the keys can be pressed repeatedly.
    assert.equal(await page.evaluate(() => document.activeElement.dataset.actionGrip), '1');

    await page.keyboard.press('ArrowUp');
    assert.equal(await page.inputValue('#actionsBody [data-action-row="0"] [data-action]'), first);

    // The top row cannot move above itself.
    await page.focus('#actionsBody [data-action-row="0"] [data-action-grip]');
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.inputValue('#actionsBody [data-action-row="0"] [data-action]'), first);

    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    server.close();
  }
});

test('a discussion record moves within its topic and across topics', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'topic-cleanup');
    browser = launched.browser;
    const { page, errors } = launched;
    await page.click('[data-step="2"]');

    const firstText = await page.inputValue('.discussion-card:nth-child(1) [data-record-field]');
    const secondCardCount = await page.locator('.discussion-card:nth-child(2) [data-record-field]').count();

    // Arrows move a record within its own kind; the first row cannot rise.
    await page.focus('.discussion-card:nth-child(1) [data-record-grip]');
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.inputValue('.discussion-card:nth-child(1) [data-record-field]'), firstText);

    // Dropping onto a row in another topic moves it there, keeping its kind.
    await page.evaluate(() => {
      const grip = document.querySelector('.discussion-card:nth-child(1) [data-record-grip]');
      const target = document.querySelector('.discussion-card:nth-child(2) [data-record-row]');
      const data = new DataTransfer();
      grip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data }));
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: data }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: data }));
    });
    assert.equal(await page.locator('.discussion-card:nth-child(2) [data-record-field]').count(), secondCardCount + 1);
    const movedKind = await page.locator('.discussion-card:nth-child(2) [data-record-field]').first().getAttribute('data-record-field');
    assert.equal(movedKind, 'points', 'a discussion point stays a discussion point when it moves');

    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    server.close();
  }
});

test('a discussion record moves to another topic from its menu, and every topic collapses at once', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'topic-cleanup');
    browser = launched.browser;
    const { page, errors } = launched;
    await page.click('[data-step="2"]');

    const firstText = await page.inputValue('.discussion-card:nth-child(1) [data-record-field]');
    const secondCardCount = await page.locator('.discussion-card:nth-child(2) [data-record-field]').count();
    await page.click('.discussion-card:nth-child(1) .record-menu>summary');
    await page.selectOption('.discussion-card:nth-child(1) [data-move-record-topic]', '1');
    assert.equal(await page.locator('.discussion-card:nth-child(2) [data-record-field]').count(), secondCardCount + 1);
    assert.equal(await page.locator('.discussion-card:nth-child(2) [data-record-field]').last().inputValue(), firstText);

    await page.click('[data-toggle-all-topics]');
    assert.equal(await page.locator('.discussion-card.is-collapsed').count(), await page.locator('.discussion-card').count());
    assert.equal((await page.textContent('[data-toggle-all-topics]')).trim(), 'Expand all');
    await page.click('[data-toggle-all-topics]');
    assert.equal(await page.locator('.discussion-card.is-collapsed').count(), 0);

    // A topic's title can be left out of the minutes, or every title at once.
    await page.click('.discussion-card:nth-child(1) .topic-menu>summary');
    await page.click('[data-toggle-topic-heading="0"]');
    assert.equal(await page.locator('.discussion-card:nth-child(1).is-heading-hidden').count(), 1);
    await page.uncheck('[data-topic-headings-switch]');
    assert.equal(await page.locator('.discussion-card.is-heading-hidden').count(), await page.locator('.discussion-card').count());
    assert.equal(await page.evaluate(() => document.querySelector('[data-topic-headings-switch]').checked), false);

    // A point becomes a decision from its own menu.
    await page.click('.discussion-card:nth-child(1) .record-menu>summary');
    await page.click('.discussion-card:nth-child(1) [data-change-kind="decisions"]');
    assert.equal(await page.locator('.discussion-card:nth-child(1) [data-record-field="decisions"]').count(), 1);

    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    server.close();
  }
});

test('the workflow has five steps and Details leads straight to generating', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'editor');
    browser = launched.browser;
    const { page, errors } = launched;

    assert.equal(await page.locator('.steps .step').count(), 5, 'Focus is gone from the stepper');
    assert.equal(await page.locator('.steps .step[data-step="1"]').count(), 0);
    // A draft saved on the retired index landing on Discussion rather than on
    // Actions is covered by 'a prepared Discussion is adopted automatically
    // after Details', whose fixture is saved on step 1.

    // The steer was hidden on 2026-09-26 after being used on 1 of 348 drafts.
    // It is hidden rather than removed, so it is still in the page and still
    // wired - and putting it back is a matter of dropping one attribute.
    await page.click('[data-step="0"]');
    assert.equal(await page.locator('#meetingSteer').count(), 1, 'still in the page');
    assert.equal(await page.locator('.steer-optional').isHidden(), true, 'but not offered');
    await page.evaluate(() => { document.querySelector('.steer-optional').hidden = false; });
    await page.click('.steer-optional>summary');
    assert.equal(await page.locator('#meetingSteer').isVisible(), true, 'one attribute reinstates it');

    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    server.close();
  }
});

test('an opened transcript panel survives a re-render, and each step remembers its place', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'topic-cleanup');
    browser = launched.browser;
    const { page, errors } = launched;
    await page.click('[data-step="2"]');
    await page.waitForSelector('#discussionList .discussion-card');

    // Open a point's transcript in the side drawer, then force the list to be rebuilt.
    await page.locator('#discussionList .record-menu>summary').first().click();
    await page.locator('#discussionList .record-menu[open] [data-view-transcript]').click();
    await page.waitForSelector('#sideDrawer:not([hidden])');
    await page.evaluate(() => { const t = document.querySelector('[data-topic]'); if (t) { t.value = t.value + ' edited'; t.dispatchEvent(new Event('input', { bubbles: true })); } });
    await page.waitForTimeout(600);
    assert.equal(await page.locator('#sideDrawer').isVisible(), true,
      'the passage a reviewer opened to read stays open across a re-render');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#sideDrawer').isVisible(), false);

    // Use native keyboard activation without first scrolling the off-screen
    // step button into view. locator.click() does that implicitly, changing
    // the position the app is correctly asked to remember to zero.
    const activateStep = async (step) => {
      await page.locator('[data-step="' + step + '"]').evaluate((node) => node.focus({ preventScroll: true }));
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-screen="' + step + '"].active');
    };
    // Without the old page-wide banner this short fixture needs a shorter
    // window to have room to scroll.
    await page.setViewportSize({ width: 1280, height: 560 });
    await page.mouse.wheel(0, 220);
    await page.waitForFunction(() => window.scrollY >= 200);
    const before = await page.evaluate(() => window.scrollY);
    await activateStep(0);
    await page.waitForTimeout(300);
    await activateStep(2);
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => window.scrollY);
    assert.ok(Math.abs(after - before) < 60, 'returned to ' + after + ' after leaving from ' + before);

    // Conversely, deliberately scrolling back to the tabs before clicking
    // must remember the top, rather than an earlier reading position.
    await page.mouse.wheel(0, -1000);
    await page.waitForFunction(() => window.scrollY === 0);
    await page.click('[data-step="0"]');
    await page.waitForTimeout(300);
    await page.click('[data-step="2"]');
    await page.waitForTimeout(600);
    assert.ok(await page.evaluate(() => window.scrollY < 2), 'mouse navigation remembers the actual departure position');

    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    server.close();
  }
});

test('action View transcript opens the relevant passage by mouse and keyboard', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'editor');
    browser = launched.browser;
    const { page, errors } = launched;
    await page.click('[data-step="3"]');
    const button = page.locator('[data-action-row="0"] [data-open-action-transcript]');
    const panel = page.locator('[data-action-row="0"] [data-action-transcript-panel]');
    await clickMenuItem(page, button);
    assert.equal(await panel.evaluate((node) => node.open), true);
    assert.equal(await button.getAttribute('aria-expanded'), 'true');
    assert.ok(await panel.locator('.source-speaker').count() > 0, 'speaker is visible');
    assert.ok(await panel.locator('.source-time').count() > 0, 'timestamp is visible');

    await page.evaluate(() => {
      const node = document.querySelector('[data-action-row="0"] [data-action-transcript-panel]');
      node.open = false;
      node.querySelector('summary').blur();
    });
    await page.locator('[data-action-row="0"] .row-menu>summary').focus();
    await page.keyboard.press('Enter');
    await button.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(50);
    assert.equal(await panel.evaluate((node) => node.open), true, 'keyboard activation opens the same passage');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    server.close();
  }
});

test('transcript excerpts hide internal ids and avoid repeated speaker labels', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'transcript-display');
    browser = launched.browser;
    const { page, errors } = launched;
    await page.click('[data-step="3"]');
    await clickMenuItem(page, '[data-action-row="0"] [data-open-action-transcript]');
    const panel = page.locator('[data-action-row="0"] [data-action-transcript-panel]');

    assert.equal(await panel.locator('.source-id').count(), 0, 'internal transcript ids are not rendered');
    assert.equal(await panel.locator('.source-kind').count(), 0, 'context rows do not repeat an explanatory label');
    assert.doesNotMatch(await panel.textContent(), /surrounding context/i);
    assert.equal(await panel.locator('.source-speaker', { hasText: 'Alex Reed' }).count(), 1, 'a consecutive speaker is named once');
    assert.equal(await panel.locator('.source-speaker', { hasText: 'Sam Okoro' }).count(), 1, 'a new speaker is named');
    assert.equal(await panel.locator('.source-time').count(), 3, 'timestamps still distinguish each line');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    server.close();
  }
});

test('independent section switches hide output without deleting saved content', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    // A fixture that has reached Summary, so that step is unlocked.
    const launched = await launchPage(port, 'layout');
    browser = launched.browser;
    const { page, errors } = launched;

    await page.click('[data-step="0"]');
    assert.equal(await page.locator('#includeObjectives').isChecked(), true, 'both are on by default');
    assert.equal(await page.locator('#includeSummary').isChecked(), true);
    const staleBeforeInclusion = await page.evaluate(async () => (await (await fetch('/test-state/layout')).json()).draft.staleStages || []);

    await page.click('[data-step="4"]');
    assert.equal(await page.locator('[data-section="executiveSummary"]').isHidden(), false);
    assert.equal(await page.evaluate(() => {
      const rule = Array.from(document.querySelectorAll('style')).flatMap((node) => Array.from(node.sheet.cssRules || []))
        .find((candidate) => candidate.selectorText === '.meeting-agent-page .summary-field .add-record');
      return rule && rule.style.background;
    }), 'var(--brand-050)', 'the add-objective control uses the brand tint');
    const longSummary = 'A long reviewer-written summary sentence that must remain readable without an internal scrollbar. '.repeat(24);
    await page.fill('#executiveSummary', longSummary);
    await page.waitForTimeout(100);
    const summaryBox = await page.locator('#executiveSummary').evaluate((node) => ({
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      overflowY: getComputedStyle(node).overflowY
    }));
    assert.ok(summaryBox.clientHeight >= summaryBox.scrollHeight, JSON.stringify(summaryBox));
    assert.equal(summaryBox.overflowY, 'hidden');
    await page.waitForTimeout(1000);

    // Turn the executive summary off.
    await page.click('[data-step="0"]');
    await page.uncheck('#includeSummary');
    const staleAfterSummaryToggle = await page.evaluate(async () => (await (await fetch('/test-state/layout')).json()).draft.staleStages || []);
    assert.deepEqual(staleAfterSummaryToggle, staleBeforeInclusion, 'summary inclusion does not change downstream freshness');
    await page.click('[data-step="4"]');
    assert.equal(await page.locator('[data-section="executiveSummary"]').isHidden(), true,
      'an excluded section leaves the screen rather than sitting there empty');
    assert.equal(await page.locator('[data-section="meetingObjectives"]').isHidden(), false,
      'the other section is untouched');

    // The choice reaches the server, and the text goes with it.
    await page.waitForFunction(async () => {
      const state = await (await fetch('/test-state/layout')).json();
      return state.draft.includeSections && state.draft.includeSections.executiveSummary === false;
    });
    assert.equal(await page.evaluate(async () => (await (await fetch('/test-state/layout')).json()).draft.executiveSummary), longSummary.trim());

    // All four combinations remain possible and the final review honours the
    // choice without changing the underlying text.
    const combinations = [
      [true, true, true, true],
      [true, false, true, false],
      [false, true, false, true],
      [false, false, false, false]
    ];
    for (const [objectives, summary, expectObjectives, expectSummary] of combinations) {
      await page.click('[data-step="0"]');
      const objectiveBox = page.locator('#includeObjectives');
      const summaryBox = page.locator('#includeSummary');
      if ((await objectiveBox.isChecked()) !== objectives) await objectiveBox.click();
      if ((await summaryBox.isChecked()) !== summary) await summaryBox.click();
      await page.click('[data-step="5"]');
      assert.equal(await page.locator('#finalDocument h3').filter({ hasText: 'Meeting objectives' }).count() > 0, expectObjectives);
      assert.equal(await page.locator('#finalDocument h3').filter({ hasText: 'Executive summary' }).count() > 0, expectSummary);
    }

    // Turning both off leaves an explanation rather than an empty screen.
    await page.click('[data-step="0"]');
    await page.uncheck('#includeObjectives');
    await page.click('[data-step="4"]');
    assert.equal(await page.locator('#summaryAllExcluded').isHidden(), false);

    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    server.close();
  }
});

test('edit confirmations and history labels use sentence capitalisation', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'layout');
    browser = launched.browser;
    const { page, errors } = launched;
    await page.click('[data-step="4"]');
    const saved = page.waitForResponse((response) => response.url().endsWith('/api/meeting-minutes-agent/drafts/layout')
      && response.request().method() === 'PATCH'
      && /^Removed “.+”$/.test(response.request().postDataJSON().reviewDecisionLabel || ''));
    await clickMenuItem(page, '[data-remove-objective]');
    await saved;
    assert.match((await page.locator('#undoToastMessage').textContent()).trim(), /^Removed “.+”\.$/);
    assert.match(await page.locator('#undoLastDecision').getAttribute('aria-label'), /^Undo: Removed “.+”$/);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a typing burst is one undo step, and a second field starts another', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'editor');
    browser = launched.browser;
    const { page, errors } = launched;

    const historyCount = async () => page.evaluate(async () =>
      (await (await fetch('/test-state/editor')).json()).undoLabels.length);
    const before = await historyCount();

    // A continuous edit to one field: several autosaves, one step.
    const field = page.locator('#actionsBody [data-action-row="0"] [data-action]');
    await field.click();
    for (const word of ['Send ', 'the ', 'revised ', 'report ', 'today.']) {
      await page.keyboard.type(word, { delay: 15 });
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(1900);
    const afterFirst = await historyCount();
    assert.equal(afterFirst - before, 1, 'one burst is one step, not one per autosave');
    assert.match(await page.textContent('#undoLastDecision'), /Undo: edit action/i);

    // Moving to a different field starts a new step.
    await page.click('#actionsBody [data-action-row="0"] [data-edit-timing]');
    await page.click('#actionsBody [data-action-row="0"] [data-timing-date]');
    await page.fill('#actionsBody [data-action-row="0"] [data-timing-date]', '2026-10-01');
    await page.waitForTimeout(1900);
    assert.equal(await historyCount() - afterFirst, 1, 'another field is another step');
    assert.match(await page.textContent('#undoLastDecision'), /Undo: change timing/i);

    // Undo puts the date back and offers a redo.
    await page.click('#undoLastDecision');
    await page.waitForTimeout(900);
    assert.equal(await page.inputValue('#actionsBody [data-action-row="0"] [data-timing-date]'), '');
    assert.equal(await page.locator('#redoLastDecision').isHidden(), false);
    assert.match(await page.textContent('#redoLastDecision'), /Redo: change timing/i);

    // Redo reapplies it.
    await page.click('#redoLastDecision');
    await page.waitForTimeout(900);
    assert.equal(await page.inputValue('#actionsBody [data-action-row="0"] [data-timing-date]'), '2026-10-01');

    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    server.close();
  }
});

test('action generation has an honest waiting state and stage-scoped status', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'running');
    browser = launched.browser;
    const { page, errors } = launched;

    assert.match(await page.textContent('#actionsBody'), /evidence-checked report/i);
    assert.match(await page.textContent('#actionsBody'), /Temporary — final checks still running/i);
    assert.equal(await page.locator('#actionsBody textarea').count(), 0, 'preview remains read-only');
    assert.equal(await page.locator('#generationProgress').isVisible(), true);
    assert.match(await page.textContent('#generationPhases'), /Find possible actions.*Finish the draft/s);
    assert.equal(await page.locator('.generation-phase.done').count(), 3);
    assert.equal(await page.locator('.generation-phase.active').count(), 1);
    for (const selector of ['#addAction', '#applyActionsEdit', '#toSummary']) {
      const control = page.locator(selector);
      assert.equal((await control.isHidden()) || (await control.isDisabled()), true, `${selector} is unavailable while actions run`);
    }
    assert.equal(await page.locator('#addDiscussion').isDisabled(), false, 'safe Discussion additions remain available');
    assert.match(await page.textContent('#saveStatus'), /Everything is saved.*close the tab/i);
    assert.doesNotMatch(await page.textContent('#saveStatus'), /Unsaved changes/i);
    assert.match(await page.textContent('#actionsBody'), /Previously saved actions/i);
    assert.match(await page.textContent('#actionsBody'), /Send the revised report/i);

    await page.waitForFunction(() => document.getElementById('workflowStatus').dataset.stage === 'actions');
    assert.equal(await page.locator('#workflowStatus').isHidden(), true, 'the progress panel replaces duplicate stage status');
    await page.click('[data-step="2"]');
    assert.equal(await page.locator('#workflowStatus').isHidden(), true);
    assert.equal(await page.locator('#generationProgress').isVisible(), true, 'generation progress remains visible across stages');
    assert.equal(await page.locator('#viewGeneratedStage').isVisible(), true);

    await page.click('[data-step="0"]');
    assert.match(await page.textContent('#saveStatus'), /Everything is saved.*generation carries on without it/i,
      'navigation alone does not pretend the background run depends on this tab');
    await page.fill('#meetingTitle', 'Edited while actions run');
    assert.match(await page.textContent('#saveStatus'), /Waiting to save until generation finishes/i);
    // The generation panel used to repeat this sentence; the save strip is now
    // the only place that says whether the tab is safe to close.
    assert.equal(await page.locator('#generationLeaveMessage').count(), 0);
    assert.match(await page.textContent('#staleStages'), /actions/i);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Discussion shows Actions prewarming while the reviewer works', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'prewarming');
    browser = launched.browser;
    const { page, errors } = launched;
    assert.equal(await page.locator('[data-screen="2"]').evaluate((node) => node.classList.contains('active')), true);
    assert.equal(await page.locator('#actionsPrewarmNotice').isVisible(), true);
    assert.match(await page.textContent('#actionsPrewarmNotice'), /Preparing Actions in the background/i);
    assert.equal(await page.textContent('#generateActions [data-stage-advance-label]'), 'Preparing Actions…');
    assert.equal(await page.locator('#generateActions').isDisabled(), true);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

// Renamed with the Focus step: the adoption it protects still happens, it just
// happens on the way out of Details now.
test('a prepared Discussion is adopted automatically after Details', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'discussion-ready');
    browser = launched.browser;
    const { page, errors } = launched;
    await page.waitForFunction(async () => {
      const state = await (await fetch('/test-state/discussion-ready')).json();
      return state.draft.generation && state.draft.generation.stage === 'discussion';
    });
    assert.equal(await page.locator('[data-screen="2"]').evaluate((node) => node.classList.contains('active')), true);
    // Neither the progress title nor the panel is asserted: with Focus gone the
    // reviewer lands here immediately, so which stage is mid-flight is a race.
    // The adoption itself is what this test is for, and the wait above plus the
    // active screen prove it happened.
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('opening an empty Summary starts generation without requiring speculation', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'summary-empty');
    browser = launched.browser;
    const { page, errors } = launched;
    await page.waitForFunction(async () => {
      const state = await (await fetch('/test-state/summary-empty')).json();
      return state.draft.generation && state.draft.generation.stage === 'summary';
    });
    assert.equal(await page.locator('[data-screen="4"]').evaluate((node) => node.classList.contains('active')), true);
    assert.match(await page.textContent('#generationProgressTitle'), /Preparing summary…/i);
    assert.equal(await page.locator('#summaryFields').isHidden(), true);
    assert.equal(await page.locator('#generateSummary').isHidden(), true);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('successful Actions regeneration clears its outdated warning and stays clear after refresh', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'actions-completing');
    browser = launched.browser;
    const { page, errors } = launched;
    assert.match(await page.textContent('#actionsBody'), /Working preview/i);
    assert.match(await page.textContent('#actionsBody'), /Previously saved actions/i);
    assert.match(await page.textContent('#actionsBody'), /Send the revised report/i);
    await page.waitForFunction(() => /Send the final checked report/i.test(document.getElementById('actionsBody').textContent));
    assert.equal(await page.locator('#staleNotice').isHidden(), true);
    await page.reload();
    await page.waitForFunction(() => /Send the final checked report/i.test(document.getElementById('actionsBody').textContent));
    assert.equal(await page.locator('#staleNotice').isHidden(), true);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('starting Actions keeps the reviewer on Discussion and exposes background progress', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchOnDiscussion(port, 'background-conflict');
    browser = launched.browser;
    const { page, errors } = launched;
    const started = page.waitForResponse((response) =>
      response.url().endsWith('/api/meeting-minutes-agent/drafts/background-conflict/generate-background'));
    await page.click('#generateActions');
    const response = await started;
    assert.equal(response.request().postDataJSON().selectedStep, 2);
    assert.equal(await page.locator('[data-screen="2"]').evaluate((node) => node.classList.contains('active')), true);
    assert.equal(await page.locator('[data-step="3"]').isDisabled(), false);
    assert.equal(await page.locator('#generationProgress').isVisible(), true);
    assert.match(await page.textContent('#generationProgressTitle'), /Preparing actions/i);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('unfinished topics and discussion rows survive autosave responses while explicit deletion clears linked warnings', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'editor');
    browser = launched.browser;
    const { page, errors } = launched;
    await page.click('[data-step="2"]');

    await page.click('#addDiscussion');
    let cards = page.locator('#discussionList .discussion-card');
    assert.equal(await cards.count(), 2);
    const newTopic = cards.last();
    assert.equal(await newTopic.locator('[data-topic]').inputValue(), '');
    assert.match(await page.textContent('#saveStatus'), /kept in this tab/i);

    // An unrelated edit saves and the server omits the empty topic. The local
    // editor must be restored so the reviewer can carry on typing.
    const topicSave = page.waitForResponse((response) =>
      response.url().endsWith('/api/meeting-minutes-agent/drafts/editor')
        && response.request().method() === 'PATCH');
    await cards.first().locator('[data-topic]').fill('Report review updated');
    await topicSave;
    cards = page.locator('#discussionList .discussion-card');
    assert.equal(await cards.count(), 2);
    assert.equal(await cards.last().locator('[data-topic]').inputValue(), '');

    const namedTopicSave = page.waitForResponse((response) =>
      response.url().endsWith('/api/meeting-minutes-agent/drafts/editor')
        && response.request().method() === 'PATCH');
    await cards.last().locator('[data-topic]').fill('New topic in progress');
    await namedTopicSave;
    cards = page.locator('#discussionList .discussion-card');
    assert.equal(await cards.last().locator('[data-topic]').inputValue(), 'New topic in progress');

    // One tap adds a plain discussion point; there is no kind menu to open first.
    await cards.last().locator('[data-add-record="points"]').click();
    cards = page.locator('#discussionList .discussion-card');
    assert.equal(await cards.last().locator('[data-record-field="points"]').count(), 1);
    assert.equal(await cards.last().locator('[data-record-field="points"]').inputValue(), '');

    const rowSave = page.waitForResponse((response) =>
      response.url().endsWith('/api/meeting-minutes-agent/drafts/editor')
        && response.request().method() === 'PATCH');
    await cards.first().locator('[data-record-field="points"]').fill('The revised report is ready for circulation now.');
    await rowSave;
    cards = page.locator('#discussionList .discussion-card');
    assert.equal(await cards.last().locator('[data-record-field="points"]').count(), 1);
    assert.equal(await cards.last().locator('[data-record-field="points"]').inputValue(), '');

    const completedRowSave = page.waitForResponse((response) =>
      response.url().endsWith('/api/meeting-minutes-agent/drafts/editor')
        && response.request().method() === 'PATCH');
    await cards.last().locator('[data-record-field="points"]').fill('The team reviewed the new topic.');
    await completedRowSave;
    const saved = await page.evaluate(async () => (await (await fetch('/test-state/editor')).json()).draft);
    assert.equal(saved.discussion.some((topic) => topic.topic === 'New topic in progress'
      && topic.points.some((record) => record.text === 'The team reviewed the new topic.')), true);

    // The original sentence carries flag-1. Removing the sentence should close
    // that warning now that the target no longer exists.
    const deleteSave = page.waitForResponse((response) =>
      response.url().endsWith('/api/meeting-minutes-agent/drafts/editor')
        && response.request().method() === 'PATCH');
    await cards.first().locator('.record-menu>summary').click();
    await page.evaluate(() => document.querySelector('[data-remove-record="points"]')?.click());
    await deleteSave;
    const afterDelete = await page.evaluate(async () => (await (await fetch('/test-state/editor')).json()).draft);
    assert.equal(afterDelete.reviewFlags.find((flag) => flag.id === 'flag-1').status, 'dismissed');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('deleting a topic dismisses warnings belonging to its nested records', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'topic-cleanup');
    browser = launched.browser;
    const { page, errors } = launched;
    await page.click('[data-step="2"]');
    const deleteSave = page.waitForResponse((response) =>
      response.url().endsWith('/api/meeting-minutes-agent/drafts/topic-cleanup')
        && response.request().method() === 'PATCH');
    page.once('dialog', (dialog) => dialog.accept());
    await page.click('#discussionList .discussion-card:nth-child(2) .topic-menu>summary');
    await page.evaluate(() => document.querySelector('[data-delete-topic="1"]')?.click());
    await deleteSave;
    const saved = await page.evaluate(async () => (await (await fetch('/test-state/topic-cleanup')).json()).draft);
    assert.equal(saved.discussion.some((topic) => topic.id === 'topic-2'), false);
    assert.equal(saved.reviewFlags.find((flag) => flag.id === 'flag-topic').status, 'dismissed');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('selected stage and deletions survive save responses, navigation and reopening', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'editor');
    browser = launched.browser;
    const { page, errors } = launched;

    const actionDeleteSave = page.waitForResponse((response) =>
      response.url().endsWith('/api/meeting-minutes-agent/drafts/editor')
        && response.request().method() === 'PATCH');
    await clickMenuItem(page, '#actionsBody [data-reject-action]');
    assert.equal(await page.locator('#actionsBody [data-action-row]').count(), 0);
    await actionDeleteSave;
    // Moving to another screen is not an edit, so it sends nothing; the
    // screen is remembered in this browser instead.
    await page.click('[data-step="2"]');
    await page.waitForTimeout(400);

    const stateAfterActionDelete = await page.evaluate(async () => await (await fetch('/test-state/editor')).json());
    const savedAfterActionDelete = stateAfterActionDelete.draft;
    assert.equal(stateAfterActionDelete.lastPatch.actions.length, 0);
    assert.equal(savedAfterActionDelete.actions.length, 0);
    assert.equal(savedAfterActionDelete.currentStep, 3, 'furthest unlocked stage remains Actions');
    assert.equal(savedAfterActionDelete.reviewFlags.find((flag) => flag.id === 'flag-action').status, 'dismissed');

    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-screen="2"]').classList.contains('active'));
    assert.equal(await page.locator('[data-step="3"]').isDisabled(), false, 'Actions remains unlocked after reopening');

    const discussionDeleteSave = page.waitForResponse((response) =>
      response.url().endsWith('/api/meeting-minutes-agent/drafts/editor')
        && response.request().method() === 'PATCH');
    await page.click('#discussionList .record-menu>summary');
    await page.evaluate(() => document.querySelector('[data-remove-record]')?.click());
    await discussionDeleteSave;
    const savedAfterDiscussionDelete = await page.evaluate(async () => (await (await fetch('/test-state/editor')).json()).draft);
    assert.equal(savedAfterDiscussionDelete.discussion.some((topic) =>
      (topic.points || []).some((point) => point.id === 'discussion-1')), false);
    assert.equal(savedAfterDiscussionDelete.reviewFlags.find((flag) => flag.id === 'flag-1').status, 'dismissed');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('unfinished owner text survives a background completion', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));

    await page.goto(`http://127.0.0.1:${port}/meeting-minutes-agent`);
    await page.locator('#transcriptFile').setInputFiles({
      name: 'transcript.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from('stub')
    });
    await page.waitForFunction(() => /Transcript uploaded and processing has started in the background/i.test(document.getElementById('workflowStatus').textContent));
    // The Focus step used to sit here, and this test stepped through it to check
    // the details prompt cleared. With Focus retired the only way forward is to
    // generate, which is a different subject; what this test protects is the
    // unfinished owner text below surviving a background completion.

    const completionResponse = page.waitForResponse((response) =>
      response.url().endsWith('/api/meeting-minutes-agent/drafts/summary-running/generation'));
    await page.goto(`http://127.0.0.1:${port}/meeting-minutes-agent?draftId=summary-running`);
    await page.waitForFunction(() => document.querySelector('#actionsBody tr'));
    assert.equal(await page.locator('[data-screen="3"]').evaluate((node) => node.classList.contains('active')), true);
    await page.click('#actionsBody [data-action-row="0"] [data-edit-owners]');
    await page.selectOption('#actionsBody [data-action-row="0"] [data-add-owner]', '__other');
    const owner = page.locator('#actionsBody [data-action-row="0"] [data-owner-other]');
    await owner.fill('Jordan Lee');

    const completed = await completionResponse;
    assert.match(JSON.stringify(await completed.json()), /confirmed for circulation/);
    assert.deepEqual(errors, []);
    await page.waitForTimeout(500);
    const completionState = await page.evaluate(() => ({
      status: document.getElementById('workflowStatus').textContent,
      summary: document.getElementById('executiveSummary').value,
      save: document.getElementById('saveStatus').textContent
    }));
    assert.match(completionState.summary, /confirmed for circulation/, JSON.stringify(completionState));
    assert.equal(await page.locator('[data-screen="3"]').evaluate((node) => node.classList.contains('active')), true);
    assert.equal(await owner.isVisible(), true);
    assert.equal(await owner.inputValue(), 'Jordan Lee');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('editing the discussion with nothing running marks the existing Actions outdated', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'editor');
    browser = launched.browser;
    const { page, errors } = launched;
    const actionsLink = page.locator('[data-stale-slot="actions"] [data-stale-link="actions"]');
    assert.equal(await actionsLink.count(), 0, 'no warning before any edit');
    await page.click('[data-step="2"]');
    await page.fill('#discussionList [data-record-field]', 'The revised report is ready for circulation next week.');
    assert.equal(await actionsLink.count(), 1, 'a material discussion edit marks the Actions section immediately');
    assert.equal(await page.locator('#staleNotice').isHidden(), true, 'the page-wide banner is retired');
    await page.click('[data-step="3"]');
    assert.equal(await actionsLink.isVisible(), true);
    assert.match(await actionsLink.textContent(), /Discussion changed/);
    // Dismissing it is remembered for this draft.
    await page.click('[data-stale-slot="actions"] [data-dismiss-stale="actions"]');
    assert.equal(await actionsLink.count(), 0);
    await page.reload();
    await page.waitForSelector('#actionsBody tr');
    assert.equal(await actionsLink.count(), 0, 'a dismissed link stays dismissed after reload');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('adding and deleting a blank discussion topic does not mark the Actions outdated', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'editor');
    browser = launched.browser;
    const { page, errors } = launched;
    await page.click('[data-step="2"]');
    await page.click('#addDiscussion');
    const actionsLink = page.locator('[data-stale-link="actions"]');
    assert.equal(await actionsLink.count(), 0, 'a blank topic is not a material edit');
    await page.click('#discussionList .discussion-card:nth-child(2) .topic-menu>summary');
    // Autosave can replace the card between Playwright's stability probe and
    // the click. Dispatch on the current node, as a user click would, instead
    // of retrying a detached copy for the whole default timeout.
    await page.evaluate(() => document.querySelector('[data-delete-topic="1"]')?.click());
    assert.equal(await page.locator('#discussionList [data-delete-topic]').count(), 1);
    assert.equal(await actionsLink.count(), 0, 'deleting a topic that never had text is not a material edit');
    // Deleting a topic that carries real content still is.
    page.once('dialog', (dialog) => dialog.accept());
    await page.click('#discussionList .discussion-card:first-child .topic-menu>summary');
    await page.evaluate(() => document.querySelector('[data-delete-topic="0"]')?.click());
    assert.equal(await actionsLink.count(), 1);
    assert.match(await page.textContent('#staleStages'), /actions/i);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('review checks lead with the potential minutes content and keep diagnostic detail collapsed', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${port}/meeting-minutes-agent?draftId=minutes-first-warning`);
    await page.waitForSelector('.flag', { state: 'attached' });
    await page.click('#reviewQueueToggle');

    const warning = page.locator('.flag').first();
    assert.equal(await warning.locator('.flag-target>span').textContent(), 'Transcript detail to consider');
    assert.match(await warning.locator('.flag-target blockquote').textContent(), /standard may be 27427/i);
    assert.doesNotMatch(await warning.textContent(), /No matching item is currently in the minutes/i);
    assert.equal(await warning.locator('.flag-kind').textContent(), 'Reference to check');
    assert.equal(await warning.locator('.flag-review-reason').evaluate((node) => node.open), false);
    assert.equal(await warning.locator('.flag-review-reason>summary').getByText('Why this was highlighted').count(), 1);
    assert.equal(await warning.locator('.flag-message').textContent(), 'Confirm the standard reference exactly as spoken.');
    assert.equal(await warning.getByRole('button', { name: 'Mark checked' }).count(), 1);
    assert.equal(await warning.getByRole('button', { name: 'Does not belong in minutes' }).count(), 1);
    assert.doesNotMatch(await warning.textContent(), /Your decision|Resolved in minutes|Open item to correct/i);
    await warning.locator('.review-note>summary').click();
    const noteLayout = await warning.locator('.review-note>div').evaluate((node) => {
      const parent = node.getBoundingClientRect();
      return Array.from(node.children).map((child) => {
        const rect = child.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width, parentLeft: parent.left, parentRight: parent.right };
      });
    });
    assert.equal(noteLayout.every((item) => item.left >= item.parentLeft - 1 && item.right <= item.parentRight + 1), true);
    assert.equal(noteLayout.every((item) => item.width > 240), true, 'open note controls use the mobile card width');
    const genericCheck = page.locator('.flag').nth(1);
    assert.equal(await genericCheck.locator('.flag-review-reason').count(), 0, 'a generic reason does not create an empty disclosure');
    assert.equal(await genericCheck.locator('.flag-review-summary .flag-kind').textContent(), 'Uncertain detail');
    assert.doesNotMatch(await genericCheck.textContent(), /Cannot verify|Why this was highlighted/i);
    const order = await warning.evaluate((node) => {
      const candidate = node.querySelector('.flag-target');
      const reason = node.querySelector('.flag-review-reason');
      return Boolean(candidate.compareDocumentPosition(reason) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    assert.equal(order, true, 'the potential minutes content appears before the review reason');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('automatic proposals apply vetted changes once and keep uncertain additions as visible checks after refresh', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    const applications = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/partial-proposals/proposal')) applications.push(request.postDataJSON());
    });
    await page.goto(`http://127.0.0.1:${port}/meeting-minutes-agent?draftId=partial-proposals`);
    await page.waitForFunction(() => document.querySelectorAll('#actionsBody [data-action]').length === 2);
    const saved = await page.evaluate(async () => (await (await fetch('/test-state/partial-proposals')).json()).draft);
    assert.equal(saved.pendingProposal, null);
    assert.deepEqual(saved.actions.map((action) => action.id), ['action-1', 'partial-action-1']);
    assert.equal(saved.reviewFlags.filter((flag) => flag.id.startsWith('proposal-review-') && flag.status === 'confirmed').length, 1);
    assert.equal(saved.reviewFlags.find((flag) => flag.id === 'flag-action').status, 'open', 'unrelated source checks remain open');
    assert.equal(saved.reviewFlags.find((flag) => flag.id === 'automatic-review-partial-2').status, 'open');
    assert.match(await page.textContent('#flagList'), /Circulate the audit checklist/);
    assert.deepEqual(applications, [{ revision: 3, decision: 'accept', automatic: true, changeIds: [] }]);
    assert.equal(await page.locator('#undoLastDecision').isVisible(), true);
    assert.equal(await page.locator('#proposalPanel,[data-proposal-change]').count(), 0);
    assert.equal(await page.textContent('#applyActionsEdit'), 'Apply changes');
    assert.equal(await page.textContent('#applyDiscussionEdit'), 'Apply changes');
    assert.equal(await page.locator('.agent-edit-body').filter({ hasText: 'Generated changes are applied automatically. You can undo them afterwards.' }).count(), 2);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#actionsBody [data-action]').length === 2);
    assert.equal(applications.length, 1, 'refresh cannot apply an already consumed proposal again');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('failed automatic proposal application preserves the draft and can recover on reload', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.route('**/drafts/proposals/proposal', (route) => route.fulfill({
      status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporarily unavailable' })
    }));
    await page.goto(`http://127.0.0.1:${port}/meeting-minutes-agent?draftId=proposals`);
    await page.waitForFunction(() => document.getElementById('workflowStatus').textContent.includes('could not be applied automatically'));
    assert.equal(await page.locator('#workflowStatus').isVisible(), true);
    assert.equal(await page.locator('#actionsBody [data-action]').count(), 1);
    let saved = await page.evaluate(async () => (await (await fetch('/test-state/proposals')).json()).draft);
    assert.equal(saved.pendingProposal.changes.length, 1);
    assert.equal(saved.reviewFlags.find((flag) => flag.id === 'proposal-review-proposal-1').status, 'open');
    await page.unroute('**/drafts/proposals/proposal');
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#actionsBody [data-action]').length === 2);
    saved = await page.evaluate(async () => (await (await fetch('/test-state/proposals')).json()).draft);
    assert.equal(saved.pendingProposal, null);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a failed AI edit application keeps its error and the instruction available to retry', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'editor');
    browser = launched.browser;
    const { page, errors } = launched;
    await page.route('**/api/meeting-minutes-agent/generate', async (route) => {
      const saved = await (await page.request.get(`http://127.0.0.1:${port}/test-state/editor`)).json();
      const proposed = await (await page.request.get(`http://127.0.0.1:${port}/test-state/proposals`)).json();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        ok: true, draft: { ...saved.draft, pendingProposal: proposed.draft.pendingProposal }
      }) });
    });
    await page.route('**/drafts/editor/proposal', (route) => route.fulfill({
      status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Application unavailable' })
    }));
    await page.locator('[data-screen="3"] .agent-edit>summary').click();
    await page.fill('#actionsInstruction', 'Include the audit folder follow-up.');
    const application = page.waitForResponse((response) => response.url().endsWith('/editor/proposal'));
    await page.click('#applyActionsEdit');
    await application;
    await page.waitForFunction(() => !document.body.classList.contains('busy'));
    assert.match(await page.textContent('#workflowStatus'), /could not be applied automatically.*Application unavailable/i);
    assert.equal(await page.locator('#workflowStatus').evaluate((node) => node.classList.contains('error')), true);
    assert.equal(await page.inputValue('#actionsInstruction'), 'Include the audit folder follow-up.');
    assert.equal(await page.locator('#actionsBody [data-action]').count(), 1);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('an AI edit waits for an automatic proposal already in flight and retains its instruction', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  let releaseApplication;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    const generations = [];
    let applications = 0;
    page.on('pageerror', (error) => errors.push(String(error)));
    const heldApplication = new Promise((resolve) => { releaseApplication = resolve; });
    await page.route('**/drafts/proposals/proposal', async (route) => {
      applications += 1;
      await heldApplication;
      await route.continue();
    });
    await page.route('**/api/meeting-minutes-agent/generate', async (route) => {
      generations.push(route.request().postDataJSON());
      const saved = await (await page.request.get(`http://127.0.0.1:${port}/test-state/proposals`)).json();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, draft: saved.draft }) });
    });
    const applicationStarted = page.waitForRequest((request) => request.url().endsWith('/proposals/proposal'));
    await page.goto(`http://127.0.0.1:${port}/meeting-minutes-agent?draftId=proposals`);
    await applicationStarted;
    await page.locator('[data-screen="3"] .agent-edit>summary').click();
    await page.fill('#actionsInstruction', 'Clarify the report recipient.');
    await page.click('#applyActionsEdit');
    // Both the rejected edit and the old erroneous success settle visibly;
    // no arbitrary sleep is needed to distinguish them.
    await page.waitForFunction(() => document.getElementById('workflowStatus').textContent.includes('still being applied')
      || (!document.body.classList.contains('busy') && document.getElementById('actionsInstruction').value === ''));
    assert.equal(generations.length, 0, 'generation cannot overlap the earlier revision-changing application');
    assert.equal(applications, 1, 'the active proposal is not submitted again');
    assert.equal(await page.inputValue('#actionsInstruction'), 'Clarify the report recipient.');
    assert.match(await page.textContent('#workflowStatus'), /still being applied/i);
    releaseApplication();
    await page.waitForFunction(() => document.querySelectorAll('#actionsBody [data-action]').length === 2
      && document.getElementById('saveStatus').dataset.state === 'saved');
    assert.equal(await page.inputValue('#actionsInstruction'), 'Clarify the report recipient.', 'completion of the earlier proposal cannot consume an unstarted edit');
    assert.equal(generations.length, 0);
    assert.equal(applications, 1);
    await page.click('#applyActionsEdit');
    await page.waitForFunction(() => document.getElementById('actionsInstruction').value === '');
    assert.equal(generations.length, 1, 'the same edit can proceed once the earlier application finishes');
    assert.equal(generations[0].instruction, 'Clarify the report recipient.');
    assert.equal(applications, 1, 'retry does not reapply the consumed proposal');
    assert.deepEqual(errors, []);
  } finally {
    if (releaseApplication) releaseApplication();
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('leaving warns while a save is in flight or has failed, and stops warning after a confirmed save', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  let releaseSave;
  try {
    const launched = await launchPage(port, 'editor');
    browser = launched.browser;
    const { page, errors } = launched;
    await page.click('[data-step="0"]');
    await page.waitForFunction(() => document.getElementById('saveStatus').dataset.state === 'saved');
    const heldSave = new Promise((resolve) => { releaseSave = resolve; });
    await page.route('**/drafts/editor', async (route) => {
      if (route.request().method() === 'PATCH') await heldSave;
      await route.continue();
    });
    const shouldWarn = () => page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
    await page.fill('#meetingTitle', 'Unsaved meeting title');
    await page.click('#replaceTranscript');
    await page.waitForFunction(() => document.getElementById('saveStatus').dataset.state === 'saving');
    assert.equal(await shouldWarn(), true, 'an ordinary in-flight PATCH is not guaranteed to finish after the tab closes');
    releaseSave();
    await page.locator('#newTranscriptDialog').waitFor({ state: 'visible' });
    await page.locator('#newTranscriptDialog button[value="cancel"]').click();
    assert.equal(await shouldWarn(), false, 'a confirmed save is safe to leave');
    await page.unroute('**/drafts/editor');
    await page.route('**/drafts/editor', (route) => route.request().method() === 'PATCH'
      ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Save unavailable' }) })
      : route.continue());
    await page.fill('#meetingTitle', 'Still unsaved after failure');
    await page.click('#replaceTranscript');
    await page.waitForFunction(() => document.getElementById('saveStatus').dataset.state === 'error');
    assert.equal(await shouldWarn(), true, 'a failed save must not silently permit losing the reviewer edits');
    assert.equal(await page.inputValue('#meetingTitle'), 'Still unsaved after failure');
    assert.deepEqual(errors, []);
  } finally {
    if (releaseSave) releaseSave();
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a meeting-date source warning opens the Details date field and remains reviewable after reload', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'metadata-date-warning');
    browser = launched.browser;
    const { page, errors } = launched;
    assert.match(await page.textContent('#flagCount'), /1 check/);
    await page.click('#reviewQueueToggle');
    assert.match(await page.textContent('.flag-target'), /Meeting date/i);
    assert.doesNotMatch(await page.textContent('.flag-target'), /Send the revised report/);
    await page.click('[data-view-flag-target="meetingDate"]');
    await page.waitForFunction(() => document.querySelector('[data-screen="0"]').classList.contains('active')
      && document.activeElement?.id === 'meetingDate');
    assert.equal(await page.inputValue('#meetingDate'), '');
    const saved = page.waitForResponse((response) => response.url().endsWith('/api/meeting-minutes-agent/drafts/metadata-date-warning')
      && response.request().method() === 'PATCH');
    await page.fill('#meetingDate', '2026-09-16');
    await saved;
    await page.waitForFunction(() => document.getElementById('saveStatus')?.dataset.state === 'saved');
    await page.reload();
    await page.waitForSelector('#meetingDate');
    assert.equal(await page.inputValue('#meetingDate'), '2026-09-16');
    assert.match(await page.textContent('#flagCount'), /1 check/);
    await page.click('#reviewQueueToggle');
    assert.equal(await page.locator('[data-view-flag-target="meetingDate"]').isVisible(), true);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('an unlinked timing warning routes to its Action field and resolves when that Action is deleted', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'unlinked-warning');
    browser = launched.browser;
    const { page, errors } = launched;
    await page.click('#reviewQueueToggle');
    assert.match(await page.textContent('.flag-target'), /Complete and sign the training attestation/i);
    await page.click('[data-view-flag-target]');
    await page.waitForFunction(() => document.querySelector('[data-screen="3"]').classList.contains('active'));
    // A timing warning continues to route directly to the date control while
    // the source wording is also available for review in the same editor.
    assert.equal(await page.locator('#minutes-action-training-action [data-timing-date]').evaluate((node) => node === document.activeElement), true);

    const savedResponse = page.waitForResponse((response) => response.url().endsWith('/api/meeting-minutes-agent/drafts/unlinked-warning')
      && response.request().method() === 'PATCH');
    await clickMenuItem(page, '#minutes-action-training-action [data-reject-action]');
    await savedResponse;
    const saved = await page.evaluate(async () => (await (await fetch('/test-state/unlinked-warning')).json()).draft);
    assert.equal(saved.reviewFlags.find((flag) => flag.id === 'training-timing-flag').status, 'dismissed');
    assert.equal(await page.locator('#reviewFlags').isHidden(), true);
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-screen="3"]').classList.contains('active'));
    assert.equal(await page.locator('#reviewFlags').isHidden(), true, 'the deleted Action warning stays resolved after refresh');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('every warning decision exposes a durable Undo that survives refresh', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'editor');
    browser = launched.browser;
    const { page, errors } = launched;
    if (!await page.locator('#reviewFlags').evaluate((node) => node.open)) await page.click('#reviewQueueToggle');
    const warning = page.locator('.flag').filter({ hasText: 'Check the owner of this action.' });
    const saved = page.waitForResponse((response) => response.url().endsWith('/api/meeting-minutes-agent/drafts/editor')
      && response.request().method() === 'PATCH' && response.request().postDataJSON().reviewDecisionLabel === 'Review item resolved');
    await warning.getByRole('button', { name: 'Mark checked' }).click();
    await saved;
    assert.equal(await page.locator('#undoToast').isVisible(), true);
    assert.match(await page.textContent('#undoToastMessage'), /Review item resolved/i);
    assert.equal(await page.locator('#undoToastButton').evaluate((node) => getComputedStyle(node).color), 'rgb(255, 255, 255)');
    assert.equal(await page.locator('#undoLastDecision').isVisible(), true);

    await page.reload();
    await page.waitForFunction(() => !document.querySelector('#undoLastDecision').hidden);
    const undone = page.waitForResponse((response) => response.url().endsWith('/api/meeting-minutes-agent/drafts/editor/undo'));
    await page.click('#undoLastDecision');
    await undone;
    const restored = await page.evaluate(async () => (await (await fetch('/test-state/editor')).json()).draft);
    assert.equal(restored.reviewFlags.find((flag) => flag.id === 'flag-action').status, 'open');
    assert.match(await page.textContent('#workflowStatus'), /undone/i);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('review objectives keep every mobile bullet aligned to its first line', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${port}/meeting-minutes-agent?draftId=objective-layout`);
    await page.waitForSelector('.final-objectives li');

    const layout = await page.locator('.final-objectives').evaluate((list) => {
      const listBox = list.getBoundingClientRect();
      const rows = Array.from(list.querySelectorAll('li')).map((row) => {
        const rowBox = row.getBoundingClientRect();
        const textBox = row.firstElementChild.getBoundingClientRect();
        return {
          display: getComputedStyle(row).display,
          marker: getComputedStyle(row, '::before').content,
          textStartsAtTop: Math.abs(textBox.top - rowBox.top) < 2,
          textIsIndented: textBox.left > rowBox.left,
          textUsesWidth: textBox.width > listBox.width * 0.8
        };
      });
      return {
        rows,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
      };
    });
    assert.equal(layout.rows.length, 4);
    assert.ok(layout.rows.every((row) => row.display === 'grid'), JSON.stringify(layout));
    assert.ok(layout.rows.every((row) => row.marker.includes('•')), JSON.stringify(layout));
    assert.ok(layout.rows.every((row) => row.textStartsAtTop && row.textIsIndented && row.textUsesWidth), JSON.stringify(layout));
    assert.ok(layout.pageOverflow <= 1, JSON.stringify(layout));
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('timing labels retain qualification, fallback and boundary wording in Actions and final minutes', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'timing-semantics');
    browser = launched.browser;
    const { page, errors } = launched;
    const actionLabels = await page.locator('#actionsBody [data-edit-timing]').allTextContents();
    assert.match(actionLabels[0], /presumably early next week \(21 Sept 2026\)/);
    assert.match(actionLabels[1], /Preferred: before departure; fallback: by 25 September \(25 Sept 2026\)/);
    assert.match(actionLabels[2], /before 24 September \(24 Sept 2026\)/);
    assert.equal(actionLabels[3], 'Target: after approval');
    await page.click('#previewDocument');
    await page.waitForFunction(() => document.querySelector('[data-screen="5"]').classList.contains('active'));
    const finalLabels = await page.locator('#finalDocument [data-kind="action"][data-field="timing"]').allTextContents();
    assert.deepEqual(finalLabels, actionLabels);
    assert.doesNotMatch(await page.textContent('#finalDocument'), /2 Mar 2026/);
    await page.click('[data-step="3"]');
    await page.waitForFunction(() => document.querySelector('[data-screen="3"]').classList.contains('active'));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click('#actionsBody [data-action-row="0"] [data-edit-timing]');
    const layout = await page.locator('#actionsBody [data-action-row="0"] .timing-editor').evaluate((editor) => {
      const wording = editor.querySelector('[data-timing-wording]');
      const date = editor.querySelector('[data-timing-date]');
      const label = wording.previousElementSibling;
      return {
        wordingWidth: wording.getBoundingClientRect().width,
        editorWidth: editor.getBoundingClientRect().width,
        dateBelowWording: date.getBoundingClientRect().top > wording.getBoundingClientRect().bottom,
        labelVisible: getComputedStyle(label).display !== 'none',
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
      };
    });
    assert.ok(layout.wordingWidth >= layout.editorWidth - 2, JSON.stringify(layout));
    assert.ok(layout.dateBelowWording && layout.labelVisible, JSON.stringify(layout));
    assert.ok(layout.overflow <= 1, JSON.stringify(layout));
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Actions timing editors preserve unchanged decisions and save explicit reviewer wording without deriving a date', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'timing-semantics');
    browser = launched.browser;
    const { page, errors } = launched;
    const saveResponse = () => page.waitForResponse((response) => response.url().endsWith('/api/meeting-minutes-agent/drafts/timing-semantics')
      && response.request().method() === 'PATCH');
    const qualified = '#actionsBody [data-action-row="0"]';
    await page.click(`${qualified} [data-edit-timing]`);
    assert.equal(await page.locator(`${qualified} [data-timing-wording]`).isVisible(), true);
    assert.equal(await page.locator(`${qualified} [data-timing-wording]`).inputValue(), 'presumably early next week');
    let saved = saveResponse();
    await page.click(`${qualified} [data-finish-timing-edit]`);
    await saved;
    await page.waitForFunction(() => document.getElementById('saveStatus')?.dataset.state === 'saved');
    let stored = await page.evaluate(async () => (await (await fetch('/test-state/timing-semantics')).json()).draft);
    assert.deepEqual(stored.actions[0].timingDecision, { status: 'qualified', version: 1 });
    assert.equal(stored.actions[0].reviewerAuthored, undefined);

    // A native date input is blank for an impossible historical date. Merely
    // opening it must not silently turn that historic value into a manual edit.
    const invalid = '#actionsBody [data-action-row="3"]';
    await page.click(`${invalid} [data-edit-timing]`);
    assert.equal(await page.locator(`${invalid} [data-timing-date]`).inputValue(), '');
    saved = saveResponse();
    await page.click(`${invalid} [data-finish-timing-edit]`);
    await saved;
    await page.waitForFunction(() => document.getElementById('saveStatus')?.dataset.state === 'saved');
    stored = await page.evaluate(async () => (await (await fetch('/test-state/timing-semantics')).json()).draft);
    assert.equal(stored.actions[3].timing.exactDate, '2026-02-30');
    assert.deepEqual(stored.actions[3].timingDecision, { status: 'invalid_calendar', version: 1 });

    await page.click(`${qualified} [data-edit-timing]`);
    saved = saveResponse();
    await page.fill(`${qualified} [data-timing-wording]`, 'Preferred: before dispatch; otherwise after approval');
    await page.fill(`${qualified} [data-timing-date]`, '');
    await page.click(`${qualified} [data-finish-timing-edit]`);
    await saved;
    await page.waitForFunction(() => document.getElementById('saveStatus')?.dataset.state === 'saved');
    stored = await page.evaluate(async () => (await (await fetch('/test-state/timing-semantics')).json()).draft);
    assert.deepEqual(stored.actions[0].timing, { kind: 'target', wording: 'Preferred: before dispatch; otherwise after approval', exactDate: '' });
    assert.equal(stored.actions[0].reviewerAuthored, true);
    assert.equal(stored.actions[0].timingDecision, undefined);
    await page.reload();
    await page.waitForSelector('#actionsBody [data-edit-timing]');
    assert.match(await page.locator(`${qualified} [data-edit-timing]`).textContent(), /Preferred: before dispatch; otherwise after approval/);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('final timing edits retain preferred and fallback semantics and clear only an edited timing decision', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'timing-semantics');
    browser = launched.browser;
    const { page, errors } = launched;
    await page.click('#previewDocument');
    await page.waitForSelector('#finalDocument [data-kind="action"][data-field="timing"]');
    await page.locator('#finalDocument [data-kind="action"][data-field="timing"]').first().click();
    await page.fill('#finalDocument [data-final-timing-wording]', 'Preferably before 24 September; fallback after approval');
    await page.fill('#finalDocument [data-final-timing-date]', '2026-09-24');
    const saved = page.waitForResponse((response) => response.url().endsWith('/api/meeting-minutes-agent/drafts/timing-semantics')
      && response.request().method() === 'PATCH');
    await page.click('#finalDocument [data-final-save]');
    await saved;
    await page.waitForFunction(() => document.getElementById('saveStatus')?.dataset.state === 'saved');
    const stored = await page.evaluate(async () => (await (await fetch('/test-state/timing-semantics')).json()).draft);
    assert.deepEqual(stored.actions[0].timing, { kind: 'target', wording: 'Preferably before 24 September; fallback after approval', exactDate: '2026-09-24' });
    assert.equal(stored.actions[0].reviewerAuthored, true);
    assert.equal(stored.actions[0].timingDecision, undefined);
    assert.deepEqual(stored.actions[3].timingDecision, { status: 'invalid_calendar', version: 1 });
    await page.waitForFunction(() => document.getElementById('saveStatus')?.dataset.state === 'saved');
    assert.match(await page.locator('#finalDocument [data-kind="action"][data-field="timing"]').first().textContent(), /Preferably before 24 September; fallback after approval \(24 Sept 2026\)/);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('final minutes edit source records in place and the finishing bar remains available', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'layout');
    browser = launched.browser;
    const { page, errors } = launched;
    assert.equal(await page.locator('#saveStrip').evaluate((node) => getComputedStyle(node).position), 'fixed');
    assert.match(await page.textContent('#flagCount'), /2 checks/i);
    await page.click('#previewDocument');
    await page.waitForFunction(() => document.querySelector('[data-screen="5"]').classList.contains('active'));
    assert.match(await page.getAttribute('#previewDocument', 'aria-label'), /Back to editing/i);
    assert.equal(await page.locator('#finalDocument [data-kind="details"][data-field="meetingDate"]').textContent(), '16 Sept 2026');
    assert.equal(await page.locator('#finalDocument .final-propositions').first().evaluate((node) => getComputedStyle(node).listStyleType), 'disc');
    assert.equal(await page.locator('#finalDocument .final-kind-label').filter({ hasText: 'Discussion' }).count(), 0);

    await page.locator('#finalDocument [data-kind="discussion"][data-field="text"]').first().click();
    const discussionEditorLayout = await page.locator('#finalDocument .final-proposition-content.is-editing').evaluate((node) => ({
      contentWidth: node.getBoundingClientRect().width,
      editorWidth: node.querySelector('[data-final-editor]').getBoundingClientRect().width,
      // The textarea is sized to its text rather than a fixed number of rows.
      fits: node.querySelector('textarea').scrollHeight <= node.querySelector('textarea').clientHeight + 2
    }));
    assert.ok(discussionEditorLayout.editorWidth >= discussionEditorLayout.contentWidth * 0.95, JSON.stringify(discussionEditorLayout));
    assert.equal(discussionEditorLayout.fits, true);
    await page.fill('#finalDocument [data-final-editor-value]', 'The final report is ready to circulate.');
    let saved = page.waitForResponse((response) => response.url().endsWith('/api/meeting-minutes-agent/drafts/layout')
      && response.request().method() === 'PATCH' && response.request().postDataJSON().reviewDecisionLabel === 'Meeting sentence edited');
    await page.click('#finalDocument [data-final-save]');
    await saved;
    // Playwright sees the network response before the page's promise handler
    // has adopted and re-rendered it. Wait for that client-side commit before
    // starting another final-document edit, otherwise the next save can read
    // the previous rendered value on a busy test host.
    await page.waitForFunction(() => document.getElementById('saveStatus')?.dataset.state === 'saved'
      && /The final report is ready to circulate/i.test(document.getElementById('finalDocument')?.textContent || ''),
    null, { timeout: 60000 });

    await page.locator('#finalDocument [data-kind="action"][data-field="action"]').first().click();
    const actionEditor = page.locator('#finalDocument tr.final-editor-row [data-final-editor]');
    assert.equal(await actionEditor.getAttribute('aria-label'), 'Edit action wording');
    assert.doesNotMatch(await actionEditor.textContent(), /Editing the wording of/i);
    assert.equal(await page.locator('#finalDocument .final-editor-title').count(), 0);
    await actionEditor.locator('[data-final-cancel]').click();

    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator('#undoLastDecision .narrow-label').textContent(), 'Undo');
    const finalBarLayout = await page.evaluate(() => {
      const review = document.getElementById('reviewQueueToggle').getBoundingClientRect();
      const undo = document.getElementById('undoLastDecision').getBoundingClientRect();
      const actions = document.querySelector('.save-strip-actions').getBoundingClientRect();
      return {
        sameRow: Math.abs((review.top + review.height / 2) - (undo.top + undo.height / 2)) < 3,
        unusedWidth: actions.width - undo.width
      };
    });
    assert.equal(finalBarLayout.sameRow, true, JSON.stringify(finalBarLayout));
    assert.ok(finalBarLayout.unusedWidth < 4, JSON.stringify(finalBarLayout));

    await page.locator('#finalDocument [data-kind="action"][data-field="owners"]').first().click();
    assert.deepEqual(await page.locator('#finalDocument [data-final-add-owner] option').allTextContents(), [
      'Choose a participant...', 'All participants', 'Sam Okoro'
    ]);
    assert.equal(await page.locator('#finalDocument [data-final-editor-value]').count(), 0, 'owners are selected rather than typed as comma-separated text');
    await page.selectOption('#finalDocument [data-final-add-owner]', '__all');
    assert.deepEqual(await page.locator('#finalDocument .final-owner-picker .owner-chip').allTextContents(), ['Alex Reed×', 'Sam Okoro×']);
    const ownerPickerLayout = await page.locator('#finalDocument .final-owner-picker').evaluate((node) => ({
      pickerWidth: node.getBoundingClientRect().width,
      selectWidth: node.querySelector('select').getBoundingClientRect().width,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    }));
    assert.ok(ownerPickerLayout.selectWidth <= ownerPickerLayout.pickerWidth + 1, JSON.stringify(ownerPickerLayout));
    assert.ok(ownerPickerLayout.pageOverflow <= 1, JSON.stringify(ownerPickerLayout));
    saved = page.waitForResponse((response) => response.url().endsWith('/api/meeting-minutes-agent/drafts/layout')
      && response.request().method() === 'PATCH' && response.request().postDataJSON().reviewDecisionLabel === 'Action owners edited');
    await page.click('#finalDocument [data-final-save]');
    await saved;
    await page.waitForFunction(() => document.getElementById('saveStatus')?.dataset.state === 'saved'
      && /Alex Reed, Sam Okoro/i.test(document.getElementById('finalDocument')?.textContent || ''),
    null, { timeout: 60000 });

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.locator('#finalDocument [data-kind="action"][data-field="timing"]').first().click();
    // The editor is a row of its own under the action, wide enough to type in,
    // not squeezed into the Timing cell.
    assert.equal(await page.locator('#finalDocument tr.final-editor-row td[colspan="3"] [data-final-editor]').count(), 1);
    assert.ok((await page.locator('#finalDocument [data-final-timing-wording]').evaluate((node) => node.getBoundingClientRect().width)) >= 200, 'the As said field is wide enough to read');
    assert.equal(await page.locator('#finalDocument .final-editing-cell [data-field="timing"]').count(), 1, 'the cell being edited stays highlighted');
    await page.selectOption('#finalDocument [data-final-timing-kind]', 'deadline');
    await page.fill('#finalDocument [data-final-timing-wording]', 'by Friday');
    await page.fill('#finalDocument [data-final-timing-date]', '2026-09-18');
    saved = page.waitForResponse((response) => response.url().endsWith('/api/meeting-minutes-agent/drafts/layout')
      && response.request().method() === 'PATCH' && response.request().postDataJSON().reviewDecisionLabel === 'Action timing edited');
    await page.click('#finalDocument [data-final-save]');
    await saved;
    await page.waitForFunction(() => document.getElementById('saveStatus')?.dataset.state === 'saved'
      && /18 Sept 2026/i.test(document.getElementById('finalDocument')?.textContent || ''),
    null, { timeout: 60000 });

    let stored = await page.evaluate(async () => (await (await fetch('/test-state/layout')).json()).draft);
    assert.equal(stored.discussion[0].points[0].text, 'The final report is ready to circulate.');
    assert.deepEqual(stored.actions[0].owners, ['Alex Reed', 'Sam Okoro']);
    assert.deepEqual(stored.actions[0].timing, { kind: 'deadline', wording: 'by Friday', exactDate: '2026-09-18' });

    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-screen="5"]').classList.contains('active'));
    assert.match(await page.textContent('#finalDocument'), /The final report is ready to circulate/i);
    assert.match(await page.textContent('#finalDocument'), /Alex Reed, Sam Okoro/i);
    assert.match(await page.textContent('#finalDocument'), /18 Sept 2026/i);
    const undone = page.waitForResponse((response) => response.url().endsWith('/api/meeting-minutes-agent/drafts/layout/undo'));
    await page.click('#undoLastDecision');
    await undone;
    stored = await page.evaluate(async () => (await (await fetch('/test-state/layout')).json()).draft);
    assert.equal(stored.actions[0].timing.kind, 'not_stated');
    assert.deepEqual(stored.actions[0].owners, ['Alex Reed', 'Sam Okoro'], 'Undo restores only the latest review decision');

    await page.click('.final-actions [data-back="4"]');
    await page.waitForFunction(() => document.querySelector('[data-screen="4"]').classList.contains('active'));

    await page.click('#openFinalReview');
    const completed = page.waitForResponse((response) => response.url().endsWith('/api/meeting-minutes-agent/drafts/layout')
      && response.request().method() === 'PATCH' && response.request().postDataJSON().status === 'complete');
    await page.click('#saveMinutes');
    await completed;
    assert.equal(await page.locator('#finalSaveConfirmation').isVisible(), true, 'the green completion message remains visible');
    assert.equal(await page.locator('.final-actions').isVisible(), true, 'Back and Export remain available');
    assert.equal(await page.locator('#saveStrip').isHidden(), true, 'the redundant sticky status strip leaves once the minutes are final');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('save and generation panels always show the same leave-safety state', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'editor');
    browser = launched.browser;
    const { page, errors } = launched;
    await page.click('[data-step="2"]');
    await page.click('#addDiscussion');
    await page.click('#discussionList .discussion-card:nth-child(2) .topic-menu>summary');
    await page.evaluate(() => document.querySelector('[data-delete-topic="1"]')?.click());
    const messages = await page.evaluate(() => ({
      save: document.getElementById('saveStatus').textContent,
      generation: document.getElementById('generationLeaveMessage')
    }));
    // The status stays short; leaving with unsaved work is the browser's
    // leave warning's job.
    assert.doesNotMatch(messages.save, /Keep this tab open/i);
    // One message, in one place: there is nothing left that could disagree.
    assert.equal(messages.generation, null);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('dense layouts give writing space to content rather than repeated controls', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'layout');
    browser = launched.browser;
    const { page, errors } = launched;
    const objectiveLayout = await page.evaluate(() => {
      const list = document.getElementById('objectivesList').getBoundingClientRect();
      const editor = document.querySelector('[data-objective-index]').getBoundingClientRect();
      const remove = document.querySelector('[data-remove-objective]').closest('details').querySelector('summary');
      const removeRect = remove.getBoundingClientRect();
      return {
        listWidth: list.width,
        editorWidth: editor.width,
        editorHeight: editor.height,
        removeText: remove.textContent.trim(),
        removeLabel: remove.getAttribute('aria-label'),
        removeWidth: removeRect.width,
        removeHeight: removeRect.height
      };
    });
    assert.ok(objectiveLayout.editorWidth > objectiveLayout.listWidth * 0.8, JSON.stringify(objectiveLayout));
    assert.ok(objectiveLayout.editorHeight < 80, JSON.stringify(objectiveLayout));
    // Removal sits in the objective's own "…" menu rather than a red trash icon.
    assert.equal(objectiveLayout.removeText, '•••');
    assert.match(objectiveLayout.removeLabel, /Objective 1 options/i);
    assert.ok(objectiveLayout.removeWidth >= 32 && objectiveLayout.removeHeight >= 32, JSON.stringify(objectiveLayout));

    await page.click('[data-step="3"]');
    const actionLayout = await page.evaluate(() => {
      const headers = Array.from(document.querySelectorAll('.editable-actions-table th')).map((node) => node.getBoundingClientRect().width);
      const row = document.querySelector('[data-action-row="0"]');
      return {
        headers,
        timingType: row.querySelector('[data-timing-kind]') && row.querySelector('[data-timing-kind]').value,
        directOwnerControl: Boolean(row.querySelector('[data-edit-owners]')),
        directTimingControl: Boolean(row.querySelector('[data-edit-timing]'))
      };
    });
    assert.ok(actionLayout.headers[0] > actionLayout.headers[1] * 3, JSON.stringify(actionLayout));
    assert.equal(actionLayout.headers.length, 3, JSON.stringify(actionLayout));
    assert.equal(actionLayout.timingType, null);
    assert.equal(actionLayout.directOwnerControl, true);
    assert.equal(actionLayout.directTimingControl, true);
    assert.equal(await page.locator('[data-screen="3"] .toolbar .agent-edit-inline').count(), 1);
    await page.click('[data-screen="3"] .agent-edit-inline>summary');
    assert.equal(await page.locator('[data-screen="3"] .agent-edit-body').isVisible(), true);
    await page.click('[data-screen="3"] .agent-edit-inline>summary');

    await page.click('[data-step="2"]');
    assert.equal(await page.locator('.discussion-card .card-head .record-add-menu').count(), 0, 'the header no longer carries an add menu');
    assert.equal(await page.locator('.discussion-card .discussion-card-body .record-add-point').count(), await page.locator('.discussion-card').count());
    const propHeight = await page.locator('.proposition-row').first().evaluate((node) => node.getBoundingClientRect().height);
    // The reorder handle floats in the gutter precisely so it does not push
    // this back over the line.
    assert.ok(propHeight < 60, 'proposition row height ' + propHeight);
    assert.ok(await page.locator('.review-flags-summary').evaluate((node) => node.getBoundingClientRect().width < 260));
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('phone save bar gives history and document actions their own responsive row', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${port}/meeting-minutes-agent?draftId=mobile-save-bar`);
    await page.waitForSelector('#undoLastDecision:not([hidden])');

    assert.equal(await page.locator('#undoLastDecision .narrow-label').textContent(), 'Undo last change');
    assert.equal(await page.locator('#undoLastDecision').getAttribute('aria-label'), 'Undo: Edit a long discussion item');
    const layout = await page.evaluate(() => {
      const box = (selector) => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
      };
      const bar = box('#saveStrip');
      const buttons = Array.from(document.querySelectorAll('.save-strip-actions>button:not([hidden])')).map((node) => {
        const rect = node.getBoundingClientRect();
        return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
      });
      return {
        bar,
        status: box('#saveStatus'),
        review: box('#reviewQueueToggle'),
        actions: box('.save-strip-actions'),
        buttons,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
      };
    });
    assert.ok(layout.status.bottom <= layout.review.top, JSON.stringify(layout));
    assert.ok(layout.review.bottom <= layout.actions.top, JSON.stringify(layout));
    assert.ok(layout.buttons.every((button) => button.left >= layout.bar.left && button.right <= layout.bar.right), JSON.stringify(layout));
    assert.ok(layout.buttons.every((button) => Math.abs(button.top - layout.buttons[0].top) < 2), JSON.stringify(layout));
    assert.ok(layout.pageOverflow <= 1, JSON.stringify(layout));
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('topic actions stay inside a narrow phone viewport', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 320, height: 720 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${port}/meeting-minutes-agent?draftId=topic-cleanup`);
    await page.waitForSelector('#actionsBody tr');
    await page.selectOption('#mobileStepSelect', '2');
    await page.click('#discussionList .discussion-card:first-child .topic-menu>summary');

    const layout = await page.evaluate(() => {
      const bounds = (selector) => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      return {
        viewport: window.innerWidth,
        menu: bounds('#discussionList .discussion-card:first-child .topic-menu-popover'),
        select: bounds('#discussionList .discussion-card:first-child [data-merge-topic]'),
        remove: bounds('#discussionList .discussion-card:first-child [data-delete-topic]'),
        toggle: bounds('#discussionList .discussion-card:first-child .topic-menu>summary'),
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
      };
    });
    assert.ok(layout.menu.left >= 8 && layout.menu.right <= layout.viewport - 8, JSON.stringify(layout));
    assert.ok(layout.menu.width >= 240, JSON.stringify(layout));
    assert.ok(layout.select.left >= layout.menu.left && layout.select.right <= layout.menu.right, JSON.stringify(layout));
    assert.ok(layout.remove.left >= layout.menu.left && layout.remove.right <= layout.menu.right, JSON.stringify(layout));
    assert.ok(layout.toggle.width >= 44 && layout.toggle.height >= 44, JSON.stringify(layout));
    assert.ok(layout.pageOverflow <= 1, JSON.stringify(layout));
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('phone layout reaches the work quickly and keeps editing controls compact', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${port}/meeting-minutes-agent?draftId=layout`);
    await page.waitForSelector('#discussionList .discussion-card', { state: 'attached' });

    assert.equal(await page.locator('.hero').isHidden(), true);
    assert.equal(await page.locator('.steps').isHidden(), true);
    assert.equal(await page.locator('.mobile-step-picker').isVisible(), true);
    // Five steps now that Focus is retired: details 1, discussion 2, actions 3,
    // summary 4, review 5. This fixture opens on Summary.
    assert.equal(await page.locator('#mobileStepCount').textContent(), 'Step 4 of 5');
    assert.ok(await page.locator('.nav a').first().evaluate((node) => node.getBoundingClientRect().height >= 40));
    assert.equal(await page.locator('#resumeLaterLink').count(), 0, 'Library is not repeated in the bottom status bar');
    const saveBarLayout = await page.evaluate(() => {
      const rect = (selector) => {
        const box = document.querySelector(selector).getBoundingClientRect();
        return { top: box.top, right: box.right, bottom: box.bottom, left: box.left, height: box.height };
      };
      return {
        bar: rect('#saveStrip'), status: rect('#saveStatus'),
        suggestions: rect('#reviewQueueToggle'), actions: rect('.save-strip-actions')
      };
    });
    assert.ok(saveBarLayout.status.bottom < saveBarLayout.suggestions.top, JSON.stringify(saveBarLayout));
    assert.ok(Math.abs(
      (saveBarLayout.suggestions.top + saveBarLayout.suggestions.bottom) / 2
      - (saveBarLayout.actions.top + saveBarLayout.actions.bottom) / 2
    ) < 4, JSON.stringify(saveBarLayout));
    assert.ok(saveBarLayout.bar.left < saveBarLayout.suggestions.left, JSON.stringify(saveBarLayout));
    assert.ok(saveBarLayout.actions.right < saveBarLayout.bar.right, JSON.stringify(saveBarLayout));
    await page.click('#reviewQueueToggle');
    assert.equal(await page.locator('.review-flags-summary').isHidden(), true, 'the labelled status-bar control replaces the empty native expander');
    assert.ok(await page.locator('.review-flags-body').evaluate((node) => node.getBoundingClientRect().width > 330));
    await page.click('#reviewQueueToggle');
    assert.equal(await page.locator('.review-flags-body').isHidden(), true, 'the queue closes again from the status bar');

    await page.selectOption('#mobileStepSelect', '2');
    const discussionLayout = await page.evaluate(() => {
      const topic = document.querySelector('.topic-field textarea');
      const card = topic.closest('.discussion-card');
      const kind = card.querySelector('.proposition-kind');
      const text = card.querySelector('[data-record-field]');
      const proposition = text.closest('.proposition-row');
      const screen = document.querySelector('[data-screen="2"]');
      const toolbar = screen.querySelector('.toolbar');
      const toolbarStyle = getComputedStyle(toolbar);
      const toolbarBox = toolbar.getBoundingClientRect();
      const actions = screen.querySelector('.screen-toolbar-actions');
      const actionsBox = actions.getBoundingClientRect();
      const regenerate = screen.querySelector('#regenerateDiscussion').getBoundingClientRect();
      const header = card.querySelector('.card-head');
      const collapse = header.querySelector('.topic-collapse').getBoundingClientRect();
      const topicBox = topic.getBoundingClientRect();
      const menu = header.querySelector('.topic-menu>summary').getBoundingClientRect();
      const toolbarButtons = Array.from(actions.children).map((node) => node.getBoundingClientRect());
      return {
        titleVisible: topic.scrollHeight <= topic.clientHeight + 1,
        titleWidth: topic.getBoundingClientRect().width,
        cardWidth: card.getBoundingClientRect().width,
        headerHeight: header.getBoundingClientRect().height,
        collapseBesideTitle: collapse.top < topicBox.bottom && collapse.bottom > topicBox.top,
        // One header row: collapse, title and the topic menu side by side.
        menuBesideTitle: menu.top < topicBox.bottom && menu.bottom > topicBox.top,
        toolbarOneRow: toolbarButtons.every((box) => Math.abs(box.top - toolbarButtons[0].top) < 2),
        kindAboveText: kind.getBoundingClientRect().bottom <= text.getBoundingClientRect().top + 1,
        propositionWidth: proposition.getBoundingClientRect().width,
        propositionTextWidth: text.getBoundingClientRect().width,
        propositionOverflow: proposition.scrollWidth - proposition.clientWidth,
        toolbarContentLeft: toolbarBox.left + parseFloat(toolbarStyle.borderLeftWidth) + parseFloat(toolbarStyle.paddingLeft),
        toolbarContentRight: toolbarBox.right - parseFloat(toolbarStyle.borderRightWidth) - parseFloat(toolbarStyle.paddingRight),
        actionsLeft: actionsBox.left,
        actionsRight: actionsBox.right,
        actionsWidth: actionsBox.width,
        regenerateWidth: regenerate.width,
        screenOverflow: screen.scrollWidth - screen.clientWidth
      };
    });
    assert.equal(discussionLayout.titleVisible, true, JSON.stringify(discussionLayout));
    assert.ok(discussionLayout.titleWidth > discussionLayout.cardWidth * 0.65, JSON.stringify(discussionLayout));
    assert.ok(discussionLayout.headerHeight < 100, JSON.stringify(discussionLayout));
    assert.equal(discussionLayout.collapseBesideTitle, true, JSON.stringify(discussionLayout));
    assert.equal(discussionLayout.menuBesideTitle, true, JSON.stringify(discussionLayout));
    assert.equal(discussionLayout.toolbarOneRow, true, JSON.stringify(discussionLayout));
    assert.equal(discussionLayout.kindAboveText, true, JSON.stringify(discussionLayout));
    assert.ok(discussionLayout.propositionTextWidth > discussionLayout.propositionWidth * 0.8, JSON.stringify(discussionLayout));
    assert.ok(discussionLayout.propositionOverflow <= 1, JSON.stringify(discussionLayout));
    // Fill the usable toolbar, excluding its intentional border and padding.
    assert.ok(Math.abs(discussionLayout.toolbarContentLeft - discussionLayout.actionsLeft) < 2, JSON.stringify(discussionLayout));
    assert.ok(Math.abs(discussionLayout.toolbarContentRight - discussionLayout.actionsRight) < 2, JSON.stringify(discussionLayout));
    assert.ok(discussionLayout.regenerateWidth > discussionLayout.actionsWidth * 0.28, JSON.stringify(discussionLayout));
    assert.ok(discussionLayout.screenOverflow <= 1, JSON.stringify(discussionLayout));

    await page.click('#omittedDetailsPanel>summary');
    const omittedDetailLayout = await page.evaluate(() => {
      const detail = document.querySelector('.omitted-detail');
      const copy = detail.querySelector('.omitted-detail-copy');
      const text = copy.querySelector('p');
      const button = detail.querySelector('[data-promote-supporting]');
      const disclosure = detail.querySelector('.omitted-detail-actions>details');
      const detailBox = detail.getBoundingClientRect();
      const copyBox = copy.getBoundingClientRect();
      const buttonBox = button.getBoundingClientRect();
      const disclosureBox = disclosure.getBoundingClientRect();
      return {
        copyWidth: copyBox.width,
        availableWidth: detailBox.width,
        controlsBelowCopy: buttonBox.top >= copyBox.bottom - 1,
        controlsShareRow: Math.abs(disclosureBox.top - buttonBox.top) < 2 && disclosureBox.left >= buttonBox.right - 1,
        textOverflow: text.scrollWidth - text.clientWidth,
        detailOverflow: detail.scrollWidth - detail.clientWidth
      };
    });
    assert.ok(omittedDetailLayout.copyWidth > omittedDetailLayout.availableWidth * 0.9, JSON.stringify(omittedDetailLayout));
    assert.equal(omittedDetailLayout.controlsBelowCopy, true, JSON.stringify(omittedDetailLayout));
    assert.equal(omittedDetailLayout.controlsShareRow, true, JSON.stringify(omittedDetailLayout));
    assert.ok(omittedDetailLayout.textOverflow <= 1, JSON.stringify(omittedDetailLayout));
    assert.ok(omittedDetailLayout.detailOverflow <= 1, JSON.stringify(omittedDetailLayout));
    await page.click('.omitted-detail-actions .evidence-toggle');
    const omittedTranscriptLayout = await page.locator('.omitted-detail').evaluate((detail) => {
      const disclosure = detail.querySelector('.omitted-detail-actions>details');
      const panel = disclosure.querySelector('.evidence-panel');
      const detailBox = detail.getBoundingClientRect();
      const disclosureBox = disclosure.getBoundingClientRect();
      const panelBox = panel.getBoundingClientRect();
      const screen = document.querySelector('[data-screen="2"]');
      return {
        disclosureUsesRow: disclosureBox.width > detailBox.width * 0.9,
        panelInsideCard: panelBox.left >= detailBox.left - 1 && panelBox.right <= detailBox.right + 1,
        detailOverflow: detail.scrollWidth - detail.clientWidth,
        screenOverflow: screen.scrollWidth - screen.clientWidth
      };
    });
    assert.equal(omittedTranscriptLayout.disclosureUsesRow, true, JSON.stringify(omittedTranscriptLayout));
    assert.equal(omittedTranscriptLayout.panelInsideCard, true, JSON.stringify(omittedTranscriptLayout));
    assert.ok(omittedTranscriptLayout.detailOverflow <= 1, JSON.stringify(omittedTranscriptLayout));
    assert.ok(omittedTranscriptLayout.screenOverflow <= 1, JSON.stringify(omittedTranscriptLayout));

    await page.selectOption('#mobileStepSelect', '3');
    const actionLayout = await page.evaluate(() => {
      const row = document.querySelector('[data-action-row="0"]');
      const owners = row.querySelector('[data-label="Owners"]').getBoundingClientRect();
      const timing = row.querySelector('[data-label="Timing"]').getBoundingClientRect();
      const screen = document.querySelector('[data-screen="3"]');
      const toolbar = screen.querySelector('.toolbar');
      const toolbarStyle = getComputedStyle(toolbar);
      const toolbarBox = toolbar.getBoundingClientRect();
      const actions = screen.querySelector('.screen-toolbar-actions');
      const actionsBox = actions.getBoundingClientRect();
      const regenerate = screen.querySelector('#regenerateActions').getBoundingClientRect();
      return {
        height: row.getBoundingClientRect().height,
        rootFontSize: parseFloat(getComputedStyle(document.documentElement).fontSize),
        actionTextVisible: row.querySelector('[data-action]').scrollHeight <= row.querySelector('[data-action]').clientHeight + 1,
        metaAligned: Math.abs(owners.top - timing.top) < 4,
        toolbarContentLeft: toolbarBox.left + parseFloat(toolbarStyle.borderLeftWidth) + parseFloat(toolbarStyle.paddingLeft),
        toolbarContentRight: toolbarBox.right - parseFloat(toolbarStyle.borderRightWidth) - parseFloat(toolbarStyle.paddingRight),
        actionsLeft: actionsBox.left,
        actionsRight: actionsBox.right,
        actionsWidth: actionsBox.width,
        regenerateWidth: regenerate.width,
        screenOverflow: screen.scrollWidth - screen.clientWidth
      };
    });
    // The owner/timing summaries and Source controls have evolved since the
    // old 180px cap. Keep this short row compact in the page's type scale,
    // without requiring controls or text to be clipped to save a pixel.
    assert.ok(actionLayout.height / actionLayout.rootFontSize < 12, JSON.stringify(actionLayout));
    assert.equal(actionLayout.actionTextVisible, true, JSON.stringify(actionLayout));
    assert.equal(actionLayout.metaAligned, true, JSON.stringify(actionLayout));
    assert.ok(Math.abs(actionLayout.toolbarContentLeft - actionLayout.actionsLeft) < 2, JSON.stringify(actionLayout));
    assert.ok(Math.abs(actionLayout.toolbarContentRight - actionLayout.actionsRight) < 2, JSON.stringify(actionLayout));
    assert.ok(actionLayout.regenerateWidth > actionLayout.actionsWidth * 0.28, JSON.stringify(actionLayout));
    assert.ok(actionLayout.screenOverflow <= 1, JSON.stringify(actionLayout));
    await page.click('#regenerateActions');
    assert.equal(await page.textContent('#regenerationTitle'), 'Regenerate actions?');
    assert.match(await page.textContent('#regenerationMessage'), /current action list stays visible/i);
    assert.match(await page.textContent('#regenerationMessage'), /applied automatically when ready/i);
    assert.equal(await page.textContent('#confirmRegeneration'), 'Regenerate actions');
    await page.locator('#regenerationDialog button[value="cancel"]').click();

    await page.selectOption('#mobileStepSelect', '4');
    assert.match(await page.textContent('#generateSummary'), /Regenerate summary/i);
    assert.ok(await page.locator('#executiveSummary').evaluate((node) => node.getBoundingClientRect().height < 150));
    await page.click('#generateSummary');
    assert.equal(await page.textContent('#regenerationTitle'), 'Regenerate meeting summary?');
    assert.match(await page.textContent('#regenerationMessage'), /new meeting objectives and a new executive summary/i);
    assert.match(await page.textContent('#regenerationMessage'), /new version will replace it/i);
    assert.equal(await page.textContent('#confirmRegeneration'), 'Regenerate summary');
    await page.locator('#regenerationDialog button[value="cancel"]').click();

    await page.selectOption('#mobileStepSelect', '5');
    assert.equal(await page.locator('.final-actions>.secondary, .final-actions>.button, .final-actions>.export-menu').count(), 3);
    assert.equal(await page.locator('#previewDocument').isHidden(), true, 'the final review does not repeat its Back action in the fixed bar');
    assert.equal(await page.locator('#downloadDraft').isHidden(), true, 'the final review uses its full export menu instead of a duplicate download');
    const compactFinalBar = await page.locator('#saveStrip').evaluate((bar) => {
      const box = bar.getBoundingClientRect();
      return {
        width: box.width,
        centreOffset: Math.abs((box.left + box.width / 2) - window.innerWidth / 2),
        actionsHidden: getComputedStyle(bar.querySelector('.save-strip-actions')).display === 'none'
      };
    });
    assert.ok(compactFinalBar.width < 320, JSON.stringify(compactFinalBar));
    assert.ok(compactFinalBar.centreOffset < 2, JSON.stringify(compactFinalBar));
    assert.equal(compactFinalBar.actionsHidden, true, JSON.stringify(compactFinalBar));
    assert.equal(await page.locator('#newMinutes').isHidden(), true, 'a new meeting is offered only after these minutes are final');
    assert.equal(await page.locator('.export-menu-body').isHidden(), true);
    await page.click('.export-menu>summary');
    assert.equal(await page.locator('.export-menu-body').isVisible(), true);
    assert.match(await page.textContent('#saveMinutes'), /Save final minutes/i);
    const finalSave = page.waitForResponse((response) => response.request().method() === 'PATCH'
      && response.url().endsWith('/api/meeting-minutes-agent/drafts/layout')
      && response.request().postDataJSON().status === 'complete');
    await page.click('#saveMinutes');
    const finalSaveResponse = await finalSave;
    assert.equal(finalSaveResponse.request().postDataJSON().status, 'complete');
    assert.equal(await page.locator('#finalSaveConfirmation').isVisible(), true);
    assert.match(await page.textContent('#finalSaveConfirmation'), /marked Complete in Library/i);
    assert.equal(await page.locator('#saveMinutes').isHidden(), true);
    assert.equal(await page.locator('#newMinutes').isVisible(), true);
    assert.equal(await page.evaluate(async () => (await (await fetch('/test-state/layout')).json()).draft.status), 'complete');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('step navigation wins over an in-flight autosave scroll restore', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${port}/meeting-minutes-agent?draftId=navigation`);
    await page.waitForSelector('[data-screen="3"].active [data-action-row]');

    const saveRequest = page.waitForRequest((request) => request.method() === 'PATCH' && request.url().endsWith('/drafts/navigation'));
    const saveResponse = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().endsWith('/drafts/navigation'));
    await page.fill('[data-action-row="0"] [data-action]', 'Complete the first preparation task and circulate the confirmed outcome.');
    await saveRequest;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.click('[data-screen="3"] [data-back="2"]');
    await saveResponse;
    await page.waitForFunction(() => document.querySelector('[data-screen="2"]').classList.contains('active'));
    await page.waitForTimeout(100);

    const position = await page.evaluate(() => {
      const screen = document.querySelector('[data-screen="2"]');
      return {
        top: Math.round(screen.getBoundingClientRect().top),
        scrollY: Math.round(window.scrollY),
        maxScroll: Math.round(document.documentElement.scrollHeight - window.innerHeight),
        activeTag: document.activeElement.tagName
      };
    });
    assert.ok(position.top <= 16 || Math.abs(position.scrollY - position.maxScroll) <= 2, JSON.stringify(position));
    // Headings never take focus; on a phone it lands on the step picker.
    assert.equal(position.activeTag, 'SELECT', JSON.stringify(position));
    assert.equal(await page.evaluate(() => document.activeElement.id), 'mobileStepSelect');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

// The server finishes stages the reviewer has not reached and writes them into
// the draft, so the work survives a closed tab. That advances the revision
// under an open tab. These cover what the tab does about it: absorb the
// background write silently, and still hand a real conflict to the reviewer.

async function launchOnDiscussion(port, draftId) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${port}/meeting-minutes-agent?draftId=${draftId}`);
  await page.waitForFunction(() => document.querySelector('#discussionList [data-record-field]'));
  return { browser, page, errors };
}

test('a completed zero-action review is explicit and remains reachable', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'completed-empty-actions');
    browser = launched.browser;
    const { page, errors } = launched;
    await page.setViewportSize({ width: 390, height: 844 });
    assert.match(await page.textContent('#actionsBody'), /No confirmed actions were identified in this meeting\./);
    const emptyLayout = await page.locator('#actionsBody .empty-actions-row').evaluate((row) => {
      const cell = row.querySelector('td');
      const rowBox = row.getBoundingClientRect();
      const cellBox = cell.getBoundingClientRect();
      return { rowWidth: rowBox.width, cellWidth: cellBox.width, rowHeight: rowBox.height };
    });
    assert.ok(emptyLayout.cellWidth >= emptyLayout.rowWidth * 0.9, JSON.stringify(emptyLayout));
    assert.ok(emptyLayout.rowHeight < 100, JSON.stringify(emptyLayout));
    assert.equal(await page.locator('[data-step="3"]').isDisabled(), false);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a stage finished in the background is absorbed instead of warning the reviewer', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchOnDiscussion(port, 'background-conflict');
    browser = launched.browser;
    const { page, errors } = launched;

    // The background stage lands while the reviewer is reading Discussion. This
    // draft never polls, so the tab is a revision behind and does not know it.
    await page.evaluate(() => fetch('/test-fill/background-conflict', { method: 'POST' }));

    await page.fill('#discussionList [data-record-field]', 'The revised report is ready for circulation today.');
    await page.waitForFunction(async () => {
      const draft = (await (await fetch('/test-state/background-conflict')).json()).draft;
      return /circulation today/.test(draft.discussion[0].points[0].text || '');
    });

    const saved = await page.evaluate(async () => (await (await fetch('/test-state/background-conflict')).json()).draft);
    // The background actions were not wiped by a tab that thought the stage was
    // still empty.
    assert.equal(saved.actions.length, 1);
    assert.equal(saved.actions[0].action, 'Circulate the checked report.');
    assert.equal(await page.locator('#reloadDraft').isHidden(), true, 'no reload banner for work the reviewer never made');
    assert.doesNotMatch(await page.textContent('#saveStatus'), /Changed elsewhere/i);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('background work already written into the draft appears without being asked for', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchOnDiscussion(port, 'background-poll');
    browser = launched.browser;
    const { page, errors } = launched;

    // Nothing is typed, so the poll can take the newer revision and show the
    // stage it carries.
    await page.waitForFunction(() => document.querySelectorAll('#actionsBody [data-action-row]').length === 1);
    assert.match(await page.textContent('#actionsBody'), /Circulate the checked report/);

    // Having taken the revision as well as the content, the next save goes
    // through first time rather than conflicting and retrying.
    const conflicts = [];
    page.on('response', (response) => { if (response.status() === 409) conflicts.push(response.url()); });
    await page.fill('#discussionList [data-record-field]', 'The revised report is ready for circulation today.');
    await page.waitForFunction(async () => (await (await fetch('/test-state/background-poll')).json()).patches >= 1);
    assert.deepEqual(conflicts, [], 'the tab was already level with the revision it adopted');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a background run that found nothing is adopted like any other, not left as a conflict', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchOnDiscussion(port, 'background-empty');
    browser = launched.browser;
    const { page, errors } = launched;

    // The server writes the empty Actions result at a newer revision. The tab
    // must take that revision: nothing is on screen to lose, and "no actions"
    // is the finished result, not the absence of one.
    await page.waitForResponse(async (response) => {
      if (!response.url().endsWith('/drafts/background-empty/generation')) return false;
      const body = await response.json().catch(() => null);
      return Boolean(body && body.draft && body.draft.generatedStages);
    });
    // The poll handler adopts the revision once the body is parsed.
    await page.waitForTimeout(400);
    const conflicts = [];
    page.on('response', (response) => { if (response.status() === 409) conflicts.push(response.url()); });
    await page.fill('#discussionList [data-record-field]', 'The revised report is ready for circulation today.');
    await page.waitForFunction(async () => (await (await fetch('/test-state/background-empty')).json()).patches >= 1);
    assert.deepEqual(conflicts, [], 'the tab was level with the empty run it adopted');
    assert.equal(await page.locator('#reloadDraft').isHidden(), true, 'no reload banner for a run that found nothing');
    assert.doesNotMatch(await page.textContent('#saveStatus'), /Changed elsewhere/i);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('an edit made elsewhere is still handed to the reviewer rather than merged', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchOnDiscussion(port, 'background-conflict');
    browser = launched.browser;
    const { page, errors } = launched;

    // Not background work: another writer changed a topic this tab already has
    // content in. Merging that silently is what loses people's work.
    await page.evaluate(() => fetch('/test-elsewhere/background-conflict', { method: 'POST' }));

    await page.fill('#discussionList [data-record-field]', 'The revised report is ready for circulation today.');
    await page.waitForFunction(() => /Changed elsewhere/i.test(document.getElementById('saveStatus').textContent));
    assert.equal(await page.locator('#reloadDraft').isHidden(), false, 'the reviewer is offered the saved version');
    // Their typing stays on screen: the warning must not cost them the edit.
    assert.match(await page.inputValue('#discussionList [data-record-field]'), /circulation today/);
    // The rejected save surfaces as an unhandled rejection, as it did before
    // this path existed. Named rather than ignored, so a new one would show up.
    assert.deepEqual(errors, ['Error: This draft was updated elsewhere. Reload it before saving again.']);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

// Stages are finished in the background before the reviewer reaches them, so
// the forward button on a screen usually has nothing left to generate. It
// should take them to the work, not ask whether to redo it.

test('the forward button moves to a stage that is already there rather than offering to redo it', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'editor');
    browser = launched.browser;
    const { page, errors } = launched;

    const generateRequests = [];
    page.on('request', (request) => {
      if (request.url().includes('/generate-background')) generateRequests.push(request.url());
    });

    await page.click('[data-step="0"]');
    // This fixture already has a discussion, so the button says so.
    assert.equal(await page.textContent('#startDiscussion [data-stage-advance-label]'), 'Continue to Discussion');
    await page.click('#startDiscussion');

    await page.waitForFunction(() => document.querySelector('[data-screen="2"]').classList.contains('active'));
    assert.equal(await page.locator('#regenerationDialog').isVisible(), false, 'no question to answer');
    assert.deepEqual(generateRequests, [], 'and nothing regenerated behind it');

    // Same rule one screen along.
    assert.equal(await page.textContent('#generateActions [data-stage-advance-label]'), 'Continue to Actions');
    await page.click('#generateActions');
    await page.waitForFunction(() => document.querySelector('[data-screen="3"]').classList.contains('active'));
    assert.equal(await page.locator('#regenerationDialog').isVisible(), false);
    assert.deepEqual(generateRequests, []);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the forward button still generates, and says so, when the stage is empty', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchOnDiscussion(port, 'background-conflict');
    browser = launched.browser;
    const { page, errors } = launched;

    // This fixture's Actions stage has not run.
    assert.equal(await page.textContent('#generateActions [data-stage-advance-label]'), 'Generate actions');
    const generated = page.waitForRequest((request) => request.url().includes('/generate-background'));
    await page.click('#generateActions');
    await generated;
    assert.equal(await page.locator('#regenerationDialog').isVisible(), false, 'nothing to overwrite, so nothing to ask');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('redoing an out-of-date stage still asks first, and still keeps the reviewer in place', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchOnDiscussion(port, 'stale-actions');
    browser = launched.browser;
    const { page, errors } = launched;

    // The forward button takes them to the actions, out of date or not - the
    // notice on that screen is where the offer to redo them lives.
    await page.click('#generateActions');
    await page.waitForFunction(() => document.querySelector('[data-screen="3"]').classList.contains('active'));
    assert.equal(await page.locator('#regenerationDialog').isVisible(), false);

    const started = page.waitForResponse((response) =>
      response.url().endsWith('/api/meeting-minutes-agent/drafts/stale-actions/generate-background'));
    // The offer to redo them sits under the Actions heading.
    await page.click('[data-stale-slot="actions"] [data-update-stale-stage="actions"]');
    // Asking before replacing work the reviewer may have edited is the point of
    // the dialog, and it is still asked on the path that means "redo this".
    assert.equal(await page.locator('#regenerationDialog').isVisible(), true);
    assert.equal(await page.textContent('#regenerationTitle'), 'Regenerate actions?');
    assert.equal(await page.textContent('#confirmRegeneration'), 'Regenerate actions');
    await page.click('#confirmRegeneration');
    const response = await started;
    assert.equal(response.request().postDataJSON().selectedStep, 3);
    assert.equal(await page.locator('[data-screen="3"]').evaluate((node) => node.classList.contains('active')), true,
      'regenerating keeps them on the screen they were reading');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

// Roughly half of all generated topics hold a single line. Nothing here tries
// to guess which of them belong together - transcript position does not
// separate topics, so any automatic merge would be inference dressed as
// structure. The reviewer decides; these make deciding cheap.

test('a topic can be merged into another in one action, and the rows all come with it', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'topic-cleanup');
    browser = launched.browser;
    const { page, errors } = launched;
    await page.click('[data-step="2"]');

    assert.equal(await page.locator('#discussionList .discussion-card').count(), 2);
    // Both hold one line, so both are drawn as the single lines they are.
    assert.equal(await page.locator('#discussionList .discussion-card.is-single').count(), 2);
    const singleTopicStyle = await page.locator('#discussionList .discussion-card.is-single').first().evaluate((card) => ({
      background: getComputedStyle(card.querySelector('.card-head')).backgroundColor,
      title: getComputedStyle(card.querySelector('.topic-field textarea')).color
    }));
    assert.deepEqual(singleTopicStyle, { background: 'rgb(238, 250, 249)', title: 'rgb(1, 23, 59)' },
      'single-item topics use the same header treatment as every other topic');

    await page.click('#discussionList .discussion-card >> nth=0 >> .topic-menu > summary');
    await page.selectOption('#discussionList [data-merge-topic="0"]', '1');

    await page.waitForFunction(() => document.querySelectorAll('#discussionList .discussion-card').length === 1);
    const card = page.locator('#discussionList .discussion-card');
    assert.equal(await card.locator('[data-record-field]').count(), 2, 'both lines survived the merge');
    // Two lines is no longer a single line.
    assert.equal(await page.locator('#discussionList .discussion-card.is-single').count(), 0);

    await page.waitForFunction(async () => {
      const draft = (await (await fetch('/test-state/topic-cleanup')).json()).draft;
      return draft.discussion.length === 1;
    });
    const saved = await page.evaluate(async () => (await (await fetch('/test-state/topic-cleanup')).json()).draft);
    const kept = saved.discussion[0];
    const texts = [...(kept.points || []), ...(kept.decisions || []), ...(kept.openQuestions || [])].map((r) => r.text);
    assert.equal(texts.length, 2, JSON.stringify(texts));
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('merging is offered only when there is somewhere to merge to', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'editor');
    browser = launched.browser;
    const { page, errors } = launched;
    await page.click('[data-step="2"]');
    // This fixture has one topic, so the control would have nothing to offer.
    assert.equal(await page.locator('#discussionList .discussion-card').count(), 1);
    assert.equal(await page.locator('#discussionList [data-merge-topic]').count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('an action row has one set of controls, not a menu repeating them', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'editor');
    browser = launched.browser;
    const { page, errors } = launched;
    // Source, review and removal share one "…" menu, with removal last and red.
    const row = page.locator('#actionsBody [data-action-row]').first();
    assert.equal(await row.locator('.row-menu').count(), 1);
    assert.equal(await row.locator('use[href="#i-trash"]').count(), 0, 'no red trash icon in the row');
    const items = await row.locator('.row-menu [data-menu-popover] > button').evaluateAll((nodes) => nodes.map((node) => node.textContent.trim()));
    assert.deepEqual(items, ['View source', 'Mark reviewed', 'Remove action']);
    assert.equal(await row.locator('.row-menu summary').getAttribute('title'), 'Action 1 options');
    const controlsWidth = await row.locator('.row-decisions').evaluate((node) => Array.from(node.children)
      .reduce((total, child) => total + child.getBoundingClientRect().width, 0));
    assert.ok(controlsWidth < 190, 'secondary action controls stay compact: ' + controlsWidth);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a fresh upload is confirmed, explains the next screens, and points at the Library', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 320, height: 720 } });
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${port}/meeting-minutes-agent`);
    assert.equal(await page.locator('#meetingLocation').inputValue(), 'Microsoft Teams', 'Teams is a real default value, not placeholder text');
    assert.equal(await page.locator('#meetingLocation').getAttribute('placeholder'), null);
    assert.equal(await page.locator('#uploadConfirmation').isHidden(), true, 'nothing to confirm before an upload');
    const preparedResponse = page.waitForResponse((response) => response.url().endsWith('/api/meeting-minutes-agent/prepare'));
    const longFileName = 'Client_T788_Calderhaven_SW_weekly_checkin_document_with_a_very_long_filename.docx';
    await page.setInputFiles('#transcriptFile', { name: longFileName, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('PK') });
    assert.equal(await page.locator('#uploadConfirmation').isHidden(), true, 'the upload is not acknowledged before the server accepts it');
    const mobileUploadLayout = await page.evaluate(() => {
      const panel = document.getElementById('uploadConfirmation').getBoundingClientRect();
      const detail = document.getElementById('uploadConfirmationDetail');
      return {
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        panelLeft: panel.left,
        panelRight: panel.right,
        detailOverflow: detail.scrollWidth - detail.clientWidth
      };
    });
    assert.ok(mobileUploadLayout.documentWidth <= mobileUploadLayout.viewportWidth, JSON.stringify(mobileUploadLayout));
    assert.ok(mobileUploadLayout.panelLeft >= 0 && mobileUploadLayout.panelRight <= mobileUploadLayout.viewportWidth, JSON.stringify(mobileUploadLayout));
    assert.ok(mobileUploadLayout.detailOverflow <= 1, JSON.stringify(mobileUploadLayout));
    assert.equal(await page.locator('#uploadConfirmation').isHidden(), true, 'the confirmation stays hidden while the server is preparing the draft');
    await preparedResponse;
    await page.waitForFunction(() => !document.getElementById('uploadConfirmation').hidden);
    assert.equal(await page.locator('#uploadConfirmationPending').isVisible(), true);
    const text = await page.textContent('#uploadConfirmation');
    assert.match(text, /Transcript uploaded/);
    assert.match(text, /processing has started in the background/i);
    assert.match(text, /processed in the background/i);
    assert.doesNotMatch(text, /keep this page open|reopen it from Library/i);
    assert.equal(await page.locator('#uploadConfirmationReady').isHidden(), true, 'the next-step guide waits for preparation to finish');
    assert.equal(await page.locator('#detailsEditor').isVisible(), true, 'the details are already there underneath');

    assert.equal(await page.locator('#uploadConfirmationContinue').count(), 1);

    // Coming back to the draft from the Library does not show it again.
    await page.goto(`http://127.0.0.1:${port}/meeting-minutes-agent?draftId=prepared`);
    await page.waitForFunction(() => !document.getElementById('detailsEditor').hidden);
    assert.equal(await page.locator('#uploadConfirmation').isHidden(), true);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('an uploaded draft synchronises in place after a failed progress check without losing edits', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${port}/meeting-minutes-agent`);
    await page.setInputFiles('#transcriptFile', {
      name: 'T761.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from('PK')
    });
    await page.waitForFunction(() => !document.getElementById('uploadConfirmation').hidden);

    // A transient status failure must leave the draft alone, expose a manual
    // retry and keep checking without starting another generation request.
    await page.waitForFunction(() => document.getElementById('reloadDraft').textContent === 'Check progress');
    await page.fill('#meetingTitle', 'Reviewer-edited T761 title');

    await page.waitForFunction(() => document.querySelectorAll('#discussionList [data-record-field]').length > 0);
    assert.equal(await page.inputValue('#meetingTitle'), 'Reviewer-edited T761 title');
    assert.match(await page.textContent('#uploadConfirmationDetail'), /Discussion is ready\. Actions are being prepared\./i);
    assert.equal(await page.textContent('#uploadConfirmationContinue'), 'Review discussion');
    assert.equal(await page.locator('#reloadDraft').isHidden(), true);

    await page.click('#uploadConfirmationContinue');
    assert.equal(await page.locator('[data-screen="2"]').evaluate((node) => node.classList.contains('active')), true);
    assert.match(await page.textContent('#discussionList'), /revised report is ready for circulation/i);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('choosing another transcript first saves the current draft and explains how to return', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'editor');
    browser = launched.browser;
    const { page, errors } = launched;
    await page.click('[data-step="0"]');
    await page.fill('#meetingTitle', 'A newly edited meeting title');

    const saved = page.waitForResponse((response) =>
      response.url().endsWith('/api/meeting-minutes-agent/drafts/editor')
        && response.request().method() === 'PATCH');
    await page.click('#replaceTranscript');
    await saved;
    // The response arrives just before the async click handler opens the
    // confirmation dialog; wait for the user-visible result of that handler.
    await page.locator('#newTranscriptDialog').waitFor({ state: 'visible' });

    assert.equal(await page.locator('#newTranscriptDialog').isVisible(), true);
    assert.equal(await page.textContent('#newTranscriptTitle'), 'Choose another transcript?');
    assert.match(await page.textContent('#newTranscriptDialog'), /saved in Library/i);
    assert.match(await page.textContent('#newTranscriptDialog'), /return to it at any time/i);
    assert.match(await page.textContent('#newTranscriptDialog'), /starts a separate draft/i);
    assert.equal(await page.evaluate(async () => (await (await fetch('/test-state/editor')).json()).draft.details.meetingTitle), 'A newly edited meeting title');

    await page.locator('#newTranscriptDialog button[value="cancel"]').click();
    assert.equal(await page.locator('#newTranscriptDialog').isHidden(), true);
    assert.match(page.url(), /draftId=editor/);

    await page.click('#replaceTranscript');
    const chooser = page.waitForEvent('filechooser');
    await page.click('#confirmNewTranscript');
    await chooser;
    assert.equal(await page.locator('#newTranscriptDialog').isHidden(), true);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('phase correction offers accurate recovery wording and restores through the existing action control', {timeout:120000}, async()=>{
 const {server,port}=await startStubServer();let browser;
 try{
  const launched=await launchPage(port,'phase-correction');browser=launched.browser;const {page,errors}=launched;
  const restore=page.locator('[data-restore-combined-actions]');
  assert.equal(await restore.innerText(),'Restore original action wording');
  await restore.click();
  await page.waitForFunction(()=>document.querySelector('#actionsBody')?.textContent.includes('Send the revised report.'));
  assert.equal(await restore.count(),0);
  assert.match(await page.textContent('body'),/Original action wording restored/);
  assert.deepEqual(errors,[]);
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
});


test('inherited warning distinguishes earlier wording, escapes it and keeps the current action and review controls', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer();
  let browser;
  try {
    const launched = await launchPage(port, 'earlier-warning');
    browser = launched.browser;
    const { page, errors } = launched;
    const warning = page.locator('[data-review-flag-id="flag-action"]');
    const reason = warning.locator('.flag-message');
    assert.match(await reason.textContent(), /raised against earlier action wording/);
    assert.match(await reason.textContent(), /Obtain <Jo> review of the documents/);
    assert.match(await reason.textContent(), /Original explanation: The linked lines/);
    assert.equal(await reason.locator('jo').count(), 0, 'origin text must not become markup');
    assert.match(await warning.locator('.flag-target').textContent(), /Follow up with Jo regarding review of the documents/);
    assert.equal(await warning.locator('[data-flag-status="confirmed"]').count(), 1);
    assert.equal(await warning.locator('[data-flag-status="dismissed"]').count(), 1);
    assert.equal(await warning.locator('[data-flag-correction]').inputValue(), '');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});

for (const fixture of ['editor', 'same-warning', 'shared-warning']) {
  test('no earlier-wording claim for historical, unchanged or shared checks: ' + fixture, { timeout: 120000 }, async () => {
    const { server, port } = await startStubServer();
    let browser;
    try {
      const launched = await launchPage(port, fixture);
      browser = launched.browser;
      assert.doesNotMatch(await launched.page.locator('#flagList').textContent(), /raised against earlier action wording/);
      assert.deepEqual(launched.errors, []);
    } finally {
      if (browser) await browser.close();
      await new Promise(resolve => server.close(resolve));
    }
  });
}


for (const kind of ['prefix', 'question']) test('document review ' + kind + ' is visibly uncertain, source-linked and does not add an action when checked', {timeout:120000}, async()=>{
  const {server,port}=await startStubServer();let browser;
  try{
    const launched=await launchPage(port,'document-review-'+kind);browser=launched.browser;const {page,errors}=launched;
    assert.equal(await page.locator('#actionsBody [data-action-row]').count(),0);
    await page.locator('#reviewQueueToggle').click();
    await page.locator('[data-review-category="optional"] > summary').click();
    const item=page.locator('#flagList [data-review-flag-id]');
    assert.equal(await item.count(),1);
    await item.locator('.flag-review-reason > summary').click();
    const explanation=await item.locator('.flag-message').innerText();
    if(kind==='prefix')assert.match(explanation,/ISO identifier prefix is not stated/);
    else assert.match(explanation,/who accepted it/);
    assert.doesNotMatch(explanation,/assessment (?:is|was) (?:approved|completed|verified)/i);
    await item.locator('.review-evidence > summary').click();
    assert.match(await item.locator('.review-evidence-body').innerText(),/assessment of that standard/);
    await item.locator('[data-flag-status="confirmed"]').click();
    await page.waitForFunction(()=>!document.querySelector('#flagList [data-review-flag-id]'));
    await page.reload();await page.waitForFunction(()=>document.querySelector('#actionsBody tr'));
    assert.equal(await page.locator('#actionsBody [data-action-row]').count(),0);
    assert.deepEqual(errors,[]);
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
});

test('row and topic menus: one open at a time, Esc and outside clicks close them, transcript opens in the drawer', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer(); let browser;
  try {
    const launched = await launchPage(port, 'editor'); browser = launched.browser;
    const { page, errors } = launched;
    await page.click('[data-step="2"]');
    const openMenus = () => page.locator('details[data-menu][open]').count();
    // Tall enough that the point menu opens downwards and leaves the topic menu clear.
    await page.setViewportSize({ width: 1280, height: 1100 });
    const pointMenu = page.locator('#discussionList .record-menu>summary').first();
    const topicMenu = page.locator('#discussionList .topic-menu>summary').first();

    await pointMenu.click();
    await page.keyboard.press('Escape');
    assert.equal(await openMenus(), 0, 'Esc closes the point menu');
    assert.equal(await page.evaluate(() => document.activeElement.tagName), 'SUMMARY', 'focus returns to the menu button');

    await pointMenu.click();
    await page.click('#discussionScreen h2');
    assert.equal(await openMenus(), 0, 'a click elsewhere closes the menu');

    await pointMenu.click();
    await topicMenu.click();
    assert.equal(await openMenus(), 1, 'opening a second menu closes the first');
    assert.equal(await page.locator('.topic-menu[open]').count(), 1);
    const clipped = await page.locator('.topic-menu[open] .topic-menu-popover').evaluate((node) =>
      node.scrollHeight > node.clientHeight + 1 || [...node.querySelectorAll('button')].some((b) => b.scrollWidth > b.clientWidth + 1));
    assert.equal(clipped, false, 'every topic menu item is shown in full');
    await page.keyboard.press('Escape');

    const before = await page.evaluate(() => window.scrollY);
    await pointMenu.click();
    const item = page.locator('#discussionList .record-menu[open] [data-view-transcript]');
    assert.match(await item.textContent(), /transcript \(1 line\)/);
    await item.click();
    assert.equal(await openMenus(), 0);
    assert.equal(await page.locator('#sideDrawer').isVisible(), true);
    assert.match(await page.textContent('#sideDrawerPinned'), /revised report is ready/);
    assert.match(await page.textContent('#sideDrawerBody'), /revised report/);
    assert.equal(await page.evaluate(() => window.scrollY), before, 'opening the drawer does not move the page');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#sideDrawer').isVisible(), false);

    const headingFocus = await page.evaluate(() => [...document.querySelectorAll('h1,h2,h3')].filter((h) => h.hasAttribute('tabindex')).length);
    assert.equal(headingFocus, 0, 'no heading is focusable');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a processed draft opens as one document with one sticky bar, and Edit structure neither scrolls nor saves', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer(); let browser;
  try {
    const launched = await launchPage(port, 'document'); browser = launched.browser;
    const { page, errors } = launched;
    const patches = async () => page.evaluate(async () => (await (await fetch('/test-state/document')).json()).patches);
    await page.waitForSelector('body.doc-mode');
    assert.equal(await page.locator('[data-screen="5"]').isVisible(), true, 'the document is shown');
    assert.equal(await page.locator('.steps').isVisible(), false, 'no step tabs');
    assert.equal(await page.locator('#staleNotice').isVisible(), false, 'no page-wide banner');
    assert.equal(await page.locator('#generationMethod').isVisible(), false, 'no beta label');
    assert.ok((await page.locator('#finalDocument').evaluate((node) => node.getBoundingClientRect().width)) <= 760);
    assert.match(await page.textContent("#documentMeta"), /16 Sept? 2026.*Teams.*Review/);
    // One bar: save state, checks, Preview and Finalise; nothing else filled.
    assert.equal(await page.locator('#finaliseMinutes').isVisible(), true);
    assert.equal(await page.locator('#downloadDraft').isVisible(), false);
    assert.equal(await page.locator('.final-actions').isVisible(), false);
    // The outdated Actions are flagged under their own heading.
    assert.match(await page.textContent('#finalDocument [data-stale-link="actions"]'), /Discussion changed/);

    const before = await patches();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.click('#editStructureToggle');
    await page.waitForSelector('body:not(.doc-mode)');
    assert.equal(await page.locator('.steps').isVisible(), true, 'the step screens are behind the toggle');
    assert.equal(await page.evaluate(() => window.scrollY), 0, 'toggling does not scroll');
    await page.waitForTimeout(1800);
    assert.equal(await patches(), before, 'toggling does not save');
    // Remembered for this draft.
    await page.reload();
    await page.waitForSelector('#editStructureToggle[aria-pressed="true"]');
    assert.equal(await page.evaluate(() => document.body.classList.contains('doc-mode')), false);
    await page.click('#editStructureToggle');
    await page.waitForSelector('body.doc-mode');

    // The title edits in place from the document header and saves after a pause.
    await page.click('#pageTitle [data-final-edit]');
    await page.fill('#pageTitle input', 'Revised report review');
    await page.keyboard.press('Enter');
    await page.waitForFunction(async () => (await (await fetch('/test-state/document')).json()).draft.details.meetingTitle === 'Revised report review');
    assert.doesNotMatch(await page.textContent('#saveStatus'), /tab open/i);

    // Preview is read-only and carries Download.
    await page.click('#previewDocument');
    assert.equal(await page.locator('#previewBar').isVisible(), true);
    assert.equal(await page.locator('#previewBar .export-menu').count(), 1);
    assert.match(await page.textContent('#previewDocument'), /Back to editing/);
    const readOnlySummary = page.locator('#finalDocument [data-final-edit][data-kind="summary"]');
    assert.equal(await readOnlySummary.isDisabled(), true);
    await page.locator('#previewDocument').evaluate((node) => node.blur());
    await readOnlySummary.focus();
    await page.keyboard.press('Enter');
    await readOnlySummary.dispatchEvent('click');
    assert.equal(await page.locator('[data-final-editor]').count(), 0);
    assert.equal(await page.locator('body.doc-preview').count(), 1);
    assert.equal(await page.locator('#documentMeta select').count(), 0);
    await page.click('#previewDocument');
    assert.equal(await page.locator('#previewBar').isVisible(), false);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a processed draft has one filled button, no red trash icons and regenerate only in section menus', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer(); let browser;
  try {
    const launched = await launchPage(port, 'document'); browser = launched.browser;
    const { page, errors } = launched;
    await page.waitForSelector('body.doc-mode');
    const filled = () => page.evaluate(() => [...document.querySelectorAll('button.button')]
      .filter((node) => node.getClientRects().length && !node.closest('dialog')).map((node) => node.id || node.textContent.trim()));
    assert.deepEqual(await filled(), ['finaliseMinutes']);
    // Regenerate lives in each section's menu.
    const actionsMenu = page.locator('#finalDocument .section-head:has(h3:text("Actions")) .section-menu');
    await actionsMenu.locator('summary').click();
    assert.equal(await actionsMenu.locator('[data-regenerate-section="actions"]').isVisible(), true);
    await page.keyboard.press('Escape');

    await page.click('#editStructureToggle');
    for (const step of [0, 2, 3, 4]) {
      await page.click('[data-step="' + step + '"]');
      const screen = page.locator('[data-screen="' + step + '"]');
      assert.deepEqual(await filled(), ['finaliseMinutes'], 'step ' + step);
      assert.equal(await screen.locator('use[href="#i-trash"]').count(), 0, 'no trash icons on step ' + step);
      assert.equal(await screen.locator('.screen-actions').isVisible(), false, 'no Back/Continue on step ' + step);
    }
    assert.equal(await page.locator('#regenerateActions').isVisible(), false);
    // Icon-only controls carry a label and a tooltip.
    const unlabeled = await page.evaluate(() => [...document.querySelectorAll('summary, button')]
      .filter((node) => node.getClientRects().length && /^[•…×]+$/.test(node.textContent.trim()))
      .filter((node) => !node.getAttribute('aria-label') || !node.getAttribute('title')).length);
    assert.equal(unlabeled, 0);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('every text in the document edits the same way and removals can be undone', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer(); let browser;
  try {
    const launched = await launchPage(port, 'document-editing'); browser = launched.browser;
    const { page, errors } = launched;
    await page.setViewportSize({ width: 1024, height: 1400 });
    await page.waitForSelector('body.doc-mode');
    const patch = (test) => page.waitForResponse((response) => response.url().endsWith('/api/meeting-minutes-agent/drafts/document-editing')
      && response.request().method() === 'PATCH' && test(response.request().postDataJSON().reviewDecisionLabel || ''));

    // A point opens as a textarea with its text selected; Save is secondary.
    const points = page.locator('#finalDocument .doc-point [data-final-edit]');
    const secondText = (await points.nth(1).textContent()).trim();
    await points.first().click();
    const editor = page.locator('#finalDocument [data-final-editor-value]');
    assert.equal(await editor.evaluate((node) => node.tagName), 'TEXTAREA');
    assert.equal(await editor.evaluate((node) => node === document.activeElement && node.selectionEnd - node.selectionStart === node.value.length), true);
    assert.equal(await page.locator('#finalDocument [data-final-save]').getAttribute('class'), 'secondary');
    // Esc cancels without saving.
    await page.keyboard.type('Thrown away');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#finalDocument [data-final-editor]').count(), 0);
    assert.equal((await page.locator('#finalDocument').textContent()).includes('Thrown away'), false);

    // Tab saves and opens the next piece of text.
    await points.first().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Confirmed.');
    let saved = patch((label) => label === 'Meeting sentence edited');
    await page.keyboard.press('Tab');
    await saved;
    assert.equal((await page.locator('#finalDocument [data-final-editor-value]').inputValue()).trim(), secondText);
    await page.keyboard.press('Escape');
    const edited = page.locator('#finalDocument .final-editable.user-edited');
    assert.equal(await edited.count(), 1);
    // The point also carries a model check, which the tooltip names first.
    assert.match(await edited.getAttribute('title'), /Edited by you$/);

    // Clicking outside an unchanged field just closes it.
    await points.nth(1).click();
    await page.mouse.click(4, 400);
    assert.equal(await page.locator('#finalDocument [data-final-editor]').count(), 0);

    // The topic title edits in place without moving its count or menu.
    const head = page.locator('#finalDocument .doc-topic-head').first();
    const metaOffset = () => head.evaluate((node) => {
      const meta = node.querySelector('.topic-meta').getBoundingClientRect(), box = node.getBoundingClientRect();
      return [Math.round(meta.left - box.left), Math.round(meta.top - box.top)];
    });
    const before = await metaOffset();
    await head.locator('[data-final-edit]').click();
    assert.equal(await page.locator('#finalDocument .doc-topic-head input[data-final-editor-value]').count(), 1);
    assert.deepEqual(await metaOffset(), before);
    await page.keyboard.press('Escape');

    // Removing a point shows an Undo toast, and Undo puts it back.
    const thirdText = (await points.nth(2).textContent()).trim();
    const pointRow = page.locator('#finalDocument .doc-point').nth(2);
    await pointRow.hover();
    await pointRow.locator('.row-menu>summary').click();
    saved = patch((label) => label.startsWith('Removed “'));
    await pointRow.locator('[data-doc-remove-record]').click();
    await saved;
    assert.match(await page.locator('#undoToastMessage').textContent(), /^Removed “.+”\. $/);
    assert.equal((await page.locator('#finalDocument').textContent()).includes(thirdText), false);
    await page.click('#undoToastButton');
    await page.waitForFunction((text) => document.getElementById('finalDocument').textContent.includes(text), thirdText);

    // Attendees are chips: add one with Enter, remove one with undo.
    await page.click('[data-doc-add-attendee="client"]');
    await page.keyboard.type('Pat Lee');
    saved = patch((label) => label === 'Attendee added');
    await page.keyboard.press('Enter');
    await saved;
    assert.ok((await page.locator('.doc-attendee-chip').allTextContents()).some((text) => text.includes('Pat Lee')));
    const patChip = page.locator('.doc-attendee-chip', { hasText: 'Pat Lee' });
    saved = patch((label) => label === 'Removed “Pat Lee”');
    await patChip.hover();
    await patChip.locator('.chip-remove').click();
    await saved;
    assert.equal(await page.locator('.doc-attendee-chip', { hasText: 'Pat Lee' }).count(), 0);

    // An empty new objective is dropped, not saved.
    await page.click('[data-doc-add-objective]');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#finalDocument .final-objectives [data-final-edit].is-empty').count(), 0);

    // Removing an action needs no confirmation and can be undone.
    const actionRows = page.locator('#finalDocument .actions-table tbody tr');
    const actionCount = await actionRows.count();
    await actionRows.first().hover();
    await actionRows.first().locator('.row-menu>summary').click();
    saved = patch((label) => label.startsWith('Removed “'));
    await actionRows.first().locator('[data-doc-remove-action]').click();
    await saved;
    assert.equal(await actionRows.count(), actionCount - 1);
    await page.click('#undoToastButton');
    await page.waitForFunction((count) => document.querySelectorAll('#finalDocument .actions-table tbody tr').length === count, actionCount);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the actions table picks owners from attendees and keeps Due structured', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer(); let browser;
  try {
    const launched = await launchPage(port, 'document-editing'); browser = launched.browser;
    const { page, errors } = launched;
    await page.setViewportSize({ width: 1024, height: 1400 });
    await page.waitForSelector('body.doc-mode');
    const patch = () => page.waitForResponse((response) => response.url().endsWith('/api/meeting-minutes-agent/drafts/document-editing')
      && response.request().method() === 'PATCH');
    const table = page.locator('#finalDocument .doc-actions-table');
    const row = (index) => table.locator('tbody tr').nth(index);
    assert.deepEqual((await table.locator('thead th').allTextContents()).slice(0, 3).map((text) => text.trim()), ['Action', 'Owner', 'Due']);
    const widths = await table.locator('thead th').evaluateAll((cells) => cells.map((cell) => Math.round(cell.getBoundingClientRect().width)));
    assert.ok(widths[0] >= 320, JSON.stringify(widths));
    assert.equal(widths[1], 180); assert.equal(widths[2], 160);

    // A long target remains structured timing, with its wording kept in a note.
    assert.match(await row(0).locator('.due-note').textContent(), /^Timing note: “hoping by early July/);
    assert.match(await row(0).locator('.due-picker>summary').textContent(), /See timing note/);
    const lineHeight = await row(0).locator('.due-note').evaluate((node) => parseFloat(getComputedStyle(node).lineHeight));
    const clamped = await row(0).locator('.due-note').evaluate((node) => node.getBoundingClientRect().height);
    assert.ok(clamped <= lineHeight * 2 + 2, 'note clamped to two lines');
    await row(0).locator('.due-note').click();
    assert.ok(await row(0).locator('.due-note').evaluate((node) => node.getBoundingClientRect().height) > clamped, 'note expands on click');
    await page.click('#previewDocument');
    assert.equal(await row(0).locator('.due-note').isDisabled(), true);
    assert.ok(await row(0).locator('.due-note').evaluate((node) => node.getBoundingClientRect().height) > clamped, 'read-only notes are fully readable without a click');
    assert.equal(await row(0).locator('.due-note').evaluate((node) => node.scrollHeight <= node.clientHeight + 1), true);
    await page.click('#previewDocument');
    // No other cell runs past two lines.
    const tall = await table.locator('tbody td').evaluateAll((cells) => cells.filter((cell) => !cell.querySelector('.due-note')).filter((cell) => {
      const line = parseFloat(getComputedStyle(cell).lineHeight) || 24;
      const inner = cell.querySelector('summary, [data-final-edit]');
      return inner && inner.getBoundingClientRect().height > line * 2 + 12;
    }).length);
    assert.equal(tall, 0);

    // Owner comes from a picker of attendees, grouped.
    assert.match(await row(1).locator('.owner-picker>summary').textContent(), /No owner assigned/);
    await row(1).locator('.owner-picker>summary').click();
    assert.deepEqual(await row(1).locator('.doc-picker-popover .record-menu-label').allTextContents(), ['Internal', 'Client']);
    let saved = patch();
    await row(1).locator('[data-owner-toggle="Sam Okoro"]').click();
    let body = (await saved).request().postDataJSON();
    assert.deepEqual(body.actions[1].owners, ['Sam Okoro']);
    assert.equal(await row(1).locator('.owner-picker').getAttribute('open'), '', 'picker stays open for more owners');
    await page.fill('[data-owner-new][data-occ="' + body.actions[1].occurrenceId + '"]', 'Pat Lee');
    saved = patch();
    await page.keyboard.press('Enter');
    body = (await saved).request().postDataJSON();
    assert.deepEqual(body.actions[1].owners, ['Sam Okoro', 'Pat Lee']);
    await page.keyboard.press('Escape');

    // Due: a relative choice replaces the sentence and the note goes.
    await row(0).locator('.due-picker>summary').click();
    await row(0).locator('[data-due-mode="relative"]').click();
    saved = patch();
    await row(0).locator('[data-due-relative]').selectOption('Next week');
    body = (await saved).request().postDataJSON();
    assert.equal(body.actions[0].timing.kind, 'target');
    assert.equal(body.actions[0].timing.wording, 'Next week');
    assert.equal(await row(0).locator('.due-note').count(), 0);
    assert.equal((await row(0).locator('.due-picker>summary').textContent()).trim(), 'Next week');
    // A date.
    await row(1).locator('.due-picker>summary').click();
    await row(1).locator('[data-due-mode="date"]').click();
    saved = patch();
    await row(1).locator('[data-due-date]').fill('2026-10-02');
    body = (await saved).request().postDataJSON();
    assert.equal(body.actions[1].timing.exactDate, '2026-10-02');
    // None clears it.
    await row(1).locator('.due-picker>summary').click();
    saved = patch();
    await row(1).locator('[data-due-mode="none"]').click();
    body = (await saved).request().postDataJSON();
    assert.equal(body.actions[1].timing.kind, 'not_stated');

    // Mark reviewed shows a check at the row's edge.
    await row(0).hover();
    await row(0).locator('.doc-row-menu .row-menu>summary').click();
    assert.deepEqual((await row(0).locator('.doc-row-menu [data-menu-popover] button').allTextContents()).map((text) => text.replace(/ \(.*\)$/, '').trim()), ['View source', 'Mark reviewed', 'Remove action']);
    saved = patch();
    await row(0).locator('[data-doc-keep-action]').click();
    await saved;
    assert.equal(await row(0).locator('.doc-reviewed').count(), 1);

    // Add action opens an empty row with the cursor in the Action cell.
    const count = await table.locator('tbody tr').count();
    await page.click('[data-doc-add-action]');
    assert.equal(await table.locator('tbody tr').count(), count + 1);
    assert.equal(await page.evaluate(() => document.activeElement.matches('.doc-actions-table [data-final-editor-value]')), true);
    await page.keyboard.type('Book the review call.');
    saved = patch();
    await page.keyboard.press('Control+Enter');
    body = (await saved).request().postDataJSON();
    assert.equal(body.actions[body.actions.length - 1].action, 'Book the review call.');
    // An empty new row is dropped when cancelled.
    await page.click('[data-doc-add-action]');
    await page.keyboard.press('Escape');
    assert.equal(await table.locator('tbody tr').count(), count + 1);
    // Long custom relative wording remains structured after save and reload.
    const longRelative = 'Within five working days following the approval meeting';
    await row(1).locator('.due-picker>summary').click();
    await row(1).locator('[data-due-mode="relative"]').click();
    await row(1).locator('[data-due-relative]').selectOption('__custom');
    await row(1).locator('[data-due-text="relative"]').fill(longRelative);
    saved = patch();
    await row(1).locator('[data-due-save="relative"]').click();
    body = (await saved).request().postDataJSON();
    assert.equal(body.actions[1].timing.kind, 'target');
    assert.equal(body.actions[1].timing.wording, longRelative);
    await page.reload();
    await page.waitForSelector('body.doc-mode');
    assert.equal((await row(1).locator('.due-picker>summary').textContent()).trim(), 'See timing note');
    assert.equal(await row(1).locator('.due-note').textContent(), 'Timing note: “' + longRelative + '”');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('one counter adds up open checks, and Finalise asks once then locks the document', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer(); let browser;
  try {
    const launched = await launchPage(port, 'document-editing'); browser = launched.browser;
    const { page, errors } = launched;
    await page.setViewportSize({ width: 1440, height: 1200 });
    await page.waitForSelector('body.doc-mode');
    const patch = () => page.waitForResponse((response) => response.url().endsWith('/api/meeting-minutes-agent/drafts/document-editing')
      && response.request().method() === 'PATCH');
    // 2 model checks + 1 missing owner + 1 missing due; a long target is still timing.
    assert.equal((await page.textContent('#flagCount')).trim(), '4 to check');

    // Flagged text has an amber bar in the document.
    assert.ok(await page.locator('#finalDocument .final-editable.model-flagged').count() >= 1);

    // The pill opens the checks drawer, grouped, with today's cards.
    await page.click('#reviewQueueToggle');
    const drawer = page.locator('#sideDrawer');
    assert.equal(await drawer.isVisible(), true);
    assert.deepEqual(await drawer.locator('.checks-group:not([hidden]) > h3').evaluateAll((nodes) => nodes.map((node) => node.firstChild.textContent.trim())), ['Model flagged', 'Missing owner', 'Missing date']);
    assert.ok(await drawer.locator('#flagList [data-flag-status="confirmed"]').count() >= 1);
    // Show in document scrolls to the item and keeps the drawer open.
    await drawer.locator('[data-view-flag-target]').first().click();
    assert.equal(await drawer.isVisible(), true);
    await page.waitForSelector('#finalDocument .doc-pulse');

    // An explicit Fix leaves Preview and opens an enabled editor.
    await page.click('#previewDocument');
    assert.equal(await page.locator('body.doc-preview').count(), 1);
    await drawer.locator('[data-fix-owner]').first().click();
    assert.equal(await page.locator('body.doc-preview').count(), 0);
    const picker = page.locator('.owner-picker[open]');
    await picker.waitFor();
    assert.equal(await picker.locator('[data-owner-toggle="Alex Reed"]').isEnabled(), true);
    let saved = patch();
    await picker.locator('[data-owner-toggle="Alex Reed"]').click();
    await saved;
    await page.keyboard.press('Escape');
    assert.equal((await page.textContent('#flagCount')).trim(), '3 to check');

    // Finalise with open items asks in the drawer; Review first keeps editing.
    await page.click('#finaliseMinutes');
    assert.equal(await page.locator('.finalise-confirm').isVisible(), true);
    assert.equal((await page.textContent('#sideDrawerTitle')).trim(), 'Finalise with open items?');
    assert.match(await page.textContent('.finalise-confirm'), /3 items are still open: 2 model checks, 1 missing date/);
    await page.click('[data-review-first]');
    assert.equal(await page.locator('.finalise-confirm').count(), 0);
    await page.keyboard.press('Escape');
    assert.equal(await drawer.isVisible(), false);
    assert.equal(await page.locator('#reviewFlags #flagList').count(), 1, 'the checks go back to their panel');

    // Finalise anyway saves the minutes as complete and locks the document.
    await page.click('#finaliseMinutes');
    saved = patch();
    await page.click('[data-finalise-anyway]');
    assert.equal((await saved).request().postDataJSON().status, 'complete');
    await page.waitForSelector('body.doc-finalised');
    assert.match(await page.textContent('#finalisedNote'), /^Finalised \d{1,2} \w+ \d{4}$/);
    for (const id of ['copyDraftLink', 'reopenMinutes']) assert.equal(await page.locator('#' + id).isVisible(), true, id);
    assert.equal(await page.locator('#finaliseMinutes').isVisible(), false);
    await page.locator('#finalDocument [data-final-edit]').first().focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('[data-final-editor]').count(), 0, 'read-only once finalised');
    assert.equal(await page.locator('#editStructureToggle').isHidden(), true);
    assert.equal(await page.locator('#editStructureToggle').isDisabled(), true);
    assert.equal(await page.locator('#finalDocument [data-final-edit]:not([disabled])').count(), 0);
    assert.equal(await page.locator('#finalDocument .due-note').first().evaluate((node) => node.scrollHeight <= node.clientHeight + 1), true);
    const lockedBefore = await page.evaluate(async () => (await (await fetch('/test-state/document-editing')).json()));
    await page.locator('#editStructureToggle').dispatchEvent('click');
    assert.equal(await page.locator('body.doc-mode.doc-finalised').count(), 1);
    assert.equal(await page.locator('[data-step="3"]').isVisible(), false);
    const lockedAfter = await page.evaluate(async () => (await (await fetch('/test-state/document-editing')).json()));
    assert.equal(lockedAfter.patches, lockedBefore.patches);
    assert.equal(lockedAfter.draft.status, 'complete');
    await page.evaluate(() => localStorage.setItem('mma-edit-structure:document-editing', '1'));
    await page.reload();
    await page.waitForSelector('body.doc-mode.doc-finalised');
    assert.equal(await page.locator('#editStructureToggle').isHidden(), true);
    await page.evaluate(() => localStorage.removeItem('mma-edit-structure:document-editing'));

    // Reopen for editing makes it editable again.
    saved = patch();
    await page.click('#reopenMinutes');
    assert.equal((await saved).request().postDataJSON().status, 'draft');
    await page.waitForFunction(() => !document.body.classList.contains('doc-finalised'));
    await page.locator('#finalDocument [data-final-edit]').first().click();
    assert.equal(await page.locator('[data-final-editor]').count(), 1);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('document print keeps meeting identity and topic visibility while excluding editing controls', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer(); let browser;
  try {
    const launched = await launchPage(port, 'document'); browser = launched.browser;
    const { page, errors } = launched;
    await page.waitForSelector('body.doc-mode');
    const saved = page.waitForResponse((response) => response.request().method() === 'PATCH'
      && response.url().endsWith('/api/meeting-minutes-agent/drafts/document')
      && response.request().postDataJSON().includeSections.topicHeadings === false);
    await page.locator('[data-doc-topic-headings]').uncheck(); await saved;
    await page.click('#previewDocument');
    await page.click('#reviewQueueToggle');
    assert.equal(await page.locator('#sideDrawer').isVisible(), true);
    await page.emulateMedia({ media: 'print' });
    const printed = await page.locator('#finalDocument').innerText();
    for (const text of ['UI state test', '16 Sept 2026', 'Teams', 'Review']) assert.ok(printed.includes(text), text);
    for (const selector of ['#previewBar', '#sideDrawer', '#undoToast', '#finalDocument .doc-topic-head.is-hidden',
      '#finalDocument .section-menu', '#finalDocument .doc-point>.row-menu']) {
      for (const node of await page.locator(selector).all()) assert.equal(await node.isVisible(), false, selector);
    }
    assert.equal(printed.includes('Report review'), false);
    assert.ok(printed.includes('The revised report is ready for circulation.'));
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

for (const kind of ['owner', 'due']) {
  test(`unfinished document ${kind} text survives the autosave pause`, { timeout: 120000 }, async () => {
    const { server, port } = await startStubServer(); let browser;
    try {
      const launched = await launchPage(port, 'document-editing'); browser = launched.browser;
      const { page, errors } = launched;
      await page.waitForSelector('body.doc-mode');
      const row = page.locator('#finalDocument .doc-actions-table tbody tr').nth(1);
      let input;
      if (kind === 'owner') {
        await row.locator('.owner-picker>summary').click();
        input = row.locator('[data-owner-new]');
      } else {
        await row.locator('.due-picker>summary').click();
        await row.locator('[data-due-mode="dependent"]').click();
        input = row.locator('[data-due-text="dependent"]');
      }
      const value = kind === 'owner' ? 'Patricia Newowner' : 'After contract approval';
      await input.fill(value);
      await page.waitForTimeout(1800);
      assert.equal(await input.inputValue(), value);
      const stored = await page.evaluate(async () => (await (await fetch('/test-state/document-editing')).json()));
      assert.equal(stored.patches, 0, 'an unfinished picker entry is not an unrelated draft save');
      assert.equal(await page.locator('#saveStatus').getAttribute('data-state'), 'local-only');
      assert.equal(await page.evaluate(() => {
        const event = new Event('beforeunload', { cancelable:true });
        window.dispatchEvent(event); return event.defaultPrevented;
      }), true, 'leaving warns about the entry that still exists only in this tab');
      assert.deepEqual(errors, []);
    } finally {
      if (browser) await browser.close();
      await new Promise(resolve => server.close(resolve));
    }
  });
}

test('a preceding save preserves the next inline edit and cancelling settles its status', { timeout: 120000 }, async () => {
  const { server, port } = await startStubServer(); let browser;
  try {
    const launched = await launchPage(port, 'document-editing'); browser = launched.browser;
    const { page, errors } = launched;
    await page.waitForSelector('body.doc-mode');
    let release, acknowledge;
    const held = new Promise(resolve => { release = resolve; });
    const intercepted = new Promise(resolve => { acknowledge = resolve; });
    let first = true;
    await page.route('**/api/meeting-minutes-agent/drafts/document-editing', async route => {
      if (route.request().method() === 'PATCH' && first) { first = false; acknowledge(); await held; }
      await route.continue();
    });
    await page.locator('#finalDocument .doc-point [data-final-edit]').first().click();
    await page.locator('#finalDocument [data-final-editor-value]').fill('The first field is committed.');
    await page.keyboard.press('Tab');
    await intercepted;
    const next = page.locator('#finalDocument [data-final-editor-value]');
    await next.fill('The next field is still being written.');
    const response = page.waitForResponse(r => r.url().endsWith('/api/meeting-minutes-agent/drafts/document-editing') && r.request().method() === 'PATCH');
    release(); await response;
    await page.waitForTimeout(100);
    assert.equal(await next.inputValue(), 'The next field is still being written.');
    assert.equal(await page.locator('#saveStatus').getAttribute('data-state'), 'local-only');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('[data-final-editor]').count(), 0);
    assert.equal(await page.locator('#saveStatus').getAttribute('data-state'), 'saved');
    assert.equal(await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable:true });
      window.dispatchEvent(event); return event.defaultPrevented;
    }), false);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('a long explicit dependency remains due after saving and reopening', { timeout:120000 }, async () => {
  const { server, port } = await startStubServer(); let browser;
  try {
    const launched = await launchPage(port, 'document-editing'); browser = launched.browser;
    const { page, errors } = launched;
    await page.waitForSelector('body.doc-mode');
    const row = page.locator('#finalDocument .doc-actions-table tbody tr').nth(1);
    await row.locator('.due-picker>summary').click();
    await row.locator('[data-due-mode="dependent"]').click();
    const value = 'After legal approval of the supplier contract';
    await row.locator('[data-due-text="dependent"]').fill(value);
    const saved = page.waitForResponse(r => r.url().endsWith('/api/meeting-minutes-agent/drafts/document-editing') && r.request().method() === 'PATCH');
    await row.locator('[data-due-save="dependent"]').click();
    const body = (await saved).request().postDataJSON();
    assert.deepEqual(body.actions[1].timing, { kind:'dependency', wording:value, exactDate:'' });
    assert.deepEqual(body.actions[1].evidenceIds, ['T0001']);
    await page.reload();
    await page.waitForSelector('body.doc-mode');
    assert.match(await row.locator('.due-picker>summary').textContent(), /Depends on: After legal approval/);
    assert.equal(await row.locator('.due-note').count(), 0, 'authored wording is not presented as a transcript quotation');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('editing only an owner preserves a generated long timing note', { timeout:120000 }, async () => {
  const { server, port } = await startStubServer(); let browser;
  try {
    const launched = await launchPage(port, 'document-editing'); browser = launched.browser;
    const { page, errors } = launched;
    await page.waitForSelector('body.doc-mode');
    const row = page.locator('#finalDocument .doc-actions-table tbody tr').first();
    const due = await row.locator('.due-picker>summary').textContent();
    const note = await row.locator('.due-note').textContent();
    await row.locator('.owner-picker>summary').click();
    const saved = page.waitForResponse(r => r.url().endsWith('/api/meeting-minutes-agent/drafts/document-editing') && r.request().method() === 'PATCH');
    await row.locator('[data-owner-toggle="Sam Okoro"]').click();
    await saved;
    await page.waitForTimeout(100);
    assert.equal(await row.locator('.due-picker>summary').textContent(), due);
    assert.equal(await row.locator('.due-note').textContent(), note);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('cancelling a later inline edit cannot hide a failed save', { timeout:120000 }, async () => {
  const { server, port } = await startStubServer(); let browser;
  try {
    const launched = await launchPage(port, 'document-editing'); browser = launched.browser;
    const { page, errors } = launched;
    await page.waitForSelector('body.doc-mode');
    let fail = true;
    await page.route('**/api/meeting-minutes-agent/drafts/document-editing', async route => {
      if (route.request().method() === 'PATCH' && fail) {
        fail = false;
        await route.fulfill({ status:503, contentType:'application/json', body:JSON.stringify({ error:'Save unavailable' }) });
      } else await route.continue();
    });
    const points = page.locator('#finalDocument .doc-point [data-final-edit]');
    await points.first().click();
    await page.locator('#finalDocument [data-final-editor-value]').fill('This first change still needs saving.');
    await page.keyboard.press('Control+Enter');
    await page.waitForFunction(() => document.getElementById('saveStatus').dataset.state === 'error');
    await points.nth(1).click();
    await page.locator('#finalDocument [data-final-editor-value]').fill('Cancel this later edit.');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#saveStatus').getAttribute('data-state'), 'error');
    assert.equal(await page.textContent('#saveStatus'), 'Save unavailable');
    assert.equal(await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable:true });
      window.dispatchEvent(event); return event.defaultPrevented;
    }), true);
    // An explicit successful save can clear the error and persist both changes.
    await points.nth(1).click();
    await page.locator('#finalDocument [data-final-editor-value]').fill('A later deliberate retry.');
    const saved = page.waitForResponse(r => r.url().endsWith('/api/meeting-minutes-agent/drafts/document-editing') && r.request().method() === 'PATCH');
    await page.keyboard.press('Control+Enter');
    await saved;
    await page.waitForFunction(() => document.getElementById('saveStatus').dataset.state === 'saved');
    const stored = await page.evaluate(async () => (await (await fetch('/test-state/document-editing')).json()).draft);
    assert.equal(stored.discussion[0].points[0].text, 'This first change still needs saving.');
    assert.equal(stored.discussion[0].points[1].text, 'A later deliberate retry.');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});