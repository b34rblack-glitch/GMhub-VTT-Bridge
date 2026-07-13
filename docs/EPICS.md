# GMhub-VTT-Bridge — Shipped Feature Log

> **The contract.** Append-only history of every release tagged in this repo.
> Module scope/intent lives in [`../SCOPE.md`](../SCOPE.md) — this file is the **changelog**; SCOPE is the **specification**.
> Sister-repo log: [`gmhub-app/docs/EPICS.md`](https://github.com/b34rblack-glitch/GMhub-app/blob/main/docs/EPICS.md)
> (cross-link upstream Epic E and Epic G).
>
> See `CLAUDE.md` §4 for the active focus and §0 for the full documentation contract.

## Releases

| Version | Tag | Summary |
|---|---|---|
| 0.1.0 | `v0.1.0` | Initial release. Two-way Journal sync (push/pull) with stable external IDs in journal flags. Per-journal context-menu action. Sync dialog from journal sidebar. Bearer-token auth with world-scoped GM-only settings. Manual sync only — no auto-push, no background polling. |
| 0.2.0 | `v0.2.0` | Epic E pulled. Module rewritten for the kind-journal mapping. Six entity-kind journals + Notes journal + per-active-session journal. Full E5/E6 client surface, `pullAll` / `pushAll`, `pendingPushQueue`, friendly error toasts, Test Connection, Pick-Session, ConfirmOverwrite. GitHub Actions `release.yml` ships `module.zip` + versioned `module.json` on every `v*` tag. |
| 0.3.0 | `v0.3.0` | Closes the v0.2.0 feature gaps: lifecycle buttons on SyncDialog, Push diff preview, Agenda & Pinned round-trip editor. `compatibility.maximum` bumped to `"13"`. |
| 0.3.1 | `v0.3.1` | Foundry v14 enablement. Manifest verified=14, maximum=14. |
| 0.3.2 | `v0.3.2` | v14 runtime hotfix #1. `renderJournalDirectory` hook signature fix; defensive `i18nInit` lang fetch. Companion CORS fix in `gmhub-app`. |
| 0.3.3 | `v0.3.3` | v14 hotfix #2. `tiptapToHtml` walker; journal sidebar re-render after lang merge. |
| 0.3.4 | `v0.3.4` | v14 hotfix #3. Patches `game.i18n.localize` and `game.i18n.format` directly with a fallback to a manually-fetched flat dictionary. |
| 0.3.5 | `v0.3.5` | Agenda fidelity. Per-scene `entities` chip render. CSS rule for `.gmhub-mention`. |
| 0.3.6 | `v0.3.6` | Per-page eye icon now reveals to GMhub. `updateJournalEntryPage` reverse-maps `ownership.default` to `visibility`. |
| 0.4.0 | `v0.4.0` | **Windowed multi-session pull.** Single-active-session expands to: prep + most-recent ended + running session each as their own JournalEntry under an auto-created `GMhub Sessions` folder. `activeSessionId` becomes a pointer; per-journal "Set as active session" context-menu action. Push fans out across all session journals. Pull orphans deleted unless dirty. SCOPE.md amended in 0.4.0-α. |
| 0.4.1 | `v0.4.1` | **Pinned page render + Handlebars helper re-register attempt.** Per-pin cards: type chip + clickable Foundry content-link + first-paragraph blurb. Per-scene entity chips on the Agenda page also become clickable content-links. Forward-compatible with cross-repo `pin_reason` (GMV-10). Late hotfix attempted to re-register Handlebars `{{localize}}` to pick up the v0.3.4 patch in templates — didn't take (Foundry re-registers later in lifecycle). |
| 0.4.2 | `v0.4.2` | **Forced republish of v0.4.1.** Foundry's update check compares `module.json#version`, not commit SHA, so retagging `v0.4.1` after the Handlebars hotfix didn't trigger Foundry to fetch the new zip. Pure version bump to make the hotfix reach installed worlds. Handlebars helper re-register from v0.4.1 still didn't fix the dialog labels (diagnostic in user F12 console showed the helper closes over a private `_loc()` that bypasses `game.i18n.localize`). |
| 0.4.3 | `v0.4.3` | **i18n finally takes.** Stops fighting `Handlebars.registerHelper` and instead mutates `game.i18n.translations` directly with the expanded form of the manually-fetched `lang/en.json`. Foundry's private `_loc()` reads from `translations` via `getProperty`, so once our keys are in there every `{{localize}}` template render finds them through the standard path. Per-key `foundry.utils.setProperty` is belt-and-suspenders in case `mergeObject` doesn't take. The localize/format JS-level patches stay for direct callers. |
| 0.4.4 | `v0.4.4` | **Push preview per-session breakdown (closes GMV-9).** When more than one session journal is dirty, the PushPreviewDialog now surfaces a `<details>` block listing the affected session journal names. The aggregated `sessionPlanLabel` row above tells the GM *which fields* will be pushed; this list tells them *which sessions* are affected. New i18n key `GMHUB.Dialog.PushPreview.SessionPlanJournalsList`. Drive-by: doc-contract catch-up after the v0.4.1 → v0.4.3 i18n debugging cycle (CLAUDE.md §5 reflects the i18n trail and now-resolved "i18n patch surface keeps growing" debt). |
| 0.4.6 | `v0.4.6` | **Unified visibility model (0016).** Every content surface moves to one three-value model (`private` / `shared` / `everyone`) with a per-table recipient allowlist. `updateEntity`/`updateNote` carry `visibility` + `recipients` directly; the legacy per-field reveal helpers are gone. Foundry `JournalEntryPage.ownership` is computed per-Pull, including per-user OBSERVER for `shared` via the GM-managed `playerMap`. Per-page "Edit visibility…" context entry (VisibilityDialog). No `v0.4.5` was tagged — the version jumped 0.4.4 → 0.4.6 in one commit; backfilled here for an honest log. |
| 0.5.0 | `v0.5.0` | **Sync path robustness pass (GMV-11).** Three hardening changes on the sync surface, no wire-format change: (1) `GmhubClient._request` auto-retries a 429 exactly once (parsing `retryAfter` from the JSON body, capped at 60s; `>60` throws immediately) instead of only toasting; (2) the recap window becomes a GM-configurable `sessionRecapCount` world setting (default 1, reproducing prior single-recap behavior byte-for-byte) threaded through `computeSessionWindow`; (3) `pullAll` split into `_pullEntities`/`_pullNotes`/`_pullSessions`/`_cleanupOrphanSessions`, with orphan cleanup now **skipped when the session-list fetch fails** so a transient error no longer wipes the local session archive. |
| 0.6.0 | `v0.6.0` | **Pre-push review dashboard + `confirmViaDialog` extraction (GMV-12).** Consumer-side UI only, no wire-format change. Part 1: the copy-pasted promise-wrapped confirm-dialog idiom (construct dialog, track `resolved`, monkey-patch `close()` to resolve false, render) is extracted into one module-scope `confirmViaDialog(DialogClass, props)` helper in `ui.js` and all three call sites (lifecycle end, pull-overwrite, push) rewritten on it; a provably-dead `dialog.options.callbacks` line is dropped. Part 2: a new `PrePushReviewDialog` **supersedes** `PushPreviewDialog` as the single Push confirm-gate — a grouped dirty-state dashboard (entities create/update, notes create/update, quick-note queue, per-session plan edits) with counts and click-through per-entry inspection (`fromUuidSync`, null-guarded), plus a **read-only visibility-drift** group surfacing local eye-toggle changes Push won't send back. Fed by an extended internal `previewPush()` shape (per-entry `uuid`; `sessionPlanJournals` → `[{name,uuid}]`; new `visibilityDrift` bucket); `total` is unchanged (drift excluded), so the `total==0` "nothing to push" empty state is byte-for-byte preserved. Retires `PushPreviewDialog`, `templates/push-preview.hbs`, and its CSS/i18n. Drift compares *effective* Foundry ownership levels against the flag-implied ownership (reusing `computePageOwnership`), excluding OWNER-holders on both sides so GM-id churn can't false-positive. |
| 0.6.1 | `v0.6.1` | **Player-mapping resolver (GMV-4).** Turns the passive Pull-time "unmapped recipients" warning into an actionable resolver, no wire-format change. (Re-versioned from 0.6.0 to 0.6.1 during rebase — GMV-12 claimed 0.6.0 on the same base.) `PlayerMapDialog` is extended in place to list every GMhub campaign player with a per-row status badge (`mapped` / `unmapped` / `stale` / `departed`), auto-suggest a Foundry user by unique case-insensitive `display_name`→`user.name` match (pre-selected only, never auto-persisted — the GM confirms by Saving), and Clear a stale/departed mapping inline. Row set is the UNION of current players and departed `playerMap` keys, with a synthetic `<select>` option round-tripping stale ids so an unrelated Save never silently drops them. The Pull-time `GMHUB.Warn.UnmappedRecipients` toast becomes a permanent, clickable toast (`notifyClickable`) that opens the resolver — bound cross-version via the v13+ `Notification.element` or the v11/12 `#notifications [data-id]` fallback, excluding the close control and degrading to non-clickable without throwing. Also fixes a latent setup-wizard bug: the mapping dialog now honors `options.onSubmit` and an `options.campaignId` override, so configuring the mapping mid-wizard flows into the saved config. AC3 ownership (`computePageOwnership`) is unchanged — resolved mappings apply on the next Pull. |

## Open backlog

(Mirrors the README "Roadmap" section. Add tickets here as they're pulled into a release branch.)

| ID | Title | Notes |
|---|---|---|
| GMV-1 | Actor sync (5e sheets) | D&D 5e character sheets ↔ GMhub `player_characters`. Out of scope per current `SCOPE.md`. |
| GMV-2 | Scene / map import | Push Foundry scenes as `campaign_maps` rows in GMhub. Out of scope per current `SCOPE.md`. |
| GMV-3 | Webhook-driven live updates | Replace pull-on-demand with push notifications from `gmhub-app`. Out of scope per current `SCOPE.md` (manual-only). |
| GMV-5 | Migrate to ApplicationV2 | Sync dialog and editors use ApplicationV1, deprecated in v13+ but still functional in v14. |
| GMV-7 | AgendaEditor: add/edit per-scene entity links | Existing scenes preserve `entities` on push; the editor has no UI to attach/detach links. |
| GMV-8 | Manual fetch of older recaps | Outside the windowed pull, GMs may want one-off access to a specific past session. Tracked in `SCOPE.md` as open design decision #7. |

**Closed:**

- **GMV-4** — Player-mapping resolver for shared visibility. Closed in v0.6.0. The passive Pull-time unmapped-recipients warning becomes an in-place resolver on `PlayerMapDialog` (status badges, unique-name auto-suggest as pre-select-only, inline Clear, departed/stale synthetic-option round-trip) plus a clickable toast that opens it; also fixes the setup-wizard `onSubmit`/`campaignId` contract. Newly allocated in the GMV-3→GMV-5 gap; no wire-format change (`docs/SISTER_REPO.md` untouched).
- **GMV-6** — Push HTML ↔ Tiptap round-trip. **Closed 2026-05-09 server-side**, see Reconciliation below.
- **GMV-9** — PushPreviewDialog per-session breakdown. Closed in v0.4.4.
- **GMV-10** — Cross-repo pin reason. Server-side shipped in `gmhub-app` 2026-05-09; rendered by v0.4.1+.
- **GMV-11** — Sync path robustness pass. Closed in v0.5.0. Three items on the sync surface: 429 auto-retry in `GmhubClient._request`; GM-configurable session recap window (`sessionRecapCount`, default 1); and the `pullAll` split into per-resource steps with orphan cleanup skipped on a session-list-fetch failure. **Adjacency to open GMV-8** (manual fetch of older recaps): GMV-11's recap-window count only widens the *automatic* window; GMV-8 remains the intended escape hatch for one-off access to a specific session *outside* that window. Keep the two mechanisms distinct so they don't collide later.

## Upstream dependencies (in `gmhub-app`)

| Their Epic | Why it matters here |
|---|---|
| **Epic E — Public API & Foundry Foundations** *(shipped 2026-05-08)* | Owns the `/api/v1` REST surface this module consumes, plus personal-access-token issuance. |
| **Epic E follow-ups** *(shipped 2026-05-09)* | CORS for `/api/v1/*`, `pin_reason` schema + API + UI (GMV-10), Live/Recap parity tabs, server-side HTML→Tiptap normalization on PATCH (GMV-6), build script `prisma migrate deploy`. |
| **Epic G — Foundry VTT Module** *(planned)* | Their tracking of *this repo*. Bidirectional. |

## Reconciliation

If a feature lands in this module but isn't reflected in `gmhub-app`'s Epic G or vice-versa, log it here so the two logs can be synced on the next pass.

- **GMV-6 (Push HTML ↔ Tiptap)** closed server-side, not in this module. Resolved via `gmhub-app` PR #64 (2026-05-09): `/api/v1` PATCH routes for entities, notes, and session plans now normalize HTML → Tiptap-JSON via `@tiptap/html.generateJSON` (jsdom polyfill on Vercel). This module ships no code change; Push round-trips losslessly from v0.4.4 onward. Verified end-to-end with the Senna Blackwater NPC test on 2026-05-09. Build-pipeline follow-ups in `gmhub-app` PR #65 (pin `@tiptap/html@3.22.5` to dodge an ERESOLVE) and PR #66 (render `gm_secrets` client-side, since Turbopack disallows `react-dom/server` in App Router server components).
- **GMV-10 (cross-repo pin reason)** server-side shipped in `gmhub-app` PR #60 (schema migration + API + web UI). v0.4.1's render path was forward-compatible — no second module release needed.
