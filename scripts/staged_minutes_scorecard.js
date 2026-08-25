'use strict';

// Whether the staged pipeline is actually right, not just unchanged.
//
// Every other harness in this repo answers "did this change?" - it diffs today's output
// against yesterday's, which is exactly what a corpus needs to catch a regression, and
// exactly what it cannot do for a question like "are we finding the actions that were
// really there?" That question needs a right answer to compare against, and one has
// existed the whole time: each of these thirteen real meetings came with an expected.json
// a person wrote by reading the transcript - type, purpose, objectives, topics, discussion
// points and a full action list with owners. Nothing read them. Every judgement of
// wrongness this session has been a person re-running these same eleven transcripts by
// hand in a browser.
//
// This is not a pass/fail gate. Human-written minutes routinely name things the transcript
// itself does not state - an owner assigned from knowing who runs a workstream, a workstream
// carried forward from a standing agenda - and no amount of extraction recovers that. So
// every score here is reported as a fraction with its denominator, never collapsed into a
// single number, and the header exists to keep that distinction in view rather than let a
// scorecard quietly become the thing everyone stops reading closely.
//
// Run:    node scripts/staged_minutes_scorecard.js            all thirteen, live Trooper
//         node scripts/staged_minutes_scorecard.js 05          one fixture, by its number prefix
// Write:  node scripts/staged_minutes_scorecard.js --write     records today's scores for drift
//
// Needs a live TROOPER_API_KEY (self-loads /srv/m365-agent-test/.env, same as the other
// live harnesses) and CANONICAL_MINILM_DISK_CACHE set for anything faster than an hour cold.

const fs = require('fs');
const path = require('path');

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

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'scripts', 'staged-scorecard-fixtures');
const BASELINE_PATH = path.join(REPO_ROOT, 'tests', 'fixtures', 'staged-minutes-scorecard-baseline.json');

function isolateEvaluationFromDatabase() {
  const dbPath = require.resolve('../utils/db');
  const unavailable = async () => { throw new Error('Database access is unavailable inside the scorecard.'); };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: new Proxy({}, { get: () => unavailable }) };
}

// --- matching, deliberately the same shape as the content-token comparisons already
// trusted elsewhere in this pipeline (utils/minutesEnglish.js's contentSet), not a new
// similarity metric invented for this one script.
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'at', 'by', 'with', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'that', 'this', 'these', 'those', 'from', 'into', 'their', 'our', 'your', 'not', 'stated']);
const stem = (token) => token.toLowerCase().replace(/(?:ing|ed|es|s)$/, '');
function tokens(value) {
  return new Set((String(value || '').toLowerCase().match(/[a-z][a-z0-9'’-]{2,}/g) || [])
    .filter((token) => !STOP.has(token))
    .map(stem));
}
function overlap(a, b) {
  const setA = tokens(a);
  const setB = tokens(b);
  if (!setA.size || !setB.size) return 0;
  const shared = [...setA].filter((token) => setB.has(token)).length;
  return shared / Math.min(setA.size, setB.size);
}
const MATCH_THRESHOLD = 0.5;

// Coverage: how many expected items have a best-matching generated item over threshold.
// Reported as {matched, total, unmatched} - a fraction with its own numerator and
// denominator, never a lone percentage.
const NEAR_THRESHOLD = 0.3;

function coverage(expectedItems, generatedItems, matchFn) {
  const unmatched = [];
  const matched = [];
  let near = 0;
  for (const expected of expectedItems) {
    const best = generatedItems.reduce((max, generated) => Math.max(max, matchFn(expected, generated)), 0);
    if (best >= MATCH_THRESHOLD) matched.push(expected);
    else {
      // The matcher is lexical, and a real paraphrase - "Practise the opening and
      // handover from Priya to Tom" against "Confirm presenter handovers and roles" -
      // scores as a miss. The near tier separates "found but worded differently" from
      // "not found at all", so a coverage number can be read without re-deriving that
      // distinction by hand from the printed pairs. The headline metric stays the strict
      // one: near is context, not credit.
      if (best >= NEAR_THRESHOLD) near += 1;
      unmatched.push(expected);
    }
  }
  return { matched: matched.length, near, total: expectedItems.length, unmatched };
}

// --- semantic tier -----------------------------------------------------------------
//
// The strict matcher above is lexical, and the corpus-wide measurement (2026-08-25) showed
// how much that hides: at MiniLM similarity >= 0.6, discussion coverage moved 19/194 ->
// 53/194 and objectives 11/68 -> 20/68, while a cross-meeting control - every expected
// item scored against a DIFFERENT meeting's output, 373 pairs - fired zero times. So the
// tier is real signal, not a softer ruler. Two rules keep it honest: the strict number
// stays the headline (this tier can never be "tuned up" to make a regression disappear),
// and every semantic match is printed beside its similarity so the soft 0.60-0.65
// boundary band - which contains some same-topic-not-same-point echoes - stays auditable.
// 0.6 is the same threshold run_meeting_minutes_final_golden_eval.py already uses.
const SEM_THRESHOLD = 0.6;
const SEM_COLUMNS = ['objectives', 'topics', 'discussion', 'actionRecall'];

// One text form per item, shared by request building and pair printing. Action rows carry
// the owner so "Ravi order the hops" vs "Dan order the hops" are not the same sentence.
function semanticText(item) {
  if (item && typeof item === 'object') return `${item.owner ? `${item.owner} ` : ''}${item.action || ''}`.trim() || String(item);
  return String(item);
}

function semanticRequestsFrom(scores) {
  const requests = [];
  for (const score of scores) {
    for (const column of SEM_COLUMNS) {
      const block = score[column];
      if (!block || !block.unmatched?.length || !block.generated?.length) continue;
      requests.push({
        id: `${score.name}::${column}`,
        expected: block.unmatched.map(semanticText),
        candidates: block.generated.map(String)
      });
    }
  }
  return requests;
}

// Pure: annotates each column with { matched, pairs } for everything the bridge scored at
// or above the threshold. Strict fields are never touched - the tier is additive.
function applySemanticMatches(scores, results, threshold = SEM_THRESHOLD) {
  const byId = new Map((results || []).map((result) => [result.id, result]));
  for (const score of scores) {
    for (const column of SEM_COLUMNS) {
      const block = score[column];
      if (!block) continue;
      const result = byId.get(`${score.name}::${column}`);
      const pairs = [];
      if (result) {
        (result.best || []).forEach((best, index) => {
          if (best && best.sim >= threshold && best.index >= 0) {
            pairs.push({
              expected: semanticText(block.unmatched[index]),
              generated: String(block.generated[best.index]),
              sim: best.sim
            });
          }
        });
      }
      block.sem = { matched: pairs.length, pairs };
    }
  }
  return scores;
}

function runSemanticBridge(requests) {
  if (!requests.length) return { ok: true, results: [] };
  const { spawnSync } = require('child_process');
  const bridge = path.join(__dirname, 'semantic_pair_bridge.py');
  const run = spawnSync('python3', [bridge], {
    input: JSON.stringify({ requests }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 300000
  });
  if (run.status !== 0 || !run.stdout) return { ok: false, reason: (run.stderr || 'bridge produced no output').trim().slice(-300) };
  try {
    return JSON.parse(run.stdout.trim().split('\n').pop());
  } catch (error) {
    return { ok: false, reason: `unparseable bridge output: ${error.message}` };
  }
}

function actionMatch(expected, generated) {
  // An owner-blank action is not a mismatch: the unassigned-actions work deliberately
  // publishes real work without guessing who it belongs to, and the scorer must not
  // punish that honesty twice.
  const ownerMatch = !expected.owner || overlap(expected.owner, generated.owner || '') >= 0.5
    || (generated.owner || '').toLowerCase() === 'not stated';
  const textOverlap = overlap(expected.action, generated.action || generated.humanFinal || '');
  // A wrong owner is a real cost even when the words are right - the reviewer has to
  // notice and correct it - so it is scored below MATCH_THRESHOLD even on a perfect text
  // match, rather than sitting exactly on the boundary.
  return ownerMatch ? textOverlap : textOverlap * 0.4;
}

// --- wording, reusing the shared detectors rather than re-deciding what "broken" means.
function wordingFaultsAcross(fields) {
  const { minutesEnglishFaults } = require('../utils/minutesEnglish');
  const counts = {};
  let checked = 0;
  let flagged = 0;
  for (const text of fields) {
    if (!text) continue;
    checked += 1;
    const faults = minutesEnglishFaults(text);
    if (faults.length) flagged += 1;
    for (const fault of faults) counts[fault.code] = (counts[fault.code] || 0) + 1;
  }
  return { checked, flagged, counts };
}

function loadFixtures(only) {
  return fs.readdirSync(FIXTURE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !only || name.startsWith(only) || name.includes(only))
    .sort();
}

async function scoreFixture(name) {
  isolateEvaluationFromDatabase();
  const api = require('../routes/api').stagedEvaluation;
  const dir = path.join(FIXTURE_ROOT, name);
  const text = fs.readFileSync(path.join(dir, 'transcript.txt'), 'utf8');
  const expectedRaw = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));
  const expected = expectedRaw.expected || expectedRaw;

  const details = api.extractStagedDetailsFromTranscript(text, name).screens?.details || {};
  const summaryResult = await api.canonicalStagedResponse('summary', { text, fileName: name, source: 'file' }, { confirmedDetails: details });
  const summary = summaryResult.screens?.summary || {};
  const confirmedSummary = {
    meetingPurpose: summary.meetingPurpose,
    objectives: summary.objectives || [],
    executiveSummary: summary.executiveSummary,
    overallTopics: summary.overallTopics || [],
    topicRefs: (summary.topicRefs || []).map((ref) => ({ text: ref.text, topicId: ref.topicId, evidenceIds: ref.evidenceIds }))
  };
  const discussionResult = await api.canonicalStagedResponse('discussion', { text, fileName: name, source: 'file' }, { confirmedDetails: details, confirmedSummary });
  const discussion = discussionResult.screens?.discussion || [];
  const actionsResult = await api.canonicalStagedResponse('actions', { text, fileName: name, source: 'file' }, { confirmedDetails: details, confirmedSummary });
  const actions = actionsResult.screens?.actions || [];

  const generatedDiscussionText = discussion.flatMap((card) => (card.points || []).map((point) => (typeof point === 'string' ? point : point?.text)));

  const typeMatch = overlap(expected.meetingType, details.meetingType) >= 0.34;
  const purposeOverlap = overlap(expected.meetingPurpose, summary.meetingPurpose);
  const objectiveCoverage = coverage(expected.meetingObjectives || [], summary.objectives || [], overlap);
  const topicCoverage = coverage(expected.overallTopicsDiscussed || [], summary.overallTopics || [], overlap);
  const discussionCoverage = coverage(expected.discussion || [], generatedDiscussionText, overlap);
  discussionCoverage.generated = generatedDiscussionText;
  objectiveCoverage.generated = summary.objectives || [];
  topicCoverage.generated = summary.overallTopics || [];
  const actionCoverage = coverage(expected.actions || [], actions, actionMatch);
  actionCoverage.generated = actions.map((item) => `${item.owner || 'Not stated'} :: ${item.action}`);
  // Precision the other way: how many published actions correspond to something a human
  // actually minuted, versus how many are the tool's own invention or noise.
  const actionPrecision = coverage(actions, expected.actions || [], (generated, exp) => actionMatch(exp, generated));

  const wording = wordingFaultsAcross([
    summary.meetingPurpose,
    summary.executiveSummary,
    ...(summary.objectives || []),
    ...(summary.overallTopics || []),
    ...generatedDiscussionText,
    ...actions.map((item) => item.action)
  ]);

  return {
    name,
    typeMatch,
    expectedType: expected.meetingType,
    generatedType: details.meetingType,
    purposeOverlap: Number(purposeOverlap.toFixed(2)),
    objectives: objectiveCoverage,
    topics: topicCoverage,
    discussion: discussionCoverage,
    actionRecall: actionCoverage,
    actionPrecision: { matched: actionPrecision.matched, total: actionPrecision.total },
    wording
  };
}

function printReport(scores) {
  console.log('\nfixture'.padEnd(38), 'type', 'purpose', 'obj', 'topics', 'disc', 'actR', 'actP', 'wording');
  const totals = { objM: 0, objT: 0, topM: 0, topT: 0, discM: 0, discT: 0, actM: 0, actT: 0, actPM: 0, actPT: 0, wordFlagged: 0, wordChecked: 0 };
  for (const s of scores) {
    const frac = (c) => `${c.matched}/${c.total}${c.near ? `+${c.near}n` : ''}`;
    console.log(
      s.name.padEnd(38),
      (s.typeMatch ? 'ok  ' : 'DIFF'),
      String(s.purposeOverlap).padEnd(8),
      frac(s.objectives).padEnd(6),
      frac(s.topics).padEnd(7),
      frac(s.discussion).padEnd(5),
      frac(s.actionRecall).padEnd(5),
      `${s.actionPrecision.matched}/${s.actionPrecision.total}`.padEnd(5),
      `${s.wording.flagged}/${s.wording.checked}`
    );
    totals.objM += s.objectives.matched; totals.objT += s.objectives.total;
    totals.topM += s.topics.matched; totals.topT += s.topics.total;
    totals.discM += s.discussion.matched; totals.discT += s.discussion.total;
    totals.actM += s.actionRecall.matched; totals.actT += s.actionRecall.total;
    totals.actPM += s.actionPrecision.matched; totals.actPT += s.actionPrecision.total;
    totals.wordFlagged += s.wording.flagged; totals.wordChecked += s.wording.checked;
  }
  const semRan = scores.some((s) => SEM_COLUMNS.some((column) => s[column]?.sem));
  const semOf = (column) => scores.reduce((sum, s2) => sum + (s2[column]?.sem?.matched || 0), 0);
  const withSem = (strictMatched, total, column) => (semRan ? `  |  ${strictMatched + semOf(column)}/${total} with semantic tier` : '');
  console.log('\ntotals');
  console.log(`  type match          : ${scores.filter((s) => s.typeMatch).length}/${scores.length}`);
  console.log(`  objective coverage  : ${totals.objM}/${totals.objT}${withSem(totals.objM, totals.objT, 'objectives')}  (+${scores.reduce((sum, s2) => sum + (s2.objectives.near || 0), 0)} near - found but worded differently)`);
  console.log(`  topic coverage      : ${totals.topM}/${totals.topT}${withSem(totals.topM, totals.topT, 'topics')}`);
  console.log(`  discussion coverage : ${totals.discM}/${totals.discT}${withSem(totals.discM, totals.discT, 'discussion')}`);
  console.log(`  action recall       : ${totals.actM}/${totals.actT}${withSem(totals.actM, totals.actT, 'actionRecall')}  (of what a human minuted, how much did we find)`);
  console.log(`  action precision    : ${totals.actPM}/${totals.actPT}  (of what we published, how much corresponds to something real)`);
  const wordCounts = {};
  for (const s of scores) for (const [code, count] of Object.entries(s.wording.counts)) wordCounts[code] = (wordCounts[code] || 0) + count;
  console.log(`  broken wording      : ${totals.wordFlagged}/${totals.wordChecked} generated strings flagged`);
  for (const [code, count] of Object.entries(wordCounts).sort((a, b) => b[1] - a[1])) console.log(`      ${String(count).padStart(3)}  ${code}`);
  // A fraction alone can hide what actually happened, which is the failure this whole
  // scorecard exists to stop: the matcher below is lexical token overlap, not meaning, so
  // a real paraphrase - "Confirm presenter handovers and roles" for "Practise the opening
  // and handover from Priya to Tom" - scores as a miss even when a person reading both
  // would call it a hit. That makes the coverage numbers a conservative lower bound, and
  // it is exactly why every "unmatched" item below is printed next to what was actually
  // generated: read the two lists, not the fraction.
  const section = (label, key) => {
    console.log(`\nunmatched ${label} (what was expected, and what was generated instead):`);
    for (const s of scores) {
      if (!s[key].unmatched.length) continue;
      console.log(`  ${s.name}:`);
      const semPairs = new Map((s[key].sem?.pairs || []).map((pair) => [pair.expected, pair]));
      for (const item of s[key].unmatched) {
        const pair = semPairs.get(semanticText(item));
        if (pair) console.log(`      sem ${pair.sim.toFixed(2)} :: ${pair.expected.slice(0, 70)}  <=>  ${pair.generated.slice(0, 70)}`);
        else console.log(`      missing :: ${String(item.action || item).slice(0, 88)}`);
      }
      if (s[key].generated?.length) console.log(`      generated had: ${s[key].generated.map((g) => String(g).slice(0, 50)).join(' | ')}`);
    }
  };
  section('objectives', 'objectives');
  section('topics', 'topics');
  section('discussion points', 'discussion');
  section('actions', 'actionRecall');
}

module.exports = { overlap, coverage, actionMatch, wordingFaultsAcross, MATCH_THRESHOLD, SEM_THRESHOLD, semanticText, semanticRequestsFrom, applySemanticMatches };

async function main() {
  const write = process.argv.includes('--write');
  const onlyArg = process.argv.find((arg, index) => index >= 2 && !arg.startsWith('--'));
  const fixtures = loadFixtures(onlyArg);
  if (!fixtures.length) { console.error('no fixtures matched'); process.exitCode = 2; return; }
  const scores = [];
  for (const name of fixtures) {
    process.stderr.write(`scoring ${name}...\n`);
    scores.push(await scoreFixture(name));
  }
  // Semantic tier: one bridge call for the whole corpus (~15s, dominated by model load).
  // SCORECARD_NO_SEM=1 skips it; an unavailable backend degrades to the strict-only report.
  if (!process.env.SCORECARD_NO_SEM) {
    process.stderr.write('scoring unmatched pairs semantically...\n');
    const bridge = runSemanticBridge(semanticRequestsFrom(scores));
    if (bridge.ok) applySemanticMatches(scores, bridge.results);
    else console.log(`\nsemantic tier unavailable (strict-only report): ${bridge.reason}`);
  }
  printReport(scores);
  // Full, untruncated pairs for offline analysis - the printed report clips generated
  // lists for readability, which is right for a human and useless for feeding the pairs
  // to a semantic matcher or a judge. SCORECARD_DUMP names a file; absent, nothing extra.
  if (process.env.SCORECARD_DUMP) {
    fs.writeFileSync(process.env.SCORECARD_DUMP, `${JSON.stringify(scores, null, 2)}\n`);
    console.log(`\nfull pairs dumped to ${process.env.SCORECARD_DUMP}`);
  }
  if (write) {
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify({ scoredAt: new Date().toISOString().slice(0, 10), scores }, null, 2)}\n`);
    console.log(`\nwrote ${scores.length} scores to ${path.relative(REPO_ROOT, BASELINE_PATH)}`);
  }
}

if (require.main === module) {
  main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
}
