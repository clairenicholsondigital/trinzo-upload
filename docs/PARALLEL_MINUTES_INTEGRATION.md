# Parallel minutes integration

This integrates the tested Microsoft prototype into the existing authenticated minutes editor, Library and exports. The original generator remains the default until the user reviews the preview.

## Frozen generation architecture

1. Existing upload extraction, phrase corrections, meeting metadata and one MiniLM v3 preparation.
2. Exactly three independent concurrent Microsoft requests: summary, discussion and actions. All receive the same evidence packet.
3. Structural/evidence-ID validation and deterministic assembly, followed by persistence.

There is no semantic repair, deduplication, referee, delegation, speculative generation or automatic provider retry in this path. It reuses the prototype's engine and existing published Microsoft agents/webhooks in the same developer environment. No new service or Microsoft flow is needed.

The original benchmark instructions are versioned under `config/meeting-minutes-parallel/`. Versions two and three were experiments, not established upgrades. Integration does not publish or edit Microsoft instructions.

## Preview and switch

Runtime configuration:

- `MEETING_MINUTES_PARALLEL_CONFIG`: absolute private JSON configuration path containing the existing three webhook URLs, agent identities, published booleans and instruction hashes. Do not commit this file or print its URLs.
- `MEETING_MINUTES_AGENT_GENERATOR`: absent/`legacy` keeps the original default; `parallel` selects parallel for new uploads.

The private configuration must match the SHA-256 hashes of the versioned instructions. Missing/unverified configuration fails explicitly before upload persistence; it does not silently invoke the old generator.

Administrators can opt in through `/meeting-minutes-agent?engine=parallel` while the default remains unchanged. The browser submits `generationProvider=parallel-specialists-v1` with the upload. Other users cannot request the preview explicitly. A rollout flag can select it as the default for all authenticated users after acceptance.

Each draft stores a server-owned generation-provider marker. Existing drafts keep their current behaviour, irrespective of the new-upload default. Reverting the default to `legacy` therefore does not migrate or reinterpret saved parallel drafts.

## Review and preservation

Parallel content bypasses the old generation, save-normalisation and publication cleanup passes. Save, read, Word and PDF adapters retain the specialist's wording and timing qualifications.

The normal editor supports manual correction, evidence navigation, action removal/checking, section visibility, final save, Library reopening, undo/redo and exports. People-directory classification still applies through the existing metadata sanitizer.

Possible actions remain separate under “Possible follow-ups”; they are not automatically accepted. Adding/dismissing a suggestion is an explicit, revision-guarded reviewer operation, retained in history and reversible. Source uncertainty remains reviewable after acceptance. Evidence exports include suggestion status, source material and review notes.

All three results become available together. Individual discussion edits do not invalidate the independently transcript-grounded actions or summary. Meeting-metadata changes mark generated sections for review.

“Generate another draft” performs the same three-call generation in a new Library draft, preserving the previous draft and reviewer edits. Concurrent requests on the same draft share the active generation. No hidden single-section call or automatic retry is introduced.

AI rewrite controls and the legacy action-audit service are unavailable for parallel drafts. In-place transcript editing is also unavailable: upload a revised transcript to generate revised minutes. These limits keep the frozen architecture intact; manual minute editing remains available.

## Failures

Results are applied only when all three branches complete and validate. A failed/malformed/timed-out branch produces a visible failure while preserving saved content and the private attempt record.

A concurrent input/content edit prevents stale generation from replacing it. Optimistic revision conflicts retry persistence only; they never repeat Microsoft calls. Background work survives closing the tab. A server restart can interrupt it; the UI exposes the interruption and an explicit retry is required.

The publication adapter validates shape and references, not factual truth or semantic completeness. Remaining quality tasks stay open.

## Validation

Focused tests:

```sh
node --test tests/meeting-minutes-parallel*.test.js
npm run build:meeting-agent
npm test
```

The production PATCH history harness imports the new provider dependency so the existing legacy history-preservation tests continue to execute their original path.

Explicit external-service acceptance:

```sh
PARALLEL_ACCEPTANCE_OUTPUT=/absolute/private/artifact-directory \
  node scripts/parallel_minutes_acceptance.cjs --microsoft
```

This runner creates a uniquely named disposable database, uses real authenticated routes and browser interactions, then closes connections and deletes only that database. It does not generate into or rewrite production drafts. It requires database-creation permission and the private Microsoft configuration.

Cases: T733 technical-file meeting, DITA internal meeting, and the deadline-dependency control. Checks cover upload/preparation, three branch completions, save/reopen, unchanged wording, owner isolation, stale revisions, suggestion acceptance/undo, desktop/mobile rendering, Word and actual PDF exports. The dependency control preserves the rejected Monday date and relative dependent deadlines.

`PARALLEL_ACCEPTANCE_REPLAY_DIR` can reuse an already recorded successful generation for UI/persistence debugging; each report identifies this explicitly. Replayed results are not fresh Microsoft generations or fresh quality evidence.

For a temporary, loopback-only review session, set \`PARALLEL_ACCEPTANCE_REVIEW=1\` and provide a replay directory containing the recorded originals. The runner restores those outputs without test edits, keeps its isolated database/server alive for up to twelve hours, and writes a private \`review-control.json\` containing session access. It uses no production records, creates no persistent service and changes no live default. Optional \`PARALLEL_ACCEPTANCE_REVIEW_NOTES\` supplies explicit human review annotations; these are not production extraction rules. Stop the process to close its connections and delete its own disposable database.\n\nThe 28 October technical acceptance records are private on the VPS. The first T733 generation succeeded before a test-harness asset-serving failure; its recorded output was reused for subsequent UI checks. DITA internal and the deadline control were freshly generated in the final acceptance run. No claim of an independent colleague trial is made: the user chose to review first.

## Release sequence

1. Pass focused and repository regression checks.
2. Deploy opt-in integration with the legacy default.
3. Preserve existing record hashes and prepare a few clearly identified review drafts.
4. Let the user inspect/correct/save/export them in the live editor.
5. Change the default only after that review; retain the legacy rollback option.

AI-011, AI-017, AI-019, AI-022 and the human pilot requirements are not automatically completed by this release. Existing historical drafts are not migrated or rewritten.
