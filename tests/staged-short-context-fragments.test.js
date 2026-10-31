'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { normaliseSourceUnits, preparedTranscriptFromUnits } = require('../utils/meetingMinutesAgentV2');

function offlinePreparation() {
  const filename = path.join(__dirname, '../utils/stagedMiniLmTrooper.js');
  const calls = [];
  const module = { exports: {} };
  const sourceUnits = [
    { id: 'T0001', speaker: 'Morgan Hale', timestamp: '0:12', text: 'Conditional. We will review the proposed plan tomorrow.', classification: 'keep', confidence: 0.99 },
    { id: 'T0002', speaker: 'Sam Lee', timestamp: '0:14', text: 'No. We can publish the revised plan.', classification: 'uncertain', confidence: 0.6 },
    { id: 'T0003', speaker: 'Jordan Park', timestamp: '0:16', text: 'I need to sneeze.', classification: 'remove', confidence: 0.99 },
    { id: 'T0004', speaker: 'Morgan Hale', timestamp: '0:18', text: 'We have not agreed the revised plan. Not approved.', classification: 'keep', confidence: 0.99 },
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
            ok: true, totalUnitCount: 4, keptUnitCount: 3, removedUnitCount: 1,
            preparedTranscript: 'Offline preparation retains bounded source context. '.repeat(4), sourceUnits,
          }));
          child.emit('close', 0);
        });
        return child;
      } };
    },
  }, { filename });
  return { prepare: module.exports.prepareMiniLmTranscript, calls };
}

test('short source context is an explicit option independent of standalone replies and dates', async () => {
  const offline = offlinePreparation();
  await offline.prepare('A complete synthetic transcript for offline preparation.');
  await offline.prepare('A complete synthetic transcript for offline preparation.', { preserveShortContextFragments: false });
  const result = await offline.prepare('A complete synthetic transcript for offline preparation.', { preserveShortContextFragments: true });
  assert.equal(offline.calls.length, 3);
  assert.equal(offline.calls[0].args.includes('--preserve-short-context-fragments'), false);
  assert.equal(offline.calls[1].args.includes('--preserve-short-context-fragments'), false);
  assert.equal(offline.calls[2].args.includes('--preserve-short-context-fragments'), true);
  assert.ok(offline.calls.every(call => !call.args.includes('--keep-short-replies')));
  assert.ok(offline.calls.every(call => !call.args.includes('--preserve-short-temporal-fragments')));

  const persisted = JSON.parse(JSON.stringify(normaliseSourceUnits(result.sourceUnits)));
  assert.deepEqual(persisted.map(unit => [unit.id, unit.speaker, unit.timestamp, unit.classification]), [
    ['T0001', 'Morgan Hale', '0:12', 'keep'],
    ['T0002', 'Sam Lee', '0:14', 'uncertain'],
    ['T0003', 'Jordan Park', '0:16', 'remove'],
    ['T0004', 'Morgan Hale', '0:18', 'keep'],
  ]);
  assert.equal(preparedTranscriptFromUnits(persisted), [
    '[T0001] Morgan Hale 0:12: Conditional. We will review the proposed plan tomorrow.',
    '[T0002] Sam Lee 0:14: No. We can publish the revised plan.',
    '[T0004] Morgan Hale 0:18: We have not agreed the revised plan. Not approved.',
  ].join('\n'));
  assert.ok(persisted.every(unit => !('owners' in unit) && !('timing' in unit) && !('action' in unit)));
});

test('the source-context option and preparation marker belong only to Agent preparation', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/api.js'), 'utf8');
  const start = source.indexOf("router.post('/meeting-minutes-agent/prepare'");
  assert.ok(start >= 0);
  const end = source.indexOf('\nregisterMeetingMinutesLibraryList(router)', start + 1);
  const route = source.slice(start, end < 0 ? source.length : end);
  assert.match(route, /prepareMiniLmTranscript\(transcript\.text,\s*\{[\s\S]*?preserveShortContextFragments:\s*true/);
  assert.equal((source.match(/preserveShortContextFragments:\s*true/g) || []).length, 1);
  assert.match(route, /shortContextFragmentsVersion:\s*1/);
  assert.match(route, /MEETING_MINUTES_AGENT_KEEP_SHORT_REPLIES_V1\s*\|\|\s*'0'/);
});
