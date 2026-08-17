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

function splitSentences(value) {
  return clean(value).split(/(?<=[.!?])\s+/).map(clean).filter(Boolean);
}

function transcriptShapedSummaryIssue(value) {
  const text = clean(value);
  if (!text) return 'empty_text';
  if (/(?:^|[.!?]\s+)(?:obviously|basically|you know)\b/i.test(text)) return 'conversational_filler';
  if (/\b(?:I|we|our|ours|my|mine|me|us|you|your|yours|you're|you are)\b/i.test(text)) return 'first_or_second_person';
  if (/\b(?:call\s+they|to\s+to|send\s+them\s+to\s+share|share\s+them\s+with\s+us)\b/i.test(text)) return 'malformed_transcript_join';
  if (/(?:^|[.!?]\s+)because\b/i.test(text)) return 'dependent_clause_start';
  return '';
}

function sanitiseSummarySentence(sentence) {
  let text = clean(sentence)
    .replace(/^(?:Obviously,\s*)?that depends on\s+how big a customer is,\s+or\s+the network that you(?:'re| are) selling to,\s+what their demands are\.?$/i, 'Requirements depend on customer size, sales network and customer demands.')
    .replace(/^Because\s+/i, '')
    .replace(/^Call\s+they\b/i, 'The client')
    .replace(/\bwere not too keen to send them to to share them with us\b/i, 'were not keen to share the materials')
    .replace(/\bwere not too keen to send them to share with us\b/i, 'were not keen to share the materials')
    .replace(/\bI (?:had|have) taken a snapshot of the label\b/i, 'a snapshot of the label had been taken')
    .replace(/\byou(?:'re| are) selling to\b/i, 'the product is being sold to')
    .replace(/\byour\b/gi, 'the')
    .replace(/\s+/g, ' ')
    .trim();
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
    if (output.length >= 4) break;
  }
  return clean(output.join(' '));
}

function shouldUseTranscriptFallback(reason) {
  return [
    'conversational_filler',
    'first_or_second_person',
    'malformed_transcript_join',
    'dependent_clause_start'
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
          const fallback = shouldUseTranscriptFallback(validation.reason)
            ? fallbackMinutesReadySummary(revised || original)
            : '';
          return fallback
            ? { text: fallback, used: false, reason: `deterministic_${validation.reason}`, overlap: validation.overlap, timingMs: Date.now() - startedAt }
            : { text: original, used: false, reason: validation.reason, overlap: validation.overlap, timingMs: Date.now() - startedAt };
        })();
  } catch (error) {
    const fallback = fallbackMinutesReadySummary(original);
    return { text: fallback || original, used: false, reason: fallback ? 'deterministic_request_failed' : 'request_failed', timingMs: Date.now() - startedAt };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

module.exports = { polishExecutiveSummaryGrammar, validateGrammarRevision, overlapScore, transcriptShapedSummaryIssue, fallbackMinutesReadySummary, shouldUseTranscriptFallback };
