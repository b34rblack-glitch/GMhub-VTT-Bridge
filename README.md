# GMhub-VTT

> The Foundry VTT module that brings GMhub into the live game session.

A Foundry VTT module that two-way-syncs GMhub campaign content with Foundry **journals only** — no scenes, actors, or background sync. Built for Foundry v11–v14, D&D 5e system.

The durable product scope (mission, workflow position, in-scope / out-of-scope, behaviour contracts) lives in [`SCOPE.md`](./SCOPE.md). Read that first if you're trying to understand what this module is and isn't.

---

## Vision

GMhub's value lands at the table. This module extends that reach into the place a lot of GMs already run their game — Foundry — so journal-shaped content (session notes, NPC writeups, location lore) doesn't have to live in two places.

The wedge is intentionally narrow: **journals first, with stable IDs that survive re-syncs.** Actor sheets, scenes, and live websocket updates are explicitly out of scope (see [`SCOPE.md`](./SCOPE.md)).

For the parent product's vision and shipped-feature log, see the [`gmhub-app` README](https://github.com/b34rblack-glitch/GMhub-app#readme) and its [`docs/EPICS.md`](https://github.com/b34rblack-glitch/GMhub-app/blob/main/docs/EPICS.md).

---

## Sister project

| Repo | Role |
|---|---|
| [**`gmhub-app`**](https://github.com/b34rblack-glitch/GMhub-app) | The web application this module syncs with. Owns the `/api/v1` REST surface (Epic E). Tracks this repo as **Epic G**. |
| **`gmhub-vtt`** *(this repo)* | The Foundry module. |

For the cross-repo contract see [`docs/SISTER_REPO.md`](docs/SISTER_REPO.md).

---

## Status

| | |
|---|---|
| Module version | `0.4.4` |
| Foundry compatibility | v11–v14 (verified v14) |
| System | dnd5e ≥3.0 |
| Shipped feature log | [`docs/EPICS.md`](docs/EPICS.md) |
| Upstream dependency | `gmhub-app` Epic E — Public API & Foundry Foundations (✅ shipped 2026-05-08) |

The cross-repo end-to-end gate is the seventeen-step checklist in [`docs/integration-test.md`](docs/integration-test.md). Run it against a `gmhub-app` Vercel preview before cutting any release.

---

## What it does (target)

(See [`SCOPE.md`](SCOPE.md) for the full contract.)

- **Pull** the GMhub codex (NPCs, Locations, Factions, Items, Quests, Lore), long-form notes, and **a windowed slice of the session calendar** — all prep sessions + the most-recent recap + the running session if any — into Foundry as JournalEntries. Older recaps stay on the web app.
- **Push** GM table-side work back to GMhub: visibility flips, new entries, edits, quick-notes captured during play, and plan edits routed to whichever session journal carries the dirty page.
- **Manual** sync only. No live/background sync. The GM presses Pull or Push when they choose.
- **One world ↔ one campaign.** Set once in module settings.

## What it does NOT do

- Does not replace Foundry's native Scenes, Actors (D&D 5e sheets), combat tracker, or compendiums.
- Does not import maps, player characters, encounters, or AI features.
- Does not run sync in the background or mirror player-side actions.
- Does not import the full session history. Pull is windowed (prep + last recap + running). Older recaps remain on the web app.

---

## Installation (manifest URL)

```
https://github.com/b34rblack-glitch/GMhub-VTT/releases/latest/download/module.json
```

> Compatibility: Foundry v14 (verified), D&D 5e system 3.0+.

## Configuration

In Foundry: **Game Settings → Configure Settings → Module Settings → GMhub VTT**

| Setting        | What it does                                                |
|----------------|-------------------------------------------------------------|
| GMhub Base URL | Root URL of the GMhub-app deployment                        |
| GMhub API Key  | Bearer token used in `Authorization: Bearer …` (GM-only)    |
| Campaign       | Bound GMhub campaign for this Foundry world                 |
| Auto-push      | Optional. When on, every page edit (text, name, eye toggle) is pushed to GMhub immediately. Default off to honour the manual-sync contract. |

**Sync surface:** the **GMhub Sync** button in the Journal sidebar opens the dialog with Pull / Push / Test connection / Pick session / lifecycle controls. Pull populates a `GMhub Sessions` folder with one journal per windowed session; right-click any session journal → **Set as active session** to flip the lifecycle pointer. The session journal's **Pinned** page renders each pinned entity as a card with a clickable link into Foundry's full entity page.

## API contract

The module talks to the GMhub Public API tracked under **Epic E** in [`b34rblack-glitch/gmhub-app`](https://github.com/b34rblack-glitch/gmhub-app). The endpoint surface is **owned by that work** — not duplicated in this README — to keep one source of truth. See [`SCOPE.md`](./SCOPE.md) for the content types this module syncs and [`docs/SISTER_REPO.md`](docs/SISTER_REPO.md) for the cross-repo contract summary.

## Development

This is a plain-ES-modules Foundry module: **no build, no bundler, no transpile step.** Foundry loads `scripts/*.js` directly. The development loop is the whole story — side-load a working copy, edit, reload.

### The edit–reload loop

Clone (or symlink) a working copy straight into your Foundry data directory so Foundry loads your live checkout:

```bash
git clone https://github.com/b34rblack-glitch/GMhub-VTT.git "$FOUNDRY_DATA/modules/gmhub-vtt"
```

Then enable the module in your world. From there the entire cycle is:

1. Edit a file under `scripts/*.js` (or `styles/gmhub.css`, `lang/en.json`, `templates/`).
2. Reload the Foundry world.
3. Observe. Repeat.

There is nothing to compile — what you save is what Foundry runs.

### What `module.json` loads

Three arrays in `module.json` gate what Foundry actually loads at world start — a file that isn't listed simply doesn't run:

| Array | Points at | Purpose |
|---|---|---|
| `esmodules` | `scripts/main.js` | The single ES-module entry point. `main.js` imports the rest (`sync.js`, `ui.js`, `api-client.js`, `error-toaster.js`) — only the entry is listed here. |
| `styles` | `styles/gmhub.css` | Module CSS. |
| `languages` | `lang/en.json` | i18n string table. |

When you add a **new** script, style, or lang file, you must add it to the relevant array **and** make sure its directory is in the copy line that `release.yml` zips (`scripts styles templates lang`, plus `packs/` when present). The arrays and the zip are not a 1:1 mapping — `templates/` ships in the release zip but is referenced from JS (Handlebars), not gated by any manifest array — so keep both in mind: the array controls what Foundry loads, the zip controls what ships.

### Local testing

There is **no automated test runner** — Foundry modules have no established one here, and there is no `npm test`. Local testing is two things:

- **The reload loop above** — most changes are verified by editing and reloading the world.
- **The manual end-to-end gate**: [`docs/integration-test.md`](docs/integration-test.md), the cross-repo Epic-E roundtrip checklist. Run it against a `gmhub-app` Vercel preview (the checklist's prerequisite is a GMhub deployment; a preview works fine).

### Conventions that bite

A few load-bearing conventions — get these wrong and sync breaks in subtle ways:

- **Stable IDs via flags, never by name.** Every journal we sync stores `flags.gmhub-vtt.externalId`; re-syncs key off that flag, never off the entry's name. Renaming an entry in Foundry must not orphan it.
- **Manual sync only.** Nothing syncs in the background. The GM presses Pull or Push. The single opt-in escape hatch is the `autoPushOnUpdate` setting, which pushes each page edit immediately — off by default.
- **Content-links are raw DOM.** Emit Foundry content-links as literal `<a class="content-link" data-uuid="…" draggable="true">…</a>` markup. Foundry recognises this DOM shape on every supported version; don't hand-roll a different anchor shape.

## Cross-references

- [`SCOPE.md`](SCOPE.md) — durable product scope (mission, in-scope, out-of-scope, behaviour contracts).
- [`docs/EPICS.md`](docs/EPICS.md) — append-only release/feature log + open backlog.
- [`docs/SISTER_REPO.md`](docs/SISTER_REPO.md) — cross-repo contract with `gmhub-app`.
- [`CLAUDE.md`](CLAUDE.md) — agent guardrails for working in this repo.

Roadmap (high level; the full backlog lives in [`docs/EPICS.md`](docs/EPICS.md)):

- Actor sync (5e character sheets ↔ GMhub)
- Scene/map import
- Webhook-driven live updates instead of polling
- Manual fetch of older recaps outside the windowed pull (v0.5+)
