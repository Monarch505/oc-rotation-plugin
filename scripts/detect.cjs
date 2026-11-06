#!/usr/bin/env node
"use strict";

// Read-only environment analysis. Run this first; it never writes anything.

const path = require("path");
const lib = require("./lib.cjs");

async function main() {
  const json = process.argv.includes("--json");
  const installs = lib.findInstalls();
  const port = await lib.detectPort();
  const dataDir = lib.findDataDir();

  const report = {
    platform: process.platform,
    node: process.version,
    appVersionSupported: lib.SUPPORTED_APP,
    dataDir,
    dataDirExists: !!(dataDir && require("fs").existsSync(path.join(dataDir, "db", "data.sqlite"))),
    runningPort: port,
    listenerPids: port ? lib.listListeners(port) : [],
    installs: installs.map((i) => ({
      appDir: i.appDir,
      launcherPath: i.launcherPath,
      appVersion: i.appVersion,
      launcherVersion: i.launcherVersion,
      buildDirs: i.buildDirs,
      needsBuildFirst: i.needsBuild,
      alreadyInstalled: i.hasPlugin,
      hookPatched: i.hookPatched,
      supported: i.appVersion === lib.SUPPORTED_APP,
    })),
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log("9router OC Rotation — environment analysis");
  console.log("  platform      : " + report.platform + " (node " + report.node + ")");
  console.log("  data dir      : " + (report.dataDir || "not found") + (report.dataDirExists ? " (db found)" : " (no db/data.sqlite)"));
  console.log("  app port      : " + (port || "not running / not detected"));
  if (report.listenerPids.length) console.log("  listener pid  : " + report.listenerPids.join(", "));
  console.log("");
  if (!installs.length) {
    console.log("No 9router (9router-pro) installation found in the usual global locations.");
    console.log("Ask the user where it is installed, then rerun with --app <dir>.");
    process.exitCode = 2;
    return;
  }
  for (const i of report.installs) {
    console.log("install        : " + i.appDir);
    console.log("  app version  : " + (i.appVersion || "unknown") + (i.supported ? "  (supported)" : "  (NOT the pinned version)"));
    console.log("  launcher     : " + (i.launcherPath || "not found — server will be started with custom-server.js"));
    console.log("  build dir    : " + (i.buildDirs.join(", ") || "none — install needs a build first"));
    console.log("  plugin       : " + (i.alreadyInstalled ? "already installed" : "not installed") + (i.hookPatched ? ", hook active" : ""));
    console.log("");
  }
  console.log("ANALYSIS COMPLETE — nothing was modified.");
  console.log("Next step: scripts/apply.cjs --app <dir> [--restart=auto|manual]");
  console.log("Applying stops 9router for a few seconds, then it is started again (or you start it manually).");
}

main().catch((e) => {
  console.error("detect failed:", e && e.message ? e.message : e);
  process.exitCode = 1;
});
