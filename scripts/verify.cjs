#!/usr/bin/env node
"use strict";

// Post-install / post-restart checks. Exit code 0 = everything the plugin owns
// is in place and answering.

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

async function main() {
  const installs = lib.findInstalls();
  const appArg = arg("app", null);
  const install = appArg
    ? installs.find((i) => i.appDir === path.resolve(String(appArg))) ||
      { appDir: path.resolve(String(appArg)) }
    : installs[0];
  if (!install) throw new Error("no 9router install found — pass --app <dir>");

  const pluginDir = path.join(install.appDir, lib.PLUGIN_DIR_NAME);
  const checks = [];
  const add = (ok, label, detail = "") => checks.push({ ok, label, detail });

  add(fs.existsSync(path.join(pluginDir, "hook.cjs")), "plugin files copied", pluginDir);
  add(fs.existsSync(path.join(pluginDir, "config.json")), "config.json present");
  add(fs.existsSync(path.join(pluginDir, "ui.html")), "ui.html present");
  add(lib.hasHookPatch(install.appDir), "custom-server hook installed");
  const sidebar = lib.sidebarFiles(install.appDir);
  const patched = sidebar.filter((f) => fs.readFileSync(f, "utf8").includes('label:"OC Rotation"'));
  add(sidebar.length > 0 && patched.length === sidebar.length, "sidebar patched", patched.length + "/" + sidebar.length + " chunk(s)");

  const port = Number(arg("port", 0)) || (await lib.detectPort()) || lib.DEFAULT_APP_PORT;
  const state = await lib.httpGet("http://127.0.0.1:20130/state", 4000);
  const stateJson = state ? safeJson(state.body) : null;
  add(!!stateJson, "engine api answers on 20130", state ? "" : "start 9router first");

  const page = await lib.httpGet("http://127.0.0.1:" + port + "/dashboard/oc-rotation", 8000);
  add(!!page && page.status === 200 && /OC Rotation/.test(page.body || ""), "dashboard page served", "http " + (page ? page.status : "no response"));

  const proxy = await lib.httpGet("http://127.0.0.1:" + port + "/api/op-rotation", 8000);
  add(!!proxy && proxy.status === 200 && !!safeJson(proxy.body), "/api/op-rotation proxies engine", "http " + (proxy ? proxy.status : "no response"));

  if (stateJson) {
    const cands = (stateJson.candidates || []).length;
    add(cands > 0, "at least one oc-active pool", cands + " candidate(s)");
    if (stateJson.elim && stateJson.elim.enabled && cands === 0) {
      add(false, "elimination ON with no pool", "opencode /v1 returns 502 by design — fix pools or turn elimination off");
    }
    add(!!stateJson.muxListening, "mux listening on 127.0.0.1:" + (stateJson.effective ? stateJson.effective.muxPort : 20129));
  }

  console.log("OC Rotation — verification (" + install.appDir + ")");
  for (const c of checks) {
    console.log("  " + (c.ok ? "PASS" : "FAIL") + "  " + c.label + (c.detail ? "  · " + c.detail : ""));
  }
  const failed = checks.filter((c) => !c.ok).length;
  console.log("");
  console.log(failed === 0 ? "ALL CHECKS PASSED" : failed + " CHECK(S) FAILED — see the lines above and " + path.join(pluginDir, "logs"));
  process.exitCode = failed === 0 ? 0 : 1;
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

main().catch((e) => {
  console.error("verify failed:", e && e.message ? e.message : e);
  process.exitCode = 1;
});
