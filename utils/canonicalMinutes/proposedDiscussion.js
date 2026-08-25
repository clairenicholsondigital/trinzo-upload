'use strict';

// Discussion by proposal, restraint by validation - the actions architecture applied to
// discussion points.
//
// The deterministic discussion path selects representative sentences from MiniLM topic
// clusters, and a narrated story fragments: Andrew's alarm demonstration ("I've got these
// three alarms now... low priority... medium... high... those are all working") landed in
// FIVE separate micro-clusters, so the card built from "the sound cluster" surfaced the
// screen-share mechanics sentence ("I'm gonna try and include sound") while the actual
// demonstration scattered. No wording pass can fix choosing the wrong sentence.
//
// A model reading the whole transcript keeps the story together. Every veto stays
// deterministic, exactly as for actions:
//  - each proposed point must QUOTE a turn that resolves to THIS transcript, or it is
//    refused - never rewritten to fit;
//  - a point that duplicates something already on the screen is dropped;
//  - a point whose wording fails the detectors is dropped - a proposal is extra coverage,
//    and extra coverage that needs repairing is not worth carrying.

const { clean } = require('./evidence');
const { quoteSupport, bestQuoteSupport, QUOTE_GROUNDING } = require('./proposedActions');
const { minutesEnglishFaults } = require('../minutesEnglish');

const DEFAULT_URL = 'https://eu.router.trooper.ai/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4o-mini';

function promptFor(transcript) {
  return [
    '[CMD: task=discussion_proposal; format=json]',
    'Read this meeting transcript and record what was actually discussed, demonstrated or established - the content a careful minute-taker would keep.',
    '',
    'For each point give:',
    '  topic - a short heading naming the workstream this belongs to (two to five words, a subject, not a sentence).',
    '  point - one complete sentence of third-person minutes prose. Record outcomes, not process:',
    '          "Andrew demonstrated the three alarm priorities and confirmed all were working",',
    '          never "Andrew is going to try and include sound" - screen sharing, audio checks and',
    '          meeting mechanics are not minutes content.',
    '  quote - a VERBATIM span copied from the transcript that shows this point. Copy exactly; do not paraphrase.',
    '',
    'Cover the whole meeting. Prefer specific detail (quantities, standards, names of documents) over summary.',
    'Invent nothing. Every point must be supported by its quote.',
    'Return JSON only as {"points":[{"topic":"...","point":"...","quote":"..."}]}.',
    '',
    'TRANSCRIPT:',
    transcript
  ].join('\n');
}

async function requestDiscussionProposals(transcript, options = {}) {
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
          { role: 'system', content: 'You extract discussion minutes from meeting transcripts. Return valid JSON only.' },
          { role: 'user', content: promptFor(transcript) }
        ],
        temperature: 0.1,
        max_tokens: 2600,
        response_format: { type: 'json_object' }
      })
    });
    if (!response.ok) return { ok: false, reason: `http_${response.status}` };
    const body = await response.json();
    const content = body?.choices?.[0]?.message?.content;
    const output = typeof content === 'object' ? content : JSON.parse(String(content || '{}'));
    return { ok: true, points: Array.isArray(output?.points) ? output.points : [] };
  } catch (error) {
    return { ok: false, reason: error?.message || 'request_failed' };
  }
}

const contentTokens = (value) => new Set(String(value || '').toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || []);

function overlapRatio(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

// The referee. Returns { grounded, refused } with per-point reasons, so the caller can
// report what was declined instead of discarding it silently.
function groundDiscussionProposals(points, evidence, existingPoints = []) {
  const events = (evidence?.events || []).filter((event) => clean(event.text));
  const existing = (existingPoints || []).map((point) => contentTokens(point));
  const grounded = [];
  const refused = [];
  const kept = [];
  for (const item of Array.isArray(points) ? points : []) {
    const point = clean(item?.point);
    const topic = clean(item?.topic);
    const quote = clean(item?.quote);
    if (!point || !quote) { refused.push({ ...item, reason: 'missing_point_or_quote' }); continue; }
    if (minutesEnglishFaults(point).length) { refused.push({ ...item, reason: 'wording_fault' }); continue; }
    const best = bestQuoteSupport(quote, evidence);
    if (best.score < QUOTE_GROUNDING) {
      refused.push({ ...item, reason: 'quote_not_found_in_transcript', bestScore: Number(best.score.toFixed(2)) });
      continue;
    }
    const tokens = contentTokens(point);
    if (existing.some((other) => overlapRatio(tokens, other) >= 0.6)
      || kept.some((other) => overlapRatio(tokens, other) >= 0.6)) {
      refused.push({ ...item, reason: 'duplicate' });
      continue;
    }
    kept.push(tokens);
    grounded.push({ topic: topic || 'Discussion', point, evidenceIds: best.evidenceIds, proposalGrounding: Number(best.score.toFixed(2)) });
  }
  return { grounded, refused };
}

async function proposeDiscussionPoints(transcript, evidence, existingPoints, options = {}) {
  const result = await requestDiscussionProposals(transcript, options);
  if (!result.ok) return { grounded: [], refused: [], reason: result.reason };
  const { grounded, refused } = groundDiscussionProposals(result.points, evidence, existingPoints);
  return { grounded, refused, reason: '' };
}

module.exports = { proposeDiscussionPoints, groundDiscussionProposals, promptFor };
