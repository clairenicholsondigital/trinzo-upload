'use strict';

// Where the meeting purpose comes from, across the transcript corpus.
//
// The purpose at the top of the minutes is chosen by a ladder in buildPurpose: a purpose
// somebody stated, else a meeting-type profile's canned prose, else the meeting title,
// else a description of what was covered. Which rung a meeting lands on decides whether
// the reader gets the meeting's own words, a sentence about a different kind of meeting,
// or a label they can already see two rows above.
//
// Nothing measured this. The topic-label sweep cannot: it calls runCanonicalLiveStage with
// `confirmed: {}`, so buildConfirmedState sets meeting.title and meeting.type to '' and
// neither purposeFromTitle nor purposePlan can fire. The whole corpus runs through a code
// path where the title does not exist.
//
// Two passes, deliberately separate:
//
//   details  - the meeting type and title only. No MiniLM, about two seconds, and it is
//              what answers the sharpest question: is a meeting being told it is a webinar
//              rehearsal because the phrase "run through" appears in its body?
//   summary  - the purpose itself, which needs the summary stage and therefore MiniLM.
//
// Capture:  node scripts/purpose_source_baseline.js --write
// Compare:  node scripts/purpose_source_baseline.js
// Fast:     node scripts/purpose_source_baseline.js --details-only
//
// Set CANONICAL_MINILM_DISK_CACHE to a directory to keep the profiles between runs; the
// full pass drops from about fifty minutes to seven.

const fs = require('fs');
const path = require('path');
const { listTranscripts, readTranscript } = require('./evidence_parse_baseline');

const REPO_ROOT = path.resolve(__dirname, '..');
const BASELINE_PATH = path.join(REPO_ROOT, 'tests', 'fixtures', 'purpose-source-baseline.json');

// The harness must not reach the database, the same way the production replay does not.
function isolateEvaluationFromDatabase() {
  const dbPath = require.resolve('../utils/db');
  const unavailable = async () => {
    throw new Error('Database access is unavailable inside the purpose baseline harness.');
  };
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: new Proxy({}, { get: () => unavailable })
  };
}

// Real meetings and invented ones answer different questions, so they are never averaged.
// A title in scripts/transcript-tests is often the fixture's own slug; measuring title
// quality there is evidence about the fixtures, not about what clients send us.
const REAL_TRANSCRIPT = /(?:meeting-minutes-final-golden\/02[1-7]_real_|human_benchmarks\/)/;

function corpusOf(file) {
  return REAL_TRANSCRIPT.test(file) ? 'real' : 'synthetic';
}

async function collectDetails() {
  isolateEvaluationFromDatabase();
  const api = require('../routes/api').stagedEvaluation;
  const rows = [];
  for (const file of listTranscripts()) {
    const text = String(await readTranscript(file));
    const fileName = path.basename(file);
    const details = api.extractStagedDetailsFromTranscript(text, fileName).screens?.details || {};
    // Would this meeting still be called a webinar rehearsal if we could only see the
    // title? The title has to be held constant to ask that - it is itself extracted from
    // the text, so blanking the body blanks the title too and everything looks
    // body-derived.
    const title = details.meetingTitle || '';
    const fromTitleOnly = api.inferStagedMeetingType('', fileName, title);
    const suggestion = details.meetingTypeSuggestion;
    rows.push({
      file,
      corpus: corpusOf(file),
      title,
      type: details.meetingType || '',
      // A type that differs from the title-only answer is a failure ONLY when it carries
      // no qualifying evidence trail. The gated suggestion is the sanctioned exception -
      // same rewording as the corpus invariant test - and is reported separately so a
      // human still eyeballs every one it fires on.
      typeFromBodyOnly: Boolean(details.meetingType) && details.meetingType !== fromTitleOnly && !(suggestion && suggestion.accepted),
      typeSuggested: Boolean(suggestion && suggestion.accepted),
      suggestionMargin: suggestion && suggestion.accepted ? suggestion.marginRatio : null,
      typeFromTitle: fromTitleOnly
    });
  }
  return rows;
}

async function collectPurposes(detailRows) {
  const { runCanonicalLiveStage } = require('../utils/canonicalMinutes/liveStages');
  const { namesARecurringSubject } = require('../utils/canonicalMinutes/statedPurpose');
  const { prepareEvidence } = require('../utils/canonicalMinutes/evidence');
  const byFile = new Map(detailRows.map((row) => [row.file, row]));
  const rows = [];
  for (const file of listTranscripts()) {
    const text = String(await readTranscript(file));
    const details = byFile.get(file) || {};
    let row;
    try {
      // The live stage, not canonicalStagedResponse: that one calls the LLM polish, which
      // is a network round trip and non-deterministic, and a baseline built on it could
      // not be compared with itself.
      const result = runCanonicalLiveStage(text, {
        stage: 'summary',
        fileName: path.basename(file),
        confirmed: { details: { meetingTitle: details.title, meetingType: details.type } }
      });
      const screen = result.screens.summary || {};
      const purpose = screen.initialUnderstanding?.meetingPurpose || {};
      const text2 = String(screen.meetingPurpose || '');
      const events = prepareEvidence(text).events;
      row = {
        file,
        corpus: details.corpus,
        purposeSource: purpose.purposeSource || 'unknown',
        purposeText: text2,
        words: text2.split(/\s+/).filter(Boolean).length,
        evidenceIdCount: Array.isArray(purpose.evidenceIds) ? purpose.evidenceIds.length : 0,
        // The purpose names something the meeting comes back to, rather than a phrase that
        // appears once. The same test the stated-purpose detector uses on itself.
        namesSubject: text2 ? namesARecurringSubject(text2, events, null) : false,
        isBareTitle: Boolean(details.title) && text2.replace(/\.$/, '') === details.title,
        flagged: (result.validationFlags || []).some((flag) => flag?.type === 'meeting_purpose_inferred')
      };
    } catch (error) {
      row = { file, corpus: details.corpus, purposeSource: 'error', purposeText: String(error && error.message || error) };
    }
    rows.push(row);
  }
  return rows;
}

function report(details, purposes) {
  const bodyOnly = details.filter((row) => row.typeFromBodyOnly);
  console.log('');
  console.log(`transcripts                                   : ${details.length}`);
  console.log(`M1  ungated body-derived types                : ${bodyOnly.length}   (target 0)`);
  const suggested = details.filter((row) => row.typeSuggested);
  console.log(`    gated suggestions fired (eyeball these)   : ${suggested.length}`);
  for (const row of suggested) console.log(`      ${row.type.padEnd(26)} margin ${String(row.suggestionMargin).padEnd(5)} ${row.title.slice(0, 40).padEnd(40)} ${row.file.split('/').slice(-2)[0]}`);
  for (const row of bodyOnly) console.log(`      ${row.type.padEnd(26)} would be ${String(row.typeFromTitle).padEnd(26)} ${row.title.slice(0, 34).padEnd(34)} ${row.file.split('/').slice(-2)[0]}`);

  if (!purposes.length) return bodyOnly.length;

  const unflagged = purposes.filter((row) => row.purposeSource !== 'stated_in_meeting' && row.purposeSource !== 'error' && !row.flagged);
  console.log(`M2  non-stated purposes shipping unflagged    : ${unflagged.length}   (target 0)`);

  const named = purposes.filter((row) => row.namesSubject).length;
  console.log(`M3  purposes naming a recurring subject       : ${named}/${purposes.length}`);

  console.log('M4  purpose source distribution');
  for (const corpus of ['real', 'synthetic']) {
    const slice = purposes.filter((row) => row.corpus === corpus);
    if (!slice.length) continue;
    const counts = slice.reduce((all, row) => ({ ...all, [row.purposeSource]: (all[row.purposeSource] || 0) + 1 }), {});
    const bare = slice.filter((row) => row.isBareTitle).length;
    console.log(`      ${corpus.padEnd(10)} n=${String(slice.length).padEnd(4)} ${JSON.stringify(counts)}  bare-title=${bare}`);
  }
  // Never one number: the title count rises when a false profile purpose is corrected into
  // an honest title, and read alone that looks like a regression.
  console.log('      (read the distribution, not the title count on its own)');

  const longest = [...purposes].sort((left, right) => (right.words || 0) - (left.words || 0))[0];
  if (longest) console.log(`      longest purpose: ${longest.words} words  ${longest.file.split('/').slice(-2)[0]}`);
  return bodyOnly.length + unflagged.length;
}

function diffAgainstBaseline(current) {
  if (!fs.existsSync(BASELINE_PATH)) {
    console.log(`\nno baseline at ${path.relative(REPO_ROOT, BASELINE_PATH)} - capture one with --write`);
    return;
  }
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  const before = new Map((baseline.purposes || []).map((row) => [row.file, row]));
  const moved = [];
  for (const row of current.purposes || []) {
    const was = before.get(row.file);
    if (!was) { moved.push(['added  ', row.file, '', row.purposeSource]); continue; }
    if (was.purposeSource !== row.purposeSource) moved.push(['moved  ', row.file, was.purposeSource, row.purposeSource]);
    else if (was.purposeText !== row.purposeText) moved.push(['reworded', row.file, was.purposeSource, row.purposeSource]);
  }
  console.log(`\nchanged against baseline: ${moved.length}`);
  for (const [kind, file, was, now] of moved.slice(0, 40)) {
    console.log(`  ${kind} ${file.split('/').slice(-2)[0].padEnd(38)} ${was ? `${was} -> ` : ''}${now}`);
  }
  if (moved.length > 40) console.log(`  ... and ${moved.length - 40} more`);
}

async function main() {
  const write = process.argv.includes('--write');
  const detailsOnly = process.argv.includes('--details-only');
  const details = await collectDetails();
  const purposes = detailsOnly ? [] : await collectPurposes(details);
  const failures = report(details, purposes);
  const payload = { details, purposes };
  if (write) {
    if (detailsOnly) {
      console.log('\nrefusing to write a baseline from a details-only run');
      process.exitCode = 2;
      return;
    }
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`\nwrote ${path.relative(REPO_ROOT, BASELINE_PATH)}: ${purposes.length} rows`);
    return;
  }
  if (!detailsOnly) diffAgainstBaseline(payload);
  process.exitCode = failures ? 1 : 0;
}

if (require.main === module) main();

module.exports = { collectDetails, corpusOf, BASELINE_PATH };
