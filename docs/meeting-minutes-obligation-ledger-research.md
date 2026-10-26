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

Input is `{sourceUnits:[{id,speaker,text}],members:[{ref,focusEvidenceId}],sourceHash,meetingDate}`. Extra candidate descriptions are omitted. Source hash refers to the frozen complete source snapshot; sourceUnits can be the supplied bounded context. This does not claim complete-transcript coverage when context was omitted. Output files are private and never overwritten. Validation distinguishes invalid responses (exit 1), valid semantic vetoes (exit 2) and a complete source review (exit 0). Every outcome reports `automaticClosureAllowed:false`; completeness never establishes target coverage.

Private exact requests/replies, wire failures and saved-evidence results are retained in `/root/trinzo-shared-obligation-research-20261026` and `/root/trinzo-obligation-ledger-research-20261026`. No production cache reset, draft write or fresh generation was performed.
