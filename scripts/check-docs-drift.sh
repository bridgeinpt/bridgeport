#!/bin/bash
# Docs drift check — run as a Claude Code Stop hook.
#
# Flags when user-facing code paths have changed (uncommitted + commits ahead of
# master) without a corresponding docs/ update. Prints a reminder to stderr so
# the transcript shows it, but never fails — this is advisory, not a gate.
#
# Heuristics:
#   * "Code-ish" paths: src/routes, src/services, prisma/schema.prisma, ui/src/pages,
#     bridgeport-agent, cli
#   * "Docs-ish" paths: docs/** or CLAUDE.md
#
# Compares to origin/master when available, else the current HEAD.

set -u

# Only run inside a git repo
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

# Find the base ref to diff against. Prefer origin/master; fall back to master; fall back to HEAD.
BASE_REF=""
for candidate in origin/master master; do
  if git rev-parse --verify --quiet "$candidate" >/dev/null 2>&1; then
    BASE_REF="$candidate"
    break
  fi
done
BASE_REF="${BASE_REF:-HEAD}"

# Collect changed files: committed-since-base plus uncommitted (staged + unstaged).
changed=$(
  {
    git diff --name-only "$BASE_REF" 2>/dev/null
    git diff --name-only HEAD 2>/dev/null
    git ls-files --others --exclude-standard 2>/dev/null
  } | sort -u
)

if [ -z "$changed" ]; then
  exit 0
fi

code_changed=$(echo "$changed" | grep -E '^(src/routes/|src/services/|prisma/schema\.prisma|ui/src/pages/|bridgeport-agent/|cli/)' || true)
docs_changed=$(echo "$changed" | grep -E '^(docs/|CLAUDE\.md$)' || true)

if [ -n "$code_changed" ] && [ -z "$docs_changed" ]; then
  {
    echo ""
    echo "────────────────────────────────────────────────────────────"
    echo " Docs drift reminder"
    echo "────────────────────────────────────────────────────────────"
    echo " Code changed without any docs/ update. Consider updating:"
    echo "   - docs/guides/*.md for new user-facing features"
    echo "   - docs/reference/*.md for API / settings / CLI changes"
    echo ""
    echo " Changed code paths:"
    echo "$code_changed" | sed 's/^/   - /'
    echo "────────────────────────────────────────────────────────────"
  } >&2
fi

exit 0
