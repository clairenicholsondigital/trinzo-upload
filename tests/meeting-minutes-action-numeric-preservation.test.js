'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { numericActionEditIssue } = require('../utils/meetingMinutesActionNumericPreservation');
const row = action => ({ action, owners: ['Morgan Lee'], timing: { kind: 'not_stated' } });
const issue = (before, after) => numericActionEditIssue(row(before), row(after));

for (const [before, after] of [
  ['Order 12 replacement cartridges.', 'Order replacement cartridges.'],
  ['Order two replacement cartridges.', 'Order replacement cartridges.'],
  ['Order 2 replacement cartridges.', 'Order 3 replacement cartridges.'],
  ['Order 2 filters and 2 cartridges.', 'Order 2 cartridges.'],
  ['Keep the target at 600 ml.', 'Keep the target at 60 ml.'],
  ['Keep 5.2 g of reagent.', 'Keep 5 g of reagent.'],
  ['Keep -5 g of reagent.', 'Keep 5 g of reagent.'],
  ['Keep −.5 g of reagent.', 'Keep .5 g of reagent.'],
  ['Keep 5e-3 g of reagent.', 'Keep 5 g of reagent.'],
  ['Keep 5e-3 g of reagent.', 'Keep 5e3 g of reagent.'],
  ['Use £1,200 for the order.', 'Use £200 for the order.'],
  ['Use £12 for the order.', 'Use $12 for the order.'],
  ['Use 12 dollars for the order.', 'Use 12 for the order.'],
  ['Keep 5 mL of reagent.', 'Keep 5 ML of reagent.'],
  ['Keep 5 ML of reagent.', 'Keep 5 mL of reagent.'],
  ['Keep 5 mL of reagent.', 'Keep 5 of reagent.'],
  ['Keep 5 mg of reagent.', 'Keep 5 g of reagent.'],
  ['Keep 5 mW of power.', 'Keep 5 MW of power.'],
  ['Keep 5 micrograms of reagent.', 'Keep 5 milligrams of reagent.'],
  ['Keep the temperature at 5 degrees Celsius.', 'Keep the temperature at 5 degrees Fahrenheit.'],
  ['Keep the temperature at 5°C.', 'Keep the temperature at 5°F.'],
  ['Rotate by 5 degrees.', 'Rotate by 5.'],
  ['Run the calibration for 2 hours.', 'Run the calibration for 2.'],
  ['Order at least 12 cartridges.', 'Order 12 cartridges.'],
  ['Order at least 12 filters and 15 cartridges.', 'Order 12 filters and at least 15 cartridges.'],
  ['Order up to 12 cartridges.', 'Order at least 12 cartridges.'],
  ['Order approximately 12 cartridges.', 'Order 12 cartridges.'],
  ['Order 2–5 cartridges.', 'Order 2 and 5 cartridges.'],
  ['Order between 2 and 5 cartridges.', 'Order 2 and 5 cartridges.'],
  ['Use SOP-12.', 'Use SOP-13.'],
  ['Use SOP-12.', 'Use 12.'],
  ['Use procedure_v2.', 'Use procedure_v3.'],
]) test(`automatic edits preserve: ${before} → ${after}`, () => {
  assert.notEqual(issue(before, after), '');
});

for (const [before, after] of [
  ['Order twelve replacement cartridges.', 'Buy 12 replacement cartridges.'],
  ['Order two replacement cartridges.', 'Buy 2 replacement cartridges.'],
  ['Order zero replacement cartridges.', 'Buy 0 replacement cartridges.'],
  ['Order twenty-two replacement cartridges.', 'Buy 22 replacement cartridges.'],
  ['Order three hundred and fifty cartridges.', 'Buy 350 cartridges.'],
  ['Keep 5.20 g of reagent.', 'Retain 5.2g of reagent.'],
  ['Keep .5 g of reagent.', 'Retain 0.5 g of reagent.'],
  ['Keep −5 g of reagent.', 'Retain -5 g of reagent.'],
  ['Keep +5 g of reagent.', 'Retain 5 g of reagent.'],
  ['Keep 5e-3 g of reagent.', 'Retain 0.005 g of reagent.'],
  ['Keep -5.2e-3 g of reagent.', 'Retain -0.0052 g of reagent.'],
  ['Keep 5e+3 g of reagent.', 'Retain 5000 g of reagent.'],
  ['Keep 9007199254740993 samples.', 'Retain 9007199254740993 samples.'],
  ['Keep 5 mL of reagent.', 'Retain 5 millilitres of reagent.'],
  ['Keep 5ml of reagent.', 'Retain 5 mL of reagent.'],
  ['Keep 5 L of reagent.', 'Retain 5 litres of reagent.'],
  ['Keep 5 grams of reagent.', 'Retain 5 g of reagent.'],
  ['Keep 5 micrograms of reagent.', 'Retain 5 µg of reagent.'],
  ['Keep 5 microlitres of reagent.', 'Retain 5 µL of reagent.'],
  ['Keep the temperature at 5 degrees Celsius.', 'Keep the temperature at 5°C.'],
  ['Keep the temperature at 5 degrees Fahrenheit.', 'Keep the temperature at 5°F.'],
  ['Keep 5 percent of the sample.', 'Retain 5% of the sample.'],
  ['Run for 2 hours.', 'Operate for 2 hrs.'],
  ['Run for 2 seconds.', 'Operate for 2 s.'],
  ['Order at least 12 cartridges.', 'Buy ≥12 cartridges.'],
  ['Order up to 12 cartridges.', 'Buy at most 12 cartridges.'],
  ['Use at most .50 g.', 'Use <= 0.5 g.'],
  ['Order at least 12 cartridges.', 'Buy >=12 cartridges.'],
  ['Order about 12 cartridges.', 'Buy approximately 12 cartridges.'],
  ['Order 2–5 cartridges.', 'Buy 2 to 5 cartridges.'],
  ['Order between two and five cartridges.', 'Buy 2-5 cartridges.'],
  ['Use twelve pounds for the order.', 'Use £12 for the order.'],
  ['Use £1,200 for the order.', 'Use GBP 1200 for the order.'],
  ['Use 12 dollars for the order.', 'Use $12 for the order.'],
  ['Use SOP-12.', 'Follow sop-12.'],
  ['Review the calibration guidance, e.g. the bench protocols.', 'Review the bench protocols and calibration guidance.'],
  ['Order cartridges.', 'Order 12 cartridges.'],
]) test(`harmless numerical representation: ${before} → ${after}`, () => {
  assert.equal(issue(before, after), '');
});

test('comparisons preserve precision and repeated units; never mutate either action', () => {
  const before = row('Keep 9007199254740993 samples and 2 g plus 2 g of reagent.');
  const after = row('Keep 9007199254740992 samples and 2 g of reagent.');
  const saved = structuredClone({ before, after });
  assert.notEqual(numericActionEditIssue(before, after), '');
  assert.deepEqual({ before, after }, saved);
  assert.notEqual(issue('Keep 2 g and 2 g of reagent.', 'Keep 2 g and 2 portions of reagent.'), '');
});

test('missing and empty actions do not throw or invent numerical facts', () => {
  assert.equal(numericActionEditIssue(undefined, undefined), '');
  assert.equal(numericActionEditIssue({}, row('Order 12 cartridges.')), '');
  assert.notEqual(numericActionEditIssue(row('Order 12 cartridges.'), {}), '');
});
