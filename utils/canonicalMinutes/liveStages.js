'use strict';

const { prepareEvidence, clean } = require('./evidence');
const { loadMiniLMProfileSync } = require('./minilm');
const { createCanonicalState, acceptProposal } = require('./state');
const semanticStages = require('./semanticStages');
const { assessEvidenceTopology } = require('./topology');
const { groundProposal } = require('./grounding');
const { auditConfirmedAgainstScreen } = require('./runner');
const { extractMentionedPeople, damerauLevenshtein } = require('../entityNormalization');
const { buildConfirmedUnderstanding } = require('../stagedSemanticAuthority');

function strings(values) {
  return (Array.isArray(values) ? values : []).map((value) => clean(value)).filter(Boolean);
}

function capitaliseInitial(value) {
  return clean(value).replace(/[a-z]/i, (letter) => letter.toUpperCase());
}

function lowerInitialUnlessInitialism(value) {
  const text = clean(value);
  if (/^[A-Z]{2,}\b/.test(text)) return text;
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

function topicLooksLikeReportedSpeechFragment(value) {
  const text = clean(value);
  if (!text) return false;
  if (/^[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+){0,3}\s+(?:said|noted|explained|mentioned|queried|asked|advised|confirmed|suggested|thought|thinks?|wanted?|wants?)\b/i.test(text)) return true;
  if (/^(?:he|she|they|we|i|you)\s+(?:said|noted|explained|mentioned|queried|asked|advised|confirmed|suggested|thought|thinks?|wanted?|wants?)\b/i.test(text)) return true;
  return false;
}

function approvedText(values, key = 'text') {
  return strings(values).map((text) => ({ [key]: text, humanFinal: text, aiOriginal: text }));
}

function approvedTopics(summary = {}) {
  const refs = Array.isArray(summary.topicRefs) ? summary.topicRefs : [];
  return strings(summary.overallTopics).map((text, index) => ({
    text,
    topicId: clean(refs[index]?.topicId),
    evidenceIds: Array.isArray(refs[index]?.evidenceIds) ? refs[index].evidenceIds : []
  }));
}

function approvedDiscussion(values) {
  return (Array.isArray(values) ? values : []).map((card) => {
    const pointRefs = Array.isArray(card?.pointRefs) ? card.pointRefs : [];
    return {
      topic: clean(card?.topic) || 'Discussion',
      topicId: clean(card?.topicId),
      evidenceIds: strings(card?.evidenceIds),
      points: (Array.isArray(card?.points || card?.bullets) ? (card.points || card.bullets) : [])
      .map((point, index) => {
        const text = clean(typeof point === 'string' ? point : point?.text);
        if (!text) return null;
        return {
          text,
          // Only retain provenance supplied by the confirmed stage. Reviewer
          // prose never receives inferred evidence merely because it is similar.
          evidenceIds: strings(typeof point === 'string' ? pointRefs[index]?.evidenceIds : point?.evidenceIds)
        };
      })
      .filter(Boolean),
      humanFinal: clean(card?.topic) || 'Discussion',
      aiOriginal: clean(card?.topic) || 'Discussion'
    };
  }).filter((card) => card.points.length);
}

function approvedActions(values) {
  return (Array.isArray(values) ? values : []).map((item) => ({
    owner: clean(item?.owner) || 'Not stated',
    action: capitaliseInitial(item?.action),
    deadline: capitaliseInitial(item?.deadline) || 'Not stated',
    humanFinal: capitaliseInitial(item?.action),
    aiOriginal: clean(item?.action)
  })).filter((item) => item.action);
}

function buildConfirmedState(transcriptText, fileName, confirmed = {}) {
  const details = confirmed.details || {};
  const participants = strings(details.participants || details.allAttendees || [
    ...(details.internalAttendees || []), ...(details.clientAttendees || [])
  ]);
  let state = createCanonicalState({
    transcriptText,
    fileName,
    meeting: {
      title: clean(details.meetingTitle),
      date: clean(details.meetingDate),
      location: clean(details.meetingLocation),
      type: clean(details.meetingType),
      participants
    }
  });
  const summary = confirmed.summary || {};
  if (Object.keys(summary).length) {
    const meetingUnderstanding = buildConfirmedUnderstanding(summary);
    state = acceptProposal(state, {
      objectives: approvedText(summary.objectives),
      topics: approvedTopics(summary),
      meeting: {
        ...state.meeting,
        purpose: meetingUnderstanding.meetingPurpose,
        // Stored so the overlay can tell "the reviewer wrote this summary" from "the
        // reviewer left ours alone". Nothing generates from it; it is a lock, not an input.
        executiveSummary: clean(summary.executiveSummary),
        criticalFacts: meetingUnderstanding.criticalFacts.map((fact) => fact.text)
      },
      meetingUnderstanding
    }, { source: 'stage_1_human_confirmation' });
  }
  if (Array.isArray(confirmed.discussion)) {
    const confirmedCards = approvedDiscussion(confirmed.discussion);
    const decisionText = confirmed.discussion.filter((card) => /^decisions?$/i.test(clean(card?.topic))).flatMap((card) => strings(card?.points || card?.bullets));
    const riskText = confirmed.discussion.filter((card) => /^(?:risks?|issues? and risks?)$/i.test(clean(card?.topic))).flatMap((card) => strings(card?.points || card?.bullets));
    state = acceptProposal(state, {
      discussion: confirmedCards,
      decisions: approvedText([...strings(confirmed.decisions), ...decisionText]),
      risks: approvedText([...strings(confirmed.risks), ...riskText])
    }, { source: 'stage_2_human_confirmation' });
  }
  if (Array.isArray(confirmed.actions)) {
    state = acceptProposal(state, { actions: approvedActions(confirmed.actions) }, { source: 'stage_3_human_confirmation' });
  }
  return state;
}

function summaryScreen(proposal) {
  const objectives = proposal.objectives.map((item) => item.text);
  const rawTopicItems = Array.isArray(proposal.topics) && proposal.topics.length
    ? proposal.topics
    : objectives.map((text) => ({ text: clean(text).replace(/^(?:Review|Confirm|Clarify|Identify|Agree)\s+/i, '') }));
  const visibleTopicItems = rawTopicItems
    .filter((item) => clean(item?.text))
    .filter((item) => !topicLooksLikeReportedSpeechFragment(item.text));
  const overallTopics = visibleTopicItems.map((item) => clean(item.text)).filter(Boolean);
  const initialUnderstanding = proposal.initialUnderstanding || null;
  const inferredPurpose = clean(initialUnderstanding?.meetingPurpose?.text);
  const spineItems = (Array.isArray(initialUnderstanding?.meetingSpine) ? initialUnderstanding.meetingSpine : [])
    .map((item) => clean(item.text))
    .filter(Boolean)
    .slice(0, 4);
  const synthesis = [inferredPurpose, ...spineItems].filter(Boolean).join(' ');
  const meetingType = clean(proposal.meeting?.type).toLowerCase();
  return {
    objectives,
    meetingPurpose: inferredPurpose,
    overallTopics,
    topicRefs: visibleTopicItems.map((item) => ({ text: item.text || '', topicId: item.topicId || '', evidenceIds: item.evidenceIds || [] })),
    executiveSummary: synthesis || (/webinar/.test(meetingType) && /rehearsal|practice|run[ -]?through/.test(meetingType)
      ? `The webinar rehearsal reviewed ${overallTopics.join('; ').replace(/; ([^;]+)$/, '; and $1').toLowerCase()}.`
      : overallTopics.length
      ? `The meeting reviewed ${overallTopics.map(lowerInitialUnlessInitialism).join('; ')}.`
      : 'No substantive meeting topics were identified automatically.'),
    initialUnderstanding: initialUnderstanding ? {
      provenance: initialUnderstanding.provenance,
      meetingMode: initialUnderstanding.meetingMode,
      meetingPurpose: initialUnderstanding.meetingPurpose,
      meetingSpine: initialUnderstanding.meetingSpine,
      primaryWorkstreams: initialUnderstanding.primaryWorkstreams,
      materialClarifications: initialUnderstanding.materialClarifications,
      unresolvedNeeds: initialUnderstanding.unresolvedNeeds,
      diagnostics: initialUnderstanding.diagnostics
    } : null
  };
}

// The confirmed value is the last write.
//
// summaryScreen derives its purpose from initialUnderstanding and its topics from the
// proposal, and never consults what the reviewer confirmed - so re-running the summary
// stage returned the model's purpose over the reviewer's own words, and the browser then
// copied that back into the purpose field. Overlaying here rather than teaching each
// builder about confirmed state keeps one place to look, and makes the regression
// impossible for any field listed rather than merely fixed once.
//
// Discussion and Actions are deliberately not overlaid: replacing those wholesale would
// make "regenerate this stage" a no-op. They are covered by the confirmed-value audit,
// which restores a changed value and reports it.
// The reviewer's spelling of a person's name, for names the recorder got wrong.
//
// Adding the confirmed attendees alongside the transcript speakers is not enough on its
// own: both spellings are then present, the transcript one matches the attribution
// exactly, and every action owner keeps reading the recorder's version. A reviewer who
// corrects "Skally" to "Scally" on screen 0 still gets Skally in the minutes.
//
// So a transcript name close enough to a confirmed name is replaced by it rather than
// joined to it. Distance is bounded and ambiguity is refused: two confirmed names equally
// close to one transcript name means we do not know which was meant, and guessing a
// person's name wrong is worse than leaving the transcript's.
function confirmedNameCorrections(confirmedNames, transcriptNames) {
  const corrections = new Map();
  for (const transcriptName of transcriptNames) {
    const source = clean(transcriptName);
    if (!source) continue;
    const ranked = confirmedNames
      .map((name) => ({ name: clean(name), distance: damerauLevenshtein(source.toLowerCase(), clean(name).toLowerCase()) }))
      .filter((item) => item.name)
      .sort((left, right) => left.distance - right.distance || left.name.localeCompare(right.name));
    const [best, second] = ranked;
    if (!best || best.distance === 0) continue;
    // Two edits over a full name is a mis-transcribed syllable; more is a different person.
    if (best.distance > 2 || source.length < 5) continue;
    if (second && second.distance === best.distance) continue;
    corrections.set(source, best.name);
  }
  return corrections;
}

function applyNameCorrections(value, corrections) {
  if (!corrections.size) return value;
  if (typeof value === 'string') return corrections.get(clean(value)) || value;
  if (Array.isArray(value)) return value.map((item) => applyNameCorrections(item, corrections));
  return value;
}

function applyConfirmedOverlay(stage, screen, state) {
  if (stage !== 'summary' || !screen || typeof screen !== 'object') return screen;
  const confirmedText = (items) => (Array.isArray(items) ? items : [])
    .map((item) => clean(item?.humanFinal || item?.text))
    .filter(Boolean);

  const purpose = clean(state?.meeting?.purpose);
  const objectives = confirmedText(state?.objectives);
  const topics = confirmedText(state?.topics);
  const criticalFacts = Array.isArray(state?.meetingUnderstanding?.criticalFacts)
    ? state.meetingUnderstanding.criticalFacts.map((fact) => clean(fact?.text)).filter(Boolean)
    : [];

  const overlaid = { ...screen };
  if (purpose) {
    overlaid.meetingPurpose = purpose;
    overlaid.meetingPurposeConfirmed = true;
    // initialUnderstanding carries its own copy of the derived purpose, and the screen
    // ships both. Correcting only the top-level one leaves the model's sentence in the
    // payload under a different key, where the pre-testing report and anything else
    // reading the diagnostics still finds it - a stale copy of a value the reviewer has
    // already corrected, which is the whole bug class this overlay exists to close.
    if (overlaid.initialUnderstanding?.meetingPurpose) {
      overlaid.initialUnderstanding = {
        ...overlaid.initialUnderstanding,
        meetingPurpose: {
          ...overlaid.initialUnderstanding.meetingPurpose,
          text: purpose,
          provenance: 'reviewer_confirmed',
          confidence: 1
        }
      };
    }
  }
  // The executive summary is the purpose sentence followed by the meeting spine, so a
  // corrected purpose that stops at the purpose field leaves the model's version still
  // opening the summary the client reads. Rebuild it from the confirmed sentence - unless
  // the reviewer wrote the summary too, in which case theirs stands untouched.
  const confirmedExecutiveSummary = clean(state?.meeting?.executiveSummary);
  if (confirmedExecutiveSummary) overlaid.executiveSummary = confirmedExecutiveSummary;
  else if (purpose) {
    const spineItems = (Array.isArray(screen.initialUnderstanding?.meetingSpine) ? screen.initialUnderstanding.meetingSpine : [])
      .map((item) => clean(item?.text))
      .filter(Boolean)
      .slice(0, 4);
    overlaid.executiveSummary = [purpose, ...spineItems].filter(Boolean).join(' ');
  }
  if (objectives.length) overlaid.objectives = objectives;
  if (topics.length) {
    overlaid.overallTopics = topics;
    overlaid.topicRefs = (state.topics || []).map((item) => ({
      text: clean(item?.humanFinal || item?.text),
      topicId: item?.topicId || '',
      evidenceIds: Array.isArray(item?.evidenceIds) ? item.evidenceIds : []
    })).filter((ref) => ref.text);
  }
  // The reviewer's key facts have never been returned to the screen, which is why the
  // browser has to guard against the server blanking the field it just sent. Returning
  // them makes the round trip honest and gives the audit something to compare.
  if (criticalFacts.length) overlaid.keyFacts = criticalFacts;
  return overlaid;
}

function discussionScreen(proposal) {
  const cards = proposal.discussion.map((card) => ({
    topic: card.topic,
    points: card.points.map((point) => point.text).filter(Boolean),
    pointRefs: card.points.map((point) => ({ evidenceIds: point.evidenceIds || [] })),
    evidenceIds: card.evidenceIds || [],
    topicId: card.topicId || null
  }));
  if (proposal.summaryTopicsAuthoritative) return cards;
  if (proposal.decisions.length) cards.push({ topic: 'Decisions', points: proposal.decisions.map((item) => item.text), evidenceIds: proposal.decisions.flatMap((item) => item.evidenceIds || []), topicId: 'canonical_decisions' });
  const riskEvidenceIds = proposal.risks.flatMap((item) => item.evidenceIds || []);
  const plannedRiskCard = cards.find((card) => /\brisk(?:s?|[- ]management| analysis| assessment)\b/i.test(clean(card.topic)));
  const plannedRiskIds = new Set(plannedRiskCard?.evidenceIds || []);
  const riskAlreadyOwned = plannedRiskCard && (
    !riskEvidenceIds.length
    || riskEvidenceIds.some((id) => plannedRiskIds.has(id))
    || proposal.risks.some((risk) => (plannedRiskCard.points || []).some((point) => {
      const riskTokens = new Set(clean(risk.text).toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 4));
      const pointText = clean(point).toLowerCase();
      const overlap = [...riskTokens].filter((token) => pointText.includes(token)).length;
      return riskTokens.size && overlap / riskTokens.size >= 0.45;
    }))
  );
  if (proposal.risks.length && !riskAlreadyOwned) cards.push({ topic: 'Risks', points: proposal.risks.map((item) => item.text), evidenceIds: riskEvidenceIds, topicId: 'canonical_risks' });
  return cards;
}

function warningFlags(warnings, stage) {
  return (warnings || []).map((warning, index) => ({
    ...warning,
    blocking: Boolean(warning.blocking),
    resolutionKey: warning.resolutionKey || `canonical_${stage}_${warning.type || index}`
  }));
}

function sampledIds(ids, maximum) {
  const values = [...new Set(ids || [])];
  if (values.length <= maximum) return values;
  return [...new Set(Array.from({ length: maximum }, (_unused, index) => values[Math.round(index * (values.length - 1) / (maximum - 1))]))];
}

function boundedEvidencePack(items, evidence, profile, stage) {
  const byId = new Map(evidence.events.map((event) => [event.id, event]));
  const actionStage = stage === 'actions';
  return (Array.isArray(items) ? items : []).map((item, itemIndex) => {
    const evidenceLimit = actionStage ? 8 : 4;
    const representativeIds = [...new Set([
      ...(Array.isArray(item.representativeEvidenceIds) ? item.representativeEvidenceIds : []),
      ...(Array.isArray(item.wordingEvidenceIds) ? item.wordingEvidenceIds : [])
    ])]
      .slice(0, evidenceLimit);
    const supportingIds = (Array.isArray(item.evidenceIds) ? item.evidenceIds : [])
      .filter((id) => !representativeIds.includes(id));
    const packedIds = [
      ...representativeIds,
      ...sampledIds(supportingIds, Math.max(0, evidenceLimit - representativeIds.length))
    ];
    return ({
    itemIndex,
    topic: clean(item.topic),
    owner: clean(item.owner),
    action: clean(item.action),
    deadline: clean(item.deadline),
    selectionMode: item.semanticOnly ? 'contextual_commitment_thread' : 'canonical_selected_action',
    recapCorroborated: Boolean(item.recapCorroborated),
    confidenceTier: clean(item.confidenceTier),
    reviewDisposition: clean(item.reviewDisposition),
    suggestedAction: clean(item.suggestedAction || item.action),
    reviewerUsefulnessScore: Number(item.reviewerUsefulnessScore || 0),
    reviewerUsefulnessTier: clean(item.reviewerUsefulnessTier),
    actionClassification: clean(item.actionClassification),
    ownerEvidenceType: clean(item.ownerEvidenceType),
    workstreamRelevance: item.workstreamRelevance || null,
    clusterKey: clean(item.clusterKey),
    clusterSize: Number(item.clusterSize || 0),
    alternateCandidateIds: Array.isArray(item.alternateCandidateIds) ? item.alternateCandidateIds : [],
    currentPoints: strings(item.points),
    // Consolidated threads retain broad supporting evidence, but the
    // representative event is the best reviewer-facing source snippet. Keep it
    // first so a short acknowledgement such as "Click" or "Yep" cannot hide
    // the actual commitment/requirement that produced the candidate.
    evidence: packedIds.map((id) => {
      const event = byId.get(id);
      if (!event) return null;
      const eventIndex = evidence.events.indexOf(event);
      const semantic = profile?.events?.[id] || {};
      return {
        id,
        speaker: clean(event.speaker),
        previous: clean(event.previousText).slice(0, 500),
        current: clean(event.text).slice(0, 700),
        next: clean(event.nextText).slice(0, 500),
        contextWindow: evidence.events.slice(
          Math.max(0, eventIndex - (item.recapCorroborated ? 1 : (actionStage ? 8 : 2))),
          Math.min(evidence.events.length, eventIndex + (item.recapCorroborated ? 2 : (actionStage ? 5 : 3)))
        ).map((contextEvent) => ({
          id: contextEvent.id,
          speaker: clean(contextEvent.speaker),
          text: clean(contextEvent.text).slice(0, 320)
        })),
        labels: {
          evidenceType: semantic.evidenceType || '',
          actionState: semantic.actionState || '',
          lifecycle: semantic.lifecycle || '',
          canonicalWorthiness: semantic.canonicalWorthiness || '',
          temporalRole: semantic.temporalRole || ''
        }
      };
    }).filter(Boolean)
  });
  });
}

function runCanonicalLiveStage(transcriptText, options = {}) {
  const stage = clean(options.stage).toLowerCase();
  if (!['summary', 'discussion', 'actions'].includes(stage)) throw new Error(`Unsupported canonical live stage: ${stage}`);
  const evidence = prepareEvidence(transcriptText);
  const observedTopology = assessEvidenceTopology(evidence);
  const topology = evidence.events.some((event) => event.structuredSource === 'actions_owner_deadline_table')
    ? { ...observedTopology, observedMode: observedTopology.mode, mode: 'standard', structuredMinutes: true }
    : observedTopology;
  const profile = loadMiniLMProfileSync(evidence, options);
  if (!profile?.available) throw new Error(`Canonical MiniLM profile unavailable: ${profile?.reason || 'unknown error'}`);
  const confirmed = options.confirmed || {};
  let state = buildConfirmedState(transcriptText, options.fileName || 'transcript.txt', confirmed);
  let proposal;
  if (stage === 'summary') proposal = semanticStages.contextStage(evidence, profile, state, options.reviewerGuidance, topology);
  if (stage === 'discussion') proposal = semanticStages.contentStage(evidence, state, profile);
  if (stage === 'actions') proposal = semanticStages.actionsStage(evidence, state, profile, topology);
  // Final provenance gate: drop anything without evidence from THIS transcript.
  proposal = groundProposal(proposal, evidence);
  const confirmedParticipants = strings(state.meeting?.participants);
  const nameCorrections = confirmedNameCorrections(confirmedParticipants, evidence.participants);
  const generatedScreen = stage === 'summary' ? summaryScreen(proposal)
    : stage === 'discussion' ? discussionScreen(proposal)
      : proposal.actions.map(({ owner, action, deadline, evidenceIds }) => ({
        owner: applyNameCorrections(owner, nameCorrections),
        action: capitaliseInitial(action),
        deadline: capitaliseInitial(deadline),
        evidenceIds
      }));
  const screen = applyConfirmedOverlay(stage, generatedScreen, state);
  const confirmedValueAudit = auditConfirmedAgainstScreen(state, stage, screen);
  const result = {
    pipeline: 'canonical_staged_v2',
    strategy: 'semantic_v2',
    stagedStage: stage,
    screens: { [stage]: screen },
    decisions: stage === 'discussion' ? proposal.decisions.map((item) => item.text) : strings(confirmed.decisions),
    risks: stage === 'discussion' ? proposal.risks.map((item) => item.text) : strings(confirmed.risks),
    validationFlags: [
      ...warningFlags(proposal.warnings, stage),
      // Something the reviewer corrected did not survive into this stage. That is our
      // failure, not theirs, so it is reported rather than made into an obstacle - but it
      // is reported, because the alternative is that it goes unnoticed, which is the
      // whole complaint.
      ...(confirmedValueAudit.missing.length ? [{
        type: 'reviewer_confirmed_value_missing',
        severity: 'warning',
        blocking: false,
        resolutionKey: `reviewer-confirmed-missing:${stage}`,
        message: `${confirmedValueAudit.missing.length} thing${confirmedValueAudit.missing.length === 1 ? '' : 's'} you confirmed earlier ${confirmedValueAudit.missing.length === 1 ? 'is' : 'are'} not reflected here: ${confirmedValueAudit.missing.map((item) => `${item.label} "${clean(item.value).slice(0, 60)}"`).join('; ')}.`,
        detail: {
          lead: 'Not carried into this screen',
          quote: clean(confirmedValueAudit.missing[0].value).slice(0, 240),
          meta: confirmedValueAudit.missing[0].label
        }
      }] : [])
    ],
    canonicalDiagnostics: {
      inputStateVersion: state.version,
      confirmedValueAudit,
      confirmedCollections: {
        objectives: state.objectives.length,
        topics: state.topics.length,
        discussion: state.discussion.length,
        decisions: state.decisions.length,
        risks: state.risks.length,
        actions: state.actions.length,
        criticalFacts: Array.isArray(state.meetingUnderstanding?.criticalFacts) ? state.meetingUnderstanding.criticalFacts.length : 0
      },
      evidenceEventCount: evidence.events.length,
      participantCount: evidence.participants.length,
      participants: evidence.participants,
      // The reviewer's attendee list first. Entity normalisation and the recovered-owner
      // resolution both read this, and both have been working from transcript speakers
      // only - so a name the reviewer corrected on screen 0 was normalised straight back
      // to the spelling the recorder produced, and the flag that says "using the confirmed
      // participant list" was describing something that had not happened.
      entityNames: [...new Set([
        ...confirmedParticipants,
        ...evidence.participants.filter((name) => !nameCorrections.has(clean(name))),
        ...extractMentionedPeople(transcriptText, evidence.participants)
      ])],
      topology: topology.mode,
      modelName: profile.modelName,
      humanConfirmedInputIsAuthoritative: true,
      initialUnderstanding: stage === 'summary' && proposal.initialUnderstanding ? {
        provenance: proposal.initialUnderstanding.provenance,
        meetingMode: proposal.initialUnderstanding.meetingMode,
        meetingPurpose: proposal.initialUnderstanding.meetingPurpose,
        spineCount: proposal.initialUnderstanding.meetingSpine?.length || 0,
        primaryWorkstreams: (proposal.initialUnderstanding.primaryWorkstreams || []).map((item) => ({
          label: item.label,
          provenance: item.provenance,
          evidenceCount: (item.evidenceIds || []).length
        })),
        materialClarificationCount: proposal.initialUnderstanding.materialClarifications?.length || 0,
        unresolvedNeedCount: proposal.initialUnderstanding.unresolvedNeeds?.length || 0,
        diagnostics: proposal.initialUnderstanding.diagnostics || null
      } : null,
      discussionPlan: stage === 'discussion' && proposal.discussionPlan ? proposal.discussionPlan : null
    },
    telemetryPreview: {
      topicCount: (profile.topics || []).length,
      discussionCards: stage === 'discussion' ? screen.length : 0,
      actionCount: stage === 'actions' ? screen.length : 0,
      embeddingClassifier: { used: true, model: profile.modelName },
      evidenceClassifier: { used: true }
    }
  };
  if (options.includeEvidencePack && ['discussion', 'actions'].includes(stage)) {
    const packItems = stage === 'actions' && Array.isArray(proposal.actionCandidates) && proposal.actionCandidates.length
      ? proposal.actionCandidates
      : screen;
    result._canonicalEvidencePack = boundedEvidencePack(packItems, evidence, profile, stage);
  }
  return result;
}

module.exports = { runCanonicalLiveStage, buildConfirmedState, capitaliseInitial, lowerInitialUnlessInitialism };
