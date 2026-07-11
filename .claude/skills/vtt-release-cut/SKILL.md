---
name: vtt-release-cut
description: Use when cutting a new gmhub-vtt-bridge release. Walks the 4-step manual release ritual from CLAUDE.md §7 in the right order — bump module.json#version FIRST, then tag and push, then add docs/EPICS.md row. Encodes the v0.4.1 → v0.4.2 re-tagging lesson so it can't recur.
allowed-tools: Read, Edit, Bash, Grep
---

# vtt-release-cut

CLAUDE.md §6: **"Bump `module.json#version` BEFORE tagging
mid-release fixes. Re-tagging the same version doesn't trigger
Foundry's update flow (lesson from v0.4.1 → v0.4.2)."**

CLAUDE.md §7 documents the manual release ritual. This skill makes
it impossible to do out of order.

## Steps

1. **Confirm working tree is clean** on `main` (or the release
   branch). If not, abort.
2. **Read the current `module.json#version`** and ask the user for
   the next version. Default by bumping the patch (`0.4.4` → `0.4.5`).
   Confirm before proceeding.
3. **Edit `module.json`:**
   - Bump `version`
   - Update `manifest` and `download` URLs if they embed the version
     (check the current values before editing — some manifests use
     `latest` indirection, in which case leave them).
4. **Verify nothing else is dirty.** Show the diff of
   `module.json` for confirmation.
5. **Commit** the version bump with message
   `chore: bump module.json to vX.Y.Z`. Do NOT tag yet.
6. **Tag and push:**
   ```
   git tag vX.Y.Z
   git push origin main
   git push origin vX.Y.Z
   ```
   The `release.yml` workflow builds `module.zip` + versioned
   `module.json` on tag push.
7. **Append a row to `docs/EPICS.md`** describing the release.
   Match the existing column format. Commit with message
   `docs: log vX.Y.Z release`.
8. **Update CLAUDE.md §1** "Current version" to the new value.
   Bundle this into the same commit as the EPICS row.
9. **Push** the docs commit.

## Anti-patterns (re-tagging lesson)

- **Never** run `git tag -f vX.Y.Z` after the tag has been pushed.
  Foundry caches manifests by version; the update flow only fires
  when the version string changes.
- If you need a mid-release fix after a tag has shipped, bump the
  version (e.g. `0.4.1` → `0.4.2`), tag the bump, and push. Do NOT
  rewrite or move the prior tag.
- Never bump the version in a commit that also ships product changes
  — keep the bump in its own commit so the release log is readable.

## Pre-release verification

Before step 6 (tag and push), surface to the user:
- [ ] `module.json#compatibility` still matches reality (v11–v14)
- [ ] `module.json#system` constraint still matches reality
- [ ] No new external runtime deps snuck into `module.json#esmodules`
- [ ] `lang/en.json` parses (run `node -e "JSON.parse(require('fs').readFileSync('lang/en.json','utf8'))"`)
- [ ] If `/api/v1` shape changed since the last release, `api-client.js`
  was updated and the `docs/SISTER_REPO.md` "wire format detail"
  section is current.
