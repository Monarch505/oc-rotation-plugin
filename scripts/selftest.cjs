#!/usr/bin/env node
"use strict";

// Self-check for the installer's patching logic against a fake app dir:
//   node scripts/selftest.cjs
// Asserts: hook patch is idempotent and removable, sidebar patch survives a
// second apply and reverses exactly, route-cache purge deletes the cache only.

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const lib = require("./lib.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-rotation-selftest-"));
const appDir = path.join(tmp, "app");
const chunkDir = path.join(appDir, ".next-cli-build", "server", "chunks");
const staticDir = path.join(appDir, ".next-cli-build", "static", "chunks");
const cacheDir = path.join(appDir, ".next-cli-build", "server", "route-cache", "APP_PAGE", "hash");

fs.mkdirSync(chunkDir, { recursive: true });
fs.mkdirSync(staticDir, { recursive: true });
fs.mkdirSync(cacheDir, { recursive: true });
fs.writeFileSync(path.join(cacheDir, "page.html"), "<html>stale</html>");

const customServer = 'const http = require("http");\nconst origCreate = http.createServer.bind(http);\n';
fs.writeFileSync(path.join(appDir, "custom-server.js"), customServer, "utf8");

const chunkBody = 'module.exports=[1,a=>{var v=[{href:"/dashboard/proxy-pools",label:"Proxy Pools",icon:"lan"},];}];\n';
fs.writeFileSync(path.join(chunkDir, "sidebar.js"), chunkBody, "utf8");
fs.writeFileSync(path.join(staticDir, "sidebar.js"), chunkBody, "utf8");

const quiet = () => {};

// custom-server hook: applied once, idempotent, reversible byte-for-byte.
assert.strictEqual(lib.hasHookPatch(appDir), false);
assert.strictEqual(lib.patchCustomServer(appDir, quiet).patched, true);
assert.strictEqual(lib.hasHookPatch(appDir), true);
assert.strictEqual(lib.patchCustomServer(appDir, quiet).patched, false, "second patch must be a no-op");
assert.ok(fs.readFileSync(path.join(appDir, "custom-server.js"), "utf8").includes("hook.cjs"));
assert.strictEqual(lib.unpatchCustomServer(appDir, quiet), true);
assert.ok(!lib.hasHookPatch(appDir));
assert.ok(fs.readFileSync(path.join(appDir, "custom-server.js"), "utf8").startsWith(customServer.trimEnd()));

// sidebar: both chunk copies patched, second run no-ops, uninstall restores.
const files = lib.sidebarFiles(appDir);
assert.strictEqual(files.length, 2, "expected the server and client chunks");
assert.strictEqual(lib.patchSidebar(appDir, quiet).length, 2);
assert.strictEqual(lib.patchSidebar(appDir, quiet).length, 0, "second patch must be a no-op");
for (const f of files) {
  const text = fs.readFileSync(f, "utf8");
  assert.ok(text.includes('label:"Proxy Pools"'), "anchor kept");
  assert.strictEqual(text.split('label:"OC Rotation"').length - 1, 1, "exactly one sidebar entry");
}
assert.strictEqual(lib.unpatchSidebar(appDir, quiet).length, 2);
for (const f of files) assert.ok(!fs.readFileSync(f, "utf8").includes("OC Rotation"));

// route-cache purge touches only the cache.
lib.patchCustomServer(appDir, quiet);
const purged = lib.purgeRouteCache(appDir);
assert.deepStrictEqual(purged, [path.join(appDir, ".next-cli-build", "server", "route-cache")]);
assert.ok(!fs.existsSync(cacheDir));
assert.ok(fs.existsSync(path.join(chunkDir, "sidebar.js")), "chunks must survive the purge");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("selftest OK — hook patch, sidebar patch, idempotency, reversal, route-cache purge");
