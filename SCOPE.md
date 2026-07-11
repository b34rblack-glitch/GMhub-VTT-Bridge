# GMhub-VTT-Bridge — Project Scope

**Status:** Draft baseline — 2026-05-07 · amended 2026-05-08 (windowed multi-session pull, v0.4.0-α) · amended 2026-05-11 (unified visibility model, v0.4.6) · amended 2026-07-10 (GM-configurable recap window, v0.5.0)
**Canonical home:** `b34rblack-glitch/GMhub-VTT-Bridge/SCOPE.md`

This document captures the agreed intent for the GMhub-VTT-Bridge Foundry module.

## Mission

GMhub-VTT-Bridge is a Foundry VTT module that lets a GM run a live tabletop session inside Foundry while keeping their GMhub campaign as the canonical archive of campaign content.

Sync is **explicit and manual**: the GM presses **Pull** to load GMhub content into Foundry, and **Push** to send their table-side work back.

## Workflow position

```
GMhub (webapp)                          Foundry VTT
┌──────────────┐                       ┌──────────────┐
│  PREP        │                       │              │
│  - codex     │ ── Pull ─────────────▶│  LIVE        │
│  - notes     │                       │  - codex     │
│  - plan      │                       │  - notes     │
│              │                       │  - plan      │
│              │                       │  - reveals   │
│  RECAP       │ ◀─────────── Push ───│  - new ents  │
│  - quick-nts │                       │  - quick-nts │
│  - reveals   │                       │              │
└──────────────┘                       └──────────────┘
```

## In scope

### Sync model
- Manual push/pull buttons in Foundry; no background sync.
- 1 Foundry world ↔ 1 GMhub campaign (set once in module settings).
- Conflict policy: **direction wins**. Pull overwrites Foundry. Push overwrites GMhub.

### Content types pulled from GMhub
- **Entities** (NPCs, Locations, Factions, Items, Quests, Lore) — the codex.
- **Long-form notes** (GMhub `notes` table).
- **Session plans (windowed)** — all sessions in `prep`, the running session if any, and the most-recently-ended session(s) — a GM-configurable count (default 1) set via the `sessionRecapCount` module setting.

### Content types pushed back from Foundry
- **Visibility changes** on any GMhub-linked item.
- **New entries** created in Foundry.
- **Text edits** to existing entity/note content.
- **Quick notes** captured during play.
- **Session lifecycle events** (start/pause/resume/end).
- **Plan edits to any pulled session.**

### Foundry-side representation
- GMhub entities → **one JournalEntry per entity_kind**, six journals total.
- GMhub notes → their own `Notes` JournalEntry with one page per note.
- Pulled session plans → **one JournalEntry per session** under an auto-created `GMhub Sessions` folder.

### Visibility

**0016 (Unified Visibility model, v0.4.6):** every content surface (notes, entities, sessions, timeline events, map pins, relationships) uses one three-value model on the gmhub-app side:

- `private` — author only.
- `shared` — author + named recipients (the per-table allowlist on gmhub-app).
- `everyone` — everyone in the campaign.

The module translates this into Foundry's `JournalEntryPage.ownership` per-Pull:

- `private` → `{ default: NONE, [gm]: OWNER }`.
- `shared` → `{ default: NONE, [gm]: OWNER, [mapped Foundry users]: OBSERVER }`.
- `everyone` → `{ default: OBSERVER, [gm]: OWNER }`.

The `shared` path requires a GM-managed mapping from GMhub user id to Foundry user id, stored in the `playerMap` world setting and edited via Module Settings → Configure player mapping. Players themselves still never authenticate with GMhub — only the GM does.

The per-page eye toggle in the Foundry sidebar still works locally but is not synced back; the canonical way to change visibility / recipients from inside Foundry is the per-page context-menu "Edit visibility…" entry (the VisibilityDialog), which calls the consolidated PATCH `/notes/{id}` (and follow-ups for entities/sessions) with `{ visibility, recipients }`.

### Session lifecycle
- GM can start/pause/resume/end the live session from either side.
- When started from Foundry, the GM picks an existing prepped session from a GMhub list.
- Active session in Foundry is independent of which session journals are present.

## Out of scope

| Out of scope                                     | Why                                                                 |
|--------------------------------------------------|---------------------------------------------------------------------|
| Maps → Foundry Scenes                            | Foundry Scenes are richer than GMhub maps.                          |
| Player characters → Foundry Actors               | Foundry's D&D 5e Actor sheet is canonical.                          |
| Live/realtime sync, websockets, webhooks         | Manual push/pull is the intended UX.                                |
| Player Foundry users authenticating with GMhub   | Only the GM client authenticates; the playerMap translates ids.     |
| Non-GM-driven syncs                              | All sync is GM-initiated.                                           |
| Encounter builder, AI assistant, Stripe          | Not module concerns.                                                |
| Full session history in Foundry                  | Pull is windowed.                                                   |

## Behaviour contracts

### Pull
1. GM clicks **Pull from GMhub** in the Journal sidebar.
2. Module fetches campaign metadata, all entities, all notes (with their `recipients` allowlists), and the session window.
3. Module reconciles into the six kind-journals + Notes journal + per-session journals.
4. Foundry permissions reset to match GMhub visibility for each item — including per-user ownership for `shared` content.
5. If any pulled row references a GMhub user id not in `playerMap`, Pull emits one warning listing the missing ids.
6. **Orphan handling** for session journals: outside-window sessions are deleted unless they carry unpushed dirty edits.

### Push
1. GM clicks **Push to GMhub**.
2. Module collects everything dirty and sends edits / new entries / visibility changes / quick-notes / plan edits in one batch.
3. GMhub responds with assigned IDs for new rows; the module writes those back into Foundry flags.

### Quick notes
- Foundry has a quick-capture surface available during a live session.
- Notes are queued in Foundry world flags.
- On push, queued notes are sent as `quick_notes` rows attached to the active session.

## Cross-references

- **GMhub-app**: `docs/SISTER_REPO.md` is the webapp-side mirror of this scope.
- **Module relies on**: `entities`, `notes`, `session_plan`, `quick_notes`, `sessions`, and the per-table `*_player_reveals` allowlists.
