// =============================================================================
// scripts/main.js
// =============================================================================
//
// GMhub VTT Bridge — module entry point.
//
// PURPOSE:
//   This file is what Foundry loads first (listed in module.json's
//   `esmodules`). It wires together every other script:
//     - Registers world settings (base URL, API key, campaign id, ...).
//     - Loads Handlebars templates and registers helpers.
//     - Installs the i18n shim that backfills `lang/en.json` into
//       Foundry's translation store on v14.
//     - Constructs the GmhubClient + SyncService singletons at `ready`.
//     - Attaches Foundry hooks for journal-directory rendering,
//       context-menu entries, and dirty-flag tracking on updates.
//
// PUBLIC SURFACE (via `game.modules.get(MODULE_ID).api`):
//   - client, sync                  -> singletons for other modules / macros
//   - openDialog(), openPickSession() -> entry points for the UI
//   - openAgendaEditor(page)        -> direct deep-link into agenda editor
//   - openPlayerMap()               -> GM-only player slot mapping submenu
//   - openVisibilityDialog(page)    -> per-page visibility editor (0016)
//
// 0016 (Unified Visibility):
//   The per-page eye-toggle reverse-mapper in `updateJournalEntryPage`
//   is gone. The VisibilityDialog (context-menu entry on every synced
//   note page) is the canonical way to change visibility/recipients
//   now; Foundry's native eye toggle still works locally but won't be
//   pushed back to GMhub.
// =============================================================================

// Singletons + UI surface from the other scripts in this module.
import { GmhubClient } from "./api-client.js";
import { SyncService } from "./sync.js";
import {
  openAgendaEditorForPage,
  openVisibilityDialogForPage,
  PickSessionDialog,
  PlayerMapDialog,
  SyncDialog
} from "./ui.js";
import { SetupWizardDialog } from "./setup-wizard.js";

// Canonical module id — matches module.json#id and is the namespace for
// every flag, setting, and template path in this codebase.
export const MODULE_ID = "gmhub-vtt-bridge";

// -----------------------------------------------------------------------------
// _refreshActiveSessionUI()
// -----------------------------------------------------------------------------
// Re-render any UI that depends on `activeSessionId`. Called from the
// setting's `onChange` so picking a new session in PickSessionDialog
// immediately re-highlights the sidebar row and refreshes the sync
// dialog header without a full reload.
// -----------------------------------------------------------------------------
function _refreshActiveSessionUI() {
  // Guard against being called before Foundry has set up `ui` (very
  // early in the boot path on first session).
  if (typeof ui === "undefined") return;
  // Re-render the journal sidebar so renderJournalDirectory can
  // re-apply the `.gmhub-active-session` class to the new entry.
  ui.journal?.render?.(false);
  // Re-render any open SyncDialog so its "Active session" line
  // reflects the new id immediately.
  for (const win of Object.values(ui.windows ?? {})) {
    if (win?.constructor?.name === "SyncDialog") win.render?.(false);
  }
}

// -----------------------------------------------------------------------------
// init hook — runs once at world boot, before any world data is ready.
// Used here to register settings and load template HTML.
// -----------------------------------------------------------------------------
Hooks.once("init", () => {
  // Base URL of the gmhub-app deployment. World-scoped so all clients
  // talk to the same server; defaults to the production URL.
  game.settings.register(MODULE_ID, "baseUrl", {
    name: "GMHUB.Settings.BaseUrl.Name",
    hint: "GMHUB.Settings.BaseUrl.Hint",
    scope: "world", config: true, type: String,
    default: "https://gmhub.app"
  });
  // Bearer API key (world-scoped so only the GM sees the input field
  // in the settings UI — `config: true` exposes it to the settings
  // dialog, but Foundry shows world-scoped strings to GMs only).
  game.settings.register(MODULE_ID, "apiKey", {
    name: "GMHUB.Settings.ApiKey.Name",
    hint: "GMHUB.Settings.ApiKey.Hint",
    scope: "world", config: true, type: String, default: ""
  });
  // The GMhub campaign this Foundry world syncs to. Changing this
  // clears the active session id (since session ids are scoped to a
  // campaign and would otherwise dangle).
  game.settings.register(MODULE_ID, "campaignId", {
    name: "GMHUB.Settings.CampaignId.Name",
    hint: "GMHUB.Settings.CampaignId.Hint",
    scope: "world", config: true, type: String, default: "",
    onChange: (value) => {
      const current = game.settings.get(MODULE_ID, "activeSessionId");
      // Empty campaign + non-empty session = orphan; clear it.
      if (!value && current) game.settings.set(MODULE_ID, "activeSessionId", "");
    }
  });
  // How many of the most-recently-ended sessions the windowed Pull
  // keeps locally (the "recap window"). Default 1 reproduces the
  // historical single-recap behavior exactly; the call site clamps a
  // blank/NaN/0/negative value back to 1. World-scoped + GM-only like
  // campaignId; no onChange because nothing caches it — it's read fresh
  // on every Pull.
  game.settings.register(MODULE_ID, "sessionRecapCount", {
    name: "GMHUB.Settings.SessionRecapCount.Name",
    hint: "GMHUB.Settings.SessionRecapCount.Hint",
    scope: "world", config: true, type: Number, default: 1
  });
  // Currently-selected session for quick-note draining + lifecycle
  // controls. `config: false` keeps it out of the settings UI — it's
  // driven entirely by PickSessionDialog and the journal context menu.
  game.settings.register(MODULE_ID, "activeSessionId", {
    scope: "world", config: false, type: String, default: "",
    onChange: () => _refreshActiveSessionUI()
  });
  // FIFO queue of quick-notes queued while no session was active /
  // network was down. Drained on the next Push when a session is bound.
  game.settings.register(MODULE_ID, "pendingPushQueue", {
    scope: "world", config: false, type: Array, default: []
  });
  // Opt-in: auto-push journals on every Foundry-side edit. Off by
  // default — see SCOPE.md "Manual sync only".
  game.settings.register(MODULE_ID, "autoPushOnUpdate", {
    name: "GMHUB.Settings.AutoPush.Name",
    hint: "GMHUB.Settings.AutoPush.Hint",
    scope: "world", config: true, type: Boolean, default: false
  });
  // ISO timestamp of the last successful Pull, displayed in the
  // SyncDialog header so the GM knows when their data was last refreshed.
  game.settings.register(MODULE_ID, "lastPullAt", {
    scope: "world", config: false, type: String, default: ""
  });
  // 0016 (Unified Visibility) — GM-managed map from GMhub user id to
  // Foundry user id. The `shared` visibility path needs this to apply
  // per-user JournalEntryPage.ownership; without a mapping the GM
  // sees a one-time warning at Pull time.
  game.settings.register(MODULE_ID, "playerMap", {
    scope: "world", config: false, type: Object, default: {}
  });
  // Submenu so the GM has a button in the settings UI to open the
  // PlayerMapDialog (a FormApplication is the standard way to expose
  // a multi-field editor for an opaque-Object setting in Foundry).
  game.settings.registerMenu(MODULE_ID, "playerMapMenu", {
    name: "GMHUB.Settings.Mapping.Menu.Name",
    label: "GMHUB.Settings.Mapping.Menu.Label",
    hint: "GMHUB.Settings.Mapping.Menu.Hint",
    icon: "fas fa-users-cog",
    type: PlayerMapDialog,
    restricted: true
  });

  // Eagerly compile + cache the Handlebars templates so the first
  // dialog open doesn't pay the parse cost.
  loadTemplates([
    `modules/${MODULE_ID}/templates/sync-dialog.hbs`,
    `modules/${MODULE_ID}/templates/pick-session.hbs`,
    `modules/${MODULE_ID}/templates/confirm-overwrite.hbs`,
    `modules/${MODULE_ID}/templates/lifecycle-confirm.hbs`,
    `modules/${MODULE_ID}/templates/push-preview.hbs`,
    `modules/${MODULE_ID}/templates/agenda-editor.hbs`,
    `modules/${MODULE_ID}/templates/player-map.hbs`,
    `modules/${MODULE_ID}/templates/visibility.hbs`,
    `modules/${MODULE_ID}/templates/setup-wizard.hbs`
  ]);

  // Register the `eq` helper iff another module hasn't already added
  // one — common enough that several modules ship it; collisions
  // would re-define the same function with the same semantics, so the
  // guard is mostly to keep the console quiet.
  if (!Handlebars.helpers.eq) {
    Handlebars.registerHelper("eq", (a, b) => a === b);
  }
});

// -----------------------------------------------------------------------------
// i18nInit hook — runs after Foundry has loaded the core translation
// files but before `ready`. We use it to backfill our own `lang/en.json`
// into `game.i18n.translations` because Foundry v14's auto-loader has
// a bug where module language files aren't always picked up.
// -----------------------------------------------------------------------------
Hooks.once("i18nInit", async () => {
  try {
    // Fetch our own translation file directly — bypasses the broken
    // auto-loader. Path is module-relative so it works in any data root.
    const res = await fetch(`modules/${MODULE_ID}/lang/en.json`);
    if (!res.ok) {
      console.warn(`[${MODULE_ID}] lang fetch returned ${res.status}`);
      return;
    }
    // The JSON is flat-keyed (`GMHUB.Foo.Bar`); convert to a nested
    // object so mergeObject can deep-merge into Foundry's store.
    const flat = await res.json();
    try {
      const expanded = foundry.utils.expandObject(flat);
      // `overwrite: false` so anything an upstream override has set
      // already wins over our defaults.
      foundry.utils.mergeObject(game.i18n.translations, expanded, {
        inplace: true, overwrite: false
      });
    } catch (mergeErr) {
      console.warn(`[${MODULE_ID}] translations merge failed`, mergeErr);
    }
    // Belt-and-braces: also write each flat key directly. Some Foundry
    // internals (the `_loc()` template helper) look up by literal
    // dotted key rather than walking the nested tree.
    for (const [key, value] of Object.entries(flat)) {
      try { foundry.utils.setProperty(game.i18n.translations, key, value); } catch {}
    }
    // Patch `game.i18n.localize` itself so direct JS callers (not
    // template helpers) also resolve our keys. The patched wrapper
    // tries the original first, falling back to our flat map on miss.
    if (!game.i18n.localize?.__gmhubPatched) {
      const origLocalize = game.i18n.localize.bind(game.i18n);
      const patchedLocalize = function (key) {
        const fromOriginal = origLocalize(key);
        // Foundry returns the key itself when not found — that's our
        // sentinel for "fall back to our store".
        if (fromOriginal !== key) return fromOriginal;
        return Object.prototype.hasOwnProperty.call(flat, key) ? flat[key] : key;
      };
      // Tag the function so we don't double-patch on a hot reload.
      patchedLocalize.__gmhubPatched = true;
      game.i18n.localize = patchedLocalize;
      // Same pattern for `format` (the interpolating cousin). We have
      // to re-implement {var} interpolation here because Foundry's
      // format only runs against its own translation store.
      const origFormat = game.i18n.format.bind(game.i18n);
      const patchedFormat = function (key, data) {
        const fromOriginal = origFormat(key, data);
        if (fromOriginal !== key) return fromOriginal;
        const template = flat[key];
        if (typeof template !== "string") return key;
        return template.replace(/\{(\w+)\}/g, (_, k) =>
          data && Object.prototype.hasOwnProperty.call(data, k) ? String(data[k]) : `{${k}}`
        );
      };
      patchedFormat.__gmhubPatched = true;
      game.i18n.format = patchedFormat;
    }
    // After the merge, force a re-render on any open UI that's already
    // rendered with the placeholder keys (typically the case when a
    // module is enabled mid-session).
    if (typeof ui !== "undefined") {
      ui.journal?.render?.(false);
      const settingsApp = Object.values(ui.windows ?? {}).find(
        (w) => w?.constructor?.name === "SettingsConfig"
      );
      settingsApp?.render?.(false);
      for (const win of Object.values(ui.windows ?? {})) {
        if (win?.constructor?.name === "SyncDialog") win.render?.(false);
      }
    }
  } catch (err) {
    // Don't blow up the world if the lang fetch fails — module will
    // just show raw keys in the UI, which is degraded but functional.
    console.warn(`[${MODULE_ID}] manual lang load failed`, err);
  }
});

// -----------------------------------------------------------------------------
// ready hook — runs once world data is fully loaded. Safe to touch
// `game.users`, `game.journal`, etc. We use it to construct the
// singleton client + sync service and publish the module's API.
// -----------------------------------------------------------------------------
Hooks.once("ready", () => {
  // Lazy getters so the client always reads the *current* setting
  // values — lets the GM edit them mid-session without re-instantiating.
  const client = new GmhubClient({
    getBaseUrl: () => game.settings.get(MODULE_ID, "baseUrl"),
    getApiKey: () => game.settings.get(MODULE_ID, "apiKey")
  });
  const sync = new SyncService(client);
  // Stash on the module record so macros + other modules can grab us
  // via `game.modules.get("gmhub-vtt-bridge").api`.
  game.modules.get(MODULE_ID).api = {
    client,
    sync,
    openDialog: () => new SyncDialog(sync).render(true),
    openPickSession: () => new PickSessionDialog(client).render(true),
    openAgendaEditor: (page) => openAgendaEditorForPage(page),
    openPlayerMap: () => new PlayerMapDialog().render(true),
    openVisibilityDialog: (page) => openVisibilityDialogForPage(page, client),
    openSetupWizard: () => SetupWizardDialog.openSetupWizard(client)
  };
  // Auto-fire the setup wizard on first run when campaignId is not configured.
  // GM-only: players don't configure the module.
  if (game.user.isGM && !game.settings.get(MODULE_ID, "campaignId")) {
    SetupWizardDialog.openSetupWizard(client);
  }
});

// -----------------------------------------------------------------------------
// renderJournalDirectory hook — fires every time the sidebar's Journals
// tab re-renders. Used here to inject the "Open GMhub Sync" header
// button and to mark the active-session journal entry.
// -----------------------------------------------------------------------------
Hooks.on("renderJournalDirectory", (app, html) => {
  // GM-only feature: no entry point shown to players.
  if (!game.user.isGM) return;
  // Foundry's `html` arg changed shape across versions — it might be a
  // jQuery-wrapped element (v11/12) or a raw HTMLElement (v14). Normalize.
  const root = (html instanceof HTMLElement) ? html : (html?.[0] ?? null);
  if (!root) return;
  // Try a few possible header containers since Foundry has moved the
  // class around between versions; fall back to the outer header.
  const target = root.querySelector(
    ".directory-header .header-actions, .header-actions, .directory-header"
  );
  // Idempotent: don't add a second button on re-render.
  if (target && !target.querySelector(".gmhub-sync-button")) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "gmhub-sync-button";
    button.innerHTML = `<i class="fas fa-cloud"></i> ${game.i18n.localize("GMHUB.Button.OpenDialog")}`;
    button.addEventListener("click", () => game.modules.get(MODULE_ID).api.openDialog());
    target.appendChild(button);
  }
  // Clear stale active-session highlights from the previous render —
  // the active session may have changed.
  const activeSessionId = game.settings.get(MODULE_ID, "activeSessionId");
  for (const el of root.querySelectorAll(".gmhub-active-session")) {
    el.classList.remove("gmhub-active-session");
  }
  // Re-apply the highlight to whichever journal row corresponds to the
  // active session id (matched by our `externalId` flag).
  if (activeSessionId) {
    const activeJournal = game.journal.contents.find(
      (e) => e.getFlag(MODULE_ID, "kind") === "session" &&
             e.getFlag(MODULE_ID, "externalId") === activeSessionId
    );
    if (activeJournal) {
      // Foundry rotates the data-attribute name between versions, so
      // we query both `data-document-id` (modern) and `data-entry-id` (legacy).
      const li = root.querySelector(
        `[data-document-id="${activeJournal.id}"], [data-entry-id="${activeJournal.id}"]`
      );
      li?.classList.add("gmhub-active-session");
    }
  }
});

// -----------------------------------------------------------------------------
// getJournalEntryContextOptions hook — extends the right-click menu on
// journal entries in the directory. Adds two GMhub-specific actions:
// "Push this journal to GMhub" and "Set as active session".
// -----------------------------------------------------------------------------
Hooks.on("getJournalEntryContextOptions", (html, options) => {
  // GM-only — players have nothing to push.
  if (!game.user.isGM) return;
  // Action #1: push a single journal to GMhub on demand. Available on
  // every entry regardless of bound state (createEntity will be called
  // if no externalId flag is set yet).
  options.push({
    name: "GMHUB.Context.PushOne",
    icon: '<i class="fas fa-cloud-upload-alt"></i>',
    callback: async (li) => {
      // `li.data` is jQuery's accessor — works on both versions.
      const entry = game.journal.get(li.data("documentId") ?? li.data("entryId"));
      if (!entry) return;
      const { sync } = game.modules.get(MODULE_ID).api;
      await sync.pushJournal(entry);
      ui.notifications.info(game.i18n.format("GMHUB.Notify.Pushed", { name: entry.name }));
    }
  });
  // Action #2: bind this session journal as the active session. Only
  // shown on session-kind entries that aren't already active.
  options.push({
    name: "GMHUB.Context.SetActiveSession",
    icon: '<i class="fas fa-play-circle"></i>',
    condition: (li) => {
      // Defensive: jQuery's data() sometimes is undefined on torn-down rows.
      const entryId = li?.data?.("documentId") ?? li?.data?.("entryId");
      const entry = game.journal.get(entryId);
      if (!entry) return false;
      // Only session-kind journals can be the active session.
      if (entry.getFlag(MODULE_ID, "kind") !== "session") return false;
      const sessionId = entry.getFlag(MODULE_ID, "externalId");
      if (!sessionId) return false;
      // Hide the option for the *current* active session — nothing to do.
      return sessionId !== game.settings.get(MODULE_ID, "activeSessionId");
    },
    callback: async (li) => {
      const entryId = li?.data?.("documentId") ?? li?.data?.("entryId");
      const entry = game.journal.get(entryId);
      if (!entry) return;
      const sessionId = entry.getFlag(MODULE_ID, "externalId");
      if (!sessionId) return;
      // Setting the value triggers `_refreshActiveSessionUI` via onChange.
      await game.settings.set(MODULE_ID, "activeSessionId", sessionId);
      ui.notifications.info(game.i18n.format("GMHUB.Notify.SessionBound", { name: entry.name }));
    }
  });
});

// -----------------------------------------------------------------------------
// updateJournalEntry hook — fires on every JournalEntry mutation. Used
// to mark the entry dirty (so Push knows to send it) and to optionally
// kick off an auto-push when the setting is enabled.
// -----------------------------------------------------------------------------
Hooks.on("updateJournalEntry", async (entry, _change, _options, userId) => {
  // Only the originating user should drive sync — otherwise every
  // client in a multi-GM world would re-push the same change.
  if (game.user.id !== userId) return;
  // GM-only feature.
  if (!game.user.isGM) return;
  const { sync } = game.modules.get(MODULE_ID).api;
  try { await sync.markDirty(entry); } catch (err) {
    console.warn("[gmhub-vtt-bridge] markDirty failed", err);
  }
  // Opt-in auto-push escape hatch (see SCOPE.md "Manual sync only").
  if (!game.settings.get(MODULE_ID, "autoPushOnUpdate")) return;
  try { await sync.pushOne(entry); } catch (err) {
    console.error("[gmhub-vtt-bridge] auto-push failed", err);
  }
});

// -----------------------------------------------------------------------------
// getJournalEntryPageContextOptions hook — extends the right-click menu
// on individual pages *inside* a journal. Adds the "Edit agenda /
// pinned" entry on session-plan pages and the visibility editor on
// every synced note page.
// -----------------------------------------------------------------------------
Hooks.on("getJournalEntryPageContextOptions", (app, options) => {
  // GM-only — players don't manage the GMhub side.
  if (!game.user.isGM) return;
  // Agenda/Pinned editor — only on the corresponding pages of a session
  // journal (the rendered HTML is read-only; the editor lets the GM
  // mutate the underlying data structures).
  options.push({
    name: "GMHUB.Context.EditAgenda",
    icon: '<i class="fas fa-list-ol"></i>',
    condition: (li) => {
      // Foundry rotates the data-attribute name; check both.
      const pageId = li?.data?.("page-id") ?? li?.data?.("pageId");
      const page = app?.object?.pages?.get?.(pageId);
      if (!page) return false;
      // Only session-kind parent journals carry agenda/pinned data.
      if (page.parent?.getFlag(MODULE_ID, "kind") !== "session") return false;
      // Page-name match is fine because we control the names at create time.
      return page.name === "Agenda" || page.name === "Pinned";
    },
    callback: (li) => {
      const pageId = li?.data?.("page-id") ?? li?.data?.("pageId");
      const page = app?.object?.pages?.get?.(pageId);
      openAgendaEditorForPage(page);
    }
  });
  // 0016 (Unified Visibility): one context entry per synced page. The
  // dialog handles notes today and can be extended to entities/sessions
  // by relaxing the condition below.
  options.push({
    name: "GMHUB.Context.EditVisibility",
    icon: '<i class="fas fa-user-shield"></i>',
    condition: (li) => {
      const pageId = li?.data?.("page-id") ?? li?.data?.("pageId");
      const page = app?.object?.pages?.get?.(pageId);
      if (!page) return false;
      // Notes-only for now — entities/sessions don't have the
      // visibility/recipients model wired through.
      if (page.parent?.getFlag(MODULE_ID, "kind") !== "notes") return false;
      // Page must be bound to a GMhub note (i.e. has an externalId).
      return Boolean(page.getFlag(MODULE_ID, "externalId"));
    },
    callback: (li) => {
      const pageId = li?.data?.("page-id") ?? li?.data?.("pageId");
      const page = app?.object?.pages?.get?.(pageId);
      const { client } = game.modules.get(MODULE_ID).api;
      openVisibilityDialogForPage(page, client);
    }
  });
});

// -----------------------------------------------------------------------------
// updateJournalEntryPage hook — page-level analog of updateJournalEntry.
// Fires when a page's text, ownership, or name changes. We use the
// granularity of the `change` payload to ignore Foundry-internal
// updates (e.g. our own dirty-flag writes would otherwise infinite-loop).
// -----------------------------------------------------------------------------
Hooks.on("updateJournalEntryPage", async (page, change, _options, userId) => {
  // Only the originating user drives sync (multi-client safety).
  if (game.user.id !== userId) return;
  if (!game.user.isGM) return;
  const parentKind = page.parent?.getFlag(MODULE_ID, "kind");
  // Page's parent isn't a GMhub-synced journal — nothing to do.
  if (!parentKind) return;

  // Filter to "real" user changes. Without this filter, any setFlag
  // call (including ours setting dirty=true) would re-enter this hook.
  const isUserChange =
    change.text !== undefined ||
    change.ownership !== undefined ||
    change.name !== undefined;
  if (!isUserChange) return;

  try { await page.setFlag(MODULE_ID, "dirty", true); } catch (err) {
    console.warn("[gmhub-vtt-bridge] page markDirty failed", err);
  }
  // Same auto-push opt-in as for entries. We push the *parent* entry
  // because the GMhub API is journal-shaped, not page-shaped.
  if (!game.settings.get(MODULE_ID, "autoPushOnUpdate")) return;
  try {
    const { sync } = game.modules.get(MODULE_ID).api;
    await sync.pushOne(page.parent);
  } catch (err) {
    console.error("[gmhub-vtt-bridge] auto-push (page) failed", err);
  }
});
