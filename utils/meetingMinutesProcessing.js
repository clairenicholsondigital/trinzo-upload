'use strict';

const { isParallel } = require('./meetingMinutesParallel');
const { captureSemanticPolicy } = require('./meetingMinutesSemanticPolicy');
const { captureDiscussionCoveragePolicy } = require('./meetingMinutesDiscussionCoveragePolicy');
const { safeLogError } = require('./apiErrors');

// Both engines share upload/storage, but retain separate generation entry points.
function createInitialMinutesProcessor({
  saveDraft, runOriginalStage, parallelRunner, hybridEnabled, bootId,
  schedule = setImmediate, logError = safeLogError
}) {
  async function startOriginal(draft, req) {
    const stage = 'discussion';
    const generation = {
      stage,
      semanticPolicy: captureSemanticPolicy(),
      discussionCoveragePolicy: captureDiscussionCoveragePolicy(),
      status: 'running',
      bootId: bootId,
      startedAt: new Date().toISOString(),
      pass: hybridEnabled() ? 'starting' : '',
      message: hybridEnabled() ? 'Processing the transcript in the background…' : '',
      completedPasses: [],
      callTimings: [],
      degradedSources: [],
      error: ''
    };
    const saved = await saveDraft(draft, req, {
      generation,
      // Keep the upload acknowledgement visible until the reviewer chooses to
      // move into the staged workflow. The background stage still advances the
      // draft when it completes.
      currentStep: 0,
      selectedStep: 0
    });
    schedule(() => {
      runOriginalStage(saved.draftId, req.authUser?.userId, stage)
        .catch((error) => logError('[meeting-minutes-agent/initial-background] failed', error));
    });
    return saved;
  }

  function startBeta(draft, req) {
    return parallelRunner.start(draft, req.authUser?.userId);
  }

  function start(draft, req) {
    return isParallel(draft) ? startBeta(draft, req) : startOriginal(draft, req);
  }

  return { start, startOriginal, startBeta };
}

module.exports = { createInitialMinutesProcessor };
