// =============================================================================
// scripts/encounters.js
// =============================================================================
//
// GMhub VTT Bridge — Encounter import & deploy (v0.8.0, GMV-13).
//
// PURPOSE:
//   The encounter *builder* lives in gmhub-app (GM-only prep content:
//   an encounter is a named list of creature rows — "3 × Barbed Devil,
//   hidden, 45 HP" — optionally linked to a session). This file is the
//   Foundry-side consumer. It is PULL-ONLY: nothing here writes back to
//   GMhub. Three jobs:
//
//     1. EncountersDialog — list the campaign's encounters (active session
//        first), expand one to its creature rows, and let the GM pick a
//        Foundry Actor per row from an auto-matched candidate list.
//     2. createHomebrewActor — for rows the GM authored a structured stat
//        block for in GMhub (`is_homebrew`), build a dnd5e `npc` Actor in a
//        "GMhub Encounters" folder from `homebrew_stats`.
//     3. deployEncounter — place `quantity` tokens per matched row on the
//        current scene around a point the GM clicks, then add them to the
//        scene's Combat (creating one if needed; initiative is NOT rolled).
//
// IMPORT DISCIPLINE:
//   This file must NOT import ui.js (ui.js imports us to open the dialog
//   from the Sync dialog's button; a reverse import would be circular).
//   It imports only MODULE_ID from main.js — the same already-tolerated
//   cycle sync.js / ui.js use — and the error toaster.
//
// FLAGS (all under `flags.gmhub-vtt-bridge`):
//   - Actor.encounterCreatureId : the GMhub creature row id a homebrew
//                                 actor was generated from (reuse key).
//   - Actor.homebrew            : true on actors this file generated.
//   - Item.homebrew             : true on feat items this file generated
//                                 (so a re-import can replace them cleanly).
//   - Token.encounterId         : the GMhub encounter id a deployed token
//                                 came from.
//
// SETTING:
//   `encounterActorMap` (world, hidden) — `{ [labelLower]: actorUuid }`.
//   Remembers the GM's per-label actor pick across dialog opens; applied
//   BEFORE auto-matching so a deliberate choice always wins over a guess.
//
// FOUNDRY VERSION NOTES:
//   - Grid snapping: `canvas.grid.getSnappedPoint` (v12+) with a fallback
//     to `canvas.grid.getSnappedPosition` (v11).
//   - Token HP override: TokenDocument `delta` (v11+; `actorData` before
//     v11 — kept as a no-cost fallback though the manifest's minimum is 11).
//   - dnd5e data shape is best-effort (see `buildHomebrewActorData`): the
//     name / HP / AC core is always sent; everything else is wrapped so an
//     unknown system version still yields a usable actor.
// =============================================================================

// Canonical module id — namespace for flags, settings, template paths.
import { MODULE_ID } from "./main.js";
// Friendly-error toaster for the GMhub fetch in the dialog.
import { safeCall } from "./error-toaster.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------
// Folder every generated homebrew actor lands in (find-or-create, type Actor).
const HOMEBREW_FOLDER_NAME = "GMhub Encounters";
// Flag keys (see file header).
const FLAG_ENCOUNTER_CREATURE_ID = "encounterCreatureId";
const FLAG_ENCOUNTER_ID = "encounterId";
const FLAG_HOMEBREW = "homebrew";
// World setting that remembers per-label actor picks.
const SETTING_ACTOR_MAP = "encounterActorMap";
// Cap on loose ("includes") matches per row so a label like "Guard" doesn't
// produce a 200-option select from a big monster compendium.
const MAX_LOOSE_MATCHES = 25;

// GMhub size → dnd5e `system.traits.size` code.
const SIZE_MAP = {
  tiny: "tiny", small: "sm", medium: "med", large: "lg", huge: "huge", gargantuan: "grg"
};
// Grid cells a token of each dnd5e size occupies (used for ring spacing).
const SIZE_CELLS = { tiny: 0.5, sm: 1, med: 1, lg: 2, huge: 3, grg: 4 };

// -----------------------------------------------------------------------------
// normalizeLabel(label)
// -----------------------------------------------------------------------------
// The matching key: trimmed, case-folded, internal whitespace collapsed.
// Used both for actor-name comparison and as the `encounterActorMap` key.
// -----------------------------------------------------------------------------
export function normalizeLabel(label) {
  return String(label ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

// -----------------------------------------------------------------------------
// _escapeHtml(s)
// -----------------------------------------------------------------------------
// Entity-escape user text before it lands in an Item description. Same
// minimal escaper sync.js uses (duplicated rather than imported to keep
// this file's import surface to main.js + error-toaster only).
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
// textToHtml(text)
// -----------------------------------------------------------------------------
// Homebrew descriptions are plain text (≤ 4000 chars) authored in GMhub.
// Blank-line-separated blocks become <p>; single newlines become <br>.
// -----------------------------------------------------------------------------
export function textToHtml(text) {
  const blocks = String(text ?? "").split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  if (!blocks.length) return "";
  return blocks.map((b) => `<p>${_escapeHtml(b).replace(/\n/g, "<br>")}</p>`).join("");
}

// -----------------------------------------------------------------------------
// parseChallengeRating(cr)
// -----------------------------------------------------------------------------
// "10" → 10, "1/2" → 0.5, "1/8" → 0.125, "" / garbage → null. dnd5e stores
// `system.details.cr` as a number (fractions as decimals).
// -----------------------------------------------------------------------------
export function parseChallengeRating(cr) {
  if (cr === null || cr === undefined) return null;
  const s = String(cr).trim();
  if (!s) return null;
  const frac = s.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (frac) {
    const d = Number(frac[2]);
    return d > 0 ? Number(frac[1]) / d : null;
  }
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// -----------------------------------------------------------------------------
// parseSpeed(speed)
// -----------------------------------------------------------------------------
// Parse a 5e-style speed string into the dnd5e movement object. Handles
// the SRD idiom where the first bare "<n> ft." is the walking speed and
// later segments are prefixed with a mode:
//   "30 ft."                          → { walk: 30 }
//   "10 ft., swim 50 ft."             → { walk: 10, swim: 50 }
//   "0 ft., fly 60 ft. (hover)"       → { walk: 0, fly: 60, hover: true }
//   "burrow 20 ft., climb 30 ft."     → { burrow: 20, climb: 30 }
// Anything unparseable yields `{}` so the caller can skip the field.
// -----------------------------------------------------------------------------
export function parseSpeed(speed) {
  const out = {};
  const s = String(speed ?? "").trim();
  if (!s) return out;
  const re = /(walk|swim|fly|burrow|climb)?\s*(\d+)\s*(?:ft|feet|')/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const mode = (m[1] ?? "").toLowerCase() || "walk";
    const n = Number(m[2]);
    if (!Number.isFinite(n)) continue;
    // First value wins per mode — a stat block never lists two walk speeds.
    if (out[mode] === undefined) out[mode] = n;
  }
  if (/hover/i.test(s)) out.hover = true;
  return out;
}

// -----------------------------------------------------------------------------
// buildHomebrewActorData(creature)
// -----------------------------------------------------------------------------
// Pure function: GMhub creature row (with `homebrew_stats`) → the
// `{ data, items }` pair `createHomebrewActor` feeds to Actor.create /
// Actor.update. Exported so it can be smoke-tested under bare `node`.
//
// Two tiers inside the returned `data`:
//   - `core`  — name / type / HP / AC. Always valid on every dnd5e version
//               we've seen (3.x → 5.x) and the fallback if the full shape
//               is rejected.
//   - `full`  — core + abilities / size / type / alignment / CR / movement
//               / senses / languages / damage & condition traits /
//               legendary resource / biography. Best-effort: unknown keys
//               are silently dropped by dnd5e's data model, and if the
//               whole create throws the caller retries with `core`.
// The `items` array is the feat-shaped trait/action list.
// -----------------------------------------------------------------------------
export function buildHomebrewActorData(creature) {
  const stats = creature?.homebrew_stats ?? {};
  const name = String(creature?.label ?? "Homebrew creature").trim() || "Homebrew creature";
  const hp = Number(stats.hp) > 0 ? Number(stats.hp) : 1;
  const ac = Number(stats.ac) > 0 ? Number(stats.ac) : 10;
  // Common flag block — the reuse key + a "we made this" marker.
  const flags = {
    [MODULE_ID]: {
      [FLAG_ENCOUNTER_CREATURE_ID]: creature?.id ?? null,
      [FLAG_HOMEBREW]: true
    }
  };

  // --- Tier 1: the always-safe core. ---------------------------------------
  const core = {
    name,
    type: "npc",
    flags,
    system: {
      attributes: {
        // Flat AC (no armor calc) — `calc: "flat"` tells dnd5e to use it.
        ac: { flat: ac, calc: "flat" },
        hp: { value: hp, max: hp }
      }
    }
  };

  // --- Tier 2: everything else, built defensively. --------------------------
  const full = foundry_deepClone(core);
  const sys = full.system;
  try {
    // Hit dice string → the HP formula field (dnd5e rolls it on demand).
    if (stats.hit_dice) sys.attributes.hp.formula = String(stats.hit_dice);
    // Movement from the speed string; omitted entirely when unparseable
    // so dnd5e's defaults (walk 30) stand rather than being zeroed.
    const movement = parseSpeed(stats.speed);
    if (Object.keys(movement).length) sys.attributes.movement = movement;
    // Six ability scores — only the keys GMhub supplied.
    if (stats.abilities && typeof stats.abilities === "object") {
      const abilities = {};
      for (const key of ["str", "dex", "con", "int", "wis", "cha"]) {
        const v = Number(stats.abilities[key]);
        if (Number.isFinite(v) && v > 0) abilities[key] = { value: v };
      }
      if (Object.keys(abilities).length) sys.abilities = abilities;
    }
    // Details: creature type / alignment / CR.
    const details = {};
    if (stats.type) details.type = { value: String(stats.type).trim().toLowerCase() };
    if (stats.alignment) details.alignment = String(stats.alignment);
    const cr = parseChallengeRating(stats.cr);
    if (cr !== null) details.cr = cr;
    // Fields dnd5e has no 1:1 slot for (saving-throw / skill strings need
    // per-skill proficiency flags we can't infer reliably) are preserved
    // verbatim in the biography so nothing authored in GMhub is lost.
    const bio = [];
    if (stats.saving_throws) bio.push(`<p><strong>Saving Throws</strong> ${_escapeHtml(stats.saving_throws)}</p>`);
    if (stats.skills) bio.push(`<p><strong>Skills</strong> ${_escapeHtml(stats.skills)}</p>`);
    if (stats.proficiency_bonus !== undefined && stats.proficiency_bonus !== null) {
      bio.push(`<p><strong>Proficiency Bonus</strong> +${_escapeHtml(stats.proficiency_bonus)}</p>`);
    }
    if (stats.legendary_description) bio.push(textToHtml(stats.legendary_description));
    if (bio.length) {
      details.biography = { value: `<p><em>Imported from GMhub encounter stats.</em></p>${bio.join("")}` };
    }
    if (Object.keys(details).length) sys.details = details;
    // Traits: size code, senses string, languages/damage/condition customs.
    const traits = {};
    const size = SIZE_MAP[String(stats.size ?? "").toLowerCase()];
    if (size) traits.size = size;
    if (stats.senses) traits.senses = String(stats.senses);
    if (stats.languages) traits.languages = { custom: String(stats.languages) };
    if (stats.damage_resistances) traits.dr = { custom: String(stats.damage_resistances) };
    if (stats.damage_immunities) traits.di = { custom: String(stats.damage_immunities) };
    if (stats.damage_vulnerabilities) traits.dv = { custom: String(stats.damage_vulnerabilities) };
    if (stats.condition_immunities) traits.ci = { custom: String(stats.condition_immunities) };
    if (Object.keys(traits).length) sys.traits = traits;
    // Legendary actions per round. Default 3 when the list is non-empty but
    // no count was given (mirrors the GMhub schema's documented default).
    const legendary = Array.isArray(stats.legendary_actions) ? stats.legendary_actions : [];
    if (legendary.length || stats.legendary_action_count) {
      const n = Number(stats.legendary_action_count) > 0 ? Number(stats.legendary_action_count) : 3;
      sys.resources = { legact: { value: n, max: n } };
    }
  } catch (err) {
    // A malformed stats block must never block actor creation — log and
    // fall through with whatever was assembled so far.
    console.warn(`[${MODULE_ID}] buildHomebrewActorData: partial stats mapping`, err);
  }

  // --- Embedded feat items for traits / actions / reactions / legendary. ---
  // Each list maps to a dnd5e activation type so the sheet files them under
  // the right header (Features / Actions / Bonus Actions / Reactions /
  // Legendary Actions). dnd5e 4.x moved activation onto activities; the
  // legacy `system.activation` key is dropped silently there (description
  // still lands), which is the documented best-effort boundary.
  const items = [];
  const lists = [
    ["traits", "", "monster"],
    ["actions", "action", "monster"],
    ["bonus_actions", "bonus", "monster"],
    ["reactions", "reaction", "monster"],
    ["legendary_actions", "legendary", "monster"]
  ];
  for (const [key, activation, featType] of lists) {
    const list = Array.isArray(stats[key]) ? stats[key] : [];
    for (const entry of list) {
      if (!entry || !entry.name) continue;
      items.push({
        name: String(entry.name).slice(0, 120),
        type: "feat",
        flags: { [MODULE_ID]: { [FLAG_HOMEBREW]: true } },
        system: {
          description: { value: textToHtml(entry.description) },
          type: { value: featType },
          // Empty string = passive (a trait); dnd5e treats "" as "none".
          activation: { type: activation }
        }
      });
    }
  }

  return { core, full, items };
}

// Local deep-clone that works under bare node (no `foundry` global) and in
// Foundry alike — the data is plain JSON so structuredClone/JSON suffice.
function foundry_deepClone(obj) {
  if (typeof structuredClone === "function") return structuredClone(obj);
  return JSON.parse(JSON.stringify(obj));
}

// -----------------------------------------------------------------------------
// ensureHomebrewFolder()
// -----------------------------------------------------------------------------
// Find-or-create the Actor folder generated homebrew actors live in.
// Keyed on name + type so a JournalEntry folder of the same name (the
// sync "GMhub Sessions" pattern) can't collide.
// -----------------------------------------------------------------------------
async function ensureHomebrewFolder() {
  const existing = game.folders?.find?.(
    (f) => f?.type === "Actor" && f?.name === HOMEBREW_FOLDER_NAME
  );
  if (existing) return existing;
  return Folder.create({ name: HOMEBREW_FOLDER_NAME, type: "Actor", color: "#6366f1" });
}

// -----------------------------------------------------------------------------
// findHomebrewActor(creatureId)
// -----------------------------------------------------------------------------
// The reuse lookup: a world Actor already stamped with this creature row's
// id. Returns null when none exists.
// -----------------------------------------------------------------------------
export function findHomebrewActor(creatureId) {
  if (!creatureId) return null;
  return game.actors?.find?.(
    (a) => a.getFlag?.(MODULE_ID, FLAG_ENCOUNTER_CREATURE_ID) === creatureId
  ) ?? null;
}

// -----------------------------------------------------------------------------
// createHomebrewActor(creature)
// -----------------------------------------------------------------------------
// Create (or refresh) the dnd5e npc Actor for a homebrew creature row.
//   - Reuse: if an Actor already carries `encounterCreatureId === creature.id`
//     its data is UPDATED in place and its previously-generated feat items
//     replaced — never a duplicate.
//   - Best-effort shape: tries the full dnd5e mapping first; if the system
//     rejects it, retries with the name/HP/AC core so the GM still gets a
//     usable actor (and a console warning explaining the downgrade).
// Returns the Actor.
// -----------------------------------------------------------------------------
export async function createHomebrewActor(creature) {
  if (!creature?.is_homebrew) throw new Error("not_homebrew");
  const { core, full, items } = buildHomebrewActorData(creature);
  const existing = findHomebrewActor(creature.id);

  if (existing) {
    // Refresh path. Update the top-level data (name + system), then swap
    // out the feat items we generated last time for the fresh set. Items
    // the GM added by hand (no homebrew flag) are left alone.
    try {
      await existing.update({ name: full.name, system: full.system });
    } catch (err) {
      console.warn(`[${MODULE_ID}] homebrew full update rejected; applying core only`, err);
      await existing.update({ name: core.name, system: core.system });
    }
    const stale = existing.items
      .filter((i) => i.getFlag?.(MODULE_ID, FLAG_HOMEBREW) === true)
      .map((i) => i.id);
    if (stale.length) await existing.deleteEmbeddedDocuments("Item", stale);
    if (items.length) {
      try { await existing.createEmbeddedDocuments("Item", items); } catch (err) {
        console.warn(`[${MODULE_ID}] homebrew item refresh failed`, err);
      }
    }
    return existing;
  }

  // Create path.
  const folder = await ensureHomebrewFolder();
  let actor;
  try {
    actor = await Actor.create({ ...full, folder: folder?.id ?? null, items });
  } catch (err) {
    console.warn(`[${MODULE_ID}] homebrew full create rejected; retrying with core data`, err);
    actor = await Actor.create({ ...core, folder: folder?.id ?? null });
    // Items are retried separately so a bad item can't sink the actor.
    if (actor && items.length) {
      try { await actor.createEmbeddedDocuments("Item", items); } catch (itemErr) {
        console.warn(`[${MODULE_ID}] homebrew items rejected`, itemErr);
      }
    }
  }
  if (!actor) throw new Error("actor_create_failed");
  return actor;
}

// -----------------------------------------------------------------------------
// matchActorCandidates(label, { indexCache })
// -----------------------------------------------------------------------------
// Auto-match a creature label to Foundry Actors. Tiers, in order:
//   1. exact (case-insensitive, trimmed) on `game.actors` names
//   2. exact on every Actor compendium pack's index
//   3. loose "includes" on world + packs (either direction), capped
// Returns `[{ uuid, name, source, exact }]`, deduped by uuid, tier order
// preserved. `source` is "World" or the pack's title (for the option label).
//
// `indexCache` is a Map<packCollection, index[]> the dialog owns so each
// pack's `getIndex()` runs once per dialog open rather than once per row.
// -----------------------------------------------------------------------------
export async function matchActorCandidates(label, { indexCache = new Map() } = {}) {
  const key = normalizeLabel(label);
  if (!key) return [];
  const exact = [];
  const loose = [];
  const seen = new Set();
  const push = (bucket, row) => {
    if (!row?.uuid || seen.has(row.uuid)) return;
    seen.add(row.uuid);
    bucket.push(row);
  };

  // Tier 1 + 3 (world). Walk once, bucket by match quality.
  const worldLoose = [];
  for (const actor of game.actors?.contents ?? []) {
    const n = normalizeLabel(actor.name);
    if (!n) continue;
    if (n === key) push(exact, { uuid: actor.uuid, name: actor.name, source: "World", exact: true });
    else if (n.includes(key) || key.includes(n)) worldLoose.push({ uuid: actor.uuid, name: actor.name, source: "World", exact: false });
  }

  // Tier 2 + 3 (compendia). Index only — never load full documents here.
  const packLoose = [];
  for (const pack of game.packs ?? []) {
    if (pack.documentName !== "Actor") continue;
    let index = indexCache.get(pack.collection);
    if (!index) {
      try {
        index = Array.from(await pack.getIndex());
      } catch (err) {
        console.warn(`[${MODULE_ID}] pack index failed: ${pack.collection}`, err);
        index = [];
      }
      indexCache.set(pack.collection, index);
    }
    const source = pack.title ?? pack.metadata?.label ?? pack.collection;
    for (const entry of index) {
      const n = normalizeLabel(entry?.name);
      if (!n) continue;
      // Index entries carry `uuid` on v11+; build it by hand as a fallback.
      const uuid = entry.uuid ?? `Compendium.${pack.collection}.Actor.${entry._id}`;
      if (n === key) push(exact, { uuid, name: entry.name, source, exact: true });
      else if (n.includes(key) || key.includes(n)) packLoose.push({ uuid, name: entry.name, source, exact: false });
    }
  }

  // Loose matches: world before packs, capped so the select stays sane.
  for (const row of worldLoose) { if (loose.length >= MAX_LOOSE_MATCHES) break; push(loose, row); }
  for (const row of packLoose) { if (loose.length >= MAX_LOOSE_MATCHES) break; push(loose, row); }
  return [...exact, ...loose];
}

// -----------------------------------------------------------------------------
// resolveActorSync(uuid)
// -----------------------------------------------------------------------------
// Null-safe `fromUuidSync`: a world Actor returns the document; a
// compendium uuid returns the index entry (not loaded) — both truthy,
// which is all "does this remembered uuid still resolve" needs.
// -----------------------------------------------------------------------------
function resolveActorSync(uuid) {
  if (!uuid) return null;
  try { return fromUuidSync(uuid) ?? null; } catch { return null; }
}

// -----------------------------------------------------------------------------
// readActorMap() / rememberActor(label, uuid)
// -----------------------------------------------------------------------------
// Accessors for the `encounterActorMap` world setting. `rememberActor`
// with an empty uuid forgets the label (so "(none)" is sticky too).
// -----------------------------------------------------------------------------
function readActorMap() {
  const raw = game.settings.get(MODULE_ID, SETTING_ACTOR_MAP);
  return raw && typeof raw === "object" ? raw : {};
}
async function rememberActor(label, uuid) {
  const key = normalizeLabel(label);
  if (!key) return;
  const next = { ...readActorMap() };
  if (uuid) next[key] = uuid; else delete next[key];
  await game.settings.set(MODULE_ID, SETTING_ACTOR_MAP, next);
}

// -----------------------------------------------------------------------------
// awaitCanvasClick()
// -----------------------------------------------------------------------------
// Resolve with the scene-space `{x, y}` of the GM's next left click on the
// canvas, or `null` if they press Escape first. One-shot: the listeners
// are removed on either outcome. Uses the PIXI stage (`canvas.stage`, with
// `canvas.app.stage` as the older alias) so the click lands regardless of
// which layer is active.
// -----------------------------------------------------------------------------
export function awaitCanvasClick() {
  return new Promise((resolve) => {
    const stage = canvas?.stage ?? canvas?.app?.stage;
    if (!stage?.on) { resolve(null); return; }
    const cleanup = () => {
      try { stage.off("pointerdown", onDown); } catch { /* already gone */ }
      window.removeEventListener("keydown", onKey, true);
    };
    const onDown = (event) => {
      // Right/middle button → ignore (the GM may be panning). `button` is
      // undefined on some PIXI shims; treat that as a left click.
      const button = event?.button ?? event?.data?.button;
      if (button !== undefined && button !== 0) return;
      cleanup();
      let pos = null;
      try {
        // PIXI v7 FederatedEvent (v11+) keeps the legacy `data` shim; the
        // direct method exists on FederatedMouseEvent as well.
        if (event?.data?.getLocalPosition) pos = event.data.getLocalPosition(canvas.stage);
        else if (event?.getLocalPosition) pos = event.getLocalPosition(canvas.stage);
      } catch { pos = null; }
      resolve(pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) ? { x: pos.x, y: pos.y } : null);
    };
    const onKey = (ev) => {
      if (ev.key !== "Escape") return;
      ev.stopPropagation();
      cleanup();
      resolve(null);
    };
    stage.on("pointerdown", onDown);
    // Capture phase so Foundry's own Escape handling (deselect / close
    // windows) doesn't swallow it before we see it.
    window.addEventListener("keydown", onKey, true);
  });
}

// -----------------------------------------------------------------------------
// ringOffsets(count)
// -----------------------------------------------------------------------------
// Grid-cell offsets `{dx, dy}` for `count` tokens around (0,0): the
// centre first, then successive square rings outward. Deterministic so a
// re-deploy lands in the same arrangement.
// -----------------------------------------------------------------------------
export function ringOffsets(count) {
  const out = [];
  if (count <= 0) return out;
  out.push({ dx: 0, dy: 0 });
  for (let r = 1; out.length < count; r++) {
    // Walk the perimeter of the r-ring clockwise from the top-left.
    for (let dx = -r; dx <= r && out.length < count; dx++) out.push({ dx, dy: -r });
    for (let dy = -r + 1; dy <= r && out.length < count; dy++) out.push({ dx: r, dy });
    for (let dx = r - 1; dx >= -r && out.length < count; dx--) out.push({ dx, dy: r });
    for (let dy = r - 1; dy >= -r + 1 && out.length < count; dy--) out.push({ dx: -r, dy });
  }
  return out;
}

// -----------------------------------------------------------------------------
// snapTokenTopLeft(center, widthCells, heightCells)
// -----------------------------------------------------------------------------
// Given a desired token centre in scene coordinates, return the snapped
// top-left `{x, y}` for a token of the given size (in grid cells).
//   v12+: `grid.getSnappedPoint` — snap the centre to a cell centre (odd
//         sizes) or a vertex (even sizes), then back off by half the size.
//   v11 : `grid.getSnappedPosition` on the top-left corner.
// Any failure falls back to the unsnapped top-left.
// -----------------------------------------------------------------------------
function snapTokenTopLeft(center, widthCells, heightCells) {
  const gs = canvas.grid?.size ?? 100;
  const halfW = (widthCells * gs) / 2;
  const halfH = (heightCells * gs) / 2;
  const raw = { x: center.x - halfW, y: center.y - halfH };
  try {
    if (typeof canvas.grid?.getSnappedPoint === "function") {
      const MODES = (typeof CONST !== "undefined" && CONST.GRID_SNAPPING_MODES) || { CENTER: 1, VERTEX: 240 };
      const even = Math.round(widthCells) % 2 === 0 && widthCells >= 1;
      const mode = even ? MODES.VERTEX : MODES.CENTER;
      const c = canvas.grid.getSnappedPoint({ x: center.x, y: center.y }, { mode, resolution: 1 });
      return { x: c.x - halfW, y: c.y - halfH };
    }
    if (typeof canvas.grid?.getSnappedPosition === "function") {
      const p = canvas.grid.getSnappedPosition(raw.x, raw.y, 1);
      return { x: p.x, y: p.y };
    }
  } catch (err) {
    console.warn(`[${MODULE_ID}] grid snap failed; placing unsnapped`, err);
  }
  return raw;
}

// -----------------------------------------------------------------------------
// resolveDeployActor(uuid)
// -----------------------------------------------------------------------------
// Turn a selected uuid into a WORLD Actor we can make tokens from. A
// compendium actor is imported into the world first (tokens can't
// reference pack documents). Returns `{ actor, importedUuid }` where
// `importedUuid` is set only when an import happened (so the caller can
// re-point the remembered mapping at the world copy).
// -----------------------------------------------------------------------------
async function resolveDeployActor(uuid) {
  if (!uuid) return { actor: null, importedUuid: null };
  let doc = null;
  try { doc = await fromUuid(uuid); } catch { doc = null; }
  if (!doc) return { actor: null, importedUuid: null };
  // World actor — use as-is.
  if (!doc.pack) return { actor: doc, importedUuid: null };
  // Compendium actor — import. Prefer the collection helper (keeps folder
  // + source metadata); fall back to a plain create from the object data.
  let imported = null;
  try {
    const pack = game.packs.get(doc.pack);
    if (pack && typeof game.actors.importFromCompendium === "function") {
      imported = await game.actors.importFromCompendium(pack, doc.id ?? doc._id);
    }
  } catch (err) {
    console.warn(`[${MODULE_ID}] importFromCompendium failed; falling back to Actor.create`, err);
  }
  if (!imported) {
    const data = doc.toObject?.() ?? doc;
    delete data._id;
    imported = await Actor.create(data);
  }
  return { actor: imported ?? null, importedUuid: imported?.uuid ?? null };
}

// -----------------------------------------------------------------------------
// deployEncounter(encounter, rowSelections, { onStatus })
// -----------------------------------------------------------------------------
// Place every matched creature row on the current scene and add the new
// tokens to the scene's Combat.
//   encounter     — the GMhub encounter row (with `creatures`).
//   rowSelections — Map<creatureId, actorUuid> (empty/missing = skip row).
//   onStatus(msg) — optional progress callback for the dialog status line.
// Flow:
//   1. Require `canvas.scene` (warn toast otherwise).
//   2. Toast "click the canvas", await one click (Escape cancels → null).
//   3. Resolve each selected actor (importing compendium actors), build
//      `quantity` token docs via `actor.getTokenDocument`, arranged on a
//      ring/grid of snapped cells around the click; `hidden` from the row;
//      `hp_override` → token delta HP; `flags.<module>.encounterId` stamped.
//   4. One `createEmbeddedDocuments("Token")` call.
//   5. Find-or-create the scene's Combat and add one Combatant per token.
//      Initiative is NOT rolled — the GM decides when.
// Returns `{ cancelled, created, skipped: [label], remembered: {label: uuid} }`.
// -----------------------------------------------------------------------------
export async function deployEncounter(encounter, rowSelections, { onStatus } = {}) {
  const status = (msg) => { try { onStatus?.(msg); } catch { /* ignore */ } };
  const creatures = Array.isArray(encounter?.creatures) ? encounter.creatures : [];
  const skipped = [];
  const remembered = {};

  // 1. Need a scene to drop tokens onto.
  if (!canvas?.scene) {
    ui.notifications.warn(game.i18n.localize("GMHUB.Encounters.Deploy.NoScene"));
    return { cancelled: true, created: 0, skipped, remembered };
  }

  // 2. Ask for the drop point.
  ui.notifications.info(game.i18n.localize("GMHUB.Encounters.Deploy.ClickCanvas"));
  status(game.i18n.localize("GMHUB.Encounters.Deploy.ClickCanvas"));
  const point = await awaitCanvasClick();
  if (!point) {
    status(game.i18n.localize("GMHUB.Encounters.Deploy.Cancelled"));
    return { cancelled: true, created: 0, skipped, remembered };
  }

  // 3. Resolve actors + build token docs.
  status(game.i18n.localize("GMHUB.Encounters.Deploy.Placing"));
  const plan = []; // [{ actor, creature }] one entry per TOKEN
  for (const creature of creatures) {
    const uuid = rowSelections?.get?.(creature.id) ?? rowSelections?.[creature.id] ?? "";
    if (!uuid) { skipped.push(creature.label); continue; }
    let resolved;
    try { resolved = await resolveDeployActor(uuid); } catch (err) {
      console.warn(`[${MODULE_ID}] resolve actor failed for ${creature.label}`, err);
      resolved = { actor: null, importedUuid: null };
    }
    if (!resolved.actor) { skipped.push(creature.label); continue; }
    if (resolved.importedUuid) remembered[creature.label] = resolved.importedUuid;
    const qty = Math.max(1, Math.min(50, Number(creature.quantity) || 1));
    for (let i = 0; i < qty; i++) plan.push({ actor: resolved.actor, creature });
  }
  if (!plan.length) {
    status(game.i18n.localize("GMHUB.Encounters.Deploy.NothingToPlace"));
    ui.notifications.warn(game.i18n.localize("GMHUB.Encounters.Deploy.NothingToPlace"));
    return { cancelled: false, created: 0, skipped, remembered };
  }

  // Spacing: one "slot" per ring cell, sized to the largest token so big
  // creatures don't overlap their neighbours. Width comes from the
  // prototype token (falls back to the dnd5e size code, then 1).
  const widthOf = (actor) => {
    const w = Number(actor?.prototypeToken?.width);
    if (Number.isFinite(w) && w > 0) return w;
    return SIZE_CELLS[actor?.system?.traits?.size] ?? 1;
  };
  const heightOf = (actor) => {
    const h = Number(actor?.prototypeToken?.height);
    if (Number.isFinite(h) && h > 0) return h;
    return widthOf(actor);
  };
  const slot = Math.max(1, ...plan.map((p) => Math.ceil(widthOf(p.actor))));
  const gs = canvas.grid?.size ?? 100;
  const offsets = ringOffsets(plan.length);
  // v11+ uses `delta` for per-token actor overrides; `actorData` before.
  const useDelta = foundry.utils.isNewerVersion(game.version, "10.999");

  const docs = [];
  for (let i = 0; i < plan.length; i++) {
    const { actor, creature } = plan[i];
    const w = widthOf(actor);
    const h = heightOf(actor);
    const center = { x: point.x + offsets[i].dx * slot * gs, y: point.y + offsets[i].dy * slot * gs };
    const topLeft = snapTokenTopLeft(center, w, h);
    const data = {
      x: topLeft.x,
      y: topLeft.y,
      hidden: Boolean(creature.hidden),
      flags: { [MODULE_ID]: { [FLAG_ENCOUNTER_ID]: encounter.id, [FLAG_ENCOUNTER_CREATURE_ID]: creature.id } }
    };
    const hpOverride = Number(creature.hp_override);
    if (Number.isFinite(hpOverride) && hpOverride > 0) {
      const override = { system: { attributes: { hp: { value: hpOverride, max: hpOverride } } } };
      if (useDelta) data.delta = override; else data.actorData = override;
      // A per-token HP override only applies to UNLINKED tokens — a linked
      // token reads HP straight from the Actor. Force unlinked for this
      // row so the override is honoured.
      data.actorLink = false;
    }
    try {
      // getTokenDocument merges `data` over the prototype token (async v11+).
      const td = await actor.getTokenDocument(data);
      docs.push(td.toObject());
    } catch (err) {
      // Fallback: hand-merge the prototype — same result on older cores.
      console.warn(`[${MODULE_ID}] getTokenDocument failed; merging prototype by hand`, err);
      const proto = actor.prototypeToken?.toObject?.() ?? {};
      docs.push(foundry.utils.mergeObject(proto, { ...data, actorId: actor.id }, { inplace: false }));
    }
  }

  // 4. Create the tokens in one batch.
  const created = await canvas.scene.createEmbeddedDocuments("Token", docs);

  // 5. Add them to the scene's combat (create if none). Prefer the viewed
  // combat when it belongs to this scene; otherwise any active combat on
  // this scene; otherwise create one.
  try {
    status(game.i18n.localize("GMHUB.Encounters.Deploy.AddingToCombat"));
    const sceneId = canvas.scene.id;
    let combat = game.combats?.viewed;
    if (!combat || (combat.scene?.id && combat.scene.id !== sceneId)) {
      combat = game.combats?.find?.((c) => c.scene?.id === sceneId) ?? null;
    }
    if (!combat) combat = await Combat.create({ scene: sceneId, active: true });
    const combatants = created.map((t) => ({
      tokenId: t.id,
      actorId: t.actorId ?? t.actor?.id ?? null,
      sceneId,
      hidden: Boolean(t.hidden)
    }));
    if (combat && combatants.length) await combat.createEmbeddedDocuments("Combatant", combatants);
  } catch (err) {
    // Tokens are already on the scene — combat is a nice-to-have.
    console.warn(`[${MODULE_ID}] adding deployed tokens to combat failed`, err);
    ui.notifications.warn(game.i18n.localize("GMHUB.Encounters.Deploy.CombatFailed"));
  }

  // Report.
  const summary = skipped.length
    ? game.i18n.format("GMHUB.Encounters.Deploy.DoneWithSkips", { count: created.length, skipped: skipped.join(", ") })
    : game.i18n.format("GMHUB.Encounters.Deploy.Done", { count: created.length });
  ui.notifications.info(summary);
  status(summary);
  return { cancelled: false, created: created.length, skipped, remembered };
}

// =============================================================================
// EncountersDialog
// =============================================================================
// ApplicationV1 dialog (same family as SyncDialog / PickSessionDialog —
// GMV-5 will migrate them together). State machine for the body:
//   loading → error | empty | groups
// Groups: the active session's encounters first, then the rest bucketed by
// session (named via the pulled session journal when present, otherwise
// "Unlinked"). Per-encounter expansion state and per-row actor picks live
// on the instance so a re-render (after a select change, a homebrew
// create, a deploy) doesn't collapse everything.
// =============================================================================
export class EncountersDialog extends Application {
  constructor(client, options = {}) {
    super(options);
    this.client = client;
    // Fetch state.
    this.loading = true;
    this.error = null;
    this.encounters = [];
    // UI state that must survive re-renders.
    this.expanded = new Set();                 // encounter ids currently open
    this.selections = new Map();               // `${encId}:${creatureId}` → uuid
    this.candidates = new Map();               // `${encId}:${creatureId}` → [{uuid,name,source,exact}]
    this.indexCache = new Map();               // pack.collection → index rows
    this.busy = new Set();                     // encounter ids with an op in flight
    this.creating = new Set();                 // row keys with a homebrew create in flight
    this.status = "";
  }
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "gmhub-encounters-dialog",
      title: "GMhub Encounters",
      template: `modules/${MODULE_ID}/templates/encounters.hbs`,
      width: 640, height: "auto", classes: ["gmhub-encounters-dialog"]
    });
  }
  get title() { return game.i18n.localize("GMHUB.Encounters.Title"); }

  // Composite key for per-row maps.
  static rowKey(encounterId, creatureId) { return `${encounterId}:${creatureId}`; }

  // ---------------------------------------------------------------------------
  // _refresh()
  // ---------------------------------------------------------------------------
  // (Re)fetch all encounters, then compute candidates + default selections
  // for every creature row. Candidate matching is async (pack indexes) so
  // it happens here rather than in getData.
  // ---------------------------------------------------------------------------
  async _refresh() {
    const campaignId = game.settings.get(MODULE_ID, "campaignId");
    if (!campaignId) {
      this.loading = false;
      this.error = game.i18n.localize("GMHUB.PickSession.NoCampaign");
      this.encounters = []; this.render(false); return;
    }
    this.loading = true; this.error = null; this.render(false);
    try {
      const rows = await safeCall(() => this.client.listAllEncounters(campaignId));
      this.encounters = Array.isArray(rows) ? rows : [];
      // Index caches are per-open: drop them so a Refresh sees new packs.
      this.indexCache.clear();
      this.candidates.clear();
      await this._prepareRows();
    } catch (err) {
      this.error = err?.message ?? String(err);
      this.encounters = [];
    }
    this.loading = false; this.render(false);
  }

  // ---------------------------------------------------------------------------
  // _prepareRows()
  // ---------------------------------------------------------------------------
  // For each creature row: compute candidates and, if the GM hasn't picked
  // in this dialog session yet, seed the selection from (a) the remembered
  // `encounterActorMap` uuid when it still resolves, else (b) the first
  // exact match, else "" (none).
  // ---------------------------------------------------------------------------
  async _prepareRows() {
    const actorMap = readActorMap();
    for (const enc of this.encounters) {
      for (const creature of enc.creatures ?? []) {
        const key = EncountersDialog.rowKey(enc.id, creature.id);
        const cands = await matchActorCandidates(creature.label, { indexCache: this.indexCache });
        this.candidates.set(key, cands);
        if (this.selections.has(key)) continue;
        const remembered = actorMap[normalizeLabel(creature.label)];
        if (remembered && resolveActorSync(remembered)) this.selections.set(key, remembered);
        else this.selections.set(key, cands.find((c) => c.exact)?.uuid ?? "");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // _sessionName(sessionId)
  // ---------------------------------------------------------------------------
  // Name of the pulled session journal for a GMhub session id (same flag
  // lookup as SyncService._findSessionJournal), or null when not pulled.
  // ---------------------------------------------------------------------------
  _sessionName(sessionId) {
    if (!sessionId) return null;
    const journal = game.journal?.contents?.find?.(
      (e) => e.getFlag(MODULE_ID, "kind") === "session" && e.getFlag(MODULE_ID, "externalId") === sessionId
    );
    return journal?.name ?? null;
  }

  // ---------------------------------------------------------------------------
  // _viewRow(enc, creature)
  // ---------------------------------------------------------------------------
  // Template-ready creature row: badges precomputed, the select's options
  // built from candidates + (if needed) a synthetic option for a remembered
  // uuid that resolves but wasn't among the candidates.
  // ---------------------------------------------------------------------------
  _viewRow(enc, creature) {
    const key = EncountersDialog.rowKey(enc.id, creature.id);
    const selected = this.selections.get(key) ?? "";
    const cands = this.candidates.get(key) ?? [];
    const options = cands.map((c) => ({
      uuid: c.uuid,
      label: c.exact ? `${c.name} (${c.source})` : `${c.name} (${c.source}) ~`,
      selected: c.uuid === selected
    }));
    if (selected && !options.some((o) => o.selected)) {
      const doc = resolveActorSync(selected);
      if (doc) options.unshift({ uuid: selected, label: `${doc.name ?? selected} (${game.i18n.localize("GMHUB.Encounters.Row.Remembered")})`, selected: true });
    }
    const existingHomebrew = creature.is_homebrew ? findHomebrewActor(creature.id) : null;
    return {
      id: creature.id,
      encounterId: enc.id,
      label: creature.label,
      quantity: creature.quantity ?? 1,
      showQuantity: (creature.quantity ?? 1) > 1,
      hidden: Boolean(creature.hidden),
      hpOverride: creature.hp_override ?? null,
      notes: creature.notes ?? "",
      isHomebrew: Boolean(creature.is_homebrew),
      homebrewExists: Boolean(existingHomebrew),
      creating: this.creating.has(key),
      options,
      hasSelection: Boolean(selected),
      noCandidates: options.length === 0
    };
  }

  // ---------------------------------------------------------------------------
  // _viewEncounter(enc)
  // ---------------------------------------------------------------------------
  _viewEncounter(enc) {
    const creatures = (enc.creatures ?? []).map((c) => this._viewRow(enc, c));
    const matched = creatures.filter((r) => r.hasSelection).length;
    return {
      id: enc.id,
      name: enc.name,
      sessionId: enc.session_id ?? null,
      expanded: this.expanded.has(enc.id),
      busy: this.busy.has(enc.id),
      creatures,
      creatureCount: creatures.length,
      matchedCount: matched,
      anyMatched: matched > 0
    };
  }

  getData() {
    const activeSessionId = game.settings.get(MODULE_ID, "activeSessionId") || "";
    const active = [];
    const buckets = new Map(); // bucket label → encounters[]
    for (const enc of this.encounters) {
      if (activeSessionId && enc.session_id === activeSessionId) { active.push(this._viewEncounter(enc)); continue; }
      const label = this._sessionName(enc.session_id)
        ?? (enc.session_id ? game.i18n.localize("GMHUB.Encounters.Group.OtherSession") : game.i18n.localize("GMHUB.Encounters.Group.Unlinked"));
      if (!buckets.has(label)) buckets.set(label, []);
      buckets.get(label).push(this._viewEncounter(enc));
    }
    const groups = [];
    if (active.length) {
      groups.push({
        label: this._sessionName(activeSessionId) ?? game.i18n.localize("GMHUB.Encounters.Group.ActiveSession"),
        isActive: true,
        encounters: active
      });
    }
    // Named-session buckets first (alphabetical), "Unlinked" last.
    const unlinkedLabel = game.i18n.localize("GMHUB.Encounters.Group.Unlinked");
    const named = [...buckets.keys()].filter((k) => k !== unlinkedLabel).sort((a, b) => a.localeCompare(b));
    for (const k of named) groups.push({ label: k, isActive: false, encounters: buckets.get(k) });
    if (buckets.has(unlinkedLabel)) groups.push({ label: unlinkedLabel, isActive: false, encounters: buckets.get(unlinkedLabel) });
    return {
      loading: this.loading,
      error: this.error,
      empty: !this.loading && !this.error && this.encounters.length === 0,
      hasActiveSession: Boolean(activeSessionId),
      groups,
      status: this.status
    };
  }

  _setStatus(message) { this.status = message ?? ""; this.render(false); }

  // Find the raw encounter row by id.
  _encounter(id) { return this.encounters.find((e) => e.id === id) ?? null; }

  activateListeners(html) {
    super.activateListeners(html);
    // First render → fetch. `loading` flips false after the first response.
    if (this.loading && !this.error) this._refresh();
    html.find('[data-action="refresh"]').on("click", () => this._refresh());

    // Expand / collapse an encounter. State lives in `this.expanded`.
    html.find('[data-action="toggle"]').on("click", (evt) => {
      const id = evt.currentTarget.dataset.encounterId;
      if (!id) return;
      if (this.expanded.has(id)) this.expanded.delete(id); else this.expanded.add(id);
      this.render(false);
    });

    // Actor pick: update the row selection + remember per label.
    html.find('[data-action="pick-actor"]').on("change", async (evt) => {
      const { encounterId, creatureId } = evt.currentTarget.dataset;
      const enc = this._encounter(encounterId);
      const creature = enc?.creatures?.find((c) => c.id === creatureId);
      if (!creature) return;
      const uuid = evt.currentTarget.value ?? "";
      this.selections.set(EncountersDialog.rowKey(encounterId, creatureId), uuid);
      try { await rememberActor(creature.label, uuid); } catch (err) {
        console.warn(`[${MODULE_ID}] encounterActorMap save failed`, err);
      }
      // Re-render so the matched-count badge on the encounter header updates.
      this.render(false);
    });

    // Homebrew: build the dnd5e actor, auto-select it, remember it.
    html.find('[data-action="create-homebrew"]').on("click", async (evt) => {
      const { encounterId, creatureId } = evt.currentTarget.dataset;
      const enc = this._encounter(encounterId);
      const creature = enc?.creatures?.find((c) => c.id === creatureId);
      if (!creature?.is_homebrew) return;
      const key = EncountersDialog.rowKey(encounterId, creatureId);
      if (this.creating.has(key)) return; // re-entrancy guard
      this.creating.add(key); this.render(false);
      try {
        const actor = await createHomebrewActor(creature);
        // Put the new actor at the top of this row's candidates (exact) and
        // every other row with the same label, then select + remember it.
        const cand = { uuid: actor.uuid, name: actor.name, source: "World", exact: true };
        const labelKey = normalizeLabel(creature.label);
        for (const e of this.encounters) {
          for (const c of e.creatures ?? []) {
            if (normalizeLabel(c.label) !== labelKey) continue;
            const k = EncountersDialog.rowKey(e.id, c.id);
            const list = (this.candidates.get(k) ?? []).filter((x) => x.uuid !== cand.uuid);
            this.candidates.set(k, [cand, ...list]);
          }
        }
        this.selections.set(key, actor.uuid);
        await rememberActor(creature.label, actor.uuid);
        ui.notifications.info(game.i18n.format("GMHUB.Encounters.Homebrew.Created", { name: actor.name }));
        this.status = game.i18n.format("GMHUB.Encounters.Homebrew.Created", { name: actor.name });
      } catch (err) {
        console.error(`[${MODULE_ID}] createHomebrewActor failed`, err);
        ui.notifications.error(game.i18n.format("GMHUB.Encounters.Homebrew.Failed", { message: err?.message ?? String(err) }));
        this.status = game.i18n.format("GMHUB.Encounters.Homebrew.Failed", { message: err?.message ?? String(err) });
      } finally {
        this.creating.delete(key);
        this.render(false);
      }
    });

    // Open an already-generated homebrew actor's sheet.
    html.find('[data-action="open-homebrew"]').on("click", (evt) => {
      const actor = findHomebrewActor(evt.currentTarget.dataset.creatureId);
      actor?.sheet?.render(true);
    });

    // Deploy: gather this encounter's selections and hand off.
    html.find('[data-action="deploy"]').on("click", async (evt) => {
      const encounterId = evt.currentTarget.dataset.encounterId;
      const enc = this._encounter(encounterId);
      if (!enc) return;
      if (this.busy.has(encounterId)) return; // re-entrancy guard
      const rowSelections = new Map();
      for (const c of enc.creatures ?? []) {
        rowSelections.set(c.id, this.selections.get(EncountersDialog.rowKey(enc.id, c.id)) ?? "");
      }
      this.busy.add(encounterId); this.render(false);
      try {
        const result = await deployEncounter(enc, rowSelections, { onStatus: (m) => this._setStatus(m) });
        // Compendium actors imported during deploy → re-point the remembered
        // mapping and the live selection at the world copy so the next
        // deploy doesn't import a second time.
        for (const [label, uuid] of Object.entries(result.remembered ?? {})) {
          const labelKey = normalizeLabel(label);
          for (const e of this.encounters) {
            for (const c of e.creatures ?? []) {
              if (normalizeLabel(c.label) !== labelKey) continue;
              const k = EncountersDialog.rowKey(e.id, c.id);
              this.selections.set(k, uuid);
              const list = (this.candidates.get(k) ?? []).filter((x) => x.uuid !== uuid);
              this.candidates.set(k, [{ uuid, name: label, source: "World", exact: true }, ...list]);
            }
          }
          try { await rememberActor(label, uuid); } catch { /* non-fatal */ }
        }
      } catch (err) {
        console.error(`[${MODULE_ID}] deployEncounter failed`, err);
        ui.notifications.error(game.i18n.format("GMHUB.Encounters.Deploy.Failed", { message: err?.message ?? String(err) }));
        this.status = game.i18n.format("GMHUB.Encounters.Deploy.Failed", { message: err?.message ?? String(err) });
      } finally {
        this.busy.delete(encounterId);
        this.render(false);
      }
    });
  }
}

// -----------------------------------------------------------------------------
// openEncountersDialog(client)
// -----------------------------------------------------------------------------
// Entry point for main.js (sidebar button, module API) and ui.js (Sync
// dialog button). Guards the missing-client case so a mis-ordered boot
// can't throw inside a click handler.
// -----------------------------------------------------------------------------
export function openEncountersDialog(client) {
  if (!client) return null;
  const dialog = new EncountersDialog(client);
  dialog.render(true);
  return dialog;
}
