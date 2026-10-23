# Repeated contact enquiries

`MEETING_MINUTES_AGENT_CONTACT_ENQUIRY_DEDUPE_V1=1` opts new meeting-minutes
runs into the existing source-verified action reconciliation infrastructure,
restricted to contact enquiries. It does not enable broad action merging or
discussion reconciliation. The policy and scope are captured in the run and
generation-cache fingerprint; legacy in-flight work stays unchanged.

The parser distinguishes the enquiry purpose from a speaking wrapper and from
temporal prepositions. Only recognised, generated, unflagged, untimed enquiries
with the same named contact, sole owner, shared evidence and overlapping purpose
are nominated. Unknown metadata, reviewer content, kept occurrences, extra
operations, dates, conditions and alternatives remain outside this opt-in.
At most two candidate pairs are assessed per run.

Nomination never authorises deletion. Existing original-to-survivor mappings,
independent source verification, clause coverage, numeric/scope guards, metadata
capacity checks and content-bound receipts must pass. Only existing wording may
survive. Failure retains the incoming register. The final survival invariant
remains enabled. Full originals and receipts stay private.

An unchanged save preserves the sealed register instead of reranking its sources.
Actual action/date edits take the existing review path. “Restore separate actions”
is available only while the complete register and source-bound receipts still
match, with no checked actions. The owner-scoped endpoint requires the current
revision and refuses restoration during generation or after edits. Restoration
enters normal undo history and marks dependent content stale.

This does not consolidate registration coordination, document acquisition,
country-list preparation, implementation, or repeated discussion paragraphs
merely because they mention the same person. Those need independent evidence.
