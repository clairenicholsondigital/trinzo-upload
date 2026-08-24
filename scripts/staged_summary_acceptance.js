'use strict';

// The two real meetings this work was built against, run through the FULL pipeline -
// Trooper included - and printed for a human to judge against the reviewer's own
// exemplar summaries. Not part of npm test: this calls a live LLM and its output is
// judged by eye, which is the honest shape of the acceptance ("give the human SOMETHING
// with relatively little effort").
//
//   node scripts/staged_summary_acceptance.js            both fixtures
//   node scripts/staged_summary_acceptance.js m204       one of them
//
// Run it before deploying any change to the summary stage, from a machine with
// TROOPER_API_KEY configured (the live tree has it in .env). Watch timingMs: the
// evidence pack rides one call, and if p95 breaches the 30s budget the pack shrinks,
// never the contract.

const fs = require('fs');
const path = require('path');

// Self-sufficient about its environment: this script exists to be run before deploys,
// and a run that silently used no API key prints the deterministic floor while looking
// like the real thing - reason=unavailable in the telemetry line is the tell. Load the
// live tree's env when the key is absent, and default the Trooper URL the way the
// server does.
if (!process.env.TROOPER_API_KEY) {
  for (const envPath of ['/srv/m365-agent-test/.env', path.resolve(__dirname, '..', '.env')]) {
    if (fs.existsSync(envPath)) {
      require('dotenv').config({ path: envPath, quiet: true });
      if (process.env.TROOPER_API_KEY) break;
    }
  }
}
process.env.TROOPER_CHAT_COMPLETIONS_URL = process.env.TROOPER_CHAT_COMPLETIONS_URL
  || 'https://eu.router.trooper.ai/v1/chat/completions';

function isolateEvaluationFromDatabase() {
  const dbPath = require.resolve('../utils/db');
  const unavailable = async () => {
    throw new Error('Database access is unavailable inside the acceptance harness.');
  };
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: new Proxy({}, { get: () => unavailable })
  };
}

const FIXTURES = {
  m204: 'scripts/meeting-minutes-final-golden/028_real_m204_webinar_rehearsal_transcript/transcript.txt',
  t761: 'scripts/meeting-minutes-final-golden/029_real_t761_tech_file_weekly_transcript/transcript.txt',
  abbott: 'scripts/meeting-minutes-final-golden/027_real_abbott_audit_kickoff_transcript/transcript.txt',
  dita: 'scripts/meeting-minutes-final-golden/021_real_dita_importer_obligations_transcript/transcript.txt',
  // Deliberately unlike the client meetings, and the ones that exposed the summary
  // printing the transcript back at the reviewer. A fix that only reads well on regulatory
  // meetings is a fix shaped like those meetings.
  allotment: 'scripts/transcript-tests/074_allotment_society_committee/transcript.txt',
  pantomime: 'scripts/transcript-tests/075_pantomime_society_planning/transcript.txt',
  brewery: 'scripts/transcript-tests/076_brewery_production_numbers/transcript.txt',
  race: 'scripts/transcript-tests/077_race_committee_two_jos/transcript.txt',
  parking: 'scripts/transcript-tests/078_parking_no_decision_reached/transcript.txt'
};

async function main() {
  isolateEvaluationFromDatabase();
  const api = require('../routes/api').stagedEvaluation;
  const wanted = process.argv[2] ? [process.argv[2]] : Object.keys(FIXTURES);
  const { isRawTranscriptDiscussionPoint } = require('../utils/stagedEditorial');
  const rows = [];
  for (const key of wanted) {
    const file = FIXTURES[key];
    if (!file) { console.error(`unknown fixture "${key}" - use one of: ${Object.keys(FIXTURES).join(', ')}`); process.exitCode = 2; return; }
    const text = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
    const fileName = path.basename(path.dirname(file));
    const details = api.extractStagedDetailsFromTranscript(text, fileName).screens?.details || {};
    const startedAt = Date.now();
    const result = await api.canonicalStagedResponse('summary', { text, fileName, source: 'file' }, { confirmedDetails: details });
    const summary = result.screens.summary || {};
    const polish = result.telemetryPreview?.initialUnderstandingPolish || {};
    console.log(`\n=== ${key} ===`);
    console.log(`title    : ${details.meetingTitle}`);
    console.log(`type     : ${details.meetingType}${details.meetingTypeSuggestion?.accepted ? ` (suggested, margin ${details.meetingTypeSuggestion.marginRatio})` : ''}`);
    console.log(`purpose  : ${summary.meetingPurpose}`);
    console.log(`summary  : ${summary.executiveSummary}`);
    console.log(`topics   : ${(summary.overallTopics || []).join(' | ')}`);
    console.log('objectives:');
    for (const objective of summary.objectives || []) console.log(`  - ${objective}`);
    console.log(`polish   : used=${polish.used} cited=${polish.cited} reason=${polish.reason} timingMs=${polish.timingMs} totalMs=${Date.now() - startedAt}`);
    if (polish.fieldOutcomes) console.log(`outcomes : ${JSON.stringify(polish.fieldOutcomes)}`);
    const flags = (result.validationFlags || []).map((flag) => flag.type);
    console.log(`flags    : ${flags.join(', ') || 'none'}`);
    // The failure this harness exists to make visible: a rejected polish used to fall back
    // to purpose-plus-quoted-turns, so the reviewer read the meeting back at themselves.
    const sentences = String(summary.executiveSummary || '').split(/(?<=[.!?])\s+/).map((item) => item.trim()).filter(Boolean);
    const quoted = sentences.filter((item) => isRawTranscriptDiscussionPoint(item));
    if (quoted.length) console.log(`QUOTED SPEECH IN SUMMARY: ${JSON.stringify(quoted)}`);
    rows.push({ key, outcome: polish.fieldOutcomes?.summary || polish.reason, sentences: sentences.length, objectives: (summary.objectives || []).length, topics: (summary.overallTopics || []).length, namedTopics: polish.fieldOutcomes?.topics || null, quoted: quoted.length });
  }
  console.log('\n=== summary');
  console.log('meeting'.padEnd(12), 'polish'.padEnd(26), 'sent', 'obj', 'topics', 'named(ok/no)', 'quoted');
  for (const row of rows) {
    const named = row.namedTopics ? `${row.namedTopics.accepted}/${row.namedTopics.rejected}` : '-';
    console.log(row.key.padEnd(12), String(row.outcome).padEnd(26), String(row.sentences).padStart(4), String(row.objectives).padStart(3), String(row.topics).padStart(6), named.padStart(12), String(row.quoted).padStart(6));
  }
  console.log(`\naccepted: ${rows.filter((row) => row.outcome === 'accepted').length}/${rows.length} | summaries quoting the transcript: ${rows.filter((row) => row.quoted > 0).length} (must be 0)`);
  console.log('\njudge the output against the reviewer exemplars, not against the previous run.');
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
