'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { actionCandidateInventory } = require('../utils/meetingMinutesAgentV2');
const { timedStepCoverage, mergeTimedStepRecovery } = require('../utils/meetingMinutesTimedStepCoverage');
const options = { meetingDate: '2026-06-17' };
const units = [{ id: 'T0001', speaker: 'Morgan', text: "I'll write the supplier letter this week." },
  { id: 'T0002', speaker: 'Morgan', text: "I'll take the inspection photo tomorrow." }];
const letter = { id: 'letter', action: 'Write the supplier letter.', owners: ['Morgan'], evidenceIds: ['T0001', 'T0002'],
  timing: { kind: 'target', wording: 'this week', exactDate: '' } };
const photo = { id: 'photo', action: 'Take the inspection photo.', owners: [], evidenceIds: ['T0002'],
  timing: { kind: 'deadline', wording: 'tomorrow', exactDate: '2026-06-18' } };

test('overlapping owner and evidence cannot discharge a different timed step', () => {
  const inventory = actionCandidateInventory(units);
  const coverage = timedStepCoverage(inventory, [letter], units, options);
  assert.equal(coverage.expected, 2);
  assert.equal(coverage.covered, 1);
  assert.equal(coverage.unresolved, 1);
  assert.equal(coverage.uncovered[0].focusEvidenceId, 'T0002');
  const recovery = mergeTimedStepRecovery({ needed: false, uncovered: [], retained: true }, coverage);
  assert.equal(recovery.needed, true);
  assert.equal(recovery.retained, true);
  assert.equal(recovery.uncovered.length, 1);
});

test('a real separate step and its own timing close coverage even when its owner is unknown', () => {
  const coverage = timedStepCoverage(actionCandidateInventory(units), [letter, photo], units, options);
  assert.equal(coverage.complete, true);
  assert.equal(coverage.covered, 2);
  assert.deepEqual(coverage.items[1].actionIds, ['photo']);
});

test('an untimed row or checker uncertainty remains explicitly unresolved and is not removed', () => {
  const untimed = { ...photo, timing: { kind: 'not_stated', wording: '', exactDate: '' } };
  const uncertain = { ...photo, timingDecision: { status: 'unresolved' } };
  for (const row of [untimed, uncertain]) {
    const before = structuredClone(row);
    const coverage = timedStepCoverage(actionCandidateInventory(units), [letter, row], units, options);
    assert.equal(coverage.unresolved, 1);
    assert.deepEqual(row, before);
  }
});

test('a schedule fact, unaccepted request or weak this-time wording does not invent timed work', () => {
  const source = [{ id: 'T0001', speaker: 'Morgan', text: 'The supplier conference is next week.' },
    { id: 'T0002', speaker: 'Riley', text: 'Could you write the letter tomorrow?' },
    { id: 'T0003', speaker: 'Morgan', text: "I'll write the letter properly this time." }];
  for (const unit of source) {
    const coverage = timedStepCoverage(actionCandidateInventory([unit]), [], [unit], options);
    assert.equal(coverage.expected, 0);
    assert.equal(coverage.complete, true);
  }
});

test('focused compound clauses are accounted once each instead of counting the whole turn again', () => {
  const source = [{ id: 'T0001', speaker: 'Morgan', text: "I'll write the supplier letter tomorrow and I'll test the equipment on Friday." }];
  const coverage = timedStepCoverage(actionCandidateInventory(source), [], source, options);
  assert.equal(coverage.expected, 2);
  assert.deepEqual(coverage.items.map(item => item.expression), ['tomorrow', 'friday']);
});

test('two separate tasks in one turn cannot cover one another just because their dates match', () => {
  const source = [{ id: 'T0001', speaker: 'Morgan', text: 'I will review the inspection report Friday; I will write the supplier letter Friday.' }];
  const action = { id: 'review', action: 'Review the inspection report.', owners: ['Morgan'], evidenceIds: ['T0001'],
    timing: { kind: 'deadline', wording: 'Friday', exactDate: '2026-06-19' } };
  const coverage = timedStepCoverage(actionCandidateInventory(source), [action], source, options);
  assert.equal(coverage.expected, 2);
  assert.equal(coverage.covered, 1);
  assert.equal(coverage.unresolved, 1);
  assert.match(coverage.uncovered[0].focusText, /write the supplier letter/i);
});

test('a missing conditional or recurring step cannot be reported as complete just because it lacks a calendar day', () => {
  for (const wording of ['once approval arrives', 'weekly']) {
    const source = [{ id: 'T0001', speaker: 'Morgan', text: `I will review the inspection report ${wording}.` }];
    const inventory = actionCandidateInventory(source);
    const absent = timedStepCoverage(inventory, [], source, options);
    assert.equal(absent.expected, 1);
    assert.equal(absent.complete, false);
    assert.equal(mergeTimedStepRecovery({ needed: false, uncovered: [] }, absent).needed, true);
    const present = timedStepCoverage(inventory, [{ id: 'review', action: 'Review the inspection report.', owners: ['Morgan'],
      evidenceIds: ['T0001'], timing: { kind: 'target', wording, exactDate: '' } }], source, options);
    assert.equal(present.complete, true, wording);
  }
});

test('generated discussion paraphrases cannot add timed steps to the raw source inventory', () => {
  const source = [{ id: 'T0001', speaker: 'Morgan', text: 'That is within the purchasing limit.' },
    { id: 'T0002', speaker: 'Morgan', text: "I'll review the inspection report tomorrow." }];
  const raw = actionCandidateInventory(source);
  const generated = { candidateId: 'candidate-discussion-example', focusEvidenceId: 'T0001',
    evidenceIds: ['T0001', 'T0002'], dispositionHint: 'committed', sourcePass: 'discussion_row',
    focusText: 'Morgan will purchase and fit the equipment on Saturday.' };
  const coverage = timedStepCoverage([...raw, generated], [], source, options);
  assert.equal(coverage.expected, 1);
  assert.deepEqual(coverage.items.map(item => item.focusEvidenceId), ['T0002']);
  assert.deepEqual(coverage.uncovered.map(candidate => candidate.candidateId), raw.map(candidate => candidate.candidateId));
  // Merely omitting the provenance marker cannot turn a paraphrase into a
  // literal source focus, either.
  assert.equal(timedStepCoverage([{ ...generated, candidateId: 'candidate-example', sourcePass: undefined }], [], source, options).expected, 0);
});

test('generated discussion rows remain excluded even when their wording happens to quote a source turn', () => {
  const inventory = actionCandidateInventory(units);
  const generated = { ...inventory[0], candidateId: 'candidate-discussion-example', sourcePass: 'discussion_row' };
  const coverage = timedStepCoverage([...inventory, generated], [], units, options);
  assert.equal(coverage.expected, 2);
  assert.equal(coverage.uncovered.some(candidate => candidate.sourcePass === 'discussion_row'), false);
});

test('co-occurring day and period qualifiers form one timed step and retain every constraint', () => {
  const source = [{ id: 'T0001', speaker: 'Morgan',
    text: "I'll review the inspection report this weekend, Saturday morning probably, before it gets busy." }];
  const inventory = actionCandidateInventory(source);
  const absent = timedStepCoverage(inventory, [], source, options);
  assert.equal(absent.expected, 1);
  assert.deepEqual(absent.items[0].expressions, ['this weekend', 'saturday', 'before it gets busy']);
  assert.equal(absent.uncovered.length, 1);
  const partial = { id: 'review', action: 'Review the inspection report.', owners: ['Morgan'], evidenceIds: ['T0001'],
    timing: { kind: 'target', wording: 'this weekend, Saturday morning probably', exactDate: '' } };
  assert.equal(timedStepCoverage(inventory, [partial], source, options).complete, false);
  const complete = { ...partial, timing: { ...partial.timing, wording: 'this weekend, Saturday morning probably, before it gets busy' } };
  // Grouping is accounting only: the independent source-binding checker
  // still cannot prove this qualified compound wording and stays unresolved.
  assert.equal(timedStepCoverage(inventory, [complete], source, options).complete, false);
  const datedSource = [{ id: 'T0001', speaker: 'Morgan', text: "I'll review the inspection report this week, Friday." }];
  const datedInventory = actionCandidateInventory(datedSource);
  const dated = { ...partial, timing: { kind: 'target', wording: 'this week, Friday', exactDate: '' } };
  const covered = timedStepCoverage(datedInventory, [dated], datedSource, options);
  assert.equal(covered.expected, 1);
  assert.equal(covered.complete, true);
  assert.equal(timedStepCoverage(datedInventory, [{ ...dated, timing: { ...dated.timing, wording: 'Friday' } }], datedSource, options).complete, false);
});

test('a second operation keeps its own timing check when a turn contains only one promise marker', () => {
  const source = [{ id: 'T0001', speaker: 'Morgan',
    text: 'I will review the inspection report Friday and write the supplier letter Monday.' }];
  const coverage = timedStepCoverage(actionCandidateInventory(source), [], source, options);
  assert.equal(coverage.expected, 2);
  assert.deepEqual(coverage.items.map(item => item.expressions), [['friday'], ['monday']]);
});

test('an anaphoric commitment remains unresolved when its own focused text cannot establish the work', () => {
  for (const focusText of ["I'll do it this weekend, Saturday morning probably, before it gets busy.", "I'll do the lot Saturday."]) {
    const source = [{ id: 'T0001', speaker: 'Morgan', text: 'The supplier letter and the inspection report need attention.' },
      { id: 'T0002', speaker: 'Morgan', text: focusText }];
    const action = { id: 'review', action: 'Review the inspection report.', owners: ['Morgan'], evidenceIds: ['T0001', 'T0002'],
      timing: { kind: 'target', wording: focusText.includes('weekend') ? 'this weekend, Saturday morning probably, before it gets busy' : 'Saturday', exactDate: '' } };
    const coverage = timedStepCoverage(actionCandidateInventory(source), [action], source, options);
    assert.equal(coverage.expected, 1);
    assert.equal(coverage.covered, 0);
    assert.equal(coverage.complete, false);
  }
});

test('a historical period used to introduce prior actions does not invent a new timed obligation', () => {
  const source = [{ id: 'T0001', speaker: 'Morgan', text: 'Okay, back to last week and the follow-up actions that we had last week.' }];
  // The discovery inventory may conservatively nominate this agenda turn;
  // timing coverage must not turn that nomination into an asserted deadline.
  const nominated = { candidateId: 'candidate-historical', focusEvidenceId: 'T0001', evidenceIds: ['T0001'],
    focusText: source[0].text, dispositionHint: 'conditional_commitment' };
  const coverage = timedStepCoverage([nominated], [], source, options);
  assert.equal(coverage.expected, 0);
  assert.equal(coverage.complete, true);
  const future = [{ id: 'T0001', speaker: 'Morgan', text: "I'll review the open actions from last week tomorrow." }];
  const futureCoverage = timedStepCoverage(actionCandidateInventory(future), [], future, options);
  assert.equal(futureCoverage.expected, 1);
  assert.deepEqual(futureCoverage.items[0].expressions, ['tomorrow']);
});

test('a source-stated overdue period remains a timed obligation despite being in the past', () => {
  const source = [{ id: 'T0001', speaker: 'Morgan', text: 'I still need to review the inspection report; it was due last week.' }];
  const inventory = actionCandidateInventory(source);
  const absent = timedStepCoverage(inventory, [], source, options);
  assert.equal(absent.expected, 1);
  assert.deepEqual(absent.items[0].expressions, ['last week']);
  assert.equal(absent.complete, false);
  const row = { id: 'review', action: 'Review the inspection report.', owners: ['Morgan'], evidenceIds: ['T0001'],
    timing: { kind: 'deadline', wording: 'last week', exactDate: '' } };
  assert.equal(timedStepCoverage(inventory, [row], source, options).complete, true);
});
