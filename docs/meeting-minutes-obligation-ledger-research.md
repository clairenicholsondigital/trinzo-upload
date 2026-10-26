# Shared source obligations: qualification research, held

This branch supplies an offline research protocol and tests. It is not connected to generation, review-item closure, actions, the library or exports. No runtime feature is enabled and no production changes are proposed here.

## Root causes investigated

The previous per-turn inventory required at least one semantic item for every member. One logical request/acceptance could become multiple work and context items. Seven of nine blocked controls contained standalone neighbouring evidence assigned to the wrong focus. Requiring more detailed instructions did not prevent this structure from encouraging redundant records.

The first shared-record experiment removed duplicate context obligations but still asked the model to bind members to obligations. Its result improved from 8/17 to 12/17 controls. In a saved failure, the model interpreted member IDs as people and mapped both source turns to both tasks because the speaker was the same. A completed obligation was also labelled committed and fulfilled, rather than excluded from outstanding work. No such output was applied.

There was another avoidable research confound: the purported source-only packet included generated candidate descriptions. The new packet strips those interpretations and passes only source text, source metadata and member focus references. The model cannot use a generated description as source evidence.

## Separated prototype

The ledger inventories each obligation once, including complete source qualifications and explicit final status (`outstanding`, `not_outstanding`, `uncertain`). It does not output independent context items or source-member-to-person relationships. Historical work can remain as explicitly not-outstanding evidence rather than disappearing from the record.

A separate source-only completeness review reads every original focus and checks every proposed record for source support, final status and qualifications. Valid unresolved/false verdicts remain vetoes. Literal source quotes, exact member/record accounting, source identity, packet freshness and source-focus checks remain mandatory. Actual target-text retention is a subsequent separate research check. None of these stages has mutation or closure authority.

The final 17-case live Microsoft matrix passes 15/17:

- One replacement-recipient completeness response is malformed JSON. The captured wire reply is preserved; this is a provider-format failure, not a semantic verdict and not repaired into acceptance.
- In the ambiguous-answer control, the ledger and completeness reviewer both call an unaccepted request outstanding. Another obligation remains uncertain, so the overall group still cannot qualify; nevertheless, this is a genuine classification error that must not be hidden by a structural validator.

These are synthetic qualification results, not improvements to five regenerated library drafts.

## Saved-evidence checks and ceiling

Four previously overconfident group candidates were tested read-only. The Abbott group receives a valid completeness veto. The notes group is blocked for a neighbour-only obligation. One council thread now retains the photo as separate work and reports that its target does not contain it.

However, the other council chain still combines the photo with the letter. Both source stages accept that combination, and the target checker claims retention while quoting text that does not contain the photo or the explicit communication requirement. Its reason says the photo is implied. Exact source/target quotes and agreement between model calls do not prove complete semantic retention. This counterexample blocks automatic removal despite better synthetic scores.

The immediate next semantic boundary is explicit operation/qualification witnesses checked against the actual target, including communication wording and supporting deliverables. Do not relax source focus, owner, timing, scope or target-span checks, and do not enable automatic closure based on a bare majority or two-model agreement. No current saved group is authorized for deletion by this research.

## Reproduction

Run the local contract tests:

```sh
node --test tests/meeting-minutes-obligation-ledger-research.test.js
```

The offline CLI prepares prompts and validates manually supplied raw protocol responses; it performs no network or database calls:

```sh
node scripts/meeting_minutes_obligation_ledger_research.js prepare-source input.json output-dir
node scripts/meeting_minutes_obligation_ledger_research.js prepare-review output-dir/source-packet.json inventory-response.json review-dir
node scripts/meeting_minutes_obligation_ledger_research.js validate-review review-dir/review-packet.json review-response.json
```

Version-2 input is `{sourceUnits:[{id,speaker,text}],members:[{ref,focusEvidenceId,focusQuote}],sourceHash,meetingDate}`; an explicit `focusMode:"whole_unit"` can replace `focusQuote`. Extra candidate descriptions are omitted. Source hash refers to the frozen complete source snapshot; sourceUnits can be the supplied bounded context. This does not claim complete-transcript coverage when context was omitted. Output files are private and never overwritten. Validation distinguishes invalid responses (exit 1), valid semantic vetoes (exit 2) and a complete source review (exit 0). Every outcome reports `automaticClosureAllowed:false`; completeness never establishes target coverage.

Private exact requests/replies, wire failures and saved-evidence results are retained in `/root/trinzo-shared-obligation-research-20261026` and `/root/trinzo-obligation-ledger-research-20261026`. No production cache reset, draft write or fresh generation was performed.

## Exact focus binding (second qualification batch)

Version 2 requires an explicit literal `focusQuote` for each member, or an explicit `focusMode:"whole_unit"` declaration. Generated `text` is never a fallback. The app resolves a quote only when it occurs exactly once, including overlapping occurrences, in exactly one identified source unit. It preserves original spelling and whitespace. The packet includes its UTF-16 start/end offsets, exact quotation, source-unit identity and SHA-256 hash of the JSON-encoded original source text. Full context remains available: a focus beginning after “not” is not a positive commitment, and a pronoun can still need an earlier request.

Missing, repeated, changed or normalized quotations fail preparation. Ambiguous source IDs fail too. Changing a span changes the packet fingerprint; old version-1 packets and responses cannot be silently reused. Provider source quotations must also be uniquely located and overlap an actual supplied focus span. A quotation from another clause of the same turn is insufficient. None of these structural checks establishes semantic equivalence or complete retention.

Updated CLI input example:

```json
{
  "sourceHash": "hash-of-frozen-full-source-snapshot",
  "meetingDate": "2026-10-26",
  "sourceUnits": [{"id":"T1","speaker":"Nora Patel","text":"I will write the letter, and I will take a photograph tomorrow."}],
  "members": [
    {"ref":"M1","focusEvidenceId":"T1","focusQuote":"write the letter"},
    {"ref":"M2","focusEvidenceId":"T1","focusQuote":"take a photograph tomorrow"}
  ]
}
```

Whole-unit inputs must explicitly use `focusMode:"whole_unit"` and omit `focusQuote`. Supplying both is invalid. Version-1 callers must add this explicit focus declaration; no automatic whole-turn fallback is provided.

Seventeen local tests cover binding, ambiguous/repeated quotes, Unicode and UTF-16 offsets, cross-clause rejection, retained negation/context, packet freshness, legacy response rejection, malformed provider output and private offline CLI artifacts. Saved-evidence preparation verifies all **138 member occurrences in 30 unresolved groups** without changing the source, actions or review decisions.

Live qualification details and the remaining semantic limitations are recorded below. This remains a held research PR; no application runtime imports this protocol.

### Version-2 qualification outcome

The new live Microsoft run passes **20/21 controls**, using 59 provider calls. These include the original 17 cases plus same-turn supporting work, clipped negation, clipped condition and an unrelated literal directive in the same turn. This is a new run, not a claim that earlier classification failures are permanently eliminated.

The clipped-condition case fails qualification. Its ledger reason acknowledges safety approval, but its literal source span excludes the condition. The independent completeness reviewer nevertheless claims all qualifications are preserved. The target checker returns `unclear`, correctly explaining that the target lacks the approval condition. Thus this is an evidence/completeness defect, not an observed unsafe final acceptance. The failed control is preserved, not weakened or rerun into a pass.

Four saved groups require another 11 calls. In the council chain, the explicit required word is now recognised as absent from the target. In the broader council thread, both the word and the separate photograph are recognised as absent. However, the model inventories the whole letter promise and its overlapping clauses as separate records, even while explaining they are parts of one obligation. Both source stages accept that structure. Target retention still falsely calls the *whole* promise retained, despite its missing required word; the separate word record receives a correct negative verdict. This contradictory per-record result remains an independent blocker even though the group does not qualify overall. The chain has no photograph focus member: neighbouring photograph work must not be counted as a chain obligation merely because it appears in its context.

The other saved groups produce an uncertain planning item with no target retention, and a not-outstanding notes item respectively. These results are research judgements, not authorization to close either existing review item. All research responses preserve `safeForAutomaticClosure:false`.

**Decision:** exact focus preparation and validation are implemented and locally tested; semantic cleanup remains unqualified. This PR stays draft and is not merged or deployed. The production deployment remains PR 157. No runtime files, review decisions, cache entries or library drafts were changed. All 60 drafts and the environment were checked against the previous deployment's preservation receipt.

**Next bounded work:** separate the immutable member audit from the source inventory's overlapping focus descriptions, so a full promise and its nested clauses do not encourage one obligation per member. Any overlapping-focus grouping must describe source geometry only, never equate independent tasks. Separately require complete operation/qualification witnesses against actual target text, with deterministic vetoes for explicitly required literal wording. Preserve the clipped-condition failure and contradictory full-promise retention as mandatory negative controls, alongside separate tasks in one turn, antecedents, refusals, completed work, ownership, recipient and timing safeguards. Do not activate automatic closure until these saved counterexamples genuinely fail acceptance.

Private artifacts for this batch, including exact requests, replies, all failed controls, saved-group results and source-binding checks, are in `/root/trinzo-exact-focus-research-20261026`. There were 70 Microsoft research calls in total, zero production writes and no new transcript generation.
