'use strict';

// A narrow veto for changed follow-up/commitment assertions in a correction. This is
// not a general semantic proof. Inherited, unchanged clauses remain untouched;
// a changed assertion needs a complete source clause, not a nearby keyword.
// Approval, completion, legal obligation and reporting certainty need their own
// source-aware proofs. Do not treat a noun such as "a plan" as a commitment,
// or "will need to" as a promise to perform the work.
const assertions = /\b(?:agreed|committed|decided|planned|planning|plans to|intends? to|intended to|promised|will(?!\s+need\s+to\b)|shall)\b/gi;
const normal = value => String(value || '').toLowerCase().replace(/[’‘]/g, "'")
  .replace(/\bwon't\b/g, 'will not').replace(/\bcan't\b/g, 'cannot')
  .replace(/\b([\p{L}]+)'ll\b/gu, '$1 will')
  .replace(/(?<=\d)[.,](?=\d)/g, value => value === '.' ? ' decimalpoint ' : ' groupcomma ')
  .replace(/(?<=\p{L})[-–—](?=\p{L})/gu, ' ').replace(/[–—]/g, '-')
  .replace(/[^\p{L}\p{N}\p{Sc}'+%:\- ]/gu, ' ').replace(/\s+/g, ' ').trim();
const clauses = value => [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(String(value || ''))]
  .flatMap(part => part.segment.split(';')).map(value => value.trim()).filter(Boolean);

function correctionMeaningIssue(original, corrected, sourceUnits = []) {
  const inherited = new Set(clauses(original).map(normal));
  const units = sourceUnits.filter(unit => typeof unit?.id === 'string' && unit.id
    && typeof unit.text === 'string' && unit.text.trim());
  const counts = new Map();
  for (const unit of units) counts.set(unit.id, (counts.get(unit.id) || 0) + 1);
  const sourceIds = [];
  for (const clause of clauses(corrected)) {
    if (!new RegExp(assertions.source, 'i').test(clause) || inherited.has(normal(clause))) continue;
    // Do not split a source semicolon: a qualification can govern its sibling.
    // First-person reporting is permitted only when the complete turn binds it
    // to an explicitly named speaker. No recipient/name guessing.
    const carrying = units.filter(unit => {
      if (counts.get(unit.id) !== 1) return false;
      if (/[?？]/.test(clause) !== /[?？]/.test(unit.text)
        || /["“”]/.test(clause) !== /["“”]/.test(unit.text)) return false;
      const source = normal(unit.text), speaker = normal(unit.speaker);
      const attributed = speaker ? source.replace(/^i\b/, speaker) : source;
      return normal(clause) === source || normal(clause) === attributed;
    });
    if (!carrying.length) return { reason: 'correction_assertion_strength_not_proved' };
    sourceIds.push(carrying[0].id);
  }
  return { sourceIds: [...new Set(sourceIds)] };
}

const commitmentClauses = value => clauses(value).filter(clause => new RegExp(assertions.source, 'i').test(clause));
module.exports = { correctionMeaningIssue, commitmentClauses };
