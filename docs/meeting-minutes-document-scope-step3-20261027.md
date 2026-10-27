# Document scope: step 3 — 27 October 2026

## Implemented, held for validation

Supported uncertain assessment work now remains reviewable in two distinct forms.

1. When a proposal names an unstated identifier prefix, the narrowly linked
   identity context can retain its original wording with an explicit correction
   warning. The prefix is recorded as **unstated**, never verified or silently
   removed. The evidence threshold remains 0.22 and step 2's other context guards
   still apply.
2. When discovery provides only a typed ownership warning and no identified
   assessment action, a valid source-backed warning remains a review question.
   Its original explanation, type and citations persist. No action or owner is
   manufactured. The adapter requires cited assessment/request language and
   excludes unknown/duplicate/excluded source IDs, completed/declined work and
   unrelated notices.

Context warnings persist even when a later lifecycle/proposal filter withholds
its candidate. Primary-only source questions are explicitly carried into the
Action stage result; they cannot rely on an unrelated final row recovering them
from the transient warning registry.

## Human-review protection

- Commitment verification cannot resolve a document-reference warning.
- Existing safe promotion remains blocked by review flags.
- Automatic proposal adoption refuses these flagged additions/modifications even
  if an old or model-created proposal marks them selected.
- Automatic consumption reuses the source warning's identity and provenance;
  repeated processing does not create another copy of that same warning.
- Warning text leads with the uncertainty before the proposed wording so a long
  action cannot truncate away the correction instruction.
- Explicit human acceptance remains a separate existing mechanism.
- Save/load and review undo/redo preserve the source context and human notes.

## Frozen replay: retain work without pretending a question is an action

The 44 captured replies, source fixtures and their checksums remain unchanged.

| Measure | Before corrections | After step 2 | After step 3 |
| --- | ---: | ---: | ---: |
| Paired replies: assessment missing | 2/6 | 0/6 | 0/6 |
| Single reply: assessment missing | 5/12 | 2/12 | 1/12 |
| Single reply: work unavailable even as a source question | 5/12 | 2/12 | 0/12 |
| Protected distinctions | 20/20 | 20/20 | 20/20 |

The remaining literal-row absence is deliberate: the provider returned no
assessment instruction. Its source-backed question survives instead. The report
continues to show `assessmentRetained:false` and separately records
`reviewQuestionRetained:true`. It is not counted as a generated/recovered action.

The offline gate now explicitly measures **work available for review**, reflecting
step 3's authorised preservation requirement. Both original missing-row metrics
remain visible; neither frozen expectations nor captured failures were erased.
`offlineRetentionGatePassed:true` is not release approval: `readyForRelease` is
still false, pending steps 4–6.

## Verification

298 focused tests passed, including source/quantity guards, warning identity,
automatic-edit protections, real API handlers with in-memory persistence, and
save/load/undo/redo. Existing removal tests exposed a null-record case in the new
reference gate; it was corrected and all affected tests rerun successfully.
Offline normalisation of all five saved registers (52 actions) exactly matches
production. No new AI requests or persistent application/database writes occurred.

Evidence: `/root/trinzo-document-scope-step3-20261027`.

## Ready for step 4

Run the broader safety matrix, including competing/unrelated identities,
source uncertainty, sole-response operation, visible review wording, and the
complete generation/proposal/persistence boundaries. A preserved optional question
must never be reported as an accepted action or a completed assessment.
Do not claim a fresh full-workflow or live-user result from this offline replay.
