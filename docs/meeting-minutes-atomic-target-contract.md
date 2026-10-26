# Atomic mapping validation and group qualification

## Bounded fixes

Before accepting a positive action disposition, the application now requires one unambiguous candidate with `recordType: action` and nonempty action wording. Previously an absent/empty type could pass the contract even though reconstruction silently wrote no action. It can no longer count as complete fast-path accounting; the record remains unresolved for repair/review.

A supplied target ID must likewise identify one writable atomic action. Previously mere ID existence admitted a group, discussion item or empty action as a target alias. Duplicate candidate or target IDs also used last-write-wins lookup. They now produce explicit unresolved materialization reasons. Group-level owner/timing hints still cannot approve children or donate fields. Valid atomic aliases, including known targets in another batch, retain their existing behavior.

Seven new regressions reproduce the old failures before the correction. Existing lifecycle-label, subset-repair and batch-order assertions are retained; four positive fixtures now provide actual writable actions instead of ID-only placeholders. The new missing-type tests separately require those placeholders to fail. The real pipeline tests continue to preserve current actions and unresolved review.

Read-only replay of all 13 recorded action-referee responses from the saved five outputs produces identical validation and reconstruction results before/after, including all 30 unresolved group materializations. These fixes close contract defects; they do not claim fewer duplicate actions in those saved outputs.

## Group mapping research

No automatic group closure was enabled. Research used the existing Microsoft endpoint with database functions blocked, bounded complete source packets, existing drafted actions only, explicit full-source ownership witnesses, per-member work/owner/recipient/condition/scope/quantity/timing checks and strict target/source accounting. Positive results require an independent challenge without the earlier answer. This trial deliberately excludes targets with review flags or unresolved/rejected timing, and does not allow context-only or non-action disposal.

The corrected-envelope assessment accounts for all 30 groups:

- Seventeen have no eligible mapping target under those conservative rules. Eight have no current action sharing the selected source references. Nine have related actions excluded by review flags; six of those also have unresolved/rejected timing. These are selection limits, not proof that work is missing.
- Five return valid unresolved verdicts.
- Seven return invalid target bindings. One claims `fully_covered` while naming excluded targets and is rejected before independent challenge.
- The initial corrected-envelope probe also returned unresolved with invalid targets. Its negative result was retained rather than retried to obtain acceptance.

No real group qualified for closure, so no real positive reached independent challenge. Three synthetic controls establish that the contract can distinguish a simple supported case: same work passes both primary and independent challenge; an additional separate operation and a changed recipient/approval condition both return valid unresolved verdicts.

Research harness issues are accounted separately: the first version used an unsupported root response envelope and produced 13 parser failures; these are not semantic evidence. A positive control also exposed an explanation-field requirement that had not been stated clearly enough. The prompt was corrected, the original failure retained, and the synthetic controls passed. None of these harness corrections waived production validation or converted a real semantic veto into acceptance.

## Next implementation boundary

The main group-mapping problem is still open. The next bounded qualification should separate usable mapping targets from reference-only context so excluded IDs cannot leak into proposed mappings. Preserve strict backend binding checks rather than relabeling invalid IDs. Broaden source retrieval only as a nomination aid for the eight no-overlap cases; shared sources or similarity must never become coverage proof. Research whether work coverage can be proved separately from an existing timing warning while preserving that warning and all temporal occurrence/condition checks. Do not silently admit flagged targets or resolve dates to make mappings pass.

Only after a real group passes complete source/retention accounting, independent challenge, separate-work negatives and stale-proof/save/reload recovery checks should it be considered for automatic closure. Keep the sparse-output safeguard and existing review questions until then. No transcript-specific production rules, new runtime flags, cache reset or library mutation are introduced by this release.
