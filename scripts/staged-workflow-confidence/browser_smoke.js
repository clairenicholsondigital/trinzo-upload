#!/usr/bin/env node
'use strict';

// Three deliberately small real-browser checks. Content quality belongs to benchmark.js;
// this script proves the deployed DOM exposes the same staged flow and reviewer controls.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../..');
const FIXTURES = path.join(ROOT, 'scripts', 'staged-scorecard-fixtures');
const BASE_URL = (process.env.STAGED_BENCHMARK_BASE_URL || 'https://trinzo.virtual-hub.online').replace(/\/$/, '');
const TIMEOUT = Number(process.env.STAGED_BROWSER_SMOKE_TIMEOUT_MS || 600000);
const scenarios = [
  { id: 't733', fixture: '04_eakin_t733_tech_file_weekly', check: 'organizer_and_actions' },
  { id: 'two_jos', fixture: '12_race_committee_two_jos', check: 'owner_collision' },
  { id: 'parking', fixture: '13_parking_no_decision', check: 'negative_control' }
];

async function signIn(page) {
  const cookieHeader = process.env.STAGED_BENCHMARK_COOKIE;
  if (cookieHeader) {
    const cookies = cookieHeader.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
      const separator = part.indexOf('=');
      return { name: part.slice(0, separator), value: part.slice(separator + 1), url: BASE_URL, httpOnly: true, secure: BASE_URL.startsWith('https:') };
    }).filter((cookie) => cookie.name && cookie.value);
    if (!cookies.length) throw new Error('STAGED_BENCHMARK_COOKIE did not contain a usable cookie.');
    await page.context().addCookies(cookies);
    await page.goto(`${BASE_URL}/staged-meeting-minutes`, { waitUntil: 'domcontentloaded' });
    if (!page.url().includes('/auth/login')) return;
    throw new Error('STAGED_BENCHMARK_COOKIE was rejected by the deployed site.');
  }
  const email = process.env.STAGED_BENCHMARK_EMAIL;
  const password = process.env.STAGED_BENCHMARK_PASSWORD;
  if (!email || !password) throw new Error('Set STAGED_BENCHMARK_EMAIL and STAGED_BENCHMARK_PASSWORD.');
  await page.goto(`${BASE_URL}/auth/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('#email', email);
  await page.fill('#password', password);
  await Promise.all([page.waitForURL((url) => !url.pathname.includes('/auth/login'), { timeout: TIMEOUT }), page.click('#loginForm button[type="submit"]')]);
}

async function waitForStage(page, screenIndex) {
  await page.waitForFunction((index) => {
    const screen = document.querySelector(`.screen[data-screen="${index}"]`);
    return screen?.classList.contains('active') && document.body.dataset.generationState === 'complete';
  }, screenIndex, { timeout: TIMEOUT });
}

async function generateFlow(page, scenario) {
  const transcript = fs.readFileSync(path.join(FIXTURES, scenario.fixture, 'transcript.txt'), 'utf8');
  await page.goto(`${BASE_URL}/staged-meeting-minutes`, { waitUntil: 'domcontentloaded' });
  await page.setInputFiles('#stagedTranscriptFile', {
    name: `${scenario.fixture}.txt`, mimeType: 'text/plain', buffer: Buffer.from(transcript)
  });
  await page.click('#generateStagedMinutesBtn');
  await waitForStage(page, 0);
  for (let next = 1; next <= 3; next += 1) {
    await page.click('#nextScreenBtn');
    await waitForStage(page, next);
  }
  return transcript;
}

async function inspectScenario(page, scenario) {
  const result = { id: scenario.id, fixture: scenario.fixture };
  if (scenario.check === 'organizer_and_actions') {
    await page.click('[data-screen-target="2"]');
    const cards = page.locator('.discussion-card');
    result.discussionGroups = await cards.count();
    const move = page.locator('.discussion-point-move').first();
    const options = await move.locator('option').count();
    if (options > 1) {
      const value = await move.locator('option').nth(1).getAttribute('value');
      if (value) await move.selectOption(value);
    }
    await page.click('[data-screen-target="3"]');
    result.actions = await page.locator('#actionsTableBody tr').evaluateAll((rows) => rows.filter((row) => !row.querySelector('.empty-state')).length);
    if (!result.discussionGroups || !result.actions) throw new Error('T733 did not expose grouped discussion and actions.');
  } else if (scenario.check === 'owner_collision') {
    if (!await page.locator('.action-owner-select').count()) await page.click('#addActionRowBtn');
    const ownerValues = await page.locator('.action-owner-select').first().locator('option').evaluateAll((options) => options.map((option) => option.value));
    result.ownerOptions = ownerValues;
    if (!ownerValues.includes('Jo Bennett') || !ownerValues.includes('Jo Marsh')) throw new Error(`The Two-Jos owner selector did not retain both identities: ${ownerValues.join(', ')}`);
  } else {
    result.actions = await page.locator('#actionsTableBody tr').evaluateAll((rows) => rows.filter((row) => !row.querySelector('.empty-state')).length);
    const bodyText = await page.locator('body').innerText();
    if (result.actions !== 0 || /confirmed parking decision/i.test(bodyText)) throw new Error('Parking negative control introduced an action or decision.');
  }
  await page.click('#nextScreenBtn');
  await waitForStage(page, 4);
  result.pdfEnabled = await page.locator('#exportClientPdfBtn').isEnabled();
  if (!result.pdfEnabled) throw new Error(`${scenario.id}: PDF export was not available on final review.`);
  return result;
}

async function main() {
  const browser = await chromium.launch({ headless: process.env.HEADFUL !== '1' });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);
  const results = [];
  try {
    await signIn(page);
    for (const scenario of scenarios) {
      try {
        await generateFlow(page, scenario);
        results.push({ ok: true, ...await inspectScenario(page, scenario) });
        process.stderr.write(`${scenario.id}: passed\n`);
      } catch (error) {
        results.push({ ok: false, id: scenario.id, fixture: scenario.fixture, error: error.message });
        process.stderr.write(`${scenario.id}: failed — ${error.message}\n`);
      }
    }
  } finally {
    await browser.close();
  }
  const ok = results.every((result) => result.ok);
  console.log(JSON.stringify({ ok, baseUrl: BASE_URL, results }, null, 2));
  if (!ok) process.exitCode = 1;
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
