'use strict';

// Keep validation aligned with the separator-insensitive corrections and
// acronym plurals accepted by the glossary renderer.
const spellingKey = value => String(value || '').normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[\s-]+/g, '').toLowerCase();
function isAcronymTerm(term) {
  return /[A-Z]$/.test(term) && /^[^a-z]*$/.test(term.replace(/[^A-Za-z]/g, '').slice(1));
}
function termSurfaces(entry) {
  const forms = [entry.term, ...(entry.heardAs || [])];
  return [...new Set(forms.flatMap(value => isAcronymTerm(entry.term) ? [spellingKey(value), spellingKey(`${value}s`)] : [spellingKey(value)]))];
}
module.exports = { spellingKey, isAcronymTerm, termSurfaces };
