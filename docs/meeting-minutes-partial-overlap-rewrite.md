# Partial-overlap discussion rewrite nomination (gated)

Status: implemented in an isolated branch; the new flag is disabled by default. Not approved for production activation based on the current reliability evidence.

The existing bounded editor obtains pair nominations from a deletion-oriented consolidation pass. That pass requires matching original qualification signatures, so it prevents the editor from considering partially overlapping paragraphs even when a combined paragraph could retain all qualifications. The existing deletion pass and its guards remain unchanged.

The optional `MEETING_MINUTES_AGENT_DISCUSSION_PARTIAL_OVERLAP_REWRITE_V1=1` path requires the existing bounded-rewrite feature as well. It nominates at most one additional pair, after existing candidates, within the existing three-candidate overall cap. Only adjacent generated main paragraphs in the same unprotected topic qualify. They must share at least two source IDs and all original references must lie within eight consecutive source positions. Reviewer content, descendants, warnings, unknown metadata, duplicate identities, questions, conflicting polarity, phase, bounds or figures are excluded. Existing lexical and semantic thresholds remain unchanged.

For those nominations only, the editor receives the complete local source window, up to eight units before and after the original references. Existing limits remain 24 units, 48,000 serialized characters, 12,000 characters per source unit and 12 output citations. Uncertain or oversized context declines the nomination; no citations are truncated to make an edit fit.

The same claim-inventory, proposal and independent verification stages must approve every original claim, every original sentence and every output sentence. Additional deterministic checks prevent the new path from dropping original uncertainty markers or condition phrases, alongside the existing source-word, figure and name checks. Full originals, source proofs, identity history and topic-scoped restoration remain preserved. Source context does not authorize recovery of new facts or silent repair of an unsupported original.

Validation: 29 new generic regression cases and 122 relevant checks passed. Across five saved drafts, the disabled implementation produces identical nomination packets to the current live implementation. The enabled path nominates one previously excluded pair in one draft; the other four nominate none. Inputs were not mutated.

Three isolated real Microsoft trials all reached the editor. One accepted a complete source-verified rewrite; one declined at citation overflow; one declined because the independent checker found the original follow-up wording insufficiently supported. The final code exactly reproduces all three outcomes using the captured requests/replies. These are saved-input trials, not fresh generation workflows. Existing library drafts and Microsoft configuration were not modified.

Activation remains held. Further work must establish a complete, auditable citation allocation within the existing cap, and resolve the source-fidelity/antecedent problem behind the disputed follow-up assertion. Neither increasing the cap nor relaxing the independent verifier is justified by these results. The nomination mechanism is addressed; reliable visible removal of the overlapping paragraphs is not yet ticked off.
