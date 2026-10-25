# Global register: isolated qualification findings

Status: research only. No production integration or automatic merge is qualified.

## Method

24 fresh requests used the app's existing Microsoft endpoint: four isolated real-pair classifications (each pair in both input orders), four independent source challenges (both existing survivor directions), four complete-inventory classifications (both orders), five blinded synthetic classification batches and five independent source-challenge batches, followed by two diagnostic single-comparison requests with the entire global inventory still visible. No semantic veto was retried into approval. No Trooper calls, generation workflows, cache reset, library writes or deployment occurred.

The Eakin and Allotment inventories came from saved outputs; the two target pairs used PR130's qualified source-corrected raw-discovery records. Original wording/counts were unchanged. Source challenges used the existing production verifier, full original records/clauses, explicit full-record timing/history instructions and no classifier explanations. Generic fixture IDs and expected verdicts were hidden from the model. Prompts, source passages and raw responses remain private; only synthetic fixtures and these aggregate findings are in this branch.

## Real pairs

- Both pairs were nominated as equivalent/covered in both small-request orders. This proves reachability, not safe survivor selection.
- Allotment: reversing the pair produced a wrong directional claim that the shorter instruction encompassed the fuller fee/effective-date instruction. Its independent checker blocked both survivors, including marking a source-supported original as not retained when the exact same record survived. The short-row veto protects real detail; the fuller-row self-retention veto is a false-negative symptom that needs diagnostic improvement. Neither veto is overridden.
- Eakin: both source challenges returned valid positive judgments. This is promising but not sufficient for integration: the existing different-operation guard remains, the dependency wording differs, timing remains unresolved, and the same checker made demonstrably wrong positive judgments on synthetic cases. Prefer preserving the fuller explicit dependency in any later qualified survivor rather than silently weakening it.
- Allotment full inventories: both 66-comparison responses had complete ID accounting, but included reasoning attached to unrelated pairs, unsafe purchase/fitting coverage claims and reversed directions. Correct IDs/counts alone do not prove the content was assessed against the correct pair.
- Eakin full inventories: only 1/120 and 15/120 decisions were returned. Both fail complete accounting and are held in full; missing pairs are not treated as distinct or covered. Responses were successful HTTP/valid JSON, not transport failures.
- Diagnostic only: requesting one nominated comparison while retaining the full inventory returned complete results for both meetings. This changes the request shape, not the original failed result. One observation per meeting does not establish stability or override any verifier veto.

## Synthetic challenges

22 cases: four positive controls, 17 semantic negative cases and one reviewer-protected equivalent pair.

- Classifier nominated all four positive controls.
- Classifier also unsafely nominated four semantic negatives: lost dependency, lost condition, lost uncertainty and a withdrawn quantity correction. It treated broader/unconditional instructions as covering qualified work. Superseding invalid wording is not duplicate equivalence.
- The reviewer-protected equivalent pair was nominated as semantically equal. That can be true while editing it remains forbidden; policy protection is separate from semantic identity.
- Independent verifier accepted three of four positive controls and falsely rejected the content-within-deliverable control. It does not provide complete recall even in these explicit controls.
- One five-case source batch failed the existing contradictory_source_verdict check: several top-level equivalent claims contained retained:false checks. All five remain unqualified; do not salvage them as approvals.
- In otherwise valid source batches the checker falsely approved three semantic negatives: different quantities, different owners and a separate conversation in addition to drafting. Existing deterministic coverage guards reject all three.
- No unsafe synthetic case cleared both model gates in this sample; one relevant case was held because its source batch was invalid. This is not proof of zero false merges or production safety. The harness cannot edit actions at all.

All 24 transports returned HTTP 200. 21 responses met their research contract; three did not (two incomplete Eakin inventories and one contradictory source batch). Six local harness/adapter tests passed. All 59 library rows and environment hashes were verified unchanged after the run.

## Recommended bounded next work

1. Keep a global register, but use small nomination/challenge requests with explicit pair binding, full original records and unresolved comparison backlog. Do not ask one response to enumerate all possible relations. The one-comparison diagnostic supports this direction without qualifying it.
2. Split verification diagnostics into source support versus exact-survivor retention. Record which facet is missing and the exact existing/source text. Self-retention and response contradictions should be identifiable without converting a source veto into approval.
3. Retain owner, recipient, quantity, timing/history, condition, occurrence, operation and reviewer guards. Neither a classifier nor a second LLM is safe enough to replace them. Any extension beyond matching verbs needs a narrowly typed, source-backed operation/deliverable proof, not a lower overlap threshold.
4. Test directional containment, condition/uncertainty loss and pair-binding under order changes, including the failures captured here. Keep effective dates separate from deadlines and prerequisite work separate from its dependent operation.
5. Requalify isolated existing-survivor consolidation against the same failures and held-out cases before save/reload/export checks or production deployment. Only then run a fresh five-generation comparison. Group-to-atomic materialization remains a separate app/Microsoft protocol task.

No duplicate pair is marked fully fixed by this research.
