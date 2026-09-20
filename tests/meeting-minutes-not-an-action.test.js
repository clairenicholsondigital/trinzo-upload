const test = require('node:test');
const assert = require('node:assert');
const V = require('../utils/meetingMinutesAgentV2');

test('a hedged state of mind is not an action', () => {
  assert.ok(V.isNotAnAction('Possibly have some questions on the reviewed document.'));
  assert.ok(V.isNotAnAction('Have some questions on the reviewed document as needed.'));
  assert.ok(V.isNotAnAction('Maybe review the draft before Friday.'), 'a hedged opener is speculative');
});

test('ordinary actions are untouched, including ones the wording score dislikes', () => {
  for (const wording of [
    'Place the full 13 kg hop order.',
    'Ring the refrigeration engineer regarding the glycol chiller.',
    'Carry out the required in-house electrical compliance testing.',
    'Have the glycol chiller serviced before pitching the IPA on the fifteenth.',
    'Raise the change request with the review team.'
  ]) assert.equal(V.isNotAnAction(wording), false, wording);
});

const closingMeeting = () => {
  const units = [];
  for (let i = 1; i <= 60; i += 1) {
    units.push({ id: `T${String(i).padStart(4, '0')}`, speaker: 'Orla Skally', classification: 'keep',
      text: 'We went through the importer obligations and the registration documents again.' });
  }
  units[56] = { id: 'T0057', speaker: 'Jacqui Fox', text: 'They definitely love you anyway, that is for sure.', classification: 'keep' };
  units[57] = { id: 'T0058', speaker: 'Orla Skally', text: "I'm gonna, yeah, I need to book a holiday.", classification: 'keep' };
  units[58] = { id: 'T0059', speaker: "Colm O'Rourke", text: 'Just another form of tax, that is all it is.', classification: 'keep' };
  return units;
};

test('a commitment in the goodbyes about something never otherwise discussed is an aside', () => {
  const units = closingMeeting();
  assert.ok(V.isSocialAside({ action: 'Book a holiday.', evidenceIds: ['T0058'] }, units));
});

test('a late commitment about the meeting\'s actual subject is not an aside', () => {
  const units = closingMeeting();
  assert.equal(V.isSocialAside({
    action: 'Send the registration documents for the importer obligations.', evidenceIds: ['T0058']
  }, units), false, 'its subject is discussed throughout, so it is real work');
});

test('an early commitment is never treated as an aside', () => {
  const units = closingMeeting();
  assert.equal(V.isSocialAside({ action: 'Book a holiday.', evidenceIds: ['T0002'] }, units), false);
});
