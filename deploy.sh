#!/usr/bin/env bash
# Deploy gate for the live tree.
#
# The process this replaces was `git pull && pm2 restart`, from memory, with the tests run
# afterwards against production if they were run at all. It worked because the person
# doing it remembered the steps; a script does not forget, and it refuses instead of
# hoping.
#
# Run it FROM the live tree:   cd /srv/m365-agent-test && bash deploy.sh
#
# Order matters and is the point:
#   1. pull        - the running process serves from memory, so the tree can change under
#                    it safely; nothing is live until the restart
#   2. npm test    - against the new revision, BEFORE it serves traffic; a failure rolls
#                    the tree straight back and never restarts
#   3. restart     - only past a green suite
#   4. smoke check - the route must answer; a dead app rolls back and restarts the old one
#   5. marker      - written last, by the same script, so it cannot say something is live
#                    that is not. The old marker went stale precisely because deploys and
#                    the marker were separate manual steps.

set -euo pipefail

APP_NAME="${APP_NAME:-trinzo}"
SMOKE_URL="${SMOKE_URL:-http://localhost:3978/staged-meeting-minutes}"
MARKER=".openclaw-deployed-revision"
export CANONICAL_MINILM_DISK_CACHE="${CANONICAL_MINILM_DISK_CACHE:-.minilm-cache}"

say() { printf '%s\n' "deploy: $*"; }
fail() { printf '%s\n' "deploy: FAILED - $*" >&2; exit 1; }

[ -d .git ] || fail "run this from the live tree (no .git here)"
[ -f server.js ] || fail "run this from the live tree (no server.js here)"

before="$(git rev-parse HEAD)"
say "current revision $(git rev-parse --short HEAD)"

if ! git diff --quiet || ! git diff --cached --quiet; then
  fail "the live tree has local modifications; resolve them before deploying"
fi

git fetch origin
after="$(git rev-parse origin/main)"
if [ "$before" = "$after" ]; then
  say "already at origin/main ($(git rev-parse --short "$after")) - nothing to deploy"
  exit 0
fi

say "pulling $(git rev-parse --short "$before")..$(git rev-parse --short "$after")"
git merge --ff-only origin/main

say "running the test suite against the new revision (the app keeps serving the old one)"
if ! npm test; then
  say "tests failed - rolling the tree back to $(git rev-parse --short "$before"), nothing was restarted"
  git reset --hard "$before"
  fail "the new revision does not pass its own tests"
fi

say "tests green - restarting $APP_NAME"
pm2 restart "$APP_NAME" --update-env >/dev/null
sleep 5

status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$SMOKE_URL" || echo 000)"
case "$status" in
  200|302)
    say "smoke check: $SMOKE_URL -> $status"
    ;;
  *)
    say "smoke check failed ($SMOKE_URL -> $status) - rolling back and restarting the previous revision"
    git reset --hard "$before"
    pm2 restart "$APP_NAME" --update-env >/dev/null
    fail "the new revision did not answer; the previous one is serving again"
    ;;
esac

git rev-parse HEAD > "$MARKER"
say "deployed $(git rev-parse --short HEAD); marker updated"
