const test = require('node:test');
const assert = require('node:assert');
const V = require('../utils/meetingMinutesAgentV2');

// Owners lost in traced runs on 2026-09-27 (drafts 1020, 1021, 1023, 1024), each
// removed by applyRequesterOwnerRule on the ground that the person was in the
// cited exchange without a parsed "I'll". Ten of ten removals were wrong.
const unit = (id, speaker, text) => ({ id, speaker, text });

test('a chair handing work to two named people with a modal keeps both', () => {
  const units = [
    unit('T0146', 'Jacqui Fox', 'I was going to say, if we take it offline, so Andrew, if you could just confirm what the spec of flow rate is.'),
    unit('T0147', 'Jacqui Fox', 'And then once we know that, we can review, David and Colm can review the standard again, just to understand, is that flow rate within the range of applicability within the standard?'),
    unit('T0148', 'Jacqui Fox', 'as to whether you need to consider.')
  ];
  assert.ok(V.assignsWorkTo('David', units[1].text));
  assert.ok(V.assignsWorkTo('Colm', units[1].text));
  assert.ok(!V.assignsWorkTo('Colm', "Colm can't review the standard this week."));
  const out = V.applyRequesterOwnerRule([{
    action: 'Review the applicability of ISO 27427:2023 against the device flow-rate specification once the flow rate is confirmed.',
    owners: ['David Didsbury', 'Colm'], evidenceIds: ['T0147']
  }], units);
  assert.deepEqual(out.actions[0].owners, ['David Didsbury', 'Colm']);
  assert.equal(out.flags.length, 0);
});

test('a person narrating their own work in progress owns it', () => {
  const units = [
    unit('T0178', 'Jacqui Fox', 'I know that the translated files are uploaded, but you had some restrictions around characters in relation to three of the languages.'),
    unit('T0179', 'Jacqui Fox', 'Has that been resolved or?'),
    unit('T0180', 'Andrew Kane', "Yeah, so I've added five of those languages that didn't have any issues into the code."),
    unit('T0181', 'Andrew Kane', "There's another four that there's some characters that aren't in the drivers at the minute."),
    unit('T0183', 'Andrew Kane', "So, I've been looking at that code, and I think those were generated using this tool, that font creator."),
    unit('T0185', 'Andrew Kane', "So, I'm trying to get access to that.")
  ];
  const out = V.applyRequesterOwnerRule([{
    action: 'Complete the remaining language implementation work by resolving missing character support in the drivers.',
    owners: ['Andrew Kane'], evidenceIds: ['T0178', 'T0181']
  }], units);
  assert.deepEqual(out.actions[0].owners, ['Andrew Kane']);
  assert.equal(out.flags.length, 0);
});

test('"I\'ve just been simulating real faults" answers "didn\'t you this afternoon, Andrew?"', () => {
  const units = [
    unit('T0116', 'David Didsbury', 'If the debug program that Andrew was running actually had those commands in, and he sent me a screenshot of the...'),
    unit('T0117', 'David Didsbury', "One of the O2 sensors, didn't you this afternoon, Andrew?"),
    unit('T0118', 'Andrew Kane', 'I sent you on a screenshot of the debug menu, yeah.'),
    unit('T0121', 'Andrew Kane', "So, there's some, you were asking about like the audio menu, which I haven't actually been using for this test and I've just been simulating real faults.")
  ];
  const out = V.applyRequesterOwnerRule([{
    action: 'Test the additional debug commands and observe the resulting behaviour on the system.',
    owners: ['Andrew Kane'], evidenceIds: ['T0116', 'T0121', 'T0118']
  }], units);
  assert.deepEqual(out.actions[0].owners, ['Andrew Kane']);
});

test('an anaphoric "I\'ll have a quick look" with someone else named nearby is kept and flagged, not removed', () => {
  const units = [
    unit('T0060', 'Jacqui Fox', 'Second question is around, I know previously we had looked at the fan logic battery alarms and the kind of justification around those.'),
    unit('T0061', 'Jacqui Fox', "And one of the things that's come up again, Andrew, question for you around the real time clock."),
    unit('T0062', 'Jacqui Fox', 'Is that documented anywhere, and if not, does it need to be documented?'),
    unit('T0071', 'Andrew Kane', "I think that's maybe covered as a mitigation in the risk analysis."),
    unit('T0072', 'Jacqui Fox', 'Okay, I think we should just do a check that we have captured this in the risk analysis.'),
    unit('T0073', 'Andrew Kane', "Yeah, I'm not sure for this, but definitely could be."),
    unit('T0074', 'Jacqui Fox', "Okay, I'll have a quick look as well to see if that's the case.")
  ];
  const out = V.applyRequesterOwnerRule([{
    action: 'Check whether the justification for fan logic battery alarms and real-time clock issues is documented in the risk analysis.',
    owners: ['Jacqui Fox'], evidenceIds: ['T0060', 'T0062', 'T0072']
  }], units);
  assert.deepEqual(out.actions[0].owners, ['Jacqui Fox']);
  assert.ok(!out.flags.some((flag) => /removed|Owner changed/.test(flag.message)), JSON.stringify(out.flags));
});

test('"Rebecca is kind of managing that through with Andrew" next to the cited line hands the work to Rebecca', () => {
  const units = [
    unit('T0018', 'Jacqui Fox', 'some cybersecurity stuff as a result of the USB ports that is on the back of the CPAP machine.'),
    unit('T0019', 'Jacqui Fox', 'So Rebecca is kind of managing that through with Andrew.'),
    unit('T0020', 'Rebecca Gill', 'Yes.')
  ];
  assert.ok(V.narratesOwnership('Rebecca', units[1].text));
  const out = V.applyRequesterOwnerRule([{
    action: 'Update the risk table with the cybersecurity considerations for the USB ports.',
    owners: ['Jacqui Fox'], evidenceIds: ['T0018']
  }], units);
  assert.deepEqual(out.actions[0].owners, []);
  assert.match(out.flags[0].message, /shows Rebecca Gill taking this on, not Jacqui Fox/);
});

test('someone else\'s work narrated fifteen rows away in the same long turn is not a rival', () => {
  const units = [
    unit('T0007', 'Jacqui Fox', 'And we review those on the software call with Rebecca and David and Andrew on Monday and there are some further updates that need to happen to that.'),
    ...Array.from({ length: 14 }, (_, index) => unit(`T00${String(8 + index).padStart(2, '0')}`, 'Jacqui Fox', `Round-up point ${index + 1} about other workstreams.`)),
    unit('T0022', 'Jacqui Fox', 'So Andrew is working on that as well.'),
    unit('T0052', 'Jacqui Fox', "I imagine, given she's only back, that hasn't happened."),
    unit('T0053', 'Kevin Beattie', "Yeah, no, not just yet, like, but we'll get there."),
    unit('T0054', 'Kevin Beattie', "We'll get that."),
    unit('T0055', 'Kevin Beattie', "I've replied to some of that other feedback that Colm and Louise put on the other documents as well, so that's work in progress."),
    unit('T0061', 'Kevin Beattie', "and then you can write 'cause I'm reviewing or rewriting the documents on there, so yeah.")
  ];
  const out = V.applyRequesterOwnerRule([{
    action: 'Send the revised documents by email for review after completing the rewrites and responses to feedback.',
    owners: ['Kevin Beattie'], evidenceIds: ['T0007', 'T0055', 'T0061']
  }], units);
  assert.deepEqual(out.actions[0].owners, ['Kevin Beattie']);
});
