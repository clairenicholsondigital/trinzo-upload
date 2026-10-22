'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { normaliseSourceUnits, preparedTranscriptFromUnits } = require('../utils/meetingMinutesAgentV2');

function offlinePreparationModule() {
  const filename = path.join(__dirname, '../utils/stagedMiniLmTrooper.js');
  const calls = [];
  const module = { exports: {} };
  const sourceUnits = [
    { id: 'T0001', speaker: 'Morgan Hale', timestamp: '0:12', text: 'I will review the proposed plan and report any concerns.', classification: 'keep' },
    { id: 'T0002', speaker: 'Sam Lee', timestamp: '0:13', text: 'Oh, probably Friday.', classification: 'uncertain' },
    { id: 'T0003', speaker: 'Jordan Park', timestamp: '0:14', text: 'Not before Monday.', classification: 'uncertain' },
  ];
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename), process, setTimeout, clearTimeout,
    require(name) {
      if (name !== 'child_process') return require(name);
      return { spawn(command, args) {
        calls.push({ command, args: [...args] });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => true;
        queueMicrotask(() => {
          child.stdout.emit('data', JSON.stringify({
            ok: true, totalUnitCount: 3, keptUnitCount: 3, removedUnitCount: 0,
            preparedTranscript: 'Offline preparation context retained. '.repeat(5), sourceUnits,
          }));
          child.emit('close', 0);
        });
        return child;
      } };
    },
  }, { filename });
  return { prepare: module.exports.prepareMiniLmTranscript, calls };
}

test('short temporal preservation is an explicit preparation option without enabling general replies', async () => {
  const offline = offlinePreparationModule();
  await offline.prepare('A complete synthetic transcript for offline preparation.');
  const result = await offline.prepare('A complete synthetic transcript for offline preparation.', { preserveShortTemporalFragments: true });
  assert.equal(offline.calls.length, 2);
  assert.equal(offline.calls[0].args.includes('--preserve-short-temporal-fragments'), false);
  assert.equal(offline.calls[1].args.includes('--preserve-short-temporal-fragments'), true);
  assert.ok(offline.calls.every(call => !call.args.includes('--keep-short-replies')));

  const units = normaliseSourceUnits(result.sourceUnits);
  const persisted = JSON.parse(JSON.stringify(units));
  assert.deepEqual(persisted.map(unit => [unit.id, unit.speaker, unit.timestamp, unit.text]), [
    ['T0001', 'Morgan Hale', '0:12', 'I will review the proposed plan and report any concerns.'],
    ['T0002', 'Sam Lee', '0:13', 'Oh, probably Friday.'],
    ['T0003', 'Jordan Park', '0:14', 'Not before Monday.'],
  ]);
  assert.match(preparedTranscriptFromUnits(persisted), /\[T0002\] Sam Lee 0:13: Oh, probably Friday\./);
  assert.match(preparedTranscriptFromUnits(persisted), /\[T0003\] Jordan Park 0:14: Not before Monday\./);
  assert.ok(persisted.every(unit => !('owners' in unit) && !('timing' in unit) && !('action' in unit)));
});

test('the opt-in is confined to the meeting-minutes-agent preparation route', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/api.js'), 'utf8');
  const start = source.indexOf("router.post('/meeting-minutes-agent/prepare'");
  assert.ok(start >= 0);
  const end = source.indexOf('\nrouter.', start + 1);
  const route = source.slice(start, end < 0 ? source.length : end);
  assert.match(route, /prepareMiniLmTranscript\(transcript\.text,\s*\{[\s\S]*?preserveShortTemporalFragments:\s*true/);
  assert.equal((source.match(/preserveShortTemporalFragments:\s*true/g) || []).length, 1);
  assert.match(route, /MEETING_MINUTES_AGENT_KEEP_SHORT_REPLIES_V1\s*\|\|\s*'0'/);
});

test('normalisation and publication retain whole short cancellation and qualification units', () => {
  const source = [
    { id: 'T0007', speaker: 'Morgan Hale', timestamp: '0:12', text: 'No. Wednesday.', classification: 'uncertain' },
    { id: 'T0008', speaker: 'Sam Lee', timestamp: '0:14', text: 'Friday. Changed my mind.', classification: 'uncertain' },
  ];
  const stored = normaliseSourceUnits(JSON.parse(JSON.stringify(source)));
  assert.deepEqual(stored.map(unit => [unit.id, unit.speaker, unit.timestamp, unit.text]), source.map(unit => [unit.id, unit.speaker, unit.timestamp, unit.text]));
  assert.equal(preparedTranscriptFromUnits(stored), '[T0007] Morgan Hale 0:12: No. Wednesday.\n[T0008] Sam Lee 0:14: Friday. Changed my mind.');
});
