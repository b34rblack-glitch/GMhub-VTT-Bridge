# GMhub-VTT — Claude Code Context

> Foundry VTT module that two-way-syncs Journal Entries with the GMhub web app.
> Keep this file under 140 lines. Update §4 "Current Focus" at the start of each
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
| Sister repo | `github.com/b34rblack-glitch/GMhub-app` (web app; tracks this repo as Epic G; owns the `/api/v1` surface as Epic E) |
| Module ID | `gmhub-vtt` |
| Current version | `0.4.6` |
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

This module is coupled to `gmhub-app` through exactly one surface: the `/api/v1` REST endpoints exposed under **Epic E — Public API & Foundry Foundations** in `gmhub-app` (shipped 2026-05-08).

- **`gmhub-app` owns the API surface.** Endpoint shapes, auth model, and token issuance all live there.
- **This module owns its consumption side and its scope.** What we sync (content types, push/pull semantics, conflict policy) is documented in `SCOPE.md`.
- **Wire format detail:**
  - `entity.summary`, `note.body`, `session_plan.gm_notes`, `session_plan.gm_secrets` are Tiptap ProseMirror-JSON. Pull renders to HTML via `tiptapToHtml` in `sync.js`. **Push sends HTML; `gmhub-app` normalizes HTML → Tiptap-JSON server-side on the `/api/v1` PATCH routes** (jsdom + `@tiptap/html.generateJSON`, shipped 2026-05-09 — closes GMV-6).
  - `session_plan.agenda` is opaque JSON server-side; canonical Scene shape `{ id, title, notes, entities: [{id, name, entityType}], estimated_duration_min, order, ticked }`.
  - **Pinned shape:** `{ entity_id, entity_type, name, staged_at, position, pin_reason? }`. Server-side `pin_reason` shipped in `gmhub-app` 2026-05-09; v0.4.1+ renders it.
  - **Visibility ride-along.** Foundry's per-page eye icon (`page.ownership.default`) reverse-maps to `visibility`: `NONE` → `gm_only`, `OBSERVER` → `campaign`.
  - **Windowed session pull (v0.4.0).** `listSessions` filtered client-side to: prep + most-recent ended + running. Orphans deleted on Pull unless they carry unpushed dirty edits.
- Either side changes the contract → the other side's `docs/EPICS.md` gets a follow-up row.

## 4. Current Focus

> **Update this section at the start of every new release.**

`v0.4.4` closed GMV-9 (PushPreviewDialog per-session breakdown when more than one session journal is dirty). **GMV-6 (Push HTML ↔ Tiptap round-trip) closed server-side** via `gmhub-app` PR #64 (2026-05-09): the `/api/v1` PATCH routes for entities, notes, and session plans now normalize HTML bodies to Tiptap-JSON via jsdom + `@tiptap/html.generateJSON` before persistence. This module's existing Push path — which sends HTML — round-trips losslessly without a code change here; verified end-to-end with the Senna Blackwater NPC test on 2026-05-09. No active backlog item breaks documented behaviour. Next on deck (recommendation): **GMV-7** (AgendaEditor entity-link UI) or **GMV-5** (ApplicationV2 migration).

No active release branch.

## 5. Known Issues & Tech Debt

| Priority | Issue | Notes |
|---|---|---|
| 🟡 Med | AgendaEditorDialog can't add/edit per-scene entity links | Existing scenes preserve `entities` on push; the editor has no UI to attach/detach links. Tracked as GMV-7. |
| 🟡 Med | ApplicationV1 deprecation | ApplicationV1 still functional in v14 but officially deprecated. Sync dialog + editors are V1; migration deferred to v0.5+. |
| 🟢 Low | Cross-campaign session journals can leak through Push | Switching campaigns leaves the old campaign's session journals in Foundry until the next Pull's orphan cleanup. |
| 🟢 Low | Eye toggle is buffered, not immediate | Per `SCOPE.md` "Manual sync only." Eye click maps to `flags.gmhub-vtt.visibility` and waits for the next Push. |
| 🟢 Low | i18n shim depends on Foundry's internal `_loc()` reading from `game.i18n.translations` | v0.4.3 mutates `translations` directly; the JS-level localize/format patches handle direct callers. If a future Foundry release moves `_loc()` to a different store, re-test on every Foundry minor. |
| 🟢 Low | No automated tests | Foundry modules don't have an established test runner. |
| 🟢 Low | Bearer token stored in world settings (GM-visible) | Acceptable for a single-GM workflow; revisit if the module ever supports multiple GMs sharing one world. |

## 6. Coding Conventions

- **Plain ES modules** — no bundler, no transpile.
- **No external runtime deps** — keep `module.json#esmodules` to files in this repo.
- **Foundry hook discipline** — register hooks in `main.js`'s `init`/`ready` blocks.
- **Stable IDs via flags** — every journal we sync stores `flags.gmhub-vtt.externalId`. Re-syncs key off this; never look up by name.
- **Bearer token in `world` scope** — settings registered with `scope: "world"`, `config: true`; only the GM sees the input.
- **Manual sync only.** Per `SCOPE.md`. (`autoPushOnUpdate` is the explicit opt-in escape hatch.)
- **Foundry content-links** — emit raw `<a class="content-link" data-uuid="<page.uuid>" draggable="true">` markup directly. Foundry recognises this DOM shape on every supported version.
- **Bump module.json#version BEFORE tagging mid-release fixes.** Re-tagging the same version doesn't trigger Foundry's update flow (lesson from v0.4.1 → v0.4.2).
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

- The module is small (~1000 LOC across 4 JS files); whole-file reads are fine.
- Always read `module.json` first when editing — the `esmodules`/`styles`/`languages` arrays gate what Foundry loads.
- **Read `SCOPE.md` before agreeing to a feature.** If a request would cross an out-of-scope line, surface that explicitly rather than implementing.
- Foundry's API is undocumented in `node_modules`; reference docs live at https://foundryvtt.com/api/v14/ — fetch live if needed.
- When `gmhub-app` changes the `/api/v1` surface (Epic E), this module's `api-client.js` follows. Bump `module.json#version` for any consumer-facing change.
- **Don't create `AUDIT_REPORT.md` or `audits/` files.** See §0 Documentation Contract.
