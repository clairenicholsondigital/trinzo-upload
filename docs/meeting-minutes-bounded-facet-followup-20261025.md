# Bounded pair and facet qualification follow-up

Status: isolated research branch only. No production integration, automatic consolidation or live draft modification is qualified.

## Implemented

- One explicitly bound pair and selected survivor per request, with immutable original/survivor hashes, global action inventory, unresolved context and an explicit unassessed-comparison backlog.
- Separate source support and survivor retention for instruction, ownership, timing and nonempty existing protected facets. Exact unchanged self-retention is established by the server, while source support still requires assessment.
- Exact source-field validation: speaker metadata is distinct from spoken text. Ownership witnesses come from the original action's existing cited full-name source units; an unrelated owner turn cannot substitute for one. The complete instruction still requires spoken evidence and owner context. Atomic quantity/content facts do not redundantly require their own additional owner assignment.
- Exact selected-survivor field validation. Existing production coverage diagnostics remain, alongside conservative research blockers for warnings, reviewer edits, occurrence identity, missing sources and rejection-history preservation. Nothing bypasses an operation/timing/recipient/quantity guard.
- A reference-only bridge for malformed survivor spans. The model selects IDs for immutable complete survivor fields. It cannot provide source/retention verdicts, reasons, copied text, unknown IDs or replacement wording. All original semantic/source decisions are hashed and checked unchanged. This is an experimental wire-format repair, not a proposed permanent extra production pass.

All helpers live in scripts/research and are not imported by a route or worker. Inputs/outputs containing real transcript material remain private. Synthetic fixtures and aggregate findings are committed.

## Experiments and validation

This follow-up used 40 fresh calls to the existing Microsoft endpoint: two stopped compatibility probes, 32 facet requests (six real-pair directions/order variants and 26 blinded synthetic cases), then six reference-only repairs. No Trooper, fresh generation, provider replay, semantic-veto retry, cache reset, Microsoft configuration publication or production deployment occurred. All transports returned HTTP 200. Four held-out synthetic cases added register-entry paraphrase, separate methods, conditional branches and rejected timing history to the previous 22-case corpus.

The compatibility stop saved 30 calls while an ambiguous source-evidence schema was corrected. The first two failed probes remain recorded. The revised contract distinguished exact speaker metadata from spoken text and exposed permitted witnesses from existing citations.

The revised-run validator initially also required a spoken-text quote for an owner-identity facet, rejecting correctly typed full-name speaker metadata. This was a validator defect: the complete instruction already independently requires spoken evidence and a cited owner witness. The rule was corrected with regression tests and captured replies were replayed offline. No model status, reason or source quotation changed. Original assessments and replies remain preserved separately. This removed a structural false rejection, not a source veto.

Six remaining responses used derived facet labels (conditions, quantities, versions, quantifiers) where the contract required actual selected-record fields. All six were repaired using immutable field IDs, with every supported/unsupported/unclear and retained/not_retained/unclear judgment and source span held unchanged. Four semantic vetoes stayed vetoes; two positive controls obtained valid references. The raw failures remain in the record.

Final assessment accounting for the 32 cases: 30 valid, two held unqualified. The two failures were incomplete source accounting in a reversed real-pair check and a wrong survivor hash in an ambiguous synthetic case. Neither was rebound, treated as a negative judgment, or discarded.

87 relevant local tests passed, covering new research contracts and existing source-verification, action-reconciliation and connected-evidence behavior. Hash verification confirms all 59 saved library rows and the environment unchanged. Production stayed at a1c3960901f111a84857b83ab9580b7ec0a43c68.

## Real pairs

| Pair/direction | Result | Remaining limit |
| --- | --- | --- |
| Allotment, keep fuller fee/effective-date instruction | Source and retention checks pass | Existing operation, destination, inline-time and occurrence-proof barriers remain; no automatic merge |
| Allotment, keep shorter explanation | Explicit veto for missing quantities, relationship, new-year qualification and units | Correctly withheld |
| Allotment, reverse inventory and keep fuller instruction | Returned only two of eight facets, omitting all six selected-survivor source checks | Unqualified; exact self-retention never excuses missing source support |
| Eakin, either forward survivor | Source and retention checks pass | Existing different-operation/different-timing barriers and independent occurrence proof remain |
| Eakin, reversed inventory keeping explicit IT dependency | Source and retention checks pass | Promising order check, not proof that weaker dependency wording is safe or timing resolved |

The production guards have not been relaxed. In particular, the checker still accepts both Eakin dependency phrasings; keep the more explicit qualification in any future proof rather than relying on that acceptance to weaken it.

## Synthetic results

- Five unprotected positive controls: four passed, one was vetoed.
- Nineteen genuinely unsafe semantic cases: eighteen explicitly vetoed; one remained unqualified because its survivor hash did not match. No valid unsafe case passed in this sample. This is a bounded test result, not proof of zero possible false positives.
- Two policy-protected identity cases (reviewer editing and rejected timing history): model identity checks passed but the server held them behind preservation blockers.
- The previous checker's three erroneous positive examples (different quantities, different owners and an additional separate conversation) are now either explicitly vetoed with valid references or blocked by ownership checks; the unchanged deterministic guards remain essential.

The persistent false veto is informative: the synthetic source assigns one notice containing an explanation, and explicitly says there is no separate explanation task. The model's stated reason for rejecting the shorter explanation row is that it was not independently assigned. It is conflating support for an obligation contained in a deliverable with support for an additional standalone action. That is a hypothesis grounded in its explicit response, not a proven global explanation for every missed consolidation. No prompt was retried to turn that veto into approval.

## Next bounded work

1. Use immutable field/source references directly in the research wire contract rather than ask the model to copy long hashes, field labels and quotes. Server-side materialization is already an established pattern in the existing semantic stage. Replace the fragile exchange; do not add a permanent repair layer on top.
2. Give source support for both originals and non-self retention separate explicit accounting structures. The reversed Allotment response omitted self source checks when told to omit self retention. Keep fail-closed counting; never infer source support from record identity.
3. Distinguish a source-supported requirement within a deliverable from an independent extra task. A narrowly typed content-requirement relation needs tests against separate conversations, preparation/approval, purchase/fitting, deadlines versus effective dates and independent methods. Do not authorize a merge merely because it is called a subtask.
4. Any source-backed exception for different leading verbs must preserve all actual operations and qualifications, prove direct coverage to one exact existing survivor and retain source/occurrence/history lineage. No threshold lowering or owner/source-overlap shortcut.
5. Repeat with held-out cases and order variants, then qualify admission/save/reload/export and a fresh five-generation run before production integration. Group-to-atomic Microsoft/app mapping remains separate.

No live duplicate pair is marked fixed by this research. The benefit so far is a more discriminating, auditable feasibility result and a narrower account of the remaining blockers.
