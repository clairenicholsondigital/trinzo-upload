# Action warning wording provenance — 27 October 2026

## Problem and scope

An isolated fresh Eakin run on `7ef3ae24` retained a follow-up action but inherited
an evidence warning quoting a discarded, stronger instruction. Diagnostic event
414 recorded the consolidation. The current action was already correctly shown
in the review queue; the explanation did not identify its earlier wording.

This change applies only to `/meeting-minutes-agent`. It changes neither action
selection, owners, timings, citations nor merge eligibility.

## Implementation

- Newly created checks in `normaliseAgentResult` record `actionWordingAtCheck`
  only when their explicit flag ID links to exactly one action.
- `normaliseFlag` preserves this bounded optional value through persistence.
- Incoming historical warnings are not backfilled from current actions or parsed
  quotations. No production drafts are rewritten.
- Where a uniquely linked current action differs from the recorded wording, the
  collapsed explanation explicitly identifies the earlier wording and retains
  the original explanation. All text is escaped.
- Shared or ambiguous targets retain the existing presentation.
- Different known wording origins remain distinct in warning deduplication.
  Existing reviewed warnings without provenance remain compatible with the
  established exact-target regeneration rule, so this metadata does not reopen
  completed checks. IDs, notes, evidence and reviewer decisions are preserved.

## Validation

- 57 focused offline regressions passed: provenance, consolidation, review flag
  identity, actual in-memory save/reload/undo/redo routes, citation ordering and
  diagnostics.
- Four targeted browser checks passed: changed wording, HTML escaping and
  existing controls; historical, unchanged and shared checks.
- Offline before/after normalisation of the five saved registers (52 actions)
  matched exactly after excluding newly recorded check-origin metadata. Existing
  action wording, owners, timing, evidence and review states were unchanged.
- Full browser suite and deployment gate results are recorded in the PR/release
  evidence when complete.

## Limits

Earlier warnings without captured origin cannot retrospectively be labelled
reliably. This fix does not decide whether an inherited warning still applies,
resolve source ambiguity or automatically approve an action. No new model calls,
transcript-specific rules, migrations or production data changes are required.
