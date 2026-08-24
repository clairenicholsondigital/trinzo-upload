'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateInitialUnderstandingRevision,
  stripInlineCitations
} = require('../utils/stagedInitialUnderstandingPolish');

// The cited-revision validator: enrichment is earned per claim against the turns the
// claim cites, which is the discussion stage's model applied to the summary. Every test
// here pins a behaviour that failed invisibly in diagnosis - the validator refusing
// grounded detail, the fallback reproducing the thin output, and nobody able to tell.

const original = {
  meetingTitle: 'Eakin software and technical file weekly check-in',
  meetingPurpose: 'Coordinate progress for the software-change and technical-file programme.',
  objectives: ['Review alarm-code and clinical confirmation.', 'Confirm electrical compliance evidence.'],
  overallTopics: ['Alarm behaviour and controls', 'Electrical compliance evidence'],
  executiveSummary: 'Coordinate progress for the software-change and technical-file programme. It covered alarm behaviour and electrical compliance.'
};

const pack = [{
  itemIndex: 0,
  topic: 'meeting_summary_evidence',
  evidence: [
    { id: 'evt_1', speaker: 'Colm', previous: '', current: 'The alarm sound and colour changes are largely working now.', next: '' },
    { id: 'evt_2', speaker: 'Orla', previous: '', current: 'Mute button behaviour still needs the clinical review before we sign it off.', next: '' },
    { id: 'evt_3', speaker: 'Colm', previous: '', current: 'IEC 60601 electrical testing should complete by the 23rd of July.', next: '' },
    { id: 'evt_4', speaker: 'Jenny', speaker2: '', previous: '', current: 'Everyone agreed the release plan for the seventeen historical changes.', next: '' }
  ]
}];

const cited = (text, ids) => ({ text, evidenceIds: ids });

test('cited enrichment is accepted, including facts absent from the input fields', () => {
  // "IEC 60601" and "23rd of July" appear in no input field. The old validator hard
  // rejected them as new_protected_fact; with citations they are checked against the
  // cited turn instead - which contains them.
  const result = validateInitialUnderstandingRevision(original, {
    meetingPurpose: cited('Coordinate the software and technical file work and confirm testing progress.', ['evt_1', 'evt_3']),
    objectives: [
      cited('Confirm the status of alarm software changes and outstanding validation.', ['evt_1', 'evt_2']),
      cited('Confirm electrical compliance testing progress against the IEC 60601 timetable.', ['evt_3'])
    ],
    executiveSummary: cited('The team reviewed alarm software changes and electrical compliance. Alarm sound and colour changes were largely working, with mute-button behaviour awaiting clinical review. IEC 60601 testing was expected to complete by the 23rd of July.', ['evt_1', 'evt_2', 'evt_3'])
  }, pack);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.reason, 'accepted_cited');
  assert.match(result.executiveSummary, /IEC 60601/);
  assert.equal(result.fieldOutcomes.purpose, 'accepted');
  assert.equal(result.fieldOutcomes.summary, 'accepted');
  assert.equal(result.fieldOutcomes.objectives.accepted, 2);
});

test('an uncited fact is still a hard reject for its field', () => {
  const result = validateInitialUnderstandingRevision(original, {
    meetingPurpose: cited('Coordinate the software and technical file work.', ['evt_1']),
    objectives: [cited('Confirm the status of alarm software changes and validation.', ['evt_1'])],
    // "MDR submission in March" appears in no cited turn and no input field.
    executiveSummary: cited('The team reviewed alarm changes ahead of the MDR submission in March.', ['evt_1'])
  }, pack);
  assert.equal(result.ok, true, 'other fields survive');
  assert.equal(result.fieldOutcomes.summary, 'new_protected_fact');
  assert.equal(result.executiveSummary, original.executiveSummary, 'the summary keeps the deterministic original');
});

test('an outcome verb needs an agreement cue in the cited turns', () => {
  // The only verb-level check in the system. evt_1 says "largely working" - status, not
  // agreement - so "the team agreed the alarm changes" is refused; evt_4 contains
  // "agreed", so a claim citing it stands.
  const refused = validateInitialUnderstandingRevision(original, {
    meetingPurpose: cited('Coordinate the software and technical file work.', ['evt_1']),
    objectives: [cited('Confirm the status of alarm software changes and validation.', ['evt_1'])],
    executiveSummary: cited('The team agreed the alarm software changes.', ['evt_1'])
  }, pack);
  assert.equal(refused.fieldOutcomes.summary, 'unsupported_outcome_verb');

  const accepted = validateInitialUnderstandingRevision(original, {
    meetingPurpose: cited('Coordinate the software and technical file work.', ['evt_1']),
    objectives: [cited('Confirm the status of alarm software changes and validation.', ['evt_1'])],
    executiveSummary: cited('The team agreed the release plan for the seventeen historical changes.', ['evt_4'])
  }, pack);
  assert.equal(accepted.fieldOutcomes.summary, 'accepted', JSON.stringify(accepted.fieldOutcomes));
});

test('citations must exist and must resolve', () => {
  const missing = validateInitialUnderstandingRevision(original, {
    meetingPurpose: { text: 'Coordinate the software and technical file work.' },
    objectives: [cited('Confirm the status of alarm software changes and validation.', ['evt_1'])],
    executiveSummary: cited('The team reviewed alarm software changes.', ['evt_1'])
  }, pack);
  assert.equal(missing.fieldOutcomes.purpose, 'missing_citation');

  const invalid = validateInitialUnderstandingRevision(original, {
    meetingPurpose: cited('Coordinate the software and technical file work.', ['evt_999']),
    objectives: [cited('Confirm the status of alarm software changes and validation.', ['evt_1'])],
    executiveSummary: cited('The team reviewed alarm software changes.', ['evt_1'])
  }, pack);
  assert.equal(invalid.fieldOutcomes.purpose, 'invalid_citation');
});

test('a bad objective is dropped and the rest kept - partial acceptance', () => {
  const result = validateInitialUnderstandingRevision(original, {
    meetingPurpose: cited('Coordinate the software and technical file work.', ['evt_1']),
    objectives: [
      cited('Confirm the status of alarm software changes and outstanding validation.', ['evt_1']),
      cited('We should probably look at the thing.', ['evt_1']),
      // Not "this quarter": the cited turn says July, and an unsupported timing claim is
      // exactly what the ratio should refuse - the first draft of this test proved it.
      cited('Confirm electrical compliance testing progress against the IEC 60601 timetable.', ['evt_3'])
    ],
    executiveSummary: cited('The team reviewed alarm software changes and electrical compliance.', ['evt_1', 'evt_3'])
  }, pack);
  assert.equal(result.ok, true);
  // Two survivors plus the deterministic floor topping up to the cap - a rejected cited
  // objective must not cost the reviewer lines the floor already validated.
  assert.ok(result.objectives.length >= 2, JSON.stringify(result.objectives));
  assert.ok(result.objectives.some((text) => /alarm software changes and outstanding validation/.test(text)), 'survivors lead');
  assert.equal(result.fieldOutcomes.objectives.rejected, 1);
  assert.ok(result.fieldOutcomes.objectives.reasons.includes('first_or_second_person_objective'));
});

test('when nothing survives, the whole revision is refused loudly', () => {
  const result = validateInitialUnderstandingRevision(original, {
    meetingPurpose: { text: 'Coordinate things.' },
    objectives: [{ text: 'Short.' }],
    executiveSummary: { text: 'We agreed everything.' }
  }, pack);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_cited_field_survived');
  assert.ok(result.fieldOutcomes, 'the outcomes travel with the refusal so telemetry can show why');
});

test('with no pack the validator is the old validator, near-verbatim only', () => {
  // The pack-less 0.08 path was never pinned; now it is, as it truly is: there is no
  // stemming, so even "coordinated" against a source that says "coordinate" counts as a
  // new content word, and the ~one-word budget on a summary this size rejects it. That
  // severity is WHY every pre-existing acceptance test rode the lenient 0.42 branch -
  // and why enrichment had to come with citations rather than by loosening this.
  const verbatimish = {
    meetingPurpose: original.meetingPurpose,
    objectives: original.objectives,
    executiveSummary: 'Coordinate progress for the software-change and technical-file programme. It covered electrical compliance and alarm behaviour.'
  };
  assert.equal(validateInitialUnderstandingRevision(original, verbatimish).ok, true, 'reordering within the source vocabulary passes');

  const morphed = {
    ...verbatimish,
    executiveSummary: 'The meeting coordinated progress across the software change and technical file programme, covering alarm behaviour and electrical compliance.'
  };
  assert.equal(validateInitialUnderstandingRevision(original, morphed).ok, false, 'even morphological drift fails the 0.08 path');
});

test('pack-less growth past 1.3x is rejected; compression is still sanctioned', () => {
  // The length_changed early-return carried no overlap property and the null-guarded
  // overlap check silently skipped, so unbounded growth passed while modest growth was
  // checked. Closed on the growth side only: this pass may deliberately compress.
  const grown = {
    meetingPurpose: original.meetingPurpose,
    objectives: original.objectives,
    executiveSummary: `${original.executiveSummary} ${original.executiveSummary} ${original.executiveSummary}`
  };
  const rejected = validateInitialUnderstandingRevision(original, grown);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'length_changed');

  const compressed = {
    meetingPurpose: original.meetingPurpose,
    objectives: original.objectives,
    executiveSummary: 'Coordinate progress across the programme.'
  };
  assert.equal(validateInitialUnderstandingRevision(original, compressed).ok, true);
});

// ---------------------------------------------------------------------------------
// What a reviewer actually saw, and why.
//
// The summary screen was printing the transcript back at people:
//
//   "Client M204 Larkfield MK Thursday Session. Tom, you're presenting so you should
//    have the green thing at the bottom. The plan is I open it, I do the housekeeping
//    bit, welcome everyone in, tell them mics are off..."
//
// Nothing was broken in the sense of throwing. The polish ran, produced a correct and
// well-written summary, and this validator refused it - so the screen fell back to the
// deterministic floor, which was built by quoting turns. Three separate rules in here
// were each answering a slightly different question from the one they were for, and the
// tests below pin the corrected questions.

test('an inflection of a word the meeting used is not new substance', () => {
  // The measured cause. On a real webinar rehearsal, nineteen of the summary's
  // forty-one words were counted as unsupported and the field was thrown away at a ratio
  // of 0.463 - for words like "rehearsing" beside "rehearse", "discussions" beside
  // "discussed" and "presenter's" beside "presenter". The gate meant to ask whether a
  // concept was in the meeting and was asking whether the model picked the same ending.
  const result = validateInitialUnderstandingRevision(original, {
    meetingPurpose: cited('Coordinate the software-change programme.', ['evt_1']),
    objectives: [cited('Review the alarm sounds and colour changes.', ['evt_1'])],
    executiveSummary: cited('Alarm sounds and colour changes were largely working. Muting behaviour still needed clinical reviews before sign-off. Electrical testing was scheduled for completion.', ['evt_1', 'evt_2', 'evt_3'])
  }, pack);
  assert.equal(result.fieldOutcomes.summary, 'accepted', JSON.stringify(result.fieldOutcomes));
});

test('prose about a different meeting is still refused', () => {
  // The thing worth pinning is refusal, not which gate gets there first. Widening the
  // vocabulary universe to the whole meeting is only safe because the gates around it
  // hold, and here the protected-fact check reaches this sentence before the ratio does.
  const result = validateInitialUnderstandingRevision(original, {
    meetingPurpose: cited('Coordinate the software-change programme.', ['evt_1']),
    objectives: [cited('Review alarm behaviour.', ['evt_1'])],
    executiveSummary: cited('The webinar rehearsal covered presenter handovers, audience question grouping, the closing slide QR code, microphone checks and dead air between speakers.', ['evt_1', 'evt_2'])
  }, pack);
  assert.notEqual(result.fieldOutcomes.summary, 'accepted', JSON.stringify(result.fieldOutcomes));
});

test('the vocabulary gate by itself refuses off-topic prose', () => {
  // The same sentence with nothing in it for the protected-fact or outcome-verb gates to
  // catch - no initialisms, no numbers, no "agreed" - so the only thing standing between
  // it and the summary field is the ratio. A summary of a rehearsal, cited against a
  // technical-file meeting, shares almost none of its vocabulary: two content words in
  // seventeen. That separation, not the threshold digit, is what the gate is.
  const result = validateInitialUnderstandingRevision(original, {
    meetingPurpose: cited('Coordinate the software-change programme.', ['evt_1']),
    objectives: [cited('Review alarm behaviour.', ['evt_1'])],
    executiveSummary: cited('The rehearsal covered presenter handovers, audience question grouping, the closing slide, microphone checks and dead air between speakers.', ['evt_1', 'evt_2'])
  }, pack);
  assert.equal(result.fieldOutcomes.summary, 'new_substantive_wording', JSON.stringify(result.fieldOutcomes));
});

test('one unresolvable citation does not throw away the ones that resolve', () => {
  // A summary cited six real turns and the string "BASIC_NOTES" - a section label from
  // our own prompt, echoed back - and the whole field was rejected. An id that resolves
  // to nothing adds nothing to the evidence a claim is checked against, so it can be
  // dropped instead of treated as a disqualification.
  const result = validateInitialUnderstandingRevision(original, {
    meetingPurpose: cited('Coordinate the software-change programme.', ['evt_1']),
    objectives: [cited('Review alarm behaviour.', ['evt_1'])],
    executiveSummary: cited('Alarm sounds and colour changes were largely working. Muting behaviour still needed clinical review.', ['evt_1', 'BASIC_NOTES', 'evt_2'])
  }, pack);
  assert.equal(result.fieldOutcomes.summary, 'accepted', JSON.stringify(result.fieldOutcomes));
});

test('a field whose citations all fail to resolve is still uncited', () => {
  const result = validateInitialUnderstandingRevision(original, {
    meetingPurpose: cited('Coordinate the software-change programme.', ['evt_1']),
    objectives: [cited('Review alarm behaviour.', ['evt_1'])],
    executiveSummary: cited('Alarm sounds and colour changes were largely working.', ['BASIC_NOTES', 'evt_999'])
  }, pack);
  assert.equal(result.fieldOutcomes.summary, 'invalid_citation', JSON.stringify(result.fieldOutcomes));
});

test('a claim still has to be carried by the turns it cites, not by the meeting at large', () => {
  // The widening is deliberately confined to vocabulary. Protected facts and outcome
  // verbs still read only the cited turns, because those are the checks that police
  // fabrication - "everyone agreed" is in evt_4, and a summary citing evt_1 may not
  // borrow it.
  const result = validateInitialUnderstandingRevision(original, {
    meetingPurpose: cited('Coordinate the software-change programme.', ['evt_1']),
    objectives: [cited('Review alarm behaviour.', ['evt_1'])],
    executiveSummary: cited('The team agreed the release plan for the seventeen historical changes.', ['evt_1'])
  }, pack);
  assert.equal(result.fieldOutcomes.summary, 'unsupported_outcome_verb', JSON.stringify(result.fieldOutcomes));
});

test('the prompt\'s own section labels never reach the reader', () => {
  // A residents' association read "a review of budget and commercial matters
  // (BASIC_NOTES)" on its summary screen. BASIC_NOTES is a heading this module writes into
  // its own prompt; the model echoed it back as prose. It is removed on the way out, the
  // same as a stray evt_0224, because what we put into the prompt is a closed set we can
  // strip without touching a word the meeting said.
  assert.equal(stripInlineCitations('a review of budget and commercial matters (BASIC_NOTES) and a discussion.').text,
    'a review of budget and commercial matters and a discussion.');
  assert.equal(stripInlineCitations('[MEETING_TITLE] Larkfield rehearsal').text, 'Larkfield rehearsal');
  // And nothing that merely looks like an initialism is touched.
  assert.equal(stripInlineCitations('A sentence about MDR and PPE conformity.').text, 'A sentence about MDR and PPE conformity.');
});
