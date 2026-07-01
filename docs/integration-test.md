# Integration Test — Epic E end-to-end roundtrip

> Manual smoke test that exercises the full GMhub `/api/v1/*` ↔ Foundry
> module roundtrip. Runs before every release. The 21 steps below
> are the **cross-repo Epic-E definition-of-done**: changes on either side
> that alter the contract require updating this checklist.

## Prerequisites

- A GMhub deployment with **E1–E9 merged** to `main` (Vercel preview
  works fine).
- Foundry VTT v14 (the module's verified version; compat v11–v14) with the
  `dnd5e` system ≥ 3.0.0.
- A throwaway test user / campaign — this exercises destructive flows
  (revoking tokens, ending sessions).

## Setup

1. **Sign up** at the GMhub deployment. Verify email if required.
2. **Create a campaign** (`/campaigns/new`). Note the UUID from the URL.
3. **Create a session** in Prep state (`/campaigns/{id}/sessions` →
   "+ New session").
4. **Mint a token** at `/account/api-tokens` with **all eight scopes**
   checked (`campaigns:read`, `entities:{read,write}`, `notes:{read,write}`,
   `sessions:{read,write}`, `sessions:secrets`). Copy the plaintext (it's
   shown exactly once — losing it means starting over).
5. **Install the module** in a fresh Foundry world: download `module.zip`
   from the latest GitHub Release and unpack it into
   `$FOUNDRY_DATA/modules/gmhub-vtt`, or use Foundry's "Install Module
   from URL" with the manifest URL from the Release.
6. **Module Settings**: paste `baseUrl` (the GMhub deployment URL),
   `apiKey` (the `gmhub_pat_…` token), `campaignId` (the UUID from step 2).

## Connection

7. **Sync Dialog → Pick Prepped Session** → select the session from step
   3. The world's `activeSessionId` setting should populate.
8. **Sync Dialog → Test Connection**. Expect:

   ```
   ✓ Connected as user <uuid>
     scopes: campaigns:read, entities:read, …, sessions:secrets
   ```

   No warning line should appear — all eight scopes are present.

## Pull

9. **Sync Dialog → Pull**. Expect six kind-journals to appear in the
   Foundry sidebar (`NPCs`, `Locations`, `Factions`, `Items`, `Quests`,
   `Lore`), plus a `Notes` journal and a `Session: <session title>`
   journal.
10. **Open one entity that's `gm_only`** in GMhub. Open the corresponding
    page in the Foundry kind-journal. Switch to a non-GM Foundry login
    (or use the "View as player" preview) — the page should not appear
    in the journal sidebar.
11. **Open the session journal**. Confirm four pages: `GM Notes`,
    `Agenda`, `GM Secrets`, `Pinned`. Verify the `GM Secrets` page is
    GM-only (`{ default: NONE, [gmId]: OWNER }`).

## Live edits

12. **Edit one entity page** in Foundry (e.g., NPCs → "Goblin King").
    Save. Open `Hooks.callAll(\"updateJournalEntryPage\", …)` should have
    set `flags.gmhub-vtt.dirty = true` on the page.
13. **Capture a quick note** during play (chat command, sidebar button,
    or `game.modules.get("gmhub-vtt").api.sync.enqueueQuickNote("…")`).
14. **Edit the GM Notes page** in the session journal.
15. **Flip an entity's reveal** (set `flags.gmhub-vtt.revealedAt` via the
    page macro, or trigger via the future Reveal UI).
16. **Sync Dialog → Push**. Expect `pendingPushQueue` to drain (the
    quick note is consumed); the entity edit and reveal flip mirror to
    GMhub. Verify on GMhub:
    - `GET /api/v1/campaigns/{id}/entities/{externalId}` returns the
      edited summary.
    - `GET /api/v1/campaigns/{id}/sessions/{sessionId}/quick-notes` (or
      the session detail page on GMhub) shows the captured quick note.
    - The reveal banner / `revealed_at` timestamp is set.

## Lifecycle

17. **Try to start a session** twice. Inside Foundry, fire
    `client.transitionLifecycle(campaignId, sessionId, "start")` or use
    the Sync Dialog. The first call should succeed (returns a 200 with
    `started_at` set); the second should toast:

    > Another session is already running in this campaign. End it before
    > starting a new one.

    The 409 is the `withApiError` mapping of Prisma's P2002 from the
    `sessions(campaign_id) WHERE ended_at IS NULL` partial unique index.
18. **End the session from Foundry** via the lifecycle action. Verify
    `ended_at` is now populated on GMhub.

## Failure modes

19. **Revoke the token** in GMhub (`/account/api-tokens` → Revoke). Click
    Push again in Foundry. Expect:

    > GMhub rejected the token. Mint a new one at `/account/api-tokens`
    > and paste it into Module Settings.

20. **Mint a token without `sessions:secrets`** and paste it. Edit the
    GM Secrets page. Push. Expect the 403 toast naming
    `sessions:secrets`.
21. **Trip the rate limit** (only run if you have a way to fire 700
    requests in a minute — typically a script outside Foundry; skip in
    routine release verification). Expect a 429 toast with a
    `retry-after` value.

## Recording the run

When the 21 steps pass, record in the PR description:

```
Integration test run by <name> on <date> against <GMhub URL>.
Module: v<x.y.z>, Foundry: v14.<patch>, dnd5e: <version>.
All steps passed.
```

If any step fails, file a follow-up ticket and link it from the PR; don't
merge a release that breaks the cross-repo gate.
