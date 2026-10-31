'use strict';

const { evidenceContextFor, comparisonText, materialTokens } = require('./meetingMinutesEvidenceContext');
const { contentTokens, COMMON_SPEECH_WORDS } = require('./meetingMinutesRecordMatching');
const { aboutWords } = require('./meetingMinutesActionSourceMatching');

// ---------------------------------------------------------------------------
// Correctness checks (MEETING_MINUTES_AGENT_CORRECTNESS_V1)
//
// Each check is deterministic and transcript-agnostic. They either correct a
// value the evidence contradicts (agent output only) or surface it to the
// reviewer as a flag; none invents content.
// ---------------------------------------------------------------------------
function correctnessChecksEnabled() {
  return /^(?:1|true|yes|on)$/i.test(String(process.env.MEETING_MINUTES_AGENT_CORRECTNESS_V1 || '0'));
}

const NOVELTY_STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'will', 'can', 'its', 'our', 'not', 'but', 'all', 'any', 'each', 'which',
  'what', 'when', 'where', 'who', 'whom', 'whose', 'than', 'then', 'them', 'these', 'those', 'some', 'such', 'very',
  'well', 'should', 'must', 'may', 'might', 'shall', 'has', 'had', 'did', 'does', 'done', 'upon', 'per', 'via',
  'within', 'without', 'across', 'between', 'through', 'during', 'before', 'under', 'above', 'below', 'further',
  'once', 'here', 'both', 'few', 'most', 'other', 'same', 'own', 'too', 'how', 'why', 'because', 'while', 'until',
  'against', 'among', 'onto', 'off', 'out', 'his', 'her', 'him', 'she', 'you', 'your', 'about', 'after', 'again',
  'also', 'been', 'being', 'could', 'from', 'have', 'into', 'just', 'more', 'only', 'over', 'said', 'that',
  'their', 'there', 'they', 'this', 'with', 'would',
  'next', 'last', 'week', 'month', 'update', 'plan', 'ensure', 'provide', 'confirm', 'confirmed', 'check',
  'discuss', 'discussed', 'decision', 'decided', 'status', 'ongoing', 'progres', 'point', 'item', 'noted', 'note',
  'issue', 'required', 'require', 'including', 'include', 'regarding', 'related', 'relation', 'current',
  'currently', 'additional', 'new', 'first', 'second', 'potential', 'possible', 'expected', 'appropriate',
  'relevant', 'specific', 'overall', 'key', 'main', 'agreed', 'agreement'
]);

function transcriptVocabulary(units = []) {
  const context = evidenceContextFor(units);
  if (!context.vocabulary) {
    context.vocabulary = new Set(context.rows.flatMap((unit) => contentTokens(comparisonText(`${unit.speaker} ${unit.text}`))));
  }
  return context.vocabulary;
}

// Share of a claim's distinctive words the meeting never used. A reviewer's
// sentence about relocating the factory to Mars borrows "team" and "agreed"
// from every meeting, so lexical scoring alone found it three citations; its
// distinctive words ("relocate", "Mars", "quarter") appear nowhere at all.
function claimNovelty(value, units = []) {
  const vocabulary = transcriptVocabulary(units);
  const tokens = [...new Set(materialTokens(comparisonText(value)))].filter((token) => !NOVELTY_STOP_WORDS.has(token));
  if (!tokens.length) return 0;
  return tokens.filter((token) => !vocabulary.has(token)).length / tokens.length;
}

// Applies only to text that arrived without citations of its own, which in
// practice is what a reviewer typed. Unsupported text gets no decorative
// citations; the missing-evidence flag then asks for it to be checked.
function uncitedClaimSupported(value, resolved = {}, units = []) {
  return claimNovelty(value, units) < 0.6 && Number(resolved.supportScore || 0) >= 0.3;
}

const STRONG_REVISION_CUE = /(?:^|[.!?]\s*)(?:sorry\b|actually\b|correction\b|scratch that\b)|\b(?:(?:has|have|had)\s+(?:since\s+)?(?:slightly\s+)?changed|slightly\s+changed|since\s+changed|no\s+longer|i\s+was\s+wrong|i\s+got\s+that\s+wrong|not\s+any\s*more)\b/i;

const WEAK_REVISION_CUE = /^\s*but\b/i;

const PRESUMPTION_CUE = /\b(?:i\s+presumed|i\s+assumed|i\s+thought|we\s+thought|originally|initially|in\s+an\s+earlier\s+call|i\s+had\s+it\s+(?:as|that))\b/i;

// "I presumed the formative would be ready for submission ... But I think
// maybe that slightly changed": a record citing the first sentence states
// something its own speaker went on to revise. Surface the revision and cite
// it alongside; the reviewer decides which statement is current.
// The row cites both the assumption and its correction ("I presumed ... But I
// think maybe that slightly changed"): the model often fuses the two, so the
// reviewer is pointed at the correction. Strong correction wording only.
function citedRevisionUnit(units = [], evidenceIds = [], rowText = null) {
  const context = evidenceContextFor(units);
  const cited = [...new Set(evidenceIds)].map((id) => context.indexById.get(id)).filter(Number.isInteger).sort((a, b) => a - b);
  const rows = context.rows;
  const presumption = cited.find((index) => PRESUMPTION_CUE.test(String(rows[index]?.text || '')));
  if (presumption === undefined) return null;
  // Citations are sometimes enriched with lines from elsewhere in the meeting.
  // The row must be about what was presumed, or the correction is not its own.
  if (rowText !== null) {
    const presumed = aboutWords(rows[presumption]?.text || '');
    const shared = [...aboutWords(rowText)].filter((word) => presumed.has(word)).length;
    if (shared < 2) return null;
  }
  const correction = cited.find((index) => index > presumption && STRONG_REVISION_CUE.test(String(rows[index]?.text || '')));
  return correction === undefined ? null : rows[correction];
}

function laterRevisionUnit(units = [], evidenceIds = []) {
  const context = evidenceContextFor(units);
  const cited = new Set(evidenceIds);
  const indexes = evidenceIds.map((id) => context.indexById.get(id)).filter(Number.isInteger).sort((a, b) => a - b);
  for (const index of indexes) {
    const unit = context.rows[index];
    const unitTokens = [...new Set(materialTokens(comparisonText(unit.text)))]
      .filter((token) => !NOVELTY_STOP_WORDS.has(token) && !COMMON_SPEECH_WORDS.has(token));
    if (!unitTokens.length) continue;
    for (let next = index + 1; next <= index + 3 && next < context.rows.length; next += 1) {
      const later = context.rows[next];
      if (cited.has(later.id) || later.speaker !== unit.speaker) continue;
      const strong = STRONG_REVISION_CUE.test(later.text);
      const weak = WEAK_REVISION_CUE.test(later.text) && PRESUMPTION_CUE.test(unit.text);
      if (!strong && !weak) continue;
      const laterWords = new Set(contentTokens(comparisonText(later.text)));
      if (unitTokens.some((token) => laterWords.has(token))) return later;
    }
  }
  return null;
}

module.exports = {
  NOVELTY_STOP_WORDS,
  PRESUMPTION_CUE,
  citedRevisionUnit,
  claimNovelty,
  correctnessChecksEnabled,
  laterRevisionUnit,
  uncitedClaimSupported
};
