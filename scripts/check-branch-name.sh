#!/bin/sh
# check-branch-name.sh — validates that a branch name starts with a Jira issue key.
#
# Called two ways:
#   sh check-branch-name.sh              # no arg: checks the current repo's branch
#   sh check-branch-name.sh "$BRANCH"    # arg given (e.g. from CI): checks that string
#
# Config — override via env vars, no need to edit this file:
#   BRANCH_CHECK_PROJECT_KEY_PATTERN   default: [A-Z][A-Z0-9]*  (matches NR, ABC, etc.)
#   BRANCH_CHECK_EXEMPT_BRANCHES       default: "main master develop" (space-separated)
#
# Exit 0 = ok (conforms, or exempt). Exit 1 = blocked, with a message explaining why and
# a valid example. No dependencies beyond POSIX sh + git.

set -eu

PROJECT_KEY_PATTERN="${BRANCH_CHECK_PROJECT_KEY_PATTERN:-[A-Z][A-Z0-9]*}"
EXEMPT_BRANCHES="${BRANCH_CHECK_EXEMPT_BRANCHES:-main master develop}"

BRANCH="${1:-}"
if [ -z "$BRANCH" ]; then
  BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || echo "")"
fi

if [ -z "$BRANCH" ]; then
  # Detached HEAD, or not in a repo at all — nothing to validate, don't block.
  exit 0
fi

for exempt in $EXEMPT_BRANCHES; do
  if [ "$BRANCH" = "$exempt" ]; then
    exit 0
  fi
done

if ! printf '%s' "$BRANCH" | grep -Eq "^${PROJECT_KEY_PATTERN}-[0-9]+"; then
  echo "" >&2
  echo "✗ Branch name '${BRANCH}' doesn't start with a Jira issue key." >&2
  echo "  Expected pattern: ^${PROJECT_KEY_PATTERN}-[0-9]+ (e.g. NR-12345-short-description)" >&2
  echo "  Exempt branches: ${EXEMPT_BRANCHES}" >&2
  echo "" >&2
  exit 1
fi

exit 0
