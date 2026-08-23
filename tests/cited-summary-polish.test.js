'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateInitialUnderstandingRevision
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
