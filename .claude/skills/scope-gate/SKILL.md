---
name: scope-gate
description: Use BEFORE agreeing to implement any non-trivial feature in this Foundry module. Reads SCOPE.md "Out of scope" and "Behaviour contracts" and reports whether the request crosses a documented line. Particularly important for anything touching sync semantics, the cross-repo contract with gmhub-app, or the manual-sync-only rule.
allowed-tools: Read, Grep, Bash
---

# scope-gate (gmhub-vtt-bridge)

CLAUDE.md §8: "Read SCOPE.md before agreeing to a feature. If a
request would cross an out-of-scope line, surface that explicitly
rather than implementing."

This module's contract is unusually rigid because it consumes a
public API owned by `gmhub-app`. Out-of-scope is not just product
scope — it's also "this would be a `gmhub-app` change, not a module
change."

## Steps

1. **Read `SCOPE.md`** end to end.
2. **Read `docs/SISTER_REPO.md`** to understand which side owns
   what. The wire-format checklist in CLAUDE.md §3 is also relevant.
3. **Classify the request:**
   - **In-scope, this side** — pure consumer-side change (UI, sync
     orchestration, conflict policy). Proceed.
   - **In-scope, but wrong side** — needs an `/api/v1` change in
     `gmhub-app` first. Stop and explain; the user should open a
     `DMHUB` ticket.
   - **Out of scope** — manual-sync rule violated, multi-GM support,
     non-dnd5e system, bundler / external runtime deps, etc. Stop
     and explain.
4. **Surface the classification** before writing code.

## Specific gotchas

- **Manual sync only.** `autoPushOnUpdate` is the documented escape
  hatch; anything else that fires sync without an explicit user
  action is out of scope.
- **No external runtime deps.** `module.json#esmodules` must only
  reference files in this repo. No npm packages at runtime.
- **No build step.** Plain ES modules. A request for "let's add
  Vite / esbuild / Rollup" is out of scope.
- **Stable IDs via flags.** `flags.gmhub-vtt-bridge.externalId` is the
  join key on every synced journal. Re-syncs key off this, never
  by name.
- **Bearer token in `world` scope.** Settings registered with
  `scope: "world"`, `config: true`. Per-user token storage is out
  of scope (single-GM workflow).

## Output format

```
SCOPE GATE: <green | yellow | red>
Request: <one-line restatement>
Decision: <proceed | needs gmhub-app change first | stop>
Reason: <if not green, quote the contract>
```
