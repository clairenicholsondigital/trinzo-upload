'use strict';

// Single source of truth for medical-device / regulatory domain terminology.
//
// Every staged module that needs to recognise domain acronyms references this
// module instead of keeping its own drifting allowlist. These are GENERAL domain
// terms — the same vocabulary applies to any medical-device meeting — not
// per-transcript phrases, client names or product names. Keeping them in one
// place is what prevents the "spaghetti" of the same acronym list being
// copy-pasted (and diverging) across half a dozen files.

const DOMAIN_TERMS = [
  { canonical: 'CAPA', aliases: ['kappa', 'capper', 'capa'], category: 'quality' },
  { canonical: 'MDR', aliases: [], category: 'regulation' },
  { canonical: 'MDSAP', aliases: ['medsap', 'meds app'], category: 'regulation' },
  { canonical: 'CFR', aliases: [], category: 'regulation' },
  { canonical: 'PPE', aliases: [], category: 'regulation' },
  { canonical: 'QMS', aliases: [], category: 'quality' },
  { canonical: 'CER', aliases: [], category: 'documentation' },
  { canonical: 'DHF', aliases: [], category: 'documentation' },
  { canonical: 'UDI', aliases: [], category: 'labelling' },
  { canonical: 'EUDAMED', aliases: ['eudamed', 'udamed', 'udimed', 'udemed'], category: 'labelling' },
  { canonical: 'HPRA', aliases: [], category: 'authority' },
  { canonical: 'FMEA', aliases: [], category: 'risk' },
  { canonical: 'PMS', aliases: [], category: 'postmarket' },
  { canonical: 'SBOM', aliases: ['s-bom'], category: 'software' },
  { canonical: 'ISO', aliases: [], category: 'standard' },
  { canonical: 'IEC 60601', aliases: ['iec 60601', 'iec60601', '60601'], category: 'standard' },
  { canonical: 'IEC 81001-5-1', aliases: ['81001-5-1', '81001'], category: 'standard' },
  { canonical: 'IEC 27427', aliases: ['27427'], category: 'standard' }
];

// General domain mishearing corrections (any transcript can contain these —
// they are not tied to one meeting). Used by the terminology-QA "check these
// terms" surface.
const AUTO_CORRECTIONS = [
  { original: 'Udemed', replacement: 'EUDAMED', reason: 'Recognised terminology correction' },
  { original: 'Udimed', replacement: 'EUDAMED', reason: 'Recognised terminology correction' },
  { original: 'Meds app', replacement: 'MDSAP', reason: 'Recognised terminology correction' },
  { original: 'S-BOM', replacement: 'SBOM', reason: 'Recognised terminology correction' },
  { original: 'Kappa', replacement: 'CAPA', reason: 'Recognised terminology correction' },
  { original: 'Kappas', replacement: 'CAPAs', reason: 'Recognised terminology correction' },
  // Teams' transcription of "Cognidox" (the document-control system) - confirmed on T761.
  { original: 'call me docs', replacement: 'Cognidox', reason: 'Recognised terminology correction' },
  { original: 'call me doc', replacement: 'Cognidox', reason: 'Recognised terminology correction' },
  // British spelling throughout published minutes, regardless of which the transcript used.
  { original: 'labeling', replacement: 'labelling', reason: 'British spelling' },
  { original: 'labeled', replacement: 'labelled', reason: 'British spelling' }
];

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Alternation of every canonical + alias surface form (longest first so the
// most specific form wins), for cheap "does this text mention a domain term?"
// checks.
const DOMAIN_TERM_ALTERNATION = [...new Set(DOMAIN_TERMS.flatMap((term) => [term.canonical, ...term.aliases]))]
  .filter(Boolean)
  .sort((left, right) => right.length - left.length)
  .map(escapeRegExp)
  .join('|');

const DOMAIN_TERM_PATTERN = new RegExp(`\\b(?:${DOMAIN_TERM_ALTERNATION})\\b`, 'i');

function mentionsDomainTerm(value) {
  return DOMAIN_TERM_PATTERN.test(String(value || ''));
}

module.exports = { DOMAIN_TERMS, AUTO_CORRECTIONS, DOMAIN_TERM_PATTERN, mentionsDomainTerm, escapeRegExp };
