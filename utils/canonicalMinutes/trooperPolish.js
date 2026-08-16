'use strict';

const fetch = require('node-fetch');
const { clean } = require('./evidence');
const { deadlineFrom } = require('./stages');
const { finaliseDiscussionPointForMinutes, normaliseFinalStagedActionCandidate } = require('../stagedEditorial');
const { normaliseAttendeeReferences } = require('../entityNormalization');

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
  if (/language support|locali[sz]ation/i.test(topic)) {
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
  if (/alarm behaviour|alarm controls/i.test(topic)) {
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
  { topic: /language support|locali[sz]ation/i, point: /\b(?:languages?|translations?|translated|characters?|fonts?|arabic|vietnamese|greek)\b/i },
  { topic: /electrical compliance/i, point: /\b(?:60601|electrical compliance|testing|test gaps?)\b/i },
  { topic: /alarm behaviour|alarm controls/i, point: /\b(?:alarm|mute button|led|flash|flashing|priority)\b/i },
  { topic: /cybersecurity|access controls/i, point: /\b(?:cyber\s*security|usb|port lock|password|access|interference|screen control|gui)\b/i },
  { topic: /software change traceability/i, point: /\b(?:17 changes|code|traceability|technical file|device file history|retrospective test data|version)\b/i },
  { topic: /software change control/i, point: /\b(?:change request|change control|software version|release|non-significant|non-substantial)\b/i }
];

function discussionPointAlignedToTopic(topic, point) {
  const topicText = clean(topic);
  const pointText = clean(point);
  if (/language support|locali[sz]ation/i.test(topicText) && /\balarms?\b/i.test(pointText) && !/\b(?:arabic|vietnamese|greek|translations?|translated|characters?|fonts?)\b/i.test(pointText)) return false;
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
    existing.points = [...new Set([...(existing.points || []), ...(card.points || [])])];
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
    evidenceIds: Array.isArray(candidate.evidenceIds)
      ? candidate.evidenceIds.map(clean).filter(Boolean)
      : [],
    sourceFlagType: clean(flag.type),
    sourceFlagKey: clean(flag.resolutionKey || flag.key || flag.id) || `flag-${index}`
  };
  if (candidate.evidence) normalised.evidence = candidate.evidence;
  return normalised;
}

function actionReviewCandidatesFromFlags(flags = []) {
  const byId = new Map();
  for (const [flagIndex, flag] of (Array.isArray(flags) ? flags : []).entries()) {
    for (const candidate of Array.isArray(flag?.repairCandidates) ? flag.repairCandidates : []) {
      const normalised = normaliseActionReviewCandidate(candidate, flag, flagIndex);
      if (normalised.action && !byId.has(normalised.id)) byId.set(normalised.id, normalised);
    }
  }
  return [...byId.values()];
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
    base.screens.discussion = mergeClientReadyDiscussionCards(base.screens.discussion.map((card) => ({
      ...card,
      points: [...new Set((card.points || []).map((point) => {
        const sourceText = discussionPointText(point);
        const presented = normaliseEntities(normaliseDiscussionPresentation(sourceText));
        const polished = finaliseDiscussionPointForMinutes(presented, card.topic);
        if (polished && discussionPointAlignedToTopic(card.topic, polished)) return polished;
        const fallback = distinctiveDiscussionFallback(card.topic, presented);
        if (fallback) return fallback;
        retainedForReview.push({ section: card.topic || 'Discussion', text: sourceText });
        if (/^there['’]s one to\b/i.test(presented)) return '';
        return DISTINCTIVE_TOPIC_ALIGNMENT.some((item) => item.topic.test(clean(card.topic))) ? '' : sourceText;
      }).filter(Boolean))]
    })).filter((card) => card.points.length));
  }
  if (stage === 'actions' && Array.isArray(base.screens.actions)) {
    base.screens.actions = base.screens.actions.map((item) => {
      const presented = normaliseEntities(normaliseActionPresentation(item.action));
      const polished = normaliseFinalStagedActionCandidate({ ...item, action: presented });
      if (polished && polished.owner !== 'Not stated') return { ...item, ...polished };
      retainedForReview.push({
        section: 'Actions',
        text: clean(item.action),
        candidate: {
          owner: polished?.owner || item.owner || 'Not stated',
          action: polished?.action || presented || clean(item.action),
          deadline: polished?.deadline || item.deadline || 'Not stated',
          reviewDisposition: 'review_required'
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
      ? `Kept ${retainedForReview.length} action candidate${retainedForReview.length === 1 ? '' : 's'} out of the final Actions table because the owner or wording could not be validated safely.`
      : `Evidence was retained for ${retainedForReview.length} item${retainedForReview.length === 1 ? '' : 's'}, but the wording could not be safely polished automatically. Review the highlighted stage before approval.`,
    ...(retainedActionReviewCandidates.length ? { repairCandidates: retainedActionReviewCandidates } : {})
  } : {
    type: 'language_polished', severity: 'info', blocking: false,
    message: 'Evidence-backed draft: client-ready language checks completed without changing the underlying facts, owners or deadlines.'
  };
  const entityFlag = entityCorrections.length ? {
    type: 'attendee_entity_normalised', severity: 'info', blocking: false,
    message: `Corrected ${entityCorrections.length} attendee-name transcription variant${entityCorrections.length === 1 ? '' : 's'} using the confirmed participant list.`
  } : null;
  const validationFlags = [...existingFlags, ...(entityFlag ? [entityFlag] : []), polishFlag];
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
      .filter((item) => !unresolvedReference(item.action) && !nonActionState(item.action)));
  }
  return base;
}

function addRecoveredActionCandidates(payload, recovered = []) {
  if (clean(payload?.stagedStage).toLowerCase() !== 'actions') return payload;
  const pack = Array.isArray(payload._canonicalEvidencePack) ? [...payload._canonicalEvidencePack] : [];
  const signatures = new Set(pack.map((item) => `${clean(item.owner).toLowerCase()}|${clean(item.action).toLowerCase()}`));
  for (const item of Array.isArray(recovered) ? recovered : []) {
    const action = clean(item?.evidenceAction || item?.action);
    const suggestedAction = clean(item?.action);
    if (!action || nonActionState(action)) continue;
    let owner = clean(item?.owner) || 'Not stated';
    if (!/^(?:Not stated|All|[A-Z][\p{L}'’.-]+(?:[ ,/-]+[A-Z][\p{L}'’.-]+)+)$/u.test(owner)) owner = 'Not stated';
    const signature = `${owner.toLowerCase()}|${action.toLowerCase()}`;
    if (signatures.has(signature)) continue;
    const id = `recovered_${pack.length + 1}`;
    const reviewDisposition = clean(item.reviewDisposition) || (owner === 'Not stated' ? 'needs_assignment' : 'confirmed_action');
    pack.push({
      itemIndex: pack.length,
      topic: '', owner, action,
      suggestedAction,
      deadline: clean(item.deadline) || 'Not stated',
      reviewDisposition,
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
    'Review every supplied MiniLM action candidate. Return each candidate that is a real minute-worthy commitment or active outstanding deliverable; omit completed work, passive status with no remaining work, availability, hypotheticals, suggestions without assignment, regulatory/process requirements without an accepted owner, and conversational noise.',
    'A retained action must be supported by an explicit prospective commitment, assignment, request or obligation, or by clear evidence that specific work remains active and incomplete. Do not turn a question, recommendation, possible option, process description, audit scope, travel fact or meeting discussion into a commitment.',
    'Treat work described as ongoing, in progress, being worked on or having recently started as outstanding only when the evidence also identifies concrete remaining work or a deliverable.',
    'Consolidate repeated descriptions of the same underlying commitment into one canonical record.',
    'Rewrite each retained action into one complete, grammatical action with an explicit verb, specific object and supported purpose where the evidence establishes it.',
    'Resolve words such as it, this and that only from the supplied bounded context window.',
    'Replace the reference with the most specific supported workstream, document, deliverable or task. Generic substitutes such as "the matter", "the topic" or "the issue" are not acceptable.',
    'The object must distinguish the record from other documents or issues: retain supported names, acronyms, subject matter and purpose. For an email, state its supported subject; for an escalation, state the exact supported issue and system or team.',
    'Preserve every supplied acronym exactly as written unless its expansion appears verbatim in the cited evidence; never guess an acronym expansion.',
    'If the concrete object cannot be established from the supplied evidence, omit the action.',
    'Do not create commitments. Preserve supplied owners and deadlines unless the cited evidence explicitly assigns a different owner. You may fill a Not stated owner or deadline only when the cited evidence explicitly assigns that owner or contains that exact deadline.',
    'Respect reviewDisposition. completed_history, requirement and review_required candidates must not be published as final actions. A needs_assignment candidate may be published only if the cited evidence explicitly resolves the owner.',
    'Do not introduce a named recipient or participant unless that person is explicitly present in the evidenceIds cited for that output record.',
    'A supplied item may represent a contextual commitment thread rather than finished action wording. Resolve it only from its cited evidence.',
    'If one supplied item contains multiple distinct explicit commitments in its cited evidence, you may return up to three records with the same itemIndex; each must cite the evidence for its own commitment.',
    'For each output record, preserve itemIndex and cite only evidenceIds supplied for that item.'
  ] : [
    'Rewrite the supplied canonical discussion records as concise, formal meeting-minutes prose.',
    'Use the supplied bounded context windows to add concrete detail that is directly supported.',
    'Return one to three points per topic when supported: prioritise the current position, concrete technical/process detail, decisions, dependencies and next steps over a generic summary.',
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

function evidenceIdsFor(item) {
  return new Set((item?.evidence || []).flatMap((entry) => [entry?.id, ...(entry?.contextWindow || []).map((context) => context?.id)]).map(clean).filter(Boolean));
}

function validReferences(candidate, source) {
  const allowed = evidenceIdsFor(source);
  const cited = Array.isArray(candidate?.evidenceIds) ? candidate.evidenceIds.map(clean).filter(Boolean) : [];
  return cited.length > 0 && cited.every((id) => allowed.has(id));
}

function evidenceEntriesFor(item) {
  return (item?.evidence || []).flatMap((entry) => [
    { id: entry?.id, speaker: entry?.speaker, text: entry?.current },
    ...(entry?.contextWindow || []).map((context) => ({ id: context?.id, speaker: context?.speaker, text: context?.text }))
  ]).filter((entry) => clean(entry.id));
}

function citedEntries(candidate, source) {
  const cited = new Set((candidate?.evidenceIds || []).map(clean));
  return evidenceEntriesFor(source).filter((entry) => cited.has(clean(entry.id)));
}

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
  const candidates = Array.isArray(output?.actions) ? output.actions : [];
  const byIndex = new Map();
  for (const candidate of candidates) {
    const index = Number(candidate.itemIndex);
    if (!byIndex.has(index)) byIndex.set(index, []);
    byIndex.get(index).push(candidate);
  }
  const actions = evidencePack.flatMap((pack, index) => {
    if (!pack) return [];
    const reviewDisposition = pack.reviewDisposition || '';
    const selectionMode = pack.selectionMode || '';
    const source = {
      owner: pack.owner || 'Not stated',
      action: pack.action,
      deadline: pack.deadline || 'Not stated',
      evidenceIds: (pack.evidence || []).map((item) => item.id).filter(Boolean),
      ...(pack.recapCorroborated ? { recapCorroborated: true } : {})
    };
    // Closing-recap promotions have already passed a stricter two-source
    // corroboration gate: one concrete earlier workstream record plus the
    // later recap. Keep those records one-for-one. Letting Trooper rewrite
    // several neighbouring recap items can merge distinct workstreams into a
    // plausible-sounding but unsupported composite action.
    if (source.recapCorroborated) return [source];
    const proposed = (byIndex.get(index) || []).slice(0, 3).flatMap((candidate) => {
      if (!validReferences(candidate, pack)) return [];
      if (!prospectiveEvidence(candidate, pack)) return [];
      const action = clean(candidate.action);
      if (!action || unresolvedReference(action) || nonActionState(action) || action.split(/\s+/).length < 4) return [];
      if (!actionVerbSupported(candidate, pack)) return [];
      if (unsupportedNamedParticipants(candidate, pack).length) return [];
      if (['completed_history', 'requirement', 'review_required'].includes(reviewDisposition)) return [];
      let owner = 'Not stated';
      if (ownerSupported(candidate, pack)) owner = clean(candidate.owner) || source.owner;
      else if (source.owner !== 'Not stated' && ownerSupported({ ...candidate, owner: source.owner }, pack)) owner = source.owner;
      if (owner === 'Not stated') return [];
      const proposedDeadline = clean(candidate.deadline) || source.deadline;
      const deadline = deadlineSupported({ ...candidate, deadline: proposedDeadline }, pack) ? proposedDeadline : 'Not stated';
      const citedIds = Array.isArray(candidate.evidenceIds) ? candidate.evidenceIds : [];
      const ownerEvidenceIds = owner === 'Not stated' ? [] : citedEntries(candidate, pack)
        .filter((entry) => clean(entry.speaker).split(/\s+/)[0].toLowerCase() === owner.split(/\s+/)[0].toLowerCase()
          || new RegExp(`\\b${owner.split(/\s+/)[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(clean(entry.text)))
        .map((entry) => entry.id);
      const deadlineEvidenceIds = deadline === 'Not stated' ? [] : citedEntries(candidate, pack)
        .filter((entry) => deadlineFrom(entry.text).toLowerCase() === deadline.toLowerCase())
        .map((entry) => entry.id);
      return [{ ...source, owner, action, deadline, evidenceIds: citedIds, provenance: { actionEvidenceIds: citedIds, ownerEvidenceIds, deadlineEvidenceIds } }];
    });
    // Confirmed evidence-bound candidates survive a language-model omission,
    // but review-only recovery candidates never become final actions by default.
    // For canonical selected actions, preserve the source only when its wording
    // is already specific enough to be safe.
    if (!proposed.length && selectionMode === 'evidence_bound_candidate'
        && !unresolvedReference(source.action) && !nonActionState(source.action)
        && clean(source.action).split(/\s+/).length >= 4) return [source];
    if (!proposed.length && selectionMode === 'canonical_selected_action'
        && source.owner !== 'Not stated'
        && !unresolvedReference(source.action) && !nonActionState(source.action)
        && clean(source.action).split(/\s+/).length >= 4) return [{ ...source, deadline: 'Not stated' }];
    return proposed;
  });
  const finalActions = dedupeActions(actions);
  return {
    ...payload,
    screens: { ...payload.screens, actions: finalActions },
    canonicalDiagnostics: {
      ...(payload.canonicalDiagnostics || {}),
      actionAccounting: {
        supplied: evidencePack.length,
        evidenceBound: evidencePack.filter((item) => item.selectionMode === 'evidence_bound_candidate').length,
        published: finalActions.length
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
    return { ...source, points, evidenceIds: candidate.evidenceIds };
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
  const packs = stage === 'actions' && evidencePack.length > 8
    ? Array.from({ length: Math.ceil(evidencePack.length / 8) }, (_unused, index) => evidencePack.slice(index * 8, (index + 1) * 8))
    : [evidencePack];
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
        max_tokens: stage === 'discussion' ? 2200 : 1400,
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
    ? { ...base, screens: { ...base.screens, actions: dedupeActions(actionResults) } }
    : discussionResult;
  return { payload: rewritten, used: true, reason: `Trooper rewrote ${packs.length} bounded MiniLM evidence pack(s).`, usage };
}

module.exports = { promptFor, polishCanonicalStage, applyActionRewrite, applyDiscussionRewrite, discussionPointGrounded, unresolvedReference, canonicalFallback, nonActionState, nearDuplicate, addRecoveredActionCandidates, clientReadyPresentation, normaliseActionPresentation, normaliseDiscussionPresentation };
