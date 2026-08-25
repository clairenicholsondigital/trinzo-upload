'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { convertSpokenNumbers, numericFactsOf } = require('../utils/spokenNumbers');

// Spoken numbers into digits, deterministically - and conservatively. Every case in the
// must-not-convert list below is a way the first draft of a converter goes wrong, and the
// corpus contains all of them.

const converted = (text) => convertSpokenNumbers(text).text;

test('the reviewer-reported cases convert', () => {
  assert.equal(converted('Order, seven point two for the IPA dry hop'), 'Order, 7.2 for the IPA dry hop');
  assert.equal(converted("I'll order three hundred and fifty to be safe"), "I'll order 350 to be safe");
  assert.equal(converted('expecting three hundred runners'), 'expecting 300 runners');
  assert.equal(converted('twelve hundred litres is the full batch'), '1200 litres is the full batch');
  assert.equal(converted('Email the fifteen casks of four point two'), 'Email the 15 casks of 4.2');
});

test('compositions and hyphens', () => {
  assert.equal(converted('we need twenty-two chairs'), 'we need 22 chairs');
  assert.equal(converted('two thousand five hundred entries'), '2500 entries');
  assert.equal(converted('Fifteen people attended'), '15 people attended');
});

test('bare small numbers stay prose', () => {
  // "one"-"nine" alone are standard minutes style, and converting them breaks idioms.
  assert.equal(converted('one of the team will handle it'), 'one of the team will handle it');
  assert.equal(converted('no one was available'), 'no one was available');
  assert.equal(converted('a two part plan'), 'a two part plan');
});

test('names are not quantities', () => {
  assert.equal(converted('Seven Sisters Road is closed'), 'Seven Sisters Road is closed');
  assert.equal(converted('Meet at Ten Downing Street'), 'Meet at Ten Downing Street');
});

test('dates and ordinals are left alone', () => {
  // "twenty-second of June" must not become "20-second of June" - the parser stops at
  // "twenty" and the dangling hyphen into an unconsumed word cancels the conversion.
  assert.equal(converted('delivery on the twenty-second of June'), 'delivery on the twenty-second of June');
  assert.equal(converted('the twenty-first century problem'), 'the twenty-first century problem');
});

test('colloquial forms are left whole rather than half-converted', () => {
  // "two-eighty" is 280 colloquially, but converting only the tail produced "two-80".
  // Whole-or-nothing: the model pass can handle the colloquialism with context.
  assert.equal(converted('approximately two-eighty entries'), 'approximately two-eighty entries');
});

test('lists and idioms with "and" are not numbers', () => {
  // "and" joins a number only after a scale word.
  assert.equal(converted('two and three make five'), 'two and three make five');
  assert.equal(converted('hundreds of entries came in'), 'hundreds of entries came in');
});

test('a sentence-initial number word still converts', () => {
  assert.equal(converted('Twenty volunteers signed up.'), '20 volunteers signed up.');
});

test('conversions are reported with their originals', () => {
  const { conversions } = convertSpokenNumbers('order three hundred and fifty medals');
  assert.equal(conversions.length, 1);
  assert.equal(conversions[0].original, 'three hundred and fifty');
  assert.equal(conversions[0].replacement, '350');
});

test('numericFactsOf treats spoken and written forms as the same fact', () => {
  // This is what lets the fact guard accept a rewrite that converts a number rather than
  // refusing it as an invented digit.
  assert.deepEqual([...numericFactsOf('order three hundred and fifty medals')], ['350']);
  assert.deepEqual([...numericFactsOf('order 350 medals')], ['350']);
  assert.deepEqual([...numericFactsOf('seven point two kilos')], ['7.2']);
});

test('empty and non-string input is safe', () => {
  assert.equal(converted(''), '');
  assert.equal(converted(null), '');
  assert.deepEqual([...numericFactsOf(undefined)], []);
});
