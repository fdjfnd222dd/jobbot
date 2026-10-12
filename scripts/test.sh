#!/usr/bin/env bash
# scripts/test.sh: jobbot's test runner. Every run takes one shared lock, so two agents (or a test run and a
# job-hunt browser check) never run the suite at once on this 8 GB laptop.
#
#   bash scripts/test.sh                  fast: every test file, tests named "[slow]" skipped
#   bash scripts/test.sh all              the full suite, "[slow]" tests included
#   bash scripts/test.sh brief queue      only the files whose name contains these words (tests/brief.test.js ...)
#   bash scripts/test.sh tests/x.test.js  one file by path
#
# Output: the summary counts, and on failure only the first lines of each failing test (not every passing name).
# Lock file: $JOBBOT_TEST_LOCK if set, else $XDG_RUNTIME_DIR/jobbot-test.lock (/tmp without XDG_RUNTIME_DIR).
# A run waits up to 15 minutes for the lock.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

# One lock path for every caller (agents, hooks, the owner), so concurrent runs really queue up.
LOCK="${JOBBOT_TEST_LOCK:-${XDG_RUNTIME_DIR:-/tmp}/jobbot-test.lock}"

MODE=fast
FILES=()
if [ $# -eq 0 ] || [ "$1" = fast ]; then
  FILES=(tests/*.test.js)
elif [ "$1" = all ] && [ $# -eq 1 ]; then
  MODE=all
  FILES=(tests/*.test.js)
else
  MODE=pick
  for arg in "$@"; do
    if [ -f "$arg" ]; then
      FILES+=("$arg")
      continue
    fi
    matches=(tests/*"$arg"*.test.js)
    if [ ! -f "${matches[0]}" ]; then
      echo "test.sh: no test file matches \"$arg\"" >&2
      exit 2
    fi
    FILES+=("${matches[@]}")
  done
fi

# A named file runs in full even when it has [slow] tests: asking for it by name means asking for all of it.
SKIP=()
if [ "$MODE" = fast ]; then SKIP=(--test-skip-pattern='\[slow\]'); fi

exec 9>"$LOCK" || { echo "test.sh: cannot open the lock file $LOCK" >&2; exit 1; }
if ! flock -w 900 9; then
  echo "test.sh: another test run holds $LOCK (waited 15 min); try again" >&2
  exit 1
fi

OUT="$(mktemp)"
START=$(date +%s)
# TAP goes to a file, so the screen gets the counts and the failures only.
node --test --test-concurrency=1 --test-reporter=tap ${SKIP[@]+"${SKIP[@]}"} "${FILES[@]}" >"$OUT" 2>&1
CODE=$?
END=$(date +%s)

grep -E '^# (tests|suites|pass|fail|cancelled|skipped|todo) ' "$OUT"
echo "test.sh: $MODE, ${#FILES[@]} file(s), $((END - START))s, exit $CODE"
if [ "$CODE" -ne 0 ]; then
  echo "--- failing tests (first lines of each) ---"
  # Per failure: the name, where it is, and the first lines of its error (not the stack).
  awk '
    /^ *not ok /            { print; inblk = 1; left = 0; next }
    inblk && /^ +location:/ { print; next }
    inblk && /^ +error:/    { print; left = ($0 ~ /[|]-$/) ? 4 : 0; next }
    left > 0 && /^    /     { print; left--; next }
    { left = 0 }
    /^ *(ok|# Subtest)/     { inblk = 0 }
  ' "$OUT" | head -120
fi
rm -f "$OUT"
exit "$CODE"
