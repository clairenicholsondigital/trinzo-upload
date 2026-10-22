'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../utils/meetingMinutesAgentV2');

function action(evidenceIds, overrides = {}) {
  return {
    action: 'Send the revised safety report.',
    owners: ['Morgan'],
    evidenceIds,
    ...overrides
  };
}

function passageLines(units) {
  return units.map((unit) => `${unit.speaker}: ${unit.text}`);
}

test('final lifecycle evidence keeps an initial request before its later completion', () => {
  const units = Array.from({ length: 20 }, (_, index) => ({
    id: `T${String(index + 1).padStart(4, '0')}`,
    speaker: 'Chair',
    text: `Agenda transition ${index + 1}.`
  }));
  units[1].text = 'Please send the revised safety report.';
  units[14] = {
    id: 'T0015', speaker: 'Morgan',
    text: 'The revised safety report has already been sent to the whole review team.'
  };
  const item = V.finalActionLifecycleCheckItems([action(['T0002', 'T0015'])], units)[0];
  const expected = [...units.slice(0, 7), ...units.slice(12, 20)];
  assert.deepEqual(item.passage.split('\n'), passageLines(expected));
  assert.ok(item.passage.indexOf(units[1].text) < item.passage.indexOf(units[14].text));

  const result = V.applyFinalActionLifecycleResults(
    [action(['T0002', 'T0015'])], [item],
    [{ id: item.id, verdict: 'not_outstanding', evidenceQuote: units[14].text }]
  );
  assert.equal(result.withheld.length, 1, 'a genuine later completion remains usable evidence');
  assert.equal(result.actions.length, 0);
});

test('final lifecycle evidence keeps later correction and renewed work after the completion it qualifies', () => {
  const units = Array.from({ length: 22 }, (_, index) => ({
    id: `T${String(index + 1).padStart(4, '0')}`,
    speaker: 'Chair',
    text: `Agenda transition ${index + 1}.`
  }));
  units[2].text = 'The revised safety report was already sent.';
  units[15] = {
    id: 'T0016', speaker: 'Morgan',
    text: 'Correction: I will send the revised safety report tomorrow because the attachment was missing.'
  };
  const actions = [action(['T0003', 'T0016'])];
  const item = V.finalActionLifecycleCheckItems(actions, units)[0];
  assert.deepEqual(item.passage.split('\n'), passageLines([
    ...units.slice(0, 8), ...units.slice(13, 21)
  ]));
  const result = V.applyFinalActionLifecycleResults(actions, [item], [{
    id: item.id, verdict: 'not_outstanding', evidenceQuote: units[2].text
  }]);
  assert.deepEqual(result.actions, actions, 'explicit renewed future work still protects the action');
  assert.equal(result.withheld.length, 0);
  assert.equal(result.rejected[0].reason, 'explicit_outstanding_evidence');
});

test('final lifecycle evidence retains relevance selection and the 40-row cap before restoring chronology', () => {
  const units = Array.from({ length: 64 }, (_, index) => ({
    id: `T${String(index + 1).padStart(4, '0')}`,
    speaker: 'Chair',
    text: `Agenda transition ${index + 1}.`
  }));
  units[46] = {
    id: 'T0047', speaker: 'Morgan',
    text: "I'll send the revised safety report."
  };
  // The seventh citation must win relevance selection. Its eight-row window
  // precedes four low-relevance windows in the existing bounded selection.
  // Restoring chronology must happen after that exact 40-row selection.
  const evidenceIds = ['T0003', 'T0013', 'T0023', 'T0033', 'T0043', 'T0053', 'T0047'];
  const item = V.finalActionLifecycleCheckItems([action(evidenceIds)], units)[0];
  const expected = [
    ...units.slice(0, 8), ...units.slice(10, 18),
    ...units.slice(20, 28), ...units.slice(30, 38),
    ...units.slice(44, 52)
  ];
  assert.equal(expected.length, 40);
  assert.deepEqual(item.passage.split('\n'), passageLines(expected));
  assert.equal(item.passage.length, passageLines(expected).join('\n').length);
  assert.ok(item.passage.includes(units[46].text), 'late relevant evidence must remain in the packet');
  assert.ok(!item.passage.includes(units[40].text), 'chronological sorting must not replace selected evidence');
  assert.ok(!item.passage.includes(units[52].text), 'the seventh low-priority window must stay excluded');
});

test('final lifecycle evidence follows canonical source position rather than numeric IDs or supplied sequence', () => {
  const units = Array.from({ length: 24 }, (_, index) => ({
    id: `T${String(90 - index).padStart(4, '0')}`,
    sequence: 1000 - index,
    speaker: 'Chair',
    text: `Agenda transition ${index + 1}.`
  }));
  units[2] = { ...units[2], text: 'Please send the revised safety report.' };
  units[16] = {
    ...units[16], speaker: 'Morgan',
    text: 'The revised safety report has already been sent.'
  };
  const item = V.finalActionLifecycleCheckItems([action([units[2].id, units[16].id])], units)[0];
  assert.deepEqual(item.passage.split('\n'), passageLines([
    ...units.slice(0, 8), ...units.slice(14, 22)
  ]));
});

test('final lifecycle evidence uses normalized IDs for nonstandard source labels and ignores excluded turns', () => {
  const units = Array.from({ length: 20 }, (_, index) => ({
    id: `external-label-${20 - index}`,
    sequence: 1000 - index,
    speaker: 'Chair',
    text: `Agenda transition ${index + 1}.`
  }));
  units[1].text = 'Please send the revised safety report.';
  units[4].classification = 'remove';
  units[14] = {
    ...units[14], speaker: 'Morgan',
    text: 'The revised safety report has already been sent.'
  };
  // Source normalization assigns T0002 and T0015 from their array positions.
  const item = V.finalActionLifecycleCheckItems([action(['T0002', 'T0015'])], units)[0];
  const expected = [
    ...units.slice(0, 8).filter((unit) => unit.classification !== 'remove'),
    ...units.slice(12, 20)
  ];
  assert.deepEqual(item.passage.split('\n'), passageLines(expected));
  assert.ok(!item.passage.includes(units[4].text));
});

test('final lifecycle evidence deduplicates overlapping windows by source ID without losing repeated utterances', () => {
  const units = Array.from({ length: 20 }, (_, index) => ({
    id: `T${String(index + 1).padStart(4, '0')}`,
    speaker: 'Chair',
    text: `Agenda transition ${index + 1}.`
  }));
  units[2].text = 'The attachment is available.';
  units[14].text = 'The attachment is available.';
  units[15] = {
    ...units[15], speaker: 'Morgan',
    text: "I'll send the revised safety report."
  };
  const actions = [action(['T0003', 'T0004', 'T0016', 'T0016'])];
  const snapshot = structuredClone({ units, actions });
  for (const unit of units) Object.freeze(unit);
  Object.freeze(units);
  Object.freeze(actions[0].owners);
  Object.freeze(actions[0].evidenceIds);
  Object.freeze(actions[0]);
  Object.freeze(actions);

  const item = V.finalActionLifecycleCheckItems(actions, units)[0];
  const expected = [...units.slice(0, 9), ...units.slice(13, 20)];
  assert.deepEqual(item.passage.split('\n'), passageLines(expected));
  assert.equal(item.passage.split('\n').filter((line) => line === 'Chair: The attachment is available.').length, 2);
  assert.deepEqual({ units, actions }, snapshot);
});

test('final lifecycle evidence orders a retained duplicate ID by its actual source occurrence', () => {
  const units = Array.from({ length: 20 }, (_, index) => ({
    id: `T${String(index + 1).padStart(4, '0')}`,
    speaker: 'Chair',
    text: `Agenda transition ${index + 1}.`
  }));
  // Duplicate IDs are tolerated by source normalization. Existing source-ID
  // deduplication retains the earlier occurrence in the selected windows.
  units[2] = { ...units[2], id: 'T0016', text: 'The report attachment is available.' };
  units[15] = { ...units[15], speaker: 'Morgan', text: "I'll send the revised safety report." };
  const item = V.finalActionLifecycleCheckItems([action(['T0004', 'T0016'])], units)[0];
  const expected = [
    ...units.slice(0, 9), ...units.slice(13, 15), ...units.slice(16, 20)
  ];
  assert.deepEqual(item.passage.split('\n'), passageLines(expected));
  assert.equal(item.passage.split('\n').filter((line) => line.includes(units[2].text)).length, 1);
  assert.ok(!item.passage.includes(units[15].text), 'the preexisting first-occurrence selection stays unchanged');
});

test('final lifecycle evidence leaves missing-source actions and empty action lists unchanged', () => {
  assert.deepEqual(V.finalActionLifecycleCheckItems([], [{ id: 'T0001', speaker: 'Chair', text: 'Hello.' }]), []);
  assert.deepEqual(V.finalActionLifecycleCheckItems([action(['T9999'])], []), []);
  assert.deepEqual(V.finalActionLifecycleCheckItems([action(['T0001'], { action: '' })], [
    { id: 'T0001', speaker: 'Chair', text: 'Hello.' }
  ]), []);
});
