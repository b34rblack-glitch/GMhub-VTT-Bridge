# Sister Repository — GMhub App

> The web application this Foundry module syncs with.
> Repo: https://github.com/b34rblack-glitch/GMhub-app
> Tracked there as **Epic G — Foundry VTT Module** (currently planned).
> Owns the `/api/v1` REST surface this module consumes (**Epic E — shipped 2026-05-08**).

---

## What it is

`gmhub-app` is the GMhub web application — a TTRPG campaign-management product running at https://gmhub.app. It hosts:

- The Postgres-backed canonical store of campaigns, sessions, entities, notes.
- The `/api/v1` REST surface this module consumes (live spec at https://gmhub.app/docs).
- The bearer-token issuance UI used for module configuration (`/account/api-tokens`).

For its full vision and shipped-feature log, see that repo's `README.md` and `docs/EPICS.md`.

---

## Cross-repo contract

The two projects are coupled through one thing only: the `/api/v1` REST surface, **owned by `gmhub-app`** under Epic E (shipped 2026-05-08).

### Ownership

- **`gmhub-app` owns the API surface.** Endpoint shapes, request/response payloads, auth model, and token issuance are all defined there. Live spec at https://gmhub.app/docs.
- **`gmhub-vtt` (this repo) owns its consumption side and its scope.** What we sync (content types, push/pull semantics, conflict policy) is documented in [`../SCOPE.md`](../SCOPE.md). The wire format mirrors what Epic E exposes.

### Auth

Per-GM personal access tokens issued at `gmhub-app/account/api-tokens` (format `gmhub_pat_<43>`), sent as `Authorization: Bearer <token>`. The token model is owned by `gmhub-app` (Epic E).

### Wire format pinpoints

- **Rich-text fields** (`entity.summary`, `note.body`, `session_plan.gm_notes`, `session_plan.gm_secrets`) are Tiptap ProseMirror-JSON server-side. Pull renders to HTML via `tiptapToHtml` in `scripts/sync.js`. Push sends HTML; **`gmhub-app` normalizes HTML → Tiptap-JSON server-side on the `/api/v1` PATCH routes** (jsdom + `@tiptap/html.generateJSON`, shipped 2026-05-09 — closes GMV-6, see [`docs/EPICS.md`](EPICS.md) Reconciliation).
- **Pinned shape** carries optional `pin_reason: string | null` (server-side shipped 2026-05-09); v0.4.1+ renders it.
- **Visibility ride-along.** Per-page eye icon (`page.ownership.default`) reverse-maps to `visibility`: `NONE` → `gm_only`, `OBSERVER` → `campaign`. Written via `flags.gmhub-vtt.visibility`, pushed on the next manual Push (or immediately when `autoPushOnUpdate` is on).

### Pull render fidelity

On Pull, `tiptapToHtml` walks the Tiptap-JSON tree and emits HTML through two private helpers in `scripts/sync.js`. The node and mark types they currently handle are:

| Tiptap node | Aliases | HTML output | Notes |
|---|---|---|---|
| `doc` | — | (children only) | Root; no wrapper element |
| `paragraph` | — | `<p>…</p>` | Empty paragraph → `<p>&nbsp;</p>` |
| `heading` | — | `<h1>`–`<h6>` | `attrs.level` clamped to 1–6, default 1 |
| `text` | — | escaped text + marks | `_escapeHtml` then `_applyMarks` |
| `hardBreak` | `hard_break` | `<br>` | |
| `horizontalRule` | `horizontal_rule` | `<hr>` | |
| `bulletList` | `bullet_list` | `<ul>…</ul>` | |
| `orderedList` | `ordered_list` | `<ol>…</ol>` | |
| `listItem` | `list_item` | `<li>…</li>` | |
| `blockquote` | — | `<blockquote>…</blockquote>` | |
| `codeBlock` | `code_block` | `<pre><code>…</code></pre>` | |
| `mention` | — | `<span class="gmhub-mention" data-entity-type="…" data-entity-id="…">@label</span>` | attrs escaped; label = `attrs.label ?? attrs.id` |

| Tiptap mark | HTML output | Notes |
|---|---|---|
| `bold` | `<strong>…</strong>` | |
| `italic` | `<em>…</em>` | |
| `underline` | `<u>…</u>` | |
| `strike` | `<s>…</s>` | |
| `code` | `<code>…</code>` | |
| `link` | `<a href="…" rel="noopener noreferrer">…</a>` | href escaped, defaults to `#` |

An unrecognised node type currently renders its children only, with no wrapper element. An unrecognised mark is currently dropped silently — the text still renders, just unstyled. The source of truth for both tables is `_nodeToHtml` and `_applyMarks` in `scripts/sync.js`; keep this section in sync with them.

### Rules of engagement

- **`gmhub-app` makes the call on shape changes.** If they change a payload, this module's `api-client.js` follows; bump `module.json#version` for any consumer-facing change.
- **This repo makes the call on scope.** If the set of content types we sync (or the push/pull semantics) changes, edit `SCOPE.md` first, then open a follow-up in `gmhub-app/docs/EPICS.md`.
- Both repos keep their `docs/EPICS.md` in sync at the cross-link points (Epic E / Epic G there ↔ GMV-* here).

## When to update this file

- The ownership of the API surface changes (e.g., this repo takes over part of it).
- The auth model changes (e.g., from bearer-token to OAuth).
- The set of repos in the ecosystem changes (e.g., a third repo joins).
- The wire format pinpoints above change in a way that requires module-side awareness.

Otherwise, leave this file alone — endpoint detail belongs in `gmhub-app`'s code/docs, scope detail belongs in this repo's `SCOPE.md`.
