# Document scope: frozen regression baseline — 27 October 2026

Step 1 is complete. This is a fixture and replay change only. No prompts,
normalisation, source validation, draft records or deployment have changed.
The application baseline is `339f56849c62d93f01be252fd9d66b9b7c5cd969` (PR 186).

## Frozen evidence

The private baseline is `/root/trinzo-document-scope-baseline-20261027`.
Its read-only manifest hashes 51 fixture files: all 44 captured Microsoft replies,
both predeclared experiment plans and recorded normalisation outputs, source inputs,
the original overgeneralised standards action and the synthetic protected inputs.

The generation experiment supplied 17 source turns. The application's offline
normalisation replay uses the full 392-unit source, matching the earlier research.
The distinction is explicit in the fixtures. Raw meeting content is kept outside
the repository; the public manifest records provenance and expectations only.
Synthetic protected inputs are portable repository fixtures.

## Cases and measured baseline

| Case | Frozen requirement or observation |
| --- | --- |
| DOC-SCOPE-001 | Original assessment applies nebulising-port applicability to plural standards. Generation-negative reference only: normalisation must not be required to rewrite historical drafts. |
| DOC-SCOPE-002 | Three first-round assessment proposals name a document identifier absent from their citations. Each source score is zero and each proposal is rejected. Supplying the actual identity passage produces scores 0.42–0.56; this diagnostic does not certify the relationship. |
| DOC-SCOPE-003 | The assessment is absent from both normalised actions and proposals in two of six captured revised paired trials. Both failures are from the first round. Later recovery was not run. |
| DOC-SCOPE-004 | Five of twelve captured revised single-response replays lose the assessment at this boundary. Four are from round one; one is from round two. All primary-only and secondary-only cases remain in the replay. |
| DOC-SCOPE-005 | Twenty protected replays pass: joint assessment, different purposes, ambiguous reference, recipient versus assessor, and conditional/separate work, across both routes and rounds. These checks do not certify every word in a model reply. |

## Reproduce without services or production data

With repository dependencies available, run:

```bash
node scripts/check_meeting_action_document_scope_baseline.js /root/trinzo-document-scope-baseline-20261027 --verify-capture
```

This verifies checksums and the frozen observations. It reports five failing
single-response cases and two failing paired cases, not a completed fix.

Run the acceptance gate without `--verify-capture`:

```bash
node scripts/check_meeting_action_document_scope_baseline.js /root/trinzo-document-scope-baseline-20261027
```

It deliberately exits **1 on the unfixed application**. There are no skipped or
TODO assertions hiding these failures. The default gate becomes green only when
the supported assessments survive every captured availability case and the
protected distinctions remain intact. Input mutation, database access and provider
calls are prohibited. The baseline replay uses no AI requests or persistent writes.

`offlineRetentionGatePassed` concerns this processing boundary only.
`readyForRelease` remains false: this offline replay cannot replace the later
Microsoft qualification, full-workflow checks and deployment gate.

## Step 2 hand-off

Make the smallest local correction at `normaliseAgentDeclaredProposals` in
`routes/api.js`, supported by the source-evidence utilities in
`utils/meetingMinutesAgentV2.js`. The frozen failed instructions are not deployed.

Do not lower the evidence threshold, treat an identifier's nearby occurrence as
proof of a relationship, infer accepted ownership or discard genuinely supported
uncertain work. A proposed correction must preserve separate work and conditions,
record source provenance, and handle either discovery response being unavailable.
Additional negative cases for unrelated identities and competing references are
required before implementation can pass its later safety stage.

Leave the captured failures and expected outcomes intact. The `--verify-capture`
mode is a historical characterisation check, not the post-fix release criterion.
No PR, merge or deployment is authorised by passing this replay alone.

## Step 3 accounting clarification

The frozen files and the original missing-assessment measurements remain intact.
The replay now additionally records whether the original source-backed ownership
question survives where the provider supplied no assessment instruction. That
question is **not** counted as an assessment row. The default offline gate checks
that supported work remains available for review in one of those two forms, as
required by step 3. It still cannot authorise deployment. See
`meeting-minutes-document-scope-step3-20261027.md` for the separate counts and
remaining validation stages.
