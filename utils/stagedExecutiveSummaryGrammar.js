'use strict';

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
  if (ratio < 0.6 || ratio > 1.3) return { ok: false, reason: 'length_changed' };
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
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), Number(options.timeoutMs || 20000)) : null;
  try {
    const response = await fetchImpl(options.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: controller?.signal,
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
              'Copy-edit the executive summary below.',
              'Fix grammar, punctuation, duplicated words, malformed transcript joins, false starts and conversational filler.',
              'Preserve every factual claim, name, acronym, number, date, commitment, uncertainty and degree of emphasis.',
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
      : { text: original, used: false, reason: validation.reason, overlap: validation.overlap, timingMs: Date.now() - startedAt };
  } catch (error) {
    return { text: original, used: false, reason: 'request_failed', timingMs: Date.now() - startedAt };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

module.exports = { polishExecutiveSummaryGrammar, validateGrammarRevision, overlapScore };
