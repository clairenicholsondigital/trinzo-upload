# Final-exchange source status

## Proven failure and bounded correction

The existing independent action source check conflated two questions: whether a transcript describes an instruction, and whether that instruction remains outstanding at the end of the supplied exchange. In isolated live Microsoft controls, the baseline approved both a request answered with an explicit completion and a request followed by an ambiguous answer to two different requests. These were valid response envelopes, not provider or parsing failures.

Adding lifecycle guidance alone resolved the ambiguous-answer control but still approved the completed-work control. That intermediate proposal was not released. New requests therefore explicitly use `sourceStatusMethod: final-exchange-v1`. Every original clause must independently return `sourceStatus: outstanding | not_outstanding | uncertain`. A positive decision requires outstanding status on every clause, in addition to all existing source-support, retained-meaning, owner-witness, source-ID, clause-accounting and packet checks. A positive decision contradicting its status is rejected. Unresolved responses remain unresolved.

The generation stage explicitly requires the method for new requests; omission cannot fall back to the legacy response contract. The same requirement applies when binding the response into coverage evidence. The changed prompt also changes the review cache fingerprint. No semantic veto is retried into acceptance, no new candidate family is enabled, and no automatic group closure is introduced.

Instructions bind request and acceptance by operation, object, assignee and recipient, with both turns cited. They distinguish an accepted condition from unconditional agreement; an answer to another task, an ambiguous answer, withdrawal, completed work and replacement cannot establish the original outstanding task. Missing context stays unresolved. This additional status check concerns merge authorization; it does not independently delete completed actions or rewrite a draft.

New source-operation certificates retain v2 compatibility and hash the status method and outstanding status into their provenance. Certificate validation rejects unknown methods and non-outstanding statuses. Legacy responses and certificates keep their existing interpretation; archived reviews are not reclassified and existing library drafts are not migrated.

## Qualification and limits

A 13-case live Microsoft matrix compared the baseline and the intermediate wording-only proposal. The baseline passed 11/13; the intermediate proposal passed 12/13. The final explicit-status protocol passed all 13 new controls: direct and accepted promises, reversed actor/recipient roles, refusal, withdrawal, completed work, replacement recipient, lost/preserved acceptance conditions, ambiguous answers, another accepted request, distinct review/send work and a hedged possibility. Positive acceptance controls require both the request and answer citations on every original. These controls demonstrate the bounded protocol behavior; they do not prove perfect semantic judgement on arbitrary transcripts.

Local tests exercise actual merge application, receipt revalidation, repeated clauses, a false positive with non-outstanding/uncertain status on either original, missing/unknown fields, preserved unresolved vetoes, legacy compatibility and generation-stage rejection of a legacy-shaped new response. Existing checks remain mandatory.

Four previously recorded original-action assessments retain their prior validation outcomes on replay. Four saved action pairs are also checked using the final protocol. None is authorized for merging by this work: independent source agreement does not override a failed direction, operation, owner or retention safeguard. This work demonstrates no saved-output duplicate-count reduction.

## Wider inventory experiment remains held

A separate source-only inventory experiment made final request/acceptance status explicit. Both previously blocked accepted-request controls passed, but the expanded 17-case matrix passed only 8/17. Nine responses were blocked by existing inventory/retention contracts. Observed causes include standalone neighbouring evidence emitted as another member's context item, overlapping work/context classifications and context dispositions carrying target spans. These are not evidence that the protected material can be discarded. No validators were weakened to make those results pass.

The four source-inventory/retention pair trials still qualify zero pairs for automatic removal. That broader experiment remains outside the production pipeline. The next useful batch is a narrower per-obligation lifecycle binding, with explanations/context carried as evidence on that obligation rather than emitted as additional disposable items. It must first pass refusal, correction, supporting-work, qualifier and neighbour-binding controls. Separately, saved-pair direction/operation and owner-citation blockers must be addressed with their own evidence; this release does not bypass them.

## Evidence

Private local artifacts: `/root/trinzo-exchange-final-status-results-20261026` and `/root/trinzo-lifecycle-resolution-20261026`. They contain exact requests/replies, failure records, test reports and read-only saved-pair results. The prior baseline outputs remain intact. These were isolated controls and saved-output checks, not a cache reset or a fresh five-transcript generation.
