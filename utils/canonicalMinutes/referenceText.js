'use strict';

// Mixed letter/number tokens in a meeting title are often internal project or client
// references. They remain useful metadata, but repeating one in an objective can make it
// read as though the code describes the type of audit, review or event. Standards written
// as a single token are explicitly protected; spaced standards such as "ISO 13485" never
// match this pattern in the first place.
const OPAQUE_REFERENCE = /\b(?!(?:ISO|IEC|ASTM|CFR|MDR)\d{3,6}\b)[A-Z]{1,3}\d{3,6}\b/gi;

function stripOpaqueMeetingReference(value = '') {
  return String(value == null ? '' : value)
    .replace(OPAQUE_REFERENCE, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .replace(/\b(?:for|about|on|of)\s+the\s+\./gi, '.')
    .replace(/\s+\./g, '.')
    .trim();
}

module.exports = { stripOpaqueMeetingReference };
