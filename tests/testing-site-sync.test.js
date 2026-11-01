'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {processingKeys, processEnvironment, sandboxEnvironment, environmentFile, assertSandboxDatabase,
  isProcessingSource, observationSignature, childEnvironment, assertChildEnvironment} = require('../ops/testing-site/sync.cjs');
const {observeState} = require('../utils/runtimeIdentity');

test('processing discovery keeps real Original flags and provider settings while excluding isolated state and secrets', () => {
  const keys = processingKeys([
    'process.env.MEETING_AGENT_COMPACT_DISCUSSION_V1; process.env.MEETING_AGENT_COMPACT_DISCUSSION_SHADOW;',
    'env.MEETING_MINUTES_BETA_SHORT_ANSWERS_V1; process.env["POWER_AUTOMATE_AGENT_WEBHOOK_URL"];',
    'os.environ.get("TROOPER_API_KEY"); os.getenv("GOOGLE_AI_STUDIO_API_KEY");',
    'os.environ["OPENROUTER_API_KEY"]; env.get("M365AGENT_TOKEN_ENDPOINT");',
    'process.env.MEETING_MINUTES_AGENT_BASELINE_TOKEN; process.env.MEETING_MINUTES_AGENT_BASELINE_TOKEN_SHA256;',
    'process.env.MICROSOFT_TENANT_ID; process.env.MICROSOFT_APPLICATION_ID; process.env.MEETING_AGENT_PUBLIC_ORIGIN;',
    'process.env.POWER_AUTOMATE_WEBHOOK_URL; process.env.DIRECTLINE_SECRET; process.env.PGUSER; process.env.DATABASE_URL;',
    'process.env.REVIEW_FEEDBACK_DATA_DIR; process.env.TRINZO_RUNTIME_DIR; process.env.ACTION_TRACE;'
  ]);
  assert.deepEqual(keys, ['GOOGLE_AI_STUDIO_API_KEY', 'M365AGENT_TOKEN_ENDPOINT', 'MEETING_AGENT_COMPACT_DISCUSSION_SHADOW',
    'MEETING_AGENT_COMPACT_DISCUSSION_V1', 'MEETING_MINUTES_BETA_SHORT_ANSWERS_V1', 'OPENROUTER_API_KEY',
    'POWER_AUTOMATE_AGENT_WEBHOOK_URL', 'TROOPER_API_KEY']);
  assert(isProcessingSource('utils/meetingMinutesOriginalFeatures.js'));
  assert(isProcessingSource('scripts/project_update_minilm.py'));
  assert(!isProcessingSource('tests/runtime-identity.test.js'));
  assert(!isProcessingSource('ops/testing-site/sync.cjs'));
  assert(!isProcessingSource('scripts/run_tests.js'));
});

test('the actual process environment wins over dotenv defaults, including blank and equals-bearing values', () => {
  const result = processEnvironment(Buffer.from('TROOPER_MODEL=running\0EMPTY=\0TOKEN=a=b=c\0'),
    {TROOPER_MODEL: 'file', EMPTY: 'fallback', NEW_FLAG: 'new'});
  assert.deepEqual(result, {TROOPER_MODEL: 'running', EMPTY: '', TOKEN: 'a=b=c', NEW_FLAG: 'new'});
});

test('child configuration uses Python parsing and rejects source or external provider overrides', () => {
  const source = childEnvironment([
    '# ignored', 'TROOPER_MODEL = ""same""', "OPENROUTER_MODEL='router'",
    'TROOPER_TOKEN=a=b # literal', 'TROOPER_PATH="a\\\\b"', 'IGNORED=anything'
  ].join('\n'));
  assert.deepEqual(source, {TROOPER_MODEL: 'same', OPENROUTER_MODEL: 'router',
    TROOPER_TOKEN: 'a=b # literal', TROOPER_PATH: 'a\\\\b', IGNORED: 'anything'});
  assert.doesNotThrow(() => assertChildEnvironment(source, source, {OPENROUTER_MODEL: 'not-loaded-by-trooper'}));
  for (const key of ['TROOPER_MODEL', 'OPENROUTER_MODEL']) {
    assert.throws(() => assertChildEnvironment({...source, [key]: 'process-override'}, source),
      /Child processing settings differ/);
  }
  assert.throws(() => assertChildEnvironment(source, source, {TROOPER_MODEL: 'external-override'}),
    /External child processing settings differ/);
  const timeout = {MEETING_MINUTES_FINAL_TIMEOUT_MS: '90000'};
  assert.throws(() => assertChildEnvironment({MEETING_MINUTES_FINAL_TIMEOUT_MS: ''}, timeout), /timeout fallback/);
  assert.throws(() => assertChildEnvironment({}, {}, timeout), /timeout fallback/);
  assert.doesNotThrow(() => assertChildEnvironment({MEETING_MINUTES_FINAL_TIMEOUT_MS: '120000'}, timeout));
});

test('metadata observations match runtime checks and detect creation, changes and removal without file reads', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'testing-sync-observe-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const file = path.join(directory, 'child.env');
  assert.equal(observationSignature(file), 'missing');
  assert.equal(observeState(file), 'missing');
  fs.writeFileSync(file, 'test-only', {mode: 0o000});
  const initial = observationSignature(file), stat = fs.statSync(file, {bigint: true});
  assert.equal(initial, [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':'));
  assert.equal(initial, observeState(file));
  fs.chmodSync(file, 0o600); fs.appendFileSync(file, '-changed');
  assert.notEqual(observationSignature(file), initial);
  assert.equal(observationSignature(file), observeState(file));
  fs.unlinkSync(file); assert.equal(observationSignature(file), 'missing');
});

test('sandbox environment copies only discovered processing configuration and rejects processing overrides', () => {
  const effective = {TROOPER_MODEL: 'same', TROOPER_API_KEY: 'private-provider', DATABASE_URL: 'private-production-db',
    TRINZO_PASSWORD: 'unrelated-secret', AUTH_PASSWORD: 'unrelated-auth', PATH: '/root/private/bin', NODE_ENV: 'production'};
  const keys = ['TROOPER_API_KEY', 'TROOPER_MODEL'];
  const result = sandboxEnvironment(effective, keys, {DATABASE_URL: 'private-sandbox-db', HOST: '127.0.0.1'});
  assert.equal(result.TROOPER_MODEL, 'same'); assert.equal(result.TROOPER_API_KEY, 'private-provider');
  assert.equal(result.DATABASE_URL, 'private-sandbox-db'); assert.equal(result.HOST, '127.0.0.1');
  assert.equal(result.TRINZO_PASSWORD, undefined); assert.equal(result.AUTH_PASSWORD, undefined);
  assert(!result.PATH.includes('/root'));
  assert.throws(() => sandboxEnvironment(effective, keys, {TROOPER_MODEL: 'different'}));
  assert.throws(() => sandboxEnvironment(effective, keys, {TRINZO_PASSWORD: 'copy-me'}));
  assert.throws(() => sandboxEnvironment(effective, keys, {NODE_OPTIONS: '--inspect=0.0.0.0'}));
  assert.equal(sandboxEnvironment({}, ['NODE_ENV'], {}).NODE_ENV, undefined, 'a referenced unset value retains its live fingerprint');
});

test('database isolation requires the dedicated testing cluster, database and role, never production or PG overrides', () => {
  const isolated = {DATABASE_URL: 'postgresql://trinzo_testing:private@127.0.0.1:5440/trinzo_testing'};
  const live = {PGHOST: '127.0.0.1', PGPORT: '5432', PGDATABASE: 'live', PGUSER: 'live'};
  assert.doesNotThrow(() => assertSandboxDatabase(isolated, live));
  for (const url of ['postgresql://trinzo_testing:private@127.0.0.1:5432/trinzo_testing',
    'postgresql://live:private@127.0.0.1:5440/trinzo_testing',
    'postgresql://trinzo_testing:private@127.0.0.1:5440/live']) {
    assert.throws(() => assertSandboxDatabase({DATABASE_URL: url}, live));
  }
  assert.throws(() => assertSandboxDatabase({DATABASE_URL: isolated.DATABASE_URL + '?port=5432&user=postgres'}, live));
  assert.throws(() => assertSandboxDatabase({DATABASE_URL: isolated.DATABASE_URL + '#ignored'}, live));
  assert.throws(() => assertSandboxDatabase({...isolated, PGDATABASE: 'live'}, live));
  assert.throws(() => assertSandboxDatabase(isolated, isolated));
});

test('environment files quote provider values without shell evaluation and reject NUL values', () => {
  const tick = String.fromCharCode(96);
  const body = environmentFile({PROVIDER: 'value "quoted" \\ path $literal '+tick+'literal'+tick, MULTILINE: 'first\nsecond'});
  assert.equal(body, 'MULTILINE="first\nsecond"\nPROVIDER="value \\"quoted\\" \\\\ path $literal '+tick+'literal'+tick+'"\n');
  assert.throws(() => environmentFile({PROVIDER: 'bad\0value'}));
});
