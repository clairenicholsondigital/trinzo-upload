# Meeting minutes regression review — 19 October 2026

Scope: `/meeting-minutes-agent` and its saved drafts in the jobs/Library page. No transcript-specific replacements, client-specific writing rules, bulk draft edits or unrelated page changes.

## Proven failures and repairs

- Model ordinal IDs were treated as unique identities when applying proposals. A stale removal could delete a different action with the same ID; a real addition could be skipped for sharing an ID. Destructive changes now require matching editable content as well as ID, with conservative occurrence handling. Evidence-only changes do not invalidate the target.
- Aggregation rewrote shared discovery objects and their nested data. Later completeness checks consequently lost the original action and could attribute different wording to its owner. Discovery records, citations and aggregation inputs are copied before later edits.
- Delivery parsing captured only the first named recipient. Full named recipient groups are parsed before bundling, and distinct documents cannot disappear through incidental name overlap. Recipient-first wording is parsed before capitalised document names.
- Delivery bundling could concatenate qualified versions of the same document and append a second paraphrase of a dependency. Overlapping objects are left to conservative deduplication; a differently worded dependency already present in the instruction stays on its own action. Distinct deliveries with representable timing still bundle.
- A failed attempt to detach an incidental copying remark discarded an entire substantive instruction. Such instructions now survive. Standalone copying apologies and safely detachable courtesy tails still disappear; reviewer-authored text remains protected.
- A named assignment split by another speaker's short acknowledgement lost its owner. An unfinished assignment can now bridge acknowledgement-only turns back to the same speaker, within a bounded window. Substantive interruptions do not qualify.
- The editor sent `acceptAll` for every pending proposal, overriding explicit uncertain selections. Automatic adoption now applies only positively selected changes. Uncertain suggestions become persistent, source-linked review checks after the proposal is consumed, rather than being applied, hidden or repeatedly processed on reload. Automatic action removal additionally requires proof that complete wording, ownership and timing survive in another retained action. Manual selection remains available through the API contract. Undo/redo and the existing review queue remain covered.
- Work of different kinds, such as confirming an input and reviewing a standard against that input, no longer merges through incidental shared words. Existing question, document hand-off and explicit way-to paraphrase workflows retain their established exceptions.

The tests added for these rules use generic examples unrelated to the Library transcript wording. No existing tests were removed or skipped. Initial failures in existing tests led to implementation corrections, preserving the old document-sharing, courtesy and ownership contracts.

## Verification

- 866 scoped regression checks passed across 60 files, with no failures or skips. Historical referee capture checks used the production artifact root so their fixtures were actually exercised.
- Agent and Library Chromium suites: 65 checks, including save/reload, uncertain suggestions, warning visibility, and undo/redo. Final result is recorded in the accompanying verification artifacts.
- Generic regression coverage includes stale and duplicated IDs, immutable discovery, multiple recipients, different recipient groups, different work, mixed courtesy/substantive instructions, split assignments, dependency handling, uncertain automatic changes, and duplicate removals that would otherwise cite each other as survivors.
- Real route/persistence tests cover automatic proposal adoption, retention of uncertain work, source checks, unchanged dependent stages for no-content changes, undo and redo.
- All five current Library sources were replayed against saved model responses before and after the changes, with database access forbidden. The final replays required no new external requests. DITA's invoice/email recipients are intact; the Allotment council letter and reimbursement survive while the speculative security addition remains a review check; Eakin's distinct specification confirmation, cybersecurity circulation and language-action owner survive; parking still produces zero actions.
- One controlled fresh Actions generation used the unchanged Abbott source, with production database access forbidden and no draft writes. Its 16 external requests completed without degraded sources. It ran during final refinements; its resulting proposal was also passed through the final adoption helper. This is a runtime check, not a controlled claim of overall model-quality improvement.
- JavaScript syntax and whitespace checks passed. Deployment and read-only Library integrity evidence are retained alongside the test reports.

Artifacts: `/root/trinzo-general-regressions-results-20261019`. The saved Library source snapshots remain in `/root/trinzo-library-comparison-20261019`.

## Remaining limits

Existing Library content is not rewritten by this release. Regeneration is needed to produce new content with the repaired generation rules; pending changes encountered on opening a draft use the safer adoption rules.

Paraphrased overlap is retained when equivalence cannot be proved without risking a real commitment or condition. The Allotment purchase/installation pair remains an example. The fresh Abbott output still has overlapping transport/preparation items: model agreement is not a guarantee of editorial quality. These are explicit quality limits, not hidden failures or transcript-specific exceptions. Broader workload asides and ambiguous personal remarks also remain matters for review rather than keyword deletion.

The Allotment summary was not generated in the inspected saved workflow. This review found no evidence that its absence was a summary-generation regression, and did not invent or write a summary.
