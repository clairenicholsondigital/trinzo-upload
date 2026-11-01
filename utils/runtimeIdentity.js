'use strict';

// Optional private attestations. A sandbox without a current live peer fails closed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const jsonHash = value => digest(JSON.stringify(value));
const SHA = /^[a-f0-9]{64}$/;
const PUBLIC_MESSAGE = 'Testing is temporarily unavailable while it synchronizes with the live service.';
const CODES = new Set(['INVALID_CONFIGURATION', 'INVALID_MANIFEST', 'SOURCE_MISMATCH',
  'MANIFEST_CHANGED', 'SOURCE_CHANGED', 'ENVIRONMENT_CHANGED', 'PROCESS_UNAVAILABLE',
  'PEER_UNAVAILABLE', 'PEER_MISMATCH', 'IDENTITY_IO_ERROR']);
const fault = code => Object.assign(new Error('Runtime identity unavailable.'), {identityCode: code});

function readProcessStart(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (['Z', 'X', 'x'].includes(fields[0]) || !/^\d+$/.test(fields[19] || '')) return null;
    const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return boot + ':' + fields[19];
  } catch { return null; }
}

function fileState(file) {
  const stat = fs.statSync(file, {bigint: true});
  if (!stat.isFile()) throw fault('INVALID_MANIFEST');
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
}

function observeState(file) {
  try { return fileState(file); }
  catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    throw error;
  }
}

function createRuntimeIdentity({env = process.env, sourceRoot = path.join(__dirname, '..'),
  role = 'web', pid = process.pid, readProcessStart: processStartFor = readProcessStart,
  now = () => new Date()} = {}) {
  const runtimeDir = env.TRINZO_RUNTIME_DIR;
  const manifestFile = env.TRINZO_RUNTIME_MANIFEST || (runtimeDir && path.join(runtimeDir, 'manifest-' + role + '.json'));
  const identityFile = env.TRINZO_RUNTIME_IDENTITY_FILE || (runtimeDir && path.join(runtimeDir, role + '.json'));
  const peerFile = env.TRINZO_RUNTIME_PEER_IDENTITY_FILE;
  const enabled = Boolean(runtimeDir || manifestFile || identityFile || peerFile);
  const sandbox = Boolean(peerFile);
  let identity = null, errorCode = '', manifest, snapshots, observations, processStart, mode = 0o600;
  const bootAt = now().toISOString();

  function writeIdentity(value) {
    if (!identityFile || (peerFile && path.resolve(identityFile) === path.resolve(peerFile))
      || (manifestFile && path.resolve(identityFile) === path.resolve(manifestFile))) return;
    fs.mkdirSync(path.dirname(identityFile), {recursive: true, mode: 0o700});
    const temporary = identityFile + '.' + pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    let created = false;
    try {
      fs.writeFileSync(temporary, JSON.stringify(value) + '\n', {flag: 'wx', mode});
      created = true;
      fs.chmodSync(temporary, mode);
      fs.renameSync(temporary, identityFile);
    } finally {
      try { if (created) fs.unlinkSync(temporary); } catch {}
    }
  }
  function invalidate(error) {
    const next = CODES.has(error?.identityCode) ? error.identityCode : 'IDENTITY_IO_ERROR';
    if (errorCode) return;
    errorCode = next;
    try {
      writeIdentity({version: 1, pid, processStart: processStart || null, role, bootAt,
        status: 'invalid', errorCode});
    } catch { /* Private status remains available through getDiagnostic. */ }
  }
  function environmentHash() {
    return jsonHash([...manifest.processingKeys].sort().map(key => [key,
      env[key] === undefined ? null : String(env[key])]));
  }
  function unavailable() {
    return Object.assign(new Error(PUBLIC_MESSAGE), {statusCode: 503, code: 'RUNTIME_IDENTITY_UNAVAILABLE'});
  }

  if (enabled) {
    try {
      if (!manifestFile || !identityFile || !Number.isSafeInteger(pid) || pid <= 0
        || typeof role !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(role)
        || (peerFile && path.resolve(identityFile) === path.resolve(peerFile))
        || path.resolve(identityFile) === path.resolve(manifestFile)) throw fault('INVALID_CONFIGURATION');
      const configuredMode = env.TRINZO_RUNTIME_IDENTITY_MODE || '0600';
      if (!['0600', '0640'].includes(configuredMode)) throw fault('INVALID_CONFIGURATION');
      mode = parseInt(configuredMode, 8);
      const raw = fs.readFileSync(manifestFile);
      manifest = JSON.parse(raw);
      if (!manifest || typeof manifest.revision !== 'string' || !/^[a-f0-9]{40}$/.test(manifest.revision)
        || !Array.isArray(manifest.files) || !manifest.files.length
        || !Array.isArray(manifest.processingKeys)
        || manifest.processingKeys.some(key => typeof key !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(key))
        || new Set(manifest.processingKeys).size !== manifest.processingKeys.length
        || (manifest.observations !== undefined && !Array.isArray(manifest.observations))) throw fault('INVALID_MANIFEST');
      const seen = new Set();
      snapshots = manifest.files.map(entry => {
        if (!entry || typeof entry.path !== 'string' || !entry.path || !SHA.test(entry.sha256))
          throw fault('INVALID_MANIFEST');
        const file = path.resolve(sourceRoot, entry.path);
        if (seen.has(file)) throw fault('INVALID_MANIFEST');
        seen.add(file);
        const before = fileState(file), actualHash = digest(fs.readFileSync(file)), after = fileState(file);
        if (before !== after || actualHash !== entry.sha256) throw fault('SOURCE_MISMATCH');
        return {file, state: after, path: entry.path, sha256: actualHash};
      });
      const observed = new Set();
      observations = (manifest.observations || []).map(entry => {
        if (!entry || typeof entry.path !== 'string' || !entry.path || typeof entry.signature !== 'string'
          || !(entry.signature === 'missing' || /^(?:[0-9]+:){3}-?[0-9]+:-?[0-9]+$/.test(entry.signature)))
          throw fault('INVALID_MANIFEST');
        const file = path.resolve(sourceRoot, entry.path);
        if (observed.has(file)) throw fault('INVALID_MANIFEST');
        observed.add(file);
        if (observeState(file) !== entry.signature) throw fault('SOURCE_MISMATCH');
        return {file, state: entry.signature};
      });
      processStart = processStartFor(pid);
      if (typeof processStart !== 'string' || !processStart) throw fault('PROCESS_UNAVAILABLE');
      const fields = {revision: manifest.revision, manifestHash: digest(raw),
        sourceHash: jsonHash(snapshots.map(({path: file, sha256}) => ({path: file, sha256}))),
        environmentHash: environmentHash()};
      identity = {version: 1, pid, processStart, role, ...fields,
        fingerprint: jsonHash(fields), bootAt, status: 'ready'};
      writeIdentity(identity);
    } catch (error) { invalidate(error); }
  }

  function assertCurrent() {
    if (!enabled) return true;
    if (!errorCode) {
      try {
        if (processStartFor(pid) !== processStart) throw fault('PROCESS_UNAVAILABLE');
        if (digest(fs.readFileSync(manifestFile)) !== identity.manifestHash) throw fault('MANIFEST_CHANGED');
        if (environmentHash() !== identity.environmentHash) throw fault('ENVIRONMENT_CHANGED');
        for (const snapshot of snapshots) {
          if (fileState(snapshot.file) !== snapshot.state) throw fault('SOURCE_CHANGED');
        }
        for (const observation of observations) {
          if (observeState(observation.file) !== observation.state) throw fault('SOURCE_CHANGED');
        }
        if (sandbox) {
          let peer;
          try { peer = JSON.parse(fs.readFileSync(peerFile, 'utf8')); }
          catch { throw fault('PEER_UNAVAILABLE'); }
          if (peer?.version !== 1 || peer.status !== 'ready' || peer.role !== role
            || !Number.isSafeInteger(peer.pid) || peer.pid <= 0 || peer.pid === pid
            || typeof peer.processStart !== 'string' || !peer.processStart
            || processStartFor(peer.pid) !== peer.processStart) throw fault('PEER_UNAVAILABLE');
          for (const key of ['revision', 'manifestHash', 'sourceHash', 'environmentHash', 'fingerprint']) {
            if (peer[key] !== identity[key]) throw fault('PEER_MISMATCH');
          }
        }
        return true;
      } catch (error) { invalidate(error); }
    }
    if (sandbox) throw unavailable();
    return false; // Attestation must never take the production application offline.
  }

  function middleware(req, res, next) {
    try { assertCurrent(); }
    catch { return res.status(503).json({ok: false, code: 'RUNTIME_IDENTITY_UNAVAILABLE', error: PUBLIC_MESSAGE}); }
    return next();
  }
  return {enabled, sandbox, assertCurrent, middleware,
    getIdentity: () => identity ? structuredClone({...identity, ...(errorCode ? {status: 'invalid', errorCode} : {})}) : null,
    getDiagnostic: () => ({enabled, sandbox, current: enabled ? !errorCode : true, errorCode: errorCode || null})};
}

module.exports = {createRuntimeIdentity, observeState};
