#!/usr/bin/env bash
# PreToolUse hook: enforce CLAUDE.md §0 Documentation Contract on commit.
#
# Blocks:
#   1. New top-level *.md files outside the canonical set
#      (README.md, SCOPE.md, CLAUDE.md)
#   2. New audits/* paths or AUDIT_REPORT.md anywhere
#
# docs/ supplementary files (EPICS.md, SISTER_REPO.md,
# integration-test.md, etc.) are allowed without a whitelist.

set -euo pipefail

input="$(cat)"

tool_name="$(printf '%s' "$input" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
[ "$tool_name" = "Bash" ] || exit 0

command="$(printf '%s' "$input" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p')"
case "$command" in
  *"git commit"*) ;;
  *) exit 0 ;;
esac

if ! git -C "${CLAUDE_PROJECT_DIR:-.}" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

added="$(git -C "${CLAUDE_PROJECT_DIR:-.}" diff --cached --name-only --diff-filter=A)"
[ -n "$added" ] || exit 0

violations=""

while IFS= read -r f; do
  [ -z "$f" ] && continue

  case "$f" in
    *AUDIT_REPORT.md|*audit_report.md)
      violations="$violations\n  $f  (forbidden: audit reports go in PR descriptions, not files)"
      continue
      ;;
  esac

  case "$f" in
    audits/*|*/audits/*)
      violations="$violations\n  $f  (forbidden: audits/ directory is not part of the doc contract)"
      continue
      ;;
  esac

  case "$f" in
    */*) ;;
    *.md|*.MD)
      case "$f" in
        README.md|SCOPE.md|CLAUDE.md) ;;
        *)
          violations="$violations\n  $f  (forbidden: only README.md, SCOPE.md, CLAUDE.md allowed at top level)"
          ;;
      esac
      ;;
  esac
done <<EOF
$added
EOF

if [ -z "$violations" ]; then
  exit 0
fi

printf '[check-doc-contract] BLOCKED: documentation contract violations:\n' >&2
printf '%b\n' "$violations" >&2
cat >&2 <<'EOF'

See CLAUDE.md §0 Documentation Contract. The canonical files are:
  README.md, SCOPE.md, CLAUDE.md, docs/EPICS.md, docs/SISTER_REPO.md

One-shot reports (audits, reviews, design notes) belong in PR
descriptions or inline conversation, not committed Markdown.
EOF
exit 2
