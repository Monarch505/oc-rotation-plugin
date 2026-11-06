# oc-rotation-plugin

Single-active proxy-pool rotation for the **opencode free lane** in 9router.

One healthy proxy pool at a time sits behind a local CONNECT mux. A 429 from the
free lane eliminates that pool and rotates to the next one, with a cascade guard
that pauses elimination when too many pools die at once. When no pool is healthy
the mux refuses the connection (`502`) instead of falling back to the local IP.

Designed to be installed by an agent: [`MANUAL.md`](MANUAL.md) is the manual,
and every step reports what it found before it changes anything.

## Requirements

- Node `>= 22.5` (uses `node:sqlite`, no native modules)
- 9router (`9router-pro`) installed globally, app version **0.5.109-pro.15**
- No rebuild: the plugin is a runtime hook plus one sidebar entry in the compiled build

## Install

```bash
node scripts/detect.cjs                  # read-only analysis
node scripts/apply.cjs --app "<9router app dir>" --dry-run
node scripts/apply.cjs --app "<9router app dir>" --restart=auto
node scripts/verify.cjs --app "<9router app dir>"
```

`--restart=auto` stops 9router, patches, starts it again and waits for
`/api/health`. `--restart=manual` (default) patches without touching the running
process — you start 9router yourself.

On Windows the app dir is usually
`%APPDATA%\npm\node_modules\9router-pro\app`; on Linux/macOS it is
`$(npm root -g)/9router-pro/app`. `detect.cjs` prints the real path.

## Use

Open `http://127.0.0.1:20127/dashboard/oc-rotation` (port is the one 9router runs
on; it is also in the sidebar under **System**).

1. **Check all pools** — each pool gets one real request on the free lane.
   Verdict: `oc-active`, `oc-limited` (free quota), or `oc-error`.
2. Turn **Elimination** on **only after** at least one pool is `oc-active`.
   It wires `providerStrategies.opencode.proxyPoolIds` to the mux pool.
3. Optional: auto sweep, so pools keep being probed.

Turning Elimination on with zero `oc-active` pools makes every opencode `/v1`
request return `502`. That is the fail-closed design: a dead pool must never leak
the local IP.

## How it works

```
client → 9router :20127 → (Elimination on) providerStrategies.opencode
       → pool "oc-rotation-mux" (strictProxy) → CONNECT mux 127.0.0.1:20129
       → current pool → opencode.ai
```

- `plugin/engine.cjs` — mux, probe, rotation, cooldown, cascade, elimination,
  loopback API on `127.0.0.1:20130`.
- `plugin/hook.cjs` — installed from `custom-server.js`; serves the dashboard page
  and `/api/op-rotation`, and attributes a 429 on `/v1/*` (body signature
  `FreeUsageLimitError`/`FreeTierError`/free-tier text) to the pool that was
  current when the request started.
- `plugin/ui.html` — the dashboard, served by the hook, no rebuild needed.

Attribution is timeline based: the engine resolves the pool that was `current` at
request start from the rotation log. Retries and late responses resolve to an
already-eliminated pool and no-op, so a single 429 cannot eliminate two pools.

## Limits

- A free-tier 429 is **global quota**, not per-IP. When every pool is `oc-limited`,
  no rotation helps; the plugin will keep returning the visible 502 until the
  quota resets.
- Probe mode `endpoint` (default) only checks that the pool reaches the opencode
  API. Probe mode `chat` runs one tiny completion and does consume quota.
- Version-pinned: `0.5.109-pro.15`. The sidebar anchor is a literal in the compiled
  chunk; other versions are refused unless `--force`.
- Do not stack it on a build that already ships OC Rotation (mux 20129 and API
  20130 would collide). Uninstall the built-in copy first.

## Uninstall

```bash
node scripts/uninstall.cjs --app "<9router app dir>" --restart=auto
```

Removes the hook, restores the sidebar chunks, purges route-cache, deletes plugin
files (logs kept). Add `--purge` to also drop the mux pool row and `ocRotation`
state from the database.

## Layout

```
plugin/engine.cjs     rotation engine + loopback API
plugin/hook.cjs       custom-server hook (routes, 429 sniffing, engine start)
plugin/ui.html        dashboard page
scripts/detect.cjs    read-only environment analysis
scripts/apply.cjs     install (backup, copy, patch, restart)
scripts/verify.cjs    post-install checks
scripts/uninstall.cjs rollback
scripts/lib.cjs       shared install logic
MANUAL.md             installation manual / agent runbook
```

MIT licensed.
