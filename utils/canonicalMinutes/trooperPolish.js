'use strict';

const fetch = require('node-fetch');
const { clean } = require('./evidence');
const { deadlineFrom } = require('./stages');
const { finaliseDiscussionPointForMinutes, normaliseFinalStagedActionCandidate } = require('../stagedEditorial');

const DEFAULT_URL = 'https://eu.router.trooper.ai/v1/chat/completions';
const DEFAULT_MODEL = 'eu_liv_000099';

function unresolvedReference(value) {
  const text = clean(value);
  return /\b(?:flick|send|share|bring|discuss|review|do|handle|sort|progress|go through)\s+(?:it|that|this)\b/i.test(text)
    || /\b(?:take|have)\s+a\s+look\s+at\s+(?:it|that|this|us|them)\b/i.test(text)
    || /\b(document|report|plan|file)\s+\1\b/i.test(text)
    || /\b(?:discuss|review|progress|handle)\s+(?:the\s+)?(?:matter|topic|issue)\b/i.test(text)
    || /\b(?:the|this)\s+(?:matter|topic|issue)\b/i.test(text)
    || /\b(?:flick|send|share|bring|review|forward|escalate)\s+(?:the\s+)?(?:document|file|item|matter|topic|issue)(?:\s+(?:over|to)\b|[.!?]*$)/i.test(text)
    || /\b(?:send|share|review|follow up (?:with\s+\w+\s+)?regarding|get\s+\w+\s+to\s+review)\s+(?:the\s+)?(?:relevant|required|appropriate|applicable)?\s*(?:document|file|item|matter|topic|issue)(?:\s|[.!?]*$)/i.test(text)
    || /\b(?:overview|summary|details?)\s+of\s+(?:the\s+)?(?:products?|documents?|items?|things?)\b/i.test(text)
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
  return clean(value).replace(
    /^(?:(?:the\s+)?(?:speaker|attendee|participant)|[A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+){0,3})\s+(?:said|explained|reported|stated)\s+(?:that\s+)?/iu,
    ''
  );
}

function clientReadyPresentation(payload) {
  const stage = clean(payload?.stagedStage).toLowerCase();
  const base = { ...payload, screens: { ...(payload?.screens || {}) } };
  const retainedForReview = [];
  if (stage === 'discussion' && Array.isArray(base.screens.discussion)) {
    base.screens.discussion = base.screens.discussion.map((card) => ({
      ...card,
      points: (card.points || []).map((point) => {
        const presented = normaliseDiscussionPresentation(point);
        const polished = finaliseDiscussionPointForMinutes(presented, card.topic);
        if (polished) return polished;
        retainedForReview.push({ section: card.topic || 'Discussion', text: clean(point) });
        return clean(point);
      }).filter(Boolean)
    })).filter((card) => card.points.length);
  }
  if (stage === 'actions' && Array.isArray(base.screens.actions)) {
    base.screens.actions = base.screens.actions.map((item) => {
      const presented = normaliseActionPresentation(item.action);
      const polished = normaliseFinalStagedActionCandidate({ ...item, action: presented });
      if (polished) return { ...item, ...polished };
      retainedForReview.push({ section: 'Actions', text: clean(item.action) });
      return item;
    });
  }
  const existingFlags = Array.isArray(base.validationFlags) ? base.validationFlags : [];
  const polishFlag = retainedForReview.length ? {
    type: 'wording_needs_review', severity: 'warning', blocking: false,
    message: `Evidence was retained for ${retainedForReview.length} item${retainedForReview.length === 1 ? '' : 's'}, but the wording could not be safely polished automatically. Review the highlighted stage before approval.`
  } : {
    type: 'language_polished', severity: 'info', blocking: false,
    message: 'Evidence-backed draft: client-ready language checks completed without changing the underlying facts, owners or deadlines.'
  };
  return { ...base, validationFlags: [...existingFlags, polishFlag], editorialStatus: retainedForReview.length ? 'wording_needs_review' : 'language_polished' };
}

function canonicalFallback(payload) {
  const base = { ...payload, screens: { ...(payload?.screens || {}) } };
  delete base._canonicalEvidencePack;
  if (Array.isArray(base.screens.actions)) {
    const recovered = (payload?._canonicalEvidencePack || [])
      .filter((item) => item.selectionMode === 'evidence_bound_candidate')
      .map((item) => ({ owner: item.owner || 'Not stated', action: item.action, deadline: item.deadline || 'Not stated', evidenceIds: (item.evidence || []).map((evidence) => evidence.id).filter(Boolean) }));
    base.screens.actions = dedupeActions([...base.screens.actions, ...recovered]
      .filter((item) => !unresolvedReference(item.action) && !nonActionState(item.action)));
  }
  return base;
}

function addRecoveredActionCandidates(payload, recovered = []) {
  if (clean(payload?.stagedStage).toLowerCase() !== 'actions') return payload;
  const pack = Array.isArray(payload._canonicalEvidencePack) ? [...payload._canonicalEvidencePack] : [];
  const signatures = new Set(pack.map((item) => `${clean(item.owner).toLowerCase()}|${clean(item.action).toLowerCase()}`));
  for (const item of Array.isArray(recovered) ? recovered : []) {
    const action = clean(item?.action);
    if (!action || nonActionState(action)) continue;
    let owner = clean(item?.owner) || 'Not stated';
    if (!/^(?:Not stated|All|[A-Z][\p{L}'’.-]+(?:[ ,/-]+[A-Z][\p{L}'’.-]+)+)$/u.test(owner)) owner = 'Not stated';
    const signature = `${owner.toLowerCase()}|${action.toLowerCase()}`;
    if (signatures.has(signature)) continue;
    const id = `recovered_${pack.length + 1}`;
    pack.push({
      itemIndex: pack.length,
      topic: '', owner, action,
      deadline: clean(item.deadline) || 'Not stated',
      selectionMode: 'evidence_bound_candidate',
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
    'Review every supplied MiniLM action candidate. Return each candidate that is a real minute-worthy commitment or active outstanding deliverable; omit completed work, passive status with no remaining work, availability, hypotheticals, suggestions without assignment, and conversational noise.',
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
  const existing = clean(source.owner) || 'Not stated';
  if (proposed.toLowerCase() === existing.toLowerCase()) return true;
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
      && /\b(?:I|we)\s*(?:['’]ll|will|shall|can|need to|must|have to|am going to)\b/i.test(text);
    const namedAssignment = proposedOwners.some((owner) => {
      const firstName = owner.split(/\s+/)[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?:^|[.!?;]\\s+)${firstName},\\s*(?:can|could|will|would)\\s+you\\b|\\b${firstName}\\s+to\\s+[a-z]|\\b(?:assigned to|owner is|action for)\\s+${firstName}\\b`, 'i').test(text);
    });
    return speakerCommitment || namedAssignment;
  });
}

function deadlineSupported(candidate, source) {
  const proposed = clean(candidate.deadline);
  const existing = clean(source.deadline) || 'Not stated';
  if (proposed.toLowerCase() === existing.toLowerCase()) return true;
  if (existing !== 'Not stated' || !proposed || proposed === 'Not stated') return false;
  return citedEntries(candidate, source).some((entry) => deadlineFrom(entry.text).toLowerCase() === proposed.toLowerCase());
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
    const source = {
      owner: pack.owner || 'Not stated',
      action: pack.action,
      deadline: pack.deadline || 'Not stated',
      evidenceIds: (pack.evidence || []).map((item) => item.id).filter(Boolean)
    };
    const proposed = (byIndex.get(index) || []).slice(0, 3).flatMap((candidate) => {
      if (!validReferences(candidate, pack)) return [];
      if (!prospectiveEvidence(candidate, pack)) return [];
      const action = clean(candidate.action);
      if (!action || unresolvedReference(action) || nonActionState(action) || action.split(/\s+/).length < 4) return [];
      const owner = ownerSupported(candidate, pack) ? (clean(candidate.owner) || source.owner) : source.owner;
      const deadline = deadlineSupported(candidate, pack) ? (clean(candidate.deadline) || source.deadline) : source.deadline;
      return [{ ...source, owner, action, deadline, evidenceIds: candidate.evidenceIds }];
    });
    // Evidence-bound candidates have already passed deterministic local-window,
    // actionability and final-output checks. The language model may improve
    // them, but silence is not a rejection decision and must not erase them.
    if (!proposed.length && pack.selectionMode === 'evidence_bound_candidate') return [source];
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
      points.push(point);
    }
    if (!candidate || !pack || clean(candidate.topic) !== clean(source.topic) || !validReferences(candidate, pack) || !points.length) return source;
    return { ...source, points, evidenceIds: candidate.evidenceIds };
  });
  return { ...payload, screens: { ...payload.screens, discussion } };
}

async function polishCanonicalStage(payload, options = {}) {
  const stage = clean(payload?.stagedStage).toLowerCase();
  const evidencePack = Array.isArray(payload?._canonicalEvidencePack) ? payload._canonicalEvidencePack : [];
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

module.exports = { promptFor, polishCanonicalStage, applyActionRewrite, applyDiscussionRewrite, unresolvedReference, canonicalFallback, nonActionState, nearDuplicate, addRecoveredActionCandidates, clientReadyPresentation, normaliseActionPresentation, normaliseDiscussionPresentation };
