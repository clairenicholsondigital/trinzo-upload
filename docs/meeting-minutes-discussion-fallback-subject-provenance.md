# Discussion fallback and supporting subject provenance

This phase fixes two application handoffs within `/meeting-minutes-agent`.

## Partial referee fallback

The referee selector deliberately strips full records from its compact provider
payload. The fallback planner previously required those missing records to
remove settled discovery rows from the recovery baseline. A failed sibling could
therefore reintroduce material already classified as supporting, merged or rejected.

The planner now resolves a private record against the existing discovery ensemble.
Binding requires a unique candidate ID and exact source pass, kind, topic, text
and citation projection. Ambiguous or stale identities remain recoverable.
Reviewer-owned records, topics and records with descendants retain the existing
protections. Baseline removal still requires exact full-record identity; topic,
owner, shared sources and semantic similarity cannot remove a row.

No full record is added to a provider request. Candidate selection, valid
verdicts, target checks, publication rules and unresolved-candidate recovery are
unchanged. Released cluster members use the same private lookup; separately
supplied members without a verdict remain eligible for recovery.

## Original subject through supporting placement

Reconstructed and compacted supporting details carry their existing original
subject, or their discovery topic when no origin exists. Normalisation retains
this bounded `originalTopic` metadata on both attached and promoted records.

If placement later fails, the lossless filing collector prefers the detail's
own origin over the proposed/current parent. Descendants inherit the nearest
origin only when they have none. Legacy details with no origin retain the
previous parent-topic fallback. The known generated-record archive accepts this
bounded field and preserves it verbatim; unknown or malformed metadata remains
protected from consolidation.

The origin is review metadata. It grants no authorship, evidence, parent match,
approval or permission to publish. No subject-match or raw-speech gate is relaxed.
Saved drafts are not migrated or reclassified by this release.

## Verification

- New tests exercise the actual compact contract rather than supplying private
  records directly to the fallback helper.
- Targeted cases cover supporting/merge/reject decisions, stale and duplicate
  identities, unresolved members, reviewer content and nested qualifications.
- Subject tests cover a structurally valid unrelated target, reconstruction,
  failed-parent publication, inherited origins and strict generated archives.
- Real route-handler tests cover PATCH/GET, undo/redo and export projection.
- Offline comparisons use both archived five-transcript sets. Subject-boundary
  replay must preserve main rows and every retained ID/text/evidence/warning
  inventory; fallback must retain each baseline row or explicitly account for
  its settled route. These are boundary replays, not fresh provider generations.

This phase does not solve cross-subject overflow, material-status classification
or accepted core targets disappearing at later publication gates. Those are the
next phase, and require separate coverage and safety validation.
