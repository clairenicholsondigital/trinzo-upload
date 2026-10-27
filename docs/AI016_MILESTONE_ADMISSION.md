# AI-016: prevent accidental milestone creation and recreation

Implementation prepared on 26 October 2026 from main commit `302ce84d0f2b65a6e3433b6ccbe81825af36f77a`. This change is for review; it is not a deployment receipt.

## Verified causes and correction

The project analyser treated every quoted phrase as a possible milestone. Unmatched phrases could then become report rows. Saving checked for existing active milestones only, so an inactive name could be inserted again as a new active record.

New labels now need source-grounded milestone intent or a clear named deliverable update. The existing configured programme vocabulary remains supported when its source alias is present. Quotation marks, model flags and invented summaries alone do not authorise creation.

Matching to existing project milestones is separate from admitting new records. Exact and accepted semantic matches, carried-forward context and discussion of previously completed work remain supported. Historical context is not authority to reactivate an inactive database record. Unknown progress remains valid for a genuinely named new milestone.

Python extraction and JavaScript persistence use the same admission policy and test cases. Persistence checks the actual submitted transcript. It loads inactive records in the selected project, excludes matching inactive names (including case/separator variants), and checks again in the insertion query. A target made inactive between preflight and the insertion query is excluded from the saved report too. These checks do not claim to serialise every possible concurrent edit after that query.

Unadmitted report rows are excluded from the returned/saved milestone list, with an admission reason recorded. Raw extraction, narrative key updates and original source text remain available. The change does not rewrite earlier reports, source records or approved history, and does not clean up existing candidates.

## Validation

- **445 Python regression tests passed**, including five new test methods and shared positive/adverse admission cases.
- **129 relevant Node tests passed**, with an explicit disposable PostgreSQL database. This includes 12 milestone-admission persistence tests, existing cross-milestone binding checks, report approval/history, browser save/reload, editor recovery, fallback generation and minutes-to-project handoff.
- After rebasing onto main including PR #174 (`7107e5dc1ec828d855a8c5cbc05e8ea6a88d8936`), **148 Node checks passed**: the same 129 relevant checks plus 19 AI-011 checks from the concurrent release.
- **20/20 project-update reference examples passed** without MiniLM enabled. These are regression checks, not independent human pilot results.
- Meeting-agent build and whitespace checks passed.
- Read-only local replay of the saved sources for reports **40 and 41** reproduced one accidental “All Over The Place” milestone per source under the base implementation and none under the patch. Sources and production reports were not changed; no external AI services were called.
- The wider Node suite was attempted but exceeded the tool timeout before completion. It is not reported as passing. Relevant project-update checks completed separately.
- Browser/database tests were run through a non-hidden symlink to the isolated worktree: Express otherwise refuses the hidden `.devspace` ancestor. No application workaround was introduced for that test environment restriction.

The shared cases cover descriptive quotes, explicit milestones with unknown progress, named deliverable updates, negative/proposed/deleted work, unrelated milestone cues, model-invented evidence and distinct names. Database tests additionally cover project isolation, inactive IDs, repeated source import, deactivation during saving, and preservation of earlier approved records.

## Scope and closure

No migration, schema change, production regeneration or existing-milestone mutation is needed. Manual project setup and meeting-minutes processing are unchanged.

**AI-016 is implemented and tested on the PR branch, awaiting review, merge and deployment.** Keep its task status In progress until released and checked. Existing-data decisions and cleanup belong to **AI-021** and are not a prerequisite for releasing this prevention fix.

This is a conservative deterministic safeguard for the demonstrated failure mechanism, not a claim that arbitrary natural-language milestone intent can always be inferred. Ambiguous new labels can still be added deliberately through existing project setup.
