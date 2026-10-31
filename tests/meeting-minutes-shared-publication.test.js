'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('Word export works without loading the legacy generation module', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const JSZip = require('jszip');
    const legacy = require.resolve('./utils/meetingMinutesAgentV2');
    const { generateMeetingMinutesAgentDocx } = require('./utils/meetingMinutesAgentDocx');
    assert.equal(require.cache[legacy], undefined);
    (async () => {
      const draft = {
        details: { meetingTitle: 'Shared export', internalAttendees: [] },
        discussion: [], sourceUnits: [],
        actions: [{ action: 'Review the file.', owners: ['Alex'],
          timing: { kind: 'dependency', wording: 'after approval', exactDate: '' } }]
      };
      const zip = await JSZip.loadAsync(await generateMeetingMinutesAgentDocx(draft));
      const xml = await zip.file('word/document.xml').async('string');
      assert.ok(xml.includes('Review the file.'));
      assert.ok(xml.includes('after approval'));
      assert.equal(require.cache[legacy], undefined);
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || String(result.error || ''));
});

test('legacy callers retain the shared text and timing function exports', () => {
  const legacy = require('../utils/meetingMinutesAgentV2');
  const text = require('../utils/meetingMinutesText');
  // These are public V2 aliases. recordLabel and salientExcerpt remain private
  // to V2 even though their shared owner also exports them for other consumers.
  const textExports = ['normaliseColloquialTimes', 'normaliseKnownTerms', 'normaliseKnownTermsDeep',
    'isAutomaticTerminologyFlag', 'cleanActionWording', 'isIdeaOnlyContemplation', 'normaliseExecutiveSummary'];
  const legacyText = Object.fromEntries(textExports.map(name => [name, text[name]]));
  for (const helpers of [legacyText, require('../utils/meetingMinutesTimingPublication')]) {
    for (const [name, value] of Object.entries(helpers)) {
      if (name !== 'text' && typeof value === 'function') assert.equal(legacy[name], value, name);
    }
  }
});
