'use strict';

// Private observational data only. Never add diagnostic fields to action rows:
// those rows participate in strict hashes, proofs and eligibility checks.
const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');
const context = new AsyncLocalStorage();
const VERSION = 'action-diagnostics-v1';
const FIELDS = ['id', 'occurrenceId', 'action', 'owners', 'timing', 'evidenceIds', 'reviewFlagIds', 'timingDecision', 'reviewerAuthored', 'confirmedTopic', 'source', 'reviewed'];
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, stable(value[k])])) : value;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const safe = fn => { try { return fn(); } catch { const s = context.getStore(); if (s) s.audit.errors++; return undefined; } };
const active = () => Boolean(context.getStore());
function ref(row) {
  const s = context.getStore(); if (!s || !row || typeof row.action !== 'string') return null;
  const record = structuredClone(Object.fromEntries(FIELDS.filter(k => row[k] !== undefined).map(k => [k, row[k]])));
  const id = 'action-' + hash(record);
  if (!s.nodes.has(id)) {
    const size = Buffer.byteLength(JSON.stringify(record));
    if (s.nodes.size >= s.maxNodes || s.resources.bytes + size > s.maxBytes) { s.audit.truncated = true; s.audit.limitHits.nodes++; return null; }
    s.resources.bytes += size; s.nodes.set(id, { ref: id, record });
  }
  return id;
}
function refs(rows = []) { return safe(() => rows.map(ref).filter(Boolean)) || []; }
function event(kind, inputs = [], outputs = [], data = {}) {
  return safe(() => {
    const s = context.getStore(); if (!s) return;
    s.audit.counts[kind] = (s.audit.counts[kind] || 0) + 1;
    if (s.audit.events.length >= s.maxEvents) { s.audit.truncated = true; s.audit.limitHits.events++; return; }
    const item = { sequence: s.audit.events.length + 1, kind, pass: s.pass || 'assembly',
      inputs, outputs, ...structuredClone(data) };
    const size = Buffer.byteLength(JSON.stringify(item));
    if (s.resources.bytes + size > s.maxBytes) { s.audit.truncated = true; s.audit.limitHits.bytes++; return; }
    s.resources.bytes += size; s.audit.events.push(item);
    return item.sequence;
  });
}
function transition(kind, before, after, data) {
  if (!active()) return;
  return safe(() => event(kind, refs(before), refs(after), data));
}
function origin(pass, rows = [], data = {}) {
  if (!active()) return;
  safe(() => {
    for (const [index, row] of rows.entries()) transition('created', [], [row], {
      origin: { pass, index, localId: String(row.id || ''), ...data }
    });
  });
}

function likely(left, right) {
  if ((left.evidenceIds || []).some(id => (right.evidenceIds || []).includes(id))) return true;
  const words = a => new Set((String(a.action || '').toLowerCase().match(/[\p{L}]{4,}/gu) || [])
    .filter(w => !['with', 'that', 'this', 'from', 'have', 'will', 'them', 'their'].includes(w)));
  const a = words(left), b = words(right);
  return [...a].filter(w => b.has(w)).length >= 3;
}
function nomination(left, right, nominationClass, reason, details = {}) {
  if (!active()) return;
  safe(() => {
    const s = context.getStore(), key = String(nominationClass) + ':' + reason;
    s.audit.nominationCounts[key] = (s.audit.nominationCounts[key] || 0) + 1;
    if (!s.targeted && !likely(left, right)) return;
    const pair = [hash(left), hash(right)].sort().join(':');
    if (!s.pairs.has(pair) && s.pairs.size >= s.maxPairs) { s.audit.truncated = true; s.audit.limitHits.pairs++; return; }
    s.pairs.add(pair);
    transition('nomination', [left, right], [], { nominationClass: nominationClass || 'general', reason, ...details });
  });
}
function scoped(pass, task) {
  const s = context.getStore(); return s ? context.run({ ...s, pass }, task) : task();
}
async function capture(task, options = {}) {
  if (options.enabled === false) return { value: await task(), audit: null };
  const audit = { version: VERSION, sourceHash: options.sourceHash || '', nodes: [], events: [],
    counts: {}, nominationCounts: {}, limitHits: { nodes: 0, events: 0, bytes: 0, pairs: 0 }, truncated: false, errors: 0 };
  const s = { audit, nodes: new Map(), pairs: new Set(), pass: 'assembly', resources: { bytes: 0 },
    targeted: options.targeted === true, maxNodes: options.maxNodes ?? 4096, maxEvents: options.maxEvents ?? 8192,
    maxPairs: options.maxPairs ?? 512, maxBytes: options.maxBytes ?? 2 * 1024 * 1024 };
  const value = await context.run(s, task);
  audit.nodes = [...s.nodes.values()];
  return { value, audit };
}
async function generate(draft, stage, options, task) {
  if (stage !== 'actions') return task();
  const { value, audit } = await capture(task, { enabled: options.actionDiagnostics !== false,
    sourceHash: hash(draft.sourceUnits || []) });
  if (!audit || !value?.changes) return value;
  // Persistence is already private; the normal browser projection excludes qualityState.
  const state = value.changes.qualityState || draft.qualityState || {};
  return { ...value, changes: { ...value.changes, qualityState: { ...state,
    actions: { ...state.actions, actionDiagnostics: audit } } } };
}



function resolution(action, suppliedIds, result, reason, metrics) {
  if (!active()) return;
  safe(() => {
    const sequence = transition('evidence_selected', [{ action, evidenceIds: suppliedIds }],
      [{ action, evidenceIds: result.evidenceIds }], { mechanism: 'resolveEvidence', reason, ...metrics });
    const s = context.getStore();
    if (!s.resources.resolutions) s.resources.resolutions = new Map();
    if (s.resources.resolutions.size < s.maxNodes) s.resources.resolutions.set(hash([action, suppliedIds]), sequence);
  });
}
function resolutionEvent(action, suppliedIds) {
  return safe(() => context.getStore()?.resources.resolutions?.get(hash([action, suppliedIds]))) || null;
}

function checkpoint(label, rows = []) {
  if (!active()) return;
  safe(() => {
    const s = context.getStore(), prior = s.resources.checkpoint || new Map(), next = new Map();
    const counts = new Map(); for (const row of rows) counts.set(row.id, (counts.get(row.id) || 0) + 1);
    for (const row of rows) {
      const after = refs([row]);
      if (!row.id || counts.get(row.id) !== 1) {
        event('checkpoint_unresolved', [], after, { checkpoint: label, reason: 'missing_or_repeated_register_id' }); continue;
      }
      const before = prior.get(row.id);
      event('checkpoint', before?.refs || [], after, { checkpoint: label, previousCheckpoint: before?.label || '',
        identityBasis: before ? 'unique_id_within_this_assembled_register' : 'first_observation_in_assembled_register' });
      next.set(row.id, { refs: after, label });
    }
    s.resources.checkpoint = next;
  });
}

function bindPublished(audit, before, after) {
  if (!audit || audit.version !== VERSION) return audit;
  try {
    const copy = structuredClone(audit);
    const nodes = new Map(copy.nodes.map(n => [n.ref, n]));
    const s = { audit: copy, nodes, pairs: new Set(), pass: 'identity_admission',
      resources: { bytes: Buffer.byteLength(JSON.stringify(copy)) }, maxNodes: 4096, maxEvents: 8192,
      maxPairs: 512, maxBytes: 2 * 1024 * 1024 };
    const frame = row => Object.fromEntries(Object.entries(row || {}).filter(([k]) => !['id', 'occurrenceId'].includes(k)));
    context.run(s, () => before.forEach((row, index) => {
      const next = after[index];
      if (!next || hash(frame(row)) !== hash(frame(next))) {
        event('identity_unmatched', refs([row]), [], { index, reason: 'presentation_changed_or_missing' }); return;
      }
      transition('identity_admitted', [row], [next], { index, mechanism: 'assignGeneratedActionIdentities' });
    }));
    copy.nodes = [...nodes.values()];
    return copy;
  } catch { return audit; }
}

module.exports = { resolution, resolutionEvent, checkpoint, bindPublished, VERSION, hash, active, refs, event, transition, origin, nomination, scoped, capture, generate };
