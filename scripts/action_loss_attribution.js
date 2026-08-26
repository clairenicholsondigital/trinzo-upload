'use strict';

// Where did each missing expected action actually die?
//
// The stage-level funnel (action_recall_attribution.js) stops at actionsStage's return
// value, and every pass in routes/api.js - band merge, corroboration, presentation,
// wording repair, claim check, semantic dedupe - runs after that. The gap between the
// funnel's recall and the scorecard's recall is exactly those passes' cost, and until
// the ACTION_TRACE tap neither instrument could attribute it.
//
// This script joins three artifacts FROM THE SAME RUN (which is what makes the answer
// clean despite the known ±5 run-to-run LLM variance):
//
//   SCORECARD_DUMP  - the scorecard's own verdicts: which expected actions went unmatched
//   ACTION_TRACE    - routes-level snapshots after every pass + every row-eating mutation
//   ACTION_FUNNEL   - stage-level discovery populations (optional; sharpens bucket b)
//
// and classifies every scorecard-unmatched expected action into exactly one bucket:
//
//   never_discovered   no source - deterministic or proposal - ever produced the content
//   stage_gate_kill    the stage discovered it and its own gates dropped it pre-publication
//   routes_eaten       published by the stage, then removed/replaced by a routes pass;
//                      subdivided by the eating pass, and by whether the surviving row
//                      still covers the content semantically (MiniLM >= 0.6):
//                        "test artifact" - content survived, wording diverged
//                        "content lost"  - the pipeline genuinely lost it
//   owner_gate_loss    a final row matches the TEXT at >= 0.5 but the scorecard's owner
//                      gate (x0.4 on a wrong owner) failed it - a merge or an owner
//                      resolution put the wrong name on real content
//   weak_final_match   best final text overlap in [0.3, 0.5) and no semantic credit -
//                      partially captured, mostly a discovery/composition shortfall
//
// Run (after a scorecard run with the taps on):
//   ACTION_TRACE=/tmp/trace.jsonl ACTION_FUNNEL=/tmp/funnel.jsonl \
//     SCORECARD_DUMP=/tmp/scores.json node scripts/staged_minutes_scorecard.js
//   node scripts/action_loss_attribution.js /tmp/scores.json /tmp/trace.jsonl /tmp/funnel.jsonl --detail

const fs = require('fs');
const path = require('path');
const { overlap, MATCH_THRESHOLD, SEM_THRESHOLD, semanticText } = require('./staged_minutes_scorecard');

const NEAR = 0.3;
const SNAPSHOT_ORDER = ['stage_published', 'after_polish', 'after_proposal_merge', 'after_completeness_sweep', 'after_presentation', 'after_wording_repair', 'after_claim_check', 'final'];
// The pass that ran between snapshot N-1 and snapshot N, named for the report.
const PASS_BEFORE = {
  after_polish: 'polish',
  after_proposal_merge: 'proposal_merge',
  after_completeness_sweep: 'completeness_sweep',
  after_presentation: 'presentation',
  after_wording_repair: 'wording_repair',
  after_claim_check: 'claim_check',
  final: 'dedupe'
};

function readJsonl(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function funnelText(entry) {
  // Funnel populations are "owner :: action" strings.
  const at = String(entry || '').indexOf(' :: ');
  return at >= 0 ? String(entry).slice(at + 4) : String(entry);
}

function bestRowOverlap(expectedAction, rows, textOf) {
  let best = 0;
  let bestRow = null;
  for (const row of rows || []) {
    const score = overlap(expectedAction, textOf(row));
    if (score > best) { best = score; bestRow = row; }
  }
  return { best, bestRow };
}

// The scorecard's owner rule, reproduced exactly so "owner-gate loss" means what the
// scorecard means: lenient on blank/Not stated, x0.4 (unreachable) on a wrong name.
function ownerAccepts(expected, row) {
  return !expected.owner || overlap(expected.owner, row.owner || '') >= 0.5
    || String(row.owner || '').toLowerCase() === 'not stated';
}

function classifyFixture(score, trace, funnel) {
  const expectedAll = score.actionRecall?.unmatched || [];
  // The semantic tier already credited some strict-unmatched items; exclude them.
  const semMatched = new Set((score.actionRecall?.sem?.pairs || []).map((pair) => pair.expected));
  const missing = expectedAll.filter((item) => !semMatched.has(semanticText(item)));
  const snapshots = new Map((trace?.snapshots || []).map((snap) => [snap.pass, snap.rows || []]));
  const finalRows = snapshots.get('final') || [];
  const proposals = trace?.proposals
    ? ['agreed', 'requirements', 'considered', 'ungrounded'].flatMap((key) => trace.proposals[key] || [])
    : [];
  const funnelPopulation = funnel
    ? [...(funnel.preEnriched || []), ...(funnel.generated || [])].map(funnelText)
    : [];

  const findings = [];
  for (const expected of missing) {
    const text = expected.action;

    // (d) owner-gate: the text is on the final screen, the name on it is wrong.
    const ownerGated = finalRows.find((row) => overlap(text, row.action) >= MATCH_THRESHOLD && !ownerAccepts(expected, row));
    if (ownerGated) {
      const viaMerge = (trace?.mutations || []).find((mutation) => ['band_replace', 'dedupe_drop'].includes(mutation.type)
        && overlap(text, mutation.before || mutation.dropped || '') >= MATCH_THRESHOLD);
      findings.push({
        expected, bucket: 'owner_gate_loss',
        detail: `final row "${ownerGated.action}" owned by "${ownerGated.owner}" (expected "${expected.owner}")${viaMerge ? ` - reached via ${viaMerge.type}` : ''}`
      });
      continue;
    }

    // (c) routes-eaten: present in some snapshot, gone from final.
    const presence = SNAPSHOT_ORDER.filter((pass) => snapshots.has(pass))
      .map((pass) => ({ pass, present: (snapshots.get(pass) || []).some((row) => overlap(text, row.action) >= MATCH_THRESHOLD) }));
    const lastPresent = [...presence].reverse().find((entry) => entry.present);
    if (lastPresent && lastPresent.pass !== 'final') {
      const after = presence[presence.findIndex((entry) => entry.pass === lastPresent.pass) + 1];
      const eater = after ? (PASS_BEFORE[after.pass] || after.pass) : 'unknown';
      // Who replaced it? A mutation record names the survivor precisely; failing that,
      // positional continuity (repair rewrites in place); failing that, the closest final row.
      const mutation = (trace?.mutations || []).find((entry) => overlap(text, entry.before || entry.dropped || entry.action || '') >= MATCH_THRESHOLD);
      let survivor = mutation ? (mutation.after || mutation.survivor || '') : '';
      if (!survivor && after && snapshots.has(after.pass)) {
        const beforeRows = snapshots.get(lastPresent.pass) || [];
        const afterRows = snapshots.get(after.pass) || [];
        const index = beforeRows.findIndex((row) => overlap(text, row.action) >= MATCH_THRESHOLD);
        if (index >= 0 && beforeRows.length === afterRows.length) survivor = afterRows[index]?.action || '';
      }
      findings.push({ expected, bucket: 'routes_eaten', eater, survivor, mutationType: mutation?.type || '' });
      continue;
    }

    // (b) stage-gate kill: the stage's own discovery saw it but never published it,
    // and the proposal source did not resurrect it.
    const inFunnel = funnelPopulation.some((entry) => overlap(text, entry) >= MATCH_THRESHOLD);
    const inProposals = proposals.some((item) => overlap(text, item.action) >= MATCH_THRESHOLD);
    const inAnySnapshot = presence.some((entry) => entry.present);
    if (inFunnel && !inAnySnapshot && !inProposals) {
      findings.push({ expected, bucket: 'stage_gate_kill' });
      continue;
    }
    if (inProposals && !inAnySnapshot) {
      // Proposed but never landed on a snapshot: grounding refusal, publishable bar,
      // isNew dedupe against a row that doesn't actually cover it, or held back.
      findings.push({ expected, bucket: 'proposal_refused' });
      continue;
    }

    // (a) never discovered - with the partial-capture shade split out.
    const { best } = bestRowOverlap(text, finalRows, (row) => row.action);
    findings.push({ expected, bucket: best >= NEAR ? 'weak_final_match' : 'never_discovered', bestFinalOverlap: Number(best.toFixed(2)) });
  }
  return findings;
}

// One bridge call for every routes_eaten pair: does the surviving row still carry the
// expected content? >= SEM_THRESHOLD means the reviewer's content survived in different
// words (a scoring artifact); below it the pipeline genuinely lost the content.
function semanticVerdicts(perFixture) {
  // The bridge scores expected[i] against all of a request's candidates, so each eaten
  // item gets its own request: its survivor when a mutation named one, otherwise every
  // final row (the content may have landed anywhere).
  const pairwise = [];
  for (const { name, findings, finalRows } of perFixture) {
    findings.filter((finding) => finding.bucket === 'routes_eaten').forEach((finding, index) => {
      const candidates = finding.survivor ? [finding.survivor] : finalRows.map((row) => row.action);
      if (!candidates.length || !candidates[0]) { finding.verdict = 'content_lost'; finding.sim = 0; return; }
      pairwise.push({ id: `${name}::${index}`, expected: [finding.expected.action], candidates, finding });
    });
  }
  if (!pairwise.length) return;
  const { spawnSync } = require('child_process');
  const bridge = path.join(__dirname, 'semantic_pair_bridge.py');
  const run = spawnSync('python3', [bridge], {
    input: JSON.stringify({ requests: pairwise.map(({ id, expected, candidates }) => ({ id, expected, candidates })) }),
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300000
  });
  let results = [];
  try { results = JSON.parse(run.stdout.trim().split('\n').pop()).results || []; } catch { /* verdicts stay unset */ }
  const byId = new Map(results.map((result) => [result.id, result]));
  for (const entry of pairwise) {
    const best = byId.get(entry.id)?.best?.[0];
    entry.finding.sim = best ? Number(best.sim.toFixed(2)) : null;
    entry.finding.verdict = best && best.sim >= SEM_THRESHOLD ? 'test_artifact' : 'content_lost';
  }
}

function main() {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const detail = process.argv.includes('--detail');
  const [dumpPath, tracePath, funnelPath] = args;
  if (!dumpPath) {
    console.error('usage: node scripts/action_loss_attribution.js <scorecard-dump.json> <trace.jsonl> [funnel.jsonl] [--detail]');
    process.exit(1);
  }
  const scores = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
  const traces = new Map(readJsonl(tracePath).map((entry) => [entry.fileName, entry]));
  const funnels = new Map(readJsonl(funnelPath).filter((entry) => entry.fileName).map((entry) => [entry.fileName, entry]));

  const perFixture = [];
  for (const score of scores) {
    const trace = traces.get(score.name) || null;
    if (!trace) {
      console.error(`no trace record for ${score.name} - was ACTION_TRACE set during the scorecard run?`);
      continue;
    }
    const findings = classifyFixture(score, trace, funnels.get(score.name) || null);
    perFixture.push({ name: score.name, findings, finalRows: (trace.snapshots || []).find((snap) => snap.pass === 'final')?.rows || [] });
  }
  semanticVerdicts(perFixture);

  const counts = {};
  for (const { findings } of perFixture) {
    for (const finding of findings) {
      const key = finding.bucket === 'routes_eaten'
        ? `routes_eaten:${finding.eater}:${finding.verdict || 'unverified'}`
        : finding.bucket;
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  const totalMissing = perFixture.reduce((sum, { findings }) => sum + findings.length, 0);
  console.log(`\n${totalMissing} expected actions unmatched (strict + semantic tier) across ${perFixture.length} fixtures\n`);
  for (const [key, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(3)}  ${key}`);
  }
  if (detail) {
    console.log('');
    for (const { name, findings } of perFixture) {
      for (const finding of findings) {
        const extra = finding.bucket === 'routes_eaten'
          ? ` [${finding.eater}${finding.mutationType ? `/${finding.mutationType}` : ''} sim=${finding.sim ?? '?'} ${finding.verdict || ''}] survivor: ${finding.survivor || '(none)'}`
          : (finding.detail ? ` [${finding.detail}]` : (finding.bestFinalOverlap !== undefined ? ` [bestFinal=${finding.bestFinalOverlap}]` : ''));
        console.log(`${name} :: ${finding.bucket} :: ${finding.expected.owner || ''} | ${finding.expected.action}${extra}`);
      }
    }
  }
}

main();
