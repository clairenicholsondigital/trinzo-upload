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
  },
  // Mis-transcriptions found across the twenty benchmark transcripts on
  // 2026-09-27, each confirmed by the sentence around it. Standards first:
  // "IEC, AC, cricky... IEC AC1001" beside 62304 and the lifecycle is
  // 81001-5-1; "IEC 6061-1" and a bare "IEC 6060" beside MDD and electrical
  // testing are 60601-1.
  { pattern: /\bIEC,?\s*(?:AC,?\s*)?AC\s?1001\b/gi, replacement: 'IEC 81001-5-1', reason: 'Standard number misheard' },
  { pattern: /\bAC\s?1001\b/g, replacement: '81001-5-1', reason: 'Standard number misheard' },
  { pattern: /\bIEC\s*6061(?:-1)?\b/gi, replacement: 'IEC 60601-1', reason: 'Standard number misheard' },
  { pattern: /\bIEC\s*6060\b(?![\d-])/gi, replacement: 'IEC 60601-1', reason: 'Standard number misheard' },
  { pattern: /\bEUMDR\b/g, replacement: 'EU MDR', reason: 'Regulation name run together' },
  // Organisations and systems. DITA is heard as Data/Deta/DJ/DT/DD/T Inc.;
  // MedEnvoy (the EU authorised representative) as two words with either
  // spelling; EUDAMED as "you to med" and Udimed/Udemed/Udamed; Cognidocs as
  // "call me docs" and "Cogni Docs".
  { pattern: /\b(?:Data|Deta|DJ|DT|DD|T)\s+Inc\b\.?/g, replacement: 'DITA', reason: 'Organisation name misheard' },
  { pattern: /\bDeta\b(?=\s+(?:here|in|at|is|are|do|does|has|have|will|would|and))/g, replacement: 'DITA', reason: 'Organisation name misheard' },
  { pattern: /\bme[dt]\s+envoy\b/gi, replacement: 'MedEnvoy', reason: 'Organisation name split' },
  { pattern: /\byou\s+to\s+med\b/gi, replacement: 'EUDAMED', reason: 'EUDAMED misheard' },
  { pattern: /\bud[aei]med\b/gi, replacement: 'EUDAMED', reason: 'EUDAMED misheard' },
  { pattern: /\bcall[\s-]*me[\s-]*docs?\b/gi, replacement: 'Cognidocs', reason: 'Cognidocs misheard' },
  { pattern: /\bcogni\s+docs?\b/gi, replacement: 'Cognidocs', reason: 'Cognidocs split' },
  { pattern: /\bKappa(s?)\b/g, replacement: 'CAPA$1', reason: 'CAPA misheard' },
  { pattern: /\bS-BOM\b/gi, replacement: 'SBOM', reason: 'SBOM hyphenated' },
  { pattern: /\bOReilly\b/g, replacement: "O'Reilly", reason: 'Apostrophe dropped' },
  // Codes: the letter O for a zero in a technical-file number; UDI-DI run
  // together; "A1 in 100" is "a 1 in 100".
  { pattern: /\bTFO(\d)\b/g, replacement: 'TF0$1', reason: 'Letter O for zero' },
  { pattern: /\bUDIDI\b/g, replacement: 'UDI-DI', reason: 'UDI-DI run together' },
  { pattern: /\bA1 in (\d+)\b/g, replacement: 'a 1 in $1', reason: 'Probability phrase misheard' },
  // Homophones in regulatory talk: "cheque" is "check" when it is a verb
  // ("just to cheque through", "cheque in with", "do a cheque that"). A
  // cheque somebody pays with ("by cheque", "a cheque for") is left alone.
  { pattern: /\b(to|just|double|quick|cross|do a|I'll|we'll|I will|we will|and)\s+cheque\b/gi, replacement: '$1 check', reason: 'Homophone' },
  { pattern: /\bcheque\s+(through|in with|that|with|if|whether|on|the|it|this|these|those|what|how|when)\b/gi, replacement: 'check $1', reason: 'Homophone' },
  { pattern: /\bport\s+luck\b/gi, replacement: 'port lock', reason: 'Homophone' },
  { pattern: /\blabeling\b/g, replacement: 'labelling', reason: 'British spelling' },
  { pattern: /\blabeled\b/g, replacement: 'labelled', reason: 'British spelling' }
];

// Returns { text, applied } so a caller can log what it changed. Idempotent:
// each replacement no longer matches its own pattern.
function applyTranscriptPhraseCorrections(value) {
  let text = String(value == null ? '' : value);
  const applied = [];
  for (const rule of TRANSCRIPT_PHRASE_CORRECTIONS) {
    const matches = text.match(rule.pattern);
    if (!matches || !matches.length) continue;
    let firstTo = '';
    text = text.replace(rule.pattern, (...args) => {
      const match = args[0];
      const offset = args[args.length - 2];
      const groups = args.slice(1, args.length - 2).map((value) => (typeof value === 'string' ? value : ''));
      let out = rule.replacement.replace(/\$(\d)/g, (_, n) => groups[Number(n) - 1] || '');
      // A correction that opens a sentence keeps its capital ("Port luck." ->
      // "Port lock."); one inside a sentence does not gain one.
      const opensSentence = offset === 0 || /(?:^|[.!?])\s*$/.test(text.slice(0, offset));
      if (opensSentence && /^[A-Z]/.test(match) && /^[a-z]/.test(out)) out = out[0].toUpperCase() + out.slice(1);
      if (!firstTo) firstTo = out;
      return out;
    });
    applied.push({ from: matches[0], to: firstTo, count: matches.length, reason: rule.reason });
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
