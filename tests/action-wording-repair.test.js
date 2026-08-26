'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { repairActionWording, wordingFaults } = require('../utils/canonicalMinutes/trooperPolish');

// The second round, for rows whose wording is still not fit to print.
//
// The first round is a selection pass: it decides which candidates are real commitments and
// rewrites them. When its rewrite came back in the speaker's own voice the rewrite was
// refused and the source wording stood - which is the raw transcript, and usually worse.
// Measured live, that left 26% of published actions carrying a wording fault, including
// every example the reviewer reported. So the residue gets one more round, asked for one
// thing only, with the evidence window attached because that window is the only place the
// "that" in "Bring that to the US team" can be resolved from.
//
// Every guard below exists because the repair produced exactly that failure on a live run.

const pack = [{
  itemIndex: 0,
  evidence: [{ id: 'evt_1', speaker: 'Barbara', text: "I'll write to the council again and cc the councillor." }]
}];

const payloadWith = (action) => ({
  stagedStage: 'actions',
  screens: { actions: [{ owner: 'Barbara Finch', action, deadline: 'Not stated', evidenceIds: ['evt_1'] }] }
});

function stubReturning(text) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ repairs: [{ index: 0, action: text }] }) } }] })
  });
}

const repairedAction = async (original, replacement) => {
  const result = await repairActionWording(payloadWith(original), pack, { apiKey: 'test', url: 'https://example.invalid', fetchImpl: stubReturning(replacement) });
  return result.payload.screens.actions[0].action;
};

test('a row in the speaker\'s own voice is repaired', async () => {
  const action = await repairedAction(
    "Write to the council again, properly this time, and I'll use the word liability",
    'Write to the council again, copying the councillor and citing liability.'
  );
  assert.equal(action, 'Write to the council again, copying the councillor and citing liability.');
  assert.deepEqual(wordingFaults(action), []);
});

test('a repair that narrates the meeting is refused', async () => {
  // "The speaker will bring one to show the recipient" is grammatical, third person, and
  // tells the reader nothing. Refusing it leaves the original, which at least looks
  // unfinished rather than looking deliberate.
  const original = 'Bring one to show you';
  assert.equal(await repairedAction(original, 'The speaker will bring one to show the recipient.'), original);
});

test('a repair that moves the work onto someone else is refused', async () => {
  // Measured live: "Get the chiller serviced" came back as "The refrigeration engineer is to
  // service the chiller", quietly making the engineer the owner of an action belonging to
  // the brewer who was going to ring them. Requiring the imperative prevents the reframing.
  const original = 'Get the chiller serviced before we pitch the IPA on the fifteenth';
  assert.equal(await repairedAction(original, 'The refrigeration engineer is to service the chiller before the IPA pitch.'), original);
});

test('a repair may not invent a fact the original did not carry', async () => {
  const original = 'Get the chiller serviced before we pitch the IPA';
  assert.equal(await repairedAction(original, 'Service the chiller before the IPA brew on the 15th of March.'), original);
});

test('a mechanical fault is repaired without asking anybody', async () => {
  // A repeated phrase is redundancy; deleting the first copy cannot change the claim, so it
  // does not deserve a round trip.
  const result = await repairActionWording(
    payloadWith('Get one from the, from the place on Mill Road'),
    pack,
    { apiKey: '', fetchImpl: null }
  );
  assert.equal(result.payload.screens.actions[0].action, 'Get one from the place on Mill Road');
});

test('a clean action is offered for polish - the reviewer chose spend over stability', async () => {
  // The old contract here was "clean actions cost nothing". Measured against the
  // reviewer's broken-wording list, 8 of 10 examples carried no detectable fault, so the
  // no-cost rule was also a no-fix rule: spoken wording published untouched. The reviewer
  // approved a universal pass; a clean row now gets ONE offer, and a refusal keeps the
  // original, unmarked.
  let called = 0;
  const result = await repairActionWording(
    payloadWith('Send the code of conduct to the audit team'),
    pack,
    { apiKey: 'test', url: 'https://example.invalid', fetchImpl: async () => { called += 1; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"repairs":[]}' } }] }) }; } }
  );
  assert.equal(called, 1, 'exactly one polish round, no retry for a row that was never broken');
  assert.equal(result.attempted, 0, 'attempted still counts only detector-faulted rows');
  assert.equal(result.payload.screens.actions[0].action, 'Send the code of conduct to the audit team');
  assert.equal(result.payload.screens.actions[0].wordingRepaired, undefined, 'a refused polish leaves no mark');
});

test('ACTION_POLISH=0 restores the no-cost behaviour', async () => {
  process.env.ACTION_POLISH = '0';
  try {
    let called = 0;
    await repairActionWording(
      payloadWith('Send the code of conduct to the audit team'),
      pack,
      { apiKey: 'test', url: 'https://example.invalid', fetchImpl: async () => { called += 1; return { ok: true, status: 200, json: async () => ({}) }; } }
    );
    assert.equal(called, 0);
  } finally {
    delete process.env.ACTION_POLISH;
  }
});

test('a polish that loses a fact is refused; one that improves wording and keeps facts lands', async () => {
  const original = 'Send the IEC 60601-1 outputs to David by Friday';
  // Loses "Friday" - refused even though it reads fine.
  const losing = await repairActionWording(payloadWith(original), pack, {
    apiKey: 'test', url: 'https://example.invalid',
    fetchImpl: stubReturning('Send the IEC 60601-1 outputs to David')
  });
  assert.equal(losing.payload.screens.actions[0].action, original);
  // Keeps every fact, changes the wording - accepted and marked.
  const keeping = await repairActionWording(payloadWith(original), pack, {
    apiKey: 'test', url: 'https://example.invalid',
    fetchImpl: stubReturning('Send the IEC 60601-1 electrical outputs to David by Friday')
  });
  assert.equal(keeping.payload.screens.actions[0].action, 'Send the IEC 60601-1 electrical outputs to David by Friday');
  assert.equal(keeping.payload.screens.actions[0].wordingRepaired, true);
});

test('a failed repair leaves the row, it never drops it', async () => {
  const original = 'Bring that to the US team';
  const result = await repairActionWording(payloadWith(original), pack, {
    apiKey: 'test', url: 'https://example.invalid', fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) })
  });
  assert.equal(result.payload.screens.actions.length, 1, 'the commitment survives a failed repair');
  assert.equal(result.payload.screens.actions[0].action, original);
});

test('changing only the function words is not a repair', async () => {
  // Measured live: "Find that little clock top right" came back as "Find THE little clock
  // top right". The demonstrative was swapped for a definite article, which clears the
  // deixis detector and leaves the reader exactly as unable to find the clock. A repair
  // that resolves a reference has to name the thing, and naming it changes the content
  // words - so an unchanged content-word set means the row was not repaired, it was
  // reworded until it passed.
  const original = 'Find that little clock top right';
  assert.equal(await repairedAction(original, 'Find the little clock top right'), original);
  // Naming the thing is a real repair and is accepted.
  assert.equal(await repairedAction(original, 'Find the wall clock above the presenter view'),
    'Find the wall clock above the presenter view');
});

// --- the publication promise: no broken row is beyond the repair's reach, and nothing
// broken ships dressed as a minute.

test('a tautology is inside the repair trigger, not outside it', async () => {
  // "The ICP is defined as the ideal client profile" shipped for weeks because its fault
  // was mechanical-severity and the trigger stopped at voice/referential/truncation.
  const payload = {
    stagedStage: 'actions',
    screens: { actions: [{ owner: 'Priya', action: 'The Ideal Client Profile (ICP) is defined as the ideal client profile.', deadline: 'Not stated', evidenceIds: ['evt_1'] }] }
  };
  const result = await repairActionWording(payload, pack, {
    apiKey: 'test', url: 'https://example.invalid',
    fetchImpl: stubReturning('Agree a working definition of the ideal client profile (ICP).')
  });
  assert.equal(result.attempted, 1);
  assert.equal(result.repaired, 1);
  assert.deepEqual(wordingFaults(result.payload.screens.actions[0].action), []);
});

test('the ninth broken row is offered for repair too, in a second chunk', async () => {
  // The old REPAIR_ROW_LIMIT of 8 meant the ninth broken row shipped broken without ever
  // being offered - an arbitrary place for a publication promise to stop.
  const actions = Array.from({ length: 9 }, (_unused, i) => ({
    owner: 'Barbara Finch', action: `Bring one to show you at plot ${i + 1}`, deadline: 'Not stated', evidenceIds: ['evt_1']
  }));
  let calls = 0;
  const fetchImpl = async (_url, request) => {
    calls += 1;
    const prompt = JSON.parse(request.body).messages[1].content;
    const rows = JSON.parse(prompt.slice(prompt.indexOf('RECORDS:') + 9).trim());
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({
        repairs: rows.map((row) => ({ index: row.index, action: `Confirm the council letter for plot ${row.index + 1}.` }))
      }) } }] })
    };
  };
  const result = await repairActionWording({ stagedStage: 'actions', screens: { actions } }, pack, { apiKey: 'test', url: 'https://example.invalid', fetchImpl });
  assert.equal(result.attempted, 9);
  assert.equal(result.repaired, 9);
  assert.equal(calls, 2, 'nine rows travel as a chunk of eight and a chunk of one');
});

test('a refused repair gets a second round, and the second round says why', async () => {
  // Round one plays the metric-gaming move the content-word guard exists for: swapping
  // the demonstrative for an article. Refused. Round two must carry the retry nudge -
  // at temperature 0.1 an unchanged prompt mostly reproduces the rejected answer.
  const prompts = [];
  const answers = ['Find the little clock top right', 'Find the small wall clock at the top right of the studio.'];
  const fetchImpl = async (_url, request) => {
    prompts.push(JSON.parse(request.body).messages[1].content);
    const answer = answers[prompts.length - 1];
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ repairs: [{ index: 0, action: answer }] }) } }] }) };
  };
  const result = await repairActionWording(payloadWith('Find that little clock top right'), pack, { apiKey: 'test', url: 'https://example.invalid', fetchImpl });
  assert.equal(prompts.length, 2);
  assert.ok(!/previous rewrite/i.test(prompts[0]));
  assert.ok(/previous rewrite/i.test(prompts[1]));
  assert.equal(result.repaired, 1);
  assert.equal(result.payload.screens.actions[0].action, 'Find the small wall clock at the top right of the studio.');
});

test('a row that survives both rounds publishes marked, never dropped', async () => {
  const original = 'Find that little clock top right';
  const result = await repairActionWording(payloadWith(original), pack, {
    apiKey: 'test', url: 'https://example.invalid',
    fetchImpl: stubReturning('The speaker will find the clock for the recipient.')
  });
  const row = result.payload.screens.actions[0];
  assert.equal(row.action, original, 'the row is never dropped for its wording');
  assert.equal(row.wordingUnresolved, true, 'but it is marked, so the UI can present it as transcript wording');
  assert.equal(result.repaired, 0);
  assert.equal(result.attempted, 1);
});

// A fragment may be COMPLETED from its own evidence; a record may never be EXTENDED with
// facts from nowhere.
//
// "Pop into folder" is a real commitment the pattern layer compressed to three words, and
// no rewrite could rescue it: saying what it means needs "GSOP" and "Louise", both
// protected facts the import guard refused. That guard is what stops fusion, so it cannot
// simply be dropped - the distinction is invention, not addition. A fact already in THIS
// row's evidence window is being resolved; a fact from nowhere is being invented.

const { acceptWordingRepair: acceptRepair } = require('../utils/canonicalMinutes/trooperPolish');
const folderEvidence = 'Jacqui Fox: Christina can pop the updated contractor GSOP into the folder for Louise to check. Louise: I will review it once it is there.';

test('a fragment may take facts its own evidence window carries', () => {
  assert.equal(
    acceptRepair('Pop into folder', 'Place the updated contractor GSOP in the folder for Louise to check.', { imperative: true, people: [], evidence: folderEvidence }),
    true
  );
});

test('a fragment may not take facts the evidence does not carry', () => {
  assert.equal(
    acceptRepair('Pop into folder', 'Place the updated ISO 13485 file in the folder for Deborah to check.', { imperative: true, people: [], evidence: folderEvidence }),
    false
  );
});

test('a complete record is still refused an extension even when the evidence carries it', () => {
  // The fusion class the growth guard exists for: both Janine and Adil are in the window,
  // and the row is still a complete sentence that may be restated, not extended.
  assert.equal(
    acceptRepair(
      'Start working through electrical compliance testing',
      'Start working through electrical compliance testing and investigate the mute button with Janine and Adil next week.',
      { imperative: true, people: [], evidence: 'Andrew: I will start the electrical compliance testing. Janine and Adil will look at the mute button.' }
    ),
    false
  );
});

test('with no evidence window a fragment still cannot gain a protected fact', () => {
  assert.equal(
    acceptRepair('Pop into folder', 'Place the GSOP in the folder.', { imperative: true, people: [], evidence: '' }),
    false
  );
});

// A completion must still be about the same work.
//
// Precautionary: letting fragments take facts from a window reaching two turns either side
// gives them somewhere to drift. No corpus run has produced such a drift - the case that
// prompted this rail, "Do the renewals", completed correctly to "Handle plot renewals" -
// so these tests pin an invariant rather than a fixed bug.

const { makePolishAcceptor } = require('../utils/canonicalMinutes/trooperPolish');
const polishAccepts = makePolishAcceptor({ imperative: true, people: [] });
const renewalWindow = 'Barbara Finch: we should do the renewals soon. Barbara Finch: write to the council again, copying the councillor, and use the word liability.';

test('a fragment may not drift onto a neighbouring commitment in its own window', () => {
  assert.equal(
    polishAccepts('Do the renewals', 'Write to the council again, copying the councillor, and use the word liability.', renewalWindow),
    false
  );
});

test('a fragment completed with its own subject intact is accepted', () => {
  assert.equal(
    polishAccepts('Pop into folder', 'Place the update into a folder for Louise to check for the GSOP.',
      'Christina can pop the updated contractor GSOP into the folder for Louise to check.'),
    true
  );
});

test('a polish may replace the opening verb but not the subject', () => {
  // "Set the fee" -> "Agree to put the fee up" is a legitimate restatement.
  assert.equal(
    polishAccepts('Set plot fee to 30 pounds', 'Agree to put the annual plot fee up from 25 pounds to 30 pounds.',
      'Ken: put the annual plot fee up from 25 pounds to 30 pounds.'),
    true
  );
});

test('subject survival is stem-matched, so a plural may become a singular', () => {
  assert.equal(
    polishAccepts('Email top three plots', 'Email the top three on the list and offer them a plot.',
      'Priyanka: email the top three, offer them a plot.'),
    true
  );
});
