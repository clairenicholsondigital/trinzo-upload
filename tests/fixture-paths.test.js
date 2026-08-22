'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Five reviewer-confirmed preservation tests in canonical-staged.test.js read their
// transcript from a sibling checkout outside this repository. When that checkout was
// not present the reads threw, the whole file failed, and the failure was absorbed into
// the suite's known-failing count — so the only coverage of "does a reviewer correction
// survive into later stages" sat dark indefinitely.
//
// A fixture that lives outside the repository cannot be relied on, and a fixture that
// has moved should say so by name rather than by a stack trace. This asserts both
// properties for every literal fixture path the tests reference.

const REPO_ROOT = path.resolve(__dirname, '..');
const TEST_DIR = __dirname;

// Matches a resolve/join against __dirname whose segments are all string literals. A call
// with a variable segment is skipped: it cannot be checked statically, and the loop that
// builds it is the test's own business.
const PATH_CALL = /path\.(?:resolve|join)\(\s*__dirname\s*,\s*([^)]*)\)/g;
const ALL_LITERAL = /^(?:\s*'[^']*'\s*,)*\s*'[^']*'\s*$/;

function fixturePathsIn(source) {
  const found = [];
  for (const match of source.matchAll(PATH_CALL)) {
    const args = match[1];
    if (!ALL_LITERAL.test(args)) continue;
    const segments = [...args.matchAll(/'([^']*)'/g)].map((segment) => segment[1]);
    if (!segments.length) continue;
    found.push({ segments, resolved: path.resolve(TEST_DIR, ...segments) });
  }
  return found;
}

// This file's own sample strings are deliberate examples, not fixtures to check.
const SELF = path.basename(__filename);
const testFiles = fs.readdirSync(TEST_DIR)
  .filter((name) => name.endsWith('.test.js') && name !== SELF)
  .sort();

test('every test fixture path resolves inside the repository', () => {
  const escapes = [];
  for (const file of testFiles) {
    const source = fs.readFileSync(path.join(TEST_DIR, file), 'utf8');
    for (const { segments, resolved } of fixturePathsIn(source)) {
      const inside = resolved === REPO_ROOT || resolved.startsWith(`${REPO_ROOT}${path.sep}`);
      if (!inside) escapes.push(`${file}: path.resolve(__dirname, ${segments.map((s) => `'${s}'`).join(', ')}) -> ${resolved}`);
    }
  }
  assert.deepEqual(escapes, [], `test fixtures must live in the repository, not a sibling checkout:\n${escapes.join('\n')}`);
});

test('every test fixture path exists', () => {
  const missing = [];
  for (const file of testFiles) {
    const source = fs.readFileSync(path.join(TEST_DIR, file), 'utf8');
    for (const { segments, resolved } of fixturePathsIn(source)) {
      if (!fs.existsSync(resolved)) missing.push(`${file}: ${segments.join(' / ')} -> ${resolved}`);
    }
  }
  assert.deepEqual(missing, [], `referenced test fixtures are missing:\n${missing.join('\n')}`);
});

test('the fixture path scanner recognises the shapes the tests actually use', () => {
  // Guards the guard: if the regex stops matching, both tests above silently pass on an
  // empty set, which is exactly the kind of quiet nothing this file exists to prevent.
  const sample = [
    "fs.readFileSync(path.resolve(__dirname, '../views/staged-meeting-minutes.html'), 'utf8')",
    "path.join(__dirname, '..', 'scripts', 'meeting-minutes-final-golden', '022_real_eakin_sw_minutes_pdf', 'transcript.txt')",
    "path.join(__dirname, '..', 'scripts', 'meeting-minutes-final-golden', name, 'transcript.txt')"
  ].join('\n');
  const found = fixturePathsIn(sample);
  assert.equal(found.length, 2, 'two literal calls match and the call with a variable segment is skipped');
  assert.equal(found[0].resolved, path.resolve(REPO_ROOT, 'views/staged-meeting-minutes.html'));

  const scanned = testFiles.reduce(
    (total, file) => total + fixturePathsIn(fs.readFileSync(path.join(TEST_DIR, file), 'utf8')).length,
    0
  );
  assert.ok(scanned >= 8, `expected the scanner to find fixture paths across the suite, found ${scanned}`);
});
