'use strict';

const fetch = require('node-fetch');
const { clean } = require('./evidence');

const DEFAULT_URL = 'https://eu.router.trooper.ai/v1/chat/completions';
const DEFAULT_MODEL = 'eu_liv_000099';

function unresolvedReference(value) {
  const text = clean(value);
  return /\b(?:flick|send|share|bring|discuss|review|do|handle|sort|progress|go through)\s+(?:it|that|this)\b/i.test(text)
    || /\b(?:discuss|review|progress|handle)\s+(?:the\s+)?(?:matter|topic|issue)\b/i.test(text)
    || /\b(?:the|this)\s+(?:matter|topic|issue)\b/i.test(text)
    || /\b(?:flick|send|share|bring|review|forward|escalate)\s+(?:the\s+)?(?:document|file|item|matter|topic|issue)(?:\s+(?:over|to)\b|[.!?]*$)/i.test(text)
    || /\b(?:it|that|this)\s+(?:over|through|with)\b/i.test(text)
    || /\bkind of\b|\bsort of\b|\byeah\b|\byep\b|\bunspecified\b|\[[^\]]+\]/i.test(text);
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

function canonicalFallback(payload) {
  const base = { ...payload, screens: { ...(payload?.screens || {}) } };
  delete base._canonicalEvidencePack;
  if (Array.isArray(base.screens.actions)) {
    base.screens.actions = base.screens.actions.filter((item) => !unresolvedReference(item.action) && !nonActionState(item.action));
  }
  return base;
}

function promptFor(stage, payload, evidencePack) {
  const contract = stage === 'actions'
    ? {
      actions: [{ itemIndex: 0, owner: 'exact supplied owner', action: 'complete action with explicit verb and object', deadline: 'exact supplied deadline', evidenceIds: ['supplied evidence id'] }]
    }
    : {
      discussion: [{ itemIndex: 0, topic: 'exact supplied topic', points: ['formal, self-contained minutes point'], evidenceIds: ['supplied evidence id'] }]
    };
  const instructions = stage === 'actions' ? [
    'Rewrite each supplied canonical action into one complete, grammatical action with an explicit verb and object.',
    'Resolve words such as it, this and that only from the supplied bounded context window.',
    'Replace the reference with the most specific supported workstream, document, deliverable or task. Generic substitutes such as "the matter", "the topic" or "the issue" are not acceptable.',
    'The object must distinguish the record from other documents or issues: retain supported names, acronyms, subject matter and purpose. For an email, state its supported subject; for an escalation, state the exact supported issue and system or team.',
    'If the concrete object cannot be established from the supplied evidence, omit the action.',
    'Do not change the supplied owner or deadline and do not create commitments.',
    'If one supplied item contains two distinct explicit commitments in its cited evidence, you may return two records with the same itemIndex; each must cite the evidence for its own commitment.',
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
    JSON.stringify({ stagedStage: stage }, null, 2),
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

function applyActionRewrite(payload, output, evidencePack) {
  const sourceActions = payload.screens?.actions || [];
  const candidates = Array.isArray(output?.actions) ? output.actions : [];
  const byIndex = new Map();
  for (const candidate of candidates) {
    const index = Number(candidate.itemIndex);
    if (!byIndex.has(index)) byIndex.set(index, []);
    byIndex.get(index).push(candidate);
  }
  const actions = sourceActions.flatMap((source, index) => {
    const pack = evidencePack[index];
    if (!pack) return [];
    return (byIndex.get(index) || []).slice(0, 3).flatMap((candidate) => {
      if (!validReferences(candidate, pack)) return [];
      const action = clean(candidate.action);
      if (!action || unresolvedReference(action) || nonActionState(action) || action.split(/\s+/).length < 4) return [];
      if (clean(candidate.owner).toLowerCase() !== clean(source.owner).toLowerCase()) return [];
      if (clean(candidate.deadline).toLowerCase() !== clean(source.deadline).toLowerCase()) return [];
      return [{ ...source, action, evidenceIds: candidate.evidenceIds }];
    });
  });
  return { ...payload, screens: { ...payload.screens, actions } };
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
  const response = await fetchImpl(clean(options.url ?? process.env.TROOPER_CHAT_COMPLETIONS_URL) || DEFAULT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: clean(options.model ?? process.env.TROOPER_MODEL) || DEFAULT_MODEL,
      messages: [
        { role: 'system', content: 'Rewrite bounded MiniLM evidence into client-ready canonical meeting records. Return valid JSON only.' },
        { role: 'user', content: promptFor(stage, base, evidencePack) }
      ],
      temperature: 0.1,
      max_tokens: stage === 'discussion' ? 2200 : 1400,
      response_format: { type: 'json_object' }
    })
  });
  if (!response.ok) throw new Error(`Trooper canonical ${stage} rewrite failed with status ${response.status}.`);
  const body = await response.json();
  const content = body?.choices?.[0]?.message?.content;
  const output = typeof content === 'object' ? content : JSON.parse(String(content || '{}'));
  const rewritten = stage === 'actions' ? applyActionRewrite(base, output, evidencePack) : applyDiscussionRewrite(base, output, evidencePack);
  return { payload: rewritten, used: true, reason: 'Trooper rewrote bounded MiniLM evidence.', usage: body?.usage || null };
}

module.exports = { promptFor, polishCanonicalStage, applyActionRewrite, applyDiscussionRewrite, unresolvedReference, canonicalFallback, nonActionState, nearDuplicate };
