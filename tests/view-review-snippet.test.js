'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { addReviewSnippet, SNIPPET } = require('../utils/reviewSnippet');

// Every view is served through addReviewSnippet, so the snippet is part of the page a
// user actually receives - and it is a <script> element, which means landing it in the
// wrong place does not merely misplace a tag, it terminates whatever script element it
// lands inside. That is what happened on /jobs: the snippet was anchored to the first
// `</body>`, the PDF-export code builds a whole HTML document as a template literal
// containing `</body>`, and every line of JS after that point rendered on screen as
// text. The page looked catastrophically broken and nothing in the view was wrong.
//
// So the assertion is about where the snippet lands, for every view, not about the one
// file that broke.

const VIEWS = path.resolve(__dirname, '../views');
const viewFiles = fs.readdirSync(VIEWS).filter((name) => name.endsWith('.html'));

// Scan the way the HTML parser does: inside a script element, only a literal
// `</script` closes it - which is why views write `<\/script>` in their strings.
function scriptSpans(html) {
  const spans = [];
  const lower = html.toLowerCase();
  let index = 0;
  while (index < lower.length) {
    const open = lower.indexOf('<script', index);
    if (open < 0) break;
    const bodyStart = lower.indexOf('>', open);
    if (bodyStart < 0) break;
    const close = lower.indexOf('</script', bodyStart);
    if (close < 0) { spans.push([bodyStart + 1, lower.length]); break; }
    spans.push([bodyStart + 1, close]);
    index = close + 8;
  }
  return spans;
}

test('there is at least one view to check', () => {
  assert.ok(viewFiles.length > 0);
});

for (const name of viewFiles) {
  test(`${name}: the review snippet lands in document content, not inside a script`, () => {
    const html = fs.readFileSync(path.join(VIEWS, name), 'utf8');
    const served = addReviewSnippet(html);
    const at = served.indexOf(SNIPPET);
    if (at < 0) return; // a view with no </body> is served unchanged, which is fine
    for (const [start, end] of scriptSpans(html)) {
      assert.ok(at <= start || at >= end,
        `snippet injected inside the script element spanning ${start}-${end}; it would close that script and dump the rest of the page as text`);
    }
  });

  test(`${name}: serving it does not change how many script elements the page has`, () => {
    const html = fs.readFileSync(path.join(VIEWS, name), 'utf8');
    const served = addReviewSnippet(html);
    assert.equal(scriptSpans(served).length, scriptSpans(html).length + 1,
      'exactly one script element is added - a different count means the snippet split an existing one');
  });
}

test('the snippet is anchored to the document body, not to a string that looks like one', () => {
  // The specific shape that broke: a page whose script builds an HTML document.
  const page = [
    '<html><body><div id="app"></div>',
    '<script>',
    "const doc = `<html><body><h1>export</h1></body></html>`;",
    'render(doc);',
    '</script>',
    '</body></html>'
  ].join('\n');
  const served = addReviewSnippet(page);
  assert.ok(served.indexOf(SNIPPET) > served.indexOf('render(doc);'), 'the snippet goes after the page script, not into it');
  assert.equal(scriptSpans(served).length, 2);
});

test('a page served twice is not given two snippets', () => {
  const once = addReviewSnippet('<html><body>hi</body></html>');
  assert.equal(addReviewSnippet(once), once);
});

test('a fragment with no body is passed through untouched', () => {
  assert.equal(addReviewSnippet('<div>fragment</div>'), '<div>fragment</div>');
});

// The proof that matters is what a browser does with the served bytes. The static
// assertions above describe where the snippet goes; this one renders the page that broke
// and reads what a person would have seen. Measured against the old first-`</body>`
// anchor, the same file put 18,455 characters of JavaScript source on screen as text and
// threw a page error; against the fix it renders the Library UI and nothing else.
test('the jobs page renders as a page, not as its own source code', { timeout: 120000 }, async () => {
  const { chromium } = require('playwright');
  const html = addReviewSnippet(fs.readFileSync(path.join(VIEWS, 'meeting-minutes-jobs.html'), 'utf8'));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    const seen = await page.evaluate(() => ({
      text: document.body.innerText || '',
      heading: document.querySelector('h1')?.textContent || ''
    }));
    assert.equal(seen.heading, 'Library');
    assert.ok(!/const printWindow = window\.open|listView\.innerHTML/.test(seen.text), 'no JavaScript source is rendered as text');
    assert.ok(!seen.text.includes('${escapeHtml('), 'no unevaluated template literal is rendered as text');
    assert.deepEqual(errors, [], 'the page raises no script error');
  } finally {
    await browser.close();
  }
});
