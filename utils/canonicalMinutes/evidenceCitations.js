'use strict';

// Resolving a model's claims against the evidence it cites.
//
// Extracted from trooperPolish so the summary polish can validate the same way the
// discussion polish always has: not "does this wording resemble the input fields" but
// "do the turns this claim cites actually contain it". The discussion validators'
// behaviour is pinned by its tests and must not drift, which is why this is a move,
// not a copy - one implementation, two callers.

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function evidenceIdsFor(item) {
  return new Set((item?.evidence || []).flatMap((entry) => [entry?.id, ...(entry?.contextWindow || []).map((context) => context?.id)]).map(clean).filter(Boolean));
}

function validReferences(candidate, source) {
  const allowed = evidenceIdsFor(source);
  const cited = Array.isArray(candidate?.evidenceIds) ? candidate.evidenceIds.map(clean).filter(Boolean) : [];
  return cited.length > 0 && cited.every((id) => allowed.has(id));
}

function evidenceEntriesFor(item) {
  return (item?.evidence || []).flatMap((entry) => [
    { id: entry?.id, speaker: entry?.speaker, text: entry?.current },
    ...(entry?.contextWindow || []).map((context) => ({ id: context?.id, speaker: context?.speaker, text: context?.text }))
  ]).filter((entry) => clean(entry.id));
}

function citedEntries(candidate, source) {
  const cited = new Set((candidate?.evidenceIds || []).map(clean));
  return evidenceEntriesFor(source).filter((entry) => cited.has(clean(entry.id)));
}

// Pack-level variants: the summary pack is a flat list of entries rather than one
// candidate's evidence, so the same questions are asked of the whole pack.
function packEntryIds(pack) {
  return new Set((Array.isArray(pack) ? pack : []).flatMap((item) => [...evidenceIdsFor(item)]));
}

function packCitedText(pack, evidenceIds) {
  const cited = new Set((Array.isArray(evidenceIds) ? evidenceIds : []).map(clean).filter(Boolean));
  return (Array.isArray(pack) ? pack : [])
    .flatMap((item) => evidenceEntriesFor(item))
    .filter((entry) => cited.has(clean(entry.id)))
    .map((entry) => clean(entry.text))
    .filter(Boolean)
    .join(' ');
}

module.exports = { evidenceIdsFor, validReferences, evidenceEntriesFor, citedEntries, packEntryIds, packCitedText };
