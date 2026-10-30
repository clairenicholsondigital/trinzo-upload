'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMeetingMinutesPeopleEvidence } = require('../utils/meetingMinutesPeopleEvidence');

// Pure assignment/acceptance checks do not need transcript or flag services.
const { assignsWorkTo, addressedRequestAccepted } = createMeetingMinutesPeopleEvidence({});

// Source-backed checks use the real shared context, flag registry and action
// disposition policy, just as the compatibility entrypoint composes them.
function peopleEvidence() {
  const V = require('../utils/meetingMinutesAgentV2');
  return createMeetingMinutesPeopleEvidence({
    evidenceContextFor: V.evidenceContextFor,
    normaliseFlag: V.normaliseFlag,
    actionEvidenceDisposition: V.actionEvidenceDisposition
  });
}

test('read-back, possessive and ongoing forms count as assigning work', () => {
  assert.ok(assignsWorkTo('Robin', 'Priya drafts the agenda, Robin sends it, and we meet again next week.'));
  assert.ok(assignsWorkTo('Robin', "Updating the supplier list is Robin's priority action this week."));
  assert.ok(assignsWorkTo('Robin', 'Robin has been working through the supplier contracts.'));
  assert.ok(!assignsWorkTo('Robin', 'Robin mentioned the contracts were late last year.'));
});


test('an addressed request answered without refusal is an accepted request', () => {
  const lines = [
    { speaker: 'Chair', text: 'Sam, on those two points, is that something you can write up for the board?' },
    { speaker: 'Sam', text: "It'll be Thursday though, I'm travelling until then." }
  ];
  assert.ok(addressedRequestAccepted('Sam', lines));
  assert.ok(!addressedRequestAccepted('Sam', [lines[0], { speaker: 'Sam', text: "No, I can't take that on this month." }]));
});


test('a declarative assignment to someone who is only talked about keeps them as owner', () => {
  assert.ok(assignsWorkTo('Priya', "So Priya, and I think Tom, you're involved in that review as well next week."));
});


test("'Name, your main focus is ...' assigns the work", () => {
  assert.ok(assignsWorkTo('Tom', 'And Tom, your main focus then really is to finish the venue risk assessment.'));
});

test('a row naming someone absent from its citation is repaired when a nearby line supplies them', () => {
  const V = peopleEvidence();
  const units = [
    { id: 'T0031', speaker: 'Rebecca Gill', text: "I can't remember the first one, but it was a quick amend." },
    { id: 'T0032', speaker: 'Rebecca Gill', text: 'And then the second one, I just kind of put a bit more detail into the use of kind of FMEAs to, as a way of measuring risk across software, hardware and various different things.' },
    { id: 'T0033', speaker: 'Rebecca Gill', text: "So I've kind of put the detail a wee bit more in there.I don't know, David, if you want to maybe have a pop in, have an RV look at that, just make sure I'm along the right lines." },
    { id: 'T0034', speaker: 'David Didsbury', text: 'Yes, I will take a look at that this week.' }
  ];
  const out = V.groundRowAttributions([{
    topic: 'Risk', points: [{ text: 'David may require an RV to review the updated FMEA detail.', evidenceIds: ['T0032'] }]
  }], units);
  // T0033 is the line that actually names David and shares the row's content,
  // so it joins the citation and the reviewer can see the words that were said.
  assert.deepEqual(out.discussion[0].points[0].evidenceIds, ['T0032', 'T0033']);
  assert.equal(out.widened, 1);
  assert.equal(out.flags.length, 0);
});


test('a row naming someone no cited or nearby line mentions keeps its wording and is flagged', () => {
  const V = peopleEvidence();
  const units = [
    { id: 'T0063', speaker: 'Smith, Stuart M', text: "So it's a deep dive into their software management system." },
    { id: 'T0064', speaker: 'Smith, Stuart M', text: 'I think your expertise looking at the specifics associated with software and the dedicated time is what we need.' },
    { id: 'T0065', speaker: 'Smith, Stuart M', text: 'That is the shape of it.' },
    { id: 'T0200', speaker: 'Niamh Lynch', text: 'Understood, thanks.' }
  ];
  const text = 'Niamh will be the lead for the software deep dive.';
  const out = V.groundRowAttributions([{ topic: 'Audit', points: [{ text, evidenceIds: ['T0063', 'T0064'] }] }], units);
  assert.equal(out.discussion[0].points[0].text, text, 'the row is flagged, never reworded');
  assert.equal(out.flags.length, 1);
  assert.equal(out.flags[0].kind, 'attribution');
  assert.match(out.flags[0].message, /does not mention Niamh Lynch/);
  assert.ok(out.discussion[0].points[0].reviewFlagIds.includes(out.flags[0].id));
});


test('a row whose cited lines already name the person is left untouched', () => {
  const V = peopleEvidence();
  const units = [
    { id: 'T0027', speaker: 'Jacqui Fox', text: 'And David, you obviously had reviewed their risk management plan.' },
    { id: 'T0028', speaker: 'Jacqui Fox', text: "Rebecca, you've reviewed David feedback on that." }
  ];
  const out = V.groundRowAttributions([{
    topic: 'Risk', points: [{ text: 'Rebecca has reviewed David feedback on the risk management plan.', evidenceIds: ['T0027', 'T0028'] }]
  }], units);
  assert.equal(out.widened, 0);
  assert.equal(out.flags.length, 0);
});


test('a speaker named only by their surname in the row still counts as supported', () => {
  const V = peopleEvidence();
  const units = [
    { id: 'T0110', speaker: 'Ciaran Ryan', text: 'My submission is scheduled for Friday.' }
  ];
  const out = V.groundRowAttributions([{
    topic: 'Submission', points: [{ text: "Ciaran Ryan's submission is scheduled for Friday.", evidenceIds: ['T0110'] }]
  }], units);
  assert.equal(out.flags.length, 0, 'the speaker label supplies the person');
});


test('conflicting exclusive role assignments are jointly flagged without guessing a winner', () => {
  const V = peopleEvidence();
  const source = [
    { id: 'T0001', speaker: 'Morgan Reed', text: 'I will prepare the scope and the audit plan.' },
    { id: 'T0002', speaker: 'Riley Shaw', text: 'I will cover the specialist review in the second week.' }
  ];
  const discussion = [{
    id: 'topic-audit', topic: 'Audit team organisation',
    points: [
      { id: 'p1', text: 'The audit lead is identified as Riley.', evidenceIds: ['T0002'], reviewFlagIds: [] },
      { id: 'p2', text: 'Preparation starts next Monday; Morgan is the lead, working with Riley.', evidenceIds: ['T0001'], reviewFlagIds: [] }
    ], decisions: [], openQuestions: []
  }];
  const out = V.flagConflictingDiscussionRoles(discussion, source);
  assert.equal(out.conflicts.length, 1);
  assert.equal(out.flags.length, 1);
  assert.equal(out.flags[0].kind, 'uncertain_fact');
  assert.match(out.flags[0].message, /conflicting role assignment/i);
  assert.deepEqual(out.discussion[0].points.map((row) => row.reviewFlagIds), [[out.flags[0].id], [out.flags[0].id]]);
  assert.equal(out.discussion[0].points[0].text, discussion[0].points[0].text, 'ambiguous wording is not silently rewritten');
});


test('different qualified lead roles do not conflict', () => {
  const V = peopleEvidence();
  const source = [
    { id: 'T0001', speaker: 'Morgan Reed', text: 'I am covering the project.' },
    { id: 'T0002', speaker: 'Riley Shaw', text: 'I am covering the technical review.' }
  ];
  const out = V.flagConflictingDiscussionRoles([{
    topic: 'Programme roles',
    points: [
      { text: 'Morgan is the project lead.', evidenceIds: ['T0001'], reviewFlagIds: [] },
      { text: 'Riley is the technical lead.', evidenceIds: ['T0002'], reviewFlagIds: [] }
    ], decisions: [], openQuestions: []
  }], source);
  assert.equal(out.conflicts.length, 0);
  assert.equal(out.flags.length, 0);
});


test('reviewer-authored role wording is not challenged by the generated-role guard', () => {
  const V = peopleEvidence();
  const source = [
    { id: 'T0001', speaker: 'Morgan Reed', text: 'I am covering the audit.' },
    { id: 'T0002', speaker: 'Riley Shaw', text: 'I am covering the specialist review.' }
  ];
  const out = V.flagConflictingDiscussionRoles([{
    topic: 'Audit roles',
    points: [
      { text: 'Morgan is the audit lead.', evidenceIds: ['T0001'], reviewFlagIds: [] },
      { text: 'Riley is the audit lead.', evidenceIds: ['T0002'], reviewFlagIds: [], reviewerAuthored: true }
    ], decisions: [], openQuestions: []
  }], source);
  assert.equal(out.conflicts.length, 0);
  assert.equal(out.flags.length, 0);
});

