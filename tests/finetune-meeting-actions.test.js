const assert = require('node:assert/strict');
const test = require('node:test');

const { _private } = require('../utils/finetuneMeetingActions');

test('normalizes action rows and fills an absent owner', () => {
  assert.deepEqual(_private.normalizeActions([
    { action: '  Review   the plan ', owner: ' Bob ' },
    { action: 'Send notes', owner: '' },
    { action: '   ', owner: 'Alice' }
  ]), [
    { action: 'Review the plan', owner: 'Bob' },
    { action: 'Send notes', owner: 'Not stated' }
  ]);
});

test('rejects a malformed model payload', () => {
  assert.throws(() => _private.normalizeActions(null), /no actions array/i);
});
