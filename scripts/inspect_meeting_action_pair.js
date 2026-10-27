#!/usr/bin/env node
'use strict';
// Local saved JSON only. No production DB credentials, API endpoints or web route.
const fs = require('node:fs');
async function main(args) {
  if (args.length !== 3 || !/^\d+$/.test(args[1]) || !/^\d+$/.test(args[2])) {
    throw Error('Usage: node scripts/inspect_meeting_action_pair.js <private-draft.json> <action-number> <action-number>');
  }
  const db = require('../utils/db');
  for (const [key, value] of Object.entries(db)) if (typeof value === 'function') db[key] = () => { throw Error('Inspection forbids database access.'); };
  const draft = JSON.parse(fs.readFileSync(args[0], 'utf8'));
  const localDedupe = require('../routes/api').stagedEvaluation.dedupeHybridActionRecords;
  const report = await require('../utils/meetingMinutesActionInspection').inspect(draft, args.slice(1).map(Number), { localDedupe });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
