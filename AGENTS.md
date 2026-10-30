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
