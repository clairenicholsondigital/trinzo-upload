'use strict';

// Which kinds of purpose do reviewers actually keep?
//
// This is the readout for the one honest measure of the purpose work. The corpus cannot
// answer it - 115 mostly invented transcripts, and every purpose the title transform
// produces lands on one of them. Reviewers answer it every time they finish a draft: the
// review event records where the purpose came from (purposeSource) and what they did with
// it (purposeEdit, graded by the same classifier as every other field).
//
// Without this script the answer exists but takes an archaeology project to extract. With
// it the answer is one command:
//
//   node scripts/purpose_acceptance_report.js            last 90 days
//   node scripts/purpose_acceptance_report.js --days 30
//
// Reading the table: accepted_unchanged and wording_or_formatting_edit mean the purpose
// did its job. substantive_rewrite and structural_or_semantic_change mean the reviewer
// threw it away and wrote their own - which for a purpose we composed is the reviewer
// telling us the composition does not work. not_recorded rows predate the field.

const { query } = require('../utils/db');

const GRADE_ORDER = [
  'accepted_unchanged',
  'wording_or_formatting_edit',
  'substantive_rewrite',
  'structural_or_semantic_change',
  'added_by_reviewer',
  'removed_by_reviewer',
  'not_recorded'
];

function pct(part, whole) {
  return whole ? `${Math.round((part / whole) * 100)}%` : '-';
}

async function main() {
  const daysArg = process.argv.indexOf('--days');
  const days = daysArg >= 0 ? Math.max(1, Number(process.argv[daysArg + 1]) || 90) : 90;

  // One row per draft: the latest event carries the final state of the review, and
  // counting every snapshot would weight chatty sessions as popular opinions.
  const { rows } = await query(`
    SELECT DISTINCT ON (draft_id)
      draft_id,
      review_status,
      edit_summary->>'purposeSource' AS purpose_source,
      edit_summary->>'purposeEdit'   AS purpose_edit,
      updated_at
    FROM staged_meeting_minutes_review_events
    WHERE updated_at >= NOW() - ($1 || ' days')::interval
    ORDER BY draft_id, updated_at DESC
  `, [String(days)]);

  if (!rows.length) {
    console.log(`no review events in the last ${days} days`);
    return;
  }

  const bySource = new Map();
  for (const row of rows) {
    const source = row.purpose_source || 'not_recorded';
    const grade = row.purpose_edit || 'not_recorded';
    if (!bySource.has(source)) bySource.set(source, { total: 0, completed: 0, grades: {} });
    const bucket = bySource.get(source);
    bucket.total += 1;
    if (row.review_status === 'completed') bucket.completed += 1;
    bucket.grades[grade] = (bucket.grades[grade] || 0) + 1;
  }

  console.log(`drafts in the last ${days} days: ${rows.length}\n`);
  const sources = [...bySource.entries()].sort((left, right) => right[1].total - left[1].total);
  for (const [source, bucket] of sources) {
    const kept = (bucket.grades.accepted_unchanged || 0) + (bucket.grades.wording_or_formatting_edit || 0);
    console.log(`${source}  (${bucket.total} draft${bucket.total === 1 ? '' : 's'}, ${bucket.completed} completed)`);
    console.log(`  kept as given or tidied : ${kept}/${bucket.total} (${pct(kept, bucket.total)})`);
    for (const grade of GRADE_ORDER) {
      if (!bucket.grades[grade]) continue;
      console.log(`    ${grade.padEnd(30)} ${String(bucket.grades[grade]).padStart(3)}  ${pct(bucket.grades[grade], bucket.total)}`);
    }
    console.log('');
  }
  console.log('a low kept-rate for a composed source is the reviewers saying that composition does not work.');
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
