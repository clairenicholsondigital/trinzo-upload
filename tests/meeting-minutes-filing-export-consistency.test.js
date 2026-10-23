'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { orderedEntries } = require('../public/meeting-minutes-filing-order');
const { orderedFilingSupportingDetails } = require('../utils/meetingMinutesSupportingDetails');
const row = (id, evidenceIds, extra = {}) => ({ id, text: 'Retained calibration context ' + id + '.', evidenceIds, ...extra });
const units = [{ id: 'late', sequence: 9 }, { id: 'early', sequence: 1 }, { id: 'middle', sequence: 4 }];
test('browser and server execute the same ordering module', () => {
  const browser = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/meeting-minutes-filing-order'), 'utf8'), browser);
  const pool = [row('last', ['late']), row('first', ['early']), row('mid', ['middle'])];
  const before = structuredClone(pool);
  const client = browser.MeetingMinutesFilingOrder.orderedEntries(pool, units);
  assert.deepEqual(Array.from(client, entry => entry.index), [1, 2, 0]);
  assert.deepEqual(Array.from(client, entry => entry.detail.id), orderedEntries(pool, units).map(entry => entry.detail.id));
  assert.deepEqual(orderedFilingSupportingDetails(pool, units).map(detail => detail.id), ['first', 'mid', 'last']);
  assert.equal(client[0].detail, pool[1]);
  assert.deepEqual(pool, before);
});
for (const [name, extra] of [
  ['reviewer authorship', { reviewerAuthored: true }],
  ['confirmed placement', { confirmedTopic: true }],
  ['human confirmation', { source: 'stage_2_human_confirmation' }],
  ['manual identity', { id: 'manual-fixed' }],
  ['reviewer identity', { id: 'reviewer-fixed' }]
]) test(name + ' retains its screen position', () => {
  const pool = [row('last', ['late']), row('fixed', ['middle'], extra), row('first', ['early'])];
  const output = orderedEntries(pool, units);
  assert.deepEqual(output.map(entry => entry.index), [2, 1, 0]);
  assert.equal(output[1].detail, pool[1]);
});
test('equal positions, unknown citations and absent sources remain stable', () => {
  const pool = [row('unknown-a', ['missing']), row('early-a', ['early']), row('early-b', ['early']), row('unknown-b', [])];
  assert.deepEqual(orderedEntries(pool, units).map(entry => entry.index), [1, 2, 0, 3]);
  assert.deepEqual(orderedEntries(pool, []).map(entry => entry.index), [0, 1, 2, 3]);
});
test('explicit sequence, array fallback and duplicate source IDs match screen rules', () => {
  const sources = [{ id: 'a', sequence: -1 }, { id: 'b', sequence: Infinity }, { id: 'a', sequence: 99 }, { id: 'c', sequence: 0.5 }];
  const pool = [row('b', ['b']), row('a', ['a']), row('c', ['c'])];
  assert.deepEqual(orderedEntries(pool, sources).map(entry => entry.index), [2, 1, 0]);
});
test('export projection combines exact duplicates and retains all placement origins', () => {
  const first = row('first', ['late', 'early'], { originalTopic: 'Equipment', placementReason: 'no_unique_parent' });
  const copy = { ...first, id: 'second', evidenceIds: ['early', 'late'], originalTopic: 'Inspection', placementReason: 'parent_not_publishable' };
  const input = [first, copy], before = structuredClone(input);
  const [result] = orderedFilingSupportingDetails(input, units);
  assert.equal(orderedFilingSupportingDetails(input, units).length, 1);
  assert.deepEqual(result.mergedFromIds, ['second']);
  assert.deepEqual(result.filingOrigins.map(origin => origin.originalTopic), ['Equipment', 'Inspection']);
  assert.deepEqual(input, before);
});
test('export projection retains different evidence, warnings, wording and reviewer rows', () => {
  const first = row('first', ['early']);
  const input = [first, { ...first, id: 'different-source', evidenceIds: ['late'] },
    { ...first, id: 'warning', reviewFlagIds: ['check'] },
    { ...first, id: 'wording', text: first.text + ' Pending review.' },
    { ...first, id: 'reviewer-copy', reviewerAuthored: true }];
  assert.equal(orderedFilingSupportingDetails(input, units).length, input.length);
});
test('page loads the shared helper before the browser application', () => {
  const html = fs.readFileSync(require.resolve('../views/meeting-minutes-agent.html'), 'utf8');
  const helper = html.indexOf('<script defer src="/static/meeting-minutes-filing-order.js">');
  const app = html.indexOf('<script defer src="/static/meeting-minutes-agent.js">');
  assert.ok(helper >= 0 && app > helper);
});
