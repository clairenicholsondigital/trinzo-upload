'use strict';

const fs = require('fs');
const path = require('path');
const { runCanonicalNoEditPass } = require('../utils/canonicalMinutes/runner');

const packDirectory = path.resolve(__dirname, 'meeting-minutes-final-golden');
const outputDirectory = path.resolve(process.argv[2] || '/tmp/canonical-final-golden');
const strategy = process.argv[3] || 'semantic_v2';
fs.mkdirSync(outputDirectory, { recursive: true });

const cases = fs.readdirSync(packDirectory).filter((name) => /^\d{3}_/.test(name)).sort();
for (const [index, caseName] of cases.entries()) {
  const transcript = fs.readFileSync(path.join(packDirectory, caseName, 'transcript.txt'), 'utf8');
  const result = runCanonicalNoEditPass(transcript, { fileName: `${caseName}.txt`, strategy });
  fs.writeFileSync(path.join(outputDirectory, `${caseName}.json`), `${JSON.stringify(result, null, 2)}\n`);
  process.stderr.write(`[${index + 1}/${cases.length}] ${caseName}: ${result.visibleOutput.actions.length} actions, ${result.visibleOutput.decisions.length} decisions, ${result.metrics.topicClusterCount} topics\n`);
}
