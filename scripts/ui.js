// =============================================================================
// scripts/ui.js
// =============================================================================
//
// GMhub VTT Bridge — Foundry Application classes.
//
// PURPOSE:
//   Every modal/dialog the module surfaces lives in this file. Each is
//   a thin subclass of Foundry's `Application` (or `FormApplication`
//   for the player-map editor) with a Handlebars template under
//   `templates/`. The patterns are repetitive on purpose — keeps the
//   ApplicationV2 migration (GMV-5) easy to do file-wide.
//
// CLASS INVENTORY:
//   - SyncDialog              — main entry point: Ping, Pull, Push, lifecycle.
//   - LifecycleConfirmDialog  — destructive-action confirm prompt.
//   - PrePushReviewDialog     — grouped dirty-state dashboard + drift; the
//                               single confirm gate before Push commits.
//   - AgendaEditorDialog      — agenda/pinned scene + entity editor.
//   - ConfirmOverwriteDialog  — "you have unpushed edits" Pull guard.
//   - PickSessionDialog       — list-and-pick the active session.
//   - PlayerMapDialog         — GM-only GMhub-user → Foundry-user mapping.
//   - VisibilityDialog        — unified per-page visibility editor (0016).
//
// 0016 (Unified Visibility):
//   RevealMenuDialog renamed to VisibilityDialog. Save now writes via
//   PATCH /notes/{id} with `{ visibility, recipients }` rather than
//   the deleted /player-reveal endpoint.
// =============================================================================

// Canonical module id for flag/setting lookups.
import { MODULE_ID } from "./main.js";
// Error toaster + ping result formatters used by Test Connection.
import { describePingFailure, describePingResult, safeCall } from "./error-toaster.js";
// Shared helpers from sync.js for the editor + visibility dialogs.
import {
  computePageOwnership,
  renderAgendaHtml,
  renderPinnedHtml,
  SESSION_PLAN_FLAGS,
  SESSION_PLAN_PAGE_NAMES
} from "./sync.js";

// -----------------------------------------------------------------------------
// statusLabel(session)
// -----------------------------------------------------------------------------
// Translate a session record into the short text label the PickSession
// list shows ("prep" / "live" / "paused" / "ended"). Mirrors the same
// derivation the gmhub-app web UI uses.
// -----------------------------------------------------------------------------
function statusLabel(session) {
  if (session.ended_at) return "ended";
  if (session.paused_at) return "paused";
  if (session.started_at) return "live";
  return "prep";
}

// -----------------------------------------------------------------------------
// lifecycleAvailableFor(status)
// -----------------------------------------------------------------------------
// Return a flag map of which lifecycle buttons should be enabled for a
// session in `status`. Keeps the SyncDialog's `getData` free of branchy
// logic — the template just `{{#if lifecycle.start}}` etc.
// -----------------------------------------------------------------------------
function lifecycleAvailableFor(status) {
  switch (status) {
    case "prep":   return { start: true,  pause: false, resume: false, end: false };
    case "live":   return { start: false, pause: true,  resume: false, end: true  };
    case "paused": return { start: false, pause: false, resume: true,  end: true  };
    // Unknown status (or no session bound) → no buttons visible.
    default:       return { start: false, pause: false, resume: false, end: false };
  }
}

// Capitalize first letter — used to build i18n keys like
// `GMHUB.Button.SessionStart` from the action name "start".
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// -----------------------------------------------------------------------------
// confirmViaDialog(DialogClass, props)
// -----------------------------------------------------------------------------
// The promise-wrapped confirm-gate idiom, extracted so every "pop a
// confirm dialog, await the GM's yes/no" call site shares one
// implementation instead of hand-rolling the same new Promise +
// resolved-flag + close() monkey-patch. Constructs `DialogClass` with
// `props` plus an injected `onConfirm` that resolves the promise `true`,
// then patches `close()` so an X-out (title-bar close without confirming)
// resolves `false`. Renders and returns a `Promise<boolean>`.
//
// Every dialog it drives already takes `({ ...props, onConfirm }, options={})`
// and fires `this.onConfirm(); this.close();` from its confirm button, so
// this is a clean drop-in. No third `options` param — no call site passes a
// Foundry-options constructor arg, and the dialog constructors already
// default `options={}` themselves.
// -----------------------------------------------------------------------------
function confirmViaDialog(DialogClass, props = {}) {
  return new Promise((resolve) => {
    // Track whether the confirm callback fired so the close handler can
    // distinguish "user cancelled" from "user confirmed".
    let resolved = false;
    const dialog = new DialogClass({
      ...props,
      onConfirm: () => { resolved = true; resolve(true); }
    });
    // Monkey-patch close so an X-out falls through to "cancel".
    const origClose = dialog.close.bind(dialog);
    dialog.close = async (...args) => { if (!resolved) resolve(false); return origClose(...args); };
    dialog.render(true);
  });
}

// =============================================================================
// SyncDialog
// =============================================================================
// The main module entry point. Surfaces:
//   - Connection info (base URL, campaign, last-pull timestamp)
//   - Test Connection button (calls /ping)
//   - Pull / Push buttons (kick off the sync orchestration)
//   - Pick Session button (opens PickSessionDialog)
//   - Session lifecycle controls (start / pause / resume / end)
//   - An inline status line + scrollable output pane
// =============================================================================
export class SyncDialog extends Application {
  constructor(sync, options = {}) {
    super(options);
    // Injected so we don't re-grab the singleton on every render.
    this.sync = sync;
    // UI-local state: status + output go into the template via getData.
    this.status = "";
    this.output = "";
    // Tri-state: null = not fetched yet, string = a known status, error
    // string = couldn't reach the API.
    this.sessionStatus = null;
    this.sessionStatusError = null;
    // Disables lifecycle buttons while a transition is in flight so
    // the GM can't double-click into a 409.
    this.lifecycleBusy = false;
  }
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "gmhub-sync-dialog",
      title: "GMhub Sync",
      template: `modules/${MODULE_ID}/templates/sync-dialog.hbs`,
      width: 520, height: "auto", classes: ["gmhub-sync-dialog"]
    });
  }
  getData() {
    // Compute lifecycle button visibility once so the template doesn't
    // recompute it per-button.
    const lifecycle = lifecycleAvailableFor(this.sessionStatus);
    const anyLifecycleVisible = lifecycle.start || lifecycle.pause || lifecycle.resume || lifecycle.end;
    return {
      // Settings echoed back so the dialog acts as a "connection status" panel.
      baseUrl: game.settings.get(MODULE_ID, "baseUrl"),
      campaignId: game.settings.get(MODULE_ID, "campaignId"),
      activeSessionId: game.settings.get(MODULE_ID, "activeSessionId"),
      // Empty lastPullAt is replaced by the localized "Never" label.
      lastPullAt: game.settings.get(MODULE_ID, "lastPullAt") || game.i18n.localize("GMHUB.Dialog.Never"),
      // Dynamic UI state.
      status: this.status,
      output: this.output,
      sessionStatus: this.sessionStatus,
      sessionStatusError: this.sessionStatusError,
      lifecycle, anyLifecycleVisible, lifecycleBusy: this.lifecycleBusy
    };
  }
  // ---------------------------------------------------------------------------
  // _refreshSessionStatus()
  // ---------------------------------------------------------------------------
  // Fetch the current status of the active session and cache it on the
  // instance. Called from `activateListeners` lazily (only when the
  // dialog is first opened with a bound session) and after every
  // lifecycle transition.
  // ---------------------------------------------------------------------------
  async _refreshSessionStatus() {
    const campaignId = game.settings.get(MODULE_ID, "campaignId");
    const sessionId = game.settings.get(MODULE_ID, "activeSessionId");
    // No session bound → clear both state fields and bail.
    if (!campaignId || !sessionId) {
      this.sessionStatus = null; this.sessionStatusError = null; return;
    }
    try {
      const session = await this.sync.client.getSession(campaignId, sessionId);
      this.sessionStatus = session ? statusLabel(session) : null;
      this.sessionStatusError = null;
    } catch (err) {
      // On failure we surface a banner; getData renders it.
      this.sessionStatus = null;
      this.sessionStatusError = err.message ?? String(err);
    }
  }
  // ---------------------------------------------------------------------------
  // _runLifecycle(action, { confirm })
  // ---------------------------------------------------------------------------
  // Common driver for the four lifecycle buttons. Optionally pops a
  // confirm dialog (used for "end"), shows in-progress status, calls
  // the API, then refreshes the cached status. All four states share
  // localization keys derived from the action name.
  // ---------------------------------------------------------------------------
  async _runLifecycle(action, { confirm = false } = {}) {
    const campaignId = game.settings.get(MODULE_ID, "campaignId");
    const sessionId = game.settings.get(MODULE_ID, "activeSessionId");
    if (!campaignId || !sessionId) return;
    // Confirm gate — the shared helper awaits the GM's yes/no in this
    // otherwise-linear flow.
    if (confirm) {
      const ok = await confirmViaDialog(LifecycleConfirmDialog, { action });
      if (!ok) return;
    }
    // Disable lifecycle buttons + show in-progress text.
    this.lifecycleBusy = true;
    this._setStatus(game.i18n.localize(`GMHUB.Notify.Lifecycle.${capitalize(action)}.InProgress`));
    try {
      // safeCall pipes any failure through the friendly-error toaster.
      await safeCall(() => this.sync.client.transitionLifecycle(campaignId, sessionId, action));
      await this._refreshSessionStatus();
      this.lifecycleBusy = false;
      const doneKey = `GMHUB.Notify.Lifecycle.${capitalize(action)}.Done`;
      ui.notifications.info(game.i18n.localize(doneKey));
      this._setStatus(game.i18n.localize(doneKey));
    } catch (err) {
      this.lifecycleBusy = false;
      this._setStatus(
        game.i18n.localize(`GMHUB.Notify.Lifecycle.${capitalize(action)}.Failed`),
        err.message ?? ""
      );
    }
  }
  // ---------------------------------------------------------------------------
  // activateListeners(html)
  // ---------------------------------------------------------------------------
  // Wire up every button click. Foundry calls this after each render,
  // so the closures here re-bind on every redraw.
  // ---------------------------------------------------------------------------
  activateListeners(html) {
    super.activateListeners(html);
    // First render with a bound session: kick off the status fetch in
    // the background and re-render when it lands.
    if (this.sessionStatus === null && this.sessionStatusError === null) {
      const sessionId = game.settings.get(MODULE_ID, "activeSessionId");
      if (sessionId) this._refreshSessionStatus().then(() => this.render(false));
    }
    // "Open module settings" shortcut — saves the GM from hunting
    // through Foundry's settings tree.
    html.find('[data-action="open-settings"]').on("click", () => {
      const settingsApp = new SettingsConfig();
      settingsApp.render(true, { focus: true });
    });
    // Open the PickSessionDialog. The callback updates the inline
    // status line so the GM sees confirmation without a toast.
    html.find('[data-action="pick-session"]').on("click", () => {
      const picker = new PickSessionDialog(this.sync.client, {
        onPicked: (session) => {
          this._setStatus(game.i18n.format("GMHUB.Notify.SessionBound", { name: session.title }));
        }
      });
      picker.render(true);
    });
    // Lifecycle buttons — `end` requires confirmation; the others are
    // reversible enough to fire immediately.
    html.find('[data-action="session-start"]').on("click", () => this._runLifecycle("start"));
    html.find('[data-action="session-pause"]').on("click", () => this._runLifecycle("pause"));
    html.find('[data-action="session-resume"]').on("click", () => this._runLifecycle("resume"));
    html.find('[data-action="session-end"]').on("click", () => this._runLifecycle("end", { confirm: true }));
    // Ping / Test Connection — the most useful debugging button.
    html.find('[data-action="ping"]').on("click", async () => {
      this._setStatus(game.i18n.localize("GMHUB.Notify.Pinging"));
      try {
        const principal = await safeCall(() => this.sync.client.ping());
        this._setStatus(game.i18n.localize("GMHUB.Notify.PingDone"), describePingResult(principal));
      } catch (err) {
        this._setStatus(game.i18n.localize("GMHUB.Notify.PingFailed"), describePingFailure(err));
      }
    });
    // Pull button. Wraps the ConfirmOverwriteDialog in a promise so
    // pullAll's `confirmOverwrite` callback can await GM input.
    html.find('[data-action="pull"]').on("click", async () => {
      this._setStatus(game.i18n.localize("GMHUB.Notify.Pulling"));
      try {
        const result = await safeCall(() => this.sync.pullAll({
          // Return the helper's promise directly so pullAll's
          // confirmOverwrite callback can await the GM's yes/no. Strip
          // each dirty entry down to {name} to keep the dialog simple.
          confirmOverwrite: (dirtyEntries) => confirmViaDialog(ConfirmOverwriteDialog, {
            dirtyEntries: dirtyEntries.map((e) => ({ name: e.name }))
          })
        }));
        // Cancel returns a sentinel — show the cancelled status and skip the report.
        if (result?.cancelled) { this._setStatus(game.i18n.localize("GMHUB.Notify.PullCancelled")); return; }
        // Format the report: counts on one line, errors below.
        const r = result?.pulled ?? { entities: 0, notes: 0, sessions: 0 };
        const summary = `entities: ${r.entities}, notes: ${r.notes}, sessions: ${r.sessions}`;
        const errs = (result?.errors ?? []).map((e) => `${e.name}: ${e.message}`).join("\n");
        this._setStatus(game.i18n.localize("GMHUB.Notify.PullDone"), `${summary}${errs ? "\n\n" + errs : ""}`);
      } catch (err) {
        // Toaster already fired; status line gets the raw message too.
        this._setStatus(game.i18n.localize("GMHUB.Notify.PullFailed"), err.message ?? "");
      }
    });
    // Push button. Two-stage: previewPush() to gather the dirty-state
    // dashboard, then PrePushReviewDialog is the single confirm gate on
    // the actual pushAll() call.
    html.find('[data-action="push"]').on("click", async () => {
      const preview = this.sync.previewPush();
      // Most common error short-circuit: no campaign bound.
      if (preview.error === "no_campaign_bound") {
        this._setStatus(game.i18n.localize("GMHUB.Notify.PushFailed"), preview.error);
        return;
      }
      // Pre-push review dashboard is the single confirm gate (no double-
      // confirm). total==0 opens it to the "nothing to push" empty state.
      const confirmed = await confirmViaDialog(PrePushReviewDialog, { preview });
      if (!confirmed) { this._setStatus(game.i18n.localize("GMHUB.Notify.PushCancelled")); return; }
      this._setStatus(game.i18n.localize("GMHUB.Notify.Pushing"));
      try {
        const result = await safeCall(() => this.sync.pushAll());
        const p = result?.pushed ?? { entities: 0, notes: 0, sessionPlans: 0, quickNotes: 0 };
        const summary = `entities: ${p.entities}, notes: ${p.notes}, sessions: ${p.sessionPlans}, quick notes: ${p.quickNotes}`;
        const errs = (result?.errors ?? []).map((e) => `${e.name}: ${e.message}`).join("\n");
        // Include failed-count in the headline so the GM notices partial failures.
        this._setStatus(
          `${game.i18n.localize("GMHUB.Notify.PushDone")} (${result?.failed ?? 0} failed)`,
          `${summary}${errs ? "\n\n" + errs : ""}`
        );
      } catch (err) {
        this._setStatus(game.i18n.localize("GMHUB.Notify.PushFailed"), err.message ?? "");
      }
    });
  }
  // Set the inline status line + (optional) multi-line output, then redraw.
  _setStatus(message, output = "") { this.status = message; this.output = output; this.render(false); }
}

// =============================================================================
// LifecycleConfirmDialog
// =============================================================================
// Tiny confirm dialog used by the "End session" button (and reserved
// for any other destructive lifecycle action we add later). Title /
// body / button label are all driven by the action name so we only
// have one component to maintain.
// =============================================================================
export class LifecycleConfirmDialog extends Application {
  constructor({ action, onConfirm = () => {} } = {}, options = {}) {
    super(options); this.action = action; this.onConfirm = onConfirm;
  }
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "gmhub-lifecycle-confirm",
      title: "Confirm session action",
      template: `modules/${MODULE_ID}/templates/lifecycle-confirm.hbs`,
      width: 460, height: "auto", classes: ["gmhub-lifecycle-confirm-dialog"]
    });
  }
  getData() {
    const action = this.action;
    // Three derived i18n keys: dialog title, body copy, confirm button.
    return {
      action,
      titleKey: `GMHUB.Dialog.LifecycleConfirm.${capitalize(action)}.Title`,
      bodyKey: `GMHUB.Dialog.LifecycleConfirm.${capitalize(action)}.Body`,
      confirmKey: `GMHUB.Button.Session${capitalize(action)}`
    };
  }
  activateListeners(html) {
    super.activateListeners(html);
    html.find('[data-action="cancel"]').on("click", () => this.close());
    // Fire the callback then close — the caller's promise resolves.
    html.find('[data-action="confirm"]').on("click", () => { this.onConfirm(); this.close(); });
  }
}

// =============================================================================
// PrePushReviewDialog
// =============================================================================
// The pre-push review dashboard — the single confirm gate on Push
// (supersedes the old PushPreviewDialog). Groups every pending change
// (entities create/update, notes create/update, quick-note queue,
// per-session plan edits) with counts and per-entry rows, plus a
// read-only visibility-drift group. Document-backed rows (entities,
// notes, session journals) open the underlying page/journal on click;
// quick-notes, the session-plan field label, and drift rows are
// read-only. Fed by `previewPush()` (see sync.js).
//
// total==0 preserves the old behaviour exactly: the dialog still opens
// (no pre-dialog short-circuit) and renders the "nothing to push" empty
// state with a disabled Confirm; drift is NOT shown in the empty branch,
// so it only ever surfaces alongside real pending work.
// =============================================================================
export class PrePushReviewDialog extends Application {
  constructor({ preview = null, onConfirm = () => {} } = {}, options = {}) {
    super(options); this.preview = preview; this.onConfirm = onConfirm;
  }
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "gmhub-pre-push-review", title: "Pre-push review",
      template: `modules/${MODULE_ID}/templates/pre-push-review.hbs`,
      width: 560, height: "auto", classes: ["gmhub-pre-push-review-dialog"]
    });
  }
  getData() {
    const p = this.preview ?? {};
    // Flatten the session-plan boolean map into a friendly field list.
    const sessionPlanFields = [];
    const sp = p.sessionPlan ?? {};
    if (sp.gmNotes) sessionPlanFields.push("gm_notes");
    if (sp.gmSecrets) sessionPlanFields.push("gm_secrets");
    if (sp.agenda) sessionPlanFields.push("agenda");
    if (sp.pinned) sessionPlanFields.push("pinned");
    return {
      // Empty preview triggers the "nothing to push" branch in the template.
      // total EXCLUDES drift, so a drift-only world still reads as empty.
      empty: (p.total ?? 0) === 0,
      entitiesCreate: p.entities?.create ?? [],
      entitiesUpdate: p.entities?.update ?? [],
      notesCreate: p.notes?.create ?? [],
      notesUpdate: p.notes?.update ?? [],
      sessionPlanFields,
      // null when no fields are set so the template can {{#if}} cleanly.
      sessionPlanLabel: sessionPlanFields.length ? sessionPlanFields.join(", ") : null,
      sessionPlanJournals: p.sessionPlanJournals ?? [],
      quickNotes: p.quickNotes ?? 0,
      // Read-only bucket; the template only renders it in the non-empty branch.
      visibilityDrift: p.visibilityDrift ?? []
    };
  }
  activateListeners(html) {
    super.activateListeners(html);
    html.find('[data-action="cancel"]').on("click", () => this.close());
    html.find('[data-action="confirm"]').on("click", () => { this.onConfirm(); this.close(); });
    // Click-through: open the underlying Foundry document for a row that
    // carries a uuid. fromUuidSync is null-guarded because the doc may have
    // been deleted between preview and click.
    html.find('[data-action="open-doc"]').on("click", (evt) => {
      const uuid = evt.currentTarget.dataset.uuid;
      if (!uuid) return;
      const doc = fromUuidSync(uuid);
      if (!doc) return;
      // A JournalEntryPage opens its parent journal focused on the page;
      // a JournalEntry (session journal) opens its own sheet.
      if (doc.documentName === "JournalEntryPage") doc.parent?.sheet?.render(true, { pageId: doc.id });
      else doc.sheet?.render(true);
    });
  }
}

// =============================================================================
// AgendaEditorDialog
// =============================================================================
// Shared editor for the Agenda and Pinned pages. `kind` is "agenda"
// or "pinned"; the same component handles both because the
// add/remove/reorder mechanics are identical — only the per-row schema
// differs (which is template-side).
// =============================================================================
export class AgendaEditorDialog extends Application {
  constructor({ page, kind } = {}, options = {}) {
    super(options);
    this.page = page; this.kind = kind;
    // Look up the right flag key (`agendaItems` or `pinnedRefs`) so
    // both modes can use the same load/save path.
    const flagKey = SESSION_PLAN_FLAGS[kind];
    const raw = page?.getFlag(MODULE_ID, flagKey) ?? [];
    // Deep clone so edits in the dialog don't mutate the page's flag
    // before the user hits Save (cancel = discard).
    this.items = JSON.parse(JSON.stringify(Array.isArray(raw) ? raw : []));
  }
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "gmhub-agenda-editor", title: "Edit",
      template: `modules/${MODULE_ID}/templates/agenda-editor.hbs`,
      width: 560, height: "auto", classes: ["gmhub-agenda-editor-dialog"]
    });
  }
  // Dynamic title so "Edit agenda" / "Edit pinned" shows on the same dialog.
  get title() {
    const titleKey = this.kind === "pinned"
      ? "GMHUB.Dialog.AgendaEditor.Title.Pinned"
      : "GMHUB.Dialog.AgendaEditor.Title.Agenda";
    return game.i18n.localize(titleKey);
  }
  getData() {
    return {
      kind: this.kind,
      // Flatten the kind switch into two booleans the template can
      // {{#if isAgenda}} on directly.
      isAgenda: this.kind === "agenda",
      isPinned: this.kind === "pinned",
      // Inject the row index so per-row buttons can find their item again.
      items: this.items.map((item, idx) => ({ ...item, _idx: idx }))
    };
  }
  activateListeners(html) {
    super.activateListeners(html);
    // Add row — push a per-kind empty record onto the array, redraw.
    html.find('[data-action="add"]').on("click", () => {
      if (this.kind === "agenda") this.items.push({ title: "", estimated_duration_min: 0, notes: "" });
      else this.items.push({ entity_type: "npc", name: "", entity_id: "" });
      this.render(false);
    });
    // Remove row — splice the matching index out and redraw.
    html.find('[data-action="remove"]').on("click", (evt) => {
      const idx = Number(evt.currentTarget.dataset.idx);
      if (Number.isInteger(idx)) { this.items.splice(idx, 1); this.render(false); }
    });
    // Reorder up — swap with the previous row. No-op at index 0.
    html.find('[data-action="up"]').on("click", (evt) => {
      const idx = Number(evt.currentTarget.dataset.idx);
      if (idx > 0) {
        [this.items[idx - 1], this.items[idx]] = [this.items[idx], this.items[idx - 1]];
        this.render(false);
      }
    });
    // Reorder down — swap with the next row. No-op at last index.
    html.find('[data-action="down"]').on("click", (evt) => {
      const idx = Number(evt.currentTarget.dataset.idx);
      if (Number.isInteger(idx) && idx < this.items.length - 1) {
        [this.items[idx], this.items[idx + 1]] = [this.items[idx + 1], this.items[idx]];
        this.render(false);
      }
    });
    // Per-field input handler: writes the new value into the
    // in-memory array. No re-render so the cursor doesn't jump on
    // every keystroke.
    html.find('[data-field]').on("input change", (evt) => {
      const idx = Number(evt.currentTarget.dataset.idx);
      const field = evt.currentTarget.dataset.field;
      if (!Number.isInteger(idx) || !field) return;
      const item = this.items[idx]; if (!item) return;
      const value = evt.currentTarget.value;
      // Numeric field — coerce on input. Everything else stays string.
      if (field === "estimated_duration_min") item[field] = Number(value) || 0;
      else item[field] = value;
    });
    html.find('[data-action="cancel"]').on("click", () => this.close());
    // Save: persist the raw array to the flag, re-render the display
    // HTML, mark dirty (so the next Push includes the change), close.
    html.find('[data-action="save"]').on("click", async () => {
      try {
        const flagKey = SESSION_PLAN_FLAGS[this.kind];
        // Strip the row-index helper before persisting.
        const clean = this.items.map((item) => { const { _idx, ...rest } = item; return rest; });
        await this.page.setFlag(MODULE_ID, flagKey, clean);
        const html = this.kind === "agenda" ? renderAgendaHtml(clean) : renderPinnedHtml(clean);
        await this.page.update({ "text.content": html });
        await this.page.setFlag(MODULE_ID, "dirty", true);
        ui.notifications.info(game.i18n.localize("GMHUB.Notify.AgendaSaved"));
        this.close();
      } catch (err) {
        ui.notifications.error(err.message ?? String(err));
      }
    });
  }
}

// -----------------------------------------------------------------------------
// openAgendaEditorForPage(page)
// -----------------------------------------------------------------------------
// Dispatch helper called from the journal-page context menu in main.js.
// Picks the right `kind` based on the page name and renders.
// -----------------------------------------------------------------------------
export function openAgendaEditorForPage(page) {
  if (!page) return;
  if (page.name === SESSION_PLAN_PAGE_NAMES.agenda) new AgendaEditorDialog({ page, kind: "agenda" }).render(true);
  else if (page.name === SESSION_PLAN_PAGE_NAMES.pinned) new AgendaEditorDialog({ page, kind: "pinned" }).render(true);
}

// =============================================================================
// ConfirmOverwriteDialog
// =============================================================================
// "You have unpushed local edits — overwrite?" guard shown before Pull
// clobbers them. Lists each dirty entry by name so the GM knows what
// would be lost.
// =============================================================================
export class ConfirmOverwriteDialog extends Application {
  constructor({ dirtyEntries = [], onConfirm = () => {} } = {}, options = {}) {
    super(options); this.dirtyEntries = dirtyEntries; this.onConfirm = onConfirm;
  }
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "gmhub-confirm-overwrite", title: "Confirm overwrite",
      template: `modules/${MODULE_ID}/templates/confirm-overwrite.hbs`,
      width: 480, height: "auto", classes: ["gmhub-confirm-overwrite-dialog"]
    });
  }
  getData() { return { dirtyCount: this.dirtyEntries.length, dirtyEntries: this.dirtyEntries }; }
  activateListeners(html) {
    super.activateListeners(html);
    html.find('[data-action="cancel"]').on("click", () => this.close());
    // The CTA is labeled "Overwrite" — destructive copy so the GM
    // understands the consequence.
    html.find('[data-action="overwrite"]').on("click", () => { this.onConfirm(); this.close(); });
  }
}

// =============================================================================
// PickSessionDialog
// =============================================================================
// Lists every session the campaign has (prep/live/paused/ended) and
// lets the GM bind one as the active session. Used by the Sync dialog
// button and the module's public API.
// =============================================================================
export class PickSessionDialog extends Application {
  constructor(client, options = {}) {
    super(options);
    this.client = client;
    // Caller hook: fires after the GM picks one (used by SyncDialog).
    this.onPicked = options.onPicked ?? (() => {});
    // List + loading-state machine.
    this.sessions = []; this.loading = true; this.error = null;
  }
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "gmhub-pick-session-dialog", title: "Pick a prepped session",
      template: `modules/${MODULE_ID}/templates/pick-session.hbs`,
      width: 520, height: "auto", classes: ["gmhub-pick-session-dialog"]
    });
  }
  // ---------------------------------------------------------------------------
  // _refresh()
  // ---------------------------------------------------------------------------
  // (Re)fetch the session list and re-render. Drives both the initial
  // load and the explicit Refresh button.
  // ---------------------------------------------------------------------------
  async _refresh() {
    const campaignId = game.settings.get(MODULE_ID, "campaignId");
    // Short-circuit: no campaign → render the helpful empty state.
    if (!campaignId) {
      this.loading = false;
      this.error = game.i18n.localize("GMHUB.PickSession.NoCampaign");
      this.sessions = []; this.render(false); return;
    }
    // Render the spinner first so the user gets immediate feedback.
    this.loading = true; this.error = null; this.render(false);
    try {
      const sessions = (typeof this.client.listSessions === "function")
        ? await this.client.listSessions(campaignId) : [];
      // Attach the derived status label so the template doesn't have to know.
      this.sessions = (sessions ?? []).map((s) => ({ ...s, statusLabel: statusLabel(s) }));
    } catch (err) {
      this.error = err.message ?? String(err);
      this.sessions = [];
    }
    this.loading = false; this.render(false);
  }
  getData() { return { loading: this.loading, error: this.error, sessions: this.sessions }; }
  activateListeners(html) {
    super.activateListeners(html);
    // First render: kick off the fetch. Subsequent renders skip this
    // because `loading` flips false after the first response.
    if (this.loading && !this.error) this._refresh();
    html.find('[data-action="refresh"]').on("click", () => this._refresh());
    // Pick handler — write the setting, invoke the callback, close.
    html.find('[data-action="pick"]').on("click", async (evt) => {
      const sessionId = evt.currentTarget.dataset.sessionId;
      if (!sessionId) return;
      const session = this.sessions.find((s) => s.id === sessionId);
      if (!session) return;
      await game.settings.set(MODULE_ID, "activeSessionId", sessionId);
      this.onPicked(session);
      this.close();
    });
  }
}

/* ------------------------------------------------------------------ */
/* Player slot mapping (GM-only submenu)                               */
/* ------------------------------------------------------------------ */

// =============================================================================
// PlayerMapDialog
// =============================================================================
// FormApplication (not plain Application) so we get Foundry's
// per-field submit handling for free. Lets the GM associate each
// GMhub player user id with a Foundry user id, which the `shared`
// visibility path in sync.js uses to apply per-user ownership.
// =============================================================================
export class PlayerMapDialog extends FormApplication {
  constructor(object = {}, options = {}) {
    super(object, options);
    this.players = []; this.loading = true; this.error = null;
    // Clone the existing setting so cancel = discard (FormApplication
    // wouldn't otherwise let us roll back).
    this.mapping = { ...(game.settings.get(MODULE_ID, "playerMap") ?? {}) };
  }
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "gmhub-player-map", title: "GMhub Player Mapping",
      template: `modules/${MODULE_ID}/templates/player-map.hbs`,
      width: 560, height: "auto", classes: ["gmhub-player-map-dialog"],
      // closeOnSubmit yes; submitOnClose/Change no so accidental edits
      // don't silently persist.
      closeOnSubmit: true, submitOnChange: false, submitOnClose: false
    });
  }
  // ---------------------------------------------------------------------------
  // _refresh()
  // ---------------------------------------------------------------------------
  // Pull the campaign member list (GMhub-side) so we can render a row
  // per player. GMs are filtered out — they're already the local GM
  // user in Foundry by definition.
  // ---------------------------------------------------------------------------
  async _refresh() {
    const campaignId = game.settings.get(MODULE_ID, "campaignId");
    if (!campaignId) {
      this.loading = false;
      this.error = game.i18n.localize("GMHUB.PickSession.NoCampaign");
      this.players = []; this.render(false); return;
    }
    this.loading = true; this.error = null; this.render(false);
    try {
      // Pull the client from the module API since this dialog can be
      // opened directly from the settings menu (no constructor injection).
      const client = game.modules.get(MODULE_ID).api?.client;
      if (!client) throw new Error("client_not_ready");
      const members = await client.getMembers(campaignId);
      // Players-only rows in the picker; GMs aren't mapped (they're the
      // local GM user in Foundry already).
      this.players = members.filter((m) => m.role === "player");
    } catch (err) {
      this.error = err.message ?? String(err);
      this.players = [];
    }
    this.loading = false; this.render(false);
  }
  getData() {
    // Foundry users available as mapping targets — anyone non-GM.
    const foundryUsers = (game.users?.contents ?? []).filter((u) => !u.isGM);
    // One row per GMhub player; the dropdown options come pre-marked
    // with `selected: true` for the currently-mapped Foundry user.
    const rows = (this.players ?? []).map((p) => {
      const mapped = this.mapping[p.user_id] ?? "";
      const choices = foundryUsers.map((u) => ({ id: u.id, name: u.name, selected: u.id === mapped }));
      return { user_id: p.user_id, display_name: p.display_name, choices };
    });
    return {
      loading: this.loading,
      error: this.error,
      // Empty state only fires after a successful load with zero rows.
      empty: !this.loading && !this.error && rows.length === 0,
      rows
    };
  }
  activateListeners(html) {
    super.activateListeners(html);
    if (this.loading && !this.error) this._refresh();
    html.find('[data-action="refresh"]').on("click", () => this._refresh());
  }
  // ---------------------------------------------------------------------------
  // _updateObject(_event, formData)
  // ---------------------------------------------------------------------------
  // FormApplication submit handler. Foundry hands us a flat formData
  // object keyed by the input names; we filter to our `player.*` keys
  // and rebuild the mapping object from scratch.
  // ---------------------------------------------------------------------------
  async _updateObject(_event, formData) {
    const next = {};
    for (const [key, value] of Object.entries(formData ?? {})) {
      if (!key.startsWith("player.")) continue;
      const userId = key.slice("player.".length);
      // Skip empty selections — "no mapping" should leave the key absent.
      if (typeof value === "string" && value.length > 0) next[userId] = value;
    }
    await game.settings.set(MODULE_ID, "playerMap", next);
    ui.notifications?.info(game.i18n.localize("GMHUB.Notify.MappingSaved"));
  }
}

/* ------------------------------------------------------------------ */
/* Unified per-page visibility editor                                  */
/* ------------------------------------------------------------------ */

// =============================================================================
// VisibilityDialog
// =============================================================================
// 0016 (Unified Visibility): single per-page editor for the
// visibility/recipients tuple. Replaces the legacy RevealMenuDialog +
// the per-page eye-toggle reverse-mapper. Save writes via PATCH
// /notes/{id} so the change is durable server-side without a Push.
// =============================================================================
export class VisibilityDialog extends Application {
  constructor({ page, client } = {}, options = {}) {
    super(options);
    this.page = page;
    this.client = client;
    // Async-fetched member list + loading state.
    this.members = [];
    this.loading = true;
    this.error = null;
    // Saving-in-progress guard so the Save button can't fire twice.
    this.pending = false;
    // Seed from the page flag; coerce legacy values to `private`.
    this.visibility = page?.getFlag(MODULE_ID, "visibility") ?? "private";
    if (this.visibility !== "private" && this.visibility !== "shared" && this.visibility !== "everyone") {
      // Legacy fallback: anything not in the new triad opens as private.
      this.visibility = "private";
    }
    // Sets give us O(1) toggle on the per-user checkboxes.
    const initialRecipients = page?.getFlag(MODULE_ID, "recipients") ?? [];
    this.selected = new Set(Array.isArray(initialRecipients) ? initialRecipients : []);
    // Snapshot of the initial state — kept so a future "Reset" button
    // (not yet implemented) can roll back without re-reading the page.
    this.initial = new Set(this.selected);
    this.initialVisibility = this.visibility;
  }
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "gmhub-visibility-dialog",
      title: "Visibility",
      template: `modules/${MODULE_ID}/templates/visibility.hbs`,
      width: 480, height: "auto", classes: ["gmhub-visibility-dialog"]
    });
  }
  // ---------------------------------------------------------------------------
  // _refresh()
  // ---------------------------------------------------------------------------
  // Load the campaign's member list so the recipient picker has rows.
  // ---------------------------------------------------------------------------
  async _refresh() {
    const campaignId = game.settings.get(MODULE_ID, "campaignId");
    if (!campaignId) {
      this.loading = false;
      this.error = game.i18n.localize("GMHUB.PickSession.NoCampaign");
      this.render(false); return;
    }
    if (!this.client) {
      this.loading = false; this.error = "client_not_ready"; this.render(false); return;
    }
    this.loading = true; this.error = null; this.render(false);
    try {
      this.members = await this.client.getMembers(campaignId);
    } catch (err) {
      this.error = err.message ?? String(err);
      this.members = [];
    }
    this.loading = false; this.render(false);
  }
  getData() {
    // Player-mapping reference so we can warn about unmapped recipients
    // *before* the GM saves (rather than only at Pull time).
    const playerMap = game.settings.get(MODULE_ID, "playerMap") ?? {};
    const rows = (this.members ?? []).map((m) => ({
      user_id: m.user_id,
      display_name: m.display_name,
      role: m.role,
      checked: this.selected.has(m.user_id),
      // unmapped = selected but no Foundry user behind it. Drives the
      // warning banner the template shows below the picker.
      unmapped: m.role === "player" && !playerMap[m.user_id]
    }));
    const anyUnmapped = rows.some((r) => r.unmapped && r.checked);
    return {
      loading: this.loading,
      error: this.error,
      empty: !this.loading && !this.error && rows.length === 0,
      pending: this.pending,
      visibility: this.visibility,
      // Flattened booleans so the template's radio group can mark the
      // active option without a custom Handlebars helper.
      isPrivate: this.visibility === "private",
      isShared: this.visibility === "shared",
      isEveryone: this.visibility === "everyone",
      anyUnmapped,
      rows
    };
  }
  activateListeners(html) {
    super.activateListeners(html);
    if (this.loading && !this.error) this._refresh();
    // Radio-group change — flip visibility + redraw so the recipient
    // picker enables/disables based on whether the new value is `shared`.
    html.find('[data-action="set-visibility"]').on("change", (evt) => {
      const value = evt.currentTarget.value;
      if (value === "private" || value === "shared" || value === "everyone") {
        this.visibility = value;
        this.render(false);
      }
    });
    // Per-user checkbox — add/remove from the Set. No re-render so the
    // cursor / scroll position stays put while picking.
    html.find('[data-action="toggle"]').on("change", (evt) => {
      const userId = evt.currentTarget.dataset.userId;
      if (!userId) return;
      if (evt.currentTarget.checked) this.selected.add(userId);
      else this.selected.delete(userId);
    });
    // Bulk select-all — covers the common "share with the whole table" case.
    html.find('[data-action="select-all"]').on("click", () => {
      for (const m of this.members) this.selected.add(m.user_id);
      this.render(false);
    });
    // Bulk clear — covers "un-share quickly".
    html.find('[data-action="clear-all"]').on("click", () => {
      this.selected.clear();
      this.render(false);
    });
    html.find('[data-action="cancel"]').on("click", () => this.close());
    // Save: PATCH the server first (single source of truth), then
    // mirror the new state into local flags + Foundry ownership.
    html.find('[data-action="save"]').on("click", async () => {
      // Re-entrancy guard so a double-click doesn't fire two PATCHes.
      if (this.pending) return;
      const campaignId = game.settings.get(MODULE_ID, "campaignId");
      const noteId = this.page?.getFlag(MODULE_ID, "externalId");
      if (!campaignId || !noteId) {
        ui.notifications?.error(game.i18n.localize("GMHUB.Notify.VisibilityFailed"));
        return;
      }
      // Recipients only matter when visibility=shared; collapse to empty
      // otherwise so the server doesn't think we're trying to keep
      // stale rows around.
      const recipients = this.visibility === "shared" ? Array.from(this.selected) : [];
      this.pending = true; this.render(false);
      try {
        await this.client.updateNote(campaignId, noteId, {
          visibility: this.visibility,
          recipients
        });
        // Mirror server-state back into the local flags so subsequent
        // Pulls don't try to overwrite what we just set.
        await this.page.setFlag(MODULE_ID, "visibility", this.visibility);
        await this.page.setFlag(MODULE_ID, "recipients", recipients);
        // Apply the per-user ownership change immediately — the GM
        // shouldn't have to wait for a Pull to see the eye toggle update.
        const { ownership } = computePageOwnership({
          visibility: this.visibility,
          recipients
        });
        await this.page.update({ ownership });
        ui.notifications?.info(game.i18n.localize("GMHUB.Notify.VisibilitySaved"));
        this.close();
      } catch (err) {
        // Reset the busy flag so the Save button comes back to life.
        this.pending = false;
        ui.notifications?.error(err.message ?? game.i18n.localize("GMHUB.Notify.VisibilityFailed"));
        this.render(false);
      }
    });
  }
}

// -----------------------------------------------------------------------------
// openVisibilityDialogForPage(page, client)
// -----------------------------------------------------------------------------
// Entry point called from the page context menu in main.js. Guards
// against missing args so a malformed context payload doesn't throw.
// -----------------------------------------------------------------------------
export function openVisibilityDialogForPage(page, client) {
  if (!page || !client) return;
  new VisibilityDialog({ page, client }).render(true);
}
