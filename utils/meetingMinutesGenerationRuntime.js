'use strict';

// The single live cache and boot identities shared by generation writers, reset paths and read-only status projections. This owner does not schedule provider work.

const { TIMING_INFERENCE_POLICY_VERSION } = require('./meetingMinutesActionTimingInference');
const { meetingAgentGenerationState: generationState } = require('./meetingMinutesAgentGeneration');
const { meetingMinutesAgentPrimaryPrompt } = require('./meetingMinutesAgentPrompts');
const { meetingAgentPromptDetails, meetingAgentTimingAnchor, sanitiseDetails: sanitiseMeetingAgentDetails } = require('./meetingMinutesDraftContext');
const { meetingAgentPassCacheKey } = require('./meetingMinutesPassCache');
const { MEETING_AGENT_STAGE_STEP, meetingAgentStageHasContent, meetingAgentStageInputFingerprint, meetingMinutesAgentHybridEnabled, meetingMinutesAgentSpeculativePipelineEnabled } = require('./meetingMinutesStageProtocol');
const { TIMING_POLICY_VERSION } = require('./meetingMinutesTiming');
const crypto = require('crypto');

// Identifies this process. A generation record still marked running but stamped
// with a different boot id can only be one thing: orphaned by a restart.
const MEETING_AGENT_BOOT_ID = crypto.randomUUID();

// Private staged extraction is deliberately a candidate source rather than a
// user-visible draft. Start it while the reviewer is checking the transcript
// and reuse it across generation requests instead of paying the full staged
// latency after every button press.
const privateStagedCandidateCache = new Map();

const PRIVATE_STAGED_CACHE_MAX_ENTRIES = 60;

const privateActionPrimaryCache = new Map();

const PRIVATE_ACTION_PRIMARY_CACHE_MAX_ENTRIES = 60;

function meetingAgentGenerationState(generation) {
  return generationState(generation, {
    bootId: MEETING_AGENT_BOOT_ID,
    hybridEnabled: meetingMinutesAgentHybridEnabled()
  });
}

function privateStagedCandidateCacheKey(draft, stage) {
  const preparedHash = crypto.createHash('sha256').update(String(draft?.preparedTranscript || '')).digest('hex');
  const details = sanitiseMeetingAgentDetails(draft?.details);
  const inference = stage === 'discussion' ? '' : `:inference-${TIMING_INFERENCE_POLICY_VERSION}`;
  return `${draft?.transcriptSha256 || preparedHash}:${preparedHash}:${details.meetingType || ''}:${details.meetingDate || ''}:${meetingAgentTimingAnchor(draft)}:${TIMING_POLICY_VERSION}:${stage}${inference}`;
}

function prunePrivateStagedCandidateCache(now = Date.now()) {
  for (const [key, entry] of privateStagedCandidateCache) {
    if (Number(entry.expiresAt || 0) <= now) privateStagedCandidateCache.delete(key);
  }
  while (privateStagedCandidateCache.size > PRIVATE_STAGED_CACHE_MAX_ENTRIES) {
    privateStagedCandidateCache.delete(privateStagedCandidateCache.keys().next().value);
  }
}

function meetingAgentActionPrimaryPromptForDraft(draft = {}) {
  return meetingMinutesAgentPrimaryPrompt({
    stage: 'actions',
    transcript: String(draft.preparedTranscript || '').trim(),
    details: meetingAgentPromptDetails(draft),
    steer: draft.steer,
    salientDetails: draft.salientDetails || []
  });
}

function prunePrivateActionPrimaryCache(now = Date.now()) {
  for (const [key, entry] of privateActionPrimaryCache) {
    if (Number(entry.expiresAt || 0) <= now) privateActionPrimaryCache.delete(key);
  }
  while (privateActionPrimaryCache.size > PRIVATE_ACTION_PRIMARY_CACHE_MAX_ENTRIES) {
    privateActionPrimaryCache.delete(privateActionPrimaryCache.keys().next().value);
  }
}

function meetingAgentActionsPrewarmState(draft = {}) {
  // Prewarming is useful UI state only while Discussion is the furthest
  // unlocked stage. Once Actions starts, its normal generation progress takes
  // over and this private implementation detail should disappear.
  if (Number(draft.currentStep || 0) !== MEETING_AGENT_STAGE_STEP.discussion) return null;
  prunePrivateStagedCandidateCache();
  prunePrivateActionPrimaryCache();
  const staged = privateStagedCandidateCache.get(privateStagedCandidateCacheKey(draft, 'actions'));
  const primary = privateActionPrimaryCache.get(meetingAgentPassCacheKey(
    meetingAgentActionPrimaryPromptForDraft(draft)
  ));
  const entries = [staged, primary].filter(Boolean);
  if (!entries.length) return null;
  const preparing = entries.some((entry) => entry.status !== 'ready');
  return {
    status: preparing ? 'preparing' : 'ready',
    startedAt: entries.map((entry) => entry.startedAt).filter(Boolean).sort()[0] || '',
    completedAt: preparing ? '' : entries.map((entry) => entry.completedAt).filter(Boolean).sort().slice(-1)[0] || ''
  };
}

// ---------------------------------------------------------------------------
// Speculative pipeline
// ---------------------------------------------------------------------------

// One private entry per draft and stage, keyed "draftId:stage". An entry holds
// the outcome of running that stage with a specific input fingerprint; the
// real run adopts it only while the draft still has that fingerprint.
const privateStageSpeculations = new Map();

function speculationKey(draftId, stage) {
  return `${String(draftId || '')}:${String(stage || '')}`;
}

const SPECULATION_MAX_ENTRIES = 40;

function pruneStageSpeculations(now = Date.now()) {
  for (const [key, entry] of privateStageSpeculations) {
    if (entry.status !== 'running' && Number(entry.expiresAt || 0) <= now) privateStageSpeculations.delete(key);
  }
  // Results carry their pass caches, so bound what one process holds.
  for (const [key, entry] of privateStageSpeculations) {
    if (privateStageSpeculations.size <= SPECULATION_MAX_ENTRIES) break;
    if (entry.status !== 'running') privateStageSpeculations.delete(key);
  }
}

// The first stage the reviewer will ask for next: an empty stage, or one the
// server has marked outdated after an upstream edit.
function meetingAgentNextSpeculativeStage(draft = {}) {
  const generation = meetingAgentGenerationState(draft.generation);
  if (generation && generation.status === 'running') return '';
  const stale = new Set(Array.isArray(draft.staleStages) ? draft.staleStages : []);
  // A stage that ran and came back empty is finished, not waiting: the next
  // stage is the one to prepare (an empty Actions list still has a summary).
  if (!meetingAgentStageHasContent(draft, 'discussion')) return 'discussion';
  if (!meetingAgentStageHasContent(draft, 'actions') || stale.has('actions')) return 'actions';
  if (!meetingAgentStageHasContent(draft, 'summary') || stale.has('summary')) return 'summary';
  return '';
}

function meetingAgentSpeculationFor(draft = {}, stage = '') {
  pruneStageSpeculations();
  const entry = privateStageSpeculations.get(speculationKey(draft.draftId, stage));
  if (!entry || entry.status === 'failed') return null;
  if (entry.fingerprint !== meetingAgentStageInputFingerprint(draft, stage)) return null;
  return entry;
}

// What the reviewer's screen may say about work happening ahead of them.
function meetingAgentSpeculationState(draft = {}) {
  if (!meetingMinutesAgentSpeculativePipelineEnabled()) return null;
  const stage = meetingAgentNextSpeculativeStage(draft);
  if (!stage) return null;
  const entry = meetingAgentSpeculationFor(draft, stage);
  if (!entry) return null;
  return {
    stage,
    status: entry.status === 'ready' ? 'ready' : 'preparing',
    startedAt: entry.startedAt || '',
    completedAt: entry.status === 'ready' ? entry.completedAt || '' : ''
  };
}

function publicMeetingAgentGeneration(generation) {
  if (!generation) return null;
  const { bootId: _bootId, semanticPolicy: _semanticPolicy, discussionCoveragePolicy: _discussionCoveragePolicy,
    progress: _progress, progressInputHash: _progressInputHash, ...rest } = generation;
  return rest;
}

module.exports = {
  MEETING_AGENT_BOOT_ID,
  PRIVATE_ACTION_PRIMARY_CACHE_MAX_ENTRIES,
  PRIVATE_STAGED_CACHE_MAX_ENTRIES,
  SPECULATION_MAX_ENTRIES,
  meetingAgentActionsPrewarmState,
  meetingAgentGenerationState,
  meetingAgentNextSpeculativeStage,
  meetingAgentSpeculationFor,
  meetingAgentSpeculationState,
  privateActionPrimaryCache,
  privateStageSpeculations,
  privateStagedCandidateCache,
  privateStagedCandidateCacheKey,
  prunePrivateActionPrimaryCache,
  prunePrivateStagedCandidateCache,
  pruneStageSpeculations,
  publicMeetingAgentGeneration,
  speculationKey,
  meetingAgentActionPrimaryPromptForDraft
};
