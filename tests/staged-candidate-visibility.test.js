'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

test('action review candidate cards expose non-empty visible text after closed groups are expanded', async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../views/staged-meeting-minutes.html'), 'utf8');
  assert.match(html, /candidate\.sourceSnippet \|\| candidate\.action \|\| candidate\.suggestedAction/);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <main>
        <div id="actionReviewGroups" class="action-review-groups">
          <details class="action-review-group">
            <summary>2 transcript snippets that may contain actions</summary>
            <div class="action-candidate-card" data-candidate-id="requirement-1">
              <blockquote class="action-transcript-snippet">Please confirm the required standards evidence.</blockquote>
              <span class="muted">Speaker: Jacqui Fox</span>
            </div>
            <div class="action-candidate-card" data-candidate-id="fallback-1">
              <blockquote class="action-transcript-snippet">So, sorry, go ahead, Mark.</blockquote>
              <span class="muted">Speaker: Not identified</span>
            </div>
          </details>
        </div>
      </main>
    `);
    await page.locator('.action-review-group').evaluateAll((groups) => groups.forEach((group) => { group.open = true; }));
    const visibleTexts = await page.locator('.action-transcript-snippet').evaluateAll((nodes) => nodes.map((node) => node.textContent.trim()));
    assert.deepEqual(visibleTexts, ['Please confirm the required standards evidence.', 'So, sorry, go ahead, Mark.']);
    assert.ok(visibleTexts.every(Boolean));
  } finally {
    await browser.close();
  }
});
