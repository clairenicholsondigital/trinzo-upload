'use strict';

const fetch = require('node-fetch');

let queueTail = Promise.resolve();
let nextRequestAt = 0;
let circuitOpenUntil = 0;

function numberSetting(value, fallback, minimum = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

function wait(ms, waitImpl = (delay) => new Promise((resolve) => setTimeout(resolve, delay))) {
  return ms > 0 ? waitImpl(ms) : Promise.resolve();
}

function retryAfterMs(response, fallback) {
  const raw = response?.headers?.get?.('retry-after');
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const reset = response?.headers?.get?.('x-ratelimit-reset') || response?.headers?.get?.('ratelimit-reset');
  if (reset) {
    const value = Number(reset);
    if (Number.isFinite(value)) return Math.max(0, value > 1e10 ? value - Date.now() : value * 1000 - Date.now());
  }
  return fallback;
}

function safeRateHeaders(response) {
  const names = ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset'];
  return Object.fromEntries(names.map((name) => [name, response?.headers?.get?.(name)]).filter(([, value]) => value != null));
}

function enqueue(task, options = {}) {
  const minIntervalMs = numberSetting(options.minIntervalMs, numberSetting(process.env.TROOPER_MIN_INTERVAL_MS, 1200));
  const run = queueTail.catch(() => undefined).then(async () => {
    const now = Date.now();
    await wait(Math.max(0, nextRequestAt - now, circuitOpenUntil - now), options.waitImpl);
    nextRequestAt = Date.now() + minIntervalMs;
    return task();
  });
  queueTail = run.catch(() => undefined);
  return run;
}

async function trooperFetch(url, init = {}, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const maxRetries = numberSetting(options.maxRetries, numberSetting(process.env.TROOPER_MAX_RETRIES, 3));
  const baseDelayMs = numberSetting(options.baseDelayMs, numberSetting(process.env.TROOPER_RETRY_BASE_MS, 5000));
  const timeoutMs = numberSetting(options.timeoutMs, numberSetting(process.env.TROOPER_REQUEST_TIMEOUT_MS, 120000), 1);
  const retryableStatuses = new Set(options.retryableStatuses || [429, 500, 502, 503, 504]);
  const startedAt = Date.now();
  let lastStatus = 0;
  let lastHeaders = {};

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const response = await enqueue(async () => {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      try {
        return await fetchImpl(url, { ...init, ...(controller ? { signal: controller.signal } : {}) });
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }, options);
    lastStatus = Number(response?.status || 0);
    lastHeaders = safeRateHeaders(response);
    if (response?.ok || !retryableStatuses.has(lastStatus)) {
      response.trooperTransport = { attempts: attempt + 1, retries: attempt, timingMs: Date.now() - startedAt, rateLimitHeaders: lastHeaders };
      return response;
    }
    const delay = retryAfterMs(response, baseDelayMs * (2 ** attempt)) + numberSetting(options.jitterMs, Math.floor(Math.random() * 500));
    if (lastStatus === 429) circuitOpenUntil = Math.max(circuitOpenUntil, Date.now() + delay);
    if (attempt >= maxRetries) break;
    try { await response.text?.(); } catch { /* release the response before retrying */ }
    await wait(delay, options.waitImpl);
  }

  const error = new Error(`Trooper request failed with status ${lastStatus} after ${maxRetries + 1} attempt(s).`);
  error.statusCode = lastStatus;
  error.retryable = retryableStatuses.has(lastStatus);
  error.attempts = maxRetries + 1;
  error.rateLimitHeaders = lastHeaders;
  error.timingMs = Date.now() - startedAt;
  throw error;
}

function resetTrooperTransportForTests() {
  queueTail = Promise.resolve();
  nextRequestAt = 0;
  circuitOpenUntil = 0;
}

module.exports = { trooperFetch, retryAfterMs, resetTrooperTransportForTests };
