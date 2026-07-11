# GMhub VTT Bridge

> Bring your [GMhub](https://www.GMhub.app/) campaign to the table — right inside Foundry VTT.

GMhub VTT Bridge syncs your GMhub campaign content into Foundry as journal entries, and sends your table-side work back when the session is done. Prep in GMhub, run the game in Foundry, and keep one source of truth for your campaign canon — no more copy-pasting notes between two apps.

**A GMhub account is required.** Get one at [GMhub.app](https://www.GMhub.app/).

---

## What you get

- **Your codex in Foundry.** Pull your NPCs, Locations, Factions, Items, Quests, and Lore into Foundry journals, along with your long-form notes and upcoming session plans.
- **Session journals, ready to run.** Each planned session becomes its own journal with your agenda, GM notes, and pinned entities rendered as clickable cards that link straight to the full entry.
- **Capture at the table, file it later.** Edits, new entries, and quick notes you jot down during play are pushed back to GMhub with one click — attached to the right session.
- **Player visibility that follows your prep.** Content you mark **Everyone** in GMhub is visible to your players in Foundry; **Shared** content reaches only the players you chose; **Private** stays GM-only.
- **You stay in control.** Sync is manual — nothing moves until you press **Pull** or **Push**. (An optional auto-push setting is there if you want edits sent immediately.)

## What it does *not* do

The module syncs journal-shaped content only. It does not touch Foundry's Scenes, Actors, combat tracker, or compendiums, and it does not import maps, player characters, encounters, or GMhub's AI features. Foundry stays canonical for running the game; GMhub stays canonical for your campaign archive.

---

## Requirements

| | |
|---|---|
| Foundry VTT | v11 – v14 (verified on v14) |
| Game system | D&D 5e (dnd5e) 3.0 or newer |
| GMhub | An account and a campaign at [GMhub.app](https://www.GMhub.app/) |

Only the GM connects to GMhub — your players never need a GMhub account.

## Installation

In Foundry: **Add-on Modules → Install Module**, then paste this manifest URL:

```
https://github.com/b34rblack-glitch/GMhub-VTT-Bridge/releases/latest/download/module.json
```

Enable **GMhub VTT Bridge** in your world's module settings.

## Setup

You'll need two things from GMhub:

1. **A personal access token** — create one at **Account → API tokens** in GMhub. The token starts with `GMhub_pat_` and is shown only once, so copy it right away.
2. **Your campaign ID** — open your campaign in GMhub and copy the ID from the URL (`/campaigns/<id>`).

Then in Foundry, go to **Game Settings → Configure Settings → GMhub VTT Bridge**:

| Setting | What it does |
|---|---|
| GMhub Base URL | Where your GMhub lives. Leave the default unless you self-host. |
| GMhub Personal Access Token | The token from step 1. Only the GM can see this field. |
| GMhub Campaign ID | The campaign this Foundry world syncs with — one world, one campaign. |
| Recap sessions to keep | How many recently-ended sessions stay in Foundry after a Pull (default 1). Older recaps remain on GMhub. |
| Auto-push journal updates | Optional. Sends every journal edit to GMhub immediately instead of waiting for Push. Off by default. |
| Player mapping | Match each GMhub player to their Foundry user so **Shared** content reaches the right people. |

## Using it

Open the **GMhub Sync** button in Foundry's Journal sidebar. From there you can test the connection, **Pull** the latest from GMhub, **Push** your table-side changes back, and start, pause, or end the live session.

- **Pull** fills in six codex journals (one per entity type), a Notes journal, and a **GMhub Sessions** folder with one journal per upcoming or recent session.
- Right-click a session journal and choose **Set as active session** to tell the module which session your quick notes belong to.
- To change who can see something from inside Foundry, right-click the page and choose **Edit visibility…** — the change syncs back to GMhub on your next Push.

A note on conflicts: sync is deliberately simple — the direction you press wins. Pull overwrites Foundry with GMhub's version; Push overwrites GMhub with Foundry's. If you edit the same entry in both places between syncs, whichever button you press decides which version survives.

## Getting help

- Found a bug or have a request? [Open an issue](https://github.com/b34rblack-glitch/GMhub-VTT-Bridge/issues).
- Curious about the module's design and roadmap? See [`SCOPE.md`](SCOPE.md) and [`docs/EPICS.md`](docs/EPICS.md).
