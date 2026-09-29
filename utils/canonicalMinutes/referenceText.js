'use strict';

// Mixed letter/number tokens in a meeting title are often internal project or client
// references. They remain useful metadata, but repeating one in an objective can make it
// read as though the code describes the type of audit, review or event. Standards written
// as a single token are explicitly protected; spaced standards such as "ISO 13485" never
// match this pattern in the first place.
const OPAQUE_REFERENCE = /\b(?!(?:ISO|IEC|ASTM|CFR|MDR)\d{3,6}\b)[A-Z]{1,3}\d{3,6}\b/gi;
// A reference introduced by a pure label ("Client M204", "Ref J1234") takes the label
// with it: "the Client Larkfield session" is no better than the code on its own.
const LABELLED_REFERENCE = /\b(?:client|ref(?:erence)?|account|job)\s+(?:no\.?\s+|number\s+)?(?=(?!(?:ISO|IEC|ASTM|CFR|MDR)\d{3,6}\b)[A-Z]{1,3}\d{3,6}\b)/gi;

function stripOpaqueMeetingReference(value = '') {
  return String(value == null ? '' : value)
    .replace(LABELLED_REFERENCE, '')
    .replace(OPAQUE_REFERENCE, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .replace(/\b(?:for|about|on|of)\s+the\s+\./gi, '.')
    .replace(/\s+\./g, '.')
    .trim();
}

// Remove only the reference codes that appear in the meeting title (with any "Client"
// style label in front of them). Free prose can legitimately name product or model
// codes, so a summary body is cleaned against the title rather than by pattern alone.
function stripMeetingTitleReferences(value = '', title = '') {
  const codes = [...new Set(String(title || '').match(OPAQUE_REFERENCE) || [])];
  if (!codes.length) return String(value == null ? '' : value);
  const escaped = codes.map((code) => code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const labelled = new RegExp(`\\b(?:(?:client|ref(?:erence)?|account|job)\\s+(?:no\\.?\\s+|number\\s+)?)?(?:${escaped})\\b`, 'gi');
  return String(value == null ? '' : value)
    .replace(labelled, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();
}

module.exports = { stripOpaqueMeetingReference, stripMeetingTitleReferences };
