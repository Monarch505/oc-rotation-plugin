#!/usr/bin/env node
"use strict";

// Installs the plugin into one 9router app directory. Idempotent, backed up,
// reversible with scripts/uninstall.cjs. Every step is logged to a file the
// user and the agent can read.

const fs = require("fs");
const path = require("path");
const lib = require("./lib.cjs");

const PLUGIN_VERSION = "1.0.0";

function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith("--" + name + "="));
  if (hit) return hit.slice(name.length + 3);
  const idx = process.argv.indexOf("--" + name);
  if (idx !== -1) {
    const next = process.argv[idx + 1];
    return next && !next.startsWith("--") ? next : true;
  }
  return fallback;
}

function resolveInstall(appArg) {
  const installs = lib.findInstalls();
  if (appArg) {
    const abs = path.resolve(String(appArg));
    const appDir = fs.existsSync(path.join(abs, "custom-server.js")) ? abs : path.join(abs, "app");
    if (!fs.existsSync(path.join(appDir, "custom-server.js"))) {
      throw new Error("not a 9router app directory: " + appDir);
    }
    const known = installs.find((i) => i.appDir === appDir);
    if (known) return known;
    const pkgDir = path.dirname(appDir);
    const launcher = path.join(pkgDir, "cli.js");
    return {
      packageDir: pkgDir,
      appDir,
      launcherPath: fs.existsSync(launcher) ? launcher : null,
      launcherVersion: (lib.readJson(path.join(pkgDir, "package.json"), {}) || {}).version || null,
      appVersion: (lib.readJson(path.join(appDir, "package.json"), {}) || {}).version || null,
      buildDirs: lib.buildDirs(appDir).map((d) => path.basename(d)),
      dataDir: lib.findDataDir(),
      hasPlugin: fs.existsSync(path.join(appDir, lib.PLUGIN_DIR_NAME, "hook.cjs")),
      hookPatched: lib.hasHookPatch(appDir),
    };
  }
  if (installs.length === 1) return installs[0];
  if (!installs.length) throw new Error("no 9router installation found — run scripts/detect.cjs and pass --app <dir>");
  throw new Error("multiple installs found — pass --app <dir>:\n  " + installs.map((i) => i.appDir).join("\n  "));
}

async function main() {
  const force = process.argv.includes("--force");
  const dryRun = process.argv.includes("--dry-run");
  const restartMode = String(arg("restart", "manual"));
  const install = resolveInstall(arg("app", null));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const pluginDir = path.join(install.appDir, lib.PLUGIN_DIR_NAME);
  const log = dryRun
    ? (msg) => console.log("[dry-run] " + msg)
    : lib.makeLogger(path.join(pluginDir, "logs", "apply-" + stamp + ".log"));

  log("oc-rotation-plugin " + PLUGIN_VERSION + " → " + install.appDir);
  log("app version " + (install.appVersion || "unknown") + ", supported " + lib.SUPPORTED_APP);
  if (install.appVersion !== lib.SUPPORTED_APP && !force) {
    throw new Error("app version " + install.appVersion + " is not the pinned " + lib.SUPPORTED_APP +
      ". Re-run with --force only after reviewing scripts/lib.cjs (sidebar anchor + payload).");
  }
  if (install.needsBuild) throw new Error("no Next build found in " + install.appDir + " (.next* missing)");

  const port = Number(arg("port", 0)) || (await lib.detectPort()) || lib.DEFAULT_APP_PORT;
  const running = lib.listListeners(port);
  const sidebar = lib.sidebarFiles(install.appDir);
  log("app port " + port + (running.length ? " (running, pid " + running.join(",") + ")" : " (not running)"));
  log("sidebar chunks found: " + sidebar.length);
  if (!sidebar.length) throw new Error("sidebar anchor not found in the build — this build is not patchable as-is");

  if (dryRun) {
    log("dry run — nothing modified. Planned steps:");
    log("  1. copy plugin → " + pluginDir);
    log("  2. write config.json (dataDir, ports, probe endpoints)");
    log("  3. patch custom-server.js (one require block, marker-guarded)");
    log("  4. patch " + sidebar.length + " sidebar chunk file(s)");
    log("  5. purge server/route-cache");
    log("  6. restart: " + restartMode);
    return;
  }

  if (restartMode === "auto" && running.length) {
    log("stopping 9router …");
    lib.stopServer(port, log);
    const free = await lib.waitForPortFree(port, 25000);
    log("port " + port + (free ? " free" : " still busy — continuing anyway"));
  }

  const backupRoot = path.join(pluginDir, "backup", stamp);
  lib.backupFile(path.join(install.appDir, "custom-server.js"), backupRoot);
  for (const file of sidebar) lib.backupFile(file, backupRoot);
  log("backup → " + backupRoot);

  fs.mkdirSync(path.join(pluginDir, "logs"), { recursive: true });
  const payload = lib.pluginPayloadDir();
  for (const name of ["engine.cjs", "hook.cjs", "ui.html"]) {
    fs.copyFileSync(path.join(payload, name), path.join(pluginDir, name));
  }
  log("copied engine/hook/ui");

  const config = {
    pluginVersion: PLUGIN_VERSION,
    installedAt: new Date().toISOString(),
    appDir: install.appDir,
    dataDir: install.dataDir,
    appPort: port,
    muxPort: 20129,
    apiPort: 20130,
    probeHost: "opencode.ai",
    probeModelsPath: "/zen/v1/models",
    probeChatPath: "/inference/openai/v1/chat/completions",
    claimAll429: false,
  };
  fs.writeFileSync(path.join(pluginDir, "config.json"), JSON.stringify(config, null, 2), "utf8");
  log("wrote config.json (dataDir " + install.dataDir + ", api 20130, mux 20129)");

  const hook = lib.patchCustomServer(install.appDir, log);
  log("custom-server: " + (hook.patched ? "patched" : hook.reason));

  const patchedSidebar = lib.patchSidebar(install.appDir, log);
  log("sidebar: " + patchedSidebar.length + " file(s) patched");

  const purged = lib.purgeRouteCache(install.appDir);
  log("route-cache purged: " + (purged.join(", ") || "nothing to purge"));

  if (restartMode === "auto") {
    log("starting 9router …");
    lib.startServer(install, port, log);
    const up = await lib.waitForApp(port, 120000);
    log("server " + (up ? "is answering on " + port : "did NOT answer within 120s — check " + path.join(pluginDir, "logs") + " and the dashboard"));
    if (!up) process.exitCode = 3;
  } else {
    log("9router was NOT restarted (manual mode). Start it the way you normally do, then run scripts/verify.cjs");
  }

  log("");
  log("INSTALL COMPLETE");
  log("  dashboard page : http://127.0.0.1:" + port + "/dashboard/oc-rotation");
  log("  engine api     : http://127.0.0.1:20130/state (loopback only)");
  log("  logs           : " + path.join(pluginDir, "logs"));
  log("  rollback       : node scripts/uninstall.cjs --app \"" + install.appDir + "\"");
  log("Elimination stays OFF until a pool reaches oc-active; turning it on early makes opencode /v1 return 502 by design.");
}

main().catch((e) => {
  console.error("apply failed:", e && e.message ? e.message : e);
  process.exitCode = 1;
});
