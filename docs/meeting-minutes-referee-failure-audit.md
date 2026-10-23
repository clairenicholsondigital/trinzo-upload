# Discussion referee context and failure evidence

This batch implements task 5B and the bounded catalogue-transport part of 5C. It does not change action comparison, publication/deletion rules, model/provider selection or the Microsoft configuration.

## Approved targets

Initial and repair discussion referee prompts include an existing `retainedDiscussionTargets` catalogue when the caller has one. Both include source windows for these approved targets as well as the candidates to classify. Reference targets remain outside expected candidate IDs/counts; they are not reclassified. Empty catalogues leave initial prompt payloads unchanged.

Unresolved candidates elsewhere in concurrently executing batches are not promoted into approved targets. Unknown targets still fail existing validation and receive the existing subset-repair/retention path. This is not the cross-batch linking phase in task 5D, and does not establish why an unavailable historical reply contained a bad target.

## Private failure audit

Only discussion referee calls enable the new failure observer. It snapshots the parsed Microsoft reply before result hooks/adapters can mutate it, then snapshots the adapted/combined reply before validation. Each failed attempt retains its exact attempt prompt (including a repair prompt when applicable), target contract, validation code/invalid candidate IDs and run/attempt identity. No additional provider requests are made. The capture is parsed reply evidence, not a copy of the underlying HTTP wire response.

Records live in the draft's private `qualityState.discussion.refereeFailureAudit`, alongside its other internal evidence. They are excluded from public draft and generation responses and ordinary logs. The audit bypasses terminology rewriting. Background runs checkpoint a failed attempt before retry/continuation, so a later stage failure does not erase the evidence; a successful stage also retains the journal. Speculative/harness runs without a checkpoint callback retain diagnostics in their returned stage result rather than introducing new draft writes.

Snapshots are immutable copies, individually limited to 128 KiB. Oversized/unserializable components are explicitly marked incomplete; serializable oversized data keeps a byte count and SHA-256 fingerprint. A journal keeps at most eight entries and 2 MiB, with at most 512 KiB per entry. Oldest entries are dropped as necessary and counted. Entries older than seven days are removed on the next append; this is not a scheduled purge of idle drafts. Audit checkpoint/storage errors cannot replace the original validation error or add provider retries. The metadata-only audit-unavailable log contains no prompt/reply/storage exception text.

## Validation and remaining scope

Generic tests execute the actual retry, production-call and private checkpoint functions with isolated provider/database fixtures. They cover adapter mutation, exact repair prompts, original-error preservation, no capture for successful replies, no-response failures, budgets/age/count, approved versus unknown targets, source context and expected counts. Actual owned GET/PATCH coverage proves private evidence survives save unchanged, cannot be forged by the client, and is not returned publicly.

No cache reset, existing draft rewrite or fresh transcript generation is part of this release. Task 5D and Microsoft-specific attribution in 5E remain open. Full source/citation alignment and registration-action parsing/synthesis from tasks 3 and 4 remain unchanged.
