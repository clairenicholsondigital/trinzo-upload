# Document scope: step 2 — 27 October 2026

## Implemented, held for step 3

A local proposal-only correction in `normaliseAgentDeclaredProposals` considers
source identity context before rejecting an otherwise supported assessment for
missing identifier evidence. The original 0.22 support threshold remains intact.
No generation prompt, action publication, ownership or date policy has changed.

`documentReferenceContextEvidence` in `utils/meetingMinutesAgentV2.js` permits
only one named numeric document identifier and one source connection:

- The cited work explicitly uses a singular document reference.
- The immediately preceding source turn, from the same known speaker, states
  the matching identity. Source IDs must be consecutive and unique.
- Neither source turn is excluded; no intervening turn can be skipped.
- Competing identifiers, multiple document references, document-kind conflicts,
  ambiguous alternatives, incidental financial values, unstated identifier
  prefixes and unsupported additional quantities prevent this repair.
- The work passage itself must support the assessment, independently of the
  identifying passage. Completed, rejected, administrative and status-only
  readings do not gain context through this path.
- All original valid citations are retained within the existing citation budget.

This nominates context; it does not certify a semantic relationship. A recovered
proposal always receives an open `unclear_reference` warning that explicitly
requires confirmation. Original, added and work citation IDs persist in bounded
warning provenance. Human decisions and notes are preserved by normalisation.
No new owner, accepted commitment or timing is derived from the added passage.

## Evidence

Frozen fixtures and expectations remain unchanged.

| Replay observation | Before | After step 2 |
| --- | ---: | ---: |
| Paired-response assessment missing | 2/6 | 0/6 |
| Single-response assessment missing | 5/12 | 2/12 |
| Protected distinctions passing | 20/20 | 20/20 |

The remaining single-response failures are explicitly still red:

1. A model adds an unstated `ISO` prefix. Step 2 does not silently substantiate
   that prefix merely because the numeric identifier occurs in the source.
2. A discovery response provides only an ownership warning and no assessment
   proposal. This function cannot preserve a proposal it did not receive.

These are the step 3 preservation/uncertainty hand-off, not completed fixes.
The default offline acceptance gate still exits 1, with `readyForRelease:false`.
Nothing in the captured plans, expected counts or immutable source fixtures was
changed to turn the gate green.

Validation: 244 focused tests passed, including 23 new context/guard regressions,
legacy action processing, evidence fallback, warning origins, review identity,
save/reload/undo/redo and diagnostics. Both paired failures are removed at the
measured discovery/normalisation boundary, not proven absent from a fresh full
workflow. Offline normalisation of the five saved registers (52 actions) matches
the deployed implementation exactly.

Private replay evidence is in `/root/trinzo-document-scope-step2-20261027`.
No provider calls, database writes, production draft changes or deployment occurred.

## Ready for step 3

Next, preserve genuinely supported uncertain work without inventing document
prefixes or ownership, and ensure the warning/provenance survives through the
actual proposal, persistence and human-review path. Do not publish or automatically
approve a context-repaired proposal solely because its source score now passes.
Full qualification and release remain later steps of the agreed plan.
