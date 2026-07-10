// =============================================================================
// scripts/sync.js
// =============================================================================
//
// GMhub VTT Bridge — Pull/Push orchestration.
//
// PURPOSE:
//   The "brain" of the module. Takes the raw GmhubClient + Foundry's
//   journal APIs and turns them into the two user-facing operations:
//
//     Pull — fetch entities/notes/sessions from gmhub-app and reflect
//            them into Foundry JournalEntries (with stable-id flags,
//            ownership, ProseMirror→HTML rendering, orphan cleanup).
//
//     Push — collect dirty journals/pages and mirror their state back
//            to gmhub-app (create-if-no-externalId, otherwise PATCH).
//            Includes a draining step for the offline quick-note queue.
//
//   Also exports a few helpers consumed by ui.js:
//     - tiptapToHtml       (renders ProseMirror JSON to HTML for Pull)
//     - computePageOwnership (maps GMhub visibility/recipients → Foundry)
//     - renderAgendaHtml / renderPinnedHtml (used by AgendaEditorDialog)
//     - SESSION_PLAN_FLAGS / SESSION_PLAN_PAGE_NAMES (shared constants)
//
// FLAG MODEL:
//   Every journal/page we sync stores at minimum:
//     - kind        : "npc" | "location" | ... | "notes" | "session"
//     - externalId  : GMhub-side primary key (used for re-sync lookups)
//     - dirty       : true after a local edit, cleared on successful Push
//   Notes/entities also carry `visibility` + `recipients`; sessions also
//   carry `agendaItems` / `pinnedRefs` (raw structured data so Push can
//   send canonical JSON back to the server).
//
// 0016 (Unified Visibility):
//   The only visibility values in flight are `private`, `shared`,
//   `everyone`. Legacy values (`gm_only`, `players_only`, `campaign`)
//   are still recognised in case a Pull brings back an unmigrated row,
//   but no Push ever writes them.
// =============================================================================

// Canonical module id — namespace for every flag we read/write.
import { MODULE_ID } from "./main.js";

// -----------------------------------------------------------------------------
// Flag key constants. Keeping them in one place avoids subtle typos
// (`externalID` vs `externalId`) that would silently fork the data.
// -----------------------------------------------------------------------------
const FLAG_KIND = "kind";                  // discriminator: npc/notes/session/...
const FLAG_EXTERNAL_ID = "externalId";     // server-side primary key
const FLAG_VISIBILITY = "visibility";      // private/shared/everyone
const FLAG_REVEALED_AT = "revealedAt";     // legacy reveal timestamp (entities)
const FLAG_RECIPIENTS = "recipients";      // GMhub user-id list for `shared`
const FLAG_DIRTY = "dirty";                // local-edit marker → Push picks up
const FLAG_ENTITY_TYPE = "entityType";     // npc/location/... within entity pages
const FLAG_AGENDA_DATA = "agendaItems";    // raw agenda array on the Agenda page
const FLAG_PINNED_DATA = "pinnedRefs";     // raw pinned array on the Pinned page

// -----------------------------------------------------------------------------
// Mapping from GMhub `entity_type` → human-friendly journal name. One
// JournalEntry per kind; pages inside it are the individual entities.
// -----------------------------------------------------------------------------
const KIND_JOURNAL_NAMES = {
  npc: "NPCs",
  location: "Locations",
  faction: "Factions",
  item: "Items",
  quest: "Quests",
  lore: "Lore"
};

// Notes get their own journal of kind "notes" (not in KIND_JOURNAL_NAMES
// because the loop conditions for entities vs notes diverge slightly).
const NOTES_JOURNAL_NAME = "Notes";
// Sessions live in a dedicated colored folder for visual separation.
const SESSION_FOLDER_NAME = "GMhub Sessions";
// Canonical page names inside a session journal. Used for lookup at
// Push time (we round-trip the contents by page name).
const SESSION_PAGE_GM_NOTES = "GM Notes";
const SESSION_PAGE_AGENDA = "Agenda";
const SESSION_PAGE_SECRETS = "GM Secrets";
const SESSION_PAGE_PINNED = "Pinned";

// -----------------------------------------------------------------------------
// computeSessionWindow(sessions, recapCount)
// -----------------------------------------------------------------------------
// v0.4.0 windowing (recap window made GM-configurable in v0.5.0): from
// the full server-side session list, keep only the sessions we want
// mirrored locally — all prep, the running one (if any), and the
// `recapCount` most-recently-ended sessions (the recap window).
// `recapCount` defaults to 1, which reproduces the historical
// single-recap behavior byte-for-byte. Everything older is pruned from
// Foundry by the orphan-cleanup pass in `pullAll`.
// -----------------------------------------------------------------------------
function computeSessionWindow(sessions, recapCount = 1) {
  // Defensive normalization — server might return null or an envelope.
  const list = Array.isArray(sessions) ? sessions : [];
  // Prep sessions: not yet started, not yet ended.
  const prep = list.filter((s) => s && !s.started_at && !s.ended_at);
  // At most one running session per campaign (server enforces).
  const running = list.find((s) => s && s.started_at && !s.ended_at);
  // Ended sessions sorted newest-first so slice(0, N) keeps the N most
  // recent recaps.
  const ended = list
    .filter((s) => s && s.ended_at)
    .sort((a, b) => {
      const ta = a.ended_at ? new Date(a.ended_at).getTime() : 0;
      const tb = b.ended_at ? new Date(b.ended_at).getTime() : 0;
      return tb - ta;
    });
  // Keep the top-N most-recently-ended sessions. N=1 -> slice(0,1) is
  // identical to the old `ended[0]`; N larger than the ended count
  // safely returns fewer.
  const recap = ended.slice(0, recapCount);
  // De-dupe via Map<id, session> in case the API returned duplicates
  // (and to give a deterministic order regardless of input order).
  const byId = new Map();
  for (const s of prep) if (s?.id) byId.set(s.id, s);
  if (running?.id) byId.set(running.id, running);
  for (const s of recap) if (s?.id) byId.set(s.id, s);
  return Array.from(byId.values());
}

// -----------------------------------------------------------------------------
// sessionJournalName(session)
// -----------------------------------------------------------------------------
// Human-readable journal name: "YYYY-MM-DD — Title". The date prefix
// makes the journal sidebar self-sort chronologically.
// -----------------------------------------------------------------------------
function sessionJournalName(session) {
  const ts = session?.created_at;
  // Fallback marker so a broken date doesn't render as "undefined — ...".
  let datePart = "????-??-??";
  if (typeof ts === "string" && ts.length >= 10) {
    // Take just the YYYY-MM-DD prefix of an ISO timestamp.
    datePart = ts.slice(0, 10);
  }
  const title = session?.title ?? "(untitled)";
  return `${datePart} — ${title}`;
}

// -----------------------------------------------------------------------------
// ensureSessionFolder()
// -----------------------------------------------------------------------------
// Idempotent: find-or-create the colored folder that holds all session
// journals. Returns the Folder instance so callers can attach new
// journals via { folder: <id> } at create time.
// -----------------------------------------------------------------------------
async function ensureSessionFolder() {
  // Folder is identified by name + type to survive renames of unrelated
  // folders (won't conflict with a Folder named "GMhub Sessions" of a
  // different document type).
  const existing = game.folders?.find?.(
    (f) => f?.type === "JournalEntry" && f?.name === SESSION_FOLDER_NAME
  );
  if (existing) return existing;
  return Folder.create({
    name: SESSION_FOLDER_NAME,
    type: "JournalEntry",
    color: "#6366f1"
  });
}

// -----------------------------------------------------------------------------
// _findEntityPageById(entityId)
// -----------------------------------------------------------------------------
// Walk every entity-kind journal (NPCs, Locations, ...) looking for a
// page whose `externalId` flag matches. Used by the pinned-card and
// scene-entity renderers to produce clickable content-links into
// already-pulled entities.
// -----------------------------------------------------------------------------
function _findEntityPageById(entityId) {
  if (!entityId) return null;
  // O(kinds × journals × pages) — acceptable for ~10s of journals and
  // a few hundred pages; not worth caching.
  for (const kind of Object.keys(KIND_JOURNAL_NAMES)) {
    const journal = game.journal.contents.find(
      (e) => e.getFlag(MODULE_ID, FLAG_KIND) === kind
    );
    if (!journal) continue;
    const page = journal.pages.contents.find(
      (p) => p.getFlag(MODULE_ID, FLAG_EXTERNAL_ID) === entityId
    );
    if (page) return page;
  }
  return null;
}

// -----------------------------------------------------------------------------
// _escapeHtml(s)
// -----------------------------------------------------------------------------
// Minimal entity-escape so user-supplied text (NPC names, scene titles,
// pin reasons, ...) can't break out of attribute or element context in
// the HTML we generate. Safer than relying on the browser's lenient
// parser to handle stray `<` or `&`.
// -----------------------------------------------------------------------------
function _escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// -----------------------------------------------------------------------------
// _firstParagraphFromHtml(html)
// -----------------------------------------------------------------------------
// Pull the first <p>…</p> from a rendered entity summary for the
// pinned-card blurb. Falls back to a truncated plain-text strip if no
// <p> wrapper is present (e.g. a raw text summary).
// -----------------------------------------------------------------------------
function _firstParagraphFromHtml(html) {
  if (!html) return "";
  const str = String(html);
  // Regex-based parse is fine here — these are server-generated bodies
  // from our own tiptapToHtml, not arbitrary user-pasted HTML.
  const match = str.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  if (match) {
    const inner = match[1].trim();
    // Skip empty <p>&nbsp;</p> placeholders that Tiptap emits.
    if (inner && inner !== "&nbsp;") return inner;
  }
  // No usable paragraph — strip all tags and ellipsize.
  const text = str.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

// -----------------------------------------------------------------------------
// _applyMarks(html, marks)
// -----------------------------------------------------------------------------
// Wrap an HTML string with the inline marks (bold, italic, link, ...)
// supplied by a Tiptap text node. Order of wrapping doesn't change
// semantics, so we just iterate in array order.
// -----------------------------------------------------------------------------
function _applyMarks(html, marks) {
  if (!Array.isArray(marks) || marks.length === 0) return html;
  let out = html;
  for (const mark of marks) {
    switch (mark?.type) {
      case "bold":      out = `<strong>${out}</strong>`; break;
      case "italic":    out = `<em>${out}</em>`; break;
      case "underline": out = `<u>${out}</u>`; break;
      case "strike":    out = `<s>${out}</s>`; break;
      case "code":      out = `<code>${out}</code>`; break;
      case "link": {
        // Escape the href to prevent attribute injection via `"`.
        const href = _escapeHtml(mark.attrs?.href ?? "#");
        out = `<a href="${href}" rel="noopener noreferrer">${out}</a>`;
        break;
      }
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// _nodeToHtml(node)
// -----------------------------------------------------------------------------
// Recursive Tiptap-JSON → HTML renderer. Covers the subset of node
// types the GMhub web app emits (doc, paragraph, heading, lists,
// blockquote, codeBlock, hardBreak, horizontalRule, mention, text).
// Unknown node types fall through to "render children, drop wrapper".
// -----------------------------------------------------------------------------
function _nodeToHtml(node) {
  if (!node || typeof node !== "object") return "";
  // Recurse into children first so the wrapper case below can splice.
  const kids = Array.isArray(node.content) ? node.content.map(_nodeToHtml).join("") : "";
  switch (node.type) {
    case "doc": return kids;
    // Empty paragraphs render &nbsp; so the block keeps its line height
    // (matches what Tiptap itself does in the web editor).
    case "paragraph": return `<p>${kids || "&nbsp;"}</p>`;
    case "heading": {
      // Clamp to valid <h1>-<h6> range; default to h1 if attrs malformed.
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 1));
      return `<h${level}>${kids}</h${level}>`;
    }
    case "text": return _applyMarks(_escapeHtml(node.text), node.marks);
    // Two-name aliases — Tiptap uses camelCase, ProseMirror snake_case.
    case "hardBreak":
    case "hard_break": return "<br>";
    case "horizontalRule":
    case "horizontal_rule": return "<hr>";
    case "bulletList":
    case "bullet_list": return `<ul>${kids}</ul>`;
    case "orderedList":
    case "ordered_list": return `<ol>${kids}</ol>`;
    case "listItem":
    case "list_item": return `<li>${kids}</li>`;
    case "blockquote": return `<blockquote>${kids}</blockquote>`;
    case "codeBlock":
    case "code_block": return `<pre><code>${kids}</code></pre>`;
    case "mention": {
      // @mentions render as a styled span carrying data attrs the
      // gmhub-mention CSS class targets; entity-type/id let future
      // hover-cards / clicks resolve back to the page.
      const label = _escapeHtml(node.attrs?.label ?? node.attrs?.id ?? "");
      const entityType = _escapeHtml(node.attrs?.entityType ?? "");
      const id = _escapeHtml(node.attrs?.id ?? "");
      return `<span class="gmhub-mention" data-entity-type="${entityType}" data-entity-id="${id}">@${label}</span>`;
    }
    // Unknown node type — keep children, drop the wrapper. Forgiving
    // by design so a new Tiptap node type doesn't break the entire pull.
    default: return kids;
  }
}

// -----------------------------------------------------------------------------
// tiptapToHtml(input)
// -----------------------------------------------------------------------------
// Public renderer. Accepts a parsed Tiptap-JSON object, a JSON string,
// or a raw HTML string (in which case it passes through unchanged —
// the gmhub-app server sometimes returns already-rendered HTML).
// -----------------------------------------------------------------------------
export function tiptapToHtml(input) {
  if (input == null) return "";
  if (typeof input === "string") {
    const trimmed = input.trim();
    // Heuristic: if it starts with `{` and ends with `}`, try JSON
    // parse first. Otherwise treat as raw HTML.
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        return _nodeToHtml(JSON.parse(trimmed));
      } catch {
        // Looked like JSON but didn't parse — pass through the string.
        return input;
      }
    }
    return input;
  }
  if (typeof input === "object") return _nodeToHtml(input);
  return "";
}

// -----------------------------------------------------------------------------
// ownershipLevels()
// -----------------------------------------------------------------------------
// Thin wrapper to centralize the Foundry constants we use. Keeps the
// rest of the file free of the long `CONST.DOCUMENT_OWNERSHIP_LEVELS`
// path and makes the call sites read like English.
// -----------------------------------------------------------------------------
function ownershipLevels() {
  return {
    NONE: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE,
    OBSERVER: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER,
    OWNER: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER
  };
}

// -----------------------------------------------------------------------------
// gmUserId()
// -----------------------------------------------------------------------------
// Pick a sensible "GM" user id to grant OWNER ownership to on every
// synced page. Prefers the first user with `isGM` true; falls back to
// the current user (covers worlds with no GM logged in at sync time).
// -----------------------------------------------------------------------------
function gmUserId() {
  return game.users.find((u) => u.isGM)?.id ?? game.user.id;
}

// -----------------------------------------------------------------------------
// _playerMap()
// -----------------------------------------------------------------------------
// Safe accessor for the GM-curated GMhub-user → Foundry-user map. The
// try/catch covers the case where Foundry hasn't initialized the
// settings store yet (very early hooks).
// -----------------------------------------------------------------------------
function _playerMap() {
  try {
    return game.settings.get(MODULE_ID, "playerMap") ?? {};
  } catch {
    return {};
  }
}

/**
 * Compute Foundry's per-page ownership map from the unified GMhub
 * visibility tuple.
 *
 * @param {object} args
 * @param {string} args.visibility one of `private` / `shared` / `everyone`
 *                                 (legacy values are mapped to safe defaults).
 * @param {string[]} args.recipients GMhub user ids granted access when
 *                                   visibility is `shared`.
 * @returns {{ ownership: Record<string, number>, skippedRecipients: string[] }}
 */
export function computePageOwnership({ visibility, recipients } = {}) {
  const { NONE, OBSERVER, OWNER } = ownershipLevels();
  const gmId = gmUserId();
  // Recipients that couldn't be mapped — collected so the caller can
  // warn the GM exactly once per Pull rather than per page.
  const skippedRecipients = [];

  // shared: GM owns + each mapped recipient gets OBSERVER.
  if (visibility === "shared") {
    const map = _playerMap();
    const ownership = { default: NONE, [gmId]: OWNER };
    for (const gmhubUserId of recipients ?? []) {
      const foundryUserId = map?.[gmhubUserId];
      // Only apply if the mapped Foundry user actually exists in this world.
      if (foundryUserId && game.users?.get?.(foundryUserId)) {
        ownership[foundryUserId] = OBSERVER;
      } else {
        skippedRecipients.push(gmhubUserId);
      }
    }
    return { ownership, skippedRecipients };
  }

  // everyone (+ legacy aliases): default ownership is OBSERVER for all.
  if (visibility === "everyone" || visibility === "campaign" || visibility === "players_only") {
    return { ownership: { default: OBSERVER, [gmId]: OWNER }, skippedRecipients };
  }

  // `private`, `gm_only`, or anything unknown — hide from non-GMs.
  return { ownership: { default: NONE, [gmId]: OWNER }, skippedRecipients };
}

// -----------------------------------------------------------------------------
// SESSION_PLAN_FLAGS / SESSION_PLAN_PAGE_NAMES
// -----------------------------------------------------------------------------
// Re-exports for ui.js so the AgendaEditorDialog can look up the right
// flag key / page name from its `kind` constructor arg without
// importing the per-field constants directly.
// -----------------------------------------------------------------------------
export const SESSION_PLAN_FLAGS = {
  agenda: FLAG_AGENDA_DATA,
  pinned: FLAG_PINNED_DATA
};

export const SESSION_PLAN_PAGE_NAMES = {
  agenda: SESSION_PAGE_AGENDA,
  pinned: SESSION_PAGE_PINNED
};

// Thin re-exports so the editor dialog can re-render preview HTML
// without reaching for the private helpers.
export function renderAgendaHtml(agenda) { return agendaHtml(agenda); }
export function renderPinnedHtml(pinned) { return pinnedHtml(pinned); }

// -----------------------------------------------------------------------------
// pinnedHtml(pinned)
// -----------------------------------------------------------------------------
// Render the Pinned page body for a session. Each pin is a card:
//   [type chip] [name (clickable if entity is in this world)]
//   [first paragraph of the linked entity's summary]
//   [optional pin_reason as a styled blockquote]
// Empty state when no pins exist.
// -----------------------------------------------------------------------------
function pinnedHtml(pinned) {
  if (!Array.isArray(pinned) || pinned.length === 0) {
    return "<p><em>No pinned entities.</em></p>";
  }
  const items = pinned
    .map((pin) => {
      // Pull the per-pin fields out, escaping each as we go.
      const entityType = _escapeHtml(pin?.entity_type ?? "");
      const name = _escapeHtml(pin?.name ?? "(unknown)");
      const entityId = pin?.entity_id ?? null;
      // Trim the reason and require non-empty so we don't render an
      // empty blockquote when the field is `""`.
      const reason = typeof pin?.pin_reason === "string" && pin.pin_reason.trim().length > 0
        ? pin.pin_reason.trim()
        : null;
      // Lookup is best-effort — entities not yet pulled render as
      // a plain span with an "Entity not in this Foundry world" notice.
      const entityPage = _findEntityPageById(entityId);
      let nameHtml;
      let blurbHtml;
      if (entityPage) {
        // Foundry content-link DOM: a single <a class="content-link"
        // data-uuid=...> with `draggable="true"` is what Foundry's
        // enricher recognizes. We emit it directly (no enrich pass needed).
        const uuid = _escapeHtml(entityPage.uuid);
        nameHtml = `<a class="content-link gmhub-pinned-name" data-uuid="${uuid}" data-entity-type="${entityType}" data-entity-id="${_escapeHtml(entityId ?? "")}" draggable="true"><i class="fas fa-book-open"></i> ${name}</a>`;
        const blurb = _firstParagraphFromHtml(entityPage.text?.content ?? "");
        blurbHtml = blurb
          ? `<div class="gmhub-pinned-blurb">${blurb}</div>`
          : `<div class="gmhub-pinned-blurb gmhub-empty-state">No summary on the linked entity yet.</div>`;
      } else {
        // Not pulled (or different campaign) — plain name, no link.
        nameHtml = `<span class="gmhub-pinned-name">${name}</span>`;
        blurbHtml = `<div class="gmhub-pinned-blurb gmhub-empty-state">Entity not in this Foundry world — Pull to populate.</div>`;
      }
      // Reason renders below the blurb when present (forward-compatible
      // with the gmhub-app pin-reason feature added 2026-05-09).
      const reasonHtml = reason ? `<div class="gmhub-pinned-reason">“${_escapeHtml(reason)}”</div>` : "";
      return `<li class="gmhub-pinned-card" data-entity-type="${entityType}" data-entity-id="${_escapeHtml(entityId ?? "")}">\n  <div class="gmhub-pinned-header">\n    <span class="gmhub-pinned-type">${entityType}</span>\n    ${nameHtml}\n  </div>\n  ${blurbHtml}\n  ${reasonHtml}\n</li>`;
    })
    .join("\n");
  return `<ul class="gmhub-pinned-list">\n${items}\n</ul>`;
}

// -----------------------------------------------------------------------------
// agendaHtml(agenda)
// -----------------------------------------------------------------------------
// Render the Agenda page body for a session: an <ol> where each scene
// is a list item with title, optional duration, prose notes, and a row
// of entity chips (clickable when the entity is in this world).
// -----------------------------------------------------------------------------
function agendaHtml(agenda) {
  if (!Array.isArray(agenda) || agenda.length === 0) {
    return "<p><em>No agenda items.</em></p>";
  }
  const items = agenda
    .map((scene) => {
      const title = _escapeHtml(scene?.title ?? "(untitled)");
      // Only emit the duration suffix when there's a real number to show.
      const dur = scene?.estimated_duration_min ? ` <em>(${Number(scene.estimated_duration_min)}m)</em>` : "";
      // Plain-text notes — wrap in <p> for spacing.
      const notes = scene?.notes ? `<p>${_escapeHtml(scene.notes)}</p>` : "";
      // Per-scene entity chips. The same "is it in this world?" check
      // as pinnedHtml: clickable when present, plain span otherwise.
      const entitiesArr = Array.isArray(scene?.entities) ? scene.entities : [];
      const entities = entitiesArr.length
        ? `<p class="gmhub-scene-entities">${entitiesArr
            .map((e) => {
              const entityName = _escapeHtml(e?.name ?? "");
              const type = _escapeHtml(e?.entityType ?? "");
              const id = _escapeHtml(e?.id ?? "");
              const entityPage = _findEntityPageById(e?.id);
              if (entityPage) {
                const uuid = _escapeHtml(entityPage.uuid);
                return `<a class="content-link gmhub-scene-entity-chip" data-uuid="${uuid}" data-entity-type="${type}" data-entity-id="${id}" draggable="true">${entityName}</a>`;
              }
              return `<span class="gmhub-scene-entity-chip" data-entity-type="${type}" data-entity-id="${id}">${entityName}</span>`;
            })
            .join(" ")}</p>`
        : "";
      return `<li><strong>${title}</strong>${dur}${notes}${entities}</li>`;
    })
    .join("\n");
  return `<ol>\n${items}\n</ol>`;
}

// -----------------------------------------------------------------------------
// SyncService
// -----------------------------------------------------------------------------
// The Pull/Push orchestrator. Constructed once at `ready` time with a
// GmhubClient. Stateless across calls — every operation re-reads
// settings + journal contents fresh.
// -----------------------------------------------------------------------------
export class SyncService {
  constructor(client) {
    // The only injected dependency. Easy to mock for future tests.
    this.client = client;
  }

  // ---------------------------------------------------------------------------
  // _findOrCreateJournal(name, kind, extraFlags)
  // ---------------------------------------------------------------------------
  // Idempotent: find the JournalEntry of a given `kind`, or create it.
  // Renames an existing journal if the canonical name has changed
  // (e.g. a future re-skin of KIND_JOURNAL_NAMES).
  // ---------------------------------------------------------------------------
  async _findOrCreateJournal(name, kind, extraFlags = {}) {
    const existing = game.journal.contents.find(
      (e) => e.getFlag(MODULE_ID, FLAG_KIND) === kind
    );
    if (existing) {
      if (existing.name !== name) await existing.update({ name });
      return existing;
    }
    // Stamp `kind` flag at create time so future lookups find us.
    return JournalEntry.create({
      name,
      flags: { [MODULE_ID]: { [FLAG_KIND]: kind, ...extraFlags } }
    });
  }

  // Find a session journal by GMhub session id (matched on externalId flag).
  _findSessionJournal(sessionId) {
    if (!sessionId) return null;
    return (
      game.journal.contents.find(
        (e) =>
          e.getFlag(MODULE_ID, FLAG_KIND) === "session" &&
          e.getFlag(MODULE_ID, FLAG_EXTERNAL_ID) === sessionId
      ) ?? null
    );
  }

  // Every session-kind journal in the world. Used by Push (gather
  // dirty session plans) and Pull (orphan cleanup).
  _allSessionJournals() {
    return game.journal.contents.filter(
      (e) => e.getFlag(MODULE_ID, FLAG_KIND) === "session"
    );
  }

  // Find a page inside a journal by externalId flag.
  _findPageByExternalId(journal, externalId) {
    return (
      journal.pages.contents.find(
        (p) => p.getFlag(MODULE_ID, FLAG_EXTERNAL_ID) === externalId
      ) ?? null
    );
  }

  // ---------------------------------------------------------------------------
  // _entityPagePayload(entity)
  // ---------------------------------------------------------------------------
  // Build the JournalEntryPage payload for an entity Pull. Renders the
  // Tiptap summary to HTML, computes per-user ownership, and stamps the
  // module flags. Returns both the payload and any recipients that
  // couldn't be mapped (so the caller can aggregate the warning).
  // ---------------------------------------------------------------------------
  _entityPagePayload(entity) {
    const recipients = Array.isArray(entity?.recipients) ? entity.recipients : [];
    const { ownership, skippedRecipients } = computePageOwnership({
      visibility: entity.visibility,
      recipients
    });
    return {
      payload: {
        name: entity.name,
        type: "text",
        // format: 1 = HTML (vs 2 = Markdown). We always send HTML.
        text: { content: tiptapToHtml(entity.summary), format: 1 },
        ownership,
        flags: {
          [MODULE_ID]: {
            [FLAG_EXTERNAL_ID]: entity.id,
            [FLAG_ENTITY_TYPE]: entity.entity_type,
            [FLAG_VISIBILITY]: entity.visibility,
            [FLAG_REVEALED_AT]: entity.revealed_at,
            [FLAG_RECIPIENTS]: recipients,
            // Just-pulled = clean by definition. Cleared so a later
            // Push doesn't try to re-send this same data right back.
            [FLAG_DIRTY]: false
          }
        }
      },
      skippedRecipients
    };
  }

  // ---------------------------------------------------------------------------
  // _notePagePayload(note)
  // ---------------------------------------------------------------------------
  // Sibling of _entityPagePayload for notes (no entity_type / revealed_at).
  // ---------------------------------------------------------------------------
  _notePagePayload(note) {
    const recipients = Array.isArray(note?.recipients) ? note.recipients : [];
    const { ownership, skippedRecipients } = computePageOwnership({
      visibility: note.visibility,
      recipients
    });
    return {
      payload: {
        name: note.title ?? "Untitled note",
        type: "text",
        text: { content: tiptapToHtml(note.body), format: 1 },
        ownership,
        flags: {
          [MODULE_ID]: {
            [FLAG_EXTERNAL_ID]: note.id,
            [FLAG_VISIBILITY]: note.visibility,
            [FLAG_RECIPIENTS]: recipients,
            [FLAG_DIRTY]: false
          }
        }
      },
      skippedRecipients
    };
  }

  // ---------------------------------------------------------------------------
  // _upsertPage(journal, externalId, payload)
  // ---------------------------------------------------------------------------
  // Update-or-create a page by externalId. Wraps the embedded-document
  // batch APIs so callers don't have to remember the singleton-array
  // signature.
  // ---------------------------------------------------------------------------
  async _upsertPage(journal, externalId, payload) {
    const existing = this._findPageByExternalId(journal, externalId);
    if (existing) {
      // Update path: include the _id in the payload (Foundry's update
      // API matches by _id within the array).
      await journal.updateEmbeddedDocuments("JournalEntryPage", [
        { _id: existing.id, ...payload }
      ]);
      return existing.id;
    }
    const [created] = await journal.createEmbeddedDocuments("JournalEntryPage", [payload]);
    return created.id;
  }

  // ---------------------------------------------------------------------------
  // _upsertSessionJournal(session, plan, folder)
  // ---------------------------------------------------------------------------
  // Build (or update) the per-session JournalEntry and its four pages:
  // GM Notes, Agenda, GM Secrets (optional), Pinned. Each page is
  // GM-only (NONE/OWNER) — sessions are never shared with players.
  // ---------------------------------------------------------------------------
  async _upsertSessionJournal(session, plan, folder) {
    const sessionId = session?.id;
    if (!sessionId) return null;
    const newName = sessionJournalName(session);
    // Folder might be null on the very first call (we only create the
    // folder when there's at least one session in the window).
    const folderId = folder?.id ?? null;

    let journal = this._findSessionJournal(sessionId);
    if (!journal) {
      // Create-path: stamp `kind` + `externalId` so future Pulls can
      // find this journal again without relying on the (mutable) name.
      journal = await JournalEntry.create({
        name: newName,
        folder: folderId,
        flags: { [MODULE_ID]: { [FLAG_KIND]: "session", [FLAG_EXTERNAL_ID]: sessionId } }
      });
    } else {
      // Update-path: re-sync name + folder if they've drifted (e.g.
      // session title was edited in the web app).
      const updates = {};
      if (journal.name !== newName) updates.name = newName;
      if (folderId && journal.folder?.id !== folderId) updates.folder = folderId;
      if (Object.keys(updates).length) await journal.update(updates);
    }

    // All four pages get GM-only ownership; sessions never leak to players.
    const { NONE, OWNER } = ownershipLevels();
    const gmOnly = { default: NONE, [gmUserId()]: OWNER };

    // --- GM Notes -----------------------------------------------------------
    // Free-form prose. Synthetic externalId so the upsert lookup works
    // without a server-side primary key for individual plan fields.
    await this._upsertPage(journal, `${sessionId}:gm_notes`, {
      name: SESSION_PAGE_GM_NOTES,
      type: "text",
      text: { content: tiptapToHtml(plan?.gm_notes), format: 1 },
      ownership: gmOnly,
      flags: { [MODULE_ID]: { [FLAG_EXTERNAL_ID]: `${sessionId}:gm_notes`, [FLAG_DIRTY]: false } }
    });
    // --- Agenda -------------------------------------------------------------
    // Rendered HTML for display + raw structured `agendaItems` flag for
    // the editor dialog and for Push (canonical Scene shape).
    await this._upsertPage(journal, `${sessionId}:agenda`, {
      name: SESSION_PAGE_AGENDA,
      type: "text",
      text: { content: agendaHtml(plan?.agenda), format: 1 },
      ownership: gmOnly,
      flags: {
        [MODULE_ID]: {
          [FLAG_EXTERNAL_ID]: `${sessionId}:agenda`,
          [FLAG_DIRTY]: false,
          [FLAG_AGENDA_DATA]: Array.isArray(plan?.agenda) ? plan.agenda : []
        }
      }
    });
    // --- GM Secrets (optional) ---------------------------------------------
    // Only render this page when the server actually returned the field
    // — keys missing from the plan response mean the token lacks the
    // `sessions:secrets` scope and we don't want to display blank
    // pages that mask the omission.
    if (plan && Object.prototype.hasOwnProperty.call(plan, "gm_secrets")) {
      await this._upsertPage(journal, `${sessionId}:gm_secrets`, {
        name: SESSION_PAGE_SECRETS,
        type: "text",
        text: { content: tiptapToHtml(plan.gm_secrets), format: 1 },
        ownership: gmOnly,
        flags: { [MODULE_ID]: { [FLAG_EXTERNAL_ID]: `${sessionId}:gm_secrets`, [FLAG_DIRTY]: false } }
      });
    }
    // --- Pinned -------------------------------------------------------------
    // Same pattern as Agenda: rendered display + raw structured data
    // flag for round-tripping.
    await this._upsertPage(journal, `${sessionId}:pinned`, {
      name: SESSION_PAGE_PINNED,
      type: "text",
      text: { content: pinnedHtml(plan?.pinned), format: 1 },
      ownership: gmOnly,
      flags: {
        [MODULE_ID]: {
          [FLAG_EXTERNAL_ID]: `${sessionId}:pinned`,
          [FLAG_DIRTY]: false,
          [FLAG_PINNED_DATA]: Array.isArray(plan?.pinned) ? plan.pinned : []
        }
      }
    });

    return journal;
  }

  // ---------------------------------------------------------------------------
  // _findDirtyEntries()
  // ---------------------------------------------------------------------------
  // Returns every JournalEntry that has unpushed local edits — either
  // at the entry level (rare; the entry itself was renamed) or in any
  // of its pages. Used by the Pull confirm dialog and by the
  // orphan-cleanup safety net.
  // ---------------------------------------------------------------------------
  _findDirtyEntries() {
    return game.journal.contents.filter((entry) => {
      if (entry.getFlag(MODULE_ID, FLAG_DIRTY)) return true;
      return entry.pages.contents.some((p) => p.getFlag(MODULE_ID, FLAG_DIRTY));
    });
  }

  // ---------------------------------------------------------------------------
  // pullAll({ confirmOverwrite })
  // ---------------------------------------------------------------------------
  // The Pull pipeline, as a thin orchestrator over four private
  // per-resource-kind steps. Each step isolates its own error
  // accumulation into `result.errors` so one bad page/kind doesn't abort
  // the run. Order (unchanged): entities → notes → unmapped-recipients
  // warning → sessions → orphan cleanup → lastPullAt stamp → return.
  //
  // v0.5.0 hardening: orphan cleanup runs ONLY when the session-list
  // fetch succeeded. On a list-fetch failure we have no authoritative
  // window, so deleting local session journals would wipe the GM's
  // archive on a transient error — we skip cleanup entirely instead.
  // ---------------------------------------------------------------------------
  async pullAll({ confirmOverwrite } = {}) {
    const campaignId = game.settings.get(MODULE_ID, "campaignId");
    if (!campaignId) return { cancelled: false, error: "no_campaign_bound" };

    // Safety prompt: if there's local unpushed work, ask before clobbering.
    const dirty = this._findDirtyEntries();
    if (dirty.length && typeof confirmOverwrite === "function") {
      const confirmed = await confirmOverwrite(dirty);
      if (!confirmed) return { cancelled: true };
    }

    // Per-resource counters + a flat error list shown in the sync dialog.
    const result = { pulled: { entities: 0, notes: 0, sessions: 0 }, errors: [] };
    // Set so we deduplicate across multiple pages from the same recipient.
    // Shared across the entity + note steps; drained into one toast below.
    const unmapped = new Set();

    // Entities and notes both mutate the shared `unmapped` set.
    await this._pullEntities(campaignId, result, unmapped);
    await this._pullNotes(campaignId, result, unmapped);

    // --- Unmapped-recipients warning ---------------------------------------
    // One toast per Pull, not one per page. Tells the GM exactly which
    // GMhub user ids need a Foundry-user mapping. Runs once, after both
    // entities and notes have contributed to `unmapped`.
    if (unmapped.size > 0) {
      const list = Array.from(unmapped).join(", ");
      ui.notifications?.warn(
        game.i18n.format("GMHUB.Warn.UnmappedRecipients", {
          count: unmapped.size,
          ids: list
        })
      );
    }

    // --- Sessions (windowed) + orphan cleanup ------------------------------
    const sessions = await this._pullSessions(campaignId, result);
    // Guard the destructure so a future missing-return can't crash cleanup.
    const pulledSessionIds = sessions?.pulledSessionIds ?? new Set();
    // Only clean up orphans when we have an authoritative window — i.e.
    // the list fetch succeeded. Skipping on failure protects the archive.
    if (sessions?.listOk) {
      await this._cleanupOrphanSessions(pulledSessionIds, result);
    }

    // Stamp the last-pull timestamp so the SyncDialog can display it.
    await game.settings.set(MODULE_ID, "lastPullAt", new Date().toISOString());
    return result;
  }

  // ---------------------------------------------------------------------------
  // _pullEntities(campaignId, result, unmapped)
  // ---------------------------------------------------------------------------
  // Pull every entity kind (NPCs / Locations / Factions / Items / Quests
  // / Lore) into its kind-journal. Per-kind try/catch so one failing
  // kind doesn't abort the rest; skipped recipients accumulate into the
  // shared `unmapped` set for the caller's single warning.
  // ---------------------------------------------------------------------------
  async _pullEntities(campaignId, result, unmapped) {
    for (const [kind, journalName] of Object.entries(KIND_JOURNAL_NAMES)) {
      try {
        const journal = await this._findOrCreateJournal(journalName, kind);
        // Stream-iterate to keep memory bounded for large campaigns.
        for await (const entity of this.client.iterateAll(
          (opts) => this.client.listEntities(campaignId, { ...opts, type: kind, limit: 100 }),
          {}
        )) {
          const { payload, skippedRecipients } = this._entityPagePayload(entity);
          for (const id of skippedRecipients) unmapped.add(id);
          await this._upsertPage(journal, entity.id, payload);
          result.pulled.entities += 1;
        }
        // Clear any leftover dirty flag from a previous failed Push so
        // the user doesn't get the overwrite warning forever.
        await journal.unsetFlag(MODULE_ID, FLAG_DIRTY).catch(() => {});
      } catch (err) {
        // Per-kind failure isolation — record and continue.
        result.errors.push({ name: journalName, message: err.message ?? String(err) });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // _pullNotes(campaignId, result, unmapped)
  // ---------------------------------------------------------------------------
  // Pull long-form notes into the single Notes journal. One try/catch
  // around the whole block; skipped recipients feed the shared set.
  // ---------------------------------------------------------------------------
  async _pullNotes(campaignId, result, unmapped) {
    try {
      const notesJournal = await this._findOrCreateJournal(NOTES_JOURNAL_NAME, "notes");
      for await (const note of this.client.iterateAll(
        (opts) => this.client.listNotes(campaignId, { ...opts, limit: 100 }),
        {}
      )) {
        const { payload, skippedRecipients } = this._notePagePayload(note);
        for (const id of skippedRecipients) unmapped.add(id);
        await this._upsertPage(notesJournal, note.id, payload);
        result.pulled.notes += 1;
      }
      await notesJournal.unsetFlag(MODULE_ID, FLAG_DIRTY).catch(() => {});
    } catch (err) {
      result.errors.push({ name: NOTES_JOURNAL_NAME, message: err.message ?? String(err) });
    }
  }

  // ---------------------------------------------------------------------------
  // _pullSessions(campaignId, result)
  // ---------------------------------------------------------------------------
  // Pull the windowed session set: read the GM-configurable recap count,
  // compute the window, and upsert each session's journal with per-session
  // failure isolation. Always returns `{ pulledSessionIds, listOk }` —
  // `pulledSessionIds` is a Set of the session ids we successfully wrote
  // (authoritative for orphan cleanup), and `listOk` is false only when
  // the session-LIST fetch itself failed (a per-session plan error keeps
  // `listOk` true, matching the historical orphan-cleanup behavior).
  // ---------------------------------------------------------------------------
  async _pullSessions(campaignId, result) {
    // Track which sessions we successfully wrote so orphan cleanup can
    // delete anything *not* in the active window.
    const pulledSessionIds = new Set();
    try {
      const sessionsList = await this.client.listSessions(campaignId);
      // GM-configurable recap window (v0.5.0). Clamp a blank/NaN/0/
      // negative setting back to 1 so the window can never collapse to
      // "no recap"; default 1 reproduces the historical behavior.
      const rawRecap = Number(game.settings.get(MODULE_ID, "sessionRecapCount"));
      const recapCount = Number.isFinite(rawRecap) && rawRecap >= 1 ? Math.floor(rawRecap) : 1;
      const window = computeSessionWindow(sessionsList ?? [], recapCount);
      // Only create the folder when there's at least one session to put in it.
      const folder = window.length > 0 ? await ensureSessionFolder() : null;
      for (const session of window) {
        try {
          const plan = await this.client.getSessionPlan(campaignId, session.id);
          await this._upsertSessionJournal(session, plan, folder);
          pulledSessionIds.add(session.id);
          result.pulled.sessions += 1;
        } catch (err) {
          // Per-session failure isolation — keep going so a single
          // permissions error doesn't kill the entire Pull.
          result.errors.push({
            name: `session ${sessionJournalName(session)}`,
            message: err.message ?? String(err)
          });
        }
      }
      // The list fetch succeeded — cleanup is safe to run.
      return { pulledSessionIds, listOk: true };
    } catch (err) {
      result.errors.push({ name: "sessions-list", message: err.message ?? String(err) });
      // List fetch failed — signal the orchestrator to SKIP cleanup so a
      // transient error doesn't wipe the GM's local session archive.
      return { pulledSessionIds, listOk: false };
    }
  }

  // ---------------------------------------------------------------------------
  // _cleanupOrphanSessions(pulledSessionIds, result)
  // ---------------------------------------------------------------------------
  // Delete local session journals that fell outside the active window —
  // either ended long ago (older than the newest ended ones we kept) or
  // deleted in the web app. A journal carrying unpushed dirty edits is
  // skipped and surfaced in one aggregate warning instead of deleted.
  // Only called when the session-list fetch succeeded (see pullAll).
  // ---------------------------------------------------------------------------
  async _cleanupOrphanSessions(pulledSessionIds, result) {
    const orphans = this._allSessionJournals().filter(
      (e) => !pulledSessionIds.has(e.getFlag(MODULE_ID, FLAG_EXTERNAL_ID))
    );
    const skippedDirty = [];
    for (const orphan of orphans) {
      const dirtyEntry = orphan.getFlag(MODULE_ID, FLAG_DIRTY);
      const dirtyPage = orphan.pages.contents.some((p) => p.getFlag(MODULE_ID, FLAG_DIRTY));
      if (dirtyEntry || dirtyPage) {
        skippedDirty.push(orphan.name);
        continue;
      }
      try {
        await orphan.delete();
      } catch (err) {
        result.errors.push({
          name: `orphan ${orphan.name}`,
          message: err.message ?? String(err)
        });
      }
    }
    // One aggregate warning for any dirty orphans we couldn't auto-clean.
    if (skippedDirty.length) {
      ui.notifications?.warn(
        `[gmhub-vtt] Skipped ${skippedDirty.length} stale session journal(s) with unpushed edits: ${skippedDirty.join(", ")}. Push or delete manually before next Pull.`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // _drainQuickNoteQueue(campaignId, sessionId, result)
  // ---------------------------------------------------------------------------
  // Pop everything in the pendingPushQueue setting, post each item to
  // the active session's /quick-notes endpoint, and rewrite the setting
  // with only the items that failed (so they're retried on the next Push).
  // ---------------------------------------------------------------------------
  async _drainQuickNoteQueue(campaignId, sessionId, result) {
    // No active session → nothing to drain into. We leave the queue
    // intact so the next session start can pick it up.
    if (!sessionId) return;
    const queue = game.settings.get(MODULE_ID, "pendingPushQueue") ?? [];
    if (!queue.length) return;
    // Items that failed this round — written back to the setting.
    const remaining = [];
    for (const item of queue) {
      try {
        await this.client.addQuickNote(campaignId, sessionId, {
          body: item.body,
          mentioned_entity_id: item.mentioned_entity_id ?? null
        });
        result.pushed.quickNotes += 1;
      } catch (err) {
        // Retain the item for next time; record the failure for display.
        remaining.push(item);
        result.errors.push({ name: "quick-note", message: err.message ?? String(err) });
      }
    }
    await game.settings.set(MODULE_ID, "pendingPushQueue", remaining);
  }

  // ---------------------------------------------------------------------------
  // _pushEntityPage(campaignId, kind, page, result)
  // ---------------------------------------------------------------------------
  // Push a single entity page back to GMhub. If there's no externalId
  // yet we POST to create; otherwise PATCH. Clears the dirty flag on
  // success and records per-failure detail on errors.
  // ---------------------------------------------------------------------------
  async _pushEntityPage(campaignId, kind, page, result) {
    const externalId = page.getFlag(MODULE_ID, FLAG_EXTERNAL_ID);
    // Fall back to safe defaults so a brand-new (never-pulled) page
    // pushes as `private` with no recipients.
    const visibility = page.getFlag(MODULE_ID, FLAG_VISIBILITY) ?? "private";
    const recipients = page.getFlag(MODULE_ID, FLAG_RECIPIENTS) ?? [];
    const payload = {
      entity_type: kind,
      name: page.name,
      summary: page.text?.content ?? "",
      visibility,
      // Defensive normalize — flags can hold odd shapes from manual edits.
      recipients: Array.isArray(recipients) ? recipients : []
    };
    try {
      if (externalId) {
        // PATCH path: only send the fields the server understands.
        await this.client.updateEntity(campaignId, externalId, {
          name: payload.name,
          summary: payload.summary,
          visibility: payload.visibility,
          recipients: payload.recipients
        });
      } else {
        // POST path: server returns the new row with its assigned id;
        // stamp that back onto the page so future Pushes PATCH instead.
        const row = await this.client.createEntity(campaignId, payload);
        await page.setFlag(MODULE_ID, FLAG_EXTERNAL_ID, row.id);
      }
      await page.setFlag(MODULE_ID, FLAG_DIRTY, false);
      result.pushed.entities += 1;
    } catch (err) {
      result.failed += 1;
      // Preserve the server's body object so the error-toaster can
      // pattern-match on `reason` rather than a flattened string.
      result.errors.push({
        name: page.name,
        message: err.message ?? String(err),
        body: err.body ?? null
      });
    }
  }

  // ---------------------------------------------------------------------------
  // _pushNotePage(campaignId, page, result)
  // ---------------------------------------------------------------------------
  // Sibling of _pushEntityPage for notes. Same create-or-PATCH pattern;
  // body field is `body` instead of `summary`, no entity_type.
  // ---------------------------------------------------------------------------
  async _pushNotePage(campaignId, page, result) {
    const externalId = page.getFlag(MODULE_ID, FLAG_EXTERNAL_ID);
    const visibility = page.getFlag(MODULE_ID, FLAG_VISIBILITY) ?? "private";
    const recipients = page.getFlag(MODULE_ID, FLAG_RECIPIENTS) ?? [];
    const payload = {
      title: page.name,
      body: page.text?.content ?? "",
      visibility,
      recipients: Array.isArray(recipients) ? recipients : []
    };
    try {
      if (externalId) {
        await this.client.updateNote(campaignId, externalId, payload);
      } else {
        const row = await this.client.createNote(campaignId, payload);
        await page.setFlag(MODULE_ID, FLAG_EXTERNAL_ID, row.id);
      }
      await page.setFlag(MODULE_ID, FLAG_DIRTY, false);
      result.pushed.notes += 1;
    } catch (err) {
      result.failed += 1;
      result.errors.push({
        name: page.name,
        message: err.message ?? String(err),
        body: err.body ?? null
      });
    }
  }

  // ---------------------------------------------------------------------------
  // _pushSessionPlan(campaignId, sessionId, result)
  // ---------------------------------------------------------------------------
  // Partial PATCH of the session plan: only the dirty pages contribute
  // fields to the request. Skips entirely if no plan page is dirty.
  // ---------------------------------------------------------------------------
  async _pushSessionPlan(campaignId, sessionId, result) {
    const journal = this._findSessionJournal(sessionId);
    if (!journal) return;
    // Index pages by name once so the four lookups below are O(1).
    const byName = new Map();
    for (const p of journal.pages.contents) byName.set(p.name, p);

    // Build the PATCH body field-by-field — only dirty pages contribute.
    const partial = {};
    const gmNotes = byName.get(SESSION_PAGE_GM_NOTES);
    if (gmNotes && gmNotes.getFlag(MODULE_ID, FLAG_DIRTY)) {
      partial.gm_notes = gmNotes.text?.content ?? "";
    }
    const secrets = byName.get(SESSION_PAGE_SECRETS);
    if (secrets && secrets.getFlag(MODULE_ID, FLAG_DIRTY)) {
      partial.gm_secrets = secrets.text?.content ?? "";
    }
    const agendaPage = byName.get(SESSION_PAGE_AGENDA);
    if (agendaPage && agendaPage.getFlag(MODULE_ID, FLAG_DIRTY)) {
      // Agenda goes back as the canonical structured array, not the
      // rendered HTML — that's why we keep `agendaItems` in flags.
      partial.agenda = agendaPage.getFlag(MODULE_ID, FLAG_AGENDA_DATA) ?? [];
    }
    const pinnedPage = byName.get(SESSION_PAGE_PINNED);
    if (pinnedPage && pinnedPage.getFlag(MODULE_ID, FLAG_DIRTY)) {
      // Same structured-not-HTML rule for pinned.
      partial.pinned = pinnedPage.getFlag(MODULE_ID, FLAG_PINNED_DATA) ?? [];
    }
    // No dirty pages → no-op (saves a redundant network call).
    if (Object.keys(partial).length === 0) return;

    try {
      await this.client.updateSessionPlan(campaignId, sessionId, partial);
      // Only clear the dirty flag on pages that we actually sent — a
      // page we didn't touch shouldn't lose its dirty marker.
      if (gmNotes) await gmNotes.setFlag(MODULE_ID, FLAG_DIRTY, false);
      if (secrets && partial.gm_secrets !== undefined) await secrets.setFlag(MODULE_ID, FLAG_DIRTY, false);
      if (agendaPage && partial.agenda !== undefined) await agendaPage.setFlag(MODULE_ID, FLAG_DIRTY, false);
      if (pinnedPage && partial.pinned !== undefined) await pinnedPage.setFlag(MODULE_ID, FLAG_DIRTY, false);
      result.pushed.sessionPlans += 1;
    } catch (err) {
      result.failed += 1;
      result.errors.push({
        name: `session-plan ${journal.name}`,
        message: err.message ?? String(err),
        body: err.body ?? null
      });
    }
  }

  // ---------------------------------------------------------------------------
  // previewPush()
  // ---------------------------------------------------------------------------
  // Dry-run that the PushPreviewDialog renders before the GM commits to
  // a Push. Walks the same shape as pushAll but doesn't hit the
  // network. Returns categorized counts + the list of session journals
  // that have dirty plan pages (so the dialog can name them — GMV-9).
  // ---------------------------------------------------------------------------
  previewPush() {
    const campaignId = game.settings.get(MODULE_ID, "campaignId");
    if (!campaignId) return { error: "no_campaign_bound" };
    const preview = {
      entities: { create: [], update: [] },
      notes: { create: [], update: [] },
      sessionPlan: { gmNotes: false, gmSecrets: false, agenda: false, pinned: false },
      sessionPlanJournals: [],
      quickNotes: 0,
      total: 0
    };
    // Bucket entity pages by create-vs-update.
    for (const kind of Object.keys(KIND_JOURNAL_NAMES)) {
      const journal = game.journal.contents.find((e) => e.getFlag(MODULE_ID, FLAG_KIND) === kind);
      if (!journal) continue;
      for (const page of journal.pages.contents) {
        // Skip non-text pages (someone added e.g. an image page manually).
        if (page.type !== "text") continue;
        const externalId = page.getFlag(MODULE_ID, FLAG_EXTERNAL_ID);
        const dirty = page.getFlag(MODULE_ID, FLAG_DIRTY);
        if (!externalId) preview.entities.create.push({ name: page.name, kind });
        else if (dirty) preview.entities.update.push({ name: page.name, kind });
      }
    }
    // Same bucketing for notes.
    const notesJournal = game.journal.contents.find((e) => e.getFlag(MODULE_ID, FLAG_KIND) === "notes");
    if (notesJournal) {
      for (const page of notesJournal.pages.contents) {
        if (page.type !== "text") continue;
        const externalId = page.getFlag(MODULE_ID, FLAG_EXTERNAL_ID);
        const dirty = page.getFlag(MODULE_ID, FLAG_DIRTY);
        if (!externalId) preview.notes.create.push({ name: page.name });
        else if (dirty) preview.notes.update.push({ name: page.name });
      }
    }
    // Aggregate session-plan dirty flags + collect dirty journal names.
    for (const journal of this._allSessionJournals()) {
      let anyDirty = false;
      for (const page of journal.pages.contents) {
        if (!page.getFlag(MODULE_ID, FLAG_DIRTY)) continue;
        anyDirty = true;
        if (page.name === SESSION_PAGE_GM_NOTES) preview.sessionPlan.gmNotes = true;
        else if (page.name === SESSION_PAGE_SECRETS) preview.sessionPlan.gmSecrets = true;
        else if (page.name === SESSION_PAGE_AGENDA) preview.sessionPlan.agenda = true;
        else if (page.name === SESSION_PAGE_PINNED) preview.sessionPlan.pinned = true;
      }
      // GMV-9: name the dirty session journals so the preview dialog
      // can show "Sessions: Foo, Bar" instead of a bare count.
      if (anyDirty) preview.sessionPlanJournals.push(journal.name);
    }
    const queue = game.settings.get(MODULE_ID, "pendingPushQueue") ?? [];
    preview.quickNotes = queue.length;
    // Grand-total fires the empty-state branch in the preview dialog.
    preview.total =
      preview.entities.create.length + preview.entities.update.length +
      preview.notes.create.length + preview.notes.update.length +
      preview.sessionPlanJournals.length + preview.quickNotes;
    return preview;
  }

  // ---------------------------------------------------------------------------
  // pushAll()
  // ---------------------------------------------------------------------------
  // The Push pipeline. Drains the quick-note queue, then walks every
  // entity kind, then notes, then dirty session plans. Each failure
  // is captured per-resource — one bad PATCH doesn't abort the run.
  // ---------------------------------------------------------------------------
  async pushAll() {
    const campaignId = game.settings.get(MODULE_ID, "campaignId");
    if (!campaignId) return { error: "no_campaign_bound" };
    const activeSessionId = game.settings.get(MODULE_ID, "activeSessionId");
    const result = {
      pushed: { entities: 0, notes: 0, sessionPlans: 0, quickNotes: 0 },
      failed: 0,
      errors: []
    };
    // Drain queued quick-notes first — they're tied to the live session
    // and we want them visible before any other Push side-effects land.
    await this._drainQuickNoteQueue(campaignId, activeSessionId, result);
    // Entities by kind. Skip kinds the GM has never pulled (no journal yet).
    for (const kind of Object.keys(KIND_JOURNAL_NAMES)) {
      const journal = game.journal.contents.find((e) => e.getFlag(MODULE_ID, FLAG_KIND) === kind);
      if (!journal) continue;
      for (const page of journal.pages.contents) {
        if (page.type !== "text") continue;
        await this._pushEntityPage(campaignId, kind, page, result);
      }
    }
    // Notes.
    const notesJournal = game.journal.contents.find((e) => e.getFlag(MODULE_ID, FLAG_KIND) === "notes");
    if (notesJournal) {
      for (const page of notesJournal.pages.contents) {
        if (page.type !== "text") continue;
        await this._pushNotePage(campaignId, page, result);
      }
    }
    // Session plans — one PATCH per dirty session journal.
    for (const journal of this._allSessionJournals()) {
      const sessionId = journal.getFlag(MODULE_ID, FLAG_EXTERNAL_ID);
      if (!sessionId) continue;
      // Pre-check at journal level so we skip the PATCH builder
      // entirely when nothing is dirty.
      const hasDirty = journal.pages.contents.some((p) => p.getFlag(MODULE_ID, FLAG_DIRTY));
      if (!hasDirty) continue;
      await this._pushSessionPlan(campaignId, sessionId, result);
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // pushOne(entry)
  // ---------------------------------------------------------------------------
  // Single-journal Push — the context-menu "Push this journal" entry
  // and the auto-push hook both call this. Dispatches based on the
  // entry's `kind` flag.
  // ---------------------------------------------------------------------------
  async pushOne(entry) {
    const campaignId = game.settings.get(MODULE_ID, "campaignId");
    if (!campaignId) throw new Error("no_campaign_bound");
    const kind = entry.getFlag(MODULE_ID, FLAG_KIND);
    const result = {
      pushed: { entities: 0, notes: 0, sessionPlans: 0, quickNotes: 0 },
      failed: 0,
      errors: []
    };
    if (kind === "notes") {
      for (const page of entry.pages.contents) {
        if (page.type !== "text") continue;
        await this._pushNotePage(campaignId, page, result);
      }
    } else if (KIND_JOURNAL_NAMES[kind]) {
      for (const page of entry.pages.contents) {
        if (page.type !== "text") continue;
        await this._pushEntityPage(campaignId, kind, page, result);
      }
    } else if (kind === "session") {
      const sessionId = entry.getFlag(MODULE_ID, FLAG_EXTERNAL_ID);
      if (sessionId) await this._pushSessionPlan(campaignId, sessionId, result);
    } else {
      // No `kind` flag means this journal isn't synced — refuse rather
      // than silently no-op so the caller can surface a real error.
      throw new Error("entry_not_bound_to_gmhub");
    }
    return result;
  }

  // Alias kept for the context-menu callback's readability.
  pushJournal(entry) { return this.pushOne(entry); }

  // Mark a journal dirty so the next Push includes it. Used by the
  // updateJournalEntry hook in main.js.
  async markDirty(entry) {
    await entry.setFlag(MODULE_ID, FLAG_DIRTY, true);
  }

  // ---------------------------------------------------------------------------
  // enqueueQuickNote(body, mentionedEntityId)
  // ---------------------------------------------------------------------------
  // Append a quick-note to the offline queue. Stamped with a queued_at
  // ISO timestamp for future "drained at most X minutes after queue"
  // reporting. Caller is responsible for triggering a Push to drain.
  // ---------------------------------------------------------------------------
  async enqueueQuickNote(body, mentionedEntityId = null) {
    const queue = game.settings.get(MODULE_ID, "pendingPushQueue") ?? [];
    queue.push({ body, mentioned_entity_id: mentionedEntityId, queued_at: new Date().toISOString() });
    await game.settings.set(MODULE_ID, "pendingPushQueue", queue);
  }
}
