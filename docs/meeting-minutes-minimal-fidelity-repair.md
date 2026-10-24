# Minimal factual repair after a rejected broad rewrite

A fidelity correction can fix a real fact while unnecessarily rephrasing an
unrelated future-work clause. The existing literal commitment guard correctly
rejects that broad rewrite. Previously, the app then retained the factual error
and added a meaning warning. This repair preserves that guard rather than making
it accept paraphrases.

After fidelity review, at most two generated records rejected specifically for
`correction_assertion_strength_not_proved` can receive a small repair attempt.
Records with pre-existing warnings, omitted source anchors, reviewer wording or
more than 1,000 characters are excluded. Only one correction can be published.
Each candidate has one proposal and one independent check, bounded to 45 seconds
per call. The optional elapsed time does not reduce the existing downstream
placement/duplication checks' time budget; telemetry still records full elapsed
time. No candidate means no additional calls. Disable this optional path with
`MEETING_MINUTES_AGENT_MINIMAL_FIDELITY_REPAIR_V1=0`.

The replacement must change one contiguous span of at most eight words. Existing
future-work clauses remain exact; new work, names, modals, explicit numbers,
conditions and timing are prohibited. Existing qualifiers and spelled quantities
are protected. A grammatical singular/plural correction needs independent proof
that its implication is source-supported. The full paragraph must still pass the
unchanged fidelity, temporal and commitment checks.

A separate verifier must establish a genuine original factual error, a supported
correction, full retention of other claims, unchanged future work and timing,
unchanged explicit quantities, and source support for any implicit quantity change.
Its proof binds the complete original and corrected text and includes exact own-
source quotations. Neighbouring context cannot donate a citation. An invalid,
negative or unavailable check retains the original warning and wording.

Publication replaces only the identified target's wording and the fresh failed-
correction flag from this same pass. It preserves every unrelated record, flag
identity, withheld item and supporting tree. Re-running the whole checker can
re-index flags; those incidental changes are deliberately not published. Existing
warnings on the target are not resolved or reinterpreted by this feature.

Original rejected proposals, subsequent attempts, source witnesses, independent
verdicts and failures remain in private `qualityState.discussion.minimalFidelityRepair`.
Save normalization protects this receipt from glossary/prose walkers. The normal
stage persistence and reviewer/concurrency protections still apply. Existing
library drafts are not rewritten by deployment.

## Validation and boundaries

Private captured-stage comparisons covered all five transcripts. They accepted
one DITA receipt-direction correction and one Eakin preference-attribution
correction; Abbott, Allotment and Parking remained unchanged. These are source-
verified factual improvements, not evidence that task/discussion mixing is closed.
Unresolved timing, genuinely uncertain source meaning, absent accepted action
coverage and larger corrections remain protected.

The secondary-extraction retest uses the actual live runtime settings and runs
sequentially. Eakin, Allotment and Parking completed; Abbott and DITA still reached
the existing 240-second deadline. Earlier private tests omitted the live embedding-
worker settings, and a parallel control exceeded the shared provider concurrency
limit. Those harness failures and the remaining real timeouts are retained as
separate evidence. Profiling the unchanged Abbott run showed 69 provider requests before the
240-second cutoff. Independent short-repair batches consumed 35.6 seconds in
sequence; the main selector was still waiting on provider requests at cutoff.
The Agent's private prepared-stage caller now opts into up to three concurrent
short-repair batches. Exact prompts, candidate numbering, ordered results, all-or-
nothing failure behavior and the existing shared request semaphore are preserved.
Other callers retain their sequential default. Trooper prompts, extraction samples,
validation and production timeout settings are unchanged. This removes a measured
serial bottleneck; remaining deadline failures must still be reported honestly.

The discussion/action separator also fixes a bounded-repair crash: a malformed
first proposal without `results` could make the duplicate-veto comparison hash
`undefined`, preventing a valid second proposal from being checked. The fix only
runs that comparison when the original results array exists; semantic vetoes and
all admission checks remain unchanged.

## Independent selector batches

The remaining profile delay was inside each selector's sequence of independent
batches. The Agent now also opts into at most two concurrent batches within each
of its two independent checks. Both forward and reverse checks, their batch
membership, prompts, per-batch retries, local/global candidate mapping and strict
consensus remain unchanged. Ordered results are combined only after every batch
succeeds; an omitted/invalid result still rejects that check. At most four selector
requests overlap, under the existing request semaphore. Other callers retain the
sequential batch default. No sample, source check or deadline is removed.
