'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture, draft, copy, settled } = require('./helpers/meeting-minutes-review-browser');
const notice = (page, id) => page.locator('[data-retained-warning="' + id + '"]');
async function openDetails(page) {
  await page.locator('#omittedDetailsPanel').evaluate(node => { node.open = true; });
}
function content(d) {
  return { discussion: d.discussion, actions: d.actions, sourceUnits: d.sourceUnits,
    unassignedSupportingDetails: d.unassignedSupportingDetails };
}
test('attached and unfiled warnings use compact escaped disclosures with independent occurrence identities', async () => {
  const initial = draft(), f = await fixture(initial);
  try {
    const { page } = f; await openDetails(page);
    const attached = notice(page, 'attached-warning'); assert.equal(await attached.count(), 2);
    assert.deepEqual(await attached.locator('summary').allTextContents(), ['Timing to check', 'Timing to check']);
    const keys = await attached.evaluateAll(nodes => nodes.map(node => node.dataset.keepOpen));
    assert.equal(new Set(keys).size, 2);
    assert.equal(await attached.first().locator('[data-retained-warning-message]').isVisible(), false);
    assert.equal(await attached.first().locator('[data-retained-warning-message]').textContent(), initial.reviewFlags[0].message);
    await attached.first().locator('summary').click();
    assert.equal(await attached.first().locator('[data-retained-warning-message]').isVisible(), true);
    assert.equal(await attached.nth(1).locator('[data-retained-warning-message]').isVisible(), false);
    assert.equal(await page.locator('#unsafe-warning').count(), 0);
    assert.equal(await page.evaluate(() => window.unsafeWarning), undefined);
    const group = page.locator('[data-identical-filing-group] > details');
    await group.locator(':scope > summary').click();
    assert.equal(await notice(page, 'pool-warning').isVisible(), true);
    assert.equal(await notice(page, 'second-pool-warning').isVisible(), true);
    assert.deepEqual(f.saved(), initial); assert.equal(f.patches.length, 0);
    assert.deepEqual(f.requests, []); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
test('resolved flags stay hidden; duplicate IDs display once and missing definitions remain visibly unresolved', async () => {
  const initial = draft();
  initial.reviewFlags = ['confirmed', 'dismissed', 'corrected'].map((status, i) => ({
    id: 'resolved-' + i, kind: 'timing', status, message: 'Previously checked.', evidenceIds: ['T0001']
  }));
  initial.discussion[0].points[0].supportingDetails[0].reviewFlagIds =
    ['resolved-0', 'resolved-1', 'resolved-2', 'missing-definition', 'missing-definition'];
  const f = await fixture(initial);
  try {
    await openDetails(f.page);
    for (let i = 0; i < 3; i++) assert.equal(await notice(f.page, 'resolved-' + i).isHidden(), true);
    const missing = notice(f.page, 'missing-definition'); assert.equal(await missing.count(), 1);
    assert.equal(await missing.isVisible(), true);
    assert.equal(await missing.locator('summary').textContent(), 'Source check needed');
    await missing.locator('summary').click();
    assert.match(await missing.locator('[data-retained-warning-message]').textContent(), /explanation.*unavailable/);
    assert.deepEqual(f.saved(), initial); assert.equal(f.patches.length, 0); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
for (const status of ['confirmed', 'corrected', 'dismissed']) {
  test('warning ' + status + ' updates all linked notices immediately and survives save, undo, redo and reload', async () => {
    const initial = draft(), f = await fixture(initial);
    try {
      const { page } = f; await openDetails(page);
      await notice(page, 'attached-warning').first().locator('summary').click();
      const source = page.locator('#omittedDetailsPanel .omitted-detail-actions > details').first();
      await source.locator('summary').click();
      await page.locator('#reviewQueueToggle').click(); await page.locator('#flagList details[data-review-category]').evaluateAll(nodes=>nodes.forEach(node=>node.open=true));
      if (status === 'corrected') {
        const note = page.locator('[data-flag-correction="0"]'); await note.locator('..').locator('..').evaluate(node => { node.open = true; });
        await note.fill('Checked against the original source.');
      }
      const response = page.waitForResponse(r => r.request().method() === 'PATCH');
      await page.locator('[data-flag-index="0"][data-flag-status="' + status + '"]').click();
      assert.equal(await notice(page, 'attached-warning').first().isHidden(), true);
      await response; await settled(page);
      assert.equal(f.saved().reviewFlags[0].status, status);
      assert.deepEqual(content(f.saved()), content(initial));
      assert.deepEqual(f.saved().reviewFlags.slice(1), initial.reviewFlags.slice(1));
      assert.equal(await source.evaluate(node => node.open), true);
      await page.locator('#undoLastDecision').click();
      await page.waitForFunction(() => !document.querySelector('[data-retained-warning="attached-warning"]').hidden);
      assert.equal(f.saved().reviewFlags[0].status, 'open');
      assert.deepEqual(content(f.saved()), content(initial));
      await page.locator('#redoLastDecision').click();
      await page.waitForFunction(() => document.querySelector('[data-retained-warning="attached-warning"]').hidden);
      await page.reload(); await page.waitForSelector('[data-retained-warning="attached-warning"]', { state: 'attached' });
      assert.equal(await notice(page, 'attached-warning').first().getAttribute('hidden'), '');
      assert.deepEqual(content(f.saved()), content(initial));
      assert.deepEqual(f.requests, []); assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });
}
test('Open in minutes reveals attached and nested unfiled targets without resolving or moving any record', async () => {
  const initial = draft(), f = await fixture(initial);
  try {
    const { page } = f; await page.locator('#reviewQueueToggle').click(); await page.locator('#flagList details[data-review-category]').evaluateAll(nodes=>nodes.forEach(node=>node.open=true));
    // The shared attached warning still has the existing paragraph target.
    const first = page.locator('#flagList [data-view-flag-target]').first();
    const targetId = await first.getAttribute('data-view-flag-target');
    await first.click();
    await page.waitForFunction(id => document.getElementById(id)?.getBoundingClientRect().height > 0, targetId);
    assert.equal(await page.locator('#omittedDetailsPanel').evaluate(node => node.open), true);
    await page.locator('#omittedDetailsPanel').evaluate(node => { node.open = false; });
    // Both retained texts are identical, so address the independent target by its occurrence ID.
    const button = page.locator('#flagList [data-view-flag-target*="unfiled-b"]');
    const id = await button.getAttribute('data-view-flag-target'); assert.ok(id);
    if (!(await button.isVisible())) await page.locator('#reviewQueueToggle').click(); await page.locator('#flagList details[data-review-category]').evaluateAll(nodes=>nodes.forEach(node=>node.open=true));
    await button.click();
    await page.waitForFunction(id => document.getElementById(id)?.getBoundingClientRect().height > 0, id);
    await page.waitForFunction(() => document.querySelector('[data-identical-filing-group] > details')?.open === true);
    assert.equal(await page.locator('[data-identical-filing-group] > details').evaluate(node => node.open), true);
    assert.deepEqual(content(f.saved()), content(initial)); assert.deepEqual(f.saved().reviewFlags, initial.reviewFlags);
    assert.equal(f.patches.length, 0); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
test('filing an unassigned occurrence retains its warning and history through undo/redo', async () => {
  const initial = draft(), f = await fixture(initial);
  try {
    const { page } = f; await openDetails(page);
    await page.locator('[data-identical-filing-group] > details > summary').click();
    const row = page.locator('[data-unassigned-supporting-row="0"]');
    await row.locator('[data-supporting-destination]').selectOption('0:points:0');
    const response = page.waitForResponse(r => r.request().method() === 'PATCH');
    await row.locator('[data-file-supporting]').click(); await response; await settled(page);
    const moved = f.saved().discussion[0].points[0].supportingDetails.find(r => r.id === 'unfiled-a');
    assert.equal(moved.text, initial.unassignedSupportingDetails[0].text);
    assert.deepEqual(moved.evidenceIds, ['T0001']); assert.deepEqual(moved.reviewFlagIds, ['pool-warning']);
    assert.ok(moved.mergedFromIds.includes('earlier-unfiled'));
    assert.equal(f.saved().unassignedSupportingDetails.length, 1);
    assert.equal(await notice(page, 'pool-warning').count(), 1);
    assert.deepEqual(f.saved().reviewFlags, initial.reviewFlags);
    await page.locator('#undoLastDecision').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-unassigned-supporting-row]').length === 2);
    assert.deepEqual(content(f.saved()), content(initial));
    await page.locator('#redoLastDecision').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-unassigned-supporting-row]').length === 1);
    assert.equal(f.saved().discussion[0].points[0].supportingDetails.find(r => r.id === 'unfiled-a').text, moved.text);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
test('promoting supporting context preserves the warning target, history and exact text through save and undo', async () => {
  const initial = draft(), f = await fixture(initial);
  try {
    const { page } = f; await openDetails(page);
    const response = page.waitForResponse(r => r.request().method() === 'PATCH');
    await page.locator('[data-promote-supporting="0"][data-item-index="0"]').click(); await response; await settled(page);
    const promoted = f.saved().discussion[0].points.find(p => p.id === 'attached-a');
    assert.ok(promoted); assert.equal(promoted.text, initial.discussion[0].points[0].supportingDetails[0].text);
    assert.deepEqual(promoted.reviewFlagIds, ['attached-warning']); assert.deepEqual(promoted.evidenceIds, ['T0001']);
    assert.ok(promoted.mergedFromIds.includes('earlier-attached')); assert.equal(promoted.reviewerAuthored, true);
    await page.locator('#reviewQueueToggle').click(); await page.locator('#flagList details[data-review-category]').evaluateAll(nodes=>nodes.forEach(node=>node.open=true));
    assert.equal(await page.locator('#flagList [data-view-flag-target="minutes-discussion-attached-a"]').count(), 1);
    await page.locator('#undoLastDecision').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-retained-warning="attached-warning"]').length === 2);
    assert.deepEqual(content(f.saved()), content(initial)); assert.deepEqual(f.saved().reviewFlags, initial.reviewFlags);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
test('font-aware editors grow, shrink and resize without clipping, changing text, moving the caret or causing saves', async () => {
  const f = await fixture();
  try {
    const { page } = f;
    assert.ok(await page.evaluate(() => [...document.fonts].some(font => font.family === 'Trinzo Roboto' && font.status === 'loaded')));
    const title = 'Calibration review and planned equipment inspections '.repeat(3).trim();
    const field = page.locator('[data-topic]').first();
    const response = page.waitForResponse(r => r.request().method() === 'PATCH');
    await field.fill(title); await response; await settled(page);
    await field.evaluate(node => { node.focus(); node.setSelectionRange(7, 19); });
    const saved = copy(f.saved()), patches = f.patches.length;
    for (const width of [390, 800, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForFunction(() => { const n = document.querySelector('[data-topic]'); return n.clientHeight >= n.scrollHeight; });
      const editor = await field.evaluate(node => ({ value: node.value, start: node.selectionStart, end: node.selectionEnd, focused: document.activeElement === node }));
      assert.deepEqual(editor, { value: title, start: 7, end: 19, focused: true });
    }
    // A late font completion must remeasure without an input or resize event.
    await field.evaluate(node => {
      node.style.height = '1px';
      document.fonts.dispatchEvent(new Event('loadingdone'));
    });
    await page.waitForFunction(() => { const n = document.querySelector('[data-topic]'); return n.clientHeight >= n.scrollHeight; });
    assert.equal(await field.inputValue(), title);
    // Explicit content-box editors must not count their padding twice.
    await field.evaluate(node => { node.style.boxSizing = 'content-box'; node.style.height = '1px'; window.dispatchEvent(new Event('resize')); });
    await page.waitForFunction(() => { const n = document.querySelector('[data-topic]'); return n.clientHeight >= n.scrollHeight; });
    await field.evaluate(node => { node.style.boxSizing = ''; window.dispatchEvent(new Event('resize')); });
    await page.waitForTimeout(800);
    assert.equal(f.patches.length, patches); assert.deepEqual(f.saved(), saved);
    const shortResponse = page.waitForResponse(r => r.request().method() === 'PATCH');
    await field.fill('Equipment'); await shortResponse; await settled(page);
    assert.ok(await field.evaluate(n => n.clientHeight >= n.scrollHeight && n.clientHeight < 80));
    for (const value of ['', 'X'.repeat(200)]) {
      const save = page.waitForResponse(r => r.request().method() === 'PATCH');
      await field.fill(value); await save; await settled(page);
      assert.ok(await field.evaluate(n => n.clientHeight >= n.scrollHeight));
    }
    await page.locator('[data-step="4"]').click();
    const summary = page.locator('#executiveSummary');
    const text = 'A long summary preserves every useful qualification. '.repeat(35).trim();
    const summarySave = page.waitForResponse(r => r.request().method() === 'PATCH' && r.request().postDataJSON().executiveSummary === text);
    await summary.fill(text); await summarySave; await settled(page);
    assert.ok(await summary.evaluate(n => n.clientHeight >= n.scrollHeight && getComputedStyle(n).overflowY === 'hidden'));
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForFunction(() => { const n = document.querySelector('#executiveSummary'); return n.clientHeight >= n.scrollHeight; });
      assert.equal(await summary.inputValue(), text);
    }
    assert.deepEqual(f.errors, []); assert.deepEqual(f.requests, []);
  } finally { await f.close(); }
});
