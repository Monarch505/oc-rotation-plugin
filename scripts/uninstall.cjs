#!/usr/bin/env node
"use strict";

// Removes the plugin. Restores what it patched by reversing the exact edits, so
// it works even when the backup folder is gone. Database rows (mux pool, kv
// state) are kept by default: pass --purge to drop them.

const fs = require("fs");
const path = require("path");
const lib = require("./lib.cjs");

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

function purgeDb(dataDir, log) {
  if (!dataDir) return log("no data dir — skipped db purge");
  const dbFile = path.join(dataDir, "db", "data.sqlite");
  if (!fs.existsSync(dbFile)) return log("db not found — skipped db purge");
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbFile);
    db.exec("PRAGMA busy_timeout=4000");
    db.prepare("DELETE FROM proxyPools WHERE id=?").run("oc-rotation-mux");
    db.prepare("DELETE FROM kv WHERE scope=?").run("ocRotation");
    log("db purged: mux pool row + ocRotation kv state");
  } catch (e) {
    log("db purge failed (server still running?): " + e.message);
  }
}

async function main() {
  const restartMode = String(arg("restart", "manual"));
  const purge = process.argv.includes("--purge");
  const installs = lib.findInstalls();
  const appArg = arg("app", null);
  const install = appArg
    ? installs.find((i) => i.appDir === path.resolve(String(appArg))) ||
      { appDir: path.resolve(String(appArg)) }
    : installs[0];
  if (!install) throw new Error("no 9router install found — pass --app <dir>");

  const pluginDir = path.join(install.appDir, lib.PLUGIN_DIR_NAME);
  const log = lib.makeLogger(path.join(pluginDir, "logs", "uninstall.log"));
  const port = Number(arg("port", 0)) || (await lib.detectPort()) || lib.DEFAULT_APP_PORT;

  log("uninstalling from " + install.appDir);
  if (restartMode === "auto" && lib.listListeners(port).length) {
    lib.stopServer(port, log);
    await lib.waitForPortFree(port, 25000);
  }

  const unhooked = lib.unpatchCustomServer(install.appDir, log);
  log("custom-server: " + (unhooked ? "hook removed" : "no hook marker found"));
  const restored = lib.unpatchSidebar(install.appDir, log);
  log("sidebar: " + restored.length + " file(s) restored");
  const purged = lib.purgeRouteCache(install.appDir);
  log("route-cache purged: " + (purged.join(", ") || "nothing to purge"));
  if (purge) purgeDb(install.dataDir, log);

  if (fs.existsSync(pluginDir)) {
    const backups = path.join(pluginDir, "backup");
    for (const entry of fs.readdirSync(pluginDir)) {
      if (entry === "backup" || entry === "logs") continue;
      fs.rmSync(path.join(pluginDir, entry), { recursive: true, force: true });
    }
    fs.rmSync(backups, { recursive: true, force: true });
    log("plugin files removed (logs kept in " + path.join(pluginDir, "logs") + ")");
  }

  if (restartMode === "auto") {
    lib.startServer(install, port, log);
    const up = await lib.waitForApp(port, 120000);
    log("server " + (up ? "is answering on " + port : "did NOT answer within 120s"));
  } else {
    log("9router was not restarted (manual mode) — start it yourself; the hook is already gone.");
  }
  log("UNINSTALL COMPLETE");
}

main().catch((e) => {
  console.error("uninstall failed:", e && e.message ? e.message : e);
  process.exitCode = 1;
});
