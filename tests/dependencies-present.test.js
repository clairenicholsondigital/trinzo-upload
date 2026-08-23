'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Every declared dependency must actually be present.
//
// node_modules is committed to this repository, which means a dependency can be declared
// in package.json and absent from the tree - and that is not hypothetical: playwright was
// declared and missing, so the suite could not run from a fresh checkout until somebody
// diagnosed it and ran npm install. The failure arrived as an unrelated-looking module
// error, hours from its cause.
//
// This makes it arrive as itself, immediately, with the fix in the message. It does not
// decide whether committing node_modules is a good idea - that is a repo-shape decision
// with its own trade-offs - it only makes the current shape unable to lie.

const manifest = require('../package.json');

test('every dependency in package.json resolves from the committed tree', () => {
  const missing = [];
  for (const name of Object.keys(manifest.dependencies || {})) {
    try {
      require.resolve(name, { paths: [path.resolve(__dirname, '..')] });
    } catch {
      missing.push(name);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `declared dependencies missing from node_modules (run: npm install): ${missing.join(', ')}`
  );
});
