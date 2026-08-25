'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { discussionCardsFromPlan, minutesPointAllowingDiscourseOpener } = require('../utils/canonicalMinutes/semanticStages');

// A turn that opens on a discourse marker is still a fact.
//
// Measured across the thirteen ground-truth fixtures: the editorial gate rejected 113 of
// 194 candidate discussion points (58%), and reading them showed most rejections were
// about HOW a turn began rather than whether it said anything - "And so the goods are
// ultimately stored here in Dublin" is a fact the human minutes record, refused for its
// leading "And". Minutes drop that conjunction as a matter of course.
//
// The rescue never relaxes the bar: the opener is removed and the SAME gate decides. An
// earlier attempt that retained refused turns and trusted a rewrite pass to clean them
// was measured and rejected - it published speech like "And storage, storage
// arrangements, so." Corpus effect of the shipped version: 450 -> 482 points, nothing
// displaced.

test('a fact refused for its leading conjunction is published without it', () => {
  const point = minutesPointAllowingDiscourseOpener('And so the goods are ultimately stored here in Dublin.', 'Goods flow and storage');
  assert.ok(point, 'the fact is not lost to its opener');
  assert.match(point, /^The goods are ultimately stored/);
});

test('junk still fails once the opener is gone - the gate keeps the last word', () => {
  // The clause after the marker has to stand on its own, so removing the opener rescues
  // content and never lowers the bar.
  assert.equal(minutesPointAllowingDiscourseOpener('And storage, storage arrangements, so.', 'Goods flow and storage'), '');
  assert.equal(minutesPointAllowingDiscourseOpener('Yeah, exactly, that is fine.', 'Goods flow and storage'), '');
});

test('a question is never rescued, however grammatical it becomes', () => {
  // "So is all the content here?" becomes a clean sentence the gate accepts, and still
  // records only that somebody asked something - not what the meeting established.
  assert.equal(minutesPointAllowingDiscourseOpener('So is all the content here?', 'Content and communications'), '');
  assert.equal(minutesPointAllowingDiscourseOpener('So how do visitors get in?', 'Parking'), '');
});

test('a point that already passes is returned untouched', () => {
  const text = 'The team confirmed that final storage takes place at the Dublin warehouse.';
  assert.equal(minutesPointAllowingDiscourseOpener(text, 'Goods flow and storage'), text);
});

const eventsFor = (texts) => texts.map((text, index) => ({
  id: `evt_${index + 1}`, text, speaker: 'Jacqui Fox', turnIndex: index
}));

const cardFor = (texts, label = 'Goods flow and storage') => {
  const events = eventsFor(texts);
  const plan = {
    workstreams: [{
      id: 'ws_1', label, topicId: 'topic_01',
      evidenceIds: events.map((event) => event.id),
      provenance: 'derived', primaryEvidenceCount: events.length
    }],
    evidenceById: new Map(events.map((event) => [event.id, event]))
  };
  return discussionCardsFromPlan(plan, { events }, {})[0];
};

test('a rescued point never displaces one that was already publishable', () => {
  // The per-card cap is four. Ordering by turn alone let rescues push out points that
  // passed as spoken, which cost a real language-support point its place when first
  // measured; direct passes now fill the card first.
  const card = cardFor([
    'And so the goods are ultimately stored here in Dublin.',
    'And the goods are dispatched the same day or next day.',
    'And required documents were reviewed for the importer obligations.',
    'And all the fully packed units are in a shipping box.',
    'The team confirmed that final storage takes place at the Dublin warehouse.'
  ]);
  assert.ok(card.points.length <= 4, 'the per-card cap still holds');
  assert.ok(
    card.points.some((point) => /final storage takes place at the Dublin warehouse/.test(point.text)),
    'the point that passed the gate as spoken keeps its slot'
  );
});

test('a card still reads in the order the meeting happened', () => {
  const card = cardFor([
    'The team confirmed that final storage takes place at the Dublin warehouse.',
    'And the goods are dispatched the same day or next day.'
  ]);
  const order = card.points.map((point) => Number(String(point.evidenceIds[0]).replace('evt_', '')));
  assert.deepEqual(order, [...order].sort((left, right) => left - right));
});
