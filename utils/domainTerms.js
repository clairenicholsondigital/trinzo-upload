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
  { original: 'Deta Inc', replacement: 'DITA', reason: 'Recognised organisation name correction' },
  { original: 'DD Inc', replacement: 'DITA', reason: 'Recognised organisation name correction' },
  { original: 'T Inc', replacement: 'DITA', reason: 'Recognised organisation name correction' },
  { original: 'Medsap', replacement: 'MDSAP', reason: 'Recognised terminology correction' },
  { original: 'Meds app', replacement: 'MDSAP', reason: 'Recognised terminology correction' },
  { original: 'S-BOM', replacement: 'SBOM', reason: 'Recognised terminology correction' },
  { original: 'Kappa', replacement: 'CAPA', reason: 'Recognised terminology correction' },
  { original: 'Kappas', replacement: 'CAPAs', reason: 'Recognised terminology correction' },
  // Teams' transcription of "Cognidocs" (the document-control system) - confirmed on T761.
  { original: 'call me docs', replacement: 'Cognidocs', reason: 'Recognised terminology correction' },
  { original: 'call me doc', replacement: 'Cognidocs', reason: 'Recognised terminology correction' },
  // British spelling throughout published minutes, regardless of which the transcript used.
  { original: 'labeling', replacement: 'labelling', reason: 'British spelling' },
  { original: 'labeled', replacement: 'labelled', reason: 'British spelling' }
];

// ---- Corrections applied to the TRANSCRIPT, before any model sees it ------
//
// AUTO_CORRECTIONS above rewrite what is printed. These rewrite what the
// models read, which is the only way to fix a phrase the transcript states
// correctly but a reader can misunderstand.
//
// "It's under his name because it's from Abbott rate's point of view" is the
// hotel booked on Abbott's corporate rate. Teams heard it right; the capital
// R made it look like a company, and the minutes then said the booking was
// "for Abbott Rate's audit" - a room rate owning an audit. Rewriting the
// phrase before extraction fixes the meaning rather than the spelling.
//
// Keep this list to phrases the client has confirmed: a wrong entry silently
// rewrites the source of truth, and the evidence panel shows this text.
const TRANSCRIPT_PHRASE_CORRECTIONS = [
  {
    pattern: /\bAbbott\s+rate\b/gi,
    replacement: 'Abbott corporate rate',
    reason: 'Abbott’s negotiated hotel rate, not an organisation'
  }
];

// Returns { text, applied } so a caller can log what it changed. Idempotent:
// each replacement no longer matches its own pattern.
function applyTranscriptPhraseCorrections(value) {
  let text = String(value == null ? '' : value);
  const applied = [];
  for (const rule of TRANSCRIPT_PHRASE_CORRECTIONS) {
    const matches = text.match(rule.pattern);
    if (!matches || !matches.length) continue;
    text = text.replace(rule.pattern, rule.replacement);
    applied.push({ from: matches[0], to: rule.replacement, count: matches.length, reason: rule.reason });
  }
  return { text, applied };
}

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

function normaliseDomainTerms(value) {
  return String(value == null ? '' : value)
    .replace(/\b(?:udimed|udemed)\b/gi, 'EUDAMED')
    // "call me docs" / "Call Me Doc" / "call-me-docs" / "callmedocs" is Teams
    // mishearing Cognidocs, the document-control system.
    .replace(/\bcall[\s-]*me[\s-]*docs?\b/gi, 'Cognidocs')
    .replace(/\b(?:deta|dd|t)\s+inc\b/gi, 'DITA')
    .replace(/\b(?:medsap|meds[\s-]*app)\b/gi, 'MDSAP');
}

function normaliseDomainTermsDeep(value) {
  if (typeof value === 'string') return normaliseDomainTerms(value);
  if (Array.isArray(value)) return value.map(normaliseDomainTermsDeep);
  if (value && typeof value === 'object') {
    if (value instanceof Date) return value;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normaliseDomainTermsDeep(item)]));
  }
  return value;
}

// Backwards-compatible names for modules outside this repository that imported
// the original single-term helper.
const normaliseUdimed = normaliseDomainTerms;
const normaliseUdimedDeep = normaliseDomainTermsDeep;

module.exports = {
  DOMAIN_TERMS,
  AUTO_CORRECTIONS,
  TRANSCRIPT_PHRASE_CORRECTIONS,
  applyTranscriptPhraseCorrections,
  DOMAIN_TERM_PATTERN,
  mentionsDomainTerm,
  normaliseDomainTerms,
  normaliseDomainTermsDeep,
  normaliseUdimed,
  normaliseUdimedDeep,
  escapeRegExp
};
