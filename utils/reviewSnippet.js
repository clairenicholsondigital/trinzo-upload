'use strict';

// Injecting the review-feedback snippet into a served view.
//
// This used to be `html.replace(/<\/body>/i, ...)`, which anchors on the FIRST
// `</body>` in the file. That is only the document's own closing tag when no script
// on the page builds an HTML document as a string - and the jobs page does exactly
// that, for its PDF export. The snippet landed 68% of the way through
// meeting-minutes-jobs.html, inside a template literal, and its own `></script>`
// closed the page's real script element: every line of JS after that point rendered
// on screen as text. The view had carefully written `<\/script>` on that same line
// to protect itself from the HTML parser; it could not protect itself from the
// server rewriting its bytes.
//
// The document's closing `</body>` is the last one by definition - anything after it
// is not part of the body - so anchoring on the last occurrence is not a workaround
// for this one file, it is the correct anchor for any file.

const SNIPPET = [
  '<script',
  '  defer',
  '  src="/static/review-snippet.js"',
  '  data-endpoint="/api/review-feedback"',
  '  data-project="trinzo"',
  '  data-accent="#17D0C4"',
  '  data-max-image-width="1600"',
  '></script>'
].join('\n');

function addReviewSnippet(html) {
  const source = String(html == null ? '' : html);
  if (source.includes('/static/review-snippet.js')) return source;
  const closingBody = source.toLowerCase().lastIndexOf('</body>');
  if (closingBody < 0) return source;
  return `${source.slice(0, closingBody)}${SNIPPET}\n${source.slice(closingBody)}`;
}

module.exports = { addReviewSnippet, SNIPPET };
