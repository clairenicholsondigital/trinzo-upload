'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const outputFiles = [
  path.join(root, 'public', 'meeting-agent.js'),
  path.join(root, 'public', 'meeting-agent-auth-redirect.js')
];

async function main() {
  await esbuild.build({
    absWorkingDir: root,
    entryPoints: ['client/meeting-agent.js', 'client/meeting-agent-auth-redirect.js'],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2022'],
    minify: true,
    outdir: 'public'
  });
  await Promise.all(outputFiles.map((file) => fs.chmod(file, 0o644)));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
