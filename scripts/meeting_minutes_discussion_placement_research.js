'use strict';

const fs = require('node:fs');
const { nominateDiscussionPlacement } = require('../utils/canonicalMinutes/discussionPlacementNomination');
const args = process.argv.slice(2);
const input = args[args.indexOf('--input') + 1], output = args[args.indexOf('--output') + 1];
if (!args.includes('--input') || !args.includes('--output') || !input || !output) {
  throw Error('Usage: node scripts/meeting_minutes_discussion_placement_research.js --input saved-draft.json --output new-report.json');
}
const packet = nominateDiscussionPlacement(JSON.parse(fs.readFileSync(input, 'utf8')));
fs.writeFileSync(output, JSON.stringify(packet, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ mode: packet.mode, nominations: packet.nominations.length,
  providerCalls: 0, libraryWrites: 0, draftWrites: 0 }));
