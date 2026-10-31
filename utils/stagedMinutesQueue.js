const { stagedGenerationMeetingType } = require('./meetingMinutesStageMeetingType');
const { safeLogError } = require('./apiErrors');
const { validateTranscriptText, transcriptMetadata } = require('./transcript');
const { assertStagedTranscriptHash } = require('./stagedIdentity');
const { normaliseDomainTermsDeep } = require('./domainTerms');
const { generateMiniLmTrooperStage } = require('./stagedMiniLmTrooper');
const { filterActionsForPresentation } = require('./stagedActionPresentation');
const {
  getGenerationJob,
  updateGenerationJobProgress,
  markGenerationJobCompleted,
  markGenerationJobFailure,
  query
} = require('./db');
const { buildPreparedTranscriptForStagedAI } = require('./stagedMinutesContext');
const { canonicalStagedResponse } = require('./stagedMinutesCanonicalResponse');
const { extractStagedDetailsFromTranscript } = require('./stagedMinutesDetails');

const MEETING_MINUTES_JOB_PIPELINE = process.env.MEETING_MINUTES_JOB_PIPELINE || 'chunked';

function stagedStageResumeUrl(inputPayload, payload) {
  const draftId = String(inputPayload?.draftId || '').trim();
  const stage = String(payload?.stagedStage || inputPayload?.stage || 'details').trim().toLowerCase();
  // targetScreen is a screen index recorded by whichever version of the review page queued
  // the job, and screen indices have already shifted once - removing Summary moved every
  // stage after Details down by one. A job queued before that shift still carries the old
  // index, so honouring it would resume the reviewer a stage further on than they had got
  // to. The stage name is what survives a renumbering, so it decides the screen, and it
  // goes in the link for the page to read back.
  const screenByStage = { details: 0, discussion: 1, actions: 2 };
  const screen = Object.prototype.hasOwnProperty.call(screenByStage, stage)
    ? screenByStage[stage]
    : (Number.isFinite(Number(inputPayload?.targetScreen)) ? Number(inputPayload.targetScreen) : 0);
  const params = new URLSearchParams();
  if (draftId) params.set('draftId', draftId);
  params.set('stage', stage);
  params.set('screen', String(screen));
  params.set('stageJobId', String(inputPayload?.jobId || ''));
  return `/staged-meeting-minutes?${params.toString()}`;
}

async function runQueuedStagedMeetingMinutesStage(jobId) {
  const startedAt = Date.now();
  const job = await getGenerationJob(jobId, { includeTranscript: true });
  if (!job || job.jobType !== 'staged_meeting_minutes_stage') return;
  const input = job.inputPayload || {};
  const stage = String(input.stage || 'details').trim().toLowerCase();
  const transcript = {
    text: job.transcriptText || '',
    source: input.source || 'staged-meeting-minutes',
    fileName: input.fileName || '',
    preparedTranscript: job.preparedTranscript || null,
    preparedTranscriptTelemetry: job.preparedTranscriptTelemetry || input.preparedTranscriptTelemetry || null
  };
  const stagedReq = {
    query: { pipeline: input.pipeline || MEETING_MINUTES_JOB_PIPELINE },
    body: {
      stage,
      meetingTitle: input.confirmedDetails?.meetingTitle || input.meetingTitle || '',
      meetingDate: input.confirmedDetails?.meetingDate || input.meetingDate || '',
      meetingLocation: input.confirmedDetails?.meetingLocation || input.meetingLocation || '',
      meetingType: input.meetingType || '',
      participants: Array.isArray(input.confirmedDetails?.participants) ? input.confirmedDetails.participants.join('\n') : input.participants || '',
      overallTopics: Array.isArray(input.confirmedSummary?.overallTopics) ? input.confirmedSummary.overallTopics.join('\n') : input.overallTopics || '',
      reviewObjectives: input.reviewObjectives || '',
      reviewDiscussion: input.reviewDiscussion || '',
      reviewActions: input.reviewActions || '',
      additionalContext: input.additionalContext || '',
      confirmedDetails: input.confirmedDetails || {},
      confirmedSummary: input.confirmedSummary || {},
      confirmedDiscussion: input.confirmedDiscussion || [],
      confirmedActions: input.confirmedActions || []
    }
  };

  try {
    await query(
      `UPDATE meeting_jobs
       SET status = 'running',
           attempts = COALESCE(attempts, 0) + 1,
           started_at = COALESCE(started_at, NOW()),
           updated_at = NOW()
       WHERE id = $1 AND job_type = 'staged_meeting_minutes_stage'`,
      [Number(jobId)]
    );
    await updateGenerationJobProgress(jobId, stage, 10, `Generating staged ${stage} content.`);
    validateTranscriptText(transcript.text);
    const transcriptIdentity = transcriptMetadata(transcript.text);
    assertStagedTranscriptHash(
      input.transcriptSha256,
      transcriptIdentity.transcriptSha256,
      'queued job transcript'
    );

    let payload;
    if (stage === 'details') {
      const preparedTranscript = buildPreparedTranscriptForStagedAI(transcript.text);
      payload = {
        source: transcript.source,
        fileName: transcript.fileName || null,
        transcriptLength: transcript.text.length,
        ...extractStagedDetailsFromTranscript(transcript.text, transcript.fileName),
        preparedTranscriptTelemetry: {
          rawLength: preparedTranscript.rawLength,
          preparedLength: preparedTranscript.preparedLength,
          removedLineCount: preparedTranscript.removedLineCount,
          removedReasons: preparedTranscript.removedReasons,
          source: 'deterministic_stage_1_prep'
        }
      };
    } else if (stage === 'discussion' || stage === 'actions') {
      await updateGenerationJobProgress(jobId, stage, 35, stage === 'actions'
        ? 'Denoising, chunking and reviewing action evidence.'
        : 'Denoising and organising discussion evidence.');
      // This is the measured live pipeline: MiniLM-v3 denoising followed by the
      // meeting-type-specific, multi-pass Trooper stage. Do not route these screens
      // through canonicalStagedResponse; that path reduced the measured Discussion
      // coverage from 168/193 to 113/194 and bypassed the high-recall action extractor.
      const selectedMeetingType = input.confirmedDetails?.meetingType || input.meetingType || '';
      const meetingIdentity = `${input.confirmedDetails?.meetingTitle || ''} ${transcript.fileName || ''}`;
      payload = await generateMiniLmTrooperStage(stage, transcript.text, {
        meetingType: stagedGenerationMeetingType(selectedMeetingType, meetingIdentity)
      });
    } else {
      const evidenceProgressMessage = stage === 'actions'
        ? 'Reviewing action evidence.'
        : stage === 'discussion'
          ? 'Reviewing discussion evidence.'
          : 'Reviewing summary evidence.';
      await updateGenerationJobProgress(jobId, stage, 35, evidenceProgressMessage);
      payload = await canonicalStagedResponse(stage, transcript, input);
    }

    const priorScreens = {};
    if (input.confirmedDetails && Object.keys(input.confirmedDetails).length) priorScreens.details = input.confirmedDetails;
    if (input.confirmedSummary && Object.keys(input.confirmedSummary).length) priorScreens.summary = input.confirmedSummary;
    if (Array.isArray(input.confirmedDiscussion) && input.confirmedDiscussion.length) priorScreens.discussion = input.confirmedDiscussion;
    if (Array.isArray(input.confirmedActions) && input.confirmedActions.length) priorScreens.actions = input.confirmedActions;
    if (Object.keys(priorScreens).length) {
      payload.screens = {
        ...priorScreens,
        ...(payload.screens || {})
      };
    }

    if (stage === 'actions' && Array.isArray(payload?.screens?.actions)) {
      const presentedActions = filterActionsForPresentation(payload.screens.actions);
      const removed = payload.screens.actions.filter((item) => !presentedActions.includes(item));
      if (removed.length) console.info(JSON.stringify({
        event: 'staged_minimum_action_words_gate',
        jobId: Number(jobId),
        stage: 'actions',
        removed: removed.map((item) => item?.action || item?.meetingActionPoint || '')
      }));
      payload.screens.actions = presentedActions;
      if (Array.isArray(payload.screens.raisedActions)) {
        payload.screens.raisedActions = filterActionsForPresentation(payload.screens.raisedActions);
      }
    }

    // Apply unconditional terminology corrections after current and prior screens have
    // been assembled, so queued results are clean both in storage and on retrieval.
    payload = normaliseDomainTermsDeep(payload);

    await updateGenerationJobProgress(jobId, stage, 90, `Staged ${stage} content generated. Preparing resume link.`);
    const resultPayload = {
      ok: true,
      staged: true,
      source: transcript.source,
      fileName: transcript.fileName || null,
      transcriptLength: transcript.text.length,
      transcriptSha256: transcriptIdentity.transcriptSha256,
      meetingId: job.meetingId,
      jobId,
      result: {
        ...payload,
        jobId,
        meetingId: job.meetingId,
        transcriptSha256: transcriptIdentity.transcriptSha256,
        queuedDiagnostics: {
          jobId,
          meetingId: job.meetingId,
          workerMode: 'staged_meeting_minutes_stage',
          rawTranscriptLength: transcript.text.length,
          transcriptSha256: transcriptIdentity.transcriptSha256,
          preparedTranscriptLength: payload.preparedTranscriptTelemetry?.preparedLength || transcript.text.length,
          durationMs: Date.now() - startedAt
        }
      }
    };
    resultPayload.resumeUrl = stagedStageResumeUrl({ ...input, jobId }, payload);
    resultPayload.result.resumeUrl = resultPayload.resumeUrl;
    await markGenerationJobCompleted(jobId, job.meetingId, resultPayload, `Staged ${stage} content is ready to review.`);
    console.info(JSON.stringify({
      event: 'staged_meeting_minutes_stage_completed',
      jobId: Number(jobId),
      draftId: String(input.draftId || ''),
      stage,
      transcriptSha256: transcriptIdentity.transcriptSha256,
      transcriptLength: transcript.text.length,
      durationMs: Date.now() - startedAt
    }));
  } catch (error) {
    await markGenerationJobFailure(
      { ...job, attempts: Number(job.attempts || 0) + 1 },
      error?.message || `Staged ${stage} generation failed.`,
      'Staged generation'
    );
  }
}

function launchQueuedStagedMeetingMinutesStage(jobId) {
  setImmediate(() => {
    runQueuedStagedMeetingMinutesStage(jobId).catch((error) => {
      safeLogError('[Queued staged meeting minutes stage failed]', error, { jobId });
    });
  });
}

module.exports = {
  MEETING_MINUTES_JOB_PIPELINE,
  launchQueuedStagedMeetingMinutesStage,
  stagedStageResumeUrl
};
