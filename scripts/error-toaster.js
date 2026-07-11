// =============================================================================
// scripts/error-toaster.js
// =============================================================================
//
// GMhub VTT Bridge — friendly error toasts (GMHUB-156 / E13).
//
// PURPOSE:
//   Centralizes how the module renders GMhub /api/v1 errors to the GM.
//   Every fetch call in sync.js + ui.js routes through `safeCall` so a
//   401/403/409/429/5xx response becomes an actionable
//   `ui.notifications` message instead of a raw exception in the
//   console.
//
// PUBLIC SURFACE:
//   - showFriendlyError(err)    -> renders a localized warn/error toast
//   - safeCall(fn)              -> wraps a fetch shape; toasts + re-throws
//   - describePingResult(p)     -> pre-formats success text for Ping panel
//   - describePingFailure(err)  -> pre-formats failure text for Ping panel
//
// LOCALIZATION:
//   Every visible string flows through `game.i18n`; the keys live under
//   `GMHUB.Error.*` and `GMHUB.Warn.*` in `lang/en.json`.
// =============================================================================

// Pull in the concrete error class so we can branch on .status / .body.reason.
import { GmhubApiError } from "./api-client.js";

// -----------------------------------------------------------------------------
// localize(key, vars)
// -----------------------------------------------------------------------------
// Tiny shim around Foundry's i18n that picks between `localize` (no
// interpolation) and `format` (with `{var}` interpolation) automatically.
// Keeps the call sites below as one-liners.
// -----------------------------------------------------------------------------
function localize(key, vars) {
  // Use `format` only when caller supplied interpolation values.
  return vars ? game.i18n.format(key, vars) : game.i18n.localize(key);
}

// -----------------------------------------------------------------------------
// showFriendlyError(err)
// -----------------------------------------------------------------------------
// Pattern-matches a thrown error against the GMhub /api/v1 error catalog
// and pops the matching Foundry notification. Anything that isn't a
// GmhubApiError gets a generic error toast plus a console log so the GM
// can still diagnose unexpected failures.
// -----------------------------------------------------------------------------
export function showFriendlyError(err) {
  // Non-API errors (network failure, bug in our own code, etc.) — log the
  // full object for debugging and surface a generic message to the GM.
  if (!(err instanceof GmhubApiError)) {
    console.error("[gmhub-vtt-bridge] non-GmhubApiError surfaced", err);
    ui.notifications.error(localize("GMHUB.Error.Generic", { message: err?.message ?? "unknown" }));
    return;
  }

  // Cache the HTTP status + server-supplied reason for the branch table below.
  const status = err.status;
  const reason = err.body?.reason ?? "";

  // 401 — missing creds: the GM forgot to paste an API key in settings.
  if (status === 401 && reason === "missing_credentials") {
    ui.notifications.warn(localize("GMHUB.Error.401.MissingCredentials"));
    return;
  }
  // 401 — generic: the bearer token is wrong, expired, or revoked.
  if (status === 401) {
    ui.notifications.warn(localize("GMHUB.Error.401"));
    return;
  }
  // 403 — missing_scope: the token authenticates but lacks a specific
  // scope (e.g. `notes:write`). Surface which scope the API demanded.
  if (status === 403 && reason === "missing_scope") {
    ui.notifications.warn(
      localize("GMHUB.Error.403", { scope: err.body?.scope ?? "(unknown)" })
    );
    return;
  }
  // 403 — generic: forbidden but no scope detail came back from the server.
  if (status === 403) {
    ui.notifications.warn(localize("GMHUB.Error.403.Generic"));
    return;
  }
  // 409 — single_active_session: another session is already live; the
  // GM must end the existing one before starting a new one.
  if (status === 409 && reason === "single_active_session") {
    ui.notifications.warn(localize("GMHUB.Error.409.single_active_session"));
    return;
  }
  // 409 — session_ended: the GM tried to push to (or transition) a
  // session that the web app already closed out.
  if (status === 409 && reason === "session_ended") {
    ui.notifications.warn(localize("GMHUB.Error.409.session_ended"));
    return;
  }
  // 409 — generic conflict: e.g. concurrent edit race the server refused.
  if (status === 409) {
    ui.notifications.warn(localize("GMHUB.Error.409.Generic"));
    return;
  }
  // 429 — rate limited: show the server-supplied retry-after window so
  // the GM knows when they can retry without hammering the API.
  if (status === 429) {
    ui.notifications.warn(
      localize("GMHUB.Error.429", { seconds: err.body?.retryAfter ?? 60 })
    );
    return;
  }
  // 5xx — the API is down or threw an unhandled exception; nothing the
  // GM can do but try again later.
  if (status >= 500) {
    ui.notifications.error(localize("GMHUB.Error.5xx"));
    return;
  }
  // Catch-all (e.g. 400 schema validation): surface whatever message
  // body came back so the GM can copy/paste it into a bug report.
  ui.notifications.error(
    localize("GMHUB.Error.Generic", {
      message: err.body?.message ?? err.body?.error ?? `HTTP ${status}`
    })
  );
}

// -----------------------------------------------------------------------------
// safeCall(fn)
// -----------------------------------------------------------------------------
// Wrap a fetch-shaped call so every failure routes through
// showFriendlyError. Re-throws so callers can still react (e.g. abort a
// sync loop). The ui.js dialog catches the re-thrown error and updates
// its inline output panel.
// -----------------------------------------------------------------------------
export async function safeCall(fn) {
  try {
    // Caller's actual API call; await so any rejection lands in catch.
    return await fn();
  } catch (err) {
    // Toast first, then rethrow so the surrounding flow can also react.
    showFriendlyError(err);
    throw err;
  }
}

// -----------------------------------------------------------------------------
// describePingResult(principal)
// -----------------------------------------------------------------------------
// Build the inline-output text for the Test Connection button in the
// Sync Dialog. Returns a string ready to drop into the
// `<pre data-role="sync-output">` block. Warns when the token can't
// read GM secrets, since the Pull flow silently skips them in that case.
// -----------------------------------------------------------------------------
export function describePingResult(principal) {
  // Normalize the scopes array so we can safely call .includes/.join.
  const scopes = Array.isArray(principal?.scopes) ? principal.scopes : [];
  // First line: tick + the user id the API recognized.
  // Second line: the scopes attached to the token, for transparency.
  const lines = [
    `✓ ${localize("GMHUB.Notify.PingOk", { userId: principal?.user_id ?? "?" })}`,
    `  scopes: ${scopes.join(", ") || "(none)"}`
  ];
  // Heads-up: without `sessions:secrets` the GM secrets pull is a no-op.
  if (!scopes.includes("sessions:secrets")) {
    lines.push(`⚠ ${localize("GMHUB.Warn.NoSessionsSecrets")}`);
  }
  // Multi-line string — the <pre> block in the dialog preserves newlines.
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// describePingFailure(err)
// -----------------------------------------------------------------------------
// Same idea as describePingResult but for the failure path. Returns a
// one-liner safe to drop into the same `<pre>` block.
// -----------------------------------------------------------------------------
export function describePingFailure(err) {
  // GmhubApiError surfaces both the HTTP code and the server's reason
  // string — most useful diagnostic for the GM in one line.
  if (err instanceof GmhubApiError) {
    return `✗ HTTP ${err.status} ${err.body?.reason ?? err.body?.error ?? "unknown"}`;
  }
  // Network / programming errors: fall back to the message field.
  return `✗ ${err?.message ?? "unknown error"}`;
}
