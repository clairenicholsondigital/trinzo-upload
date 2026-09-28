'use strict';

const crypto = require('node:crypto');
const express = require('express');

function suppliedBearerToken(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+([^\s]+)$/i);
  return match ? match[1] : '';
}

function tokenMatches(supplied, expected, expectedHash = '') {
  if (!supplied || (!expected && !expectedHash)) return false;
  const suppliedHash = crypto.createHash('sha256').update(supplied).digest();
  const configuredHash = /^[a-f0-9]{64}$/i.test(String(expectedHash || ''))
    ? Buffer.from(expectedHash, 'hex')
    : crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(suppliedHash, configuredHash);
}

function createBaselineTestingRouter({
  clearMemoryCaches,
  token = process.env.MEETING_MINUTES_AGENT_BASELINE_TOKEN,
  tokenHash = process.env.MEETING_MINUTES_AGENT_BASELINE_TOKEN_SHA256
} = {}) {
  if (typeof clearMemoryCaches !== 'function') throw new TypeError('clearMemoryCaches is required.');
  const router = express.Router();

  router.post('/reset-memory-cache', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const configuredToken = String(token || '').trim();
    const configuredTokenHash = String(tokenHash || '').trim();
    if (!configuredToken && !/^[a-f0-9]{64}$/i.test(configuredTokenHash)) {
      return res.status(503).json({ ok: false, code: 'BASELINE_RESET_NOT_CONFIGURED', error: 'Baseline cache reset is not configured.' });
    }
    if (!tokenMatches(suppliedBearerToken(req), configuredToken, configuredTokenHash)) {
      return res.status(401).json({ ok: false, code: 'BASELINE_RESET_UNAUTHORISED', error: 'A valid baseline reset token is required.' });
    }

    try {
      const result = await clearMemoryCaches();
      return res.json({
        ok: true,
        resetAt: new Date().toISOString(),
        ...result,
        note: 'Persisted drafts and their saved pass caches were not changed. Start the bulk run with new drafts.'
      });
    } catch (error) {
      const status = Number(error.statusCode || error.status || 500);
      return res.status(status).json({
        ok: false,
        code: error.code || (status === 409 ? 'BASELINE_RESET_BUSY' : 'BASELINE_RESET_FAILED'),
        error: status < 500 ? error.message : 'The meeting-minutes memory cache could not be reset.',
        ...(error.state ? { state: error.state } : {})
      });
    }
  });

  return router;
}

module.exports = { createBaselineTestingRouter, suppliedBearerToken, tokenMatches };
