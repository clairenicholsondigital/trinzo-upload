'use strict';

const { MEETING_AGENT_BOOT_ID, meetingAgentActionsPrewarmState, meetingAgentGenerationState, meetingAgentNextSpeculativeStage, meetingAgentSpeculationFor, meetingAgentSpeculationState, privateActionPrimaryCache, privateStageSpeculations, privateStagedCandidateCache, pruneStageSpeculations, publicMeetingAgentGeneration, speculationKey } = require('./meetingMinutesGenerationRuntime');
const { MEETING_AGENT_RETRY_MS, meetingAgentCallContext } = require('./meetingMinutesAgentTransport');
const { MEETING_AGENT_STAGE_STEP, meetingAgentStageHasContent, meetingAgentStageInputFingerprint, meetingMinutesAgentHybridEnabled, meetingMinutesAgentSpeculativePipelineEnabled } = require('./meetingMinutesStageProtocol');
const { applyStageResultVirtually, meetingAgentCompletedStagePerformance, meetingAgentPreviewSavedActions, meetingAgentRegenerationChanges, meetingAgentUntouchedSpeculationChanges, mergeMeetingAgentGenerationFlags } = require('./meetingMinutesGenerationAdmission');
const { buildProposal } = require('./meetingMinutesProposals');
const { captureDiscussionCoveragePolicy, discussionCoveragePolicyForFingerprint } = require('./meetingMinutesDiscussionCoveragePolicy');
const { captureSemanticPolicy, semanticPolicyForFingerprint } = require('./meetingMinutesSemanticPolicy');
const { clearMeetingMinutesAgentV2MemoryCaches } = require('./meetingMinutesEvidenceContext');
const { clearMiniLMProfileMemoryCache } = require('./canonicalMinutes/minilm');
const { createMeetingMinutesAgentDraft, getMeetingMinutesAgentDraft, linkMeetingMinutesAgentDraftToProject } = require('./db');
const fetch = require('node-fetch');
const { loadOwnedMeetingAgentDraft, sendMeetingAgentFailure } = require('./meetingMinutesDraftHttp');
const { meetingAgentStagePersistenceChanges } = require('./meetingMinutesStagePersistence');
const { meetingAgentStaleStagesAfterGeneration, normaliseMeetingAgentGeneration } = require('./meetingMinutesReviewerState');
const { meetingMinutesAgentText } = require('./meetingMinutesPlainText');
const { normaliseMeetingAgentPassCache } = require('./meetingMinutesPassCache');
const parallelMinutes = require('./meetingMinutesParallel');
const { mergeMeetingAgentProgress, publicMeetingAgentProgress } = require('./meetingMinutesAgentGeneration');
const { preselectRequestedProposal } = require('./meetingMinutesProposalSelection');
const { privateStagedCandidateQueueState } = require('./meetingMinutesCandidatePrewarm');
const { publicMeetingAgentDraft } = require('./meetingMinutesDraftView');
const { requireAuth } = require('./../routes/auth');
const { safeLogError } = require('./apiErrors');
const { saveMeetingAgentDraft } = require('./meetingMinutesDraftPersistence');

// One process authority for scheduling, persistence queues, polling and reset.
const speculationTimers = new Map();

const SPECULATION_TTL_MS = 2 * 60 * 60 * 1000;

const SPECULATION_IDLE_LIMIT_MS = 45 * 60 * 1000;

const SPECULATION_EDIT_DEBOUNCE_MS = Math.max(5000, Number(process.env.MEETING_MINUTES_AGENT_SPECULATION_DEBOUNCE_MS || 30000));

const SPECULATION_MAX_RUNNING = Math.max(1, Math.min(4, Number(process.env.MEETING_MINUTES_AGENT_SPECULATION_MAX_RUNNING || 2)));

// Concurrent Referee batches can finish together and all checkpoint the same
// optimistic draft revision. Queue only the writes; model calls stay parallel.
const meetingAgentDraftWriteQueues = new Map();

const meetingAgentObservedGenerationCompletions = new Set();

// The upload response is the hand-off point: once the draft is persisted,
// start the first minutes stage on the server. This deliberately does not
// depend on a browser request remaining open; a closed tab can only stop
// polling, not the queued work itself.
const parallelMinutesCopies = new Map();

// Runs after the response has already gone back to the reviewer. Same in-process
// pattern as launchQueuedStagedMeetingMinutesStage: this app is a single pm2
// process, so there is no other executor to hand it to.
let activeMeetingAgentBackgroundStages = 0;

// These two functions execute the existing complete generation pipelines.
function createMeetingMinutesGenerationLifecycle(generateHybridMeetingAgentStage, generateMeetingAgentStage) {
const parallelMinutesRunner = parallelMinutes.createRunner({
  getDraft: getMeetingMinutesAgentDraft,
  saveDraft: (draft, userId, changes) => saveMeetingAgentDraft(draft, {authUser:{userId}}, changes),
  bootId: MEETING_AGENT_BOOT_ID,
  serialWrite: meetingAgentSerialDraftWrite
});
// Pass results from any speculation of this stage, whatever its fingerprint.
// Entries are keyed by prompt hash, so a real run reuses only identical calls.
function meetingAgentSpeculationPassCacheSeed(draftId, stage) {
  const entry = privateStageSpeculations.get(speculationKey(draftId, stage));
  const caches = [];
  for (let current = entry; current; current = current.previous) {
    if (Array.isArray(current.passCache) && current.passCache.length) caches.push(current.passCache);
  }
  return caches.flat();
}

function runningStageSpeculationCount() {
  let count = 0;
  for (const entry of privateStageSpeculations.values()) if (entry.status === 'running') count += 1;
  return count;
}

async function persistUntouchedSpeculation(draftId, userId, stage, result, fingerprint) {
  if (!result || !result.changes) return false;
  try {
    return await meetingAgentSerialDraftWrite(draftId, async () => {
      const fresh = await getMeetingMinutesAgentDraft(draftId, userId, { includeTranscript: true });
      if (!fresh) return false;
      const generation = meetingAgentGenerationState(fresh.generation);
      // The reviewer has asked for this stage themselves; that run owns it.
      if (generation && generation.status === 'running') return false;
      if (meetingAgentStageHasContent(fresh, stage)) return false;
      if (meetingAgentStageInputFingerprint(fresh, stage) !== fingerprint) return false;
      // Never move the reviewer: the stage they are on is their business.
      const changes = meetingAgentUntouchedSpeculationChanges(fresh, stage, result.changes);
      const saved = await saveMeetingAgentDraft(fresh, { authUser: { userId } }, {
        ...changes,
        staleStages: meetingAgentStaleStagesAfterGeneration(fresh, fresh, stage, changes)
      });
      console.info(JSON.stringify({
        event: 'meeting_agent_speculation_persisted', journeyId: draftId, stage,
        revision: saved?.revision || null
      }));
      return Boolean(saved);
    });
  } catch (error) {
    // A draft that cannot be filled in silently is not a failure the reviewer
    // needs to see: the result stays in memory and is adopted on arrival.
    safeLogError('[meeting-minutes-agent] speculation persist failed', error);
    return false;
  }
}

function startStageSpeculation(draft = {}, userId = '', options = {}) {
  if (parallelMinutes.isParallel(draft)) return null;
  if (!meetingMinutesAgentSpeculativePipelineEnabled() || !meetingMinutesAgentHybridEnabled()) return null;
  const draftId = String(draft.draftId || '');
  if (!draftId || !String(draft.preparedTranscript || '').trim()) return null;
  const stage = options.stage || meetingAgentNextSpeculativeStage(draft);
  if (!stage) return null;
  const idleMs = Date.now() - new Date(draft.updatedAt || draft.createdAt || Date.now()).getTime();
  if (Number.isFinite(idleMs) && idleMs > SPECULATION_IDLE_LIMIT_MS) return null;
  pruneStageSpeculations();
  const key = speculationKey(draftId, stage);
  const fingerprint = meetingAgentStageInputFingerprint(draft, stage);
  const existing = privateStageSpeculations.get(key);
  if (existing && existing.fingerprint === fingerprint && existing.status !== 'failed') return existing;
  if (runningStageSpeculationCount() >= SPECULATION_MAX_RUNNING) {
    scheduleStageSpeculation(draftId, userId, { delayMs: 15000 });
    return null;
  }
  if (existing && existing.status === 'running') existing.superseded = true;
  const entry = {
    draftId, userId, stage, fingerprint,
    status: 'running', superseded: false, previous: existing || null,
    startedAt: new Date().toISOString(), completedAt: '',
    expiresAt: Date.now() + SPECULATION_TTL_MS,
    progress: { pass: 'starting', message: 'Preparing independent quality checks…', completedPasses: [], callTimings: [], degradedSources: [] },
    preview: null, passCache: null, result: null, error: null, promise: null
  };
  const speculativeDraft = { ...draft, generation: null,
    _semanticPolicy: semanticPolicyForFingerprint(draft),
    _discussionCoveragePolicy: discussionCoveragePolicyForFingerprint(draft) };
  entry.promise = meetingAgentCallContext.run({ background: true, draftId, stage }, () =>
    generateHybridMeetingAgentStage(speculativeDraft, stage, {
      onProgress: async (progress) => { entry.progress = { ...entry.progress, ...progress }; },
      onCheckpoint: async (passCache) => { entry.passCache = normaliseMeetingAgentPassCache(passCache); },
      onPreview: async (preview) => { entry.preview = preview; }
    })
  ).then((result) => {
    entry.status = 'ready';
    entry.result = result;
    entry.completedAt = new Date().toISOString();
    entry.previous = null;
    if (Array.isArray(result?.changes?.passCache)) entry.passCache = normaliseMeetingAgentPassCache(result.changes.passCache);
    console.info(JSON.stringify({
      event: 'meeting_agent_speculation', journeyId: draftId, stage, ok: true,
      elapsedMs: Date.now() - new Date(entry.startedAt).getTime(), superseded: entry.superseded
    }));
    if (!entry.superseded) {
      // Fill the stage in if it is still empty, so a reviewer who uploaded and
      // walked away comes back to finished work rather than an untouched draft.
      // Queued before the chain so the next stage sees this one on disk, and
      // skipped rather than forced if it does not.
      setImmediate(() => {
        persistUntouchedSpeculation(draftId, userId, stage, result, fingerprint)
          .catch((error) => safeLogError('[meeting-minutes-agent] speculation persist failed', error));
      });
      // Carry on down the pipeline from the result the reviewer has not yet
      // asked for; every later adoption is protected by its own fingerprint.
      setImmediate(() => {
        try { startStageSpeculation(applyStageResultVirtually(speculativeDraft, stage, result), userId); } catch (error) {
          safeLogError('[meeting-minutes-agent] speculation chain failed', error);
        }
      });
    }
    return result;
  }).catch((error) => {
    entry.status = 'failed';
    entry.error = error;
    console.warn(JSON.stringify({
      event: 'meeting_agent_speculation', journeyId: draftId, stage, ok: false,
      message: meetingMinutesAgentText(error.message, 300)
    }));
    return null;
  });
  privateStageSpeculations.set(key, entry);
  console.info(JSON.stringify({ event: 'meeting_agent_speculation', journeyId: draftId, stage, started: true }));
  return entry;
}

function scheduleStageSpeculation(draftId, userId, options = {}) {
  if (!meetingMinutesAgentSpeculativePipelineEnabled()) return;
  const key = String(draftId || '');
  if (!key) return;
  clearTimeout(speculationTimers.get(key));
  const delayMs = Math.max(0, Number(options.delayMs ?? SPECULATION_EDIT_DEBOUNCE_MS));
  const timer = setTimeout(async () => {
    speculationTimers.delete(key);
    try {
      const fresh = await getMeetingMinutesAgentDraft(key, userId, { includeTranscript: true });
      if (!fresh) return;
      if (!parallelMinutes.isParallel(fresh)) startStageSpeculation(fresh, userId);
    } catch (error) {
      console.warn(JSON.stringify({ event: 'meeting_agent_speculation', journeyId: key, ok: false, message: meetingMinutesAgentText(error.message, 300) }));
    }
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
  speculationTimers.set(key, timer);
}

function meetingAgentMemoryCacheState() {
  return {
    stagedCandidates: privateStagedCandidateCache.size,
    stagedPreparing: [...privateStagedCandidateCache.values()].filter((entry) => entry.status !== 'ready').length,
    ...privateStagedCandidateQueueState(),
    actionPrimary: privateActionPrimaryCache.size,
    actionPrimaryPreparing: [...privateActionPrimaryCache.values()].filter((entry) => entry.status !== 'ready').length,
    stageSpeculations: privateStageSpeculations.size,
    stageSpeculationsRunning: runningStageSpeculationCount(),
    speculationTimers: speculationTimers.size,
    backgroundStagesActive: activeMeetingAgentBackgroundStages,
    draftWrites: meetingAgentDraftWriteQueues.size,
    observedGenerationCompletions: meetingAgentObservedGenerationCompletions.size
  };
}

async function resetMinutesMiniLmWorkerMemoryCache() {
  const base = new URL(process.env.MINUTES_MINILM_WORKER_URL || 'http://127.0.0.1:8767');
  if (!['127.0.0.1', '::1', 'localhost'].includes(base.hostname)) {
    const error = new Error('The configured MiniLM worker is not local, so its memory cache cannot be reset safely.');
    error.statusCode = 503;
    error.code = 'BASELINE_RESET_WORKER_NOT_LOCAL';
    throw error;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(new URL('/cache/reset', base).toString(), {
      method: 'POST', headers: { Accept: 'application/json' }, signal: controller.signal
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.ok) {
      const error = new Error('The MiniLM worker did not reset its memory cache.');
      error.statusCode = 503;
      error.code = 'BASELINE_RESET_WORKER_FAILED';
      throw error;
    }
    return Number(body.cleared || 0);
  } catch (error) {
    if (error.code && String(error.code).startsWith('BASELINE_RESET_')) throw error;
    const wrapped = new Error('The MiniLM worker could not be reached to reset its memory cache.');
    wrapped.statusCode = 503;
    wrapped.code = 'BASELINE_RESET_WORKER_UNAVAILABLE';
    throw wrapped;
  } finally {
    clearTimeout(timeout);
  }
}

async function clearMeetingAgentMemoryCaches() {
  const before = meetingAgentMemoryCacheState();
  const busy = before.stagedPreparing || before.stagedActive || before.stagedQueued
    || before.actionPrimaryPreparing || before.stageSpeculationsRunning
    || before.backgroundStagesActive || before.draftWrites;
  if (busy) {
    const error = new Error('Meeting-minutes work is still running. Retry the reset after it finishes.');
    error.statusCode = 409;
    error.code = 'BASELINE_RESET_BUSY';
    error.state = before;
    throw error;
  }

  // Reset the separate embedding worker first. If it is unavailable, leave the
  // application caches untouched so a retry has an all-or-nothing contract.
  const workerEmbeddings = await resetMinutesMiniLmWorkerMemoryCache();
  for (const timer of speculationTimers.values()) clearTimeout(timer);
  speculationTimers.clear();
  privateStageSpeculations.clear();
  privateStagedCandidateCache.clear();
  privateActionPrimaryCache.clear();
  meetingAgentObservedGenerationCompletions.clear();
  const canonicalProfiles = clearMiniLMProfileMemoryCache();
  const v2 = clearMeetingMinutesAgentV2MemoryCaches();
  const after = meetingAgentMemoryCacheState();
  console.info(JSON.stringify({ event: 'meeting_agent_memory_cache_reset', before, after, workerEmbeddings, canonicalProfiles }));
  return { cleared: { workerEmbeddings, canonicalProfiles, ...v2 }, before, after };
}

function meetingAgentSerialDraftWrite(draftId, task) {
  const key = String(draftId || '');
  const prior = meetingAgentDraftWriteQueues.get(key) || Promise.resolve();
  const run = prior.catch(() => {}).then(task);
  let tracked;
  tracked = run.finally(() => {
    if (meetingAgentDraftWriteQueues.get(key) === tracked) meetingAgentDraftWriteQueues.delete(key);
  });
  meetingAgentDraftWriteQueues.set(key, tracked);
  return tracked;
}

async function updateMeetingAgentHybridProgress(draftId, userId, stage, patch = {}, expectedGeneration) {
  return meetingAgentSerialDraftWrite(draftId, async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const fresh = await getMeetingMinutesAgentDraft(draftId, userId, { includeTranscript: true });
      if (!fresh) return;
      if (expectedGeneration && (meetingAgentGenerationState(fresh.generation)?.status !== 'running'
        || fresh.generation.stage !== stage || fresh.generation.bootId !== expectedGeneration.bootId
        || fresh.generation.startedAt !== expectedGeneration.startedAt)) return;
      const { passCache, refereeFailureAudit, progress, ...generationPatch } = patch;
      if (progress) generationPatch.progress = mergeMeetingAgentProgress(fresh.generation?.progress, { ...progress, stage });
      else if (generationPatch.pass) {
        const code = generationPatch.completedPasses?.includes(generationPatch.pass) ? 'validated'
          : /referee|check/.test(generationPatch.pass) ? 'checking'
          : generationPatch.pass === 'topic-arranger' ? 'arranging'
          : /primary|recovery/.test(generationPatch.pass) ? 'extracting' : 'preparing';
        generationPatch.progress = mergeMeetingAgentProgress(fresh.generation?.progress, { stage, code });
      }
      if (stage === 'actions' && Array.isArray(generationPatch.previewActions)) {
        const visible = meetingAgentPreviewSavedActions(
          generationPatch.previewActions, fresh.actions, fresh.sourceUnits
        );
        // During regeneration the Actions screen shows the checked preview and
        // the saved register together. Filter only the saved display copy here:
        // otherwise the same deliverable appears twice until the final result
        // is persisted, even though the publication boundary later merges it.
        // Distinct reviewer-authored actions remain visible and untouched.
        generationPatch.previewActions = visible.previewActions;
        generationPatch.previewSavedActions = visible.savedActions;
      }
      const generation = normaliseMeetingAgentGeneration({
        ...(fresh.generation || {}), stage, status: 'running', bootId: MEETING_AGENT_BOOT_ID,
        startedAt: fresh.generation?.startedAt || new Date().toISOString(), ...generationPatch
      });
      try {
        await saveMeetingAgentDraft(fresh, { authUser: { userId } }, {
          generation,
          ...(passCache ? { passCache: normaliseMeetingAgentPassCache(passCache) } : {}),
          ...(refereeFailureAudit ? { qualityState: { ...(fresh.qualityState || {}),
            [stage]: { ...(fresh.qualityState?.[stage] || {}), refereeFailureAudit } } } : {})
        });
        return;
      } catch (error) {
        if (error.statusCode !== 409 || attempt === 2) throw error;
      }
    }
  });
}

const { start: startInitialMeetingAgentProcessing } = require('./meetingMinutesProcessing').createInitialMinutesProcessor({
  saveDraft: saveMeetingAgentDraft,
  runOriginalStage: runMeetingAgentBackgroundStage,
  parallelRunner: parallelMinutesRunner,
  hybridEnabled: meetingMinutesAgentHybridEnabled,
  bootId: MEETING_AGENT_BOOT_ID
});

async function persistMeetingAgentBackgroundStage(options = {}) {
  const {
    draftId, userId, stage, sourceDraft = {}, result = null, failure = null,
    getDraft = getMeetingMinutesAgentDraft,
    saveDraft = (draft, changes) => saveMeetingAgentDraft(draft, { authUser: { userId } }, changes),
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    maxAttempts = 3
  } = options;
  return meetingAgentSerialDraftWrite(draftId, async () => {
    let lastConflict = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const fresh = await getDraft(draftId, userId, { includeTranscript: true });
      if (!fresh) return { saved: null, conflictFields: [], attemptCount: attempt + 1 };
      let conflictFields = [];
      let changes;
      if (result) {
        const scoped = meetingAgentStagePersistenceChanges(sourceDraft, fresh, stage, result.changes || {});
        conflictFields = scoped.conflictFields;
        changes = conflictFields.length
          ? {
            generation: {
              stage, status: 'failed', bootId: MEETING_AGENT_BOOT_ID,
              startedAt: sourceDraft.generation?.startedAt || new Date().toISOString(),
              error: `This ${stage} section changed while generation was running. Your newer edits were kept; generate it again to replace them.`
            }
          }
          : (() => {
            const regeneration = meetingAgentRegenerationChanges(fresh, stage, scoped.changes, result);
            return {
              ...regeneration.changes,
              reviewFlags: regeneration.reviewFlags,
              staleStages: meetingAgentStaleStagesAfterGeneration(fresh, sourceDraft, stage, regeneration.changes),
              currentStep: Math.max(MEETING_AGENT_STAGE_STEP[stage], fresh.currentStep || 0),
              generation: null
            };
          })();
      } else {
        changes = {
          generation: {
            stage, status: 'failed', bootId: MEETING_AGENT_BOOT_ID,
            startedAt: sourceDraft.generation?.startedAt || new Date().toISOString(),
            error: (failure && failure.message) || 'The agent could not complete this request.'
          }
        };
      }
      try {
        const saved = await saveDraft(fresh, changes);
        return { saved, conflictFields, attemptCount: attempt + 1 };
      } catch (error) {
        if (error.statusCode !== 409 || attempt === maxAttempts - 1) throw error;
        lastConflict = error;
        await wait(300 * (attempt + 1));
      }
    }
    throw lastConflict;
  });
}

// A real run adopts a speculative result only while the draft's inputs for
// that stage are byte-for-byte what the speculation used. If it is still in
// flight, the reviewer sees its progress and gets its result; if the inputs
// moved on, the real run happens as before, seeded with any identical passes.
async function adoptStageSpeculation(fresh, stage, draftId, userId) {
  const entry = meetingAgentSpeculationFor(fresh, stage);
  if (!entry) return null;
  const waitedFrom = Date.now();
  if (entry.status === 'running') {
    const forward = async () => {
      try {
        await updateMeetingAgentHybridProgress(draftId, userId, stage, { ...(entry.progress || {}), ...(entry.preview || {}) }, fresh.generation);
      } catch (error) { /* progress is best effort */ }
    };
    await forward();
    const timer = setInterval(forward, 1500);
    try { await entry.promise; } finally { clearInterval(timer); }
  }
  if (entry.status !== 'ready' || !entry.result) return null;
  privateStageSpeculations.delete(speculationKey(draftId, stage));
  console.info(JSON.stringify({
    event: 'meeting_agent_speculation', journeyId: draftId, stage, adopted: true,
    waitedMs: Date.now() - waitedFrom, speculationStartedAt: entry.startedAt, speculationCompletedAt: entry.completedAt
  }));
  return entry;
}

async function runMeetingAgentBackgroundStage(draftId, userId, stage) {
  activeMeetingAgentBackgroundStages += 1;
  try {
  const backgroundStartedAt = Date.now();
  let result = null;
  let failure = null;
  let sourceDraft = null;
  let speculationAdopted = false;
  let expectedGeneration;
  const onStatus = (event) => expectedGeneration?.status === 'running'
    ? updateMeetingAgentHybridProgress(draftId, userId, stage,
      { progress: event }, expectedGeneration).catch(() => {}) : Promise.resolve();
  const hybrid = meetingMinutesAgentHybridEnabled();
  const stageRetryDelays = hybrid ? [] : MEETING_AGENT_RETRY_MS;
  for (let attempt = 0; attempt <= stageRetryDelays.length; attempt += 1) {
    try {
      const fresh = await getMeetingMinutesAgentDraft(draftId, userId, { includeTranscript: true });
      if (!fresh) return;
      sourceDraft = fresh;
      expectedGeneration ||= fresh.generation && { ...fresh.generation };
      let adopted = null;
      if (hybrid && meetingMinutesAgentSpeculativePipelineEnabled()) {
        adopted = await adoptStageSpeculation(fresh, stage, draftId, userId);
        if (!adopted) {
          const seed = meetingAgentSpeculationPassCacheSeed(draftId, stage);
          if (seed.length) {
            fresh.passCache = normaliseMeetingAgentPassCache([...normaliseMeetingAgentPassCache(fresh.passCache), ...seed]);
          }
        }
      }
      speculationAdopted = Boolean(adopted);
      result = adopted
        ? adopted.result
        : hybrid
          ? await generateHybridMeetingAgentStage(fresh, stage, {
            onProgress: (progress) => updateMeetingAgentHybridProgress(draftId, userId, stage, progress, expectedGeneration),
            onCheckpoint: (passCache) => updateMeetingAgentHybridProgress(draftId, userId, stage, { passCache }, expectedGeneration),
            onRefereeFailure: (refereeFailureAudit) => updateMeetingAgentHybridProgress(draftId, userId, stage, { refereeFailureAudit }, expectedGeneration),
            onPreview: (preview) => updateMeetingAgentHybridProgress(draftId, userId, stage, preview, expectedGeneration),
            onStatus
          })
          : await meetingAgentCallContext.run({ ...(meetingAgentCallContext.getStore() || {}), stage, onStatus },
            () => generateMeetingAgentStage(fresh, stage, ''));
      failure = null;
      break;
    } catch (error) {
      failure = error;
      // The [5,15,30]s usage-limit ladder lives in the browser. A background run
      // has no browser, so without repeating it here this path would be strictly
      // less reliable than the button it replaces.
      if (!error.retryable || attempt === stageRetryDelays.length) break;
      onStatus({ code: 'retrying' });
      await new Promise((resolve) => setTimeout(resolve, stageRetryDelays[attempt]));
    }
  }

  const processingElapsedMs = Date.now() - backgroundStartedAt;
  if (result?.changes?.qualityState?.[stage]) {
    result.changes.qualityState[stage] = {
      ...result.changes.qualityState[stage],
      backgroundStartedAt: sourceDraft?.generation?.startedAt || new Date(backgroundStartedAt).toISOString(),
      processingElapsedMs
    };
  }
  if (result && !failure) onStatus({ code: 'saving' });
  const persistenceStartedAt = Date.now();
  const persistence = await persistMeetingAgentBackgroundStage({
    draftId, userId, stage, sourceDraft: sourceDraft || {}, result, failure
  });
  const persistenceElapsedMs = Date.now() - persistenceStartedAt;
  if (persistence?.saved && meetingMinutesAgentSpeculativePipelineEnabled()) {
    scheduleStageSpeculation(draftId, userId, { delayMs: 0 });
  }
  console.info(JSON.stringify({
    event: 'meeting_agent_stage_performance', journeyId: draftId, stage,
    ok: Boolean(result && !failure), processingElapsedMs, persistenceElapsedMs, speculationAdopted,
    totalElapsedMs: Date.now() - backgroundStartedAt,
    telemetry: result?.changes?.qualityState?.[stage]?.telemetry,
    passImpact: result?.changes?.qualityState?.[stage]?.passImpact,
    calls: result?.changes?.qualityState?.[stage]?.callPerformance,
    revision: persistence?.saved?.revision,
    persistenceAttemptCount: Number(persistence?.attemptCount || 0),
    conflictFieldCount: Array.isArray(persistence?.conflictFields) ? persistence.conflictFields.length : 0,
    errorCode: failure ? meetingMinutesAgentText(failure.code, 120) || undefined : undefined
  }));
  } finally {
    activeMeetingAgentBackgroundStages = Math.max(0, activeMeetingAgentBackgroundStages - 1);
  }
}

function registerMeetingMinutesBackgroundGeneration(router) {
router.post('/meeting-minutes-agent/drafts/:draftId/generate-background', requireAuth, async (req, res) => {
  try {
    const stage = String(req.body?.stage || '').trim().toLowerCase();
    if (!Object.hasOwn(MEETING_AGENT_STAGE_STEP, stage)) {
      return res.status(400).json({ ok: false, error: 'Choose discussion, actions or summary.' });
    }
    const draft = await loadOwnedMeetingAgentDraft(req);
    if (Number(req.body?.revision) !== draft.revision) {
      const error = new Error('This draft was updated elsewhere. Reload it before generating again.');
      error.statusCode = 409;
      error.currentDraft = draft;
      throw error;
    }
    if (parallelMinutes.isParallel(draft)) {
      if (parallelMinutesRunner.active.has(String(draft.draftId))) {
        return res.status(202).json({ok:true,generation:publicMeetingAgentDraft(draft).generation,draft:publicMeetingAgentDraft(draft)});
      }
      const saved = await meetingAgentSerialDraftWrite('parallel-start:'+draft.draftId, async () => {
        const copyId = parallelMinutesCopies.get(String(draft.draftId));
        if (copyId && parallelMinutesRunner.active.has(String(copyId))) {
          return getMeetingMinutesAgentDraft(copyId,req.authUser.userId,{includeTranscript:true});
        }
        parallelMinutes.configuration();
        let target = draft;
        if (draft.qualityState?.parallel?.completedAt) {
          const original = await loadOwnedMeetingAgentDraft(req, {includeTranscript:true});
          if (original.revision !== draft.revision) throw Object.assign(new Error('Reload the saved draft before generating another version.'),{statusCode:409});
          target = await createMeetingMinutesAgentDraft({
            userId:req.authUser.userId,title:draft.details?.meetingTitle || draft.title,fileName:draft.fileName,
            rawTranscript:original.rawTranscript,payload:parallelMinutes.initialPayload(draft)
          });
          if (draft.linkedProjectId) await linkMeetingMinutesAgentDraftToProject(target.draftId,req.authUser.userId,draft.linkedProjectId);
        }
        const started = await parallelMinutesRunner.start(target, req.authUser.userId);
        if (target.draftId !== draft.draftId) {
          parallelMinutesCopies.set(String(draft.draftId),target.draftId);
          parallelMinutesRunner.active.get(String(target.draftId))?.finally(()=>parallelMinutesCopies.delete(String(draft.draftId)));
        }
        return started;
      });
      return res.status(202).json({ok:true,generation:publicMeetingAgentDraft(saved).generation,draft:publicMeetingAgentDraft(saved)});
    }
    const existing = meetingAgentGenerationState(draft.generation);
    if (existing && existing.status === 'running') {
      return res.status(202).json({ ok: true, generation: publicMeetingAgentGeneration(existing), draft: publicMeetingAgentDraft(draft) });
    }
    const generation = {
      stage,
      semanticPolicy: captureSemanticPolicy(),
      discussionCoveragePolicy: captureDiscussionCoveragePolicy(),
      status: 'running',
      bootId: MEETING_AGENT_BOOT_ID,
      startedAt: new Date().toISOString(),
      pass: meetingMinutesAgentHybridEnabled() ? 'starting' : '',
      message: meetingMinutesAgentHybridEnabled() ? 'Preparing independent quality checks…' : '',
      completedPasses: [],
      callTimings: [],
      degradedSources: [],
      error: ''
    };
    const saved = await saveMeetingAgentDraft(draft, req, {
      generation,
      currentStep: Math.max(MEETING_AGENT_STAGE_STEP[stage], draft.currentStep || 0),
      selectedStep: Math.max(0, Math.min(
        Math.max(MEETING_AGENT_STAGE_STEP[stage], draft.currentStep || 0),
        Number(req.body?.selectedStep ?? MEETING_AGENT_STAGE_STEP[stage]) || 0
      ))
    });
    const userId = req.authUser?.userId;
    setImmediate(() => {
      runMeetingAgentBackgroundStage(saved.draftId, userId, stage)
        .catch((error) => safeLogError('[meeting-minutes-agent/background] failed', error));
    });
    return res.status(202).json({ ok: true, generation: publicMeetingAgentGeneration(generation), draft: publicMeetingAgentDraft(saved) });
  } catch (error) {
    safeLogError('[meeting-minutes-agent/generate-background] failed', error);
    return sendMeetingAgentFailure(res, error);
  }
});
}

function registerMeetingMinutesGenerationStatus(router) {
router.get('/meeting-minutes-agent/drafts/:draftId/generation', requireAuth, async (req, res) => {
  try {
    const draft = await loadOwnedMeetingAgentDraft(req);
    const generation = meetingAgentGenerationState(draft.generation);
    const running = Boolean(generation && generation.status === 'running');
    const completedPerformance = running ? null : meetingAgentCompletedStagePerformance(draft);
    let observedPerformance;
    if (completedPerformance) {
      const observedAt = new Date().toISOString();
      const pollingOverheadMs = Math.max(0, Date.now() - new Date(draft.updatedAt || observedAt).getTime());
      observedPerformance = {
        stage: completedPerformance.stage,
        processingElapsedMs: Number(completedPerformance.processingElapsedMs
          || completedPerformance.stageElapsedMs || 0),
        persistedAt: draft.updatedAt,
        observedAt,
        pollingOverheadMs
      };
      const observationKey = `${draft.draftId}:${draft.revision}:${completedPerformance.stage}`;
      if (!meetingAgentObservedGenerationCompletions.has(observationKey)) {
        meetingAgentObservedGenerationCompletions.add(observationKey);
        if (meetingAgentObservedGenerationCompletions.size > 500) {
          meetingAgentObservedGenerationCompletions.delete(meetingAgentObservedGenerationCompletions.values().next().value);
        }
        console.info(JSON.stringify({
          event: 'meeting_agent_poll_observed', journeyId: draft.draftId,
          revision: draft.revision, ...observedPerformance
        }));
      }
    }
    return res.json({
      ok: true,
      generation: publicMeetingAgentGeneration(generation),
      progress: publicMeetingAgentProgress(draft, generation),
      actionsPrewarm: meetingAgentActionsPrewarmState(draft),
      speculation: meetingAgentSpeculationState(draft),
      // Carry the draft only once the run is over, so completion is one round trip.
      draft: running ? undefined : publicMeetingAgentDraft(draft),
      performance: observedPerformance
    });
  } catch (error) {
    return sendMeetingAgentFailure(res, error);
  }
});
}

function registerMeetingMinutesGeneration(router) {
router.post('/meeting-minutes-agent/generate', requireAuth, async (req, res) => {
  try {
    const stage = String(req.body?.stage || '').trim().toLowerCase();
    if (!Object.hasOwn(MEETING_AGENT_STAGE_STEP, stage)) {
      return res.status(400).json({ ok: false, error: 'Choose discussion, actions or summary.' });
    }
    const instruction = meetingMinutesAgentText(req.body?.instruction, 4000);
    if (stage === 'summary' && instruction) {
      // buildProposal diffs arrays of rows; there is no meaningful diff for a
      // prose summary, so this stage is edited directly rather than proposed.
      return res.status(400).json({ ok: false, error: 'The summary is edited directly, not through the agent editor.' });
    }
    const draft = await getMeetingMinutesAgentDraft(req.body?.draftId, req.authUser?.userId, { includeTranscript: true });
    if (!draft) return res.status(404).json({ ok: false, error: 'Meeting-minutes draft not found.' });
    if (Number(req.body?.revision) !== draft.revision) {
      const error = new Error('This draft was updated elsewhere. Reload it before generating again.');
      error.statusCode = 409;
      error.currentDraft = draft;
      throw error;
    }
    const result = await generateMeetingAgentStage({ ...draft,
      _semanticPolicy: captureSemanticPolicy(), _discussionCoveragePolicy: captureDiscussionCoveragePolicy() }, stage, req.body?.instruction);
    if (instruction) {
      const before = stage === 'discussion' ? draft.discussion || [] : draft.actions || [];
      const after = stage === 'discussion' ? result.normalised.discussion : result.normalised.actions;
      const proposal = preselectRequestedProposal(buildProposal(stage, before, after));
      const saved = await saveMeetingAgentDraft(draft, req, {
        pendingProposal: proposal,
        reviewFlags: mergeMeetingAgentGenerationFlags(draft.reviewFlags, result.reviewFlags, result.replaceCoverageFlags)
      });
      return res.json({ ok: true, stage, proposal, draft: publicMeetingAgentDraft(saved) });
    }
    const saved = await saveMeetingAgentDraft(draft, req, {
      ...result.changes,
      reviewFlags: mergeMeetingAgentGenerationFlags(draft.reviewFlags, result.reviewFlags, result.replaceCoverageFlags, { stage, changes: result.changes, draft }),
      staleStages: meetingAgentStaleStagesAfterGeneration(draft, draft, stage, result.changes),
      currentStep: Math.max(MEETING_AGENT_STAGE_STEP[stage], draft.currentStep || 0)
    });
    return res.json({ ok: true, stage, draft: publicMeetingAgentDraft(saved) });
  } catch (error) {
    safeLogError('[meeting-minutes-agent/generate] failed', error);
    return sendMeetingAgentFailure(res, error);
  }
});
}

  return {
    startStageSpeculation,
    adoptStageSpeculation,
    meetingAgentSerialDraftWrite,
    persistMeetingAgentBackgroundStage,
    meetingAgentMemoryCacheState,
    clearMeetingAgentMemoryCaches,
    scheduleStageSpeculation,
    startInitialMeetingAgentProcessing,
    registerMeetingMinutesBackgroundGeneration,
    registerMeetingMinutesGenerationStatus,
    registerMeetingMinutesGeneration
  };
}

module.exports = { createMeetingMinutesGenerationLifecycle };
