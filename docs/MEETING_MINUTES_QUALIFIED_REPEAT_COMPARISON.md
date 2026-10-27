# Qualified action-repeat comparison

Assessment and implementation: 27 October 2026. Baseline: `42b3f9d5854ccbac4e2770c509de42fda6fb3ae3` (PR #187).

## Bounded execution and acceptance criteria

1. Freeze Abbott's risk-sharing pair and Allotment's photograph pair, including complete original action records, sources, timing decisions and warning records. Record file hashes before testing.
2. Reproduce nomination against the deployed baseline. Establish whether exclusion, budget, provider failure or a semantic veto explains the absence of a final comparison.
3. Add a generic, bounded nomination route through the existing independent source/retention review contract. Similar words and shared sources nominate a comparison; they never establish equivalence.
4. Require two independently bound positive reviews, supported commitments for both originals, the same obligation and complete retention in one unchanged existing record. Keep writing correspondence separate from supplying its photograph.
5. Preserve citations, every warning ID, active rejected-date/wording guards, unresolved timing and recoverable original records. Check final preservation, identity admission, JSON reload and public presentation.
6. Test failures and regressions. Do not retry a semantic veto, clear timing warnings or change production drafts to obtain a successful result.

The nomination gap is closed when both frozen pairs reach the existing source review. A visible pair is safely consolidated only after both reviews and final preservation pass. Closing that gap does **not** mean all action duplication is fixed or that either action's timing has been verified.

## Verified cause

Both pairs received zero final candidates on the deployed baseline. The bounded-survivor route deliberately excludes structured timing and review flags. The contained-content route excludes those records too. The qualified-dependency route supports a much narrower instruction/dependency structure and does not cover these pairs.

Abbott's mechanical comparison reports `different_timing` and `different_condition_or_dependency`. Allotment's reports `different_timing`. This is exclusion before final assessment, not a failed final provider request.

## Implemented correction

`utils/canonicalMinutes/qualifiedRepeatShape.js` nominates only records with one matching owner, shared source evidence, matching opening words and substantial wording overlap, the same timing kind, no exact date and an unresolved/rejected timing assessment. It elects a uniquely fuller existing record. Unknown row metadata, reviewer-authored/kept records, conflicting timing bindings and capacity violations remain excluded.

The route uses the existing contained-requirement flag, source/retention contract, independent challenge, proof receipts and recovery mechanisms. It uses spare candidate capacity after all established nomination classes; the existing comparison budgets are unchanged.

Only a validated certificate for this nomination kind may resolve the mechanical timing/condition difference. Other conflict guards remain active. Timing retention must reference the survivor's actual timing wording. No new wording, owner or date is generated. Warning IDs and active rejection guards are combined; the elected unresolved timing assessment is retained and original assessments remain in recovery history.

## Actual results

Three new Microsoft calls were made against the frozen full registers: two for Abbott and one for Allotment. No whole-transcript regeneration or Trooper call was needed. Subsequent save/publication checks replayed only replies matching the complete exact saved requests; they are not additional independent service trials.

| Case | Before nomination | After nomination | Actual source-review outcome | Main action count |
| --- | --- | --- | --- | --- |
| Abbott risk-sharing | 0 | 1 | Primary and challenge passed; final preservation passed | 17 → 16 |
| Allotment photograph | 0 | 1 | Primary vetoed: one source basis was `required_component`, despite a `same_obligation` relationship and positive retention | 10 → 10 |

Abbott retained the fuller confidentiality/conduct and before-arrival conditions, all source references and all eight original warning records. Original actions are recoverable after identity admission and reload.

Allotment retained both original records, all five warning records and the rejected-date history. Its council-letter action was unchanged. A contradictory component/commitment classification is a remaining obstacle to automatic consolidation; no challenge or retry was requested after the veto. The photograph pair must not be reported as fixed visually.

Across all five saved registers, the new route nominated exactly these two pairs. DITA, Eakin and Parking gained no candidates. Existing nominations were not displaced.

## Regression evidence and limits

313 relevant tests passed, covering semantic reconciliation, contained requirements, qualified dependencies, contact comparisons, policy, proof contracts and document-reference protection. Seven new tests cover nomination, no deterministic deletion, independent vetoes, conditions/warnings/rejections, request binding, timing-wording references, correspondence separation, identity recovery, background persistence/public projection and established-candidate priority.

Synthetic positive responses exercise the contract; they are not presented as real-service approval. The actual three-call result is reported separately above.

Private, source-containing evidence is deliberately outside the repository at `/root/trinzo-qualified-repeats-evidence-20261027/`. `manifest.json` records SHA-256 hashes of read-only frozen cases. Supporting artefacts include `baseline-diagnostic.json`, `five-register-nomination.json`, the exact private requests/replies, `verification.json` and `regression.log`. Persistent database access was disabled in the real-service comparison; publication was exercised with in-memory storage. No library draft or production configuration was changed.

This bounded implementation has not been merged or deployed. A future fresh generation may vary; this result establishes the behaviour on the frozen examples, not a guarantee of duplicate-free new output.
