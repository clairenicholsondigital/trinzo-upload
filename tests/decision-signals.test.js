'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { collectDecisionSignals } = require('../utils/canonicalMinutes/semanticStages');

// Decisions, collected for the summary the way actionSignals already are.
//
// The scorecard's remaining objective gaps had names, and most of them were decisions:
// the allotment's plot-fee rise, the pantomime's choice of show. Human minutes write the
// objective as the intent behind the decision - "Decide between Cinderella and Aladdin" -
// and the model can compose that, but only from evidence it is shown, and the summary
// pack carried actions, clarifications and unresolved needs while decisions never rode.
//
// The impersonal announcement is the general form the explicit extractor missed: a chair
// closes a question with "it's decided" or "that's settled" without ever saying "we
// decided". These tests use synthetic events shaped like the real moments that exposed
// the gap.

const evidenceOf = (...texts) => ({ events: texts.map((text, index) => ({ id: `e${index}`, text })) });

test('an announcement carrying its own clause is the decision', () => {
  const signals = collectDecisionSignals(evidenceOf(
    'The costumes for Cinders are largely in the store.',
    "Right, so it's decided, we're doing Cinderella this year."
  ), {});
  assert.equal(signals.length, 1);
  assert.match(signals[0].text, /doing Cinderella this year/);
  assert.deepEqual(signals[0].evidenceIds, ['e1']);
});

test('a bare ratification ratifies the nearest substantive turn', () => {
  // "Good. That's decided then." decides nothing by itself - it closes the question that
  // was just asked. The walk-back skips acknowledgements to find it, and carries both
  // turns' evidence: the proposal and its ratification.
  const signals = collectDecisionSignals(evidenceOf(
    'So are we agreed, we put the annual plot fee up from twenty-five to thirty pounds, starting in January?',
    'Yeah, go on.',
    'Agreed.',
    "Good. That's decided then."
  ), {});
  assert.equal(signals.length, 1);
  assert.match(signals[0].text, /annual plot fee up from twenty-five to thirty pounds/);
  assert.deepEqual(signals[0].evidenceIds, ['e0', 'e3']);
});

test('a meeting that decides nothing yields nothing', () => {
  // The counterweight, and the property that matters most: the parking meeting discusses
  // options for half an hour and settles none of them, and its human minutes say exactly
  // that. A decision collector that manufactures decisions from discussion would poison
  // the objectives it exists to feed.
  const signals = collectDecisionSignals(evidenceOf(
    'We could paint the bays a different colour.',
    'Permits might work but there is an enforcement problem.',
    'Nobody reads the letters.',
    'Let us all think about parking options before next month.'
  ), {});
  assert.deepEqual(signals, []);
});

test('door locks and settled dust are not decisions', () => {
  // The pattern requires the announcement form, not the words: "decided", "agreed" and
  // "settled" only count in "it's/that's X" position, where they can only be about the
  // question in the room.
  const signals = collectDecisionSignals(evidenceOf(
    'The shed door was decided lly hard to open.',
    'He settled into the chair and agreed to listen.'
  ), {});
  assert.deepEqual(signals, []);
});
