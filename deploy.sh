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

# Not `[ -d .git ]`: the live tree's .git is a FILE - a gitdir pointer - and the first
# live run of this script rejected exactly the directory it exists for. Ask git itself.
git rev-parse --git-dir >/dev/null 2>&1 || fail "run this from the live tree (not a git checkout)"
[ -f server.js ] || fail "run this from the live tree (no server.js here)"

before="$(git rev-parse HEAD)"
deployed="$(cat "$MARKER" 2>/dev/null || true)"
say "current revision $(git rev-parse --short HEAD)"
say "marker says ${deployed:0:8}${deployed:+ is live}"

if ! git diff --quiet || ! git diff --cached --quiet; then
  fail "the live tree has local modifications; resolve them before deploying"
fi

git fetch origin
after="$(git rev-parse origin/main)"

# What is live is what the MARKER says, not what the remote says. Comparing the
# tree to origin/main alone was wrong for the commit authored IN the live tree:
# push, and the two match immediately, so this said "nothing to deploy" and
# exited without restarting while the running process was still on old code.
# That is not hypothetical - it silently skipped 23 commits between 2026-09-07
# and 2026-09-08, every one of them committed here rather than pulled.
if [ "$before" = "$after" ] && [ "$deployed" = "$after" ]; then
  say "already at origin/main ($(git rev-parse --short "$after")) and marker agrees - nothing to deploy"
  exit 0
fi

pulled=0
if [ "$before" != "$after" ]; then
  say "pulling $(git rev-parse --short "$before")..$(git rev-parse --short "$after")"
  git merge --ff-only origin/main
  pulled=1
else
  say "tree is already at origin/main but the marker is not - restarting onto $(git rev-parse --short "$after") without a pull"
fi

say "running the test suite against the new revision (the app keeps serving the old one)"
if ! npm test; then
  if [ "$pulled" = "1" ]; then
    say "tests failed - rolling the tree back to $(git rev-parse --short "$before"), nothing was restarted"
    git reset --hard "$before"
  else
    say "tests failed - nothing was pulled, and nothing was restarted"
  fi
  fail "the new revision does not pass its own tests"
fi

# Everything this tree runs, not just the web process.
#
# deploy.sh restarted "trinzo" alone, and three other pm2 processes run from this same
# directory: the minutes job worker, the MiniLM worker and the rewriter. They were found
# serving three- and four-day-old code after several deploys, which is exactly the state
# that makes "have you actually deployed?" a reasonable question - the answer was yes for
# the web process and no for everything beside it.
#
# The staged review is unaffected either way: its stages run in-process (181 staged-stage
# completions logged by trinzo, none by the worker). The /meeting-minutes-final queue is
# not, and neither are the two helpers.
say "tests green - restarting $APP_NAME and its workers"
pm2 restart "$APP_NAME" --update-env >/dev/null
for worker in $(pm2 jlist 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{JSON.parse(d).forEach(p=>{if(p.name&&p.name.startsWith("trinzo-"))console.log(p.name)})}catch{}})'); do
  say "restarting worker $worker"
  pm2 restart "$worker" --update-env >/dev/null || say "warning: could not restart $worker"
done
sleep 5

status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$SMOKE_URL" || echo 000)"
case "$status" in
  200|302)
    say "smoke check: $SMOKE_URL -> $status"
    ;;
  *)
    say "smoke check failed ($SMOKE_URL -> $status) - rolling back and restarting the previous revision"
    if [ "$pulled" = "1" ]; then git reset --hard "$before"; fi
    pm2 restart "$APP_NAME" --update-env >/dev/null
    fail "the new revision did not answer; the previous one is serving again"
    ;;
esac

git rev-parse HEAD > "$MARKER"
say "deployed $(git rev-parse --short HEAD); marker updated"
