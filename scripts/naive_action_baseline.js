'use strict';

// The control the pipeline never had: just ask the model.
//
// Action recall sits at 29/102 and four separate interventions in the deterministic
// selection layer - publishing the weak band, corroborating the not_action veto, ablating
// every thread veto, and widening the commitment patterns - each recovered exactly zero
// ground-truth actions while adding rows that match nothing a human minuted. Before
// building anything more elaborate, the obvious question deserves a number: how well does
// a light clean plus one plain request to Trooper do on the same thirteen fixtures, scored
// by the same matcher?
//
// This is a measurement script, not a pipeline path. Nothing here is wired into the
// product. It exists so "are we overcomplicating this?" has an answer with evidence.
//
//   node scripts/naive_action_baseline.js            # all thirteen
//   node scripts/naive_action_baseline.js 01_abbott  # one fixture
//   node scripts/naive_action_baseline.js --raw      # skip the cleaning, send it as-is

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'scripts', 'staged-scorecard-fixtures');

// Same key discovery the scorecard uses, so both harnesses talk to the same endpoint.
if (!process.env.TROOPER_API_KEY) {
  for (const envPath of ['/srv/m365-agent-test/.env', path.resolve(__dirname, '..', '.env')]) {
    if (fs.existsSync(envPath)) {
      require('dotenv').config({ path: envPath, quiet: true });
      if (process.env.TROOPER_API_KEY) break;
    }
  }
}
const URL = process.env.TROOPER_CHAT_COMPLETIONS_URL || 'https://eu.router.trooper.ai/v1/chat/completions';
const MODEL = process.env.TROOPER_MODEL || 'gpt-4o-mini';

// Scored by the SAME functions as the live scorecard. A baseline measured with a friendlier
// matcher would prove nothing.
const { coverage, actionMatch, wordingFaultsAcross } = require('./staged_minutes_scorecard');

// Light cleaning only. The point of this experiment is to change as little as possible:
// drop the timestamp furniture Teams emits, merge a speaker's consecutive turns, and drop
// turns that carry no words. No filler vocabulary, no domain rules - anything cleverer
// would make this a second pipeline rather than a control.
function cleanTranscript(raw) {
  const lines = String(raw).split(/\r?\n/);
  const turns = [];
  const SPEAKER_LINE = /^([A-Z][A-Za-z'’.,\- ]{1,40}?)\s+(\d{1,2}:\d{2})(.*)$/;
  let current = null;
  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;
    if (/^\d+ \w+ \d{4},/.test(text) || /^\d+m \d+s$/.test(text) || /started transcription$/.test(text)) continue;
    const match = text.match(SPEAKER_LINE);
    if (match) {
      const speaker = match[1].replace(/,\s*$/, '').trim();
      const rest = match[3].trim();
      if (current && current.speaker === speaker) {
        if (rest) current.parts.push(rest);
      } else {
        current = { speaker, parts: rest ? [rest] : [] };
        turns.push(current);
      }
    } else if (current) {
      current.parts.push(text);
    }
  }
  return turns
    .map((turn) => `${turn.speaker}: ${turn.parts.join(' ').replace(/\s+/g, ' ').trim()}`)
    .filter((line) => line.split(': ')[1])
    .join('\n');
}

const PROMPT = [
  'From this meeting transcript, pull out the actions.',
  'An action is a task somebody is expected to carry out after the meeting.',
  'Give the owner where the transcript makes it clear who is responsible, and "Not stated" where it does not.',
  'Write each action as a short instruction in third-person minutes English. Invent nothing.',
  'Return JSON only as {"actions":[{"owner":"...","action":"..."}]}.'
].join('\n');

async function askTrooper(transcript) {
  const response = await fetch(URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.TROOPER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: 'You extract action items from meeting transcripts. Return valid JSON only.' },
        { role: 'user', content: `${PROMPT}\n\nTRANSCRIPT:\n${transcript}` }
      ],
      temperature: 0.1,
      max_tokens: 2000,
      response_format: { type: 'json_object' }
    })
  });
  if (!response.ok) throw new Error(`http_${response.status}`);
  const body = await response.json();
  const content = body?.choices?.[0]?.message?.content;
  const output = typeof content === 'object' ? content : JSON.parse(String(content || '{}'));
  return Array.isArray(output?.actions) ? output.actions : [];
}

async function main() {
  if (!process.env.TROOPER_API_KEY) {
    console.error('TROOPER_API_KEY is not configured - this harness needs a live key.');
    process.exitCode = 2;
    return;
  }
  const raw = process.argv.includes('--raw');
  const only = process.argv.find((arg, index) => index >= 2 && !arg.startsWith('--'));
  const fixtures = fs.readdirSync(FIXTURE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !only || name.includes(only))
    .sort();

  const scores = [];
  for (const name of fixtures) {
    const dir = path.join(FIXTURE_ROOT, name);
    const transcriptPath = path.join(dir, 'transcript.txt');
    if (!fs.existsSync(transcriptPath)) continue;
    const original = fs.readFileSync(transcriptPath, 'utf8');
    const sent = raw ? original : cleanTranscript(original);
    const expected = (JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8')).expected || {}).actions || [];

    process.stderr.write(`asking ${name} (${original.length} -> ${sent.length} chars)...\n`);
    let actions = [];
    let error = '';
    try {
      actions = await askTrooper(sent);
    } catch (failure) {
      error = failure.message;
    }
    const recall = coverage(expected, actions, actionMatch);
    const precision = coverage(actions, expected, (generated, exp) => actionMatch(exp, generated));
    const wording = wordingFaultsAcross(actions.map((item) => item.action));
    scores.push({ name, originalChars: original.length, sentChars: sent.length, expected: expected.length, produced: actions.length, recall, precision, wording, actions, error });
  }

  console.log('\nnaive baseline: light clean + one "pull out the actions" call');
  console.log('\nfixture'.padEnd(36), 'chars', 'sent', 'exp', 'got', 'recall', 'prec', 'wording');
  const totals = { rm: 0, rt: 0, pm: 0, pt: 0, wf: 0, wc: 0 };
  for (const score of scores) {
    totals.rm += score.recall.matched; totals.rt += score.recall.total;
    totals.pm += score.precision.matched; totals.pt += score.precision.total;
    totals.wf += score.wording.flagged; totals.wc += score.wording.checked;
    console.log(
      score.name.padEnd(36),
      String(score.originalChars).padStart(5),
      String(score.sentChars).padStart(5),
      String(score.expected).padStart(3),
      String(score.produced).padStart(3),
      `${score.recall.matched}/${score.recall.total}`.padStart(6),
      `${score.precision.matched}/${score.precision.total}`.padStart(5),
      `${score.wording.flagged}/${score.wording.checked}`.padStart(7),
      score.error ? ` ERROR ${score.error}` : ''
    );
  }
  console.log('\ntotals');
  console.log(`  action recall    : ${totals.rm}/${totals.rt}`);
  console.log(`  action precision : ${totals.pm}/${totals.pt}`);
  console.log(`  broken wording   : ${totals.wf}/${totals.wc}`);
  console.log(`  characters sent  : ${scores.reduce((sum, s) => sum + s.sentChars, 0)} (from ${scores.reduce((sum, s) => sum + s.originalChars, 0)})`);
  console.log('\n  live pipeline for comparison: recall 29/102, precision 30/67, wording 3/413');

  const dump = process.env.BASELINE_DUMP;
  if (dump) {
    fs.writeFileSync(dump, `${JSON.stringify(scores, null, 2)}\n`);
    console.log(`\nfull output written to ${dump}`);
  }
}

module.exports = { cleanTranscript, PROMPT };

if (require.main === module) {
  main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
}
