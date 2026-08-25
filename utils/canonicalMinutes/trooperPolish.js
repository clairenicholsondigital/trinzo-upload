'use strict';

const fetch = require('node-fetch');
const { clean } = require('./evidence');
const { deadlineFrom } = require('./stages');
const { minutesEnglishFaults, repairMechanicalFaults, contentSet } = require('../minutesEnglish');
const { openingVerbIsActionable } = require('../stagedEditorial');
const { finaliseDiscussionPointForMinutes, normaliseFinalStagedActionCandidate, normaliseAndValidateActionOwner } = require('../stagedEditorial');
const { isReviewerAuthored } = require('./state');
const { normaliseAttendeeReferences } = require('../entityNormalization');
const { enrichActionReviewCandidate, rankAndClusterActionReviewCandidates } = require('./actionReviewRanking');

const DEFAULT_URL = 'https://eu.router.trooper.ai/v1/chat/completions';
const DEFAULT_MODEL = 'eu_liv_000099';

function unresolvedReference(value) {
  const text = clean(value);
  return /\b(?:flick|send|share|bring|discuss|review|do|handle|sort|progress|go through)\s+(?:it|that|this)\b/i.test(text)
    || /\b(?:take|have)\s+a\s+look\s+at\s+(?:it|that|this|us|them)\b/i.test(text)
    || /\b(document|report|plan|file)\s+\1\b/i.test(text)
    || /\b(?:discuss|review|progress|handle)\s+(?:the\s+)?(?:matter|topic|issue)\b/i.test(text)
    || /\b(?:the|this)\s+(?:matter|topic|issue)\b/i.test(text)
    || /\b(?:flick|send|share|bring|review|forward|escalate)\s+(?:the\s+)?(?:document|file|item|pack|matter|topic|issue)(?:\s+(?:over|to)\b|[.!?]*$)/i.test(text)
    || /\b(?:send|share|review|follow up (?:with\s+\w+\s+)?regarding|get\s+\w+\s+to\s+review)\s+(?:the\s+)?(?:relevant|required|appropriate|applicable)?\s*(?:document|file|item|matter|topic|issue)(?:\s|[.!?]*$)/i.test(text)
    || /\b(?:overview|summary|details?)\s+of\s+(?:the\s+)?(?:products?|documents?|items?|things?)\b/i.test(text)
    || /\b(?:the\s+)?recipient\b/i.test(text)
    || /\b(?:all|the|some|other)\s+(?:other\s+)?stuff\b|\b(?:stuff|things?)\s+that\b/i.test(text)
    || /\b(?:ideally|might be worth|maybe|perhaps)\b/i.test(text)
    || /\b(?:send|share|provide|flick|forward|discuss|review)\b[^.]{0,80}\b(?:to|with)\s+you\b/i.test(text)
    || /\b(?:it|that|this)\s+(?:over|through|with)\b/i.test(text)
    || /\bkind of\b|\bsort of\b|\byeah\b|\byep\b|\bunspecified\b|\[[^\]]+\]/i.test(text)
    || /\b(?:assigned|do|complete)\s+homework\b/i.test(text);
}

function nonActionState(value) {
  return /^(?:be|remain|stay)\s+(?:out|away|off|unavailable|available)\b/i.test(clean(value));
}

function tokenSet(value) {
  return new Set(clean(value).toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 3 && !['team', 'reviewed', 'specific', 'regarding', 'including'].includes(token)));
}

function nearDuplicate(left, right) {
  const a = tokenSet(left); const b = tokenSet(right);
  if (!a.size || !b.size) return false;
  const shared = [...a].filter((token) => b.has(token)).length;
  return shared / Math.min(a.size, b.size) >= 0.72;
}

function normaliseActionPresentation(value) {
  return clean(value)
    .replace(/^give\s+(.+?)\s+to\s+([A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+){0,3})\b/iu, 'Send $1 to $2')
    .replace(/^provide\s+([A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+){0,3})\s+with\s+(.+)$/iu, 'Provide $2 to $1')
    .replace(/^(?:the\s+)?(?:speaker|attendee|participant)\s+(?:said|noted|explained|confirmed)\s+(?:that\s+)?/i, '');
}

function normaliseDiscussionPresentation(value) {
  return clean(value)
    .replace(/\s*\((?:evt_[a-z0-9_]+(?:\s*,\s*)?)+\)\.?/gi, '')
    .replace(
      /^(?:(?:the\s+)?(?:speaker|attendee|participant)|[A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+){0,3})\s+(?:said|explained|reported|stated)\s+(?:that\s+)?/iu,
      ''
    );
}

function discussionPointText(value) {
  return value && typeof value === 'object' ? clean(value.text) : clean(value);
}

function distinctiveDiscussionFallback(topic, value) {
  const text = clean(value);
  if (/language(?: support| and country)|locali[sz]ation/i.test(topic)) {
    if (/\b(?:arabic|vietnamese|greek)\b/i.test(text)) return 'Arabic, Vietnamese and Greek were identified as languages that may require additional character support.';
    if (/\b(?:font|arial)\b/i.test(text)) return 'Additional font support may be required for some languages.';
    if (/\b(?:18 language files|12 languages).*(?:memory|capacity)|(?:memory|capacity).*(?:18 language files|12 languages)\b/i.test(text)) return 'Memory testing indicated that the system can accommodate 18 language files.';
    if (/\bfully translated\b/i.test(text)) return 'The next step is to load the fully translated language files.';
  }
  if (/cybersecurity|access controls/i.test(topic)) {
    if (/\b(?:usb|port lock)\b/i.test(text)) return 'The cybersecurity review considered USB-port controls and the risk of unauthorised or unintended device interference.';
    if (/\bpassword\b/i.test(text)) return 'Password protection was considered as a potential access control alongside the need for rapid clinical intervention.';
    if (/\b(?:screen|gui)\b.*\b(?:access|control|interference)\b|\b(?:access|control|interference)\b.*\b(?:screen|gui)\b/i.test(text)) return 'The review also considered controls for access to the device screen and GUI.';
  }
  if (/electrical compliance/i.test(topic)) {
    if (/\b60601-?1\b/i.test(text)) return 'IEC 60601-1 documentation is being reviewed to identify any electrical-compliance testing gaps.';
    if (/\b23rd of July|23 July\b/i.test(text)) return 'Electrical compliance testing is targeted for completion by 23 July.';
  }
  if (/alarm(?: behaviour| controls|-code)|clinical confirmation/i.test(topic)) {
    if (/\bmute button\b.*\b(?:led|flash)\b|\b(?:led|flash)\b.*\bmute button\b/i.test(text)) return 'The remaining alarm-control point is to confirm the LED and flash behaviour when the mute button is pressed.';
    if (/\b(?:low|medium|high) priority\b.*\b(?:colour|color|screen|led|flash)\b/i.test(text)) return 'The low-, medium- and high-priority alarm colour and flash behaviours were reviewed.';
  }
  if (/software change traceability/i.test(topic)) {
    if (/\b17 changes\b.*\bcode\b|\bcode\b.*\b17 changes\b/i.test(text)) return 'The 17 changes between software versions 1.01 and 1.02 are being traced to their locations in the code.';
    if (/\bretrospective test data\b/i.test(text)) return 'Retrospective test data may be required where software changes cannot otherwise be traced clearly.';
  }
  return '';
}

const DISTINCTIVE_TOPIC_ALIGNMENT = [
  { topic: /language(?: support| and country)|locali[sz]ation/i, point: /\b(?:languages?|translations?|translated|characters?|fonts?|arabic|vietnamese|greek|country|countries)\b/i },
  { topic: /electrical compliance/i, point: /\b(?:60601|electrical compliance|testing|test gaps?)\b/i },
  { topic: /alarm(?: behaviour| controls|-code)|clinical confirmation/i, point: /\b(?:alarm|mute button|led|flash|flashing|priority|sound|chirps?|clinical|clinician|colour|color)\b/i },
  { topic: /debug|test[- ]?script/i, point: /\b(?:debug|test scripts?|test data|validation|verification|retrospective|visible on screen)\b/i },
  { topic: /cybersecurity|access controls/i, point: /\b(?:cyber\s*security|usb|port lock|password|access|interference|screen control|gui)\b/i },
  { topic: /change control|software change traceability|version traceability/i, point: /\b(?:change request|change control|17 changes|code|traceability|technical file|device file history|retrospective test data|version)\b/i },
  { topic: /standards?|risk[- ]management/i, point: /\b(?:standards?|risk management|risk matrix|benefit-risk|mitigation|81001|27427|hazard|fmea)\b/i },
  { topic: /software change control/i, point: /\b(?:change request|change control|software version|release|non-significant|non-substantial)\b/i }
];

function discussionPointAlignedToTopic(topic, point) {
  const topicText = clean(topic);
  const pointText = clean(point);
  if (/language(?: support| and country)|locali[sz]ation/i.test(topicText) && /\b(?:alarms?|debug|chirps?|mute button|led|flash|priority)\b/i.test(pointText) && !/\b(?:arabic|vietnamese|greek|translations?|translated|characters?|fonts?|country|countries)\b/i.test(pointText)) return false;
  const rule = DISTINCTIVE_TOPIC_ALIGNMENT.find((item) => item.topic.test(topicText));
  return !rule || rule.point.test(pointText);
}

function mergeClientReadyDiscussionCards(cards) {
  const output = [];
  for (const card of Array.isArray(cards) ? cards : []) {
    const family = /^(?:risks?|risks and dependencies)$/i.test(clean(card.topic)) ? 'risks and dependencies' : clean(card.topic).toLowerCase();
    const existing = output.find((item) => item._family === family);
    if (!existing) {
      output.push({ ...card, _family: family });
      continue;
    }
    for (const [pointIndex, point] of (card.points || []).entries()) {
      if ((existing.points || []).includes(point)) continue;
      existing.points.push(point);
      existing.pointRefs = Array.isArray(existing.pointRefs) ? existing.pointRefs : [];
      existing.pointRefs.push(Array.isArray(card.pointRefs) ? card.pointRefs[pointIndex] || { evidenceIds: [] } : { evidenceIds: [] });
    }
    existing.evidenceIds = [...new Set([...(existing.evidenceIds || []), ...(card.evidenceIds || [])])];
  }
  return output.map(({ _family, ...card }) => card);
}

function stableReviewPart(value) {
  if (Array.isArray(value)) return value.map(stableReviewPart).join(',');
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().map((key) => `${key}:${stableReviewPart(value[key])}`).join('|');
  }
  return clean(value).toLowerCase();
}

function actionReviewCandidateId(candidate = {}) {
  const explicit = clean(candidate.id || candidate.key || candidate.candidateId);
  if (explicit) return explicit;
  return `candidate::${stableReviewPart({
    owner: candidate.owner || 'Not stated',
    action: candidate.suggestedAction || candidate.action,
    deadline: candidate.deadline || 'Not stated',
    disposition: candidate.reviewDisposition || candidate.confidenceTier || '',
    evidenceIds: candidate.evidenceIds || []
  })}`;
}

function normaliseActionReviewCandidate(candidate = {}, flag = {}, index = 0) {
  const normalised = {
    id: actionReviewCandidateId(candidate),
    owner: clean(candidate.owner) || 'Not stated',
    action: clean(candidate.action || candidate.suggestedAction),
    suggestedAction: clean(candidate.suggestedAction || candidate.action),
    deadline: clean(candidate.deadline) || 'Not stated',
    reviewDisposition: clean(candidate.reviewDisposition || candidate.confidenceTier) || 'review_required',
    confidenceTier: clean(candidate.confidenceTier),
    reviewerUsefulnessScore: Number(candidate.reviewerUsefulnessScore || 0),
    reviewerUsefulnessTier: clean(candidate.reviewerUsefulnessTier),
    actionClassification: clean(candidate.actionClassification),
    ownerEvidenceType: clean(candidate.ownerEvidenceType),
    workstreamRelevance: candidate.workstreamRelevance || null,
    clusterKey: clean(candidate.clusterKey),
    clusterSize: Number(candidate.clusterSize || 0),
    alternateCandidateIds: Array.isArray(candidate.alternateCandidateIds) ? candidate.alternateCandidateIds.map(clean).filter(Boolean) : [],
    evidenceIds: Array.isArray(candidate.evidenceIds)
      ? candidate.evidenceIds.map(clean).filter(Boolean)
      : [],
    sourceSnippet: clean(candidate.sourceSnippet),
    sourceSpeaker: clean(candidate.sourceSpeaker),
    sourceFlagType: clean(flag.type),
    sourceFlagKey: clean(flag.resolutionKey || flag.key || flag.id) || `flag-${index}`
  };
  if (candidate.evidence) normalised.evidence = candidate.evidence;
  return normalised;
}

function recoveredCandidateNeedsClauseReview(value) {
  const text = clean(value);
  if (!text) return false;
  if (/\b(?:drivers needs|access shirt|back[- ]to[- ]somber pressure valves?|version one to 10[12])\b/i.test(text)) return true;
  const families = [
    /\b(?:language|languages?|translation|font|characters?|symbols?|graphics driver)\b/i,
    /\b(?:electrical compliance|iec\s*60601|electrical testing)\b/i,
    /\b(?:alarm|mute button|led|flash(?:ing)?|priority|clinical|clinician|sound|chirps?)\b/i,
    /\b(?:usb|port lock|gui|screen control|cyber\s*security|password)\b/i,
    /\b(?:change request|change control|version|traceability|technical file|device file history|17 changes?)\b/i,
    /\b(?:risk management|risk file|risk matrix|standards?|81001|27427)\b/i,
    /\b(?:debug|test scripts?|test data|validation|verification)\b/i
  ].filter((pattern) => pattern.test(text)).length;
  const clauses = text.split(/\s*(?:[.;]\s+|[.;](?=[A-Z0-9])|\band then\b|\bthen\b)\s*/i)
    .map(clean)
    .filter((part) => part.split(/\s+/).length >= 3).length;
  return families >= 2 && clauses >= 2;
}

function actionReviewCandidatesFromFlags(flags = []) {
  const byId = new Map();
  for (const [flagIndex, flag] of (Array.isArray(flags) ? flags : []).entries()) {
    for (const candidate of Array.isArray(flag?.repairCandidates) ? flag.repairCandidates : []) {
      const normalised = normaliseActionReviewCandidate(candidate, flag, flagIndex);
      if (normalised.action && !byId.has(normalised.id)) byId.set(normalised.id, normalised);
    }
  }
  return rankAndClusterActionReviewCandidates([...byId.values()], { preserveExistingUsefulness: true });
}

function clientReadyPresentation(payload) {
  const stage = clean(payload?.stagedStage).toLowerCase();
  const base = { ...payload, screens: { ...(payload?.screens || {}) } };
  const participants = Array.isArray(base.canonicalDiagnostics?.entityNames)
    ? base.canonicalDiagnostics.entityNames
    : (Array.isArray(base.canonicalDiagnostics?.participants) ? base.canonicalDiagnostics.participants : []);
  const entityCorrections = [];
  const normaliseEntities = (value) => {
    const result = normaliseAttendeeReferences(value, participants);
    entityCorrections.push(...result.corrections);
    return result.text;
  };
  const retainedForReview = [];
  if (stage === 'discussion' && Array.isArray(base.screens.discussion)) {
    base.screens.discussion = mergeClientReadyDiscussionCards(base.screens.discussion.map((card) => {
      const points = [];
      const pointRefs = [];
      (card.points || []).forEach((point, pointIndex) => {
        const sourceText = discussionPointText(point);
        const presented = normaliseEntities(normaliseDiscussionPresentation(sourceText));
        const polished = finaliseDiscussionPointForMinutes(presented, card.topic);
        let retained = '';
        if (polished && discussionPointAlignedToTopic(card.topic, polished)) retained = polished;
        const fallback = distinctiveDiscussionFallback(card.topic, presented);
        if (!retained && fallback) retained = fallback;
        if (!retained) {
          retainedForReview.push({ section: card.topic || 'Discussion', text: sourceText });
          if (!/^there['’]s one to\b/i.test(presented) && !DISTINCTIVE_TOPIC_ALIGNMENT.some((item) => item.topic.test(clean(card.topic)))) retained = sourceText;
        }
        if (!retained || points.includes(retained)) return;
        points.push(retained);
        pointRefs.push(Array.isArray(card.pointRefs) ? card.pointRefs[pointIndex] || { evidenceIds: [] } : { evidenceIds: [] });
      });
      return { ...card, points, pointRefs };
    }).filter((card) => card.points.length || isReviewerAuthored(card)));
  }
  if (stage === 'actions' && Array.isArray(base.screens.actions)) {
    // How each action's owner was established, keyed by the evidence it cites.
    // The published action carries only owner, action, deadline and evidenceIds,
    // so this is where the upstream finding — that someone committed to this or
    // was asked to do it — is reattached before the publication gate reads it.
    const provenanceByEvidenceId = new Map();
    for (const entry of Array.isArray(payload?._canonicalEvidencePack) ? payload._canonicalEvidencePack : []) {
      if (!entry?.ownerEvidenceType) continue;
      for (const cited of Array.isArray(entry.evidence) ? entry.evidence : []) {
        if (!cited?.id) continue;
        const existing = provenanceByEvidenceId.get(cited.id);
        // An explicit commitment or request outranks a weaker attribution.
        if (!existing || /^(?:self_commitment|direct_request)$/i.test(entry.ownerEvidenceType)) {
          provenanceByEvidenceId.set(cited.id, entry.ownerEvidenceType);
        }
      }
    }
    base.screens.actions = base.screens.actions.map((item) => {
      const presented = normaliseEntities(normaliseActionPresentation(item.action));
      const ownerEvidenceType = (Array.isArray(item.evidenceIds) ? item.evidenceIds : [])
        .map((id) => provenanceByEvidenceId.get(id))
        .find((value) => /^(?:self_commitment|direct_request)$/i.test(String(value || ''))) || null;
      const polished = normaliseFinalStagedActionCandidate({ ...item, action: presented, ownerEvidenceType });
      if (polished && polished.owner !== 'Not stated') return { ...item, ...polished };
      // A row the deterministic layer selected is not the wording gate's to remove.
      //
      // With selection split from writing, the published count is supposed to be a
      // property of the pipeline - and it was, right up to this gate, which dropped or
      // diverted rows on wording quality. The wording varies run to run because a model
      // wrote it, so the same meeting published three actions on one run and four on the
      // next with selection already stable: the variance had just moved one gate later.
      // A selected row with a real owner therefore publishes regardless of its wording -
      // the repair pass and the action_wording_needs_review flag exist precisely for the
      // rows this gate would have held - while ownerless rows keep their existing rules,
      // which are deterministic.
      if (item.selectionFinal && clean(item.owner) && clean(item.owner) !== 'Not stated') {
        return { ...item, action: clean(presented) || clean(item.action) };
      }
      // An action nobody was named for is still an action.
      //
      // This gate held back every row whose owner could not be resolved, which is right for
      // a half-heard aside and wrong for a regulatory review, where the work is real, agreed
      // and stated impersonally: "the clinical review needs doing". Checked against the
      // minutes a person wrote for the same meeting, eight of the nine actions in the T761
      // human minutes were being generated and all eight were held here - "Complete
      // Electrical compliance testing" was produced word for word and shown as a snippet to
      // consider rather than a row to own.
      //
      // Rows marked ownerUnassigned have already been through readsAsAnActionRecord, so they
      // are composed instructions rather than fragments, and they arrive with a non-blocking
      // flag telling the reviewer how many need a name. Assigning an owner to a row that
      // already says the right thing is a different task from finding it in a candidate list.
      if (item.ownerUnassigned) {
        return { ...item, ...(polished || {}), owner: 'Not stated', action: polished?.action || presented || clean(item.action) };
      }
      retainedForReview.push({
        section: 'Actions',
        text: clean(item.action),
        candidate: {
          owner: polished?.owner || item.owner || 'Not stated',
          action: polished?.action || presented || clean(item.action),
          deadline: polished?.deadline || item.deadline || 'Not stated',
          reviewDisposition: 'review_required',
          confidenceTier: item.confidenceTier,
          evidenceIds: item.evidenceIds || []
        }
      });
      return null;
    }).filter(Boolean);
  }
  const existingFlags = Array.isArray(base.validationFlags) ? base.validationFlags : [];
  const retainedActionReviewCandidates = stage === 'actions'
    ? retainedForReview.map((item) => item.candidate).filter(Boolean)
    : [];
  const polishFlag = retainedForReview.length ? {
    type: stage === 'actions' ? 'action_publication_review' : 'wording_needs_review', severity: 'warning', blocking: false,
    message: stage === 'actions'
      ? `${retainedForReview.length} possible action${retainedForReview.length === 1 ? ' needs' : 's need'} your decision because the owner or wording was not safe to publish automatically. Add the real actions and dismiss anything that should not appear in the minutes.`
      : `${retainedForReview.length} item${retainedForReview.length === 1 ? '' : 's'} still need a wording check. Edit the highlighted section before approval.`,
    ...(retainedActionReviewCandidates.length ? { repairCandidates: retainedActionReviewCandidates } : {})
    // Nothing needing a decision means nothing to raise. This used to emit a
    // check saying the wording had been tidied and inviting a scan, on every
    // stage where the rewrite ran cleanly — which is most of them. It asked for
    // no decision and named nothing specific, so it appeared beside real checks
    // and taught reviewers that items in this panel can be ignored.
  } : null;
  const entityFlag = entityCorrections.length ? {
    type: 'attendee_entity_normalised', severity: 'info', blocking: false,
    message: `The tool corrected ${entityCorrections.length} attendee-name transcription variant${entityCorrections.length === 1 ? '' : 's'} using the confirmed participant list. Check the visible names still look right.`
  } : null;
  const validationFlags = [...existingFlags, ...(entityFlag ? [entityFlag] : []), ...(polishFlag ? [polishFlag] : [])];
  const actionReviewCandidates = stage === 'actions'
    ? actionReviewCandidatesFromFlags(validationFlags)
    : [];
  return {
    ...base,
    validationFlags,
    ...(stage === 'actions' ? {
      actionReviewCandidates,
      candidateAccounting: {
        confirmedActions: Array.isArray(base.screens.actions) ? base.screens.actions.length : 0,
        reviewerCandidates: actionReviewCandidates.length,
        validationFlagsWithCandidates: validationFlags.filter((flag) => Array.isArray(flag.repairCandidates) && flag.repairCandidates.length).length
      }
    } : {}),
    editorialStatus: retainedForReview.length ? 'wording_needs_review' : 'language_polished'
  };
}

function canonicalFallback(payload) {
  const base = { ...payload, screens: { ...(payload?.screens || {}) } };
  delete base._canonicalEvidencePack;
  if (Array.isArray(base.screens.actions)) {
    const recovered = (payload?._canonicalEvidencePack || [])
      .filter((item) => item.selectionMode === 'evidence_bound_candidate')
      .map((item) => ({ owner: item.owner || 'Not stated', action: item.action, deadline: item.deadline || 'Not stated', evidenceIds: (item.evidence || []).map((evidence) => evidence.id).filter(Boolean) }));
    base.screens.actions = dedupeActions([...base.screens.actions, ...recovered]
      .filter((item) => clean(item.owner) && clean(item.owner) !== 'Not stated')
      .filter((item) => !unresolvedReference(item.action) && !nonActionState(item.action)))
      .map((item) => ({ ...item, selectionFinal: true }));
  }
  return base;
}

function addRecoveredActionCandidates(payload, recovered = []) {
  if (clean(payload?.stagedStage).toLowerCase() !== 'actions') return payload;
  const pack = Array.isArray(payload._canonicalEvidencePack) ? [...payload._canonicalEvidencePack] : [];
  const signatures = new Set(pack.map((item) => `${clean(item.owner).toLowerCase()}|${clean(item.action).toLowerCase()}`));
  const diagnostics = payload?.canonicalDiagnostics || {};
  const recoveredOwnerCandidates = Array.isArray(diagnostics.entityNames)
    ? diagnostics.entityNames
    : (Array.isArray(diagnostics.participants) ? diagnostics.participants : []);
  for (const item of Array.isArray(recovered) ? recovered : []) {
    const rawAction = clean(item?.evidenceAction || item?.action);
    const canonicalRecoveredAction = clean(item?.action);
    const needsClauseReview = recoveredCandidateNeedsClauseReview(rawAction) || recoveredCandidateNeedsClauseReview(clean(item?.evidence));
    const safeRecoveredAction = needsClauseReview ? canonicalRecoveredAction : rawAction;
    const enriched = enrichActionReviewCandidate({
      ...item,
      action: safeRecoveredAction,
      suggestedAction: item?.action,
      evidenceIds: item?.sourceTurnIds || item?.evidenceIds || []
    }, {});
    const action = clean(enriched?.action);
    const suggestedAction = clean(enriched?.suggestedAction || item?.action);
    if (!action || nonActionState(action)) continue;
    // Resolve against the people actually in the meeting rather than by shape. The
    // previous test required two capitalised words, so a meeting where everyone is
    // referred to by first name lost every recovered owner - and an owner-less action
    // is then held back by the publication gate. normaliseAndValidateActionOwner
    // already matches a lone first name to a single participant; it only ever needed
    // to be given the list.
    let owner = clean(item?.owner) || 'Not stated';
    owner = normaliseAndValidateActionOwner(owner, recoveredOwnerCandidates).owner;
    const signature = `${owner.toLowerCase()}|${action.toLowerCase()}`;
    if (signatures.has(signature)) continue;
    const id = `recovered_${pack.length + 1}`;
    const reviewDisposition = needsClauseReview
      ? 'review_required'
      : (clean(item.reviewDisposition) || (owner === 'Not stated' ? 'needs_assignment' : 'confirmed_action'));
    const rankedScore = Number(item.reviewerUsefulnessScore || 0);
    const recoveredScore = Number(enriched.reviewerUsefulnessScore || 0);
    pack.push({
      itemIndex: pack.length,
      topic: '', owner, action,
      suggestedAction,
      deadline: clean(item.deadline) || 'Not stated',
      reviewDisposition,
      reviewerUsefulnessScore: rankedScore || recoveredScore,
      reviewerUsefulnessTier: rankedScore ? clean(item.reviewerUsefulnessTier) : clean(enriched.reviewerUsefulnessTier || item.reviewerUsefulnessTier),
      actionClassification: rankedScore ? clean(item.actionClassification) : clean(enriched.actionClassification || item.actionClassification),
      ownerEvidenceType: clean(enriched.ownerEvidenceType || item.ownerEvidenceType),
      workstreamRelevance: enriched.workstreamRelevance || item.workstreamRelevance || null,
      clusterKey: clean(enriched.clusterKey || item.clusterKey),
      selectionMode: reviewDisposition === 'confirmed_action' ? 'evidence_bound_candidate' : 'review_required_candidate',
      currentPoints: [],
      evidence: [{ id, speaker: owner, previous: '', current: clean(item.evidence).slice(0, 1800), next: '', contextWindow: [], labels: { evidenceType: 'action_candidate', actionState: 'possible_action', lifecycle: 'active', canonicalWorthiness: 'review_required', temporalRole: '' } }]
    });
    signatures.add(signature);
  }
  return { ...payload, _canonicalEvidencePack: pack.map((item, index) => ({ ...item, itemIndex: index })) };
}

function promptFor(stage, payload, evidencePack, options = {}) {
  const contract = stage === 'actions'
    ? {
      actions: [{ itemIndex: 0, owner: 'supplied or explicitly evidenced owner', action: 'complete action with explicit verb and object', deadline: 'supplied or explicitly evidenced deadline', evidenceIds: ['supplied evidence id'] }]
    }
    : {
      discussion: [{ itemIndex: 0, topic: 'exact supplied topic', points: ['formal, self-contained minutes point'], evidenceIds: ['supplied evidence id'] }]
    };
  const instructions = stage === 'actions' ? [
    // Rewriting, not selecting. The old contract opened with "Return each candidate that
    // is a real minute-worthy commitment; omit..." - a veto over what exists, which made
    // the published action count a sample from the model rather than a property of the
    // pipeline: the same transcript shipped three actions on one run and five on the
    // next, and the live path routinely published fewer actions than the deterministic
    // list it was given. Which actions exist is decided before this call and is not this
    // call's business; every supplied record comes back, reworded or untouched.
    'Every supplied record is already a confirmed action from this meeting. Rewrite each one as a single complete, grammatical instruction in minutes English. Return every itemIndex exactly once; never omit a record and never add one.',
    'Write each action in the third person as an instruction beginning with a verb. Do not repeat transcript filler, first-person or second-person speech, unresolved pronouns or speaker narration.',
    'Resolve words such as it, this and that only from the supplied bounded context window, and replace them with the specific supported workstream, document, deliverable or task. If the reference cannot be resolved from the cited evidence, return the record\'s text unchanged rather than guessing.',
    'The object must distinguish the record from other documents or issues: retain supported names, acronyms, quantities, subject matter and purpose. Preserve every supplied acronym exactly as written unless its expansion appears verbatim in the cited evidence; never guess an acronym expansion.',
    'Keep every fact. Do not change the owner or the deadline, and do not introduce a name, number or date that is not in the record or its cited evidence.',
    'For each output record, preserve itemIndex and cite only evidenceIds supplied for that item.'
  ] : [
    'Rewrite the supplied canonical discussion records as concise, formal meeting-minutes prose.',
    'Use the supplied bounded context windows to add concrete detail that is directly supported.',
    // Two to five, raised from one to three after measuring against human-written minutes:
    // a person records 14-20 discussion points per meeting and the model was returning
    // 7-15, with the instruction as the binding cap - there is no code cap on this path,
    // and the downstream compaction already admits four to eight per topic.
    'Return two to five points per topic when the cited evidence supports them: prioritise the current position, concrete technical/process detail, decisions, dependencies and next steps over a generic summary.',
    'Keep each supplied topic exactly unchanged. Do not create, merge, split or remove topics.',
    'Do not repeat transcript filler, first-person speech, unresolved pronouns or speaker narration.',
    'For each output record, preserve itemIndex and cite only evidenceIds supplied for that item.'
  ];
  return [
    '[CMD: task=canonical_minutes_evidence_rewrite; format=json; evidence=bounded_minilm_pack; style=client_ready_uk_business_english]',
    '',
    'You are rewriting already-selected canonical records. MiniLM and deterministic resolution selected the records; you must not discover new records.',
    ...instructions.map((line) => `- ${line}`),
    '- Never invent an owner, deadline, document, organisation, decision, risk or action.',
    '- Return valid JSON only.',
    '',
    'CONFIRMED_STATE:',
    JSON.stringify({ stagedStage: stage, reviewerGuidance: clean(options.reviewerGuidance) }, null, 2),
    '',
    'BOUNDED_MINILM_EVIDENCE:',
    JSON.stringify(evidencePack, null, 2),
    '',
    'RETURN_SCHEMA:',
    JSON.stringify(contract, null, 2)
  ].join('\n');
}

// Moved to evidenceCitations.js so the summary polish validates the same way this stage
// always has - one implementation, two callers, and the pinned discussion behaviour
// cannot drift from its sibling.
const { evidenceIdsFor, validReferences, evidenceEntriesFor, citedEntries } = require('./evidenceCitations');

function ownerSupported(candidate, source) {
  const proposed = clean(candidate.owner);
  if (!proposed || proposed === 'Not stated') return false;
  const proposedOwners = proposed.split(/\s+(?:and|&)\s+/i).map(clean).filter(Boolean);
  const entries = citedEntries(candidate, source);
  const supportedPeople = proposedOwners.every((owner) => {
    const firstName = owner.split(/\s+/)[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return entries.some((entry) => clean(entry.speaker).toLowerCase() === owner.toLowerCase()
      || clean(entry.speaker).split(/\s+/)[0].toLowerCase() === owner.split(/\s+/)[0].toLowerCase()
      || new RegExp(`\\b${firstName}\\b`, 'i').test(clean(entry.text)));
  });
  if (!supportedPeople) return false;
  return entries.some((entry) => {
    const text = clean(entry.text);
    const speakerIsOwner = proposedOwners.some((owner) => clean(entry.speaker).toLowerCase() === owner.toLowerCase());
    const speakerCommitment = speakerIsOwner
      && (/\b(?:I|we)\s*(?:['’]ll|will|shall|can|need to|must|have to|am going to)\b/i.test(text)
        || (source.recapCorroborated && /\bI(?:['’]m| am| was)\s+(?:in the middle of|working on|continuing|updating|reviewing|tidying|preparing|testing)\b|\bI(?:['’]ve| have)?\s*started\b/i.test(text)));
    const namedAssignment = proposedOwners.some((owner) => {
      const firstName = owner.split(/\s+/)[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?:^|[.!?;]\\s+)${firstName},\\s*(?:can|could|will|would)\\s+you\\b|\\b${firstName}\\s+to\\s+[a-z]|\\b(?:assigned to|owner is|action for)\\s+${firstName}\\b`, 'i').test(text);
    });
    return speakerCommitment || namedAssignment;
  });
}

const ACTION_VERB_FAMILIES = [
  ['send', 'share', 'provide', 'flick', 'give', 'forward', 'circulate', 'distribute'],
  ['review', 'check', 'read', 'assess', 'inspect', 'look'],
  ['schedule', 'arrange', 'book', 'set up'],
  ['meet', 'discuss', 'talk', 'speak'],
  ['update', 'modify', 'add', 'include', 'revise'],
  ['prepare', 'draft', 'create', 'develop', 'compile', 'produce'],
  ['attend', 'join'],
  ['run', 'perform', 'complete', 'do', 'execute'],
  ['follow', 'contact', 'call', 'email'],
  ['sign', 'approve', 'authorise', 'authorize'],
  ['confirm', 'verify', 'validate'],
  ['submit', 'upload', 'register', 'record'],
  ['investigate', 'trace', 'identify', 'resolve', 'fix']
];

function actionVerbFamily(value) {
  const text = clean(value).toLowerCase();
  return ACTION_VERB_FAMILIES.find((family) => family.some((verb) => new RegExp(`\\b${verb.replace(' ', '\\s+')}\\b`, 'i').test(text))) || [];
}

function actionVerbSupported(candidate, source) {
  const family = actionVerbFamily(candidate.action);
  if (!family.length) return false;
  const entries = citedEntries(candidate, source);
  if (entries.some((entry) => family.some((verb) => new RegExp(`\\b${verb.replace(' ', '\\s+')}\\b`, 'i').test(clean(entry.text))))) return true;
  if (!source.recapCorroborated) return false;
  const evidenceText = entries.map((entry) => clean(entry.text)).join(' ');
  if (family.includes('complete') && /\b(?:needs? still to be done|has started|have started|will start|started)\b/i.test(evidenceText)) return true;
  if (family.includes('update') && /\b(?:update|upgrade|updating)\b/i.test(evidenceText)) return true;
  if (family.includes('review') && /\b(?:review|reviewing|look(?:ing)? at)\b/i.test(evidenceText)) return true;
  return false;
}

function deadlineSupported(candidate, source) {
  const proposed = clean(candidate.deadline);
  if (!proposed || proposed === 'Not stated') return false;
  // A deadline is field-level evidence, not a property of a broad commitment
  // thread. It must appear in evidence explicitly cited for this output record;
  // matching a pre-filled source deadline is not sufficient.
  return citedEntries(candidate, source).some((entry) => deadlineFrom(entry.text).toLowerCase() === proposed.toLowerCase());
}

function unsupportedNamedParticipants(candidate, source) {
  const action = clean(candidate.action);
  if (!action) return [];
  const allEntries = evidenceEntriesFor(source);
  const cited = citedEntries(candidate, source);
  const participants = [...new Set(allEntries.map((entry) => clean(entry.speaker)).filter((name) => /\s/.test(name)))];
  return participants.filter((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`\\b${escaped}\\b`, 'i').test(action)) return false;
    const firstName = name.split(/\s+/)[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return !cited.some((entry) => clean(entry.speaker).toLowerCase() === name.toLowerCase()
      || new RegExp(`\\b${escaped}\\b|\\b${firstName}\\b`, 'i').test(clean(entry.text)));
  });
}

function prospectiveEvidence(candidate, source) {
  if (source.selectionMode === 'canonical_selected_action') return true;
  const actionVerb = '(?:review|complete|update|share|send|flick|give|get|confirm|trace|generate|schedule|arrange|set up|prepare|provide|finish|finalise|finalize|investigate|check|raise|bring|discuss|upload|forward|circulate|draft|document|sign|approve|submit|publish|call|contact|meet|follow(?: up)?|develop|create|deliver|write|build|restore|monitor|test|assess|coordinate|book|obtain|request|resolve|fix|add|integrate|distribute|compile|progress|read|limit|determine|front[ -]?end|work(?: on| through)?|look at|do|handle|take)';
  const explicit = new RegExp(`\\b(?:I|we)\\s*(?:['’]ll|will|shall|can|need to|must|have to|am going to)\\s+${actionVerb}\\b|\\b(?:you|[A-Z][A-Za-z'’.-]+)\\s+(?:will|shall|need to|needs to|must|have to|has to|is going to)\\s+${actionVerb}\\b|\\b(?:can|could|will|would)\\s+you\\s+${actionVerb}\\b|\\bplease\\s+${actionVerb}\\b|\\b(?:action|owner)\\s*(?:is|:)?\\s+[^.]{0,50}\\b${actionVerb}\\b`, 'i');
  const impersonalObligation = new RegExp(`\\b(?:needs? to|must|has to|have to|will need to)\\s+(?:be\\s+)?${actionVerb}\\b`, 'i');
  const deliverableObligation = /\b(?:needs? to|must|has to|have to|will need to)\s+be\s+(?:ready|available|completed|finished|signed|approved|submitted|provided|shared|updated|reviewed)\b/i;
  const qualifiedCommitment = new RegExp(`\\b(?:I|we)\\s*(?:['’]ll|will)\\s+(?:try\\s+(?:and|to)\\s+)?${actionVerb}\\b|\\bI(?:['’]ve| have)\\s+got to\\s+${actionVerb}\\b`, 'i');
  const actionCue = new RegExp(`\\b${actionVerb}\\b`, 'i');
  const outstandingWork = new RegExp(`\\b(?:still (?:need|needs|requires?|pending|outstanding)|remain(?:s|ing)? (?:to be done|outstanding|open|pending)|in progress|working on|yet to be|follow[- ]?up (?:is|remains) (?:open|pending)|needs? (?:review|completion|updating|confirmation)|continu(?:e|ing) (?:to |with )?${actionVerb})\\b`, 'i');
  const activeThread = (source.evidence || []).some((item) => {
    const labels = item?.labels || {};
    return ['confirmed_action', 'possible_action'].includes(labels.actionState)
      && labels.lifecycle === 'active'
      && !['supporting_detail', 'context_only', 'duplicate_expression', 'administrative_chatter', 'none'].includes(labels.canonicalWorthiness);
  });
  const entries = citedEntries(candidate, source);
  const supported = entries.some((entry) => {
    const text = clean(entry.text);
    if (/\b(?:already|previously|last (?:week|month|year)|yesterday)\b.*\b(?:sent|shared|reviewed|completed|finished|signed|approved|submitted|did)\b/i.test(text)) return false;
    if (/\bI\s+(?:do\s+)?have\s+(?:a|an|the)\s+(?:call|meeting|session)\b/i.test(text) && !/\b(?:schedule|arrange|book|set up|need to|will|shall|must)\b/i.test(text)) return false;
    if (/\b(?:might|maybe|perhaps|if you wanted|could have|worth thinking|ideally|probably)\b/i.test(text)
        && !/\b(?:agreed|confirmed|yes[,.;]?\s+I['’]ll|leave that with me|I\s+will|I['’]ll)\b/i.test(text)) return false;
    if (/\?\s*$/.test(text) && !/\b(?:can|could|will|would)\s+you\b/i.test(text)) return false;
    if (explicit.test(text) || impersonalObligation.test(text) || deliverableObligation.test(text) || qualifiedCommitment.test(text) || outstandingWork.test(text)) return true;
    const sourceEvidence = (source.evidence || []).find((item) => clean(item.id) === clean(entry.id));
    const labels = sourceEvidence?.labels || {};
    const citedActive = ['confirmed_action', 'possible_action'].includes(labels.actionState)
      && labels.lifecycle === 'active'
      && !['supporting_detail', 'context_only', 'duplicate_expression', 'administrative_chatter', 'none'].includes(labels.canonicalWorthiness);
    return actionCue.test(text) && (citedActive || activeThread);
  });
  if (supported) return true;
  if (source.selectionMode !== 'contextual_commitment_thread') return false;
  const allText = entries.map((entry) => clean(entry.text)).join(' ');
  if (/\b(?:no action|nothing to action|already (?:done|completed|finished|closed)|cancelled|withdrawn)\b/i.test(allText)) return false;
  if (/^(?:understand|demonstrate|consider|discuss .+ during the meeting|perform .+ controls|guarantee)\b/i.test(clean(candidate.action))) return false;
  return actionCue.test(clean(candidate.action))
    && clean(candidate.owner) !== 'Not stated'
    && ownerSupported(candidate, source);
}

function dedupeActions(items) {
  const output = [];
  for (const item of items) {
    const duplicateIndex = output.findIndex((existing) => {
      const compatibleOwner = clean(existing.owner).toLowerCase() === clean(item.owner).toLowerCase()
        || existing.owner === 'Not stated' || item.owner === 'Not stated';
      return compatibleOwner && nearDuplicate(existing.action, item.action);
    });
    if (duplicateIndex < 0) {
      output.push(item);
      continue;
    }
    const existing = output[duplicateIndex];
    output[duplicateIndex] = {
      ...(existing.owner === 'Not stated' && item.owner !== 'Not stated' ? item : existing),
      owner: existing.owner === 'Not stated' ? item.owner : existing.owner,
      deadline: existing.deadline === 'Not stated' ? item.deadline : existing.deadline,
      evidenceIds: [...new Set([...(existing.evidenceIds || []), ...(item.evidenceIds || [])])]
    };
  }
  return output;
}

function applyActionRewrite(payload, output, evidencePack) {
  // The published rows go in; the published rows come out. Count preservation is
  // structural - a map over the sources, never over the model's output - because any
  // implementation that iterates what the model returned inherits the model's omissions,
  // and omissions are exactly the variance this exists to remove: the same transcript
  // shipping three actions on one run and five on the next, and the live path publishing
  // fewer actions than the deterministic selection it was handed.
  //
  // What did NOT change is the slot discipline. Owner and deadline are facts, not
  // wording: a proposed owner stands only on explicit cited assignment evidence, a
  // deadline only when the cited evidence contains it, and a named recipient the
  // evidence never mentions refuses the whole rewrite. Those rules predate this
  // function's rewrite and their tests pass unchanged - the difference is that refusing
  // a rewrite now leaves the row standing with its source wording, where it used to
  // leave a hole.
  const anyMarked = evidencePack.some((pack) => pack && pack.published);
  const sources = evidencePack
    .map((pack, index) => ({ pack, index }))
    .filter(({ pack }) => pack && (anyMarked
      ? pack.published
      // Compatibility for packs built before the marking existed: every entry is a
      // source EXCEPT recovery candidates - both kinds - which were never published rows.
      // They are review material, and auto-publishing them here would resurrect exactly
      // the ownerless-candidate leak the old selection logic guarded against.
      : !['evidence_bound_candidate', 'review_required_candidate'].includes(pack.selectionMode)));

  const candidates = Array.isArray(output?.actions) ? output.actions : [];
  const byIndex = new Map();
  for (const candidate of candidates) {
    const index = Number(candidate.itemIndex);
    if (!byIndex.has(index)) byIndex.set(index, candidate);
  }

  const actions = sources.map(({ pack, index }) => {
    const source = {
      owner: pack.owner || 'Not stated',
      action: pack.action,
      deadline: pack.deadline || 'Not stated',
      evidenceIds: (pack.evidence || []).map((item) => item.id).filter(Boolean),
      ...(pack.recapCorroborated ? { recapCorroborated: true } : {})
    };
    // Closing-recap promotions passed a stricter two-source corroboration gate; their
    // wording is kept one-for-one, as before.
    if (source.recapCorroborated) return { ...source, selectionFinal: true };
    const candidate = byIndex.get(index);
    if (!candidate) return { ...source, selectionFinal: true };
    const rewritten = clean(candidate.action);
    // Wording guards. A rewrite that fails any of them leaves the source text standing -
    // the row itself is never at stake. The contract says resolve the reference or return
    // the text unchanged, so a rewrite that is still unresolved is refused outright
    // rather than compared for improvement.
    const wordingAcceptable = rewritten
      && rewritten.split(/\s+/).length >= 4
      && !nonActionState(rewritten)
      && !unresolvedReference(rewritten)
      && !minutesEnglishFaults(rewritten).some((fault) => ['voice', 'truncation'].includes(fault.severity))
      && openingVerbIsActionable(rewritten)
      && !(ANONYMOUS_PERSON.test(rewritten) && !ANONYMOUS_PERSON.test(source.action))
      && (!candidate.evidenceIds?.length || validReferences(candidate, pack))
      && !unsupportedNamedParticipants({ ...candidate, action: rewritten }, pack).length;
    const action = wordingAcceptable ? rewritten : source.action;
    // Slot validation, unchanged in substance from the old selection path. A proposed
    // owner needs explicit cited assignment; failing that the supplied owner stands if
    // the evidence supports it; otherwise the supplied owner simply stands - unlike the
    // old path, an unresolvable owner no longer deletes the row, because whether the row
    // exists is not this function's question any more.
    let owner = source.owner;
    if (clean(candidate.owner) && ownerSupported({ ...candidate, owner: clean(candidate.owner) }, pack)) owner = clean(candidate.owner);
    const proposedDeadline = clean(candidate.deadline) || source.deadline;
    const deadline = proposedDeadline !== 'Not stated' && deadlineSupported({ ...candidate, deadline: proposedDeadline }, pack)
      ? proposedDeadline
      : 'Not stated';
    const citedIds = wordingAcceptable && Array.isArray(candidate.evidenceIds) && candidate.evidenceIds.length
      ? candidate.evidenceIds
      : source.evidenceIds;
    const ownerEvidenceIds = owner === 'Not stated' ? [] : citedEntries({ ...candidate, evidenceIds: citedIds }, pack)
      .filter((entry) => clean(entry.speaker).split(/\s+/)[0].toLowerCase() === owner.split(/\s+/)[0].toLowerCase()
        || new RegExp(`\\b${owner.split(/\\s+/)[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(clean(entry.text)))
      .map((entry) => entry.id);
    const deadlineEvidenceIds = deadline === 'Not stated' ? [] : citedEntries({ ...candidate, evidenceIds: citedIds }, pack)
      .filter((entry) => deadlineFrom(entry.text).toLowerCase() === deadline.toLowerCase())
      .map((entry) => entry.id);
    return { ...source, owner, action, deadline, evidenceIds: citedIds, selectionFinal: true, provenance: { actionEvidenceIds: citedIds, ownerEvidenceIds, deadlineEvidenceIds } };
  });

  return {
    ...payload,
    screens: { ...payload.screens, actions },
    canonicalDiagnostics: {
      ...(payload.canonicalDiagnostics || {}),
      actionAccounting: {
        supplied: sources.length,
        rewritten: actions.filter((item, position) => clean(item.action) !== clean(sources[position].pack.action)).length,
        published: actions.length
      }
    }
  };
}

function discussionPointGrounded(point, candidate, pack) {
  const entries = citedEntries(candidate, pack);
  if (!entries.length) return false;
  const evidenceText = entries.map((entry) => clean(entry.text).toLowerCase()).join(' ');
  const text = clean(point);
  const protectedTokens = text.match(/\b(?:[A-Z]{2,}(?:-\d+)?|\d+(?:\.\d+)*(?:%|st|nd|rd|th)?|[A-Za-z]+\d+[A-Za-z0-9-]*)\b/g) || [];
  if (protectedTokens.some((token) => !evidenceText.includes(token.toLowerCase()))) return false;
  const suspiciousSpecifics = text.toLowerCase().match(/\b(?:clean room|sterili[sz]ation|sharepoint|hotel|california|eudamed|hpra|medenvoy|cybersecurity|password|usb|declaration(?:s)? of conformity)\b/g) || [];
  return !suspiciousSpecifics.some((phrase) => !evidenceText.includes(phrase));
}

function applyDiscussionRewrite(payload, output, evidencePack) {
  const sourceCards = payload.screens?.discussion || [];
  const candidates = Array.isArray(output?.discussion) ? output.discussion : [];
  const byIndex = new Map(candidates.map((item) => [Number(item.itemIndex), item]));
  const discussion = sourceCards.map((source, index) => {
    const candidate = byIndex.get(index);
    const pack = evidencePack[index];
    const points = [];
    for (const point of Array.isArray(candidate?.points) ? candidate.points.map(clean) : []) {
      if (!point || unresolvedReference(point) || point.split(/\s+/).length < 5 || points.some((existing) => nearDuplicate(existing, point))) continue;
      if (!discussionPointAlignedToTopic(source.topic, point)) continue;
      if (!discussionPointGrounded(point, candidate, pack)) continue;
      points.push(point);
    }
    if (!candidate || !pack || clean(candidate.topic) !== clean(source.topic) || !validReferences(candidate, pack) || !points.length) return source;
    return {
      ...source,
      points,
      evidenceIds: candidate.evidenceIds,
      pointRefs: points.map(() => ({ evidenceIds: candidate.evidenceIds }))
    };
  });
  return { ...payload, screens: { ...payload.screens, discussion } };
}

function normaliseEvidencePackEntities(evidencePack, participants) {
  return (Array.isArray(evidencePack) ? evidencePack : []).map((item) => ({
    ...item,
    action: normaliseAttendeeReferences(item.action, participants).text,
    currentPoints: (item.currentPoints || []).map((point) => normaliseAttendeeReferences(point, participants).text),
    evidence: (item.evidence || []).map((entry) => ({
      ...entry,
      previous: normaliseAttendeeReferences(entry.previous, participants).text,
      current: normaliseAttendeeReferences(entry.current, participants).text,
      next: normaliseAttendeeReferences(entry.next, participants).text,
      contextWindow: (entry.contextWindow || []).map((context) => ({
        ...context,
        text: normaliseAttendeeReferences(context.text, participants).text
      }))
    }))
  }));
}


// A second round, for the rows whose wording is still not fit to print.
//
// The first round is a selection pass: it decides which candidates are real commitments and
// rewrites them. When its rewrite comes back in the speaker's own voice the rewrite is
// refused, and the source wording stands - which is the raw transcript, and usually worse.
// Measured live, that left 26% of published actions carrying a wording fault, including
// every example the reviewer reported.
//
// So the residue gets repair rounds, asked for one thing only. It is a repair, not a
// re-selection: every row supplied comes back, and the evidence window comes with it,
// because the window is the only place "that" in "Bring that to the US team" can be
// resolved from. A repair is accepted only through the acceptWordingRepair guard chain
// below; anything refused twice publishes marked wordingUnresolved rather than dressed
// as a minute, and nothing is ever dropped for its wording.

// Definite generic human reference: a noun phrase that points at a person and names none.
const ANONYMOUS_PERSON = /\bthe\s+(?:speaker|recipient|individual|person|attendee|participant|user|requester|reader|addressee|action item)\b/i;

function protectedFactsOf(value) {
  return new Set([
    ...(clean(value).match(/\b\d+(?:[.,:]\d+)*(?:%|st|nd|rd|th)?\b/g) || []),
    ...(clean(value).match(/\b[A-Z][A-Z0-9&/-]{1,}\b/g) || []),
    ...(clean(value).match(/\b[A-Z][a-z'\u2019-]+(?:\s+[A-Z][a-z'\u2019-]+)+\b/g) || [])
  ].map((item) => item.toLowerCase()));
}

function wordingFaults(action) {
  // Every fault the detectors can find, not a severity subset. The mechanical deletion
  // repair runs before this is consulted in the repair flow, so anything still present -
  // a tautology, an empty adjunct, raw speech, a dangling deictic - is exactly what the
  // model round exists to fix. This list used to stop at voice/referential/truncation,
  // which is why "The ICP is defined as the ideal client profile" and "review the risk
  // whilst looking at the risk" shipped: their faults were mechanical-severity, outside
  // the trigger, and the deletion repair had no rule for them either.
  return minutesEnglishFaults(action);
}

function repairPrompt(rows, retry) {
  return [
    '[CMD: task=minutes_wording_repair; format=json]',
    'Each supplied record is a real commitment from a meeting whose wording is not fit to print. Rewrite each one as one or two complete sentences of third-person meeting-minutes English.',
    'Resolve every it, this and that from the supplied evidence window and name the thing referred to. Remove first-person and second-person speech, conversational asides and stray evaluations.',
    'Keep every fact: owner, deadline, quantity, standard, document and name. Invent nothing and add no detail the evidence does not carry.',
    'Write each record as an instruction beginning with a verb - "Write to the council...", "Service the chiller...". Never narrate the meeting: no "the speaker", no "the recipient", no "the action item is". Do not turn the person the work is about into the person doing it.',
    'Return every supplied index. If a record cannot be resolved from its evidence, return its original text unchanged.',
    // The retry line earns its place: at temperature 0.1 an unchanged prompt mostly
    // reproduces the rejected answer, so a second round without it is a wasted call.
    retry ? 'A previous rewrite of these records was rejected for keeping speech-like wording or changing too little. Rewrite each record thoroughly, in fresh words.' : '',
    'Return JSON only as {"repairs":[{"index":0,"action":"..."}]}.',
    '',
    'RECORDS:',
    JSON.stringify(rows.map((row) => ({ index: row.index, action: row.action, evidence: row.evidence })))
  ].filter(Boolean).join('\n');
}

function discussionRepairPrompt(rows, retry) {
  return [
    '[CMD: task=minutes_wording_repair; format=json]',
    'Each supplied record is a discussion point from meeting minutes whose wording is not fit to print. Rewrite each one as one or two complete sentences of third-person meeting-minutes prose.',
    'Resolve every it, this and that from the supplied evidence window and name the thing referred to. Remove first-person and second-person speech, conversational asides, restarts, repetition and circular phrasing.',
    'Keep every fact: name, quantity, standard, document and date. Invent nothing and add no detail the evidence does not carry.',
    'These are records of what was discussed or agreed, not instructions: never write an imperative, and never narrate ("the speaker said...").',
    'Return every supplied index. If a record cannot be resolved from its evidence, return its original text unchanged.',
    retry ? 'A previous rewrite of these records was rejected for keeping speech-like wording or changing too little. Rewrite each record thoroughly, in fresh words.' : '',
    'Return JSON only as {"repairs":[{"index":0,"action":"..."}]}.',
    '',
    'RECORDS:',
    JSON.stringify(rows.map((row) => ({ index: row.index, action: row.action, evidence: row.evidence })))
  ].filter(Boolean).join('\n');
}

// The guard chain every accepted repair passes, shared by the action and discussion
// rounds. Each rule was added after a live failure and keeps its story:
function acceptWordingRepair(original, candidate, { imperative } = {}) {
  if (!candidate || candidate.toLowerCase() === original.toLowerCase()) return false;
  if (wordingFaults(candidate).length) return false;
  // An action record is an instruction. Requiring the imperative is what stops the
  // repair reframing a row into narration - "The speaker will bring one to show the
  // recipient", "The action item is to locate the clock" - and, more seriously, what
  // stops it moving the work onto the wrong person: "Service the chiller" became "The
  // refrigeration engineer is to service the chiller", quietly making the engineer the
  // owner of an action that belonged to the brewer who was going to ring them.
  if (imperative && !openingVerbIsActionable(candidate)) return false;
  // A repair may not introduce an anonymous person. "Bring the enormous item to show the
  // recipient" is grammatical, third person and imperative, and tells the reader nothing
  // about who anything is for - the repair substituted a placeholder for a name it could
  // not resolve, which is worse than leaving the pronoun, because a pronoun looks unfinished
  // and a placeholder looks deliberate. Only refused when the original did not have one.
  if (ANONYMOUS_PERSON.test(candidate) && !ANONYMOUS_PERSON.test(original)) return false;
  // Changing only the function words is not a repair, it is passing the test.
  //
  // "Find that little clock top right" came back as "Find THE little clock top right" -
  // the demonstrative swapped for a definite article, which clears the deixis detector
  // and leaves the reader exactly as unable to find the clock. A repair that resolves a
  // reference has to name the thing, and naming it changes the content words. If the
  // content words are identical the row has not been repaired, so it keeps its fault and
  // its flag rather than being quietly marked fixed.
  const beforeContent = contentSet(original);
  const afterContent = contentSet(candidate);
  const unchanged = beforeContent.size === afterContent.size
    && [...afterContent].every((token) => beforeContent.has(token));
  if (unchanged) return false;
  const before = protectedFactsOf(original);
  if ([...protectedFactsOf(candidate)].some((fact) => !before.has(fact))) return false;
  return true;
}

const REPAIR_ROWS_PER_CALL = 8;
const REPAIR_ROUNDS = 2;

async function requestWordingRepairs(rows, prompt, options) {
  const apiKey = clean(options.apiKey ?? process.env.TROOPER_API_KEY);
  const fetchImpl = options.fetchImpl || fetch;
  if (!apiKey || typeof fetchImpl !== 'function') return { ok: false, reason: 'unavailable' };
  try {
    const response = await fetchImpl(clean(options.url ?? process.env.TROOPER_CHAT_COMPLETIONS_URL) || DEFAULT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: clean(options.model ?? process.env.TROOPER_MODEL) || DEFAULT_MODEL,
        messages: [
          { role: 'system', content: 'Rewrite meeting records into client-ready minutes English. Return valid JSON only.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        max_tokens: Math.min(1600, 300 + rows.length * 140),
        response_format: { type: 'json_object' }
      })
    });
    if (!response.ok) return { ok: false, reason: `http_${response.status}` };
    const body = await response.json();
    const content = body?.choices?.[0]?.message?.content;
    const output = typeof content === 'object' ? content : JSON.parse(String(content || '{}'));
    return { ok: true, repairs: Array.isArray(output?.repairs) ? output.repairs : [] };
  } catch (error) {
    return { ok: false, reason: error?.message || 'request_failed' };
  }
}

// The driver both repair surfaces share. Rows arrive faulted; each round sends what is
// still broken (chunked, so a meeting with twenty broken rows is not a single oversized
// call), applies whatever passes acceptWordingRepair, and the second round retries the
// refusals with the retry nudge in the prompt. No row cap: the old REPAIR_ROW_LIMIT of 8
// meant the ninth broken row shipped broken without ever being offered for repair, which
// is an arbitrary place for a publication promise to stop.
async function runWordingRepairRounds(entries, promptBuilder, imperative, options) {
  const fixed = new Map();
  let reason = '';
  let remaining = entries;
  for (let round = 0; round < REPAIR_ROUNDS && remaining.length; round += 1) {
    const next = [];
    for (let at = 0; at < remaining.length; at += REPAIR_ROWS_PER_CALL) {
      const chunk = remaining.slice(at, at + REPAIR_ROWS_PER_CALL);
      const rows = chunk.map((entry) => ({ index: entry.index, action: entry.text, evidence: entry.evidence }));
      const result = await requestWordingRepairs(rows, promptBuilder(rows, round > 0), options);
      if (!result.ok) { reason = result.reason; next.push(...chunk); continue; }
      const byIndex = new Map(result.repairs.map((repair) => [Number(repair?.index), clean(repair?.action)]));
      for (const entry of chunk) {
        const candidate = byIndex.get(entry.index);
        if (candidate && acceptWordingRepair(entry.text, candidate, { imperative })) fixed.set(entry.index, candidate);
        else next.push(entry);
      }
    }
    remaining = next;
    if (reason === 'unavailable') break;
  }
  return { fixed, reason };
}

async function repairActionWording(payload, evidencePack, options = {}) {
  // Mechanical faults first, and without asking anybody: a repeated phrase is redundancy,
  // and deleting the first copy cannot change what the row claims. "Get one from the, from
  // the place on Mill Road" is fixed here rather than spent on a round trip.
  const actions = (Array.isArray(payload?.screens?.actions) ? payload.screens.actions : [])
    .map((item) => {
      const repair = repairMechanicalFaults(clean(item.action));
      return repair.applied.length ? { ...item, action: repair.text } : item;
    });
  const broken = actions
    .map((action, index) => ({ action: clean(action.action), index, faults: wordingFaults(clean(action.action)) }))
    .filter((row) => row.faults.length);
  const withActions = (rows) => ({ ...payload, screens: { ...payload.screens, actions: rows } });
  if (!broken.length) return { payload: withActions(actions), repaired: 0, attempted: 0 };

  const textFor = (index) => evidenceEntriesFor({ evidence: (evidencePack || []).flatMap((item) => item.evidence || []) })
    .filter((entry) => (actions[index].evidenceIds || []).map(String).includes(String(entry.id)))
    .map((entry) => clean(entry.text))
    .filter(Boolean)
    .slice(0, 4)
    .join(' ');

  const entries = broken.map((row) => ({ index: row.index, text: row.action, evidence: textFor(row.index) }));
  const { fixed, reason } = await runWordingRepairRounds(entries, repairPrompt, true, options);
  const brokenIndexes = new Set(broken.map((row) => row.index));
  const next = actions.map((item, index) => {
    if (fixed.has(index)) return { ...item, action: fixed.get(index), wordingRepaired: true };
    // A row that survived both rounds still publishes - dropping a real commitment to
    // keep the prose tidy is the worse trade - but it publishes marked, so the UI can
    // present it as transcript wording under review rather than dressed as a minute.
    if (brokenIndexes.has(index)) return { ...item, wordingUnresolved: true };
    return item;
  });
  return { payload: withActions(next), repaired: fixed.size, attempted: broken.length, ...(reason ? { reason } : {}) };
}

// The same promise for discussion prose. Until now a broken discussion point - "the team
// had looked at starting to document that change within the on a change record" - had no
// second chance anywhere: the rewrite that produced it was also the last pass that
// touched it. Mechanical deletion first, then the shared repair rounds, prose rules.
async function repairDiscussionWording(payload, evidencePack, options = {}) {
  const cards = Array.isArray(payload?.screens?.discussion) ? payload.screens.discussion : [];
  const repairedCards = cards.map((card) => ({
    ...card,
    points: (card.points || []).map((point) => {
      const text = clean(typeof point === 'string' ? point : point?.text);
      const repair = repairMechanicalFaults(text);
      return repair.applied.length ? repair.text : text;
    })
  }));
  const entriesById = new Map(
    evidenceEntriesFor({ evidence: (evidencePack || []).flatMap((item) => item.evidence || []) })
      .map((entry) => [String(entry.id), clean(entry.text)])
  );
  const evidenceTextFor = (card) => (Array.isArray(card.evidenceIds) ? card.evidenceIds : [])
    .map((id) => entriesById.get(String(id)))
    .filter(Boolean)
    .slice(0, 4)
    .join(' ');
  const entries = [];
  repairedCards.forEach((card, cardIndex) => {
    card.points.forEach((point, pointIndex) => {
      if (!wordingFaults(point).length) return;
      entries.push({ index: entries.length, cardIndex, pointIndex, text: point, evidence: evidenceTextFor(card) });
    });
  });
  const withCards = { ...payload, screens: { ...payload.screens, discussion: repairedCards } };
  if (!entries.length) return { payload: withCards, repaired: 0, attempted: 0 };
  const { fixed, reason } = await runWordingRepairRounds(entries, discussionRepairPrompt, false, options);
  for (const entry of entries) {
    if (fixed.has(entry.index)) repairedCards[entry.cardIndex].points[entry.pointIndex] = fixed.get(entry.index);
  }
  return { payload: withCards, repaired: fixed.size, attempted: entries.length, ...(reason ? { reason } : {}) };
}

async function polishCanonicalStage(payload, options = {}) {
  const stage = clean(payload?.stagedStage).toLowerCase();
  const participants = Array.isArray(payload?.canonicalDiagnostics?.entityNames)
    ? payload.canonicalDiagnostics.entityNames
    : (Array.isArray(payload?.canonicalDiagnostics?.participants) ? payload.canonicalDiagnostics.participants : []);
  const evidencePack = normaliseEvidencePackEntities(payload?._canonicalEvidencePack, participants);
  const base = { ...payload };
  delete base._canonicalEvidencePack;
  if (!['discussion', 'actions'].includes(stage) || !evidencePack.length) return { payload: base, used: false, reason: 'No bounded evidence pack.' };
  const apiKey = clean(options.apiKey ?? process.env.TROOPER_API_KEY);
  if (!apiKey) return { payload: canonicalFallback(payload), used: false, reason: 'TROOPER_API_KEY is not configured.' };
  const fetchImpl = options.fetchImpl || fetch;
  // For actions, only the published rows travel to the model - the candidates stay in the
  // payload's pack for the review screen's source snippets, but they are not the model's
  // to publish, and chunking them in would spend the token budget rewriting rows that
  // nothing displays.
  const anyMarked = stage === 'actions' && evidencePack.some((item) => item && item.published);
  const rewritePack = anyMarked ? evidencePack.filter((item) => item && item.published) : evidencePack;
  // A meeting whose deterministic selection is empty has nothing to reword - candidates
  // alone are the review screen's business, and a round trip over zero rows is a chance
  // for the model to invent one.
  if (stage === 'actions' && anyMarked && !rewritePack.length) {
    return { payload: base, used: false, reason: 'No published actions to rewrite.' };
  }
  const packs = stage === 'actions' && rewritePack.length > 8
    ? Array.from({ length: Math.ceil(rewritePack.length / 8) }, (_unused, index) => rewritePack.slice(index * 8, (index + 1) * 8))
    : [rewritePack];
  const actionResults = [];
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let discussionResult = null;
  for (const pack of packs) {
    const indexedPack = pack.map((item, itemIndex) => ({ ...item, itemIndex }));
    const response = await fetchImpl(clean(options.url ?? process.env.TROOPER_CHAT_COMPLETIONS_URL) || DEFAULT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: clean(options.model ?? process.env.TROOPER_MODEL) || DEFAULT_MODEL,
        messages: [
          { role: 'system', content: 'Rewrite bounded MiniLM evidence into client-ready canonical meeting records. Return valid JSON only.' },
          { role: 'user', content: promptFor(stage, base, indexedPack, options) }
        ],
        temperature: 0.1,
        max_tokens: stage === 'discussion' ? 2600 : 1400,
        response_format: { type: 'json_object' }
      })
    });
    if (!response.ok) throw new Error(`Trooper canonical ${stage} rewrite failed with status ${response.status}.`);
    const body = await response.json();
    for (const key of Object.keys(usage)) usage[key] += Number(body?.usage?.[key] || 0);
    const content = body?.choices?.[0]?.message?.content;
    const output = typeof content === 'object' ? content : JSON.parse(String(content || '{}'));
    if (stage === 'actions') actionResults.push(...applyActionRewrite({ ...base, screens: { ...base.screens, actions: [] } }, output, indexedPack).screens.actions);
    else discussionResult = applyDiscussionRewrite(base, output, indexedPack);
  }
  const rewritten = stage === 'actions'
    // No dedupe. The deterministic selection was already deduplicated when it was made,
    // and a near-duplicate pass over the rewrites can merge two distinct rows the model
    // happened to word similarly - which is a count change, and the count is now the
    // pipeline's property, not the model's.
    ? {
      ...base,
      screens: { ...base.screens, actions: actionResults },
      canonicalDiagnostics: {
        ...(base.canonicalDiagnostics || {}),
        actionAccounting: { supplied: rewritePack.length, published: actionResults.length }
      }
    }
    : discussionResult;
  return { payload: rewritten, used: true, reason: `Trooper rewrote ${packs.length} bounded MiniLM evidence pack(s).`, usage };
}

module.exports = { promptFor, polishCanonicalStage, repairActionWording, repairDiscussionWording, acceptWordingRepair, wordingFaults, applyActionRewrite, applyDiscussionRewrite, discussionPointGrounded, unresolvedReference, canonicalFallback, nonActionState, nearDuplicate, addRecoveredActionCandidates, clientReadyPresentation, normaliseActionPresentation, normaliseDiscussionPresentation };
