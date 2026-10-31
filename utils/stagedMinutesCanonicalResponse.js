'use strict';

const { safeLogError } = require('./apiErrors');
const { stagedAnalyticsText } = require('./stagedReviewAnalytics');
const fetch = require('node-fetch');
const path = require('path');
const crypto = require('crypto');
const { buildEvidenceBoundStagedActionInventory, unassignedActionsWorthPublishing, readsAsAnActionRecord } = require('./stagedActionRecovery');
const { runCanonicalLiveStage } = require('./canonicalMinutes/liveStages');
const { prepareEvidence } = require('./canonicalMinutes/evidence');
const { polishCanonicalStage, canonicalFallback, addRecoveredActionCandidates, clientReadyPresentation, repairActionWording, repairDiscussionWording, wordingFaults, ownerSupported, unresolvedReference } = require('./canonicalMinutes/trooperPolish');
const { proposeActions, proposeMissedActions } = require('./canonicalMinutes/proposedActions');
const { meetingRecordAdminAction } = require('./canonicalMinutes/semanticStages');
const { proposeDiscussionPoints } = require('./canonicalMinutes/proposedDiscussion');
const { normaliseAttendeeReferences } = require('./entityNormalization');
const { duplicateGroups, encodeViaWorker, cosine, splitDedupeGroupsByOwner } = require('./canonicalMinutes/semanticDedupe');
const { personErrorAssertion } = require('./canonicalMinutes/claimCheck');
const { minutesEnglishFaults } = require('./minutesEnglish');
const { isReviewerAuthored } = require('./canonicalMinutes/state');
const { isPublishableTopicLabel, labelNamesAWorkstream } = require('./canonicalMinutes/topicEditorial');
const { enrichActionReviewCandidate } = require('./canonicalMinutes/actionReviewRanking');
const { normaliseDomainTermsDeep } = require('./domainTerms');
const { polishExecutiveSummaryGrammar } = require('./stagedExecutiveSummaryGrammar');
const { polishInitialUnderstanding } = require('./stagedInitialUnderstandingPolish');
const { assessStagedTranscriptHealth, stagedTranscriptHealthFlag } = require('./stagedTranscriptHealth');
const { isRoutineMeetingAdministrationText, removeRoutineMeetingAdministrationSentences } = require('./meetingAdministration');
const { filterActionsForPresentation } = require('./stagedActionPresentation');
const { buildConfirmedUnderstanding, repairDiscussionForConfirmedUnderstanding } = require('./stagedSemanticAuthority');
const { cleanStagedGeneratedLine, isNoEvidenceDiscussionText, cleanStagedActionText, stagedTokenSimilarity, cleanStagedEvidenceSnippet, canonicalKnownStagedPersonName, transcriptForStagedAI } = require('./stagedMinutesContext');

const TROOPER_STAGE_URL_DEFAULT = 'https://eu.router.trooper.ai/v1/chat/completions';

const TROOPER_STAGE_MODEL_DEFAULT = 'eu_liv_000099';

function cleanStagedExecutiveSummary(value) {
  const cleaned = cleanStagedGeneratedLine(value)
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !/\bthe reviewer should check\b/i.test(sentence))
    .join(' ')
    .trim();
  return isNoEvidenceDiscussionText(cleaned) ? '' : cleaned;
}

async function grammarPolishStagedExecutiveSummary(value) {
  const original = cleanStagedExecutiveSummary(value);
  if (!original) return { text: '', used: false, reason: 'empty_text' };
  return polishExecutiveSummaryGrammar(original, {
    apiKey: process.env.TROOPER_API_KEY,
    model: String(process.env.TROOPER_MODEL || TROOPER_STAGE_MODEL_DEFAULT).trim() || TROOPER_STAGE_MODEL_DEFAULT,
    url: String(process.env.TROOPER_CHAT_COMPLETIONS_URL || TROOPER_STAGE_URL_DEFAULT).trim() || TROOPER_STAGE_URL_DEFAULT,
    fetchImpl: fetch,
    maxTokens: Number(process.env.STAGED_SUMMARY_GRAMMAR_MAX_TOKENS || 700),
    timeoutMs: Number(process.env.STAGED_SUMMARY_GRAMMAR_TIMEOUT_MS || 20000)
  });
}

async function polishStagedInitialUnderstanding(summary, meetingTitle, evidencePack = null, meetingText = '') {
  return polishInitialUnderstanding({
    meetingTitle,
    meetingPurpose: summary?.meetingPurpose,
    objectives: summary?.objectives,
    overallTopics: summary?.overallTopics,
    executiveSummary: summary?.executiveSummary
  }, {
    apiKey: process.env.TROOPER_API_KEY,
    model: String(process.env.TROOPER_MODEL || TROOPER_STAGE_MODEL_DEFAULT).trim() || TROOPER_STAGE_MODEL_DEFAULT,
    url: String(process.env.TROOPER_CHAT_COMPLETIONS_URL || TROOPER_STAGE_URL_DEFAULT).trim() || TROOPER_STAGE_URL_DEFAULT,
    fetchImpl: fetch,
    evidencePack,
    meetingText,
    // 1300/30s with a pack: the same single call carries ~8-10k more prompt tokens and
    // brings back a three-to-five sentence summary, up to eight objectives and now the
    // topic headings too. At 900 the response no longer fit, and the tell was indirect -
    // the router answered 422 json_generation_failed on a truncated object, the retry
    // dropped the pack, and three meetings quietly fell back to deterministic text with a
    // reason that pointed at the wording rather than the size. Without a pack the old
    // budget stands.
    maxTokens: Number(process.env.STAGED_INITIAL_UNDERSTANDING_MAX_TOKENS || (evidencePack ? 1300 : 650)),
    timeoutMs: Number(process.env.STAGED_INITIAL_UNDERSTANDING_TIMEOUT_MS || (evidencePack ? 30000 : 20000))
  });
}

function canonicalConfirmedStages(input = {}) {
  return {
    details: input.confirmedDetails || {},
    summary: input.confirmedSummary || {},
    discussion: Array.isArray(input.confirmedDiscussion) ? input.confirmedDiscussion : [],
    actions: Array.isArray(input.confirmedActions) ? input.confirmedActions : [],
    decisions: Array.isArray(input.confirmedDecisions) ? input.confirmedDecisions : [],
    risks: Array.isArray(input.confirmedRisks) ? input.confirmedRisks : []
  };
}

function stableActionCandidateHash(candidate = {}) {
  const payload = {
    owner: cleanStagedGeneratedLine(candidate.owner || 'Not stated') || 'Not stated',
    action: cleanStagedActionText(candidate.suggestedAction || candidate.action || ''),
    deadline: cleanStagedGeneratedLine(candidate.deadline || 'Not stated') || 'Not stated',
    disposition: cleanStagedGeneratedLine(candidate.reviewDisposition || candidate.confidenceTier || ''),
    evidenceIds: Array.isArray(candidate.evidenceIds) ? candidate.evidenceIds : [],
    sourceTurnIds: Array.isArray(candidate.sourceTurnIds) ? candidate.sourceTurnIds : []
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

function serialiseActionReviewCandidate(item = {}) {
  const evidenceEntries = Array.isArray(item.evidence) ? item.evidence.filter(Boolean) : [];
  const primaryEvidence = evidenceEntries.find((entry) => entry.current || entry.text) || {};
  const evidenceIds = Array.isArray(item.evidenceIds)
    ? item.evidenceIds
    : (Array.isArray(item.evidence)
      ? item.evidence.map((entry) => entry && entry.id).filter(Boolean)
      : []);
  const candidate = enrichActionReviewCandidate({
    owner: item.owner || 'Not stated',
    action: item.action || item.suggestedAction || '',
    suggestedAction: item.suggestedAction || item.action || '',
    deadline: item.deadline || 'Not stated',
    reviewDisposition: item.reviewDisposition || 'review_required',
    evidenceIds,
    sourceTurnIds: Array.isArray(item.sourceTurnIds) ? item.sourceTurnIds : [],
    evidence: item.evidence
  });
  return {
    id: `action-candidate-${stableActionCandidateHash(candidate)}`,
    ...candidate,
    sourceSnippet: cleanStagedGeneratedLine(item.sourceSnippet || primaryEvidence.current || primaryEvidence.text || item.action || item.suggestedAction || ''),
    sourceSpeaker: cleanStagedGeneratedLine(item.sourceSpeaker || primaryEvidence.speaker || '')
  };
}

function attachActionCandidateSourceSnippets(payload = {}) {
  const packedEvidence = (Array.isArray(payload._canonicalEvidencePack) ? payload._canonicalEvidencePack : [])
    .flatMap((pack) => Array.isArray(pack?.evidence) ? pack.evidence : []);
  const evidenceById = new Map(packedEvidence
    .flatMap((entry) => [entry, ...(Array.isArray(entry?.contextWindow) ? entry.contextWindow : [])])
    .filter((entry) => entry?.id)
    .map((entry) => [String(entry.id), entry]));
  const candidateLists = [
    ...(Array.isArray(payload.validationFlags) ? payload.validationFlags : []).map((flag) => flag?.repairCandidates),
    payload.actionReviewCandidates
  ];
  for (const candidates of candidateLists) {
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      const evidence = [
        ...(Array.isArray(candidate.representativeEvidenceIds) ? candidate.representativeEvidenceIds : []),
        ...(Array.isArray(candidate.evidenceIds) ? candidate.evidenceIds : [])
      ]
        .map((id) => evidenceById.get(String(id)))
        .filter(Boolean)
        .map((entry) => ({
          entry,
          snippet: cleanStagedEvidenceSnippet(entry.current || entry.text),
          relevance: stagedTokenSimilarity(candidate.suggestedAction || candidate.action, entry.current || entry.text)
        }))
        .filter((item) => item.snippet)
        .sort((left, right) => right.relevance - left.relevance || left.snippet.length - right.snippet.length)[0]?.entry;
      if (!evidence) continue;
      candidate.sourceSnippet = cleanStagedGeneratedLine(evidence.current || evidence.text);
      candidate.sourceSpeaker = cleanStagedGeneratedLine(evidence.speaker || '');
    }
  }
  return payload;
}

// Topic headings the model named, merged onto the ones the pipeline derived.
//
// A heading is not just a line on the summary screen: the discussion stage allocates
// evidence per topic, so replacing the text and losing the ids would leave the reviewer
// with better headings over empty cards. So a named heading that covers ground the
// pipeline already found REPLACES that topic's wording and keeps its id and evidence; one
// that covers new ground is ADDED with the turns it cited. Nothing the reviewer confirmed
// is touched - that contract is older than this feature and outranks it.
function mergeNamedTopics(summary, namedTopics, confirmedTopics) {
  const text = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').replace(/[.\u2026]+$/, '').trim();
  const named = Array.isArray(namedTopics) ? namedTopics.filter((item) => text(item?.text)) : [];
  if (!named.length || (Array.isArray(confirmedTopics) && confirmedTopics.length)) return {};
  const refs = Array.isArray(summary?.topicRefs) ? summary.topicRefs.map((item) => ({ ...item })) : [];
  const used = new Set();
  for (const topic of named) {
    const ids = new Set(Array.isArray(topic.evidenceIds) ? topic.evidenceIds.map(String) : []);
    let bestIndex = -1;
    let bestOverlap = 0;
    refs.forEach((ref, index) => {
      if (used.has(index)) return;
      const existing = Array.isArray(ref.evidenceIds) ? ref.evidenceIds.map(String) : [];
      if (!existing.length || !ids.size) return;
      const shared = existing.filter((id) => ids.has(id)).length / Math.min(existing.length, ids.size);
      if (shared > bestOverlap) { bestOverlap = shared; bestIndex = index; }
    });
    if (bestIndex >= 0 && bestOverlap >= 0.34) {
      used.add(bestIndex);
      refs[bestIndex] = { ...refs[bestIndex], text: text(topic.text) };
      continue;
    }
    refs.push({ text: text(topic.text), topicId: '', evidenceIds: [...ids] });
  }
  // Additive, deliberately. Letting the named list stand alone was tried and measured: on
  // the Eakin weekly the model named three headings well and the meeting lost four correct
  // derived ones - debug evidence, change control, electrical compliance, cybersecurity -
  // because naming three subjects is not the same as saying the other four were wrong. The
  // model summarises at whatever grain it chooses; the derived labels come from patterns
  // that matched real evidence. A heading is only replaced when a named one demonstrably
  // covers the same turns.
  return { overallTopics: refs.map((ref) => ref.text).filter(Boolean), topicRefs: refs };
}

// Objectives topped up from the topics the model named and the validators accepted.
//
// Deterministic objectives derive from workstreams, and workstreams on informal meetings
// are thin - the domain concepts don't match an allotment committee, and the emergent
// labels that used to fill the gap were quotations and are now refused. The scorecard made
// the cost concrete: the allotment's five expected objectives collapsed to one, for a
// meeting about a water butt, a boundary fence, plot fees, a waiting list, a show and a
// break-in. The named topics for those meetings are good - they passed the citation
// validators and the heading gates - so each one not already covered by an objective
// becomes "Review {topic}.", the same template the deterministic path has always used.
// Composed from a validated heading, not quoted from anywhere.
function topUpObjectivesFromNamedTopics(objectives, namedTopics, limit = 8) {
  const existing = Array.isArray(objectives) ? objectives.slice() : [];
  const text = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  const tokensOf = (value) => new Set((text(value).toLowerCase().match(/[a-z][a-z0-9'\u2019-]{2,}/g) || [])
    .filter((token) => !['the', 'and', 'review', 'confirm', 'agree'].includes(token)));
  for (const topic of Array.isArray(namedTopics) ? namedTopics : []) {
    if (existing.length >= limit) break;
    const label = text(topic?.text || topic);
    if (!label) continue;
    const labelTokens = tokensOf(label);
    if (!labelTokens.size) continue;
    const covered = existing.some((objective) => {
      const objectiveTokens = tokensOf(objective);
      const shared = [...labelTokens].filter((token) => objectiveTokens.has(token)).length;
      return shared / labelTokens.size >= 0.5;
    });
    if (covered) continue;
    const lowered = /^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label;
    existing.push(`Review ${lowered}.`);
  }
  return existing;
}

// The health record: one judgement per generation, built from signals that already exist.
//
// Every silent failure in this area followed the same script - a component degraded, said
// nothing, and the output looked plausible. The summary polish was rejected invisibly and
// the fallback reproduced the thin output that prompted the work; a token ceiling
// presented as a complaint about wording; the wording repair failed over HTTP and nobody
// could tell repaired rows from untouched ones. Each took an afternoon to dig out of pm2
// logs and the database, and each would have been one line here.
//
// The rule for what counts as a degradation is narrow on purpose: a step that chose not
// to run (wrong stage, nothing to do, reviewer already confirmed the text) is quiet,
// because flagging the ordinary path teaches reviewers to ignore the flag - which is the
// exact failure this exists to end. Only a step that TRIED to serve the screen and served
// something lesser instead is a degradation.
const HEALTH_QUIET_REASONS = new Set([
  'Trooper is not used for this stage.',
  'No bounded evidence pack.',
  'No published actions to rewrite.',
  'not_applicable',
  'empty_notes',
  'empty_text',
  'reviewer_confirmed',
  'superseded_by_evidence_polish',
  'purpose_only'
]);

function assessGenerationHealth({ stage, trooper, summaryPolish, grammarPolish, wordingRepair }) {
  const degradations = [];
  const note = (step, reason, label) => degradations.push({ step, reason: String(reason || ''), label });

  if (['discussion', 'actions'].includes(stage) && trooper && !trooper.used && !HEALTH_QUIET_REASONS.has(String(trooper.reason || ''))) {
    note('trooper_rewrite', trooper.reason, 'the evidence-grounded rewrite (deterministic wording served instead)');
  }
  if (stage === 'summary' && summaryPolish?.attempted) {
    const reason = String(summaryPolish.reason || '');
    if (!summaryPolish.used && !HEALTH_QUIET_REASONS.has(reason)) {
      note('summary_polish', reason, 'the summary polish (deterministic summary served instead)');
    }
    if (summaryPolish.truncated) note('summary_polish', 'response_truncated', 'a summary polish response that was cut short by its size limit');
    if (summaryPolish.degraded) note('summary_polish', 'retried_without_evidence', 'the evidence-cited summary (the simpler uncited form served instead)');
  }
  // The grammar pass is judged by consequence, not symmetry with the summary polish. When
  // the summary polish's validator refuses, the screen falls back to the deterministic
  // floor - a genuinely lesser screen, and the original silent incident. When the grammar
  // pass's validator refuses, the text it was HANDED serves unchanged - the guard working,
  // nothing lost - so only a pass that could not run at all counts.
  if (grammarPolish?.attempted && !grammarPolish.used) {
    const reason = String(grammarPolish.reason || '');
    if (/^(?:unavailable|request_failed|timeout)$/.test(reason) || reason.startsWith('http_')) {
      note('summary_grammar', reason, 'the summary grammar pass');
    }
  }
  // The repair failing its guards on a row is not a degradation - those rows carry their
  // own flag. Only a repair that could not run at all is one.
  if (['actions', 'discussion'].includes(stage) && wordingRepair?.attempted > 0 && wordingRepair?.reason) {
    note('wording_repair', wordingRepair.reason, `the wording repair (${wordingRepair.attempted} flagged row${wordingRepair.attempted === 1 ? '' : 's'} published as extracted)`);
  }
  return { served: degradations.length ? 'degraded' : 'full', degradations };
}

// The revision serving this generation. Workers were once found serving three-day-old
// code across several deploys, and nothing in any payload said so; now every generation
// records what it ran as. Read once - the file changes only on deploy, and a deploy
// restarts the process.
let SERVING_REVISION = '';

function servingRevision() {
  if (SERVING_REVISION) return SERVING_REVISION;
  try {
    SERVING_REVISION = require('fs').readFileSync(path.join(__dirname, '..', '.openclaw-deployed-revision'), 'utf8').trim().slice(0, 12) || 'dev';
  } catch {
    SERVING_REVISION = 'dev';
  }
  return SERVING_REVISION;
}

async function canonicalStagedResponse(stage, transcript, input = {}) {
  const generationStartedAt = Date.now();
  // One-run loss attribution (scripts/action_loss_attribution.js). ACTION_TRACE names a
  // file; every snapshot and row-eating mutation in the actions stage is recorded there,
  // so a single scorecard run can say, for each expected action the scorecard missed,
  // which pass lost it and what survived in its place. The stage-level ACTION_FUNNEL tap
  // stops at actionsStage's return value - every pass in THIS function (band merge,
  // claim check, wording repair, dedupe) runs after that, and the recall those passes
  // cost was invisible to both instruments. Dead code when the env var is unset.
  const actionTrace = stage === 'actions' && process.env.ACTION_TRACE
    ? { fileName: transcript.fileName || 'transcript.txt', snapshots: [], proposals: null, mutations: [] }
    : null;
  const traceSnap = (pass, rows) => {
    if (!actionTrace) return;
    actionTrace.snapshots.push({
      pass,
      rows: (Array.isArray(rows) ? rows : []).map((item) => ({
        owner: item.owner || 'Not stated',
        action: String(item.action || ''),
        modelProposed: Boolean(item.modelProposed),
        ownerUnassigned: Boolean(item.ownerUnassigned),
        reviewerAuthored: Boolean(item.reviewerAuthored)
      }))
    });
  };
  const confirmed = canonicalConfirmedStages(input);
  const semanticTranscript = transcriptForStagedAI(transcript, input);
  const transcriptHealth = assessStagedTranscriptHealth(semanticTranscript.text);
  let payload = runCanonicalLiveStage(semanticTranscript.text, {
    stage,
    fileName: transcript.fileName || 'transcript.txt',
    confirmed,
    reviewerGuidance: input.additionalContext || '',
    includeEvidencePack: ['summary', 'discussion', 'actions'].includes(stage)
  });
  // canonicalDiagnostics.entityNames is built from raw Teams speaker labels
  // (liveStages.js), so an invented surname lived here at the source: "Rebecca Cuckoo" was
  // the canonical name every downstream consumer worked from - the repeated_person_name
  // detector, the "people" list threaded into every repair/polish call, and the entity
  // sweep below. Correcting the owner column alone left the reference list itself wrong,
  // so anything correcting discussion or action TEXT against that list had nothing to
  // correct against. Fixed at the source: every consumer downstream inherits it free.
  if (payload?.canonicalDiagnostics?.entityNames) {
    const correctedNames = payload.canonicalDiagnostics.entityNames.map((name) => canonicalKnownStagedPersonName(name) || name);
    if (correctedNames.some((name, index) => name !== payload.canonicalDiagnostics.entityNames[index])) {
      payload = { ...payload, canonicalDiagnostics: { ...payload.canonicalDiagnostics, entityNames: [...new Set(correctedNames)] } };
    }
  }
  // Screen 0. A transcript the parser could only partly read produces thin
  // minutes at every later stage, so the reviewer needs to know before they
  // spend time editing them, not after.
  if (stage === 'details') {
    const healthFlag = stagedTranscriptHealthFlag(transcriptHealth);
    if (healthFlag) payload.validationFlags = [...(payload.validationFlags || []), healthFlag];
  }
  if (stage === 'actions') payload = attachActionCandidateSourceSnippets(payload);
  let unassignedActions = [];
  if (stage === 'actions') {
    const recoveredActions = buildEvidenceBoundStagedActionInventory(semanticTranscript.text);
    // Decided here, before the candidate list is built, so a row that is going to be
    // published does not also appear underneath as something to consider adding. The
    // reviewer seeing the same action twice, once as theirs and once as a suggestion, is
    // its own kind of noise.
    unassignedActions = unassignedActionsWorthPublishing(recoveredActions, payload?.screens?.actions || []);
    // Recovered rows carry NUMERIC turn indices from the recovery parser, while the
    // evidence pack keys everything by evt_* event ids - so the wording repair's evidence
    // window lookup never matched and these rows were repaired blind, with an empty
    // window in the prompt. Map turn index to the event ids of that turn here, where both
    // id schemes are in scope.
    if (unassignedActions.length) {
      const eventsByTurnIndex = new Map();
      for (const event of prepareEvidence(semanticTranscript.text).events) {
        if (!eventsByTurnIndex.has(event.turnIndex)) eventsByTurnIndex.set(event.turnIndex, []);
        eventsByTurnIndex.get(event.turnIndex).push(event.id);
      }
      unassignedActions = unassignedActions.map((item) => {
        const mapped = (Array.isArray(item.evidenceIds) ? item.evidenceIds : [])
          .flatMap((id) => (typeof id === 'number' ? (eventsByTurnIndex.get(id) || []) : [id]));
        return mapped.length ? { ...item, evidenceIds: mapped } : item;
      });
    }
    const promoted = new Set(unassignedActions.map((item) => String(item.action || '').toLowerCase()));
    const stillCandidates = recoveredActions.filter((item) => !promoted.has(String(item.action || '').toLowerCase()));
    payload = addRecoveredActionCandidates(payload, stillCandidates);
    const reviewOnly = stillCandidates.filter((item) => item.reviewDisposition && item.reviewDisposition !== 'confirmed_action');
    if (reviewOnly.length) {
      const counts = reviewOnly.reduce((summary, item) => {
        const key = item.reviewDisposition || 'review_required';
        summary[key] = (summary[key] || 0) + 1;
        return summary;
      }, {});
      const labels = {
        needs_assignment: 'need an owner',
        requirement: 'are requirements rather than agreed actions',
        completed_history: 'look completed or historical',
        review_required: 'need reviewer confirmation'
      };
      payload.validationFlags = [
        ...(Array.isArray(payload.validationFlags) ? payload.validationFlags : []),
        {
          type: 'action_review_candidates',
          severity: 'warning',
          blocking: false,
          message: `${reviewOnly.length} possible follow-up${reviewOnly.length === 1 ? ' needs' : 's need'} a decision: ${Object.entries(counts).map(([key, count]) => `${count} ${labels[key] || 'need review'}`).join(', ')}. Add the real actions and dismiss anything that should not appear in the minutes.`,
          resolutionKey: `action-review-candidates:${crypto.createHash('sha256').update(reviewOnly.map((item) => stableActionCandidateHash(item)).join('|')).digest('hex').slice(0, 16)}`,
          repairCandidates: reviewOnly.map(serialiseActionReviewCandidate)
        }
      ];
    }
  }
  if (stage === 'actions') traceSnap('stage_published', payload?.screens?.actions);
  const canonicalEvidencePack = Array.isArray(payload._canonicalEvidencePack) ? payload._canonicalEvidencePack : [];
  let polished = { payload, used: false, reason: 'Trooper is not used for this stage.' };
  if (['discussion', 'actions'].includes(stage)) {
    try {
      polished = await polishCanonicalStage(payload, { reviewerGuidance: input.additionalContext || '' });
    } catch (error) {
      safeLogError('[Canonical staged Trooper polish failed]', error, { stage });
      const fallback = canonicalFallback(payload);
      polished = { payload: fallback, used: false, reason: error?.message || 'Trooper rewrite failed.' };
    }
  }
  if (stage === 'discussion') {
    const evidence = prepareEvidence(semanticTranscript.text);
    const semanticPreservation = repairDiscussionForConfirmedUnderstanding({
      discussion: polished.payload?.screens?.discussion || [],
      understanding: buildConfirmedUnderstanding(confirmed.summary),
      transcriptText: semanticTranscript.text,
      evidenceEvents: evidence.events
    });
    polished.payload = {
      ...polished.payload,
      screens: {
        ...(polished.payload?.screens || {}),
        discussion: semanticPreservation.discussion
      },
      validationFlags: [
        ...(Array.isArray(polished.payload?.validationFlags)
          ? polished.payload.validationFlags.filter((flag) => flag.type !== 'reviewer_confirmed_fact_not_preserved')
          : []),
        ...semanticPreservation.validationFlags
      ],
      telemetryPreview: {
        ...(polished.payload?.telemetryPreview || {}),
        reviewerConfirmedFactPreservationAfterPolish: semanticPreservation.telemetry
      }
    };
  }
  if (stage === 'actions') {
    // Published after the rewrite, not before it. These records are already composed - the
    // recovery rules built them from cited turns and they match the human minutes almost
    // word for word - so there is nothing for the polish to improve and a real risk it
    // drops them, since its own contract tells it requirements are not final actions.
    const published = polished.payload?.screens?.actions || [];
    const unassigned = unassignedActions;
    if (unassigned.length) {
      polished.payload = {
        ...polished.payload,
        screens: { ...(polished.payload?.screens || {}), actions: [...published, ...unassigned] },
        validationFlags: [
          ...(Array.isArray(polished.payload?.validationFlags) ? polished.payload.validationFlags : []),
          {
            type: 'actions_need_an_owner',
            severity: 'warning',
            blocking: false,
            message: `${unassigned.length} action${unassigned.length === 1 ? '' : 's'} below ${unassigned.length === 1 ? 'has' : 'have'} no owner: the meeting agreed the work without naming anybody. Assign ${unassigned.length === 1 ? 'it' : 'them'} before sharing, or delete ${unassigned.length === 1 ? 'it' : 'them'} if ${unassigned.length === 1 ? 'it is' : 'they are'} not yours to track.`,
            resolutionKey: `actions-need-an-owner:${crypto.createHash('sha256').update(unassigned.map((item) => item.action).join('|')).digest('hex').slice(0, 16)}`
          }
        ]
      };
    }
  }
  // Discovery by proposal, restraint by validation.
  //
  // The deterministic layer reached 29 of 102 ground-truth actions and four attempts to
  // tune its gates recovered none; one plain request to the model reached 39-40. So the
  // model proposes here, and every veto stays deterministic: a proposal must quote a turn
  // that resolves to THIS transcript or it is refused, an owner the transcript never names
  // becomes "Not stated", and an option the meeting never agreed is filed as considered
  // rather than published as a commitment.
  //
  // Merged after the rewrite for the same reason the recovered rows are: these records are
  // already composed against cited turns, and applyActionRewrite's contract would treat
  // them as candidates rather than final rows.
  let actionProposals = { agreed: [], requirements: [], considered: [], ungrounded: [], reason: 'not_attempted' };
  if (stage === 'actions') {
    // Same parse the stage itself ran on, so a quote resolves against the events the
    // pipeline actually saw rather than a second, differently-parsed view of the meeting.
    actionProposals = await proposeActions(semanticTranscript.text, prepareEvidence(semanticTranscript.text), {});
    const existing = polished.payload?.screens?.actions || [];
    traceSnap('after_polish', existing);
    if (actionTrace) {
      const population = (items) => (Array.isArray(items) ? items : []).map((item) => ({
        owner: item.owner || 'Not stated', action: String(item.action || '')
      }));
      actionTrace.proposals = {
        agreed: population(actionProposals.agreed),
        requirements: population(actionProposals.requirements),
        considered: population(actionProposals.considered),
        ungrounded: population(actionProposals.ungrounded)
      };
    }
    // Same duplicate rule the recovery path uses, so a proposal cannot restate a row the
    // deterministic layer already published.
    const seen = existing.map((item) => new Set(String(item.action || '').toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || []));
    const isNew = (item) => {
      const tokens = new Set(String(item.action || '').toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || []);
      if (!tokens.size) return false;
      return !seen.some((other) => {
        if (!other.size) return false;
        let shared = 0;
        for (const token of tokens) if (other.has(token)) shared += 1;
        return shared / Math.min(tokens.size, other.size) >= 0.6;
      });
    };
    // Proposals carry selectionFinal so the wording gate cannot remove them, which also
    // means no quality bar applies unless one is applied here. The content bar is the same
    // predicate recovered rows already pass - an instruction of 3-26 words, opening on a
    // verb rather than a name or pronoun, with a concrete object - so a vague proposal
    // ("Limit risk for them", "Think about how to execute the study") is held back as a
    // candidate rather than published as work. This is a CONTENT check, not a wording one:
    // it asks whether the row states a task, never whether it is phrased nicely.
    // meetingRecordAdminAction: the deterministic path already refuses "update the
    // minutes"-class rows via reviewCandidateNoise, but the model proposes the same
    // commitment independently and this path was its way back in.
    const proposalIsPublishable = (item) => readsAsAnActionRecord(String(item.action || ''))
      && !meetingRecordAdminAction(String(item.action || ''));
    // The model sometimes proposes the same commitment twice in different words. Deduped
    // against each other on the same overlap rule used against the deterministic rows, so
    // one commitment produces one row.
    const distinct = [];
    for (const item of [...actionProposals.agreed, ...actionProposals.requirements]) {
      const tokens = new Set(String(item.action || '').toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || []);
      if (!tokens.size) continue;
      const duplicate = distinct.some((other) => {
        let shared = 0;
        for (const token of tokens) if (other.tokens.has(token)) shared += 1;
        return shared / Math.min(tokens.size, other.tokens.size) >= 0.6;
      });
      if (!duplicate) distinct.push({ item, tokens });
    }
    const heldBack = [];
    // The paraphrase band, closed at its source. isNew drops a proposal that overlaps an
    // existing row at >= 0.6; the corroboration filter keeps a deterministic row that a
    // proposal overlaps at >= 0.34. Between the two, the same commitment published twice,
    // once in each wording - Abbott's "Provide the applicable classifications and an
    // overview of the products" beside "Provide overall view of products". A proposal in
    // that band is now treated as the same commitment: its minutes-English wording
    // REPLACES the deterministic row's, the row keeps its owner when the proposal lacks
    // one, and the evidence of both is united on one row.
    const bandOverlap = (a, b) => {
      if (!a.size || !b.size) return 0;
      let shared = 0;
      for (const token of a) if (b.has(token)) shared += 1;
      return shared / Math.min(a.size, b.size);
    };
    const replacements = new Map();
    const bandMerges = [];
    const isBandMatch = (item) => {
      // BAND_MERGE=0 reverts a proposal in the band to the normal isNew/publishable path:
      // worst case a visible duplicate on the screen, never a silently replaced wording.
      if (process.env.BAND_MERGE === '0') return false;
      const tokens = new Set(String(item.action || '').toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || []);
      if (!tokens.size) return false;
      for (let index = 0; index < existing.length; index += 1) {
        if (replacements.has(index)) continue;
        const row = existing[index];
        if (row.reviewerAuthored) continue;
        // Different real owners are different commitments, whatever the words say.
        const rowOwner = String(row.owner || 'Not stated');
        const itemOwner = String(item.owner || 'Not stated');
        if (rowOwner !== 'Not stated' && itemOwner !== 'Not stated' && rowOwner !== itemOwner) continue;
        const overlap = bandOverlap(tokens, new Set(String(row.action || '').toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || []));
        if (overlap >= 0.34 && overlap < 0.6) {
          replacements.set(index, {
            ...row,
            action: item.action,
            owner: rowOwner !== 'Not stated' ? rowOwner : itemOwner,
            evidenceIds: [...new Set([...(row.evidenceIds || []), ...(item.evidenceIds || [])])],
            modelProposed: true,
            wordingRepaired: true
          });
          bandMerges.push({
            before: String(row.action || ''),
            after: String(item.action || ''),
            owner: rowOwner !== 'Not stated' ? rowOwner : itemOwner,
            overlap: Number(overlap.toFixed(3))
          });
          return true;
        }
      }
      return false;
    };
    const added = distinct.map((entry) => entry.item).filter(isNew).filter((item) => {
      if (isBandMatch(item)) return false;
      if (proposalIsPublishable(item)) return true;
      heldBack.push(item);
      return false;
    }).map((item) => ({
      owner: item.owner,
      action: item.action,
      deadline: 'Not stated',
      evidenceIds: item.evidenceIds,
      ownerUnassigned: item.owner === 'Not stated',
      modelProposed: true,
      // Composed against a cited turn and already checked for grounding and owner safety,
      // so the presentation wording gate must not silently remove it - the same treatment
      // deterministically selected rows get. Without this, Abbott produced seven grounded
      // proposals and published two: the gate dropped five real actions on wording alone.
      selectionFinal: true,
      reviewDisposition: item.disposition === 'requirement' ? 'requirement' : 'confirmed_action'
    }));
    // Corroboration filter, applied only when the proposal call actually succeeded.
    //
    // The model reads the whole transcript and lists everything actionable in it. A
    // deterministic row with no counterpart anywhere in that reading - not among the
    // agreed items, the requirements, the options, or even the proposals refused for
    // grounding - is a row the model saw the evidence for and did not think was work.
    // That is what "Prepare the response to the cars" and "Update the ports table for the
    // new set of minutes" are: mis-transcribed fragments the pattern layer shaped into
    // instructions. Never applied when proposals were unavailable, because then the
    // absence of corroboration means nothing.
    const everythingProposed = [
      ...actionProposals.agreed, ...actionProposals.requirements,
      ...actionProposals.considered, ...(actionProposals.ungrounded || [])
    ].map((item) => new Set(String(item.action || '').toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || []));
    const corroborated = (item) => {
      if (item.reviewerAuthored || item.ownerUnassigned) return true;
      const tokens = new Set(String(item.action || '').toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || []);
      if (!tokens.size) return false;
      return everythingProposed.some((other) => {
        if (!other.size) return false;
        let shared = 0;
        for (const token of tokens) if (other.has(token)) shared += 1;
        return shared / Math.min(tokens.size, other.size) >= 0.34;
      });
    };
    // The verdict is deferred, not skipped. One reading is one sample: the loss
    // attribution measured six real expected actions dropped here because the single
    // reading happened not to mention them ("Continue updating the risk management
    // plan", "Get a quote from St John Ambulance"). The completeness sweep below is a
    // SECOND independent reading, so a row it names is corroborated after all - and a
    // row neither reading names is still exactly what this filter was built to remove.
    // Rows are withheld here and either restored or dropped once the sweep has spoken.
    const withheld = new Map();
    const corroborationRestored = [];
    const keptExisting = (process.env.ACTION_CORROBORATION === '0' || !actionProposals.agreed.length
      ? existing.map((item, index) => replacements.get(index) || item)
      : existing.map((item, index) => replacements.get(index) || item).filter((item, index) => {
        if (replacements.has(index) || corroborated(item)) return true;
        withheld.set(index, item);
        return false;
      }));
    const uncorroborated = [...withheld.values()];
    if (added.length || actionProposals.considered.length || uncorroborated.length || replacements.size) {
      polished.payload = {
        ...polished.payload,
        screens: {
          ...(polished.payload?.screens || {}),
          actions: [...keptExisting, ...added],
          // The third bucket. A meeting that weighed options and agreed nothing produced no
          // actions and plenty of content, and forcing that into the actions table was how
          // a residents' parking meeting published seven commitments nobody made.
          consideredOptions: actionProposals.considered.map((item) => ({
            option: item.action, raisedBy: item.owner, evidenceIds: item.evidenceIds
          }))
        }
      };
    }
    // `applied` records whether the guard above actually took the merges. It always does
    // now that replacements.size is part of the condition - before that, a generation
    // where EVERY distinct proposal was a band match silently discarded the replacements.
    const proposalMergeApplied = Boolean(added.length || actionProposals.considered.length || uncorroborated.length || replacements.size);
    if (bandMerges.length) {
      console.log(JSON.stringify({ event: 'staged_band_merge', stage: 'actions', applied: proposalMergeApplied, merges: bandMerges }));
    }
    if (actionTrace) {
      for (const merge of bandMerges) actionTrace.mutations.push({ type: 'band_replace', applied: proposalMergeApplied, ...merge });
      for (const item of heldBack) actionTrace.mutations.push({ type: 'held_back', owner: item.owner || 'Not stated', action: String(item.action || '') });
    }
    traceSnap('after_proposal_merge', polished.payload?.screens?.actions);
    // The completeness sweep: one reading of a transcript is one sample, and the loss
    // attribution measured 23 of 53 missing expected actions as never discovered by any
    // source plus 5 more eaten by the corroboration filter because that single reading
    // happened not to mention them. A second call sees what is already captured and may
    // only name commitments NOT covered; everything it returns faces the same referee
    // (verbatim quote grounding, owner resolution, content bar, duplicate rule), and the
    // claim check and dedupe still run after it. Skipped entirely on the no-decision
    // shape, where a "what's missing" question invites invention. The gate is the FIRST
    // reading's own disposition judgement: a meeting whose full-attention reading found
    // ZERO agreed items is a meeting that agreed nothing, and the sweep does not run -
    // measured directly on the parking fixture, where rows awaiting the presentation
    // gate's cull made any published-row-count guard see work that was never real, the
    // sweep ran, and two "commitments" were published for a meeting that agreed none.
    // ACTION_COMPLETENESS_SWEEP=0 disables.
    if (process.env.ACTION_COMPLETENESS_SWEEP !== '0' && !actionProposals.reason && actionProposals.agreed.length) {
      const currentRows = polished.payload?.screens?.actions || [];
      {
        const sweep = await proposeMissedActions(semanticTranscript.text, prepareEvidence(semanticTranscript.text), currentRows.map((item) => ({ owner: item.owner, action: item.action })), {});
        const currentTokens = currentRows.map((item) => new Set(String(item.action || '').toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || []));
        const coveredByCurrent = (item) => {
          const tokens = new Set(String(item.action || '').toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || []);
          if (!tokens.size) return true;
          return currentTokens.some((other) => {
            if (!other.size) return false;
            let shared = 0;
            for (const token of tokens) if (other.has(token)) shared += 1;
            return shared / Math.min(tokens.size, other.size) >= 0.6;
          });
        };
        // Disposition consistency: the first reading saw the whole meeting with its
        // attention on agreed-vs-considered, and an item it filed as an OPTION must not
        // come back through the sweep re-badged as a commitment. Measured: the sweep
        // re-proposed "Think about parking" - filed considered by the first reading,
        // correctly - as an agreed item on the no-decision fixture.
        const consideredTokens = actionProposals.considered.map((item) => new Set(String(item.action || '').toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || []));
        const consideredByFirstReading = (item) => {
          const tokens = new Set(String(item.action || '').toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || []);
          if (!tokens.size) return false;
          return consideredTokens.some((other) => {
            if (!other.size) return false;
            let shared = 0;
            for (const token of tokens) if (other.has(token)) shared += 1;
            return shared / Math.min(tokens.size, other.size) >= 0.6;
          });
        };
        const sweepRefused = [];
        const sweepRows = [...sweep.agreed, ...sweep.requirements].filter((item) => {
          if (coveredByCurrent(item)) { sweepRefused.push({ action: item.action, reason: 'already_covered' }); return false; }
          if (consideredByFirstReading(item)) { sweepRefused.push({ action: item.action, reason: 'considered_by_first_reading' }); return false; }
          if (!proposalIsPublishable(item)) { sweepRefused.push({ action: item.action, reason: 'content_bar' }); return false; }
          return true;
        }).map((item) => ({
          owner: item.owner,
          action: item.action,
          deadline: 'Not stated',
          evidenceIds: item.evidenceIds,
          ownerUnassigned: item.owner === 'Not stated',
          modelProposed: true,
          completenessSweep: true,
          selectionFinal: true,
          reviewDisposition: item.disposition === 'requirement' ? 'requirement' : 'confirmed_action'
        }));
        if (sweepRows.length || sweepRefused.length || (sweep.ungrounded || []).length) {
          console.log(JSON.stringify({
            event: 'staged_completeness_sweep',
            added: sweepRows.map((item) => item.action),
            refused: sweepRefused,
            ungrounded: (sweep.ungrounded || []).length
          }));
        }
        // The withheld rows' second chance. A row the corroboration filter could not
        // find in the FIRST reading is restored when the sweep's reading names it -
        // two independent readings both seeing work is corroboration, and the rows
        // neither reading names are still dropped, which is the whole point of the
        // filter. Skipped when the sweep already published the same content as a row
        // of its own, so a rescue never produces a duplicate.
        const sweepUniverse = [...sweep.agreed, ...sweep.requirements, ...sweep.considered, ...(sweep.ungrounded || [])]
          .map((item) => new Set(String(item.action || '').toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || []));
        const sweepRowTokens = sweepRows.map((item) => new Set(String(item.action || '').toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || []));
        const overlapAgainst = (tokens, others, bar) => others.some((other) => {
          if (!other.size || !tokens.size) return false;
          let shared = 0;
          for (const token of tokens) if (other.has(token)) shared += 1;
          return shared / Math.min(tokens.size, other.size) >= bar;
        });
        for (const [index, item] of withheld) {
          const tokens = new Set(String(item.action || '').toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || []);
          if (!overlapAgainst(tokens, sweepUniverse, 0.34)) continue;
          if (overlapAgainst(tokens, sweepRowTokens, 0.6)) continue;
          corroborationRestored.push(item);
          withheld.delete(index);
        }
        if (sweepRows.length || corroborationRestored.length) {
          polished.payload = {
            ...polished.payload,
            screens: { ...(polished.payload?.screens || {}), actions: [...keptExisting, ...corroborationRestored, ...added, ...sweepRows] }
          };
        }
        traceSnap('after_completeness_sweep', polished.payload?.screens?.actions);
      }
    }
    // Reported after both readings have spoken, so the line says what was actually
    // dropped rather than what was provisionally withheld.
    if (withheld.size || corroborationRestored.length) {
      console.log(JSON.stringify({
        event: 'staged_corroboration',
        stage: 'actions',
        dropped: [...withheld.values()].map((item) => String(item.action || '')),
        restoredBySweep: corroborationRestored.map((item) => String(item.action || ''))
      }));
    }
    if (actionTrace) {
      for (const item of withheld.values()) actionTrace.mutations.push({ type: 'corroboration_drop', owner: item.owner || 'Not stated', action: String(item.action || '') });
      for (const item of corroborationRestored) actionTrace.mutations.push({ type: 'corroboration_restored', owner: item.owner || 'Not stated', action: String(item.action || '') });
    }
  }
  let result = clientReadyPresentation(polished.payload);
  if (stage === 'actions' && Array.isArray(result?.screens?.actions)) {
    // The owner is a person, and the known-people registry is the authority on how that
    // person's name is spelled. Teams wrote "Rebecca Cuckoo" 388 times across this corpus
    // where the attendee is Rebecca Gill; the mismatch was detected and only warned about,
    // so the invented surname reached the owner column. canonicalKnownStagedPersonName
    // resolves it, and declines when two known people share a first name.
    result = {
      ...result,
      screens: {
        ...result.screens,
        actions: result.screens.actions.map((item) => {
          const owner = canonicalKnownStagedPersonName(item.owner || '');
          return owner && owner !== item.owner ? { ...item, owner } : item;
        })
      }
    };
  }
  if (stage === 'actions' && canonicalEvidencePack.length) {
    result = attachActionCandidateSourceSnippets({ ...result, _canonicalEvidencePack: canonicalEvidencePack });
    delete result._canonicalEvidencePack;
  }
  // Wording repair runs on what would otherwise ship: after the presentation pass, after the
  // unassigned-action merge, on the exact rows the reviewer would have read. Rows with clean
  // wording cost nothing, because the repair only fires when at least one row is broken.
  let actionWordingRepair = { repaired: 0, attempted: 0 };
  if (stage === 'actions') {
    traceSnap('after_presentation', result?.screens?.actions);
    // The participant list travels with the repair so the repeated_person_name detector
    // can actually fire on this path - wordingFaults without options.people can never
    // detect a doubled roster name, whatever the row says.
    actionWordingRepair = await repairActionWording(result, canonicalEvidencePack, {
      people: result?.canonicalDiagnostics?.entityNames || [],
      // The whole meeting, so a rewrite's context window can reach the later turn where
      // the meeting summarises the same thing and the neighbours that disambiguate a
      // garbled phrase. The evidence pack carries only each row's own cited turns.
      allEvents: prepareEvidence(semanticTranscript.text).events
    });
    result = actionWordingRepair.payload || result;
    const stillBroken = (result?.screens?.actions || []).filter((item) => wordingFaults(String(item.action || '')).length);
    if (stillBroken.length) {
      result = {
        ...result,
        validationFlags: [
          ...(Array.isArray(result.validationFlags) ? result.validationFlags : []),
          {
            type: 'action_wording_needs_review',
            severity: 'warning',
            blocking: false,
            // Never silently. A row we could not phrase properly still reaches the reviewer,
            // because deleting a real commitment to keep the prose tidy is the worse trade -
            // but it is pointed at rather than left to be noticed.
            message: `${stillBroken.length} action${stillBroken.length === 1 ? '' : 's'} below still read${stillBroken.length === 1 ? 's' : ''} like speech rather than a minute. The work is real; the wording needs a pass before sharing.`,
            resolutionKey: `action-wording-needs-review:${crypto.createHash('sha256').update(stillBroken.map((item) => item.action).join('|')).digest('hex').slice(0, 16)}`
          }
        ]
      };
    }
    // A last, whole-screen sweep for an invented surname. The owner column is corrected
    // above (canonicalKnownStagedPersonName), but the ACTION TEXT can carry a name too -
    // "Ask Rebecca Cuckoo to review it" - and that text is written by three different
    // sources (deterministic selection, the model rewrite, the model proposal), each
    // reading the raw transcript rather than a normalised copy. One sweep over the
    // finished rows catches every source at once rather than patching each upstream.
    const actionEntityNames = result?.canonicalDiagnostics?.entityNames || [];
    if (actionEntityNames.length) {
      result = {
        ...result,
        screens: {
          ...result.screens,
          actions: (result.screens.actions || []).map((item) => {
            const action = normaliseAttendeeReferences(item.action, actionEntityNames).text;
            return action !== item.action ? { ...item, action } : item;
          })
        }
      };
    }
    traceSnap('after_wording_repair', result?.screens?.actions);
    // A named person's cognitive error is not minutes content, and a record that asserts
    // more than its evidence supports is not either. "David Didsbury misinterpreted the
    // software." came from "Or I misinterpreted the software" - a speaker walking back
    // their own guess - and "Compute a firm decision on the mute aspect" came from the
    // garbled "if we can compute a firm on that mute aspect". Both are grammatical, both
    // cite real turns, both are unique: nothing else in the pipeline asks whether the
    // claim is true to its evidence. Only an explicit "unsupported" removes a row.
    if (process.env.CLAIM_CHECK !== '0' && (result?.screens?.actions || []).length) {
      const rows = result.screens.actions;
      const allEvents = prepareEvidence(semanticTranscript.text).events;
      const byId = new Map(allEvents.map((event) => [String(event.id), String(event.text || '').replace(/\s+/g, ' ').trim()]));
      const windowFor = (item) => (item.evidenceIds || []).map((id) => byId.get(String(id))).filter(Boolean).slice(0, 4).join(' ');
      const dropped = [];
      const kept = rows.filter((item) => {
        if (item.reviewerAuthored) return true;
        if (personErrorAssertion(item.action)) { dropped.push(item.action); return false; }
        return true;
      });
      if (dropped.length) {
        console.log(JSON.stringify({ event: 'staged_claim_check', stage: 'actions', dropped }));
        if (actionTrace) for (const action of dropped) actionTrace.mutations.push({ type: 'claim_drop', action });
        result = { ...result, screens: { ...result.screens, actions: kept } };
      }
    }
    traceSnap('after_claim_check', result?.screens?.actions);
    // Final semantic near-duplicate pass, the safety net behind the paraphrase-band
    // merge: rows the lexical rules cannot see as the same commitment. Threshold 0.80 -
    // above every observed distinct pair on the reviewer-named fixtures - so only
    // near-restatements merge, and judgement calls ("thirty-second intro cap" beside
    // "drop the nervous comment") stay on the screen. Rows with different real owners
    // never merge; reviewer-authored rows are never dropped; the survivor is chosen by
    // owner > minutes-English wording > earliest, and inherits the dropped rows'
    // evidence. DEDUP_PASS=0 disables.
    if (process.env.DEDUP_PASS !== '0' && (result?.screens?.actions || []).length > 1) {
      const rows = result.screens.actions;
      const dedupe = await duplicateGroups(rows.map((item) => String(item.action || '')));
      const drop = new Set();
      const dropRecords = [];
      for (const group of dedupe.groups) {
        const members = group.filter((index) => !rows[index].reviewerAuthored);
        // Split by real owner: only same-owner (or ownerless) members may merge, and an
        // ownerless row joins a named cluster only on scored-pair evidence - with two
        // named owners in a group it must not be absorbed into an arbitrary one.
        const clusters = splitDedupeGroupsByOwner(members, (index) => rows[index].owner, dedupe.pairs);
        for (const cluster of clusters) {
          if (cluster.length < 2) continue;
          const survivor = [...cluster].sort((a, b) => {
            const ownerA = String(rows[a].owner || 'Not stated') !== 'Not stated' ? 0 : 1;
            const ownerB = String(rows[b].owner || 'Not stated') !== 'Not stated' ? 0 : 1;
            if (ownerA !== ownerB) return ownerA - ownerB;
            const polishedA = rows[a].wordingRepaired || rows[a].modelProposed ? 0 : 1;
            const polishedB = rows[b].wordingRepaired || rows[b].modelProposed ? 0 : 1;
            if (polishedA !== polishedB) return polishedA - polishedB;
            return a - b;
          })[0];
          const merged = [...new Set(cluster.flatMap((index) => rows[index].evidenceIds || []))];
          rows[survivor] = { ...rows[survivor], evidenceIds: merged };
          for (const index of cluster) {
            if (index === survivor) continue;
            drop.add(index);
            dropRecords.push({
              dropped: String(rows[index].action || ''),
              owner: rows[index].owner || 'Not stated',
              survivor: String(rows[survivor].action || ''),
              survivorOwner: rows[survivor].owner || 'Not stated'
            });
          }
        }
      }
      if (drop.size) {
        // Auditable, because a merge that cannot be audited is a merge that hides a bug:
        // one greppable line per generation naming exactly what merged, into what, and at
        // what score. The survivor mapping matters: a dropped row whose survivor no longer
        // carries its content is a lost action, and only this line can show that.
        console.log(JSON.stringify({ event: 'staged_dedupe', stage: 'actions', dropped: [...drop].map((index) => rows[index].action), merges: dropRecords, pairs: dedupe.pairs }));
        if (actionTrace) for (const record of dropRecords) actionTrace.mutations.push({ type: 'dedupe_drop', ...record });
        result = { ...result, screens: { ...result.screens, actions: rows.filter((item, index) => !drop.has(index)) } };
      }
    }
    // The reviewer's three-proof rule for a confirmed action, applied to what would
    // otherwise ship. Commitment is already proven upstream (disposition strictness and
    // the corroboration of two readings); these are the other two proofs.
    //
    // Concreteness: a record whose reference cannot be resolved by a reader is not a
    // task. "Limit risk for them" was published as a confirmed action from a
    // conversational aside - grammatical, verb-initial, concrete-object-shaped, and
    // useless, because "them" names nobody. Such a row is demoted to a review
    // candidate, never silently dropped. ACTION_CONCRETENESS=0 disables.
    if (process.env.ACTION_CONCRETENESS !== '0' && (result?.screens?.actions || []).length) {
      const demoted = [];
      const kept = result.screens.actions.filter((item) => {
        if (item.reviewerAuthored) return true;
        if (!unresolvedReference(item.action)) return true;
        demoted.push(item);
        return false;
      });
      if (demoted.length) {
        console.log(JSON.stringify({ event: 'staged_concreteness_gate', stage: 'actions', demoted: demoted.map((item) => item.action) }));
        if (actionTrace) for (const item of demoted) actionTrace.mutations.push({ type: 'concreteness_demotion', owner: item.owner || 'Not stated', action: String(item.action || '') });
        result = {
          ...result,
          screens: {
            ...result.screens,
            actions: kept,
            actionCandidates: [
              ...(result.screens.actionCandidates || []),
              ...demoted.map((item) => ({ owner: item.owner, action: item.action, suggestedAction: item.action, reviewDisposition: 'review_required', evidenceIds: item.evidenceIds }))
            ]
          }
        };
      }
    }
    // Owner support - BUILT, MEASURED, AND OFF BY DEFAULT. The idea: a name on a row is
    // an assertion, and an unsupported one should become an honest blank ("Send training
    // attestation" carried Stuart's name when the transcript shows Stuart telling NIAMH
    // she needs to complete it). The measurement: with the evidence correctly flattened,
    // the full corpus run still demoted ~44 owners and many were plainly CORRECT -
    // "Priya Sethi: Handle the opening" and "Callum Reid: Hit record" are their own
    // explicit commitments. ownerSupported was designed as a PROMOTION gate, where a
    // false negative costs nothing; as a demotion gate every false negative blanks a
    // right name, and evidence citations are too noisy for absence-of-proof to mean
    // wrongness. Re-enable (OWNER_SUPPORT_GATE=1) only with a version that demotes on
    // POSITIVE contrary evidence - the cited turns showing a DIFFERENT person committing
    // - rather than on absence of support.
    if (process.env.OWNER_SUPPORT_GATE === '1' && (result?.screens?.actions || []).length && canonicalEvidencePack.length) {
      // Flattened to the entry shape citedEntries reads. Passing the pack unflattened
      // resolved zero cited turns, which read as "no owner is supported" and demoted 89
      // of 95 named owners in one run - the scorecard's blank-owner escape hatch kept
      // recall LOOKING fine while the screens filled with blank owner cells. Measured
      // before shipping, which is the only reason it did not ship.
      const ownerEvidence = { evidence: canonicalEvidencePack.flatMap((item) => item.evidence || []) };
      const demotions = [];
      const gated = result.screens.actions.map((item) => {
        if (item.reviewerAuthored || !item.owner || item.owner === 'Not stated') return item;
        if (ownerSupported({ owner: item.owner, evidenceIds: item.evidenceIds || [] }, ownerEvidence)) return item;
        demotions.push({ owner: item.owner, action: String(item.action || '') });
        return { ...item, owner: 'Not stated', ownerUnassigned: true, ownerDemoted: item.owner };
      });
      if (demotions.length) {
        console.log(JSON.stringify({ event: 'staged_owner_demotion', stage: 'actions', demotions }));
        if (actionTrace) for (const item of demotions) actionTrace.mutations.push({ type: 'owner_demotion', ...item });
        result = { ...result, screens: { ...result.screens, actions: gated } };
      }
    }
    traceSnap('final', result?.screens?.actions);
    if (actionTrace) {
      try { require('fs').appendFileSync(process.env.ACTION_TRACE, `${JSON.stringify(actionTrace)}\n`); } catch { /* tracing must never break generation */ }
    }
  }
  // Discussion prose gets the same publication promise as actions: broken wording is
  // mechanically repaired, then sent to the model, and whatever survives both rounds is
  // pointed at rather than left to be noticed. Until this block a broken discussion point
  // had no second chance anywhere - the rewrite that produced it was the last pass that
  // touched it.
  let discussionWordingRepair = { repaired: 0, attempted: 0 };
  if (stage === 'discussion') {
    discussionWordingRepair = await repairDiscussionWording(result, canonicalEvidencePack, {
      people: result?.canonicalDiagnostics?.entityNames || [],
      allEvents: prepareEvidence(semanticTranscript.text).events
    });
    result = discussionWordingRepair.payload || result;
    // Discussion by proposal, restraint by validation - the actions architecture applied
    // here for the same measured reason. The deterministic path selects representative
    // sentences from MiniLM clusters, and a narrated story fragments across them:
    // Andrew's alarm demonstration split into five micro-clusters, so the card surfaced
    // "I'm gonna try and include sound" (screen-share mechanics) while the demonstration
    // itself scattered. A model reading the whole transcript keeps the story together;
    // every proposed point must quote a turn that resolves to this transcript, must pass
    // the wording detectors, and must not duplicate a point already on the screen.
    // DISCUSSION_PROPOSALS=0 turns the pass off.
    if (process.env.DISCUSSION_PROPOSALS !== '0') {
      const existingCards = Array.isArray(result?.screens?.discussion) ? result.screens.discussion : [];
      const existingPoints = existingCards.flatMap((card) => (card.points || []).map((point) => (typeof point === 'string' ? point : point?.text || '')));
      const proposal = await proposeDiscussionPoints(semanticTranscript.text, prepareEvidence(semanticTranscript.text), existingPoints, {});
      if (proposal.grounded.length) {
        const tokensOf = (value) => new Set(String(value || '').toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || []);
        const overlapOf = (a, b) => {
          if (!a.size || !b.size) return 0;
          let shared = 0;
          for (const token of a) if (b.has(token)) shared += 1;
          return shared / Math.min(a.size, b.size);
        };
        const cards = existingCards.map((card) => ({ ...card, points: [...(card.points || [])] }));
        const newCards = new Map();
        // A confirmed agenda IS the agenda.
        //
        // Measured on the Abbott rerun: the discussion stage honoured the reviewer's four
        // themes exactly - five cards in, four of them confirmed - and this block turned
        // that into twenty-two by minting a heading for every proposal whose label failed
        // to overlap an existing one at 0.34. "Hotel reservation details" and "Audit
        // attendees confirmation" never will overlap "Audit scope, timing, and logistics",
        // so the reviewer's structure was intact right up to the point where it was
        // buried under micro-sections.
        //
        // When any card is reviewer-confirmed, no new heading may be minted. A proposed
        // point belongs to one of THEIR topics or it does not belong on the screen, and
        // the label the model happened to invent for it is the weakest available signal
        // for deciding which - it was measured at 0.00 lexical overlap against the right
        // theme. Evidence is the strongest: a point drawn from turns a card already owns
        // belongs to that card. Semantic similarity of the POINT (not its label) against
        // the heading is the fallback, and anything below the floor is dropped rather
        // than given a section of its own.
        // Targets are every card the stage produced, not only the confirmed ones. The
        // stage emits a generic catch-all card beside the reviewer's themes, and that is
        // the honest home for a real point that fits none of them - better than dropping
        // it, and far better than giving it a heading of its own.
        const confirmedAgenda = cards.some((card) => card.confirmedTopic);
        const agendaCards = cards;
        let catchAllCard = cards.find((card) => !card.confirmedTopic && /^(?:other|general|miscellaneous|any other business)\b/i.test(String(card.topic || '')));
        const attachFloor = Number(process.env.AGENDA_ATTACH_FLOOR || 0.4);
        let agendaVectors = null;
        if (confirmedAgenda && proposal.grounded.length) {
          const vecTexts = [...new Set([
            ...agendaCards.map((card) => String(card.topic || '')),
            ...proposal.grounded.map((item) => String(item.point || ''))
          ])].filter(Boolean);
          const encoded = await encodeViaWorker(vecTexts);
          if (encoded) agendaVectors = new Map(vecTexts.map((text, index) => [text, encoded[index]]));
        }
        const agendaAttachments = [];
        const agendaDropped = [];
        for (const item of proposal.grounded) {
          const pointText = item.point;
          const topicTokens = tokensOf(item.topic);
          if (confirmedAgenda) {
            const itemEvidence = new Set((item.evidenceIds || []).map(String));
            let home = agendaCards.find((card) => (card.evidenceIds || []).some((id) => itemEvidence.has(String(id))));
            let how = 'evidence';
            let score = 1;
            if (!home && agendaVectors) {
              const pointVector = agendaVectors.get(String(pointText || ''));
              let best = null;
              for (const card of agendaCards) {
                const cardVector = agendaVectors.get(String(card.topic || ''));
                const value = pointVector && cardVector ? cosine(pointVector, cardVector) : 0;
                if (!best || value > best.value) best = { card, value };
              }
              if (best && best.value >= attachFloor) { home = best.card; how = 'semantic'; score = Number(best.value.toFixed(3)); }
            }
            // Nothing is dropped under a confirmed agenda. Forbidding new headings is a
            // structure rule, not a licence to lose content: measured, dropping the
            // unmatched cost 41 published points and 16 of discussion coverage, because
            // the fixtures where every card is confirmed have no catch-all to fall back
            // on. One catch-all section is created on demand instead - the reviewer can
            // redistribute or delete it, which is a far smaller job than reading
            // seventeen micro-sections, and no evidence goes missing.
            if (!home) {
              if (!catchAllCard) {
                catchAllCard = { topic: 'Other points raised', points: [], evidenceIds: [], modelProposed: true };
                cards.push(catchAllCard);
              }
              home = catchAllCard;
              how = 'catch_all';
              score = 0;
            }
            home.points.push(pointText);
            home.evidenceIds = [...new Set([...(home.evidenceIds || []), ...item.evidenceIds])];
            agendaAttachments.push({ point: String(pointText).slice(0, 80), topic: home.topic, via: how, score });
            continue;
          }
          // Attach to the existing card whose heading this point's proposed topic best
          // matches; a new heading is only minted when nothing existing fits, and it must
          // read as a heading - the same bar every other label source passes.
          let bestCard = null;
          let bestScore = 0;
          for (const card of cards) {
            const score = overlapOf(topicTokens, tokensOf(card.topic));
            if (score > bestScore) { bestScore = score; bestCard = card; }
          }
          if (bestCard && bestScore >= 0.34) {
            bestCard.points.push(pointText);
            bestCard.evidenceIds = [...new Set([...(bestCard.evidenceIds || []), ...item.evidenceIds])];
          } else if (item.topic.split(/\s+/).length >= 2 && labelNamesAWorkstream(item.topic) && isPublishableTopicLabel(item.topic)) {
            // Not canHeadlineTopic: its 4-word floor and meta-text screen are calibrated
            // for stopword-strip debris ("Let get total"), and both were measured before
            // being kept - but a model-written heading is different provenance. The floor
            // refused "Change request documentation", and the meta screen refused "Alarm
            // mute button behaviour" because "mute button" usually means Teams mechanics -
            // here it is the product's own mute button. The heading still has to read as a
            // workstream and be client-ready, and the points under it are quote-grounded.
            const key = item.topic.toLowerCase();
            if (!newCards.has(key)) newCards.set(key, { topic: item.topic, points: [], evidenceIds: [], modelProposed: true });
            const card = newCards.get(key);
            card.points.push(pointText);
            card.evidenceIds = [...new Set([...card.evidenceIds, ...item.evidenceIds])];
          }
          // A point whose topic neither matches a card nor survives the heading gates is
          // dropped - coverage is not worth a heading that reads as speech.
        }
        if (agendaAttachments.length || agendaDropped.length) {
          console.log(JSON.stringify({ event: 'staged_agenda_attach', attached: agendaAttachments, dropped: agendaDropped.map((text) => String(text).slice(0, 80)) }));
        }
        result = {
          ...result,
          screens: { ...result.screens, discussion: [...cards, ...newCards.values()] }
        };
      }
    }
    const stillBrokenPoints = (result?.screens?.discussion || [])
      .flatMap((card) => (card.points || []).map((point) => (typeof point === 'string' ? point : point?.text)))
      .filter((point) => wordingFaults(String(point || '')).length);
    if (stillBrokenPoints.length) {
      result = {
        ...result,
        validationFlags: [
          ...(Array.isArray(result.validationFlags) ? result.validationFlags : []),
          {
            type: 'discussion_wording_needs_review',
            severity: 'warning',
            blocking: false,
            message: `${stillBrokenPoints.length} discussion point${stillBrokenPoints.length === 1 ? '' : 's'} below still read${stillBrokenPoints.length === 1 ? 's' : ''} like speech rather than a minute. The content is real; the wording needs a pass before sharing.`,
            resolutionKey: `discussion-wording-needs-review:${crypto.createHash('sha256').update(stillBrokenPoints.join('|')).digest('hex').slice(0, 16)}`
          }
        ]
      };
    }
    // A last, whole-screen sweep for an invented surname, over both the topic heading and
    // every point. "Rebecca Cuckoo" was corrected to "Rebecca Gill" in owners and
    // attendees, but discussion PROSE is written by four different sources by this point
    // (the deterministic presentation pass, the fault-gated repair, the universal polish,
    // and the model proposal) and each reads the raw transcript rather than a normalised
    // copy - so a name fixed upstream could still resurface downstream. One sweep over the
    // finished cards catches every source at once, wherever the bad spelling came from.
    const discussionEntityNames = result?.canonicalDiagnostics?.entityNames || [];
    if (discussionEntityNames.length) {
      result = {
        ...result,
        screens: {
          ...result.screens,
          discussion: (result.screens.discussion || []).map((card) => {
            const topic = normaliseAttendeeReferences(card.topic, discussionEntityNames).text;
            const points = (card.points || []).map((point) => {
              if (typeof point === 'string') return normaliseAttendeeReferences(point, discussionEntityNames).text;
              const text = normaliseAttendeeReferences(point?.text || '', discussionEntityNames).text;
              return text !== point?.text ? { ...point, text } : point;
            });
            return topic !== card.topic || points.some((point, index) => point !== card.points[index])
              ? { ...card, topic, points }
              : card;
          })
        }
      };
    }
    // Same claim check for discussion points, and the same deterministic refusal of a
    // named person's error. A point is dropped only on an explicit "unsupported"; a card
    // emptied by the pass is removed unless reviewer-authored or confirmed.
    if (process.env.CLAIM_CHECK !== '0' && (result?.screens?.discussion || []).length) {
      const cards = result.screens.discussion.map((card) => ({ ...card, points: [...(card.points || [])] }));
      const allEvents = prepareEvidence(semanticTranscript.text).events;
      const byId = new Map(allEvents.map((event) => [String(event.id), String(event.text || '').replace(/\s+/g, ' ').trim()]));
      const flat = [];
      cards.forEach((card, cardIndex) => card.points.forEach((point, pointIndex) => {
        flat.push({
          index: flat.length, cardIndex, pointIndex,
          text: String(typeof point === 'string' ? point : point?.text || ''),
          evidence: (card.evidenceIds || []).map((id) => byId.get(String(id))).filter(Boolean).slice(0, 4).join(' ')
        });
      }));
      const dropKeys = new Set();
      const droppedPoints = [];
      for (const entry of flat) {
        if (personErrorAssertion(entry.text)) {
          dropKeys.add(`${entry.cardIndex}:${entry.pointIndex}`);
          droppedPoints.push(entry.text);
        }
      }
      if (dropKeys.size) {
        console.log(JSON.stringify({ event: 'staged_claim_check', stage: 'discussion', dropped: droppedPoints }));
        result = {
          ...result,
          screens: {
            ...result.screens,
            discussion: cards
              .map((card, cardIndex) => ({ ...card, points: card.points.filter((point, pointIndex) => !dropKeys.has(`${cardIndex}:${pointIndex}`)) }))
              .filter((card) => card.points.length || isReviewerAuthored(card) || card.confirmedTopic)
          }
        };
      }
    }
    // Card consolidation, before the point dedupe.
    //
    // The attach rule is lexical min-set overlap >= 0.34, and THREE-word headings sharing
    // exactly one word score 0.333 every time - so "Alarm code review" / "Alarm
    // functionality testing" / "Alarm visual indication" each minted their own card,
    // missing by a hundredth. Measured on the reviewer's live rerun: four separate alarm
    // cards, and the demonstration restated across five of them. "Benefit-risk analysis"
    // and "Risk assessment conclusion" share NO tokens at all (lexical 0.00) yet are
    // plainly one subject (cosine 0.597).
    //
    // So cards merge on heading MEANING as well as tokens. 0.62 sits below the alarm
    // family (0.610-0.736) and above the closest pair that reads as genuinely separate.
    // Reviewer-authored and confirmed cards are never absorbed - they keep their heading
    // and their identity. Points move; headings never blend.
    if (process.env.CARD_MERGE !== '0') {
      const cards = (result?.screens?.discussion || []).map((card) => ({ ...card, points: [...(card.points || [])] }));
      if (cards.length > 1) {
        const headingVectors = await encodeViaWorker(cards.map((card) => String(card.topic || '')));
        if (headingVectors) {
          const absorbed = new Set();
          for (let i = 0; i < cards.length; i += 1) {
            if (absorbed.has(i)) continue;
            for (let j = i + 1; j < cards.length; j += 1) {
              if (absorbed.has(j)) continue;
              if (isReviewerAuthored(cards[j]) || cards[j].confirmedTopic) continue;
              if (!headingVectors[i] || !headingVectors[j]) continue;
              if (cosine(headingVectors[i], headingVectors[j]) < 0.62) continue;
              cards[i].points.push(...cards[j].points);
              cards[i].evidenceIds = [...new Set([...(cards[i].evidenceIds || []), ...(cards[j].evidenceIds || [])])];
              absorbed.add(j);
            }
          }
          if (absorbed.size) {
            console.log(JSON.stringify({ event: 'staged_card_merge', absorbed: [...absorbed].map((index) => cards[index].topic) }));
            result = { ...result, screens: { ...result.screens, discussion: cards.filter((card, index) => !absorbed.has(index)) } };
          }
        }
      }
    }
    // Final semantic near-duplicate pass across ALL cards' points - the proposal dedupe
    // only compared against points that existed at merge time, so a paraphrase could land
    // in a NEW card while its twin sat in another (DITA's B2B-ordering point appeared
    // under two headings). Same 0.80 near-restatement bar as actions; first occurrence
    // wins; a card emptied by the pass is removed unless it is reviewer-authored or a
    // confirmed topic. Card HEADINGS never merge - "Alarm functionality testing" and
    // "Alarm visual and auditory configuration" are legitimately different topics.
    if (process.env.DEDUP_PASS !== '0') {
      const cards = (result?.screens?.discussion || []).map((card) => ({ ...card, points: [...(card.points || [])] }));
      const flat = [];
      cards.forEach((card, cardIndex) => card.points.forEach((point, pointIndex) => {
        flat.push({ cardIndex, pointIndex, text: String(typeof point === 'string' ? point : point?.text || '') });
      }));
      if (flat.length > 1) {
        // Discussion restatements measured on the reviewer's live rerun cluster at
        // 0.71-0.78 - every one under the 0.80 action bar, which is why five versions of
        // the alarm demonstration all published. Discussion gets its own threshold; the
        // 0.708 distinct pair that set the action bar was an ACTIONS pair, so lowering
        // here does not reopen it.
        const dedupe = await duplicateGroups(flat.map((entry) => entry.text), { threshold: Number(process.env.DISCUSSION_DEDUPE_THRESHOLD || 0.72) });
        const dropKeys = new Set();
        for (const group of dedupe.groups) {
          const informationScore = (memberIndex) => {
            const entry = flat[memberIndex];
            const point = cards[entry.cardIndex].points[entry.pointIndex];
            const words = new Set(String(entry.text || '').toLowerCase().match(/[a-z0-9][a-z0-9'’-]{2,}/g) || []);
            const figures = (String(entry.text || '').match(/(?:[$£€]\s*)?\d+(?:[.,]\d+)?(?:\s*%|\s*(?:days?|weeks?|months?|years?))?/g) || []).length;
            return words.size + figures * 4 + Math.min(12, (point?.evidenceIds || []).length) * 0.25
              + Math.min(4, (point?.supportingDetails || []).length);
          };
          const survivorIndex = [...group].sort((a, b) => informationScore(b) - informationScore(a) || a - b)[0];
          const survivorEntry = flat[survivorIndex];
          const survivorPoint = cards[survivorEntry.cardIndex].points[survivorEntry.pointIndex];
          const mergedPoints = group.map((memberIndex) => {
            const entry = flat[memberIndex];
            return cards[entry.cardIndex].points[entry.pointIndex];
          }).filter((point) => point && typeof point === 'object');
          if (survivorPoint && typeof survivorPoint === 'object') {
            survivorPoint.evidenceIds = [...new Set(mergedPoints.flatMap((point) => point.evidenceIds || []))].slice(0, 24);
            survivorPoint.reviewFlagIds = [...new Set(mergedPoints.flatMap((point) => point.reviewFlagIds || []))].slice(0, 24);
            survivorPoint.supportingDetails = mergedPoints.flatMap((point) => point.supportingDetails || [])
              .filter((detail, index, all) => all.findIndex((candidate) => String(candidate?.text || '').toLowerCase() === String(detail?.text || '').toLowerCase()) === index);
            const mergedFromIds = [...new Set(mergedPoints.flatMap((point) => [point.id, ...(point.mergedFromIds || [])]).filter(Boolean))]
              .filter((id) => id !== survivorPoint.id);
            if (mergedFromIds.length) survivorPoint.mergedFromIds = mergedFromIds;
          }
          for (const memberIndex of group) {
            if (memberIndex === survivorIndex) continue;
            const entry = flat[memberIndex];
            dropKeys.add(`${entry.cardIndex}:${entry.pointIndex}`);
          }
        }
        if (dropKeys.size) {
          console.log(JSON.stringify({ event: 'staged_dedupe', stage: 'discussion', dropped: [...dropKeys].map((key) => { const [c, i] = key.split(':').map(Number); const point = cards[c].points[i]; return typeof point === 'string' ? point : point?.text; }), pairs: dedupe.pairs }));
          const deduped = cards
            .map((card, cardIndex) => ({
              ...card,
              points: card.points.filter((point, pointIndex) => !dropKeys.has(`${cardIndex}:${pointIndex}`))
            }))
            .filter((card) => card.points.length || isReviewerAuthored(card) || card.confirmedTopic);
          result = { ...result, screens: { ...result.screens, discussion: deduped } };
        }
      }
    }
    // The reviewer's hard rule, applied last: no published sentence may read as spoken
    // transcript language. Every point above has already been OFFERED repair and polish;
    // one that still carries a voice-severity fault here is one the model could not
    // restate within the acceptance guards - "Limit the risk for them, yeah, okay." -
    // and until now it published anyway, because the finaliser's rejection was undone by
    // a fallback that restored the raw text. It moves to the wording flag as a review
    // candidate, never silently: the flag names each removed point in full. Cards
    // emptied by the gate follow the existing empty-card contract.
    // DISCUSSION_SPEECH_GATE=0 disables.
    if (process.env.DISCUSSION_SPEECH_GATE !== '0' && Array.isArray(result?.screens?.discussion)) {
      const people = result?.canonicalDiagnostics?.entityNames || [];
      const removed = [];
      const gatedCards = result.screens.discussion.map((card) => {
        if (isReviewerAuthored(card)) return card;
        const points = (card.points || []).filter((point) => {
          const text = typeof point === 'string' ? point : String(point?.text || '');
          const spoken = minutesEnglishFaults(text, { people, spokenRegister: true })
            .some((fault) => fault.severity === 'voice');
          if (spoken) removed.push({ section: card.topic || 'Discussion', text });
          return !spoken;
        });
        return points.length === (card.points || []).length ? card : { ...card, points };
      }).filter((card) => (card.points || []).length || isReviewerAuthored(card) || card.confirmedTopic);
      if (removed.length) {
        console.log(JSON.stringify({ event: 'staged_speech_gate', stage: 'discussion', removed }));
        result = {
          ...result,
          screens: { ...result.screens, discussion: gatedCards },
          validationFlags: [
            ...(Array.isArray(result.validationFlags) ? result.validationFlags : []),
            {
              type: 'discussion_speech_removed',
              severity: 'warning',
              blocking: false,
              message: `${removed.length} discussion point${removed.length === 1 ? '' : 's'} read as spoken transcript language and could not be restated, so ${removed.length === 1 ? 'it was' : 'they were'} moved here for a decision rather than published as minutes.`,
              resolutionKey: `discussion-speech-removed:${crypto.createHash('sha256').update(removed.map((item) => item.text).join('|')).digest('hex').slice(0, 16)}`,
              repairCandidates: removed
            }
          ]
        };
      }
    }
  }
  // Routine mechanics of running the call are neither discussion content nor a
  // meeting outcome.  Model prompts already say this, but a grounded rewrite can
  // still paraphrase "wait for an attendee" and pass a lexical evidence check.
  // Apply the deterministic publication rule after rewriting; reviewer-authored
  // cards remain authoritative.
  if (stage === 'discussion' && Array.isArray(result?.screens?.discussion)) {
    const removed = [];
    const cards = result.screens.discussion.map((card) => {
      if (isReviewerAuthored(card)) return card;
      const points = (card.points || []).filter((point) => {
        const pointText = typeof point === 'string' ? point : String(point?.text || '');
        if (isRoutineMeetingAdministrationText(pointText)) removed.push(pointText);
        return !isRoutineMeetingAdministrationText(pointText);
      });
      return points.length === (card.points || []).length ? card : { ...card, points };
    }).filter((card) => (card.points || []).length || isReviewerAuthored(card) || card.confirmedTopic);
    if (removed.length) console.info(JSON.stringify({ event: 'staged_meeting_admin_removed', stage, removed }));
    result = { ...result, screens: { ...result.screens, discussion: cards } };
  }
  let initialUnderstandingPolish = { used: false, reason: 'not_applicable' };
  const presentationInitialSummary = result?.screens?.summary;
  if (stage === 'summary' && presentationInitialSummary) {
    const summaryEvidencePack = stage === 'summary' && Array.isArray(payload._canonicalEvidencePack)
      ? payload._canonicalEvidencePack
      : null;
    initialUnderstandingPolish = await polishStagedInitialUnderstanding(
      presentationInitialSummary,
      confirmed.details?.meetingTitle || input.meetingTitle || '',
      summaryEvidencePack,
      semanticTranscript.text
    );
    if (initialUnderstandingPolish.used) {
      // A field the reviewer wrote is not ours to copy-edit. The polish is a presentation
      // pass over model prose; run over confirmed text it silently rewrites the reviewer's
      // own words back at them, which is the thing they came here to stop.
      const confirmedSummary = confirmed.summary || {};
      const keepConfirmed = (confirmedValue, polishedValue, presentedValue) => (
        stagedAnalyticsText(confirmedValue) ? presentedValue : polishedValue
      );
      // A purpose somebody said in the meeting, or one taken from the title, is a quote.
      // Copy-editing it is how "sense check our academic theory" became "The session
      // focused on a sense check of the academic theory" - vaguer than what was actually
      // said, and no longer the thing the cited turn supports. Only prose we composed
      // ourselves is ours to rewrite.
      // The purpose decides for itself whether it is ours to rewrite, because the module
      // that builds it is the only place that knows where its words came from. An
      // enumerated list here describing objects constructed in another file is how
      // MODE_CONFIG escaped the source check written to catch exactly that.
      // 'never'  - somebody said it; a quote is not replaced, however good the polish.
      // 'evidence_grounded' - a title standing in for an absent purpose; replaceable by
      //             a cited paragraph that passed the citation validators, which is what
      //             fieldOutcomes.purpose === 'accepted' certifies.
      // 'free'/absent - prose the pipeline composed; the polish may rewrite it.
      const purposeMeta = presentationInitialSummary?.initialUnderstanding?.meetingPurpose || {};
      const purposePolicy = purposeMeta.purposeReplacementPolicy
        || (purposeMeta.purposeIsAuthoredElsewhere ? 'evidence_grounded' : 'free');
      const citedPurposeAccepted = initialUnderstandingPolish.cited
        && initialUnderstandingPolish.fieldOutcomes?.purpose === 'accepted';
      const purposeIsQuoted = purposePolicy === 'never'
        || (purposePolicy === 'evidence_grounded' && !citedPurposeAccepted);
      result = {
        ...result,
        screens: {
          ...(result.screens || {}),
          summary: {
            ...presentationInitialSummary,
            meetingPurpose: purposeIsQuoted
              ? presentationInitialSummary.meetingPurpose
              : keepConfirmed(confirmedSummary.meetingPurpose, initialUnderstandingPolish.meetingPurpose, presentationInitialSummary.meetingPurpose),
            objectives: keepConfirmed(
              confirmedSummary.objectives,
              topUpObjectivesFromNamedTopics(initialUnderstandingPolish.objectives, initialUnderstandingPolish.namedTopics),
              presentationInitialSummary.objectives
            ),
            ...mergeNamedTopics(presentationInitialSummary, initialUnderstandingPolish.namedTopics, confirmedSummary.overallTopics),
            executiveSummary: keepConfirmed(confirmedSummary.executiveSummary, initialUnderstandingPolish.executiveSummary, presentationInitialSummary.executiveSummary),
            // The turns behind the composed prose, for the screen to show on demand. The
            // reviewer asked to see the evidence rather than delete id markers from the
            // sentences; this is where the markers went.
            evidenceQuotes: initialUnderstandingPolish.evidenceQuotes || null
          }
        }
      };
    }
  }
  // Objectives are derived from the meeting's own action phrases, so two near-identical
  // commitments produce two near-identical objectives - Abbott published "Run the code
  // of conduct through the site in advance to ensure alignment." beside "Run code of
  // conduct through the site in advance to make sure they're in alignment with it" -
  // and the existing dedupe compares normalised string KEYS, which different wordings
  // sail straight past. Semantic near-restatements collapse here, first occurrence
  // kept, live path only (the corpus baselines call runCanonicalLiveStage directly and
  // never reach this). Reviewer-confirmed objectives are never touched: their list IS
  // the list. OBJECTIVE_DEDUPE=0 disables.
  if (stage === 'summary' && process.env.OBJECTIVE_DEDUPE !== '0'
      && !stagedAnalyticsText(confirmed.summary?.objectives)
      && Array.isArray(result?.screens?.summary?.objectives)
      && result.screens.summary.objectives.length > 1) {
    const objectives = result.screens.summary.objectives;
    const dedupe = await duplicateGroups(objectives.map((item) => String(item || '')));
    const drop = new Set();
    for (const group of dedupe.groups) for (const index of group.slice(1)) drop.add(index);
    if (drop.size) {
      console.log(JSON.stringify({ event: 'staged_objective_dedupe', dropped: [...drop].map((index) => objectives[index]), pairs: dedupe.pairs }));
      result = {
        ...result,
        screens: {
          ...result.screens,
          summary: { ...result.screens.summary, objectives: objectives.filter((item, index) => !drop.has(index)) }
        }
      };
    }
  }
  let executiveSummaryGrammar = { used: false, reason: 'not_applicable' };
  const presentationSummary = result?.screens?.summary?.executiveSummary;
  const executiveSummaryIsConfirmed = Boolean(stagedAnalyticsText(confirmed.summary?.executiveSummary));
  if (executiveSummaryIsConfirmed) executiveSummaryGrammar = { used: false, reason: 'reviewer_confirmed' };
  // An evidence-cited summary is already minutes-ready prose validated claim by claim;
  // re-polishing it would fight the enrichment (the grammar pass's own 1.3x length gate
  // rejects sanctioned growth) and could reintroduce the outcome-summary drift the
  // citation contract exists to prevent. The purpose-prefix invariant scopes to the
  // deterministic path from here: a cited summary need not open with the purpose - the
  // user's own exemplars do not - and the supersession is pinned by test.
  const summaryWasCited = initialUnderstandingPolish.used && initialUnderstandingPolish.cited
    && initialUnderstandingPolish.fieldOutcomes?.summary === 'accepted';
  if (summaryWasCited) {
    executiveSummaryGrammar = { used: false, reason: 'superseded_by_evidence_polish' };
    result = {
      ...result,
      validationFlags: [
        ...(result.validationFlags || []),
        {
          type: 'summary_machine_composed',
          severity: 'info',
          blocking: false,
          resolutionKey: 'summary-machine-composed',
          message: 'This summary was composed from the meeting\'s own evidence by the drafting model, with each statement tied to cited moments. Read it before sharing - it is a draft, not a record.'
        }
      ]
    };
  }
  if (!executiveSummaryIsConfirmed && !summaryWasCited && ['summary', 'discussion'].includes(stage) && presentationSummary) {
    // The summary is built as purpose-sentence-then-spine, and the purpose field itself
    // is exempt from copy-editing when its words are quoted or the reviewer's. Sending
    // the whole summary through the grammar pass quietly undid that from the other side:
    // the purpose field said "Check in on progress for AI." while the summary opening
    // said "The session focused on...". Same words, two renderings, one screen.
    //
    // So the purpose is an opaque prefix. The grammar pass polishes only what follows it,
    // and the prefix is reattached byte-identical - which makes the divergence impossible
    // rather than merely fixed, and is asserted as an invariant by
    // executive-summary-prefix.test.js.
    const summaryPurpose = String(result?.screens?.summary?.meetingPurpose || '').trim();
    const protectPrefix = summaryPurpose && presentationSummary.startsWith(summaryPurpose);
    const polishable = protectPrefix ? presentationSummary.slice(summaryPurpose.length).trim() : presentationSummary;
    if (!polishable) {
      executiveSummaryGrammar = { used: false, reason: 'purpose_only' };
    } else {
      executiveSummaryGrammar = await grammarPolishStagedExecutiveSummary(polishable);
      if (executiveSummaryGrammar.text) {
        const polished = protectPrefix ? `${summaryPurpose} ${executiveSummaryGrammar.text}` : executiveSummaryGrammar.text;
        result = {
          ...result,
          screens: {
            ...(result.screens || {}),
            summary: {
              ...(result.screens?.summary || {}),
              executiveSummary: polished
            }
          }
        };
      }
    }
  }
  // Run after every optional summary rewrite.  The guard is field-specific so
  // text the reviewer confirmed is never silently removed.
  if (stage === 'summary' && result?.screens?.summary) {
    const summary = result.screens.summary;
    const purposeConfirmed = Boolean(stagedAnalyticsText(confirmed.summary?.meetingPurpose));
    const objectivesConfirmed = Boolean(stagedAnalyticsText(confirmed.summary?.objectives));
    const topicsConfirmed = Boolean(stagedAnalyticsText(confirmed.summary?.overallTopics));
    const generatedPurpose = purposeConfirmed || !isRoutineMeetingAdministrationText(summary.meetingPurpose)
      ? summary.meetingPurpose : '';
    const generatedObjectives = objectivesConfirmed ? summary.objectives : (summary.objectives || [])
      .filter((item) => !isRoutineMeetingAdministrationText(item));
    const generatedTopics = topicsConfirmed ? summary.overallTopics : (summary.overallTopics || [])
      .filter((item) => !isRoutineMeetingAdministrationText(item));
    const visibleTopicKeys = new Set(generatedTopics.map((item) => stagedAnalyticsText(item).toLowerCase()));
    const executiveSummary = executiveSummaryIsConfirmed
      ? summary.executiveSummary
      : removeRoutineMeetingAdministrationSentences(summary.executiveSummary);
    result = {
      ...result,
      screens: {
        ...result.screens,
        summary: {
          ...summary,
          meetingPurpose: generatedPurpose,
          objectives: generatedObjectives,
          overallTopics: generatedTopics,
          topicRefs: topicsConfirmed ? summary.topicRefs : (summary.topicRefs || [])
            .filter((item) => visibleTopicKeys.has(stagedAnalyticsText(item?.text).toLowerCase())),
          executiveSummary,
          ...(summary.initialUnderstanding ? {
            initialUnderstanding: {
              ...summary.initialUnderstanding,
              meetingPurpose: purposeConfirmed || !isRoutineMeetingAdministrationText(summary.initialUnderstanding?.meetingPurpose?.text)
                ? summary.initialUnderstanding.meetingPurpose
                : { ...summary.initialUnderstanding.meetingPurpose, text: '' },
              meetingSpine: (summary.initialUnderstanding.meetingSpine || [])
                .filter((item) => !isRoutineMeetingAdministrationText(item?.text))
            }
          } : {})
        }
      }
    };
  }
  if (stage === 'actions' && Array.isArray(result?.screens?.actions)) {
    const presentedActions = filterActionsForPresentation(result.screens.actions);
    const removed = result.screens.actions.filter((item) => !presentedActions.includes(item));
    if (removed.length) console.log(JSON.stringify({
      event: 'staged_minimum_action_words_gate',
      stage: 'actions',
      removed: removed.map((item) => item?.action || item?.meetingActionPoint || '')
    }));
    result = { ...result, screens: { ...result.screens, actions: presentedActions } };
  }
  const health = assessGenerationHealth({
    stage,
    trooper: { used: polished.used, reason: polished.reason },
    summaryPolish: {
      attempted: stage === 'summary' && Boolean(presentationInitialSummary),
      used: Boolean(initialUnderstandingPolish.used),
      reason: initialUnderstandingPolish.reason,
      truncated: Boolean(initialUnderstandingPolish.truncated),
      degraded: Boolean(initialUnderstandingPolish.degraded)
    },
    grammarPolish: {
      attempted: ['summary', 'discussion'].includes(stage) && Boolean(presentationSummary),
      used: Boolean(executiveSummaryGrammar.used),
      reason: executiveSummaryGrammar.reason
    },
    wordingRepair: stage === 'discussion' ? discussionWordingRepair : actionWordingRepair
  });
  const pipelineHealth = {
    revision: servingRevision(),
    stage,
    served: health.served,
    degradations: health.degradations,
    durationMs: Date.now() - generationStartedAt,
    actionAccounting: result?.canonicalDiagnostics?.actionAccounting || null,
    wordingRepair: (({ attempted = 0, repaired = 0, reason = '' }) => ({ attempted, repaired, reason }))(stage === 'discussion' ? discussionWordingRepair : actionWordingRepair)
  };
  // One greppable line per generation, because the last five incidents in this area were
  // each dug out of pm2 logs by hand. `grep staged_generation_health` now answers the
  // first three questions of any dig - what ran, what degraded, what code served it.
  console.log(JSON.stringify({ event: 'staged_generation_health', fileName: transcript.fileName || null, ...pipelineHealth }));
  if (health.degradations.length) {
    result = {
      ...result,
      validationFlags: [
        ...(Array.isArray(result.validationFlags) ? result.validationFlags : []),
        {
          type: 'generation_degraded',
          severity: 'warning',
          blocking: false,
          // Written for the reviewer, not the operator: what it means for their read.
          message: `Part of this screen was generated in a reduced mode - without ${[...new Set(health.degradations.map((item) => item.label))].join('; and without ')}. The content is complete, but the wording is worth a closer read before sharing.`,
          resolutionKey: `generation-degraded:${stage}:${crypto.createHash('sha256').update(health.degradations.map((item) => `${item.step}|${item.reason}`).join('|')).digest('hex').slice(0, 12)}`
        }
      ]
    };
  }
  return normaliseDomainTermsDeep({
    source: transcript.source,
    fileName: transcript.fileName || null,
    transcriptLength: transcript.text.length,
    ...result,
    pipelineHealth,
    telemetryPreview: {
      ...(result.telemetryPreview || {}),
      executiveSummaryGrammar: {
        attempted: ['summary', 'discussion'].includes(stage) && Boolean(presentationSummary),
        used: Boolean(executiveSummaryGrammar.used),
        reason: executiveSummaryGrammar.reason,
        overlap: executiveSummaryGrammar.overlap,
        timingMs: executiveSummaryGrammar.timingMs
      },
      initialUnderstandingPolish: {
        attempted: stage === 'summary' && Boolean(presentationInitialSummary),
        used: Boolean(initialUnderstandingPolish.used),
        cited: Boolean(initialUnderstandingPolish.cited),
        reason: initialUnderstandingPolish.reason,
        // Per-field acceptance and every rejection reason - the failure mode this whole
        // area keeps re-teaching is the invisible one, where a validator quietly refuses
        // and the fallback reproduces the thin output that prompted the work.
        fieldOutcomes: initialUnderstandingPolish.fieldOutcomes || null,
        overlap: initialUnderstandingPolish.overlap,
        // Whether the model ran out of room, and whether what came back was the fallback
        // request rather than the one we meant to make. Both were invisible, and their
        // absence is why a maxTokens ceiling presented as a complaint about wording.
        truncated: Boolean(initialUnderstandingPolish.truncated),
        degraded: Boolean(initialUnderstandingPolish.degraded),
        finishReason: initialUnderstandingPolish.finishReason || '',
        timingMs: initialUnderstandingPolish.timingMs
      },
      transcriptHealth,
      trooper: { used: polished.used, reason: polished.reason, usage: polished.usage || null, input: 'bounded_minilm_evidence' }
    },
    preparedTranscriptTelemetry: semanticTranscript.preparedTranscriptTelemetry || transcript.preparedTranscriptTelemetry || null
  });
}

module.exports = {
  mergeNamedTopics,
  assessGenerationHealth,
  canonicalStagedResponse
};
