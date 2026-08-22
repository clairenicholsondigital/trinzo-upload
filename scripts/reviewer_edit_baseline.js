'use strict';

// Reviewer-correction replay across the transcript corpus.
//
// The parse baseline guards prepareEvidence(); the topic-label baseline guards what a
// reviewer reads at the top of the discussion. This guards the promise the staged
// workflow makes by existing: that correcting an early screen changes the later ones,
// and that nothing a reviewer corrected comes back wrong.
//
// For each scripted correction in tests/fixtures/reviewer-edits.json it runs the stage
// chain twice over the same transcript - once with no edit, once with the correction
// applied at its stage - and compares.
//
// Two families of measure, and they are read differently:
//
//   contract   - must hold exactly. A violation is a bug: the reviewer's own words were
//                reworded, filtered, regenerated or dropped. Asserted by
//                tests/reviewer-edit-contract.test.js over a small named subset, so a
//                regression fails the suite rather than waiting for a corpus run.
//   difference - read, not asserted. Whether a correction changed anything downstream,
//                and how much. There is no target: a correction to a heading nobody
//                referred to legitimately changes little.
//
// Capture:  node scripts/reviewer_edit_baseline.js --write
// Compare:  node scripts/reviewer_edit_baseline.js
// One case: node scripts/reviewer_edit_baseline.js --scenario rename-heading-keeps-fact-placement
//
// Cost is one MiniLM profile per transcript, not per run: loadMiniLMProfileSync keys its
// cache on transcript-derived evidence, so the edited chain and the cold chain share it,
// as do all three stages. Set CANONICAL_MINILM_DISK_CACHE to a directory to keep the
// profiles between runs and the corpus pass drops from about fifty minutes to seven.

const fs = require('fs');
const path = require('path');
const { runCanonicalLiveStage } = require('../utils/canonicalMinutes/liveStages');
const { factIsPreserved } = require('../utils/stagedSemanticAuthority');

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_PATH = path.join(REPO_ROOT, 'tests', 'fixtures', 'reviewer-edits.json');
const BASELINE_PATH = path.join(REPO_ROOT, 'tests', 'fixtures', 'reviewer-edit-baseline.json');
const TRANSCRIPT_ROOTS = [
  path.join(REPO_ROOT, 'scripts', 'meeting-minutes-final-golden'),
  path.join(REPO_ROOT, 'scripts', 'transcript-tests')
];

function transcriptPath(name) {
  for (const root of TRANSCRIPT_ROOTS) {
    const candidate = path.join(root, name, 'transcript.txt');
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`transcript not found for "${name}" under ${TRANSCRIPT_ROOTS.join(', ')}`);
}

// --- the dotted field vocabulary, shared with flattenStagedReviewVersion -------------

// "summary.overallTopics[0]" -> { stage:'summary', field:'overallTopics', index:0 }
// "discussion.0.points[1]"   -> { stage:'discussion', card:0, field:'points', index:1 }
function parsePath(value) {
  const [stage, ...rest] = String(value || '').split('.');
  const joined = rest.join('.');
  const card = /^\d+$/.test(rest[0]) ? Number(rest[0]) : null;
  const tail = card === null ? joined : rest.slice(1).join('.');
  const match = /^([A-Za-z]+)(?:\[(\d+)\])?$/.exec(tail || '');
  if (!match) return { stage, card, field: tail || '', index: null };
  return { stage, card, field: match[1], index: match[2] === undefined ? null : Number(match[2]) };
}

function applyEdit(confirmed, edit) {
  const { stage, card, field, index } = parsePath(edit.path);
  const next = JSON.parse(JSON.stringify(confirmed));
  if (edit.op === 'regenerate') return next;

  if (stage === 'discussion' && card !== null) {
    const cards = Array.isArray(next.discussion) ? next.discussion : [];
    if (!cards[card]) return next;
    if (index === null) cards[card][field] = edit.to;
    else if (Array.isArray(cards[card][field])) cards[card][field][index] = edit.to;
    next.discussion = cards;
    return next;
  }
  if (stage === 'actions' && card !== null) {
    const rows = Array.isArray(next.actions) ? next.actions : [];
    if (!rows[card]) return next;
    rows[card][field] = edit.to;
    next.actions = rows;
    return next;
  }

  const container = next[stage] || (next[stage] = {});
  if (edit.op === 'append') {
    container[field] = [...(Array.isArray(container[field]) ? container[field] : []), edit.to];
  } else if (index === null) {
    container[field] = edit.to;
  } else {
    const list = Array.isArray(container[field]) ? [...container[field]] : [];
    // A scenario may edit a slot the cold run did not produce; appending keeps the
    // correction rather than silently discarding the case.
    if (index < list.length) list[index] = edit.to;
    else list.push(edit.to);
    container[field] = list;
  }
  return next;
}

// --- running a chain ------------------------------------------------------------------

const STAGES = ['summary', 'discussion', 'actions'];

function runChain(transcriptText, fileName, edits = []) {
  const editsFor = (stage) => edits.filter((edit) => parsePath(edit.path).stage === stage || edit.stage === stage);
  let confirmed = { details: { meetingTitle: '', meetingType: '' } };
  for (const edit of editsFor('details')) confirmed = applyEdit(confirmed, edit);

  const screens = {};
  const flags = [];
  for (const stage of STAGES) {
    const result = runCanonicalLiveStage(transcriptText, {
      stage,
      fileName,
      confirmed,
      includeEvidencePack: stage === 'actions'
    });
    screens[stage] = result.screens[stage];
    flags.push(...(result.validationFlags || []));
    // The reviewer confirms the screen they were shown, then corrects it.
    confirmed = { ...confirmed, [stage]: screens[stage] };
    const stageEdits = editsFor(stage);
    for (const edit of stageEdits) confirmed = applyEdit(confirmed, edit);
    screens[stage] = confirmed[stage];

    // A reviewer who presses regenerate runs the stage again with their corrections in
    // hand. That is the only path on which a later run could overwrite what they wrote,
    // so a scenario testing "my correction is not regenerated away" has to take it.
    if (stageEdits.some((edit) => edit.op === 'regenerate')) {
      const again = runCanonicalLiveStage(transcriptText, {
        stage,
        fileName,
        confirmed,
        includeEvidencePack: stage === 'actions'
      });
      screens[stage] = again.screens[stage];
      flags.push(...(again.validationFlags || []));
      confirmed = { ...confirmed, [stage]: screens[stage] };
    }
  }
  return { screens, flags, confirmed };
}

// --- measures -------------------------------------------------------------------------

function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('\n');
  if (typeof value === 'object') return Object.values(value).map(textOf).join('\n');
  return String(value);
}

function stageText(screens, stage) {
  if (stage === 'final') return textOf(screens);
  return textOf(screens[stage]);
}

function discussionCards(screens) {
  return Array.isArray(screens.discussion) ? screens.discussion : [];
}

function measure(scenario, edited) {
  const expect = scenario.expect || {};
  const violations = [];

  for (const item of expect.preserved || []) {
    if (!stageText(edited.screens, item.stage).includes(item.text)) {
      violations.push({ kind: 'not_preserved', stage: item.stage, text: item.text });
    }
  }
  for (const text of expect.absent || []) {
    if (stageText(edited.screens, 'final').includes(text)) {
      violations.push({ kind: 'present_but_should_not_be', text });
    }
  }
  if (expect.noOtherBucket !== undefined) {
    const other = discussionCards(edited.screens).filter((card) => /^other$/i.test(String(card?.topic || '').trim())).length;
    if (other > expect.noOtherBucket) violations.push({ kind: 'other_bucket', count: other });
  }
  for (const type of expect.flags || []) {
    if (!edited.flags.some((flag) => flag?.type === type)) violations.push({ kind: 'flag_missing', type });
  }
  // A screen may carry the same value under more than one key - the purpose sits in
  // meetingPurpose and again inside initialUnderstanding. Correcting one and leaving the
  // other is how a value the reviewer already fixed goes on being read somewhere else.
  if (expect.noStaleDerivedPurpose) {
    const summary = edited.screens.summary || {};
    const derived = String(summary.initialUnderstanding?.meetingPurpose?.text || '');
    if (derived && derived !== String(summary.meetingPurpose || '')) {
      violations.push({ kind: 'stale_derived_purpose', text: derived.slice(0, 60) });
    }
  }
  if (expect.blockingFlags !== undefined) {
    const blocking = edited.flags.filter((flag) => flag?.blocking).length;
    if (blocking > expect.blockingFlags) violations.push({ kind: 'blocking_flags', count: blocking, allowed: expect.blockingFlags });
  }

  // Key facts the reviewer confirmed must survive into the discussion. factIsPreserved is
  // the same check the repair uses, so the harness and the pipeline cannot disagree about
  // what "preserved" means.
  const keyFacts = Array.isArray(edited.confirmed.summary?.keyFacts) ? edited.confirmed.summary.keyFacts : [];
  const unpreservedFacts = keyFacts.filter((fact) => !factIsPreserved(fact, discussionCards(edited.screens)));

  return { violations, keyFactCount: keyFacts.length, unpreservedFactCount: unpreservedFacts.length, unpreservedFacts };
}

function difference(cold, edited) {
  const headings = (screens) => discussionCards(screens).map((card) => String(card?.topic || ''));
  const coldHeadings = headings(cold.screens);
  const editedHeadings = headings(edited.screens);
  const changed = (stage) => stageText(cold.screens, stage) !== stageText(edited.screens, stage);
  return {
    summaryChanged: changed('summary'),
    discussionChanged: changed('discussion'),
    actionsChanged: changed('actions'),
    headingsAdded: editedHeadings.filter((heading) => !coldHeadings.includes(heading)),
    headingsRemoved: coldHeadings.filter((heading) => !editedHeadings.includes(heading)),
    coldDiscussionCards: coldHeadings.length,
    editedDiscussionCards: editedHeadings.length,
    coldActions: Array.isArray(cold.screens.actions) ? cold.screens.actions.length : 0,
    editedActions: Array.isArray(edited.screens.actions) ? edited.screens.actions.length : 0,
    coldBlockingFlags: cold.flags.filter((flag) => flag?.blocking).length,
    editedBlockingFlags: edited.flags.filter((flag) => flag?.blocking).length
  };
}

// --- driver ---------------------------------------------------------------------------

function scenarios(only) {
  const loaded = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')).scenarios || [];
  return only ? loaded.filter((item) => item.id === only) : loaded;
}

function collect(only) {
  const rows = [];
  for (const scenario of scenarios(only)) {
    for (const name of scenario.appliesTo || []) {
      const file = transcriptPath(name);
      const transcriptText = fs.readFileSync(file, 'utf8');
      const fileName = `${name}.txt`;
      let row;
      try {
        const cold = runChain(transcriptText, fileName, []);
        const edited = runChain(transcriptText, fileName, scenario.edits || []);
        row = {
          scenario: scenario.id,
          transcript: name,
          ...measure(scenario, edited),
          difference: difference(cold, edited),
          headings: discussionCards(edited.screens).map((card) => String(card?.topic || '')),
          actions: (Array.isArray(edited.screens.actions) ? edited.screens.actions : [])
            .map((action) => `${action?.owner || ''} | ${action?.action || ''} | ${action?.deadline || ''}`)
        };
      } catch (error) {
        row = { scenario: scenario.id, transcript: name, error: String(error && error.message || error), violations: [{ kind: 'threw' }] };
      }
      rows.push(row);
      const count = (row.violations || []).length;
      process.stdout.write(`${count ? 'VIOLATION' : '        ok'}  ${scenario.id}  ${name}${count ? ` (${count})` : ''}\n`);
    }
  }
  return rows;
}

function report(rows) {
  const violations = rows.flatMap((row) => (row.violations || []).map((item) => ({ scenario: row.scenario, transcript: row.transcript, ...item })));
  console.log('');
  console.log(`scenarios run          : ${rows.length}`);
  console.log(`contract violations    : ${violations.length}`);
  const moved = rows.filter((row) => row.difference && (row.difference.summaryChanged || row.difference.discussionChanged || row.difference.actionsChanged)).length;
  console.log(`corrections that changed a later stage : ${moved}/${rows.length}`);
  if (violations.length) {
    console.log('');
    for (const item of violations) {
      console.log(`  ${item.scenario} / ${item.transcript}: ${item.kind}${item.text ? ` "${item.text}"` : ''}${item.type ? ` ${item.type}` : ''}`);
    }
  }
  return violations.length;
}

function main() {
  const write = process.argv.includes('--write');
  const scenarioArg = process.argv.indexOf('--scenario');
  const only = scenarioArg >= 0 ? process.argv[scenarioArg + 1] : '';
  const rows = collect(only);
  const failures = report(rows);
  if (write) {
    if (only) {
      console.log('\nrefusing to write a baseline from a single scenario');
      process.exitCode = 2;
      return;
    }
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify({ rows }, null, 2)}\n`);
    console.log(`\nwrote ${path.relative(REPO_ROOT, BASELINE_PATH)}: ${rows.length} rows`);
    return;
  }
  process.exitCode = failures ? 1 : 0;
}

if (require.main === module) main();

module.exports = { runChain, applyEdit, parsePath, measure, difference, scenarios, transcriptPath, BASELINE_PATH };
