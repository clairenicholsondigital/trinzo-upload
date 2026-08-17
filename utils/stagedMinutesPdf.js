const { chromium } = require('playwright');
const fs = require('fs');

let robotoFaces = '';

function embeddedRobotoFaces() {
  if (robotoFaces) return robotoFaces;
  robotoFaces = [400, 500, 700].map((weight) => {
    const fontPath = require.resolve(`@fontsource/roboto/files/roboto-latin-${weight}-normal.woff2`);
    const fontData = fs.readFileSync(fontPath).toString('base64');
    return `@font-face { font-family:'Roboto'; font-style:normal; font-weight:${weight}; font-display:block; src:url(data:font/woff2;base64,${fontData}) format('woff2'); }`;
  }).join('\n');
  return robotoFaces;
}

function clean(value, fallback = '') {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeList(value) {
  return (Array.isArray(value) ? value : []).map((item) => clean(item)).filter(Boolean).slice(0, 100);
}

function attendeeLists(details = {}) {
  let internal = safeList(details.internalAttendees);
  const client = safeList(details.clientAttendees);
  const combined = safeList(details.participants || details.allAttendees);
  if (!internal.length && !client.length && combined.length) internal = combined;
  return { internal, client };
}

function formatUkDate(value) {
  const text = clean(value, 'Not stated');
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return text;
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) return text;
  return `${day} ${months[monthIndex]} ${match[1]}`;
}

function normaliseMinutes(input = {}) {
  const details = input.details && typeof input.details === 'object' ? input.details : {};
  const attendees = attendeeLists(details);
  const summary = input.summary && typeof input.summary === 'object' ? input.summary : {};
  return {
    details: {
      meetingTitle: clean(details.meetingTitle, 'Meeting minutes').slice(0, 500),
      meetingDate: formatUkDate(details.meetingDate).slice(0, 100),
      meetingLocation: clean(details.meetingLocation, 'Not stated').slice(0, 500),
      clientAttendeeLabel: clean(details.clientAttendeeLabel, 'Client').slice(0, 50),
      internalAttendees: attendees.internal,
      clientAttendees: attendees.client
    },
    summary: {
      objectives: safeList(summary.objectives),
      executiveSummary: clean(summary.executiveSummary, 'Not stated').slice(0, 20000)
    },
    discussion: (Array.isArray(input.discussion) ? input.discussion : []).map((item) => ({
      topic: clean(item?.topic, 'Discussion').slice(0, 1000),
      points: safeList(item?.points || item?.bullets)
    })).filter((item) => item.points.length).slice(0, 100),
    actions: (Array.isArray(input.actions) ? input.actions : []).map((item) => ({
      owner: clean(item?.owner, 'Not stated').slice(0, 500),
      action: clean(item?.action).slice(0, 5000),
      deadline: clean(item?.deadline, 'Not stated').slice(0, 500)
    })).filter((item) => item.action).slice(0, 200)
  };
}

function renderList(items, fallback = 'Not stated') {
  if (!items.length) return `<p>${escapeHtml(fallback)}</p>`;
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function renderStagedMinutesPdfHtml(input = {}) {
  const minutes = normaliseMinutes(input);
  const { details, summary, discussion, actions } = minutes;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(details.meetingTitle)}</title>
<style>
  ${embeddedRobotoFaces()}
  @page { size:A4; margin:14mm; }
  * { box-sizing:border-box; }
  body { margin:0; color:#17222c; font:400 10.5pt/1.45 'Roboto'; }
  header { display:flex; justify-content:space-between; gap:20px; border-bottom:5px solid #17d0c4; padding-bottom:12px; margin-bottom:18px; }
  header p { margin:0 0 3px; color:#287084; font-size:9pt; font-weight:700; text-transform:uppercase; letter-spacing:.08em; }
  h1 { margin:0; color:#02173b; font-size:22pt; line-height:1.15; }
  h2 { margin:20px 0 8px; color:#02173b; font-size:14pt; break-after:avoid; }
  p { margin:0 0 8px; }
  ul { margin:5px 0 8px; padding-left:20px; }
  li { margin:2px 0; }
  .meta { display:grid; grid-template-columns:1fr 1fr; border:1px solid #cfdbe4; border-radius:8px; overflow:hidden; }
  .meta div { padding:8px 10px; border-bottom:1px solid #e1e8ed; }
  .meta div:nth-child(odd) { border-right:1px solid #e1e8ed; }
  .label { display:block; color:#5d6b78; font-size:8pt; font-weight:500; text-transform:uppercase; }
  table { width:100%; border-collapse:collapse; break-inside:auto; }
  tr { break-inside:avoid; }
  th, td { border:1px solid #cfdbe4; padding:7px 8px; text-align:left; vertical-align:top; }
  th { color:#445463; background:#eef4f6; font-size:8pt; font-weight:500; text-transform:uppercase; }
  .discussion th:first-child { width:29%; }
  .actions th:first-child { width:20%; }
  .actions th:last-child { width:20%; }
  .footer { margin-top:20px; padding-top:8px; border-top:1px solid #cfdbe4; color:#687785; font-size:8pt; }
</style></head><body>
<header><div><p>Meeting minutes</p><h1>${escapeHtml(details.meetingTitle)}</h1></div></header>
<section class="meta">
  <div><span class="label">Date</span>${escapeHtml(details.meetingDate)}</div>
  <div><span class="label">Location</span>${escapeHtml(details.meetingLocation)}</div>
  <div><span class="label">Internal attendees</span>${escapeHtml(details.internalAttendees.join(', ') || 'Not stated')}</div>
  <div><span class="label">${escapeHtml(details.clientAttendeeLabel)} attendees</span>${escapeHtml(details.clientAttendees.join(', ') || 'Not stated')}</div>
</section>
<h2>Objectives</h2>${renderList(summary.objectives)}
<h2>Executive summary</h2><p>${escapeHtml(summary.executiveSummary)}</p>
<h2>Key discussion points</h2>
<table class="discussion"><thead><tr><th>Topic</th><th>Discussion points</th></tr></thead><tbody>
${discussion.length ? discussion.map((item) => `<tr><td>${escapeHtml(item.topic)}</td><td>${renderList(item.points)}</td></tr>`).join('') : '<tr><td>Discussion</td><td>Not stated</td></tr>'}
</tbody></table>
<h2>Actions</h2>
<table class="actions"><thead><tr><th>Owner</th><th>Action</th><th>Due</th></tr></thead><tbody>
${actions.length ? actions.map((item) => `<tr><td>${escapeHtml(item.owner)}</td><td>${escapeHtml(item.action)}</td><td>${escapeHtml(item.deadline)}</td></tr>`).join('') : '<tr><td>Not stated</td><td>No actions recorded.</td><td>Not stated</td></tr>'}
</tbody></table>
<p class="footer">Generated by Trinzo meeting minutes workflow. Review and approve before sharing externally.</p>
</body></html>`;
}

function stagedMinutesPdfFilename(input = {}) {
  const title = clean(input?.details?.meetingTitle, 'meeting-minutes')
    .replace(/[^a-z0-9 _-]+/gi, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100) || 'meeting-minutes';
  return `${title}.pdf`;
}

async function generateStagedMinutesPdf(input = {}) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(renderStagedMinutesPdfHtml(input), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    return await page.pdf({ format: 'A4', printBackground: true, displayHeaderFooter: false, preferCSSPageSize: true });
  } finally {
    await browser.close();
  }
}

module.exports = { formatUkDate, generateStagedMinutesPdf, normaliseMinutes, renderStagedMinutesPdfHtml, stagedMinutesPdfFilename };
