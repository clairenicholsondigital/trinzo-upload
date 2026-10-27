# Enquiry relationship classification qualification

Scope: `/meeting-minutes-agent` action comparison. No transcript-specific runtime
rules, new comparison classes, changed pair budgets or reduced proof requirements.

## Change

Contact-enquiry instructions distinguish differently detailed descriptions of one
source-supported enquiry from required content within a deliverable. Separate
requests, outcomes, responsibilities and occurrences remain distinct. The selected
existing action must retain the full requirement; shared names or conversation do
not establish equivalence.

The early assessment now applies the existing final contact requirements:
`same_obligation`, with `commitment` basis for both originals. A rejected proposal
stops before requesting an unnecessary challenge and is recorded as a semantic
veto. Cached rejected proposals cannot bypass the same check. Successful merges
still require two independent reviews, complete source/retention accounting,
unchanged existing survivor wording, final certification and reversible receipts.

## Recorded qualification

Control revision: `a4c350ddc84386604d72c3842b4eb51e229eb9fb`.
Revised implementation: `503fcf6e` (following prompt change `945c9101`).

The fixed order and acceptance criteria were saved before provider calls. Each
workflow started with an empty review cache and used single-attempt Microsoft
requests. Failures were retained rather than retried for a favourable answer.

| Fixed-input case | Control | Revised |
| --- | --- | --- |
| Saved DITA enquiry pair | Merged in 2/3 trials | Merged in 3/3 trials |
| Separate enquiries for different offices | Both retained | Both retained |
| Separate kickoff and handover conversations | Both retained | Both retained |

Both negative fixtures passed nomination and reached real source review. The
experiment used 16 Microsoft requests within the predeclared ceiling of 20, with
zero cache hits, semantic retries, database writes or false merges in the four
negative workflows. The control reproduced the inconsistent deliverable-content
verdict. Three successes are qualification evidence, not a reliable estimate of
future failure frequency or proof that every semantic duplicate is resolved.

## Preservation

All three successful revised proofs were replayed offline against the complete
saved 13-action DITA register. Request bytes matched their corresponding isolated
qualification exactly. Every replay produced 12 actions, preserved the other 11
records exactly, retained the fuller original enquiry wording, validated receipts,
and recovered the exact original register after identity admission, JSON and save
normalisation. Private quality data stayed out of the public projection.

All five saved transcripts retained byte-identical nomination packets against the
control implementation. No five-transcript regeneration, production draft rewrite
or colleague usability trial is claimed.

## Regression coverage and release gate

The focused shared-stage regression suite passed 176 tests. New cases first
reproduced eight delayed-veto/incorrect-diagnostic failures, then passed after
alignment, covering both row orders and both independent review roles. Cached
vetoes and existing successful two-review/receipt paths are covered. Another 24
non-enquiry prompt variants were byte-identical to the previous implementation;
enquiry source data and the neutral response contract were unchanged.

Release uses the existing full Python/JavaScript test gate and route checks before
the deployed revision marker is accepted. Record the final gate result on the PR.
