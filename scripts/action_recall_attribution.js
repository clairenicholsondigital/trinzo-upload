'use strict';

// Which gate kills a real action?
//
// The scorecard says recall is 29/102. It does not say why. Every count between "a source
// proposed this row" and "the reviewer sees it" is computed inside actionsStage and then
// discarded, so "too conservative" has never been attributable to a specific gate - and a
// fix chosen without that attribution is a guess.
//
// This harness runs the deterministic actions path over the thirteen ground-truth fixtures
// with the ACTION_FUNNEL tap on, then asks, for each of the 102 actions a human minuted:
// did any population in the funnel ever contain it, and which was the LAST one that did?
// The gate immediately after that population is the one that killed it.
//
// Deterministic on purpose. The live scorecard swings +-5 run to run, which is wider than
// most of the effects we are trying to measure.
//
//   node scripts/action_recall_attribution.js            # the ranking
//   node scripts/action_recall_attribution.js --detail   # plus every lost action

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'scripts', 'staged-scorecard-fixtures');

// Same lexical overlap the scorecard matches with, so "found" means the same thing in both
// places and a number here can be compared with a number there.
const { overlap, MATCH_THRESHOLD } = require('./staged_minutes_scorecard');

// The funnel populations in the order the pipeline applies them. `lostTo` names the gate
// that removes an action present in this population but absent from the next one.
const STAGES = [
  { key: 'generated', label: 'proposed by a source', lostTo: 'never proposed - no source found it' },
  { key: 'afterFloor', label: 'survived the publishability floors', lostTo: 'underspecified / below floor / candidate band' },
  { key: 'published', label: 'published by the stage', lostTo: 'review-candidate noise or compound demotion' }
];

function textOf(item) {
  if (item && typeof item === 'object') return `${item.owner || ''} ${item.action || ''}`.trim();
  return String(item || '');
}

// An expected action counts as present in a population if any row in it clears the same
// bar the scorecard uses. Deliberately generous on owner: this asks whether the CONTENT
// survived the gate, not whether it was attributed correctly - owner attribution is a
// separate failure with a separate fix.
function presentIn(expectedText, rows) {
  return (rows || []).some((row) => overlap(expectedText, String(row).replace(/^[\d.]+\s+/, '')) >= MATCH_THRESHOLD);
}

// How much of the EXPECTED action's vocabulary the turn carries. Asymmetric on purpose -
// see the note at the call site about one-word turns scoring 1.00 under `overlap`.
function supportScore(expectedText, turnText) {
  const words = (value) => new Set(String(value).toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) || []);
  const want = words(expectedText);
  const have = words(turnText);
  if (!want.size || !have.size) return 0;
  let shared = 0;
  for (const token of want) if (have.has(token)) shared += 1;
  return shared / want.size;
}

function loadFixtures() {
  return fs.readdirSync(FIXTURE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(FIXTURE_ROOT, name, 'transcript.txt')))
    .sort();
}

function run() {
  const detail = process.argv.includes('--detail');
  const tapPath = path.join(os.tmpdir(), `action-funnel-${process.pid}.jsonl`);
  fs.writeFileSync(tapPath, '');
  process.env.ACTION_FUNNEL = tapPath;

  // Required after ACTION_FUNNEL is set: the tap is read at call time, but requiring the
  // stage first keeps the env assignment above honest for a reader.
  const { runCanonicalLiveStage } = require('../utils/canonicalMinutes/liveStages');

  const rows = [];
  for (const name of loadFixtures()) {
    const dir = path.join(FIXTURE_ROOT, name);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));
    const expected = (raw.expected || raw).actions || [];
    if (!expected.length) continue;

    const before = fs.readFileSync(tapPath, 'utf8').split('\n').filter(Boolean).length;
    try {
      runCanonicalLiveStage(fs.readFileSync(path.join(dir, 'transcript.txt'), 'utf8'), {
        stage: 'actions', fileName: name, confirmed: {}, includeEvidencePack: false
      });
    } catch (error) {
      console.error(`${name}: stage threw - ${error.message}`);
      continue;
    }
    const lines = fs.readFileSync(tapPath, 'utf8').split('\n').filter(Boolean);
    const funnel = lines[before] ? JSON.parse(lines[before]) : null;
    if (!funnel) {
      console.error(`${name}: no funnel record - the tap did not fire`);
      continue;
    }
    rows.push({ name, expected, funnel });
  }
  fs.rmSync(tapPath, { force: true });

  const lostAt = new Map(STAGES.map((stage) => [stage.lostTo, []]));
  let found = 0;
  let total = 0;

  for (const { name, expected, funnel } of rows) {
    for (const item of expected) {
      total += 1;
      const text = textOf(item);
      let lastPresent = -1;
      STAGES.forEach((stage, index) => { if (presentIn(text, funnel[stage.key])) lastPresent = index; });
      if (lastPresent === STAGES.length - 1) { found += 1; continue; }
      const gate = STAGES[lastPresent + 1] ? STAGES[lastPresent + 1].lostTo : STAGES[0].lostTo;
      lostAt.get(gate).push(`${name}: ${text.slice(0, 92)}`);
    }
  }

  console.log('\nAction recall attribution - where the human-minuted actions go');
  console.log(`\n  ground-truth actions : ${total}`);
  console.log(`  reached publication  : ${found}`);
  console.log(`  lost                 : ${total - found}\n`);

  console.log('  lost to'.padEnd(56), 'count');
  for (const stage of STAGES) {
    const losses = lostAt.get(stage.lostTo);
    console.log(`  ${stage.lostTo}`.padEnd(56), String(losses.length).padStart(5));
  }

  // Per-fixture funnel, so a meeting that produces nothing is distinguishable from one
  // that produces plenty and then filters it away.
  console.log('\nper-fixture funnel');
  console.log('  fixture'.padEnd(38), 'events', 'proposed', 'afterFloor', 'published', 'expected');
  for (const { name, expected, funnel } of rows) {
    console.log(
      `  ${name}`.padEnd(38),
      String(funnel.eventCount || 0).padStart(6),
      String((funnel.generated || []).length).padStart(8),
      String((funnel.afterFloor || []).length).padStart(10),
      String((funnel.published || []).length).padStart(9),
      String(expected.length).padStart(8)
    );
  }

  // Discovery attribution: for the actions no source proposed, was the underlying turn
  // even seen? Find the transcript turn that best supports the expected action, then ask
  // whether it entered a commitment thread and whether the per-event MiniLM gate passed.
  const discovery = { noSupportingTurn: 0, turnSeenNotAdmitted: 0, admittedButNoRow: 0, droppedByEnriched: 0, samples: [] };
  for (const { name, expected, funnel } of rows) {
    for (const item of expected) {
      const text = textOf(item);
      if (presentIn(text, funnel.generated)) continue;
      const events = funnel.events || [];
      let best = null;
      let bestScore = 0;
      for (const event of events) {
        // `overlap` normalises by the SHORTER token set, so a one-word turn that happens
        // to share its word scores 1.00 - "Before." matched a document-sharing action
        // perfectly on the first run of this harness. Support has to be measured against
        // the expected action's own vocabulary, and a turn too short to carry a
        // commitment cannot be the evidence for one.
        const words = String(event.text || '').split(/\s+/).filter(Boolean).length;
        if (words < 6) continue;
        const score = supportScore(text, event.text || '');
        if (score > bestScore) { bestScore = score; best = event; }
      }
      // 0.25 of the expected action's own content words is a low bar on purpose: this asks
      // whether ANY turn plausibly supports the action, not whether it would match as a row.
      if (!best || bestScore < 0.25) { discovery.noSupportingTurn += 1; continue; }
      if (presentIn(text, funnel.preEnriched)) { discovery.droppedByEnriched += 1; continue; }
      if (!best.inThread && !best.semanticCandidate) {
        discovery.turnSeenNotAdmitted += 1;
        if (discovery.samples.length < 12) discovery.samples.push(`${bestScore.toFixed(2)} ${name}\n        want: ${text.slice(0, 76)}\n        turn: ${String(best.text).slice(0, 76)}`);
      } else {
        discovery.admittedButNoRow += 1;
      }
    }
  }
  console.log('\ninside "never proposed" - was the supporting turn even seen?');
  console.log('  no turn plausibly supports it (synthesis needed) :', discovery.noSupportingTurn);
  console.log('  turn exists but discovery gates rejected it      :', discovery.turnSeenNotAdmitted);
  console.log('  a row existed, enriched eligibility dropped it   :', discovery.droppedByEnriched);
  console.log('  turn admitted, but no row was ever built        :', discovery.admittedButNoRow);
  if (discovery.samples.length) {
    console.log('\n  sample turns discovery rejected:');
    for (const sample of discovery.samples) console.log(`   - ${sample}`);
  }

  if (detail) {
    for (const stage of STAGES) {
      const losses = lostAt.get(stage.lostTo);
      if (!losses.length) continue;
      console.log(`\nlost to ${stage.lostTo} (${losses.length}):`);
      for (const line of losses) console.log(`   - ${line}`);
    }
  } else {
    console.log('\n(run with --detail to list every lost action)');
  }
}

module.exports = { presentIn, STAGES };

if (require.main === module) {
  try { run(); } catch (error) { console.error(error.stack || error); process.exitCode = 1; }
}
