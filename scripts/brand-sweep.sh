#!/usr/bin/env bash
# brand-sweep.sh — exhaustive DMhub→GMhub rebrand audit.
#
# WHY THIS EXISTS
#   Earlier rebrand sweeps grepped only for the marketing spelling `DMhub`
#   (case-sensitive) inside `src/**`. That missed five whole classes of
#   reference, which is why DMhub kept surfacing (e.g. in Resend emails):
#     1. Case/separator variants:  DMHUB, dmhub, dm-hub, dm_hub, "DM Hub"
#     2. Identifiers in code:       dmhub_pat_, dmhubClient, etc.
#     3. Non-`src` surfaces:        migrations, *.sql run-books, .mcp.json,
#                                   docs, .env*, CI config
#     4. Immutable historical refs: JIRA ticket IDs `DMHUB-123`, already-
#                                   applied migration comments (must NOT change)
#     5. Out-of-repo runtime config the repo CAN'T see (see RUNTIME note below)
#
#   This script catches every in-repo variant and *buckets* them so you can
#   tell an actionable brand leak from an immutable ticket ID at a glance.
#
# USAGE
#   scripts/brand-sweep.sh            # human-readable, grouped report
#   scripts/brand-sweep.sh --ci       # exit 1 if any ACTIONABLE leak remains
#
# Run it from the root of either repo (gmhub-app or gmhub-vtt).

set -euo pipefail

CI_MODE=0
[[ "${1:-}" == "--ci" ]] && CI_MODE=1

# Case-insensitive match for the brand in any separator form: DMhub, DMHUB,
# dmhub, dm-hub, dm_hub, "DM Hub", DmHub. Deliberately does NOT match "D&D" /
# "dndbeyond" (the third-party game system) nor the bare TTRPG role "Dungeon
# Master" — those are not our brand. (Run --roles for an advisory pass over
# "Dungeon Master" role copy that a rename to "Game Master" might also touch.)
PATTERN='dm[-_ ]?hub'

# Pathspecs to ignore: vendored code, lockfiles, and raw third-party data
# fixtures (D&D Beyond dumps — minified single-line JSON that is not ours to
# edit). Everything else — migrations, sql, docs, dotfiles, CI — is in scope.
EXCLUDES=(
  ':!*.lock' ':!*-lock.json' ':!package-lock.json'
  ':!pnpm-lock.yaml' ':!yarn.lock' ':!node_modules/**'
  ':!**/__fixtures__/**'
)

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
hr()   { printf '%.0s─' {1..72}; printf '\n'; }

# Pull every matching line once; classify in awk.
matches="$(git grep -nI -E -i "$PATTERN" -- "${EXCLUDES[@]}" 2>/dev/null || true)"

if [[ -z "$matches" ]]; then
  bold "✓ No DMhub references found in tracked files."
  exit 0
fi

# Classify each "path:line:content" hit into a bucket.
#   TICKET     — JIRA id DMHUB-<n>; immutable history, do NOT rewrite
#   MIGRATION  — under prisma/migrations/; applied SQL is immutable
#   EXTERNAL   — names an out-of-repo resource (Vercel team slug, a local
#                clone path); rename in the dashboard/filesystem, not here
#   ACTIONABLE — a real in-repo brand leak that should become GMhub
classify() {
  awk -F: -v OFS=: '
    {
      path=$1; rest=$0;
      line=tolower(rest);
      # Uppercase DMHUB is the JIRA project/ticket key (DMHUB-12, "DMHUB
      # project") — immutable history, never the brand wordmark.
      if (rest ~ /DMHUB/)                               { print "TICKET",    rest; next }
      if (path ~ /prisma\/migrations\//)                { print "MIGRATION", rest; next }
      if (line ~ /dm-hub-team|c:\\\\users|\.mcp\.json/) { print "EXTERNAL",  rest; next }
      print "ACTIONABLE", rest;
    }' <<< "$1"
}

classified="$(classify "$matches")"

print_bucket() {
  local key="$1" title="$2"
  local rows; rows="$(grep "^${key}:" <<< "$classified" | sed "s/^${key}://" || true)"
  local n; n="$(printf '%s' "$rows" | grep -c . || true)"
  hr; bold "$title  ($n)"
  [[ "$n" -gt 0 ]] && printf '%s\n' "$rows" || echo "  (none)"
}

bold "DMhub → GMhub brand sweep — $(basename "$(pwd)")"
print_bucket ACTIONABLE "⚠  ACTIONABLE — in-repo brand leaks to fix"
print_bucket EXTERNAL   "↗  EXTERNAL — rename in dashboard/filesystem, not in code"
print_bucket TICKET     "•  HISTORICAL JIRA IDs — immutable, leave as-is"
print_bucket MIGRATION  "•  APPLIED MIGRATIONS — immutable, leave as-is"

hr
cat <<'NOTE'
RUNTIME / OUT-OF-REPO SURFACES this script CANNOT see — verify manually:
  • Vercel env var  EMAIL_FROM   (the Resend "From:" line — most likely
    source of DMhub in delivered email; code default is already GMhub)
  • Vercel env var  APP_URL / NEXT_PUBLIC_APP_URL
  • Resend dashboard: verified sending domain + sender display name
  • Vercel project / team slug, DNS records, OAuth app names
NOTE

actionable_n="$(grep -c '^ACTIONABLE:' <<< "$classified" || true)"
if [[ "$CI_MODE" -eq 1 && "$actionable_n" -gt 0 ]]; then
  exit 1
fi
exit 0
