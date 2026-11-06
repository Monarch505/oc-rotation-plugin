"use strict";

// Shared install logic for detect/apply/verify/uninstall. No dependencies.

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFileSync, spawn } = require("child_process");

// Pinned on purpose: the sidebar chunk anchor and the plugin payload are
// verified against exactly this build. A different version is refused unless
// the caller passes --force and accepts the risk.
const SUPPORTED_APP = "0.5.109-pro.15";
const PLUGIN_DIR_NAME = "plugins/oc-rotation";
const HOOK_BEGIN = "// >>> oc-rotation-plugin >>>";
const HOOK_END = "// <<< oc-rotation-plugin <<<";
const SIDEBAR_ANCHOR = '{href:"/dashboard/proxy-pools",label:"Proxy Pools",icon:"lan"}';
const SIDEBAR_ENTRY = '{href:"/dashboard/oc-rotation",label:"OC Rotation",icon:"sync_alt"}';
const DEFAULT_APP_PORT = 20127;
const CANDIDATE_PORTS = [20127, 3000, 3001, 8000, 8080, 9000];

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function packageCandidates() {
  const out = [];
  const push = (p) => { if (p) out.push(p); };
  const nodeRoot = path.dirname(process.execPath);
  push(path.join(nodeRoot, "node_modules", "9router-pro"));
  push(path.join(nodeRoot, "..", "lib", "node_modules", "9router-pro"));
  if (process.env.APPDATA) push(path.join(process.env.APPDATA, "npm", "node_modules", "9router-pro"));
  if (process.env.LOCALAPPDATA) {
    push(path.join(process.env.LOCALAPPDATA, "npm", "node_modules", "9router-pro"));
    push(path.join(process.env.LOCALAPPDATA, "pnpm", "global", "5", "node_modules", "9router-pro"));
  }
  push(path.join(os.homedir(), ".npm-global", "lib", "node_modules", "9router-pro"));
  push(path.join(os.homedir(), ".bun", "install", "global", "node_modules", "9router-pro"));
  push(path.join(os.homedir(), ".local", "share", "pnpm", "global", "5", "node_modules", "9router-pro"));
  push(path.join(os.homedir(), ".volta", "tools", "image", "node", "lib", "node_modules", "9router-pro"));
  push("/usr/lib/node_modules/9router-pro");
  push("/usr/local/lib/node_modules/9router-pro");
  push("/opt/homebrew/lib/node_modules/9router-pro");
  try {
    if (process.env.NVM_BIN) push(path.join(process.env.NVM_BIN, "..", "lib", "node_modules", "9router-pro"));
  } catch {}
  try {
    const nvmDir = path.join(os.homedir(), ".nvm", "versions", "node");
    for (const v of fs.readdirSync(nvmDir)) push(path.join(nvmDir, v, "lib", "node_modules", "9router-pro"));
  } catch {}
  return out;
}

function findInstalls() {
  const seen = new Set();
  const found = [];
  for (const dir of packageCandidates()) {
    const appDir = path.join(dir, "app");
    const pkg = path.join(dir, "package.json");
    if (!fs.existsSync(path.join(appDir, "custom-server.js"))) continue;
    if (seen.has(appDir)) continue;
    seen.add(appDir);
    const launcher = readJson(pkg, {}) || {};
    const appPkg = readJson(path.join(appDir, "package.json"), {}) || {};
    found.push({
      packageDir: dir,
      appDir,
      launcherPath: fs.existsSync(path.join(dir, "cli.js")) ? path.join(dir, "cli.js") : null,
      launcherVersion: launcher.version || null,
      appVersion: appPkg.version || null,
      needsBuild: fs.existsSync(path.join(appDir, ".next-cli-build")) || fs.existsSync(path.join(appDir, ".next")) ? false : true,
      buildDirs: [".next-cli-build", ".next"].filter((d) => fs.existsSync(path.join(appDir, d))),
      dataDir: findDataDir(),
      hasPlugin: fs.existsSync(path.join(appDir, PLUGIN_DIR_NAME, "hook.cjs")),
      hookPatched: hasHookPatch(appDir),
    });
  }
  return found;
}

function findDataDir() {
  const pick = [
    process.env.DATA_DIR,
    process.env.APPDATA ? path.join(process.env.APPDATA, "9router") : null,
    path.join(os.homedir(), ".9router"),
    path.join(os.homedir(), ".config", "9router"),
    path.join(os.homedir(), "Library", "Application Support", "9router"),
  ].filter(Boolean);
  for (const d of pick) {
    try { if (fs.existsSync(path.join(d, "db", "data.sqlite"))) return d; } catch {}
  }
  return pick[0] || null;
}

function hasHookPatch(appDir) {
  try {
    return fs.readFileSync(path.join(appDir, "custom-server.js"), "utf8").includes(HOOK_BEGIN);
  } catch { return false; }
}

function httpGet(url, timeout = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", () => resolve(null));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

// A running 9router answers /api/health or /api/settings on its app port.
async function detectPort(candidatePorts = CANDIDATE_PORTS) {
  for (const port of candidatePorts) {
    const health = await httpGet("http://127.0.0.1:" + port + "/api/health", 1200);
    if (health && health.status && health.body && /"ok"|healthy|version/i.test(health.body)) return port;
  }
  return null;
}

function listListeners(port) {
  const pids = new Set();
  if (process.platform === "win32") {
    let out = "";
    try { out = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", windowsHide: true }); } catch { return []; }
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const cols = line.trim().split(/\s+/);
      const local = cols[1] || "";
      if (!local.endsWith(":" + port)) continue;
      const pid = Number(cols[cols.length - 1]);
      if (Number.isFinite(pid) && pid > 0) pids.add(pid);
    }
    return [...pids];
  }
  try {
    const out = execFileSync("lsof", ["-ti", "tcp:" + port, "-sTCP:LISTEN"], { encoding: "utf8" });
    for (const p of out.split(/\s+/)) if (p) pids.add(Number(p));
  } catch {
    try {
      const out = execFileSync("ss", ["-ltnp", "sport = :" + port], { encoding: "utf8" });
      for (const m of out.matchAll(/pid=(\d+)/g)) pids.add(Number(m[1]));
    } catch {}
  }
  return [...pids];
}

function processInfo(pid) {
  if (process.platform === "win32") {
    try {
      const out = execFileSync("powershell", ["-NoProfile", "-Command",
        "(Get-CimInstance Win32_Process -Filter \"ProcessId=" + pid + "\") | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"],
        { encoding: "utf8", windowsHide: true });
      const j = JSON.parse(out.trim());
      return { pid: Number(j.ProcessId), ppid: Number(j.ParentProcessId), cmd: String(j.CommandLine || "") };
    } catch { return null; }
  }
  try {
    const cmd = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").replace(/\0/g, " ").trim();
    const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8").split(" ");
    return { pid, ppid: Number(stat[3]), cmd };
  } catch {
    try {
      const cmd = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
      return { pid, ppid: null, cmd };
    } catch { return null; }
  }
}

function looksLikeServer(cmd) {
  return /custom-server\.js|next-server|9router|next start/i.test(String(cmd || ""));
}

// Stop the process listening on the app port. When the listener is the Next
// child of the CLI launcher, the launcher is stopped too — otherwise it
// respawns the child we just killed.
function stopServer(port, log = () => {}) {
  const pids = listListeners(port);
  if (!pids.length) {
    log("no listener on " + port + " — nothing to stop");
    return [];
  }
  const stopped = [];
  for (const pid of pids) {
    const info = processInfo(pid);
    log("listener " + pid + (info ? " · " + info.cmd.slice(0, 120) : ""));
    const parent = info && info.ppid ? processInfo(info.ppid) : null;
    const killParent = parent && (/cli\.js|9router/i.test(parent.cmd) && !/custom-server\.js/i.test(parent.cmd));
    try { process.kill(pid); stopped.push(pid); log("sent termination to " + pid); } catch (e) { log("kill " + pid + " failed: " + e.message); }
    if (killParent) {
      try { process.kill(parent.pid); stopped.push(parent.pid); log("sent termination to launcher " + parent.pid); } catch (e) { log("kill launcher failed: " + e.message); }
    }
  }
  return stopped;
}

function waitForPortFree(port, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (!listListeners(port).length) return resolve(true);
      if (Date.now() > until) return resolve(false);
      setTimeout(tick, 400);
    };
    tick();
  });
}

function startServer(install, port, log = () => {}) {
  const env = { ...process.env, PORT: String(port), HOSTNAME: process.env.HOSTNAME || "0.0.0.0" };
  const detached = { cwd: install.appDir, env, detached: true, stdio: "ignore", windowsHide: true };
  const logDir = path.join(install.appDir, PLUGIN_DIR_NAME, "logs");
  try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
  const out = fs.openSync(path.join(logDir, "server.log"), "a");
  const opts = { ...detached, stdio: ["ignore", out, out] };
  let child;
  if (install.launcherPath) {
    const args = [install.launcherPath];
    if (!process.argv.includes("--no-tray")) args.push("--tray");
    child = spawn(process.execPath, args, opts);
    log("started launcher: node " + install.launcherPath + " " + args.slice(1).join(" "));
  } else {
    child = spawn(process.execPath, [path.join(install.appDir, "custom-server.js")], opts);
    log("started server: node custom-server.js (cwd " + install.appDir + ")");
  }
  child.unref();
  return child.pid;
}

async function waitForApp(port, timeoutMs = 90000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const res = await httpGet("http://127.0.0.1:" + port + "/api/health", 1500);
    if (res && res.status && res.status < 500) return true;
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}

function pluginPayloadDir() {
  return path.join(__dirname, "..", "plugin");
}

function buildDirs(appDir) {
  return [".next-cli-build", ".next"].map((d) => path.join(appDir, d)).filter((d) => fs.existsSync(d));
}

// Compiled sidebar arrays: one in the server (ssr) chunks, one in the client
// chunks. Both carry the same literal object, so one anchor patches both.
function sidebarFiles(appDir) {
  const hits = [];
  const roots = buildDirs(appDir).map((d) => path.join(d, "server")).concat(buildDirs(appDir).map((d) => path.join(d, "static")));
  for (const root of roots) {
    for (const file of walk(root)) {
      if (!file.endsWith(".js")) continue;
      try {
        const text = fs.readFileSync(file, "utf8");
        if (text.includes(SIDEBAR_ANCHOR)) hits.push(file);
      } catch {}
    }
  }
  return hits;
}

function walk(dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function purgeRouteCache(appDir) {
  const removed = [];
  for (const buildDir of buildDirs(appDir)) {
    const cache = path.join(buildDir, "server", "route-cache");
    if (!fs.existsSync(cache)) continue;
    fs.rmSync(cache, { recursive: true, force: true });
    removed.push(cache);
  }
  return removed;
}

function patchText(file, from, to, log = () => {}) {
  const text = fs.readFileSync(file, "utf8");
  if (!text.includes(from)) return false;
  fs.writeFileSync(file, text.replace(from, to), "utf8");
  log("patched " + file);
  return true;
}

function hookSnippet() {
  return [
    "",
    HOOK_BEGIN,
    "// Installed by oc-rotation-plugin. Remove with scripts/uninstall.cjs.",
    'try { require("./' + PLUGIN_DIR_NAME + '/hook.cjs").install(http); } catch (e) { console.error("[oc-rotation] hook load failed:", e && e.message ? e.message : e); }',
    HOOK_END,
    "",
  ].join("\n");
}

// Appended at the end of custom-server.js on purpose: it must wrap the
// createServer that custom-server already replaced, so our route interception
// sits in front of Next without touching its wrapper.
function patchCustomServer(appDir, log = () => {}) {
  const file = path.join(appDir, "custom-server.js");
  const text = fs.readFileSync(file, "utf8");
  if (text.includes(HOOK_BEGIN)) return { patched: false, reason: "already patched" };
  fs.writeFileSync(file, text.replace(/\s*$/, "\n") + hookSnippet(), "utf8");
  log("patched " + file);
  return { patched: true };
}

function unpatchCustomServer(appDir, log = () => {}) {
  const file = path.join(appDir, "custom-server.js");
  const text = fs.readFileSync(file, "utf8");
  const start = text.indexOf(HOOK_BEGIN);
  if (start === -1) return false;
  const end = text.indexOf(HOOK_END);
  const next = text.slice(0, start).replace(/\s*$/, "\n") + (end === -1 ? "" : text.slice(end + HOOK_END.length).replace(/^\s*/, "\n"));
  fs.writeFileSync(file, next, "utf8");
  log("unpatched " + file);
  return true;
}

function patchSidebar(appDir, log = () => {}) {
  const patched = [];
  for (const file of sidebarFiles(appDir)) {
    if (fs.readFileSync(file, "utf8").includes(SIDEBAR_ENTRY)) continue;
    if (patchText(file, SIDEBAR_ANCHOR, SIDEBAR_ANCHOR + "," + SIDEBAR_ENTRY, log)) patched.push(file);
  }
  return patched;
}

function unpatchSidebar(appDir, log = () => {}) {
  const restored = [];
  for (const file of sidebarFiles(appDir)) {
    if (patchText(file, SIDEBAR_ANCHOR + "," + SIDEBAR_ENTRY, SIDEBAR_ANCHOR, log)) restored.push(file);
  }
  return restored;
}

function makeLogger(logFile) {
  try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); } catch {}
  return (msg) => {
    const line = "[" + new Date().toISOString() + "] " + msg;
    try { fs.appendFileSync(logFile, line + "\n"); } catch {}
    console.log(line);
  };
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

function backupFile(file, backupRoot) {
  if (!fs.existsSync(file)) return null;
  const rel = file.replace(/[:\\/]/g, "_");
  const dst = path.join(backupRoot, rel);
  fs.mkdirSync(backupRoot, { recursive: true });
  fs.copyFileSync(file, dst);
  return dst;
}

module.exports = {
  SUPPORTED_APP,
  PLUGIN_DIR_NAME,
  DEFAULT_APP_PORT,
  CANDIDATE_PORTS,
  findInstalls,
  findDataDir,
  detectPort,
  httpGet,
  listListeners,
  processInfo,
  stopServer,
  waitForPortFree,
  startServer,
  waitForApp,
  pluginPayloadDir,
  buildDirs,
  sidebarFiles,
  purgeRouteCache,
  patchCustomServer,
  unpatchCustomServer,
  patchSidebar,
  unpatchSidebar,
  makeLogger,
  copyDir,
  backupFile,
  readJson,
  hasHookPatch,
};
