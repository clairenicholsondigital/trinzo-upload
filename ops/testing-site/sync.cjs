#!/usr/bin/env node
'use strict';
// Root timer, no source copies or production restarts. /etc/trinzo-testing/config.json (root:0600):
// {liveRoot,stateRoot,runtimeRoot,pm2Guard,extraFiles:[],profiles:{web:{overrides:{}},queue:{overrides:{}}}}
// Optional profile paths must equal the fixed paths below; productionEnvFile contains runtime controls only.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const {execFileSync} = require('node:child_process'), assert = require('node:assert/strict');
const LIVE = '/srv/m365-agent-test', STATE = '/var/lib/trinzo-testing', RUNTIME = '/var/lib/trinzo-runtime';
const CONFIG = '/etc/trinzo-testing/config.json', SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const EXTRA_CHILD_ENV = '/data/.openclaw/workspace/.secrets/trooper.env';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const jsonHash = value => hash(JSON.stringify(value));
const ISOLATION = new Set(('DATABASE_URL PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PGSSLMODE PGAPPNAME ' +
  'PORT HOST AUTH_SESSION_DAYS HOME TMPDIR TMP TEMP HF_HOME XDG_CACHE_HOME TORCH_HOME PYTHONDONTWRITEBYTECODE ' +
  'REVIEW_FEEDBACK_DATA_DIR MEETING_AGENT_TRANSCRIPT_STORE_PATH CANONICAL_MINILM_DISK_CACHE TRINZO_SETTINGS_SNAPSHOT ' +
  'MEETING_MINUTES_WORKER_ID MEETING_MINUTES_WORKER_POLL_MS PROJECT_KNOWLEDGE_EMBED_INTERVAL_MS').split(' '));
function excluded(key) {
  return ISOLATION.has(key) || /^(?:PG|TRINZO_RUNTIME_|TEST_|CI$|CI_|AUTH_)/.test(key)
    || /(?:^|_)(?:BASELINE|TRACE|CAPTURE)(?:_|$)/.test(key)
    || ['PATH', 'NODE_OPTIONS', 'NODE_PATH', 'ACTION_TRACE', 'ACTION_FUNNEL', 'POWER_AUTOMATE_WEBHOOK_URL',
      'MICROSOFT_TENANT_ID', 'MICROSOFT_APPLICATION_ID', 'MEETING_AGENT_PUBLIC_ORIGIN', 'DIRECTLINE_SECRET'].includes(key);
}
const isProcessingSource = name => /^(?:server\.js|routes\/.*\.[cm]?js|utils\/.*\.[cm]?js|scripts\/.*\.py|scripts\/meeting_minutes_final_worker\.js)$/.test(name);
function processingKeys(texts) {
  const keys = new Set();
  const patterns = [/\b(?:process\.env|env)\.([A-Z][A-Z0-9_]*)/g,
    /\b(?:process\.env|env)\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g,
    /\b(?:os\.)?(?:getenv|(?:environ|env)\.get)\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
    /\b(?:os\.)?environ\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g];
  for (const text of texts) for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
    if (!excluded(match[1])) keys.add(match[1]);
  }
  return [...keys].sort();
}
function processEnvironment(raw, defaults) {
  const effective = {...defaults};
  for (const entry of raw.toString().split('\0')) {
    const split = entry.indexOf('=');
    if (split > 0) effective[entry.slice(0, split)] = entry.slice(split + 1);
  }
  return effective; // /proc is authoritative; dotenv fills only absent initial-environment keys.
}
function observationSignature(file) {
  try {
    const stat = fs.statSync(file, {bigint: true}); assert(stat.isFile());
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
  } catch (error) { if (error.code === 'ENOENT') return 'missing'; throw error; }
}
function childEnvironment(raw) {
  const values = {};
  for (const line of raw.toString().split(/\r\n|\r|\n/)) {
    const text = line.trim(), split = text.indexOf('=');
    if (!text.startsWith('#') && split > 0) values[text.slice(0, split).trim()] = text.slice(split + 1).trim().replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '');
  }
  return values; // Match the Python child loaders; they do not use dotenv's comment/escape parsing.
}
function assertChildEnvironment(effective, source, extra = {}) {
  for (const values of [source, extra]) for (const [key, value] of Object.entries(values))
    if (key.startsWith('MEETING_MINUTES_FINAL_TIMEOUT_MS') && !effective[key])
      assert(!value, 'Child timeout fallback differs from the effective live environment');
  for (const [key, value] of Object.entries(source)) if (/^(?:TROOPER_|OPENROUTER_)/.test(key))
    assert(effective[key] === value, 'Child processing settings differ from the effective live environment');
  for (const [key, value] of Object.entries(extra)) if (/^TROOPER_/.test(key))
    assert(effective[key] === value, 'External child processing settings differ from the effective live environment');
}
function sandboxEnvironment(effective, keys, overrides) {
  const result = {PATH: SAFE_PATH, LANG: effective.LANG || 'C.UTF-8', NODE_ENV: effective.NODE_ENV || 'production'};
  for (const key of keys) {
    if (effective[key] !== undefined) result[key] = String(effective[key]);
    else delete result[key];
  }
  for (const [key, value] of Object.entries(overrides || {})) {
    assert(ISOLATION.has(key) && !keys.includes(key), 'Only isolation settings may override live processing configuration');
    assert(['string', 'number', 'boolean'].includes(typeof value) && !String(value).includes('\0'));
    result[key] = String(value);
  }
  return result;
}
function databaseTarget(environment) {
  if (!environment.DATABASE_URL) return [environment.PGHOST, String(environment.PGPORT || 5432), environment.PGDATABASE, environment.PGUSER];
  const url = new URL(environment.DATABASE_URL); assert(['postgres:', 'postgresql:'].includes(url.protocol));
  assert(!url.search && !url.hash, 'Database URLs must not override their fixed target through query parameters');
  return [url.hostname, url.port || '5432', decodeURIComponent(url.pathname.slice(1)), decodeURIComponent(url.username)];
}
function assertSandboxDatabase(environment, live) {
  assert.deepEqual(databaseTarget(environment), ['127.0.0.1', '5440', 'trinzo_testing', 'trinzo_testing']);
  assert(!Object.keys(environment).some(key => key.startsWith('PG')), 'Sandbox profiles use only their dedicated DATABASE_URL');
  assert.notDeepEqual(databaseTarget(environment), databaseTarget(live), 'Sandbox database must differ from production');
}
function environmentFile(values) {
  return Object.keys(values).sort().map(key => {
    assert(/^[A-Z][A-Z0-9_]*$/.test(key) && !String(values[key]).includes('\0'));
    return key + '="' + String(values[key]).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"\n';
  }).join('');
}
function trustedFile(file, mode) {
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 && !(stat.mode & 0o022));
  if (mode !== undefined) assert.equal(stat.mode & 0o777, mode);
  return fs.readFileSync(file);
}
function run(binary, args) {
  return execFileSync(binary, args, {cwd: LIVE, env: {PATH: SAFE_PATH, LANG: 'C.UTF-8'},
    encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024}).trim();
}
function processState(pid) {
  assert(Number.isSafeInteger(pid) && pid > 0);
  const base = '/proc/' + pid, stat = fs.readFileSync(base + '/stat', 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  assert(!['Z', 'X', 'x'].includes(fields[0]) && fs.statSync(base).uid === 0);
  return {start: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + ':' + fields[19],
    raw: fs.readFileSync(base + '/environ')};
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function currentIdentity(value) {
  try {
    assert(Number.isSafeInteger(value?.pid) && value.pid > 0);
    const stat = fs.readFileSync('/proc/' + value.pid + '/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return !['Z', 'X', 'x'].includes(fields[0]) && value.processStart === fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + ':' + fields[19];
  } catch { return false; }
}
function atomic(file, body, mode, gid) {
  try {
    const stat = fs.lstatSync(file); assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0);
    if (fs.readFileSync(file, 'utf8') === body && stat.gid === gid && (stat.mode & 0o777) === mode) return false;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const directory = fs.lstatSync(path.dirname(file)); assert(directory.isDirectory() && !directory.isSymbolicLink() && directory.uid === 0);
  const temporary = file + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temporary, body, {flag: 'wx', mode});
    fs.chownSync(temporary, 0, gid); fs.chmodSync(temporary, mode); fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
  return true;
}
function main() {
  assert.equal(process.geteuid(), 0, 'Root host execution required');
  const configRaw = trustedFile(CONFIG, 0o600), config = JSON.parse(configRaw);
  assert.equal(config.liveRoot, LIVE); assert.equal(config.stateRoot, STATE); assert.equal(config.runtimeRoot, RUNTIME);
  assert(path.isAbsolute(config.pm2Guard) && config.pm2Guard.startsWith('/root/'));
  trustedFile(config.pm2Guard);
  const gid = Number(run('/usr/bin/getent', ['group', 'trinzo-runtime']).split(':')[2]); assert(Number.isSafeInteger(gid));
  const status = () => JSON.parse(run(process.execPath, [config.pm2Guard, 'status']));
  const rows = status(), git = (...args) => run('/usr/bin/git', args);
  const revision = git('rev-parse', 'HEAD'); assert(/^[a-f0-9]{40}$/.test(revision));
  assert.equal(git('status', '--porcelain'), '', 'Live source must be a clean release');
  const tracked = run('/usr/bin/git', ['ls-files', '-z']).split('\0').filter(Boolean).sort();
  const observations = [path.join(LIVE, '.env'), EXTRA_CHILD_ENV].map(file => ({path: file, signature: observationSignature(file)}));
  const envRaw = fs.readFileSync(path.join(LIVE, '.env'));
  const defaults = require(path.join(LIVE, 'node_modules/dotenv')).parse(envRaw);
  const extraChild = observations[1].signature === 'missing' ? {} : childEnvironment(fs.readFileSync(EXTRA_CHILD_ENV));
  const extras = config.extraFiles || []; assert(Array.isArray(extras));
  const names = [...new Set([...tracked, ...extras.map(file => {
    assert(typeof file === 'string' && file && !file.includes('\0'));
    const absolute = path.resolve(LIVE, file);
    assert(absolute !== path.join(LIVE, '.env') && !absolute.startsWith('/etc/trinzo-testing/'));
    return absolute.startsWith(LIVE + '/') ? path.relative(LIVE, absolute) : absolute;
  })])].sort();
  const texts = [], files = names.map(name => {
    const file = path.resolve(LIVE, name), body = fs.readFileSync(file); assert(fs.statSync(file).isFile());
    if (tracked.includes(name) && isProcessingSource(name)) texts.push(body.toString());
    return {path: name, sha256: hash(body)};
  });
  const keys = processingKeys(texts), plans = [];
  for (const role of ['web', 'queue']) {
    const settings = config.profiles?.[role]; assert(settings && typeof settings === 'object');
    const name = role === 'web' ? 'trinzo' : 'trinzo-minutes-final-worker';
    const matches = rows.filter(row => row.name === name); assert.equal(matches.length, 1);
    const row = matches[0]; assert.equal(row.pm2_env.status, 'online'); assert.equal(row.pm2_env.pm_cwd, LIVE);
    assert.equal(row.pm2_env.pm_exec_path, path.join(LIVE, role === 'web' ? 'server.js' : 'scripts/meeting_minutes_final_worker.js'));
    const observed = processState(row.pid), effective = processEnvironment(observed.raw, defaults);
    assertChildEnvironment(effective, defaults, extraChild);
    assertChildEnvironment(effective, childEnvironment(envRaw), extraChild);
    const paths = {envFile: '/etc/trinzo-testing/' + role + '.env',
      productionEnvFile: '/etc/trinzo-testing/production-' + role + '.env',
      identityFile: STATE + '/runtime/' + role + '.json', peerIdentityFile: RUNTIME + '/' + role + '.json'};
    for (const [key, value] of Object.entries(paths)) if (settings[key] !== undefined) assert.equal(settings[key], value);
    const unit = 'minutes-testing-' + role + '.service'; if (settings.unit !== undefined) assert.equal(settings.unit, unit);
    const manifestFile = RUNTIME + '/manifest-' + role + '.json';
    const manifest = JSON.stringify({revision, files, processingKeys: keys, observations}, null, 2) + '\n';
    const controls = {TRINZO_RUNTIME_MANIFEST: manifestFile, TRINZO_RUNTIME_IDENTITY_FILE: paths.identityFile,
      TRINZO_RUNTIME_PEER_IDENTITY_FILE: paths.peerIdentityFile, TRINZO_RUNTIME_IDENTITY_MODE: '0640'};
    const environment = sandboxEnvironment(effective, keys, settings.overrides);
    assertSandboxDatabase(environment, effective);
    const fields = {revision, manifestHash: hash(manifest), sourceHash: jsonHash(files),
      environmentHash: jsonHash(keys.map(key => [key, effective[key] === undefined ? null : String(effective[key])]))};
    plans.push({role, row, observed, paths, unit, manifestFile, manifest,
      envBody: environmentFile({...environment, ...controls}),
      productionBody: environmentFile({TRINZO_RUNTIME_DIR: RUNTIME, TRINZO_RUNTIME_IDENTITY_MODE: '0640'}),
      fingerprint: jsonHash(fields), writeProductionEnvironment: Boolean(settings.productionEnvFile)});
  }
  // Recheck every input and both live processes before publishing anything.
  assert.equal(hash(trustedFile(CONFIG, 0o600)), hash(configRaw)); assert.equal(git('rev-parse', 'HEAD'), revision);
  assert.equal(git('status', '--porcelain'), '', 'Live source changed during synchronization');
  for (const entry of observations) assert.equal(observationSignature(entry.path), entry.signature);
  assert.deepEqual(run('/usr/bin/git', ['ls-files', '-z']).split('\0').filter(Boolean).sort(), tracked);
  assert.equal(hash(fs.readFileSync(path.join(LIVE, '.env'))), hash(envRaw));
  for (const entry of files) assert.equal(hash(fs.readFileSync(path.resolve(LIVE, entry.path))), entry.sha256);
  const latest = status();
  for (const plan of plans) {
    assert.equal(latest.find(row => row.name === plan.row.name)?.pid, plan.row.pid);
    const fresh = processState(plan.row.pid); assert.equal(fresh.start, plan.observed.start); assert(fresh.raw.equals(plan.observed.raw));
  }
  const restarted = [];
  for (const plan of plans) {
    const manifestChanged = atomic(plan.manifestFile, plan.manifest, 0o640, gid);
    const environmentChanged = atomic(plan.paths.envFile, plan.envBody, 0o600, gid);
    if (plan.writeProductionEnvironment) atomic(plan.paths.productionEnvFile, plan.productionBody, 0o600, gid);
    const peer = readJson(plan.paths.peerIdentityFile), local = readJson(plan.paths.identityFile);
    const peerReady = peer?.status === 'ready' && peer.pid === plan.row.pid && peer.processStart === plan.observed.start
      && peer.role === plan.role && peer.fingerprint === plan.fingerprint;
    const recover = peerReady && (local?.status !== 'ready' || local.fingerprint !== peer.fingerprint || !currentIdentity(local));
    if (manifestChanged || environmentChanged || recover) {
      run('/usr/bin/systemctl', ['try-restart', plan.unit]); restarted.push(plan.role);
    }
  }
  console.log(JSON.stringify({revision, sourceFiles: files.length, processingKeys: keys.length, restarted}));
}
if (require.main === module) {
  try { main(); } catch { console.error('Testing synchronization failed; production services were not restarted.'); process.exitCode = 1; }
}
module.exports = {processingKeys, processEnvironment, sandboxEnvironment, environmentFile, assertSandboxDatabase,
  isProcessingSource, observationSignature, childEnvironment, assertChildEnvironment};
