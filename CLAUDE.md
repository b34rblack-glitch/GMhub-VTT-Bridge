# GMhub-VTT-Bridge — Claude Code Context

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
| Repo | `github.com/b34rblack-glitch/GMhub-VTT-Bridge` |
| Sister repo | `github.com/b34rblack-glitch/GMhub-app` (web app; tracks this repo as Epic G; owns the `/api/v1` surface as Epic E) |
| Module ID | `gmhub-vtt-bridge` |
| Current version | `0.6.1` |
| Foundry compat | v11 minimum, v14 verified, v14 maximum |
| System | `dnd5e` ≥ 3.0.0 |
| Manifest URL | `https://github.com/b34rblack-glitch/GMhub-VTT-Bridge/releases/latest/download/module.json` |

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
  - **Windowed session pull (v0.4.0; recap count GM-configurable in v0.5.0).** `listSessions` filtered client-side to: prep + running + the `sessionRecapCount` most-recently-ended sessions (default 1). Orphans deleted on Pull unless they carry unpushed dirty edits — and cleanup is skipped entirely when the session-list fetch fails.
- Either side changes the contract → the other side's `docs/EPICS.md` gets a follow-up row.

## 4. Current Focus

> **Update this section at the start of every new release.**

`v0.7.0` closed **GMV-7**, an Agenda Editor hardening-then-feature pass over `AgendaEditorDialog` (`scripts/ui.js`) and `templates/agenda-editor.hbs`, with no wire-format change (so `docs/SISTER_REPO.md` and the `/api/v1` contract are untouched — Save already persisted the whole row object to the structured `agendaItems`/`pinnedRefs` flags). Hardening first: (1) a `pending` re-entrancy guard on Save (mirroring `VisibilityDialog`) so a double-click can't fire two overlapping `setFlag`/`update` sequences; (2) the up/down/remove row buttons gain localized `aria-label`s (their `<i>` `aria-hidden`) and 44px touch targets. Then the feature on that hardened base: a per-scene entity-link picker — an "Add entity" button opens a kind-grouped `<select>` of **already-pulled** entities and renders removable chips against the canonical `entities:[{id,name,entityType}]` (camelCase) shape, sourced by a new exported `listPulledEntities()` in `sync.js`; and the pinned row's brittle free-text `entity_id`/`entity_type` inputs are replaced by the same single-select picker (writing the snake `entity_id`/`entity_type`/`name` shape, with a "(not pulled)" fallback option that preserves a stored link that isn't in the current pull). Both round-trip through Push/Pull and render as content-links. (GMV-7 was planned as `v0.6.0`; re-versioned to `v0.7.0` during rebase because GMV-12 and GMV-4 landed `v0.6.0`/`v0.6.1` on the same base first.)

`v0.6.1` (shipped just before, on the same base) closed **GMV-4**, the player-mapping resolver — a consumer-side UI pass with no wire-format change: `PlayerMapDialog` is extended in place with per-row status badges (`mapped`/`unmapped`/`stale`/`departed`), unique-name auto-suggest (pre-selected only), inline Clear, and a departed/stale synthetic-option round-trip; the Pull-time `GMHUB.Warn.UnmappedRecipients` toast becomes a clickable `notifyClickable` toast that opens the resolver; and a latent setup-wizard bug is fixed (the dialog now honors `options.onSubmit` and an `options.campaignId` override). AC3 ownership (`computePageOwnership`) is unchanged — resolved mappings apply on the next Pull.

`v0.6.0` (same base) closed **GMV-12**, also a consumer-side UI pass with no wire-format change: the copy-pasted promise-wrapped confirm-dialog idiom is extracted into one module-scope `confirmViaDialog(DialogClass, props)` helper in `ui.js` (all three call sites rewritten on it), and a new `PrePushReviewDialog` **supersedes** `PushPreviewDialog` as the single Push confirm-gate — a grouped dirty-state dashboard with click-through per-entry inspection plus a read-only visibility-drift group; `total` is unchanged so the `total==0` empty state is preserved, and `PushPreviewDialog` + `templates/push-preview.hbs` + its CSS/i18n are retired.

Next on deck (recommendation): **GMV-5** (ApplicationV2 migration).

No active release branch.

## 5. Known Issues & Tech Debt

| Priority | Issue | Notes |
|---|---|---|
| 🟡 Med | ApplicationV1 deprecation | ApplicationV1 still functional in v14 but officially deprecated. Sync dialog + editors (incl. `AgendaEditorDialog` and the extended `PlayerMapDialog`) are V1; migration tracked as GMV-5, still deferred. |
| 🟢 Low | Clickable-toast DOM binding is version-fragile | `notifyClickable` (`sync.js`) resolves the rendered notification `<li>` to attach its click handler. The v13+ `Notification.element` path is doc-confirmed and verified on v14; the v11/12 `#notifications [data-id]` fallback is best-effort and unverified. On any unrecognized DOM shape the toast degrades to non-clickable (never throws) — re-test the binding on every Foundry minor. |
| 🟢 Low | Stale-mapping preservation leans on a synthetic `<select>` option | `PlayerMapDialog` renders a synthetic selected option carrying the raw id for stale / departed-stale rows so `_updateObject`'s from-scratch rebuild round-trips them. If that option is ever dropped from `player-map.hbs`, an unrelated Save silently drops those keys — keep the synthetic-option render whenever the union/departed rows change. |
| 🟢 Low | Cross-campaign session journals can leak through Push | Switching campaigns leaves the old campaign's session journals in Foundry until the next Pull's orphan cleanup. |
| 🟢 Low | Eye toggle is buffered, not immediate | Per `SCOPE.md` "Manual sync only." Eye click maps to `flags.gmhub-vtt-bridge.visibility` and waits for the next Push. |
| 🟢 Low | i18n shim depends on Foundry's internal `_loc()` reading from `game.i18n.translations` | v0.4.3 mutates `translations` directly; the JS-level localize/format patches handle direct callers. If a future Foundry release moves `_loc()` to a different store, re-test on every Foundry minor. |
| 🟢 Low | No automated tests | Foundry modules don't have an established test runner. |
| 🟢 Low | Bearer token stored in world settings (GM-visible) | Acceptable for a single-GM workflow; revisit if the module ever supports multiple GMs sharing one world. |

## 6. Coding Conventions

- **Plain ES modules** — no bundler, no transpile.
- **No external runtime deps** — keep `module.json#esmodules` to files in this repo.
- **Foundry hook discipline** — register hooks in `main.js`'s `init`/`ready` blocks.
- **Stable IDs via flags** — every journal we sync stores `flags.gmhub-vtt-bridge.externalId`. Re-syncs key off this; never look up by name.
- **Bearer token in `world` scope** — settings registered with `scope: "world"`, `config: true`; only the GM sees the input.
- **Manual sync only.** Per `SCOPE.md`. (`autoPushOnUpdate` is the explicit opt-in escape hatch.)
- **Foundry content-links** — emit raw `<a class="content-link" data-uuid="<page.uuid>" draggable="true">` markup directly. Foundry recognises this DOM shape on every supported version.
- **Bump module.json#version BEFORE tagging mid-release fixes.** Re-tagging the same version doesn't trigger Foundry's update flow (lesson from v0.4.1 → v0.4.2).
- **i18n surface is layered.** v0.4.3 mutates `game.i18n.translations`; v0.3.4 patches `game.i18n.localize`/`format`. Both stay — they cover different code paths (`_loc()` template helper vs. direct JS calls). Adding new lang keys: just edit `lang/en.json`, the i18nInit hook merges + patches at world load.

## 7. Useful Commands

```bash
# Local install
git clone https://github.com/b34rblack-glitch/GMhub-VTT-Bridge.git "$FOUNDRY_DATA/modules/gmhub-vtt-bridge"

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
