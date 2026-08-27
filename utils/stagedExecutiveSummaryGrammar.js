'use strict';

const { trooperFetch } = require('./trooperTransport');

const { minutesEnglishFaults, repairMechanicalFaults } = require('./minutesEnglish');

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function contentTokens(value) {
  return new Set((clean(value).toLowerCase().match(/[a-z][a-z0-9'’-]{3,}/g) || [])
    .filter((token) => !new Set(['that', 'this', 'with', 'from', 'were', 'have', 'been', 'their', 'there', 'which', 'would', 'could', 'should']).has(token)));
}

function protectedFacts(value) {
  return new Set([
    ...(clean(value).match(/\b\d+(?:[.,:]\d+)*(?:%|st|nd|rd|th)?\b/g) || []),
    ...(clean(value).match(/\b[A-Z][A-Z0-9&/-]{1,}\b/g) || []),
    ...(clean(value).match(/\b[A-Z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+)+\b/g) || [])
  ].map((item) => item.toLowerCase()));
}

function splitSentences(value) {
  return clean(value).split(/(?<=[.!?])\s+/).map(clean).filter(Boolean);
}

// The general form of what a stack of per-transcript literals used to do here.
//
// sanitiseSummarySentence was the poster child for the fix-shape this project has
// renounced: eight literal rewrites, each transcribed from one meeting - "were not too
// keen to send them to to share them with us", "Call they", "I had taken a snapshot of
// the label" - each dead the day its transcript left rotation, and each a promise that
// the next transcript would need its own. The general layers now carry the load: a
// mechanical stutter is repaired by the shared phrase-restart rule, and a sentence in the
// speaker's voice is DROPPED rather than patched, because the fallback's job is to serve
// only what already reads as minutes - rewriting speech is the polish's job, upstream,
// with citations. Dropping where the literals used to patch trades a rescued sentence for
// an honest absence, which is this pipeline's standing trade.
function transcriptShapedSummaryIssue(value) {
  const text = clean(value);
  if (!text) return 'empty_text';
  if (/(?:^|[.!?]\s+)(?:obviously|basically|you know)\b/i.test(text)) return 'conversational_filler';
  if (/\b(?:I|we|we'd|we'll|we've|we're|our|ours|my|mine|me|us|you|your|yours|you're|you are)\b/i.test(text)) return 'first_or_second_person';
  // The old rule here was six literal phrases from two transcripts. The general property
  // they shared is the restarted phrase - "to to", "send them to share them with us" - and
  // the shared detector tests for that property instead of for those strings.
  if (minutesEnglishFaults(text).some((fault) => fault.code === 'phrase_restart')) return 'malformed_transcript_join';
  // A fragment posing as a sentence: it opens with a preposition or subordinator and no
  // finite verb ever arrives. "For a site in the areas of quality system, quality culture
  // operating." was one of the six literals the old list named; this is the property all
  // six shared. A prepositional opener with a real clause behind it survives - "For the
  // avoidance of doubt, the tests must pass" carries its finite verb.
  if (/^(?:for|with|from|in|on|at|of|as|by|into|onto)\b/i.test(text)
    && !/\b(?:is|are|was|were|has|have|had|will|would|can|could|should|must|does|did|do|needs?|remains?|includes?|covers?|requires?)\b/i.test(text)) return 'sentence_fragment';
  if (/(?:^|[.!?]\s+)because\b/i.test(text)) return 'dependent_clause_start';
  return '';
}

function sanitiseSummarySentence(sentence) {
  let text = repairMechanicalFaults(clean(sentence)
    .replace(/^Because\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()).text;
  if (text && !/[.!?]$/.test(text)) text += '.';
  return text;
}

function fallbackMinutesReadySummary(value) {
  const sentences = splitSentences(value)
    .map(sanitiseSummarySentence)
    .filter(Boolean)
    .filter((sentence) => {
      if (sentence.split(/\s+/).length < 6) return false;
      return !transcriptShapedSummaryIssue(sentence);
    });
  const output = [];
  for (const sentence of sentences) {
    if (output.some((existing) => existing.toLowerCase() === sentence.toLowerCase())) continue;
    output.push(sentence);
    // Five, raised from four alongside the richer summary contract: a fallback that
    // truncates a five-sentence enriched summary to four silently undoes the enrichment.
    if (output.length >= 5) break;
  }
  return clean(output.join(' '));
}

function shouldUseTranscriptFallback(reason) {
  return [
    'conversational_filler',
    'first_or_second_person',
    'malformed_transcript_join',
    'dependent_clause_start',
    'meaning_changed'
  ].includes(clean(reason));
}

function overlapScore(original, revised) {
  const source = contentTokens(original);
  const target = contentTokens(revised);
  if (!source.size && !target.size) return 1;
  const intersection = [...source].filter((token) => target.has(token)).length;
  return intersection / Math.max(source.size, target.size, 1);
}

function validateGrammarRevision(original, revised) {
  const source = clean(original);
  const candidate = clean(revised);
  if (!source || !candidate) return { ok: false, reason: 'empty_text' };
  const ratio = candidate.length / source.length;
  if (ratio < 0.45 || ratio > 1.3) return { ok: false, reason: 'length_changed' };
  const transcriptIssue = transcriptShapedSummaryIssue(candidate);
  if (transcriptIssue) return { ok: false, reason: transcriptIssue };
  const sourceFacts = protectedFacts(source);
  const candidateFacts = protectedFacts(candidate);
  if ([...candidateFacts].some((fact) => !sourceFacts.has(fact))) return { ok: false, reason: 'new_protected_fact' };
  if ([...sourceFacts].some((fact) => !candidateFacts.has(fact))) return { ok: false, reason: 'protected_fact_removed' };
  const overlap = overlapScore(source, candidate);
  if (overlap < 0.62) return { ok: false, reason: 'meaning_changed', overlap };
  return { ok: true, reason: 'accepted', overlap };
}

async function polishExecutiveSummaryGrammar(text, options = {}) {
  const original = clean(text);
  if (!original) return { text: original, used: false, reason: 'empty_text' };
  const apiKey = clean(options.apiKey);
  const fetchImpl = options.fetchImpl || global.fetch;
  if (!apiKey || typeof fetchImpl !== 'function') return { text: original, used: false, reason: 'unavailable' };
  const startedAt = Date.now();
  try {
    const response = await trooperFetch(options.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        messages: [
          {
            role: 'system',
            content: 'You are a British English copy editor. Correct grammar and readability only. Never add, remove, infer, summarise or reinterpret facts.'
          },
          {
            role: 'user',
            content: [
              'Copy-edit the executive summary below immediately before it is shown to the reviewer.',
              'The result must read like formal client-ready meeting minutes, not copied transcript speech.',
              'Fix grammar, punctuation, duplicated words, malformed transcript joins, false starts and conversational filler.',
              'Convert first-person or second-person transcript wording into neutral third-person minutes prose where the meaning is explicit.',
              'Remove non-substantive filler such as "obviously" and repair dependent sentence starts such as "Because..." into standalone sentences.',
              'Preserve every factual claim, name, acronym, number, date, commitment, uncertainty and degree of emphasis.',
              'If a fragment is unclear or cannot be safely converted, omit that fragment rather than guessing.',
              'Do not add context from outside the supplied text. Do not turn uncertainty into certainty.',
              'Return JSON only as {"revisedText":"..."}.',
              '',
              '[EXECUTIVE_SUMMARY]', original, '[/EXECUTIVE_SUMMARY]'
            ].join('\n')
          }
        ],
        temperature: 0,
        max_tokens: Number(options.maxTokens || 700),
        response_format: { type: 'json_object' }
      })
    }, {
      fetchImpl,
      timeoutMs: Number(options.timeoutMs || 20000),
      minIntervalMs: options.sharedTransport ? options.minIntervalMs : 0,
      maxRetries: options.sharedTransport ? options.maxRetries : 0,
      baseDelayMs: options.baseDelayMs,
      jitterMs: options.jitterMs,
      waitImpl: options.waitImpl
    });
    const raw = await response.text();
    if (!response.ok) return { text: original, used: false, reason: `http_${response.status}`, timingMs: Date.now() - startedAt };
    const body = raw ? JSON.parse(raw) : {};
    const content = body?.choices?.[0]?.message?.content;
    const parsed = typeof content === 'object' && content ? content : JSON.parse(String(content || '{}'));
    const revised = clean(parsed.revisedText);
    const validation = validateGrammarRevision(original, revised);
    return validation.ok
      ? { text: revised, used: revised !== original, reason: validation.reason, overlap: validation.overlap, timingMs: Date.now() - startedAt }
      : (() => {
          const fallback = shouldUseTranscriptFallback(validation.reason) && (
              validation.reason !== 'meaning_changed' || transcriptShapedSummaryIssue(original)
            )
            ? fallbackMinutesReadySummary(revised || original)
            : '';
          return fallback
            ? { text: fallback, used: false, reason: `deterministic_${validation.reason}`, overlap: validation.overlap, timingMs: Date.now() - startedAt }
            : { text: original, used: false, reason: validation.reason, overlap: validation.overlap, timingMs: Date.now() - startedAt };
        })();
  } catch (error) {
    const fallback = fallbackMinutesReadySummary(original);
    return { text: fallback || original, used: false, reason: fallback ? 'deterministic_request_failed' : 'request_failed', timingMs: Date.now() - startedAt };
  }
}

module.exports = { polishExecutiveSummaryGrammar, validateGrammarRevision, overlapScore, transcriptShapedSummaryIssue, fallbackMinutesReadySummary, shouldUseTranscriptFallback };
