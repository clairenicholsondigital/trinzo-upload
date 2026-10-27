# Document review reconstruction fix — 27 October 2026

**Ready to begin step 6: PR, full checks, merge and deployment.** Those release
steps have not been performed. This closes the confirmed reconstruction bypass;
it does not declare all action duplication or document-scope uncertainty fixed.

Implementation commits: `8560409c`, `def8ee15`.
Private evidence: `/root/trinzo-document-referee-fix-20261027`.

## Correction

In `routes/api.js`, `reconstructRefereeActions` now keeps a document assessment
marked for human review as a proposal even when the referee says `publish`.
It preserves the original review flags and proposed owner, and cannot fill an
empty owner from the referee or an owner-bearing twin.

The referee contract deliberately compacts away full records and review flags.
The restriction is therefore recovered by exact candidate ID from the server's
original candidate ledger, passed through the existing owner-pool argument.
It is not inferred from similar wording and does not alter provider prompts.
Ordinary actions retain their existing reconstruction and owner-recovery rules.

Final flag assembly also retains document-review questions from original ledger
records. Filtering or revalidating a proposal cannot erase its source-linked
question. This keeps the work available for human judgement without publishing
an unsupported assessment. Existing explicit human acceptance remains available.

## Failures proved before correction

- The first generic regression run failed five review-protection cases; the
  ordinary-action control passed. Reconstruction cleared the warning and could
  add an owner.
- After the direct reconstruction correction, the stronger full-pipeline cases
  still failed. Investigation showed that compact referee candidates no longer
  contained the flags. A separate contract-compaction reproduction failed before
  the exact-ID ledger lookup and passes afterwards.
- The pipeline also showed that proposal revalidation could withhold the row and
  lose its question. Final flag assembly now retains the original ledger warning.
  No assertion was removed or weakened to obtain the final passing result.

## Verification

- **198 regression/browser checks passed**, including seven new generic
  reconstruction tests, ordinary owner recovery, timing, source identity,
  materialisation, review persistence and the complete 72-test browser file.
- **Four strengthened offline full-pipeline cases passed.** For the two
  document-prefix cases the fixture referee deliberately publishes the
  assessment. The application still withholds it from main actions and preserves
  the review question through background persistence and public projection,
  including when either discovery route is unavailable.
- The exact real candidate that exposed the bug was replayed through the actual
  compact referee contract: zero published actions, one warned proposal, original
  owner state preserved, no automatic promotion.
- 22 repeated real Microsoft discovery comparisons completed without request
  errors. All ten protected output checks passed. The subsequent ledger lookup
  and final question-retention changes leave those discovery prompts unchanged;
  captured results were inspected with the final normalisation code.
- The immutable 44-response replay passes: no lost-work cases; all 20 protected
  distinctions pass. Its historical warning-only response remains a question,
  not a fabricated assessment row.
- All five saved registers, totalling 52 actions, normalise identically to live.

## Fresh Eakin qualification

A fresh isolated production-settings workflow completed Discussion, Actions and
Summary using 27 Microsoft calls, with no saved-response replay or library write.
Final output has 13 actions, five discussion rows in five topics, and five filing
rows. The standards section has three rows: sending documents, assessing the
specific standard, and following up with Colm. The broader duplicate assessment
and second delivery/Colm wordings observed in the failed qualification are absent
in this sample. The assessment retains an open owner-confirmation warning.

Admission, JSON persistence, public projection, Word/PDF export and automatic
proposal handling pass. The two pending additions are not automatically accepted;
the 13 final actions are unchanged by automatic review.

This fresh discovery produced the specific assessment directly as an action,
not the flagged proposal that exposed the bypass. It does not independently
exercise that rare branch. The captured-case replay and generic full-pipeline
cases provide that proof. Nor does one improved sample prove stable duplicate
elimination: discussion and action wording vary across independent generations.
The preceding failed sample had 20 discussion rows and 15 actions; this is not a
controlled claim of a platform-wide quality improvement or coverage equivalence.

## Remaining limits and release boundary

The optional secondary Action extractor again timed out after 240 seconds and
contributed no secondary Action candidates. Discussion secondary extraction
completed. The grouped-referee response contract again failed for five candidates,
with the existing evidence-grounded fallback used. These are recorded, separate
limitations, not repaired or hidden by this correction.

All **64 live draft rows** and the live environment are unchanged. Production
remains at `339f56849c62d93f01be252fd9d66b9b7c5cd969`. No PR, merge, deployment,
cache deletion, task-database update or existing-library edit occurred.

The next authorised stage should review this bounded branch and run the full
release gate. Deployment is conditional on that gate passing. Remaining semantic
duplication and optional-service failures must not be labelled resolved by this
review-boundary fix.
