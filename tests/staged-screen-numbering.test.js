'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { stagedStageResumeUrl } = require('../routes/api').stagedEvaluation;

// Screen indices shifted when the Summary stage was removed: Details, Summary, Discussion,
// Actions, Final review became Details, Discussion, Actions, Final review, and everything
// after Details moved down by one. Links and drafts written before that shift outlive it.
// A reviewer resuming one landed a stage further on than they had reached - a draft parked
// on Actions (old screen 3) opened on Final review, past a Discussion review they had never
// done, with nothing on screen to say a stage had been skipped.
//
// The fix is to stop treating a screen index as durable. A stage name survives renumbering,
// so links and drafts carry one and it decides the screen; an index arriving alone predates
// the change and is read in the old numbering.

const PAGE_PATH = path.join(__dirname, '..', 'views', 'staged-meeting-minutes.html');

// The resolver runs inside a 4,300-line inline script that expects a DOM. Lifting the four
// functions out and evaluating them is what lets the mapping be tested as behaviour rather
// than by grepping the page for its own source.
function loadScreenResolver() {
  const page = fs.readFileSync(PAGE_PATH, 'utf8');
  const start = page.indexOf('  var STAGE_SCREEN_INDEX = {');
  const end = page.indexOf('  var requestedScreen = resolveScreenIndex(');
  assert.ok(start > 0 && end > start, 'the review page still defines the screen-scheme helpers');
  const context = { Object: Object, String: String, Number: Number, Math: Math };
  vm.createContext(context);
  vm.runInContext(`${page.slice(start, end)}
    resolved = { resolveScreenIndex: resolveScreenIndex, screenIndexForStage: screenIndexForStage, stageNameForScreen: stageNameForScreen };`, context);
  return context.resolved;
}

test('a stage name decides the screen, whatever index arrives with it', () => {
  const { resolveScreenIndex } = loadScreenResolver();

  assert.equal(resolveScreenIndex({ stage: 'details' }), 0);
  assert.equal(resolveScreenIndex({ stage: 'discussion' }), 1);
  assert.equal(resolveScreenIndex({ stage: 'actions' }), 2);
  assert.equal(resolveScreenIndex({ stage: 'final_review' }), 3);

  // A link written today carries both. The stage is the one that still means something.
  assert.equal(resolveScreenIndex({ stage: 'discussion', screen: '3' }), 1,
    'the stage overrides an index that disagrees with it');
  assert.equal(resolveScreenIndex({ stage: 'Final Review', screen: '9' }), 3,
    'the stage is read case- and separator-insensitively');
});

test('a link with only a screen index is read in the numbering that wrote it', () => {
  const { resolveScreenIndex } = loadScreenResolver();

  // Old: 0 Details, 1 Summary, 2 Discussion, 3 Actions, 4 Final review.
  assert.equal(resolveScreenIndex({ screen: '0' }), 0, 'Details is Details either way');
  assert.equal(resolveScreenIndex({ screen: '2' }), 1, 'old Discussion resumes on Discussion');
  assert.equal(resolveScreenIndex({ screen: '3' }), 2, 'old Actions resumes on Actions, not Final review');
  assert.equal(resolveScreenIndex({ screen: '4' }), 3, 'old Final review resumes on Final review');

  // Summary is gone. A draft parked on it resumes at the stage that now follows Details,
  // which is also the stage that reviewer had not reached.
  assert.equal(resolveScreenIndex({ screen: '1' }), 1, 'old Summary resumes on Discussion');

  assert.equal(resolveScreenIndex({}), 0, 'nothing at all opens on Details');
  assert.equal(resolveScreenIndex({ screen: '' }), 0);
  assert.equal(resolveScreenIndex({ screen: 'not a number' }), 0);
  assert.equal(resolveScreenIndex({ screen: '-2' }), 0);
  assert.equal(resolveScreenIndex({ screen: '97' }), 3, 'an index past the end clamps to the last screen');
});

test('every screen names itself, so today\'s links survive the next renumbering', () => {
  const { stageNameForScreen, resolveScreenIndex } = loadScreenResolver();

  for (const index of [0, 1, 2, 3]) {
    assert.equal(resolveScreenIndex({ stage: stageNameForScreen(index) }), index,
      `screen ${index} round-trips through its stage name`);
  }
});

test('a resume link names its stage rather than repeating a stored screen index', () => {
  // The index this job recorded is the one Actions sat on before Summary was removed.
  const stale = stagedStageResumeUrl({ draftId: 'draft-1', stage: 'actions', targetScreen: 3, jobId: 7 }, {});
  const params = new URLSearchParams(stale.split('?')[1]);

  assert.equal(params.get('stage'), 'actions', 'the link says which stage it resumes');
  assert.equal(params.get('screen'), '2', 'and the index is the one Actions sits on now, not the one stored');
  assert.equal(params.get('draftId'), 'draft-1');
  assert.equal(params.get('stageJobId'), '7');

  const discussion = stagedStageResumeUrl({ draftId: 'draft-2', stage: 'discussion', targetScreen: 2 }, {});
  assert.equal(new URLSearchParams(discussion.split('?')[1]).get('screen'), '1');

  // The payload's stage wins over the input's, as it did before.
  const regenerated = stagedStageResumeUrl({ draftId: 'draft-3', stage: 'details' }, { stagedStage: 'actions' });
  assert.equal(new URLSearchParams(regenerated.split('?')[1]).get('stage'), 'actions');
});

test('an unrecognised stage still falls back to the index it was given', () => {
  // Nothing queues a "summary" stage any more, but a job row predating the change can still
  // be replayed, and its own index is the best thing left to go on.
  const url = stagedStageResumeUrl({ draftId: 'draft-4', stage: 'summary', targetScreen: 1 }, {});
  assert.equal(new URLSearchParams(url.split('?')[1]).get('screen'), '1');

  const unknown = stagedStageResumeUrl({ draftId: 'draft-5', stage: 'summary' }, {});
  assert.equal(new URLSearchParams(unknown.split('?')[1]).get('screen'), '0');
});
