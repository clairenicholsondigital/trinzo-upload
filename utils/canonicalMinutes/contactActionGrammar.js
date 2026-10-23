'use strict';

// Parse only an explicit, single named recipient in a direct contact
// instruction. This describes syntax; it never establishes task equivalence.
// Lists, titles with punctuation, quotations and unfamiliar grammar retain the
// existing parser rather than receiving a guessed recipient or destination.
const PREFIX = /^\s*(?:please\s+)?(?:speak|talk|discuss|check|liaise|consult|meet|coordinate)\s+(?:to|with)\s+/i;
const NAME = /^([\p{Lu}][\p{L}'’-]*(?:\s+[\p{Lu}][\p{L}'’-]*){0,11})(?=\s+(?:to|about|regarding|concerning|the|a|an|in|at|on)\b|\s*[.!]?\s*$)/u;
// These forms are unambiguously verbal in this construction. Do not strip
// ambiguous objects such as "to check point", or capitalised place names.
const PURPOSE = /\bto\s+(?=(?:clarify|avoid|understand|ensure|determine|establish|identify|confirm|agree)\b)/g;
const NAMED_DESTINATION = /\b(into|onto|in|at|on|to)\s+(?:the\s+)?([\p{Lu}][\p{L}'’-]*(?:\s+[\p{Lu}][\p{L}'’-]*){0,5})(?=\s+(?:for|by|before|after|and|to|once|when)\b|[.!]|$)/gu;
const normal = value => value.normalize('NFKC').replace(/[’]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();

function contactActionFrame(value) {
  const text = String(value || '').trim();
  if (text.length > 1600 || /[,;:"“”()[\]{}?&]/.test(text)) return null;
  const prefix = text.match(PREFIX);
  if (!prefix) return null;
  const rest = text.slice(prefix[0].length), name = rest.match(NAME);
  if (!name) return null;
  if (/\b(?:to|with|the|in|at|on|about|regarding|concerning|and|or)\b/i.test(name[1])) return null;
  const body = rest.slice(name[0].length).trim();
  if (!body || /^[.!]$/.test(body)) return null;
  const destinationText = body.replace(PURPOSE, '');
  return { recipient: normal(name[1]), body, destinationText,
    namedDestinations: [...new Set([...destinationText.matchAll(NAMED_DESTINATION)].map(match => normal(`${match[1]} ${match[2]}`)))].sort() };
}

module.exports = { contactActionFrame };
