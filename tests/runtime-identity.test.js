'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {createRuntimeIdentity, observeState} = require('../utils/runtimeIdentity');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trinzo-runtime-identity-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const source = path.join(root, 'source.js'), external = path.join(root, 'provider.json');
  fs.writeFileSync(source, 'synthetic source');
  fs.writeFileSync(external, '{"endpoint":"https://fixture.invalid/private-secret"}');
  const manifestFile = path.join(root, 'manifest.json'), peerFile = path.join(root, 'live.json');
  const manifest = {revision: 'a'.repeat(40),
    files: [{path: 'source.js', sha256: sha(fs.readFileSync(source))},
      {path: external, sha256: sha(fs.readFileSync(external))}],
    processingKeys: ['FEATURE_FLAG', 'PROVIDER_ENDPOINT']};
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const liveProcesses = new Map([[101, 'boot:111'], [202, 'boot:222']]);
  const env = {TRINZO_RUNTIME_MANIFEST: manifestFile, TRINZO_RUNTIME_IDENTITY_FILE: peerFile,
    FEATURE_FLAG: '1', PROVIDER_ENDPOINT: 'https://fixture.invalid/credential-never-log'};
  const options = {sourceRoot: root, readProcessStart: pid => liveProcesses.get(pid) || null,
    now: () => new Date('2026-11-01T12:00:00Z')};
  const live = () => createRuntimeIdentity({...options, env, pid: 101, role: 'web'});
  const sandboxEnv = () => ({...env, TRINZO_RUNTIME_IDENTITY_FILE: path.join(root, 'sandbox.json'),
    TRINZO_RUNTIME_PEER_IDENTITY_FILE: peerFile});
  const sandbox = extra => createRuntimeIdentity({...options, env: sandboxEnv(), pid: 202, role: 'web', ...extra});
  return {root, source, external, manifestFile, peerFile, manifest, liveProcesses, env, options, live, sandboxEnv, sandbox};
}
function blocked(owner) {
  assert.throws(() => owner.assertCurrent(), error => error.statusCode === 503
    && error.code === 'RUNTIME_IDENTITY_UNAVAILABLE' && !/secret|credential|source\.js|provider\.json/.test(error.message));
}
function response() {
  return {statusCode: 200, status(code) {this.statusCode = code; return this;},
    json(value) {this.body = value; return this;}};
}

test('inactive owner does not probe processes or touch files and leaves normal requests alone', () => {
  const owner = createRuntimeIdentity({env: {}, readProcessStart: () => {throw Error('Must not run');}});
  assert.equal(owner.enabled, false);
  assert.equal(owner.assertCurrent(), true);
  let next = 0;
  owner.middleware({}, {}, () => next++);
  assert.equal(next, 1);
  assert.equal(owner.getIdentity(), null);
});

test('matching live and sandbox attestations cover source, absolute provider file and actual processing env', t => {
  const f = fixture(t), live = f.live(), sandbox = f.sandbox();
  assert.equal(live.assertCurrent(), true);
  assert.equal(sandbox.assertCurrent(), true);
  assert.equal(live.getIdentity().fingerprint, sandbox.getIdentity().fingerprint);
  assert.equal(live.getIdentity().role, 'web');
  assert.equal(live.getIdentity().processStart, 'boot:111');
  assert.equal(fs.statSync(f.peerFile).mode & 0o777, 0o600);
  const serialized = fs.readFileSync(f.peerFile, 'utf8');
  assert.equal(serialized.includes('fixture.invalid'), false);
  assert.equal(serialized.includes('credential-never-log'), false);
  assert.equal(serialized.includes(f.root), false);
  f.env.NON_PROCESSING_SETTING = 'allowed infrastructure difference';
  assert.equal(live.assertCurrent(), true);
  const copy = live.getIdentity(); copy.fingerprint = 'changed';
  assert.notEqual(copy.fingerprint, live.getIdentity().fingerprint);
});

test('explicit group-readable identity is permitted without broadening permissions', t => {
  const f = fixture(t);
  f.env.TRINZO_RUNTIME_IDENTITY_MODE = '0640';
  assert.equal(f.live().assertCurrent(), true);
  assert.equal(fs.statSync(f.peerFile).mode & 0o777, 0o640);
  f.env.TRINZO_RUNTIME_IDENTITY_MODE = '0666';
  assert.equal(f.live().assertCurrent(), false);
});

for (const [name, change] of [
  ['missing peer', f => fs.unlinkSync(f.peerFile)],
  ['malformed peer', f => fs.writeFileSync(f.peerFile, '{"broken"')],
  ['dead peer', f => f.liveProcesses.delete(101)],
  ['reused peer PID', f => f.liveProcesses.set(101, 'boot:999')],
  ['different process role', f => {const peer = JSON.parse(fs.readFileSync(f.peerFile)); peer.role = 'queue'; fs.writeFileSync(f.peerFile, JSON.stringify(peer));}],
  ['invalidated live identity', f => {const peer = JSON.parse(fs.readFileSync(f.peerFile)); peer.status = 'invalid'; fs.writeFileSync(f.peerFile, JSON.stringify(peer));}],
  ['different peer environment', f => {const peer = JSON.parse(fs.readFileSync(f.peerFile)); peer.environmentHash = '0'.repeat(64); fs.writeFileSync(f.peerFile, JSON.stringify(peer));}]
]) test('sandbox rejects ' + name + ' before admitting a request', t => {
  const f = fixture(t); f.live(); const sandbox = f.sandbox(); change(f);
  const res = response(); let reached = false;
  sandbox.middleware({}, res, () => {reached = true;});
  assert.equal(reached, false);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(Object.keys(res.body).sort(), ['code', 'error', 'ok']);
  assert.equal(JSON.stringify(res.body).includes(f.root), false);
  blocked(sandbox);
});

for (const [name, change] of [
  ['source content', f => fs.writeFileSync(f.source, 'different source contents')],
  ['source metadata even with unchanged bytes', f => {const stat = fs.statSync(f.source); fs.utimesSync(f.source, stat.atime, new Date(stat.mtimeMs + 1000));}],
  ['absolute provider configuration', f => fs.writeFileSync(f.external, '{"endpoint":"changed"}')],
  ['removed source', f => fs.unlinkSync(f.source)],
  ['manifest revision', f => {f.manifest.revision = 'b'.repeat(40); fs.writeFileSync(f.manifestFile, JSON.stringify(f.manifest));}],
  ['actual processing env', f => {f.env.FEATURE_FLAG = '0';}],
  ['own process start identity', f => f.liveProcesses.set(202, 'boot:999')]
]) test('sandbox rejects runtime drift in ' + name, t => {
  const f = fixture(t); f.live();
  const env = f.sandboxEnv(), sandbox = f.sandbox({env});
  if (name === 'actual processing env') env.FEATURE_FLAG = '0';
  else change(f);
  blocked(sandbox);
  assert.equal(sandbox.getDiagnostic().current, false);
});

test('live runtime drift invalidates its attestation while production middleware continues', t => {
  const f = fixture(t), live = f.live();
  f.env.FEATURE_FLAG = '0';
  let next = 0;
  live.middleware({}, {}, () => next++);
  assert.equal(next, 1);
  assert.equal(live.assertCurrent(), false);
  assert.equal(live.getDiagnostic().errorCode, 'ENVIRONMENT_CHANGED');
  assert.equal(live.getIdentity().status, 'invalid');
  assert.equal(JSON.parse(fs.readFileSync(f.peerFile)).status, 'invalid');
  blocked(f.sandbox());
});

test('different actual sandbox processing config cannot match live even with matching source', t => {
  const f = fixture(t); f.live();
  blocked(f.sandbox({env: {...f.sandboxEnv(), PROVIDER_ENDPOINT: 'https://other.fixture.invalid/another-secret'}}));
});

for (const kind of ['missing manifest', 'missing identity file setting', 'missing source', 'wrong source hash', 'duplicate paths', 'bad manifest JSON']) {
  test('invalid startup ' + kind + ' stays safe for production and closed for sandbox', t => {
    const f = fixture(t);
    if (kind === 'missing manifest') fs.unlinkSync(f.manifestFile);
    if (kind === 'missing identity file setting') delete f.env.TRINZO_RUNTIME_IDENTITY_FILE;
    if (kind === 'missing source') fs.unlinkSync(f.source);
    if (kind === 'wrong source hash') {f.manifest.files[0].sha256 = '0'.repeat(64); fs.writeFileSync(f.manifestFile, JSON.stringify(f.manifest));}
    if (kind === 'duplicate paths') {f.manifest.files.push({...f.manifest.files[0]}); fs.writeFileSync(f.manifestFile, JSON.stringify(f.manifest));}
    if (kind === 'bad manifest JSON') fs.writeFileSync(f.manifestFile, 'credential-never-log');
    const live = f.live();
    assert.equal(live.assertCurrent(), false);
    const env = {...f.env, TRINZO_RUNTIME_PEER_IDENTITY_FILE: f.peerFile,
      TRINZO_RUNTIME_IDENTITY_FILE: path.join(f.root, 'sandbox.json')};
    if (kind === 'missing identity file setting') delete env.TRINZO_RUNTIME_IDENTITY_FILE;
    const sandbox = f.sandbox({env});
    blocked(sandbox);
    assert.equal(JSON.stringify(live.getDiagnostic()).includes('credential-never-log'), false);
    assert.equal(JSON.stringify(sandbox.getDiagnostic()).includes(f.root), false);
  });
}

test('native Linux process start probe attests the actual current process', t => {
  const f = fixture(t);
  const live = createRuntimeIdentity({env: f.env, sourceRoot: f.root, role: 'web'});
  assert.equal(live.assertCurrent(), true);
  assert.equal(live.getIdentity().pid, process.pid);
  assert.match(live.getIdentity().processStart, /^[a-f0-9-]{36}:\d+$/);
});

test('queue processes compare only to the corresponding live queue role', t => {
  const f = fixture(t);
  const live = createRuntimeIdentity({...f.options, env: f.env, pid: 101, role: 'queue'});
  const queue = f.sandbox({role: 'queue'});
  assert.equal(live.assertCurrent(), true);
  assert.equal(queue.assertCurrent(), true);
  blocked(f.sandbox());
});

test('runtime directory derives web and queue paths while explicit paths take precedence', t => {
  const f = fixture(t);
  for (const role of ['web', 'queue']) {
    fs.copyFileSync(f.manifestFile, path.join(f.root, 'manifest-' + role + '.json'));
    const env = {...f.env, TRINZO_RUNTIME_DIR: f.root};
    delete env.TRINZO_RUNTIME_MANIFEST;
    delete env.TRINZO_RUNTIME_IDENTITY_FILE;
    const owner = createRuntimeIdentity({...f.options, env, pid: 101, role});
    assert.equal(owner.enabled, true);
    assert.equal(owner.assertCurrent(), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, role + '.json'))).role, role);
  }
  const explicit = {...f.env, TRINZO_RUNTIME_DIR: path.join(f.root, 'absent')};
  const owner = createRuntimeIdentity({...f.options, env: explicit, pid: 101, role: 'web'});
  assert.equal(owner.assertCurrent(), true);
  assert.equal(fs.existsSync(explicit.TRINZO_RUNTIME_DIR), false);
});

test('sandbox restart recovers an attestation invalidated during a live restart gap', t => {
  const f = fixture(t); f.live(); const sandbox = f.sandbox();
  fs.unlinkSync(f.peerFile);
  blocked(sandbox);
  f.liveProcesses.set(101, 'boot:333');
  f.live();
  blocked(sandbox); // An invalidated process must be restarted by the sync hook.
  assert.equal(f.sandbox().assertCurrent(), true);
});

test('sandbox cannot overwrite its peer through equivalent identity paths', t => {
  const f = fixture(t); f.live();
  const before = fs.readFileSync(f.peerFile, 'utf8');
  const env = {...f.sandboxEnv(), TRINZO_RUNTIME_IDENTITY_FILE: f.root + '/./live.json'};
  blocked(f.sandbox({env}));
  assert.equal(fs.readFileSync(f.peerFile, 'utf8'), before);
});

function observe(f, file, signature = observeState(file)) {
  f.manifest.observations = [{path: file, signature}];
  fs.writeFileSync(f.manifestFile, JSON.stringify(f.manifest));
}

test('observation reads metadata only even when opening observed content is prohibited', t => {
  const f = fixture(t), file = path.join(f.root, 'protected.env');
  fs.writeFileSync(file, 'SYNTHETIC_PRIVATE_VALUE=never-open-this');
  fs.chmodSync(file, 0o000);
  observe(f, file);
  const read = fs.readFileSync;
  fs.readFileSync = function(target, ...args) {
    if (typeof target === 'string' && path.resolve(target) === file)
      throw Error('Observed file content must never be opened.');
    return read.call(this, target, ...args);
  };
  try {
    assert.match(observeState(file), /^(?:[0-9]+:){3}-?[0-9]+:-?[0-9]+$/);
    assert.equal(f.live().assertCurrent(), true);
    assert.equal(f.sandbox().assertCurrent(), true);
    assert.equal(fs.readFileSync(f.peerFile, 'utf8').includes('SYNTHETIC_PRIVATE_VALUE'), false);
  } finally { fs.readFileSync = read; fs.chmodSync(file, 0o600); }
});

for (const kind of ['created', 'removed', 'modified']) {
  test('observed file ' + kind + ' closes sandbox and invalidates production without blocking it', t => {
    const f = fixture(t), file = path.join(f.root, 'optional-provider.env');
    if (kind !== 'created') fs.writeFileSync(file, 'fixture configuration');
    observe(f, file);
    const live = f.live(), sandbox = f.sandbox();
    assert.equal(sandbox.assertCurrent(), true);
    if (kind === 'created') fs.writeFileSync(file, 'new fixture configuration');
    if (kind === 'removed') fs.unlinkSync(file);
    if (kind === 'modified') fs.writeFileSync(file, 'changed fixture configuration contents');
    blocked(sandbox);
    assert.equal(sandbox.getDiagnostic().errorCode, 'SOURCE_CHANGED');
    assert.equal(live.assertCurrent(), false);
    let next = false;
    live.middleware({}, {}, () => {next = true;});
    assert.equal(next, true);
    assert.equal(JSON.parse(fs.readFileSync(f.peerFile)).status, 'invalid');
  });
}

test('startup observed-state mismatch cannot attest either instance as current', t => {
  const f = fixture(t), file = path.join(f.root, 'provider.env');
  fs.writeFileSync(file, 'exists');
  observe(f, file, 'missing');
  const live = f.live();
  assert.equal(live.assertCurrent(), false);
  assert.equal(live.getDiagnostic().errorCode, 'SOURCE_MISMATCH');
  blocked(f.sandbox());
});

test('observed metadata access errors fail closed and never reveal paths or content', t => {
  const f = fixture(t), file = path.join(f.root, 'access-denied.env');
  observe(f, file);
  const stat = fs.statSync;
  fs.statSync = function(target, ...args) {
    if (typeof target === 'string' && path.resolve(target) === file)
      throw Object.assign(Error('Synthetic private path must stay private: ' + file), {code: 'EACCES'});
    return stat.call(this, target, ...args);
  };
  try {
    assert.throws(() => observeState(file), error => error.code === 'EACCES');
    assert.equal(f.live().assertCurrent(), false);
    blocked(f.sandbox());
  } finally { fs.statSync = stat; }
});

for (const observations of [{}, [{path: '', signature: 'missing'}], [{path: 'optional.env', signature: 'invalid'}],
  [{path: 'optional.env', signature: 'missing'}, {path: './optional.env', signature: 'missing'}]]) {
  test('invalid observation entries cannot create a current attestation: ' + JSON.stringify(observations), t => {
    const f = fixture(t);
    f.manifest.observations = observations;
    fs.writeFileSync(f.manifestFile, JSON.stringify(f.manifest));
    assert.equal(f.live().assertCurrent(), false);
    blocked(f.sandbox());
  });
}
