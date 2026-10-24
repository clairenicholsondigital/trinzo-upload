# Exact discussion provenance and bounded placement research

Generated discussion normalisation can combine identical accepted claims while retaining their sources but losing the predecessor IDs. The publication audit then reports an already visible claim as unmaterialised. Internal reconstruction and final assembly now bridge those identities only for **exact unchanged text, matching record kind, complete surviving source/warning metadata and a unique surviving destination**. The bridge adds history; it does not change wording, sources, primary source ownership, warnings or children. Approximate historical aliases are not independently certified by this bridge. Model parsing and reviewer-save permissions remain unchanged.

The final bridge runs before the bounded editor creates its restoration archive. Adding history after an archive's final hash would invalidate restoration. Generated source records with child trees are excluded as predecessors; existing generated children on the surviving parent remain untouched. Reviewer-owned topics/subtrees, ambiguous IDs, conflicting existing aliases, unfamiliar parent metadata and history overflow prevent a new bridge.

Own-parent coverage recognises validated `originalTopic` navigation metadata locally and retains the exact original tree in the existing restoration archive. It does not broaden the shared merge allowlist, remove a child warning, admit a new source, or treat subject overlap as proof of coverage. A unique detail must still survive inventory and independent verification.

## Placement research

The diagnostic CLI produces a private, immutable nomination packet:

```sh
node scripts/meeting_minutes_discussion_placement_research.js --input saved-draft.json --output new-report.json
```

It makes no provider requests and changes no library drafts. The output file must not already exist. It nominates at most twelve links using sentence/semicolon spans under the existing distinctive-subject thresholds. Full parent/detail text and bounded source context remain available for later assessment. Explicit unresolved targets, reviewer locks, duplicate identities and invalid evidence cannot acquire a fallback destination. Warned nominations remain marked protected. Every nomination has `automaticPlacementAllowed: false`; no production generation path consumes these packets.

Sentence matches are not coverage proofs: they can link different artefacts with similar readiness wording, or conflicting named roles. Additional context and fully covered repetitions need separate judgements. Do not lower global thresholds or enable automatic filing on the basis of nomination counts or model agreement alone.

## Discovery experiment boundary

The existing Microsoft anchored-discovery contract returns exactly one result per anchor. A paragraph spanning multiple subjects cannot be split into several records merely by changing the final topic arranger. Increasing the number of anchors is an input experiment; it must preserve the same source inventory and be evaluated for new repetitions, lost qualifications, task leakage and latency before release. Passing JSON/anchor accounting does not establish factual or editorial quality. No Microsoft prompt publication, anchor-budget change, blanket placement or broader semantic merging is part of this release.
