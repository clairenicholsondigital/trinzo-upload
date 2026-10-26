# Referee wire evidence and member-coverage qualification

## Bounded application corrections

Malformed Microsoft responses were rejected inside the transport parser before the retry layer's optional failure audit could see them. An HTTP response body therefore appeared as `no_reply` in later investigation. The transport now supplies an optional private callback before HTTP/empty-body/structure validation. The retry layer snapshots that exact body as `wireReply`, separately from the decoded pre-adapter `rawReply` and adapted `normalizedReply`. Actual network failures still explicitly have no wire reply.

The existing bounded private failure journal now covers action-referee calls as well as discussion-referee calls. Action completion retains its journal, in addition to the existing durable progress checkpoint. All stages' audit objects remain exempt from glossary rewriting and excluded from public draft payloads.

The callback is installed only when a failure observer exists. Successful replies create no failure entry. Callback/storage errors cannot replace the provider error or request another attempt. No parser acceptance rule, retry limit, endpoint, action wording, owner/date rule, nomination rule or review decision changes. Per-component/entry/journal limits and existing seven-day-on-append retention remain in force; oversized evidence is fingerprinted and explicitly omitted, never silently truncated. Wire snapshots participate in aggregate entry budgeting. Request URLs and headers are not added to the journal.

New regressions reproduce the missing wire evidence before the correction. They cover malformed JSON envelopes, non-JSON bodies, HTTP failures, empty bodies, oversized evidence, optional capture, capture failures, stage-specific durable checkpoints and public exclusion. Existing production-call assertions now exercise both referee stages using each stage's actual rejection code. The full action pipeline's existing three fault scenarios additionally require exact wire evidence to survive stage completion and save/reload while actions and unresolved coverage notices remain intact.

Read-only replay of all 13 recorded referee responses across the saved five outputs retains identical validation, reconstruction and all 30 unresolved group materializations. This is a diagnostic repair, not a demonstrated reduction in duplicate actions or reviewer questions.

## Member-by-member research

An isolated, database-blocked trial assesses 30 saved groups using the existing Microsoft endpoint. It distinguishes represented work, fully retained continuations, source-supported context-only material and unresolved material. Continuations must point directly to represented work, preserve the same target set, cite their own and their antecedent's focus sources, and preserve all qualifications. Missing target/owner information is never proof of context-only status. Existing timing warnings remain untouched. Each structurally valid positive is challenged afresh without the prior answer.

Thirty primary and four challenge calls produce:

| Primary outcome | Groups |
| --- | ---: |
| Valid assessment | 5 |
| Missing source-owner/target witness | 4 |
| Invalid provider structure | 8 |
| Claimed represented work without a complete target mapping | 10 |
| Invalid continuation binding | 3 |

Four groups have complete contract-valid agreement across the two assessments. That agreement is **not semantic qualification for deployment**. Direct source/target inspection exposes unsafe positives:

- A promised supporting deliverable is classified as context only by both passes. Its relationship to a larger task does not make it disposable.
- Both assessments claim that a specifically requested communication detail is retained even though the drafted target's wording and timing do not contain it. Source citations are not target retention.

These findings confirm correlated model agreement can miss the same omission. None of these candidate assessments changes production notices or library drafts.

Synthetic controls are reported honestly. Acknowledgement and polite-commitment cases pass primary/challenge. Additional separate work and separate temporal occurrences return valid unresolved results. A retained continuation omits its parent citation and is rejected. Lost-continuation, corrected-obligation, new work in scheduling and dependency-with-its-own-work cases fail the contract because the model labels unmapped work as represented; these are **not** counted as successful semantic negatives. The initial acknowledgement trial returned an empty checks object; its formatting failure was preserved, mandatory fields made explicit, and the corrected protocol assessed separately. No semantic veto was retried into acceptance.

Twenty-two local research contract checks cover stale source/action/owner/timing/member data, changed packets, invalid references, missing members, incomplete conditions, invalid/cyclic continuation parents, unsupported context and independently orphaned continuations. These are research-harness checks, not production closure receipts.

## Next bounded implementation boundary

Do not enable automatic context disposal or group closure from boolean assertions or agreement alone. Next qualify exact **target-side retention witnesses** for each meaningful source condition/deliverable, and explicit source-side justification for a non-action decision. Witnesses must quote actual supplied source/target spans; deterministic validation rejects invented or source-only target evidence. Paraphrases must still be assessed semantically; literal source verbs are not reinstated as an acceptance rule.

Add controls for a supporting deliverable disguised as a continuation, an omitted communication qualification, a polite acceptance of a preceding request, and an ambiguous self-correction. A failed or missing witness must preserve review. Any future runtime closure also needs durable complete-input receipts, stale-edit rejection, actual save/reload and undo/recovery checks, and five-output preservation replay. The current classifier is not ready for automatic removal. This release fixes the diagnostic gaps needed to investigate failures reliably.
