---
name: oc-rotation
description: Install, verify, and remove the OC Rotation plugin on a 9router install (opencode free-tier pool rotation with 429 elimination). Use when the user asks to install OC Rotation, rotate opencode free pools, or diagnose the rotation engine.
---

# OC Rotation plugin — agent runbook

Single-active proxy-pool rotation for 9router's opencode free lane: one pool at a
time behind a local CONNECT mux, 429 elimination with a cascade guard, fail-closed
(no local egress when no pool is healthy).

Follow the steps in order. Steps 1-3 are read-only; step 4 changes the target
install; step 5 verifies; step 6 is what the user does afterwards.

## 0. Preconditions

- Node `>= 22.5` (the engine uses `node:sqlite`).
- 9router installed globally as the `9router-pro` package (npm/bun/pnpm/volta/nvm all covered).
- Target app version must be `0.5.109-pro.15`. Another version is refused; do not
  pass `--force` unless you have reviewed `scripts/lib.cjs` (sidebar anchor and
  payload are pinned).

## 1. Analyse the environment (read-only)

```bash
node scripts/detect.cjs
# machine-readable: node scripts/detect.cjs --json
```

It reports: platform, data dir (`db/data.sqlite`), running app port, listener PIDs,
every 9router install it found, the app version, whether a Next build exists, and
whether the plugin is already installed. Nothing is written.

If nothing is found, ask the user for the install path, then rerun with
`--app <dir>` on the later commands.

## 2. Report to the user before touching anything

Say, in the user's language:

- where 9router is installed and which version, plus the data dir and port;
- that **applying stops 9router for a few seconds** and it is started again
  afterwards (or left stopped if the user prefers to start it manually);
- that the plugin is installed as `plugins/oc-rotation/` plus one guarded hook in
  `custom-server.js` and one sidebar entry in the compiled build, and that
  `scripts/uninstall.cjs` reverses all of it.

Wait for a green light. Then ask which restart mode to use (or take it from what
the user already said):

- `--restart=auto` — the script stops, patches, starts, and waits for `/api/health`.
- `--restart=manual` (default) — the script patches and stops nothing; the user
  starts 9router the way they normally do.

Never stop the user's server yourself before they choose.

## 3. Optional dry run

```bash
node scripts/apply.cjs --app "<app dir>" --dry-run
```

Prints every planned step; modifies nothing.

## 4. Apply

```bash
node scripts/apply.cjs --app "<app dir>" --restart=auto     # or --restart=manual
```

What it does, in order: version check → backup (`plugins/oc-rotation/backup/<stamp>/`)
→ copy `engine.cjs`/`hook.cjs`/`ui.html` → write `config.json` (data dir, ports,
probe endpoints) → patch `custom-server.js` (marker-guarded, appended at the end)
→ patch the compiled sidebar chunk(s) → purge `server/route-cache` → restart
(unless manual) → wait for the app.

Everything it did is logged to `plugins/oc-rotation/logs/apply-<stamp>.log`. Print
the tail of that file to the user instead of paraphrasing.

## 5. Verify

```bash
node scripts/verify.cjs --app "<app dir>"
```

Exit code 0 means: files in place, hook installed, sidebar patched, engine answering
on `127.0.0.1:20130`, `/dashboard/oc-rotation` served, `/api/op-rotation` proxying,
mux listening. Every check prints PASS/FAIL with the reason.

If the engine answers but there are no `oc-active` pools, that is expected on a
fresh install — continue to step 6.

## 6. First-run activation (the user does this in the dashboard)

1. Open Proxy Pools and make sure the user's proxy pools are present and active.
2. Open `http://127.0.0.1:<port>/dashboard/oc-rotation`.
3. Press **Check all pools**. Pools become `oc-active` when one real request
   through that pool reaches the opencode free lane.
4. Only after at least one pool is `oc-active`, turn **Elimination** on. It wires
   `providerStrategies.opencode.proxyPoolIds` to the mux pool.
5. Optional: enable auto sweep so the pools keep being probed.

Warn the user explicitly: enabling Elimination with zero `oc-active` pools makes
every opencode `/v1` request return **502** — that is the fail-closed design, not a
bug. It exists so a dead proxy never leaks the local IP.

## 7. Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| `/dashboard/oc-rotation` 404 or the sidebar entry is missing | route-cache stale after patching | stop, `node scripts/apply.cjs --app <dir> --restart=manual` again (it purges), start |
| `/api/op-rotation` 503 | hook did not load or engine crashed | read `plugins/oc-rotation/logs/hook.log` and `engine.log` |
| All requests 502 | Elimination on with zero `oc-active` pools | turn Elimination off, run Check all |
| Every pool `oc-limited` | the free tier quota is global, not per IP | rotation cannot fix it; wait for the quota reset |
| Sidebar entry duplicated | apply ran twice on different builds | `uninstall.cjs` then apply once |
| Mux tunnels fail everywhere | pools dead or `strictProxy` off | re-check pools; the mux pool is created with `strictProxy: true` |

## 8. Uninstall

```bash
node scripts/uninstall.cjs --app "<app dir>" --restart=manual
node scripts/uninstall.cjs --app "<app dir>" --restart=auto --purge
```

Removes the hook, restores the sidebar chunks, purges route-cache, deletes plugin
files (logs kept), and with `--purge` also drops the mux pool row and the
`ocRotation` kv state. Restart required before the change takes effect.

## Safety rules

- Loopback only: mux `127.0.0.1:20129`, engine API `127.0.0.1:20130`. Never expose
  or port-forward them; the API is unauthenticated by design.
- Do not edit `custom-server.js` outside the marked block; uninstall depends on it.
- Do not patch anything else in the build. One anchor, one entry.
- Never enable Elimination before an `oc-active` pool exists.
- Do not restart the user's 9router without their approval.
