// =============================================================================
// scripts/api-client.js
// =============================================================================
//
// GMhub VTT Bridge — GMhub /api/v1/* client.
//
// PURPOSE:
//   Thin REST wrapper around the gmhub-app `/api/v1` surface (Epic E in
//   the sister repo). All HTTP, auth, JSON parse/encode, and error
//   normalization live here so sync.js / ui.js never see a raw `fetch`.
//
// AUTH MODEL:
//   Bearer token from world settings (`gmhub-vtt.apiKey`), injected on
//   every request. A 401 triggers exactly one re-read of the setting —
//   so if the GM pastes a fresh token after a failure, the next call
//   picks it up without a world reload.
//
// ERROR CONTRACT:
//   Every non-2xx HTTP response throws `GmhubApiError` carrying:
//     - status: numeric HTTP code
//     - body:   parsed JSON body (or `{}` if no body)
//   `body.reason` is the GMhub-side string code (e.g.
//   "missing_credentials", "single_active_session") that
//   `error-toaster.js` maps to localized toasts.
//
// 0016 (Unified Visibility):
//   One consolidated PATCH per resource. The legacy
//   `setNotePlayerReveal`, `setEntityReveal`, `setNoteVisibility`, and
//   `setEntityVisibility` helpers are gone — updateNote and updateEntity
//   now carry `visibility` and `recipients` directly.
// =============================================================================

// -----------------------------------------------------------------------------
// GmhubApiError
// -----------------------------------------------------------------------------
// Custom Error subclass that preserves the HTTP status and the parsed
// JSON body returned by /api/v1. Lets the error-toaster pattern-match
// on `.status` / `.body.reason` to pick the right user-facing toast.
// -----------------------------------------------------------------------------
export class GmhubApiError extends Error {
  constructor(status, body) {
    // Prefer the server-supplied `reason` string as the Error message;
    // fall back to `http_<status>` if no body / reason came back.
    const reason = body && body.reason ? body.reason : `http_${status}`;
    super(reason);
    // Standard Error subclass plumbing — set `name` for stack traces.
    this.name = "GmhubApiError";
    // Numeric HTTP status (401, 403, 409, 429, 5xx, ...).
    this.status = status;
    // Always an object so callers can do `err.body?.reason` safely.
    this.body = body ?? {};
  }
}

// -----------------------------------------------------------------------------
// parseRetryAfterSeconds(raw, fallback)
// -----------------------------------------------------------------------------
// Coerce a server-supplied retry window (from the 429 JSON body's
// `retryAfter` field, expressed in seconds) into a safe non-negative
// number. Anything that isn't a finite, >= 0 value — undefined, a
// non-numeric string, NaN, Infinity, a negative — degrades to
// `fallback` (60s). Exported as a pure function so it can be smoke-
// tested under bare `node` without a Foundry/fetch runtime.
//   parseRetryAfterSeconds(30)        -> 30
//   parseRetryAfterSeconds("30")      -> 30
//   parseRetryAfterSeconds(undefined) -> 60
//   parseRetryAfterSeconds("abc")     -> 60
//   parseRetryAfterSeconds(-5)        -> 60
//   parseRetryAfterSeconds(0)         -> 0
//   parseRetryAfterSeconds(Infinity)  -> 60
// -----------------------------------------------------------------------------
export function parseRetryAfterSeconds(raw, fallback = 60) {
  const n = Number(raw);
  // Number.isFinite rejects NaN and ±Infinity in one check; `>= 0`
  // keeps 0 (retry immediately) but drops negatives.
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// -----------------------------------------------------------------------------
// sleep(ms)
// -----------------------------------------------------------------------------
// Minimal promise-based delay used by the 429 auto-retry to wait the
// server-requested window before replaying the request once.
// -----------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -----------------------------------------------------------------------------
// GmhubClient
// -----------------------------------------------------------------------------
// Constructed once at `ready` time with lazy getters for baseUrl + apiKey
// (so the GM can edit settings live without re-instantiating the client).
// Exposes one method per /api/v1 endpoint plus an async-iterator helper
// for cursor-paginated list endpoints.
// -----------------------------------------------------------------------------
export class GmhubClient {
  constructor({ getBaseUrl, getApiKey }) {
    // Late-bound so changes to settings take effect immediately on the
    // next call rather than requiring a world reload.
    this.getBaseUrl = getBaseUrl;
    this.getApiKey = getApiKey;
  }

  // ---------------------------------------------------------------------------
  // _url(path, query)
  // ---------------------------------------------------------------------------
  // Build a fully-qualified URL: `<baseUrl>/api/v1<path>?<query>`.
  // Strips trailing slashes from the base so the join is deterministic
  // regardless of how the GM typed it in settings.
  // ---------------------------------------------------------------------------
  _url(path, query) {
    // Trim a trailing slash so we don't end up with `//api/v1...`.
    const base = (this.getBaseUrl() || "").replace(/\/+$/, "");
    let url = `${base}/api/v1${path}`;
    if (query) {
      // URLSearchParams handles encoding for us.
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        // Skip undefined/null so callers can pass `{ cursor: undefined }`
        // without polluting the URL with `cursor=undefined`.
        if (v === undefined || v === null) continue;
        params.set(k, String(v));
      }
      const q = params.toString();
      // Only append the `?` if at least one param survived the filter.
      if (q) url += `?${q}`;
    }
    return url;
  }

  // ---------------------------------------------------------------------------
  // _request(method, path, body, query)
  // ---------------------------------------------------------------------------
  // The single fetch chokepoint. Adds bearer auth, JSON content-type,
  // parses responses, and converts non-2xx into GmhubApiError. Implements
  // the "one-retry on 401 if the key changed" behavior described in the
  // file header.
  // ---------------------------------------------------------------------------
  async _request(method, path, body, query) {
    // Pull the bearer token lazily so live-edits in settings apply.
    let key = this.getApiKey();
    // Short-circuit before hitting the network if no key is configured.
    if (!key) throw new GmhubApiError(401, { error: "unauthorized", reason: "missing_credentials" });

    // Closure over the current `key` so we can call it twice on retry.
    const doFetch = async () => fetch(this._url(path, query), {
      method,
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      // Only stringify when there's a body — GET/DELETE typically omit it.
      body: body !== undefined ? JSON.stringify(body) : undefined
    });

    let res = await doFetch();
    // Retry-on-401-if-key-changed: lets the GM paste a fresh key and
    // have the very next request pick it up automatically.
    if (res.status === 401) {
      const reread = this.getApiKey();
      if (reread && reread !== key) {
        key = reread;
        res = await doFetch();
      }
    }
    // Retry-on-429: the server rate-limited us. A 429 means the request
    // was rejected *before* processing, so replaying a POST/PATCH is
    // side-effect-safe. Read the JSON body (the only place we get the
    // `retryAfter` window) and decide:
    //   - window <= 60s (or missing/malformed -> 60): sleep, then replay
    //     `doFetch()` exactly once. `res` is reassigned to a *fresh*
    //     Response so the text() read below stays valid (no double-read).
    //   - window > 60s: don't wait — throw immediately so the existing
    //     `GMHUB.Error.429` toast fires with the intact retryAfter.
    // Only one retry: if the replay still 429s it falls through to the
    // generic non-2xx throw below (no second retry).
    if (res.status === 429) {
      const body429 = await res.json().catch(() => ({}));
      const seconds = parseRetryAfterSeconds(body429?.retryAfter);
      if (seconds > 60) throw new GmhubApiError(429, body429);
      await sleep(seconds * 1000);
      res = await doFetch();
    }
    // 204 No Content is a legitimate success (e.g. DELETE) — return null
    // rather than trying to JSON.parse the empty body.
    if (res.status === 204) return null;

    // Read the body once as text so we can both attempt a JSON parse and
    // still surface the raw string when parsing fails.
    const text = await res.text().catch(() => "");
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }

    // Any 4xx/5xx becomes a typed error for the toaster to localize.
    if (!res.ok) throw new GmhubApiError(res.status, json);
    return json;
  }

  // ---- Identity --------------------------------------------------------------

  // GET /ping — sanity-check round-trip. Returns the principal record:
  // `{ user_id, scopes: [...] }`. Used by the Test Connection button.
  ping() { return this._request("GET", "/ping"); }

  // ---- Campaigns -------------------------------------------------------------

  // GET /campaigns — list every campaign the bearer token can see.
  // (Not currently surfaced in UI, but kept for future multi-campaign UX.)
  listCampaigns() { return this._request("GET", "/campaigns"); }

  // GET /campaigns/{id} — fetch a single campaign's metadata.
  getCampaign(campaignId) {
    return this._request("GET", `/campaigns/${encodeURIComponent(campaignId)}`);
  }

  /**
   * GET /campaigns/{id}/members — list of campaign members (GMs and
   * players) for the visibility recipient picker. Returns a flat
   * array of { user_id, display_name, role }.
   */
  async getMembers(campaignId) {
    // Tolerant of both shapes: `{ data: [...] }` envelope or raw array,
    // because the API was envelope-only in earlier Epic E revisions.
    const page = await this._request(
      "GET",
      `/campaigns/${encodeURIComponent(campaignId)}/members`
    );
    return Array.isArray(page) ? page : page?.data ?? [];
  }

  // ---- Entities --------------------------------------------------------------

  // GET /campaigns/{id}/entities — cursor-paginated list of NPCs,
  // locations, factions, items, quests, lore. `opts` is the query
  // hash (cursor, limit, type filter, etc.).
  listEntities(campaignId, opts = {}) {
    return this._request(
      "GET",
      `/campaigns/${encodeURIComponent(campaignId)}/entities`,
      undefined,
      opts
    );
  }

  // GET /campaigns/{id}/entities/{id} — single entity by id.
  getEntity(campaignId, entityId) {
    return this._request(
      "GET",
      `/campaigns/${encodeURIComponent(campaignId)}/entities/${encodeURIComponent(entityId)}`
    );
  }

  // POST /campaigns/{id}/entities — create a new entity. Body must
  // include `entity_type` and `name`; server fills in defaults.
  createEntity(campaignId, body) {
    return this._request(
      "POST",
      `/campaigns/${encodeURIComponent(campaignId)}/entities`,
      body
    );
  }

  /**
   * PATCH /campaigns/{id}/entities/{id}. Body: any subset of
   * { name?, summary?, visibility?, recipients? }. The server
   * reconciles entity_player_reveals when visibility is `shared`.
   */
  updateEntity(campaignId, entityId, body) {
    return this._request(
      "PATCH",
      `/campaigns/${encodeURIComponent(campaignId)}/entities/${encodeURIComponent(entityId)}`,
      body
    );
  }

  // DELETE /campaigns/{id}/entities/{id} — hard delete on the server.
  deleteEntity(campaignId, entityId) {
    return this._request(
      "DELETE",
      `/campaigns/${encodeURIComponent(campaignId)}/entities/${encodeURIComponent(entityId)}`
    );
  }

  // ---- Notes -----------------------------------------------------------------

  // GET /campaigns/{id}/notes — cursor-paginated list of campaign notes
  // (the "Notes" journal in Foundry). `opts` carries cursor/limit.
  listNotes(campaignId, opts = {}) {
    return this._request(
      "GET",
      `/campaigns/${encodeURIComponent(campaignId)}/notes`,
      undefined,
      opts
    );
  }

  // GET /campaigns/{id}/notes/{id} — single note by id.
  getNote(campaignId, noteId) {
    return this._request(
      "GET",
      `/campaigns/${encodeURIComponent(campaignId)}/notes/${encodeURIComponent(noteId)}`
    );
  }

  // POST /campaigns/{id}/notes — create a new campaign note.
  createNote(campaignId, body) {
    return this._request(
      "POST",
      `/campaigns/${encodeURIComponent(campaignId)}/notes`,
      body
    );
  }

  /**
   * PATCH /campaigns/{id}/notes/{id}. Body: any subset of
   * { title?, body?, visibility?, recipients? }. The server
   * reconciles note_player_reveals when visibility is `shared`.
   */
  updateNote(campaignId, noteId, body) {
    return this._request(
      "PATCH",
      `/campaigns/${encodeURIComponent(campaignId)}/notes/${encodeURIComponent(noteId)}`,
      body
    );
  }

  // DELETE /campaigns/{id}/notes/{id} — remove a note server-side.
  deleteNote(campaignId, noteId) {
    return this._request(
      "DELETE",
      `/campaigns/${encodeURIComponent(campaignId)}/notes/${encodeURIComponent(noteId)}`
    );
  }

  // ---- Sessions --------------------------------------------------------------

  // GET /campaigns/{id}/sessions — list every session (prep/live/ended).
  // The Pull pipeline calls this then narrows to the prep + running +
  // most-recent-ended window via `computeSessionWindow` in sync.js.
  async listSessions(campaignId, opts = {}) {
    const page = await this._request(
      "GET",
      `/campaigns/${encodeURIComponent(campaignId)}/sessions`,
      undefined,
      opts
    );
    // Same array-or-envelope normalization as `getMembers`.
    return Array.isArray(page) ? page : page?.data ?? [];
  }

  // GET /campaigns/{id}/sessions/{id} — single session metadata
  // (status, started_at, ended_at, paused_at, title, ...).
  getSession(campaignId, sessionId) {
    return this._request(
      "GET",
      `/campaigns/${encodeURIComponent(campaignId)}/sessions/${encodeURIComponent(sessionId)}`
    );
  }

  // GET /campaigns/{id}/sessions/active — convenience endpoint for the
  // currently-running session. Returns null on 404 (no active session)
  // rather than throwing, since "no active session" is a normal state.
  async getActiveSession(campaignId) {
    try {
      return await this._request(
        "GET",
        `/campaigns/${encodeURIComponent(campaignId)}/sessions/active`
      );
    } catch (err) {
      // 404 = nothing live right now — translate to a null sentinel.
      if (err instanceof GmhubApiError && err.status === 404) return null;
      throw err;
    }
  }

  // GET /campaigns/{id}/sessions/{id}/plan — the prep packet for a
  // session: { gm_notes, gm_secrets, agenda, pinned }.
  getSessionPlan(campaignId, sessionId) {
    return this._request(
      "GET",
      `/campaigns/${encodeURIComponent(campaignId)}/sessions/${encodeURIComponent(sessionId)}/plan`
    );
  }

  // PATCH /campaigns/{id}/sessions/{id}/plan — partial update of the
  // prep packet. Body is any subset of the four plan fields.
  updateSessionPlan(campaignId, sessionId, body) {
    return this._request(
      "PATCH",
      `/campaigns/${encodeURIComponent(campaignId)}/sessions/${encodeURIComponent(sessionId)}/plan`,
      body
    );
  }

  // POST /campaigns/{id}/sessions/{id}/quick-notes — drain queued
  // quick-notes into the active session. Body: { body, mentioned_entity_id? }.
  addQuickNote(campaignId, sessionId, body) {
    return this._request(
      "POST",
      `/campaigns/${encodeURIComponent(campaignId)}/sessions/${encodeURIComponent(sessionId)}/quick-notes`,
      body
    );
  }

  // POST /campaigns/{id}/sessions/{id}/lifecycle — start/pause/resume/
  // end the session. Server enforces "only one running per campaign".
  transitionLifecycle(campaignId, sessionId, action) {
    return this._request(
      "POST",
      `/campaigns/${encodeURIComponent(campaignId)}/sessions/${encodeURIComponent(sessionId)}/lifecycle`,
      { action }
    );
  }

  // ---- Helpers ---------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // iterateAll(listFn, args, safetyLimit)
  // ---------------------------------------------------------------------------
  // Async-iterator helper that walks a cursor-paginated endpoint to
  // completion. Yields one row at a time so callers can `for await ...`
  // without ever holding the full result set in memory. `safetyLimit`
  // (default 1000) protects against runaway loops if the server keeps
  // returning a new cursor that points back at itself.
  // ---------------------------------------------------------------------------
  async *iterateAll(listFn, args = {}, safetyLimit = 1000) {
    // Start at the caller-supplied cursor (or the first page).
    let cursor = args.cursor ?? null;
    let yielded = 0;
    for (;;) {
      // Fetch one page; spread `args` so e.g. `type`/`limit` carry through.
      const page = await listFn({ ...args, cursor: cursor ?? undefined });
      // Same shape normalization the other list endpoints use.
      const data = Array.isArray(page) ? page : page?.data ?? [];
      for (const row of data) {
        yield row;
        yielded += 1;
        // Defensive bound to keep a buggy server from spinning forever.
        if (yielded >= safetyLimit) return;
      }
      // Pull the next cursor out of the envelope; arrays are last-page.
      const next = (Array.isArray(page) ? null : page?.meta?.cursor) ?? null;
      // No next page, or a cursor that repeats — we're done.
      if (!next || next === cursor) return;
      cursor = next;
    }
  }
}
