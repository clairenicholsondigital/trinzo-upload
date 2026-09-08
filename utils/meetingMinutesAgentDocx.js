'use strict';

const JSZip = require('jszip');
function formatUkDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return String(value || '');
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'
  }).format(new Date(`${value}T00:00:00Z`));
}

function xml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function run(value, options = {}) {
  const bold = options.bold ? '<w:b/>' : '';
  const colour = options.colour ? `<w:color w:val="${options.colour}"/>` : '';
  const size = options.size ? `<w:sz w:val="${options.size}"/><w:szCs w:val="${options.size}"/>` : '';
  return `<w:r><w:rPr>${bold}${colour}${size}</w:rPr><w:t xml:space="preserve">${xml(value)}</w:t></w:r>`;
}

function paragraph(value, style = '', options = {}) {
  const styleXml = style ? `<w:pStyle w:val="${style}"/>` : '';
  const spacing = options.after === 0 ? '<w:spacing w:after="0"/>' : '';
  return `<w:p><w:pPr>${styleXml}${spacing}</w:pPr>${run(value, options)}</w:p>`;
}

function bullet(value) {
  return `<w:p><w:pPr><w:pStyle w:val="BodyText"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${run(value)}</w:p>`;
}

function cell(value, width, options = {}) {
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${options.shade ? `<w:shd w:fill="${options.shade}"/>` : ''}</w:tcPr>${paragraph(value, '', { bold: options.bold, colour: options.colour, after: 0 })}</w:tc>`;
}

function timingLabel(timing = {}) {
  if (timing.kind === 'not_stated' || (!timing.wording && !timing.exactDate)) return 'Not stated';
  const prefix = timing.kind === 'target' ? 'Target' : 'Deadline';
  const value = timing.exactDate ? formatUkDate(timing.exactDate) : timing.wording;
  return `${prefix}: ${value}`;
}

function actionTable(actions = []) {
  const header = `<w:tr>${cell('Action', 5600, { bold: true, shade: 'DCEFF1', colour: '123544' })}${cell('Owner', 1900, { bold: true, shade: 'DCEFF1', colour: '123544' })}${cell('Timing', 1900, { bold: true, shade: 'DCEFF1', colour: '123544' })}</w:tr>`;
  const rows = actions.map((action) => `<w:tr>${cell(action.action, 5600)}${cell((action.owners || []).join(', ') || 'Not stated', 1900)}${cell(timingLabel(action.timing), 1900)}</w:tr>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="B9CBD2"/><w:left w:val="single" w:sz="4" w:color="B9CBD2"/><w:bottom w:val="single" w:sz="4" w:color="B9CBD2"/><w:right w:val="single" w:sz="4" w:color="B9CBD2"/><w:insideH w:val="single" w:sz="4" w:color="D9E3E7"/><w:insideV w:val="single" w:sz="4" w:color="D9E3E7"/></w:tblBorders></w:tblPr>${header}${rows}</w:tbl>`;
}

function evidenceAppendix(draft = {}) {
  const units = Array.isArray(draft.sourceUnits) ? draft.sourceUnits : [];
  const flags = Array.isArray(draft.reviewFlags) ? draft.reviewFlags : [];
  const used = new Set();
  for (const topic of draft.discussion || []) {
    for (const item of [...(topic.points || []), ...(topic.decisions || []), ...(topic.openQuestions || [])]) {
      for (const id of item.evidenceIds || []) used.add(id);
    }
  }
  for (const action of draft.actions || []) for (const id of action.evidenceIds || []) used.add(id);
  let body = paragraph('Evidence appendix', 'Heading1');
  for (const unit of units.filter((item) => used.has(item.id))) {
    body += paragraph(`${unit.id} · ${unit.speaker}${unit.timestamp ? ` · ${unit.timestamp}` : ''}`, 'Heading3');
    body += paragraph(unit.text, 'BodyText');
  }
  if (flags.length) {
    body += paragraph('Review notes', 'Heading2');
    for (const flag of flags) body += bullet(`${flag.status === 'open' ? 'Open' : flag.status}: ${flag.message}`);
  }
  return body;
}

function documentBody(draft = {}, includeEvidence = false) {
  const details = draft.details || {};
  let body = paragraph(details.meetingTitle || draft.title || 'Meeting minutes', 'Title');
  body += paragraph(`Date: ${details.meetingDate ? formatUkDate(details.meetingDate) : 'Not stated'}`, 'Subtitle');
  body += paragraph(`Location: ${details.meetingLocation || 'Not stated'}`, 'Subtitle');
  body += paragraph(`Meeting type: ${details.meetingType || 'Not stated'}`, 'Subtitle');
  body += paragraph(`Internal attendees: ${(details.internalAttendees || []).join(', ') || 'Not stated'}`, 'Subtitle');
  body += paragraph(`${details.clientAttendeeLabel === 'External' ? 'External' : 'Client'} attendees: ${(details.clientAttendees || []).join(', ') || 'Not stated'}`, 'Subtitle');
  // Objectives and the executive summary lead the document when present, and are
  // omitted entirely when absent so an older draft exports exactly as it did before.
  const objectives = (Array.isArray(draft.meetingObjectives) ? draft.meetingObjectives : [])
    .map((item) => (typeof item === 'string' ? item : item?.text))
    .filter(Boolean);
  if (objectives.length) {
    body += paragraph('Meeting objectives', 'Heading1');
    body += objectives.map((item) => bullet(item)).join('');
  }
  if (draft.executiveSummary) {
    body += paragraph('Executive summary', 'Heading1');
    body += paragraph(draft.executiveSummary, 'BodyText');
  }
  body += paragraph('Discussion', 'Heading1');
  for (const topic of draft.discussion || []) {
    body += paragraph(topic.topic || 'Discussion', 'Heading2');
    for (const point of topic.points || []) body += bullet(point.text);
  }
  const decisions = (draft.discussion || []).flatMap((topic) => (topic.decisions || []).map((item) => ({ topic: topic.topic, ...item })));
  body += paragraph('Decisions', 'Heading1');
  body += decisions.length ? decisions.map((item) => bullet(`${item.topic}: ${item.text}`)).join('') : paragraph('No decisions recorded.', 'BodyText');
  const questions = (draft.discussion || []).flatMap((topic) => (topic.openQuestions || []).map((item) => ({ topic: topic.topic, ...item })));
  body += paragraph('Open questions', 'Heading1');
  body += questions.length ? questions.map((item) => bullet(`${item.topic}: ${item.text}`)).join('') : paragraph('No open questions recorded.', 'BodyText');
  body += paragraph('Actions', 'Heading1');
  body += (draft.actions || []).length ? actionTable(draft.actions) : paragraph('No actions recorded.', 'BodyText');
  if (includeEvidence) body += evidenceAppendix(draft);
  return body;
}

async function generateMeetingMinutesAgentDocx(draft = {}, includeEvidence = false) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`);
  zip.folder('_rels').file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  const word = zip.folder('word');
  word.file('_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`);
  word.file('styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="20"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="120"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:pPr><w:spacing w:after="180"/></w:pPr><w:rPr><w:b/><w:color w:val="123544"/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:pPr><w:spacing w:after="60"/></w:pPr><w:rPr><w:color w:val="53636D"/><w:sz w:val="19"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:spacing w:before="260" w:after="120"/></w:pPr><w:rPr><w:b/><w:color w:val="087F82"/><w:sz w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:spacing w:before="180" w:after="80"/></w:pPr><w:rPr><w:b/><w:color w:val="123544"/><w:sz w:val="23"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:rPr><w:b/><w:color w:val="53636D"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="BodyText"><w:name w:val="Body Text"/></w:style></w:styles>`);
  word.file('numbering.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="720"/></w:tabs><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`);
  word.file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${documentBody(draft, includeEvidence)}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function docxFilename(draft = {}) {
  const title = String(draft.details?.meetingTitle || draft.title || 'Meeting minutes').replace(/[^A-Za-z0-9 ._-]+/g, '').trim() || 'Meeting minutes';
  return `${title.slice(0, 90)}.docx`;
}

module.exports = { generateMeetingMinutesAgentDocx, docxFilename, timingLabel };
