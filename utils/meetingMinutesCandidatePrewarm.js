'use strict';

const crypto = require('crypto');
const { generatePreparedTrooperStage } = require('./stagedMiniLmTrooper');
const { normaliseSourceUnits } = require('./meetingMinutesSource');
const { sanitiseDetails: sanitiseMeetingAgentDetails, meetingAgentTimingAnchor } = require('./meetingMinutesDraftContext');
const { normaliseStagedCandidateResult, stagedCandidateLedgerFromResult } = require('./meetingMinutesCandidateLedger');
const { stagedGenerationMeetingType } = require('./meetingMinutesStageMeetingType');
const { privateStagedCandidateCache, privateStagedCandidateCacheKey, prunePrivateStagedCandidateCache, privateActionPrimaryCache, prunePrivateActionPrimaryCache, meetingAgentActionPrimaryPromptForDraft } = require('./meetingMinutesGenerationRuntime');
const { meetingAgentPassCacheKey } = require('./meetingMinutesPassCache');
const { meetingAgentEmptyDiscoveryError } = require('./meetingMinutesDiscoveryValidation');
const { askPowerAutomateMeetingMinutesAgentWithRetry } = require('./meetingMinutesAgentTransport');
const { actionCandidateInventory, actionCommitmentChainInventory, actionCommitmentThreadInventory } = require('./meetingMinutesActionCandidateInventory');

const PRIVATE_STAGED_CACHE_TTL_MS = 2 * 60 * 60 * 1000;

const PRIVATE_ACTION_PRIMARY_CACHE_TTL_MS = 2 * 60 * 60 * 1000;

const PRIVATE_STAGED_MAX_CONCURRENCY = Math.max(1, Math.min(2,
  // Two simultaneous staged/Trooper subprocesses compete for the same local
  // worker and external allowance. Serial prewarming is faster in practice
  // because it avoids both branches timing out together.
  Number(process.env.MEETING_MINUTES_AGENT_STAGED_CANDIDATE_CONCURRENCY || 1)));

let privateStagedActive = 0;

const privateStagedQueue = [];

function drainPrivateStagedQueue() {
  while (privateStagedActive < PRIVATE_STAGED_MAX_CONCURRENCY && privateStagedQueue.length) {
    // Discussion is the foreground stage immediately after upload. Do not let
    // speculative action prewarming for an earlier draft starve discussion
    // coverage for another user. Equal-priority jobs retain FIFO ordering.
    privateStagedQueue.sort((left, right) => Number(right.priority || 0) - Number(left.priority || 0)
      || Number(left.queuedAt || 0) - Number(right.queuedAt || 0));
    const job = privateStagedQueue.shift();
    privateStagedActive += 1;
    Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(() => {
      privateStagedActive -= 1;
      drainPrivateStagedQueue();
    });
  }
}

function withPrivateStagedCandidateSlot(task, priority = 0) {
  return new Promise((resolve, reject) => {
    privateStagedQueue.push({ task, resolve, reject, priority, queuedAt: Date.now() });
    drainPrivateStagedQueue();
  });
}

function privateStagedCandidateQueueState() {
  return { stagedActive: privateStagedActive, stagedQueued: privateStagedQueue.length };
}

// The fallback is the full staged provider pipeline owned by the API composition.
// All candidate policy and shared queue/cache state are canonical imports here.
function createMeetingMinutesCandidatePrewarm(runStagedSequenceForEvaluation) {
async function buildPrivateStagedCandidateLedger(draft, stage = '') {
  const requestedStage = ['discussion', 'actions'].includes(stage) ? stage : '';
  if (!requestedStage) {
    const run = await runStagedSequenceForEvaluation(draft.preparedTranscript, { fileName: draft.fileName || 'transcript.txt' });
    return stagedCandidateLedgerFromResult(normaliseStagedCandidateResult(run, draft), draft);
  }
  const details = sanitiseMeetingAgentDetails(draft.details);
  const meetingIdentity = `${details.meetingTitle || ''} ${draft.fileName || ''}`;
  // The public staged parser expects Teams-style speaker/timestamp lines. The
  // Agent's prepared transcript deliberately prefixes stable [Txxxx] IDs,
  // which are useful to the Agent but make that parser report no speakers.
  // Production drafts retain the original upload; the reconstruction keeps
  // tests and migrated drafts functional without exposing it to the browser.
  const stagedTranscript = normaliseSourceUnits(draft.sourceUnits)
    .filter((unit) => unit.classification !== 'remove' || unit.restored)
    .map((unit) => `${unit.speaker}   ${unit.timestamp || '0:00'} ${unit.text}`)
    .join('\n\n');
  const payload = await generatePreparedTrooperStage(requestedStage, stagedTranscript, {
    meetingType: stagedGenerationMeetingType(details.meetingType, meetingIdentity),
    shortRepairConcurrency: 3,
    selectorBatchConcurrency: 2,
    selectorProtocol: /^(?:1|true)$/i.test(process.env.MEETING_MINUTES_AGENT_SELECTOR_PROTOCOL_V1 || '0'),
    selectorFailureSignal: true,
    // Long transcripts routinely finish just beyond the previous 150-second
    // boundary. This work is private and prewarmed, so allow it to finish and
    // populate the cache instead of killing useful work near completion.
    timeoutMs: Number(process.env.MEETING_MINUTES_AGENT_STAGED_CANDIDATE_TIMEOUT_MS || 240000)
  });
  const run = { state: {
    discussion: requestedStage === 'discussion' ? (payload?.screens?.discussion || []) : [],
    actions: requestedStage === 'actions' ? (payload?.screens?.actions || []) : [],
    summary: {}
  } };
  return stagedCandidateLedgerFromResult(normaliseStagedCandidateResult(run, draft), draft);
}

function startPrivateStagedCandidateLedger(draft, stage) {
  prunePrivateStagedCandidateCache();
  const key = privateStagedCandidateCacheKey(draft, stage);
  const existing = privateStagedCandidateCache.get(key);
  if (existing) return existing.promise;
  const entry = {
    expiresAt: Date.now() + PRIVATE_STAGED_CACHE_TTL_MS,
    sourceHash: crypto.createHash('sha256').update(JSON.stringify(normaliseSourceUnits(draft.sourceUnits))).digest('hex'),
    status: 'preparing',
    startedAt: new Date().toISOString(),
    completedAt: '',
    promise: null
  };
  entry.promise = withPrivateStagedCandidateSlot(
    () => buildPrivateStagedCandidateLedger(draft, stage),
    stage === 'discussion' ? 2 : 1
  ).then((value) => {
    entry.value = value;
    entry.status = 'ready';
    entry.completedAt = new Date().toISOString();
    return value;
  }).catch((error) => {
    // Failed work is not cached: a later stage/rerun must be able to retry it.
    if (privateStagedCandidateCache.get(key) === entry) privateStagedCandidateCache.delete(key);
    throw error;
  });
  privateStagedCandidateCache.set(key, entry);
  prunePrivateStagedCandidateCache();
  return entry.promise;
}

async function awaitPrivateStagedCandidateLedger(draft, stage, maxWaitMs = 12000) {
  const promise = startPrivateStagedCandidateLedger(draft, stage);
  if (!Number.isFinite(maxWaitMs) || maxWaitMs <= 0) return [];
  let timer;
  try {
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), maxWaitMs); });
    const value = await Promise.race([promise, timeout]);
    return value === null ? null : value;
  } finally {
    clearTimeout(timer);
  }
}

function startPrivateActionPrimaryPrewarm(draft) {
  prunePrivateActionPrimaryCache();
  const prompt = meetingAgentActionPrimaryPromptForDraft(draft);
  const promptSha256 = meetingAgentPassCacheKey(prompt);
  const existing = privateActionPrimaryCache.get(promptSha256);
  if (existing) return existing.promise;
  const requestId = `actions:primary:${promptSha256.slice(0, 16)}`;
  const deterministicCandidates = actionCandidateInventory(draft.sourceUnits);
  const candidates = [
    ...actionCommitmentChainInventory(draft.sourceUnits, deterministicCandidates),
    ...actionCommitmentThreadInventory(draft.sourceUnits, deterministicCandidates),
    ...deterministicCandidates
  ];
  const entry = {
    expiresAt: Date.now() + PRIVATE_ACTION_PRIMARY_CACHE_TTL_MS,
    status: 'preparing',
    startedAt: new Date().toISOString(),
    completedAt: '',
    promise: null
  };
  entry.promise = askPowerAutomateMeetingMinutesAgentWithRetry(prompt, {
    pass: 'actions:primary', maxAttempts: 3, requestId,
    validateResult: (result) => meetingAgentEmptyDiscoveryError(
      result, 'actions', candidates, draft.sourceUnits,
      { meetingDate: meetingAgentTimingAnchor(draft) }
    )
  }).then((response) => {
    entry.status = 'ready';
    entry.completedAt = new Date().toISOString();
    return {
      result: response.result,
      timings: response.timings || [],
      promptSha256,
      requestId,
      completedAt: entry.completedAt
    };
  }).catch((error) => {
    if (privateActionPrimaryCache.get(promptSha256) === entry) privateActionPrimaryCache.delete(promptSha256);
    throw error;
  });
  privateActionPrimaryCache.set(promptSha256, entry);
  prunePrivateActionPrimaryCache();
  return entry.promise;
}

async function usePrivateActionPrimaryPrewarm(draft, prompt) {
  const promptSha256 = meetingAgentPassCacheKey(prompt);
  const existing = privateActionPrimaryCache.get(promptSha256);
  try {
    return await (existing ? existing.promise : startPrivateActionPrimaryPrewarm(draft));
  } catch (error) {
    return null;
  }
}

function prewarmPrivateStagedCandidateLedgers(draft) {
  // Start only the stage the user is about to request. Action prewarming starts
  // after the discussion draft is ready, when review time can hide its cost.
  // Starting both here allowed speculative action work to block another
  // transcript's foreground discussion on the deliberately serial worker.
  startPrivateStagedCandidateLedger(draft, 'discussion').catch((error) => {
    console.warn(JSON.stringify({ event: 'meeting_agent_staged_prewarm', stage: 'discussion', ok: false, message: error.message }));
  });
}

  return {
    buildPrivateStagedCandidateLedger,
    startPrivateStagedCandidateLedger,
    awaitPrivateStagedCandidateLedger,
    startPrivateActionPrimaryPrewarm,
    usePrivateActionPrimaryPrewarm,
    prewarmPrivateStagedCandidateLedgers
  };
}

module.exports = {
  createMeetingMinutesCandidatePrewarm,
  privateStagedCandidateQueueState
};
