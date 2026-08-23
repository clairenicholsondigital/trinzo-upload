'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runCanonicalLiveStage } = require('../utils/canonicalMinutes/liveStages');

// The executive summary opens with the purpose, byte-identical.
//
// The summary is composed as purpose-sentence-then-spine, so the purpose appears twice on
// the same screen: in its own field and as the summary's opening. The field is protected
// from copy-editing; the summary was not, so the LLM grammar pass could rewrite the
// opening into "The session focused on..." while the field above it said something else.
// Two renderings of one sentence on one screen is how a reviewer learns to trust neither.
//
// This is the invariant, asserted at the seam the pages actually read. The grammar pass
// itself is free to change - it can no longer produce the divergence, rather than merely
// not producing it today.

const TRANSCRIPTS = [
  // One per purpose source that composes a summary this way.
  ['scripts/transcript-tests/001_status_review/transcript.txt', 'Daily AI Check In', 'Project review'],            // title_transform
  ['scripts/meeting-minutes-final-golden/021_real_dita_importer_obligations_transcript/transcript.txt',
    'Client DITA T819 Importer Obligations review plan', 'Importer obligations review'],                            // meeting_type_profile
  ['scripts/meeting-minutes-core-golden/human_benchmarks', '', '']                                                  // placeholder trimmed below
].filter(([file]) => file.endsWith('.txt'));

test('the executive summary begins with the purpose, whatever produced the purpose', { timeout: 600000 }, () => {
  for (const [file, title, type] of TRANSCRIPTS) {
    const text = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
    const result = runCanonicalLiveStage(text, {
      stage: 'summary',
      fileName: path.basename(file),
      confirmed: { details: { meetingTitle: title, meetingType: type } }
    });
    const summary = result.screens.summary;
    const purpose = String(summary.meetingPurpose || '').trim();
    assert.ok(purpose, `${file}: a purpose is produced`);
    assert.ok(
      String(summary.executiveSummary || '').startsWith(purpose),
      `${file}: the summary must open with the purpose byte-identical.\n  purpose: ${purpose}\n  summary: ${String(summary.executiveSummary || '').slice(0, 160)}`
    );
  }
});

test('a reviewer-confirmed purpose leads the summary the same way', { timeout: 600000 }, () => {
  const file = 'scripts/transcript-tests/001_status_review/transcript.txt';
  const text = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const reviewerPurpose = 'Check in on the AI programme and unblock the stalled items.';
  const result = runCanonicalLiveStage(text, {
    stage: 'summary',
    fileName: '001.txt',
    confirmed: {
      details: { meetingTitle: 'Daily AI Check In', meetingType: 'Project review' },
      summary: { meetingPurpose: reviewerPurpose }
    }
  });
  const summary = result.screens.summary;
  assert.equal(summary.meetingPurpose, reviewerPurpose);
  assert.ok(
    String(summary.executiveSummary || '').startsWith(reviewerPurpose),
    `summary must open with the reviewer's own purpose.\n  summary: ${String(summary.executiveSummary || '').slice(0, 160)}`
  );
});

test('the grammar pass is fenced off from the prefix in the code that calls it', () => {
  // The behavioural tests above run without the LLM (the polish is a network call), so
  // this pins the seam itself: the call site must split the purpose off before polishing
  // and reattach it verbatim.
  const api = fs.readFileSync(path.resolve(__dirname, '../routes/api.js'), 'utf8');
  const site = api.slice(api.indexOf('const executiveSummaryIsConfirmed'), api.indexOf('return {', api.indexOf('const executiveSummaryIsConfirmed')));
  assert.match(site, /presentationSummary\.startsWith\(summaryPurpose\)/, 'the prefix is detected');
  assert.match(site, /presentationSummary\.slice\(summaryPurpose\.length\)/, 'only the remainder is polished');
  assert.match(site, /`\$\{summaryPurpose\} \$\{executiveSummaryGrammar\.text\}`/, 'the prefix is reattached byte-identical');
});
