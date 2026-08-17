'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

test('action review candidate cards expose non-empty visible text after closed groups are expanded', async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../views/staged-meeting-minutes.html'), 'utf8');
  assert.match(html, /candidate\.suggestedAction \|\| candidate\.action \|\| 'Review follow-up'/);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <main>
        <div id="actionReviewGroups" class="action-review-groups">
          <details class="action-review-group">
            <summary>1 requirements that may need an action</summary>
            <div class="action-candidate-card" data-candidate-id="requirement-1">
              <strong>Confirm the required standards evidence</strong>
              <span class="muted">Owner: Not stated</span>
            </div>
          </details>
          <details class="action-review-group">
            <summary>1 other possible follow-ups</summary>
            <div class="action-candidate-card" data-candidate-id="fallback-1">
              <strong>Review follow-up</strong>
              <span class="muted">Owner: Unconfirmed</span>
            </div>
          </details>
        </div>
      </main>
    `);
    await page.locator('.action-review-group').evaluateAll((groups) => groups.forEach((group) => { group.open = true; }));
    const visibleTexts = await page.locator('.action-candidate-card strong').evaluateAll((nodes) => nodes.map((node) => node.textContent.trim()));
    assert.deepEqual(visibleTexts, ['Confirm the required standards evidence', 'Review follow-up']);
    assert.ok(visibleTexts.every(Boolean));
  } finally {
    await browser.close();
  }
});
