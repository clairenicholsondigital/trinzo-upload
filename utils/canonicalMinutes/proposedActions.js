'use strict';

// Discovery by proposal, restraint by validation.
//
// The action pipeline was built the other way round: a thirteen-pattern regex whitelist
// found the actions and the model was only allowed to reword them. Measured across the
// thirteen ground-truth fixtures, that whitelist reached 29 of 102 actions while one plain
// request to the model reached 39-40 - and four separate attempts to tune the selection
// gates recovered exactly zero between them. The model is the better finder.
//
// It is also the worse referee. On a residents' meeting that agreed nothing, the same
// plain request produced seven action rows - not invented, but the OPTIONS the meeting
// discussed and never agreed ("Consider painting visitor bays", "Ask the council if they
// would adopt the road"). The deterministic layer got that meeting right with zero.
//
// So this module lets the model propose and keeps every veto deterministic:
//   - each proposal must quote the turn that supports it, and the quote must resolve to a
//     real event in THIS transcript, or the row is dropped (never rewritten to fit);
//   - each proposal is filed as agreed / requirement / considered, so an option that was
//     never agreed stops being published as though somebody had committed to it.

const { clean } = require('./evidence');

const DEFAULT_URL = 'https://eu.router.trooper.ai/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4o-mini';

// How much of the quoted span has to be found in a single transcript turn before the
// proposal counts as grounded.
//
// Set from the measured gap rather than picked: a fabricated action ("we agreed to fly to
// the moon next Tuesday") scores 0.17 against the nearest real turn, while genuine
// proposals refused at 0.6 scored 0.46-0.59 - the model had quoted the turn accurately but
// trimmed or lightly smoothed it ("I'm gonna focus on TFO3 this week"). 0.45 sits in the
// empty band between the two, so real support still has to exist and invention still has
// nowhere to hide.
const QUOTE_GROUNDING = 0.45;

const DISPOSITIONS = new Set(['agreed', 'requirement', 'considered']);

function contentWords(value) {
  return (String(value || '').toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || []);
}

// Asymmetric on purpose: how much of the QUOTE the turn contains. A long turn that carries
// the whole quote is the support; a short turn sharing one word is not.
function quoteSupport(quote, turnText) {
  const want = contentWords(quote);
  if (!want.length) return 0;
  const have = new Set(contentWords(turnText));
  let shared = 0;
  for (const token of want) if (have.has(token)) shared += 1;
  return shared / want.length;
}

function promptFor(transcript, participants) {
  return [
    '[CMD: task=action_proposal; format=json]',
    'Read this meeting transcript and list everything the meeting produced that someone might act on.',
    '',
    'For each item give:',
    '  owner       - the person responsible, exactly as named in the transcript, or "Not stated".',
    '  action      - a short instruction, starting with the verb. Do NOT begin with the owner\'s name:',
    '                write "Share the risk analysis before she arrives", not "Stuart will share the risk analysis".',
    '  quote       - a VERBATIM span copied from the transcript that shows this item. Copy it exactly; do not paraphrase.',
    '  disposition - one of:',
    '      "agreed"      somebody committed to do this, or was asked and accepted.',
    '      "requirement" the work plainly has to happen, but nobody was named or accepted it.',
    '      "considered"  an option the meeting discussed and did NOT agree to do.',
    '',
    'Be strict about the difference between agreed and considered. A meeting that weighed several',
    'options and reached no decision has NO agreed items - file every option as "considered".',
    'Invent nothing. Every item must be supported by its quote.',
    participants.length ? `Participants: ${participants.join(', ')}.` : '',
    'Return JSON only as {"items":[{"owner":"...","action":"...","quote":"...","disposition":"..."}]}.',
    '',
    'TRANSCRIPT:',
    transcript
  ].filter(Boolean).join('\n');
}

async function requestItems(promptText, options = {}) {
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
          { role: 'system', content: 'You extract action items from meeting transcripts. Return valid JSON only.' },
          { role: 'user', content: promptText }
        ],
        temperature: 0.1,
        max_tokens: Number(options.maxTokens || 2400),
        response_format: { type: 'json_object' }
      })
    });
    if (!response.ok) return { ok: false, reason: `http_${response.status}` };
    const body = await response.json();
    const content = body?.choices?.[0]?.message?.content;
    const output = typeof content === 'object' ? content : JSON.parse(String(content || '{}'));
    return { ok: true, items: Array.isArray(output?.items) ? output.items : [] };
  } catch (error) {
    return { ok: false, reason: error?.message || 'request_failed' };
  }
}

// Where a quote's support lives. prepareEvidence splits turns into per-sentence events,
// and a verbatim quote legitimately spans several sentences of one turn - Andrew's alarm
// demonstration quote scored 0.41 against its best single sentence and was refused, while
// the whole turn contains it entirely. So support is measured against each event AND each
// whole turn; the threshold itself never moves.
function bestQuoteSupport(quote, evidence) {
  const events = (evidence?.events || []).filter((event) => clean(event.text));
  let best = { score: 0, evidenceIds: [] };
  for (const event of events) {
    const score = quoteSupport(quote, event.text);
    if (score > best.score) best = { score, evidenceIds: [event.id] };
  }
  const byTurn = new Map();
  for (const event of events) {
    const key = event.turnId ?? event.turnIndex;
    if (!byTurn.has(key)) byTurn.set(key, []);
    byTurn.get(key).push(event);
  }
  for (const turnEvents of byTurn.values()) {
    if (turnEvents.length < 2) continue;
    const score = quoteSupport(quote, turnEvents.map((event) => event.text).join(' '));
    if (score > best.score) best = { score, evidenceIds: turnEvents.slice(0, 6).map((event) => event.id) };
  }
  return best;
}

// The referee. A proposal survives only if its quote resolves to a turn in THIS transcript.
// Returns { grounded, ungrounded } so the caller can report what was refused rather than
// discarding it silently.
function groundProposals(items, evidence) {
  const events = (evidence?.events || []).filter((event) => clean(event.text));
  const grounded = [];
  const ungrounded = [];
  for (const item of Array.isArray(items) ? items : []) {
    const action = clean(item?.action);
    const quote = clean(item?.quote);
    const disposition = DISPOSITIONS.has(String(item?.disposition || '').toLowerCase())
      ? String(item.disposition).toLowerCase()
      : 'requirement';
    if (!action || !quote) { ungrounded.push({ ...item, reason: 'missing_action_or_quote' }); continue; }
    const best = bestQuoteSupport(quote, evidence);
    if (best.score < QUOTE_GROUNDING) {
      ungrounded.push({ ...item, reason: 'quote_not_found_in_transcript', bestScore: Number(best.score.toFixed(2)) });
      continue;
    }
    grounded.push({
      owner: clean(item?.owner) || 'Not stated',
      action,
      deadline: 'Not stated',
      disposition,
      evidenceIds: best.evidenceIds,
      quote,
      source: 'model_proposed',
      proposalGrounding: Number(best.score.toFixed(2))
    });
  }
  return { grounded, ungrounded };
}

// The owner has its own column, so repeating the name inside the action is redundancy the
// reviewer has to delete on every row: "Stuart Smith will share the risk analysis" under an
// owner cell already reading Stuart Smith. Stripped deterministically rather than trusted
// to the prompt, and only when the name being stripped is THIS row's owner - a different
// person named in the action is information, not repetition.
function stripOwnerPrefix(action, owner) {
  const text = clean(action);
  const name = clean(owner);
  if (!text || !name || /^not stated$/i.test(name)) return text;
  const parts = [name, name.split(/\s+/)[0]].filter(Boolean).map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  for (const part of parts) {
    const match = text.match(new RegExp(`^${part}\\s+(?:will|is to|should|to|needs to|has to)\\s+(.+)$`, 'i'));
    if (match) {
      const rest = clean(match[1]);
      if (rest.split(/\s+/).length >= 3) return rest.charAt(0).toUpperCase() + rest.slice(1);
    }
  }
  return text;
}

// An owner the transcript never mentions is a fabricated attribution even when the action
// itself is real, so it is downgraded rather than published as though somebody accepted it.
function resolveProposedOwner(owner, participants) {
  const name = clean(owner);
  if (!name || /^not stated$/i.test(name)) return 'Not stated';
  const known = (participants || []).map((item) => clean(item)).filter(Boolean);
  if (!known.length) return name;
  const lower = name.toLowerCase();
  const match = known.find((item) => item.toLowerCase() === lower)
    || known.find((item) => item.toLowerCase().split(/\s+/).includes(lower))
    || known.find((item) => lower.split(/\s+/).includes(item.toLowerCase().split(/\s+/)[0]));
  return match || 'Not stated';
}

// Shared tail of both proposal calls: ground, resolve owners, strip prefixes, bucket.
function refereeItems(items, evidence, participants) {
  const { grounded, ungrounded } = groundProposals(items, evidence);
  const owned = grounded.map((item) => {
    const owner = resolveProposedOwner(item.owner, participants);
    return { ...item, owner, action: stripOwnerPrefix(item.action, owner) };
  });
  return {
    agreed: owned.filter((item) => item.disposition === 'agreed'),
    requirements: owned.filter((item) => item.disposition === 'requirement'),
    considered: owned.filter((item) => item.disposition === 'considered'),
    ungrounded,
    reason: ''
  };
}

async function proposeActions(transcript, evidence, options = {}) {
  const participants = (evidence?.participants || []).map((item) => clean(item?.name || item)).filter(Boolean);
  const result = await requestItems(promptFor(transcript, participants), options);
  if (!result.ok) return { agreed: [], requirements: [], considered: [], ungrounded: [], reason: result.reason };
  return refereeItems(result.items, evidence, participants);
}

// The completeness sweep: a second reading aimed only at what the first pass missed.
//
// Measured need (2026-08-26, one-run loss attribution across the 13 ground-truth
// fixtures): of 53 expected actions the scorecard missed, 23 were never discovered by
// ANY source and 5 more were real commitments the corroboration filter dropped because
// the model's single reading happened not to mention them. One reading of a transcript
// is one sample; the misses cluster in long meetings where the first call's attention
// (and its 2400-token budget) ran out before the small commitments.
//
// The sweep shows the model what is already captured and asks ONLY for commitments not
// covered - so a row the corroboration filter removed is fair game again (it is no
// longer on the list), and everything that comes back faces the same referee: verbatim
// quote, grounding against this transcript's turns, owner resolution, disposition
// strictness. A meeting that agreed nothing gets no sweep at all (the caller skips it),
// and the prompt's own empty-permission keeps the model from inventing coverage.
function missedPromptFor(transcript, participants, alreadyCaptured) {
  const captured = (alreadyCaptured || []).map((item, index) => `  ${index + 1}. ${clean(item.owner) && !/^not stated$/i.test(clean(item.owner)) ? `${clean(item.owner)}: ` : ''}${clean(item.action)}`);
  return [
    '[CMD: task=action_completeness_sweep; format=json]',
    'Below is a meeting transcript and the list of action items already captured from it.',
    'List ONLY commitments or requirements in the transcript that are NOT covered by that list.',
    'An item is covered if the list already records the same work, even in different words -',
    'do not restate, reword or improve anything already on the list.',
    'If everything is covered, return {"items":[]}.',
    '',
    'For each missed item give:',
    '  owner       - the person responsible, exactly as named in the transcript, or "Not stated".',
    '  action      - a short instruction, starting with the verb. Do NOT begin with the owner\'s name.',
    '  quote       - a VERBATIM span copied from the transcript that shows this item. Copy it exactly; do not paraphrase.',
    '  disposition - "agreed" (somebody committed), "requirement" (must happen, nobody named),',
    '                or "considered" (discussed and NOT agreed).',
    '',
    'Be strict about the difference between agreed and considered. A meeting that weighed several',
    'options and reached no decision has NO agreed items - file every option as "considered".',
    'Invent nothing. Every item must be supported by its quote.',
    participants.length ? `Participants: ${participants.join(', ')}.` : '',
    'Return JSON only as {"items":[{"owner":"...","action":"...","quote":"...","disposition":"..."}]}.',
    '',
    'ALREADY CAPTURED:',
    captured.length ? captured.join('\n') : '  (nothing captured yet)',
    '',
    'TRANSCRIPT:',
    transcript
  ].filter(Boolean).join('\n');
}

async function proposeMissedActions(transcript, evidence, alreadyCaptured, options = {}) {
  const participants = (evidence?.participants || []).map((item) => clean(item?.name || item)).filter(Boolean);
  const result = await requestItems(missedPromptFor(transcript, participants, alreadyCaptured), { maxTokens: 1200, ...options });
  if (!result.ok) return { agreed: [], requirements: [], considered: [], ungrounded: [], reason: result.reason };
  return refereeItems(result.items, evidence, participants);
}

module.exports = { proposeActions, proposeMissedActions, groundProposals, quoteSupport, bestQuoteSupport, resolveProposedOwner, stripOwnerPrefix, promptFor, missedPromptFor, QUOTE_GROUNDING };
