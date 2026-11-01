# House rules for AI helpers

Read this file and `docs/LIVE_PRODUCT_MAP.md` before any change. Each rule exists because breaking it is how the repo got messy in 2026.

## Before you start
- Keep one coherent goal per branch and PR, with a finite stopping point. Follow the user's agreed scope, including related steps they have authorized.
- Search for an existing helper, route module or test before creating a file. Say what you found and why you are or are not reusing it.
- If your change touches something not on the live product map, say so before writing code.

## While you work
- Extend the existing feature owner under `routes/` or `utils/` when appropriate. Treat files over ~800 lines as a reason to review responsibility, not a requirement to split them. Extract only when it solves a concrete maintenance problem within the task.
- Replace obsolete implementations rather than stacking versions. Verify consumers before retiring a path; supported alternatives such as Original and Beta remain supported. Record intentional coexistence in the live map.
- Repeated fixes to the same behaviour call for investigating the common cause. Keep the repair within the agreed scope and explain any larger redesign that needs a separate task.
- No experiments in production paths. New research code goes in `archive/` or a separate repo, and production must not import from it.
- Do not commit generated logs, research run outputs or `node_modules`. Runtime models, fixtures and UI-consumed reports listed in the live map are retained product inputs; justify their updates and verify consumers before removing them. Check `git status` before every commit.

## Docs
- No new top-level docs. Update `docs/LIVE_PRODUCT_MAP.md` and, if behaviour changed, add one line to `CHANGELOG.md`. Working notes go in the PR description or `docs/archive/`.

## Tests
- Test behaviour: call the route or function and check the result.
- Prefer behaviour tests over matching implementation strings. Retain justified security, architecture and source-contract checks. Replace brittle checks only when equivalent coverage is demonstrated; a small change should not require an unrelated test rewrite.

## Finishing
- Before opening the PR, sweep your own diff: leftovers (debug logs, dead code, unused imports, generated files), duplicates of existing helpers, and anything you replaced but did not remove. Put a short note of what you removed or flagged in the PR description.
- Bundle related small fixes into one PR. Structural changes need an independent review before merging; readiness depends on review and verification, not a fixed waiting period.
- Delete your branch once the PR is merged or closed.

# Verification for changes in this repository

- Use `npm test` for the compact product checks. Use `npm run test:changed -- --base origin/main` for a PR, or the PR's actual base revision if different. Fetch the base first.
- Inspect `--list` when the selection is unexpectedly broad. The selector retains the core and falls back to full regressions for installation/test infrastructure or unmapped changes. Follow that selection; do not independently repeat the full bank at each edit, push and merge.
- `npm run test:full` retains the broad regression bank. Shared API/legacy dependencies can still justify many tests. Retire cases only with evidence that their behaviour is covered elsewhere or their implementation is removed.
- Use isolated checkouts for implementation and keep production data/configuration out of fixtures.
- Database checks use `npm run test:integration` with an explicit disposable `TEST_DATABASE_URL` pointing to a database named `trinzo_tasks_test`. Never substitute production credentials. Required persistence coverage must pass before release.
- Deployment uses `test:release` against `.openclaw-deployed-revision`, including already-pulled changes. Missing baselines require `--all`; hand-picked development `--file` arguments cannot certify a release.
- Provider prompt changes require a representative transcript quality comparison as well as their contract tests. A passing JavaScript suite does not establish factual accuracy.
- After checks pass, repeat them only for subsequent relevant changes, failures or unresolved coverage gaps. Documentation-only follow-ups do not warrant another complete regression run.
- Report the selected profile, relevant behaviours, elapsed time and material gaps. Avoid presenting a large aggregate check count as the main evidence that a small change is safe.

The suite commands and selection rules are documented in README.md; the compact core and all PostgreSQL fixtures are listed in tests/suites.json.
