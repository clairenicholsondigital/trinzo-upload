const assert = require('node:assert/strict');
const test = require('node:test');

const { _private } = require('../utils/finetuneMeetingActions');

test('normalizes Trooper action rows and requires evidence', () => {
  assert.deepEqual(_private.normalizeActions([
    { action: '  Review   the plan ', owner: ' Bob ', deadline: ' Friday ', evidence: ' I will review it. ', chunkNumber: 2, turnRange: '4-8' },
    { action: 'Send notes', owner: '', evidence: 'I will send the notes.' },
    { action: '   ', owner: 'Alice' }
  ]), [
    { action: 'Review the plan', owner: 'Bob', deadline: 'Friday', evidence: 'I will review it.', chunkNumber: 2, turnRange: '4-8' },
    { action: 'Send notes', owner: 'Unclear', deadline: 'Not stated', evidence: 'I will send the notes.', chunkNumber: null, turnRange: '' }
  ]);
});

test('rejects a malformed model payload', () => {
  assert.throws(() => _private.normalizeActions(null), /no actions array/i);
});
