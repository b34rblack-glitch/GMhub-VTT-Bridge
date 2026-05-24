# GMhub-VTT — Claude Code Context

> Foundry VTT module that two-way-syncs Journal Entries with the GMhub web app.
> Keep this file under 180 lines. Update §4 "Current Focus" at the start of each
> new release. Everything else is stable reference.

## 0. Documentation Contract

Five files are the canonical documentation. Keep them in sync on every PR that ships:

1. **`README.md`** — landing page. Vision, status snapshot, install/config; defers to other docs for detail.
2. **`SCOPE.md`** — durable product scope and intent. **Edit only when scope itself changes.**
3. **`docs/EPICS.md`** — append-only shipped-feature log + open backlog. **Add a row when any feature ships;** never edit historical rows.
4. **`CLAUDE.md`** *(this file)* — update §4 "Current Focus" at release start; update §5 "Known Issues" when you fix or add tech debt.
5. **`docs/SISTER_REPO.md`** — only edit when the cross-repo contract with `gmhub-app` changes.

**Do not create new top-level Markdown files** beyond these five.

When the user asks for an "audit" or "review", deliver findings inline in the conversation or as a PR description — not as a checked-in file.

## 1. Project Identity

| Key | Value |
|---|---|
| Repo | `github.com/b34rblack-glitch/GMhub-VTT` |
| Sister repo | `github.com/b34rblack-glitch/GMhub-app` (web app; tracks this repo as Epic G; owns the internal `/api/v1` surface as Epic E — first-party only, no public docs) |
| Module ID | `gmhub-vtt` |
| Current version | `0.4.6` (per `module.json`; latest tag is `v0.4.4` — re-tag pending) |
| Foundry compat | v11 minimum, v14 verified, v14 maximum |
| System | `dnd5e` ≥ 3.0.0 |
| Manifest URL | `https://github.com/b34rblack-glitch/GMhub-VTT/releases/latest/download/module.json` |

## 2. Repo Structure

Top-level documentation (the five canonical files from §0):

```
README.md                # Landing page (vision + install + status)
SCOPE.md                 # Durable product scope/intent (read first)
CLAUDE.md                # This file (agent guardrails)
docs/EPICS.md            # Append-only shipped-feature log + backlog
docs/SISTER_REPO.md      # Cross-repo contract with gmhub-app
.github/
  pull_request_template.md
  CODEOWNERS
```

Source layout:

```
module.json              # Foundry manifest
scripts/
  main.js                # Module entry; hooks; v14 i18n shim (translations merge + localize/format patch)
  api-client.js          # REST client: ping, list, get, create, update; bearer auth
  sync.js                # Push/pull orchestration; windowed session pull; tiptapToHtml; pinned-card render
  ui.js                  # Sync dialog, session pick, push preview, agenda editor
styles/
  gmhub.css              # Module-specific UI styling
templates/               # Handlebars templates for the sync dialog
lang/
  en.json                # i18n strings
```

No build step — the module is plain ES modules loaded by Foundry directly.

## 3. Cross-repo contract (with `gmhub-app`)

This module is coupled to `gmhub-app` through exactly one surface: the `/api/v1` REST endpoints exposed under **Epic E — Public API & Foundry Foundations** in `gmhub-app` (shipped 2026-05-08). Despite the historical epic name, the API is **internal**: this module is its only sanctioned consumer (closed 2026-05-26 — see `gmhub-app/SCOPE.md` § Out of scope).

- **`gmhub-app` owns the API surface.** Endpoint shapes, auth model, and token issuance all live there.
- **This module owns its consumption side and its scope.** What we sync (content types, push/pull semantics, conflict policy) is documented in `SCOPE.md`.
- **No public docs.** There is no OpenAPI spec endpoint, no Swagger UI, no developer quickstart. If you need a reference for a wire-format detail, look at `docs/SISTER_REPO.md` on the gmhub-app side.
- **Wire format detail:**
  - `entity.summary`, `note.body`, `session_plan.gm_notes`, `session_plan.gm_secrets` are Tiptap ProseMirror-JSON. Pull renders to HTML via `tiptapToHtml` in `sync.js`. **Push sends HTML; `gmhub-app` normalizes HTML → Tiptap-JSON server-side on the `/api/v1` PATCH routes** (jsdom + `@tiptap/html.generateJSON`, shipped 2026-05-09 — closes GMV-6).
  - `session_plan.agenda` is opaque JSON server-side; canonical Scene shape `{ id, title, notes, entities: [{id, name, entityType}], estimated_duration_min, order, ticked }`.
  - **Pinned shape:** `{ entity_id, entity_type, name, staged_at, position, pin_reason? }`. Server-side `pin_reason` shipped in `gmhub-app` 2026-05-09; v0.4.1+ renders it.
  - **Unified visibility (v0.4.6, mirrors `gmhub-app` 0016).** `visibility` is the 3-value enum `private` / `shared` / `everyone`; `shared` rows carry a `recipients[]` of GMhub user IDs. `sync.js#computePageOwnership({visibility, recipients})` maps to `JournalEntryPage.ownership`: `private` → `{default:NONE, gm:OWNER}`; `everyone` → `{default:OBSERVER, gm:OWNER}`; `shared` → `{default:NONE, gm:OWNER, [mapped Foundry user]:OBSERVER}` using the `playerMap` world setting (GMhub user ID → Foundry user ID, edited via Module Settings → Configure player mapping). Per-page eye toggle still works locally but is not synced back; canonical write path from inside Foundry is the per-page `VisibilityDialog` (context-menu "Edit visibility…"). Players never authenticate with GMhub — only the GM does.
  - **Windowed session pull (v0.4.0).** `listSessions` filtered client-side to: prep + most-recent ended + running. Orphans deleted on Pull unless they carry unpushed dirty edits.
- Either side changes the contract → the other side's `docs/EPICS.md` gets a follow-up row.

## 4. Current Focus

> **Update this section at the start of every new release.**

`module.json#version` is at **0.4.6** in tree but the latest pushed tag is
`v0.4.4` — cut the tag (see §7 ritual) before the unified-visibility work
reaches end users.

- **v0.4.6 (in tree, untagged) — Unified Visibility (PR #27, mirrors
  `gmhub-app` 0016).** Replaces the legacy 4-value visibility model with the
  consolidated 3-value `{private, shared, everyone}` enum plus a per-row
  `recipients[]` allowlist. New `sync.js#computePageOwnership({visibility,
  recipients})` is the single mapper to Foundry `JournalEntryPage.ownership`.
  New world setting `playerMap` (GMhub user ID → Foundry user ID) with a
  FormApplication submenu ("Configure player mapping"). New per-page
  `VisibilityDialog` (context-menu "Edit visibility…") replaces the legacy
  RevealMenuDialog and writes via the consolidated PATCH `/notes/{id}`
  (followups for entities/sessions). `api-client.js` gains `getPlayers`,
  `setNoteVisibility`, `setEntityReveal`, `setNotePlayerReveal`.
- **v0.4.4 (last tagged) — PushPreviewDialog per-session breakdown
  (GMV-9).** When more than one session journal is dirty, the dialog lists
  the affected session journal names in a `<details>` block.
- **GMV-6 (Push HTML ↔ Tiptap round-trip) closed server-side** via
  `gmhub-app` PR #64 (2026-05-09): the `/api/v1` PATCH routes for entities,
  notes, and session plans normalize HTML → Tiptap-JSON via jsdom +
  `@tiptap/html.generateJSON` before persistence. This module's existing
  HTML-emitting Push path round-trips losslessly without a code change here;
  verified end-to-end with the Senna Blackwater NPC test on 2026-05-09.

No active release branch. Next on deck (recommendation): tag and ship v0.4.6,
then pick up **GMV-7** (AgendaEditor entity-link UI) or **GMV-5**
(ApplicationV2 migration).

## 5. Known Issues & Tech Debt

| Priority | Issue | Notes |
|---|---|---|
| 🟡 Med | AgendaEditorDialog can't add/edit per-scene entity links | Existing scenes preserve `entities` on push; the editor has no UI to attach/detach links. Tracked as GMV-7. |
| 🟡 Med | ApplicationV1 deprecation | ApplicationV1 still functional in v14 but officially deprecated. Sync dialog + editors are V1; migration deferred to v0.5+. |
| 🟢 Low | Cross-campaign session journals can leak through Push | Switching campaigns leaves the old campaign's session journals in Foundry until the next Pull's orphan cleanup. |
| 🟢 Low | Eye toggle is buffered, not immediate; canonical writer is `VisibilityDialog` | Per `SCOPE.md` "Manual sync only." Local eye toggle is GM-only convenience and is not synced back to GMhub — the canonical write path from inside Foundry is the per-page context-menu "Edit visibility…" entry. |
| 🟢 Low | `shared` ownership requires a configured `playerMap` | If a pulled row's `recipients` reference a GMhub user ID with no mapping, Pull emits one warning and that user gets no ownership grant. GM must seed `playerMap` via Module Settings → Configure player mapping. |
| 🟢 Low | i18n shim depends on Foundry's internal `_loc()` reading from `game.i18n.translations` | v0.4.3 mutates `translations` directly; the JS-level localize/format patches handle direct callers. If a future Foundry release moves `_loc()` to a different store, re-test on every Foundry minor. |
| 🟢 Low | No automated tests | Foundry modules don't have an established test runner. |
| 🟢 Low | Bearer token stored in world settings (GM-visible) | Acceptable for a single-GM workflow; revisit if the module ever supports multiple GMs sharing one world. |

## 6. Coding Conventions

- **Plain ES modules** — no bundler, no transpile.
- **No external runtime deps** — keep `module.json#esmodules` to files in this repo.
- **Foundry hook discipline** — register hooks in `main.js`'s `init`/`ready` blocks.
- **Stable IDs via flags** — every journal we sync stores `flags.gmhub-vtt.externalId`. Re-syncs key off this; never look up by name.
- **Bearer token in `world` scope** — settings registered with `scope: "world"`, `config: true`; only the GM sees the input. `playerMap` is also `world` scope, edited via the `playerMapMenu` FormApplication submenu.
- **Single ownership mapper.** All four sync paths (entities, notes, sessions, pull-of-shared rows) compute `JournalEntryPage.ownership` through `sync.js#computePageOwnership({visibility, recipients})`. Do not inline the visibility → ownership branches anywhere else; new visibility cases go in the mapper.
- **Manual sync only.** Per `SCOPE.md`. (`autoPushOnUpdate` is the explicit opt-in escape hatch.)
- **Foundry content-links** — emit raw `<a class="content-link" data-uuid="<page.uuid>" draggable="true">` markup directly. Foundry recognises this DOM shape on every supported version.
- **Bump module.json#version BEFORE tagging mid-release fixes.** Re-tagging the same version doesn't trigger Foundry's update flow (lesson from v0.4.1 → v0.4.2). The `/vtt-release-cut` skill walks this in order.
- **i18n surface is layered.** v0.4.3 mutates `game.i18n.translations`; v0.3.4 patches `game.i18n.localize`/`format`. Both stay — they cover different code paths (`_loc()` template helper vs. direct JS calls). Adding new lang keys: just edit `lang/en.json`, the i18nInit hook merges + patches at world load.

## 7. Useful Commands

```bash
# Local install
git clone https://github.com/b34rblack-glitch/GMhub-VTT.git "$FOUNDRY_DATA/modules/gmhub-vtt"

# Cut a release (manual)
# 1. Bump module.json#version FIRST
# 2. Tag and push:  git tag v0.X.Y && git push origin v0.X.Y
# 3. Add release row in docs/EPICS.md
# 4. release.yml builds module.zip + versioned module.json on tag push
```

## 8. Claude Code Tips for This Repo

- The module is small (~1500 LOC across 4 JS files); whole-file reads are fine.
- Always read `module.json` first when editing — the `esmodules`/`styles`/`languages` arrays gate what Foundry loads.
- **Read `SCOPE.md` before agreeing to a feature.** Or invoke `/scope-gate`,
  which does it for you. If a request would cross an out-of-scope line,
  surface that explicitly rather than implementing.
- **Project skills live in `.claude/skills/`** — invoke with `/<name>`:
  - `/scope-gate` — runs before agreeing to non-trivial features.
  - `/vtt-release-cut` — walks the 4-step manual release ritual (§7) in the
    right order, encoding the v0.4.1 → v0.4.2 re-tagging lesson.
- **Pre-commit hook** `.claude/hooks/check-doc-contract.sh` blocks `git
  commit` if a new top-level `*.md` outside the canonical three (or an
  `audits/` path / `AUDIT_REPORT.md`) is staged.
- Foundry's API is undocumented in `node_modules`; reference docs live at https://foundryvtt.com/api/v14/ — fetch live if needed.
- When `gmhub-app` changes the `/api/v1` surface (Epic E), this module's `api-client.js` follows. Bump `module.json#version` for any consumer-facing change.
- **Don't create `AUDIT_REPORT.md` or `audits/` files.** See §0 Documentation Contract.
