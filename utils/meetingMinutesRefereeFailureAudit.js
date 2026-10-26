'use strict';
const crypto = require('node:crypto');

const VERSION = 1, MAX_SNAPSHOT_BYTES = 128 * 1024, MAX_ENTRY_BYTES = 512 * 1024;
const MAX_AUDIT_BYTES = 2 * 1024 * 1024, MAX_ENTRIES = 8, RETENTION_MS = 7 * 86400000;
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

// Capture BEFORE adapters or validation can mutate a reply. Oversized evidence
// is explicitly omitted with its fingerprint, never presented as an exact copy.
function refereeFailureSnapshot(value) {
  if (value === undefined) return { complete: false, reason: 'no_reply' };
  try {
    const serialised = JSON.stringify(value);
    const result = { complete: Buffer.byteLength(serialised, 'utf8') <= MAX_SNAPSHOT_BYTES,
      bytes: Buffer.byteLength(serialised, 'utf8'), sha256: crypto.createHash('sha256').update(serialised).digest('hex') };
    if (result.complete) result.value = JSON.parse(serialised);
    return result;
  } catch { return { complete: false, reason: 'not_serializable' }; }
}

function appendRefereeFailureAudit(previous, input, now = Date.now()) {
  const entry = { ...structuredClone(input), version: VERSION, capturedAt: new Date(now).toISOString() };
  // Each component is already bounded, but a large target catalogue or several
  // near-limit components can overflow the total entry budget.
  for (const key of ['contract', 'normalizedReply', 'rawReply', 'wireReply', 'prompt']) {
    if (bytes(entry) <= MAX_ENTRY_BYTES) break;
    if (entry[key]?.complete) { delete entry[key].value; entry[key].complete = false; entry[key].reason = 'entry_budget'; }
  }
  if (bytes(entry) > MAX_ENTRY_BYTES) throw new Error('Referee failure metadata exceeds its audit budget.');
  const old = previous?.version === VERSION && Array.isArray(previous.entries) ? previous.entries : [];
  const retained = old.filter(row => row?.version === VERSION && Number.isFinite(Date.parse(row.capturedAt))
    && Date.parse(row.capturedAt) >= now - RETENTION_MS && Date.parse(row.capturedAt) <= now);
  const audit = { version: VERSION, dropped: Math.max(0, Number(previous?.dropped) || 0) + old.length - retained.length,
    entries: [...structuredClone(retained), entry] };
  while (audit.entries.length > MAX_ENTRIES || bytes(audit) > MAX_AUDIT_BYTES) {
    audit.entries.shift(); audit.dropped++;
  }
  return audit;
}

module.exports = { refereeFailureSnapshot, appendRefereeFailureAudit,
  VERSION, MAX_SNAPSHOT_BYTES, MAX_ENTRY_BYTES, MAX_AUDIT_BYTES, MAX_ENTRIES, RETENTION_MS };
