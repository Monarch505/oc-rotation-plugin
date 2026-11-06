"use strict";

const fs = require("fs");
const path = require("path");
const net = require("net");
const tls = require("tls");
const http = require("http");
const os = require("os");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

// config.json is written by scripts/apply.cjs and pins this copy to one host
// install (data dir, app port, opencode free-lane endpoints).
const CONFIG_PATH = path.join(__dirname, "config.json");
const CONFIG = (() => {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch { return {}; }
})();

function defaultDataDir() {
  const pick = [
    process.env.DATA_DIR,
    process.env.APPDATA ? path.join(process.env.APPDATA, "9router") : null,
    path.join(os.homedir(), ".9router"),
    path.join(os.homedir(), ".config", "9router"),
  ].filter(Boolean);
  for (const d of pick) {
    try { if (fs.existsSync(path.join(d, "db", "data.sqlite"))) return d; } catch {}
  }
  return pick[0] || path.join(os.homedir(), ".9router");
}

const DATA_DIR = CONFIG.dataDir || defaultDataDir();
const DB_PATH = path.join(DATA_DIR, "db", "data.sqlite");
const LOG_DIR = path.join(__dirname, "logs");
const LOG_PATH = path.join(LOG_DIR, "engine.log");
const PROBE_HOST = CONFIG.probeHost || "opencode.ai";
const PROBE_MODELS_PATH = CONFIG.probeModelsPath || "/zen/v1/models";
const PROBE_CHAT_PATH = CONFIG.probeChatPath || "/inference/openai/v1/chat/completions";
const OPENCODE_UA = "opencode/1.19.4 ai-sdk/provider-utils/4.0.23 runtime/bun/1.4.4";
const KV_SCOPE = "ocRotation";
const KV_KEY = "state";
const MUX_POOL_ID = "oc-rotation-mux";
const DEFAULT_PORT = Number(CONFIG.muxPort) || 20129;
const DEFAULT_API_PORT = Number(CONFIG.apiPort) || 20130;
const PROBE_TIMEOUT = 15000;
const TUNNEL_TIMEOUT = 10000;
const DEFAULT_SWEEP_CONCURRENCY = 4;
const FAIL_STREAK_LIMIT = 2;
const USAGE_LIMIT = 400;
const EVENT_LIMIT = 300;
const ROTATION_LIMIT = 50;
const DEFAULT_SETTINGS = {
  cooldownMin: 5,
  cascade: { maxElim: 3, windowMin: 10, pauseMin: 30 },
  // "endpoint" = GET the models endpoint through the pool (cheap, no quota);
  // "chat" = one tiny chat completion (what actually burns the free window).
  probeMode: "endpoint",
  probeModel: "big-pickle",
  probeTimeoutMs: PROBE_TIMEOUT,
  sweepConcurrency: DEFAULT_SWEEP_CONCURRENCY,
  tunnelTimeoutMs: TUNNEL_TIMEOUT,
};

function createEngine() {
  let _db = null;
  function db() {
    if (!_db) {
      _db = new DatabaseSync(DB_PATH);
      try { _db.exec("PRAGMA busy_timeout=4000"); } catch {}
    }
    return _db;
  }

  function logLine(msg) {
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      const line = new Date().toISOString() + " " + msg + "\n";
      try {
        const st = fs.statSync(LOG_PATH);
        if (st.size > 1024 * 1024) fs.renameSync(LOG_PATH, LOG_PATH + ".1");
      } catch {}
      fs.appendFileSync(LOG_PATH, line);
    } catch {}
  }

  function kvGet() {
    try {
      const row = db().prepare("SELECT value FROM kv WHERE scope=? AND key=?").get(KV_SCOPE, KV_KEY);
      return row ? JSON.parse(row.value) : null;
    } catch { return null; }
  }
  function kvSet(v) {
    try {
      db().prepare("INSERT INTO kv(scope,key,value) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value")
        .run(KV_SCOPE, KV_KEY, JSON.stringify(v));
    } catch (e) { console.error("[oc-rotation] kv write failed:", e.message); }
  }

  function defaultState() {
    return {
      auto: { enabled: false, intervalMin: 30 },
      elim: { enabled: false },
      port: DEFAULT_PORT,
      muxPoolId: MUX_POOL_ID,
      prevProxyPoolIds: null,
      prevCaptured: false,
      lastSweepAt: null,
      lastSweepSummary: null,
      eliminations: [],
      elimPausedUntil: 0,
      settings: { ...DEFAULT_SETTINGS, cascade: { ...DEFAULT_SETTINGS.cascade } },
      current: { poolId: null, since: 0 },
      cooldown: {},
      rotations: [],
    };
  }
  function state() {
    const s = kvGet();
    const d = defaultState();
    if (!s) return d;
    return {
      ...d,
      ...s,
      auto: { ...d.auto, ...(s.auto || {}) },
      elim: { ...d.elim, ...(s.elim || {}) },
      settings: {
        ...d.settings,
        ...(s.settings || {}),
        cascade: { ...d.settings.cascade, ...((s.settings && s.settings.cascade) || {}) },
      },
      current: { ...d.current, ...(s.current || {}) },
      cooldown: { ...(s.cooldown || {}) },
      rotations: Array.isArray(s.rotations) ? s.rotations : [],
    };
  }
  function saveState(s) { kvSet(s); }

  function pruneCooldown(map, now) {
    const out = {};
    for (const [id, until] of Object.entries(map || {})) {
      const n = Number(until);
      if (Number.isFinite(n) && n > now) out[id] = n;
    }
    return out;
  }

  function listPools() {
    const rows = db().prepare("SELECT id,isActive,testStatus,data,createdAt,updatedAt FROM proxyPools").all();
    return rows.map((r) => {
      let data = {};
      try { data = JSON.parse(r.data || "{}"); } catch {}
      return { id: r.id, isActive: !!r.isActive, testStatus: r.testStatus || "", data, createdAt: r.createdAt, updatedAt: r.updatedAt };
    });
  }
  function getPool(id) { return listPools().find((p) => p.id === id) || null; }
  function updatePool(id, fn) {
    const p = getPool(id);
    if (!p) return null;
    const patch = fn({ ...p, data: { ...p.data } }) || {};
    const nextData = patch.data ? { ...p.data, ...patch.data } : p.data;
    const isActive = patch.isActive === undefined ? (p.isActive ? 1 : 0) : (patch.isActive ? 1 : 0);
    const testStatus = patch.testStatus === undefined ? p.testStatus : patch.testStatus;
    const now = new Date().toISOString();
    db().prepare("UPDATE proxyPools SET isActive=?, testStatus=?, data=?, updatedAt=? WHERE id=?")
      .run(isActive, testStatus, JSON.stringify(nextData), now, id);
    return { ...p, data: nextData, isActive: !!isActive, testStatus };
  }

  function parseProxyUrl(raw) {
    const u = new URL(String(raw));
    if (u.protocol !== "http:") throw new Error("unsupported proxy protocol " + u.protocol);
    const auth = u.username
      ? "Basic " + Buffer.from(decodeURIComponent(u.username) + ":" + decodeURIComponent(u.password || "")).toString("base64")
      : null;
    return { host: u.hostname, port: Number(u.port || 80), auth };
  }

  function connectViaProxy(proxyUrl, host, port, timeoutMs) {
    return new Promise((resolve, reject) => {
      let p;
      try { p = parseProxyUrl(proxyUrl); } catch (e) { return reject(e); }
      const sock = net.connect(p.port, p.host);
      let acc = Buffer.alloc(0);
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; sock.destroy(); reject(new Error("proxy connect timeout")); } }, timeoutMs);
      const fail = (e) => { if (done) return; done = true; clearTimeout(timer); sock.destroy(); reject(e); };
      sock.on("error", fail);
      sock.on("connect", () => {
        const lines = ["CONNECT " + host + ":" + port + " HTTP/1.1", "Host: " + host + ":" + port];
        if (p.auth) lines.push("Proxy-Authorization: " + p.auth);
        lines.push("", "");
        sock.write(lines.join("\r\n"));
      });
      sock.on("data", (chunk) => {
        acc = Buffer.concat([acc, chunk]);
        const idx = acc.indexOf("\r\n\r\n");
        if (idx === -1) return;
        const head = acc.subarray(0, idx).toString("latin1");
        const rest = acc.subarray(idx + 4);
        const status = Number((head.split(" ")[1] || "0"));
        if (status !== 200) return fail(new Error("proxy CONNECT " + status));
        done = true;
        clearTimeout(timer);
        sock.removeListener("data", onData);
        if (rest.length) sock.unshift(rest);
        resolve(sock);
      });
      const onData = () => {};
      sock.on("close", () => { if (!done) fail(new Error("proxy closed")); });
    });
  }

  // Probe = one real request through this pool's tunnel, on the opencode free
  // lane, with the identity headers the CLI sends. The dashboard model-test
  // route is not an option here: this plugin installs without touching the Next
  // build, so nothing in the app knows about a pinned pool.
  const FREE_LIMIT_RE = /FreeUsageLimitError|Free usage limit|FreeTierError|free tier limit|quota/i;
  const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

  // Shape the free gate decodes: ses_<12 hex of a descending timestamp><14 random>.
  function probeSessionId(now = Date.now()) {
    const hex = (~(BigInt(now) * 0x1000n) & ((1n << 48n) - 1n)).toString(16).padStart(12, "0");
    const bytes = crypto.randomBytes(14);
    let tail = "";
    for (let i = 0; i < 14; i++) tail += BASE62[bytes[i] % 62];
    return "ses_" + hex + tail;
  }

  // CONNECT through the pool, TLS to the target, one HTTP/1.1 exchange.
  function httpsViaProxy(proxyUrl, { method, targetPath, headers, body, timeoutMs }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, v) => { if (settled) return; settled = true; fn(v); };
      connectViaProxy(proxyUrl, PROBE_HOST, 443, timeoutMs).then((sock) => {
        const timer = setTimeout(() => { sock.destroy(); finish(reject, new Error("probe timeout")); }, timeoutMs);
        const t = tls.connect({ socket: sock, servername: PROBE_HOST }, () => {
          const payload = body ? Buffer.from(body) : Buffer.alloc(0);
          const head = [
            method + " " + targetPath + " HTTP/1.1",
            "Host: " + PROBE_HOST,
            ...Object.entries(headers).map(([k, v]) => k + ": " + v),
            payload.length ? "Content-Length: " + payload.length : null,
            "Connection: close",
            "", "",
          ].filter((x) => x !== null).join("\r\n");
          t.write(head);
          if (payload.length) t.write(payload);
        });
        let acc = Buffer.alloc(0);
        t.on("data", (c) => { acc = Buffer.concat([acc, c]); });
        t.on("error", (e) => { clearTimeout(timer); finish(reject, e); });
        t.on("close", () => { clearTimeout(timer); finish(resolve, acc.toString("utf8")); });
      }).catch((e) => finish(reject, e));
    });
  }

  function probeIdentity() {
    return {
      Authorization: "Bearer public",
      "User-Agent": OPENCODE_UA,
      "x-opencode-client": "cli",
      "x-opencode-project": "global",
      "x-opencode-session": probeSessionId(),
      "x-opencode-session-id": probeSessionId(),
      "x-opencode-request": "msg_" + crypto.randomBytes(10).toString("hex"),
    };
  }

  async function probePool(pool, timeoutMs) {
    const t0 = Date.now();
    if (!pool || !pool.id) return { ok: false, status: 0, limited: false, ms: 0, error: "no pool id" };
    const d = pool.data || {};
    const proxyUrl = String(d.realProxyUrl || d.proxyUrl || "");
    if (!proxyUrl) return { ok: false, status: 0, limited: false, ms: 0, error: "no proxyUrl" };
    const s = state();
    const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : (Number(s.settings.probeTimeoutMs) || PROBE_TIMEOUT);
    const mode = s.settings.probeMode === "chat" ? "chat" : "endpoint";
    const headers = probeIdentity();
    let method = "GET";
    let targetPath = PROBE_MODELS_PATH;
    let body = null;
    if (mode === "chat") {
      method = "POST";
      targetPath = PROBE_CHAT_PATH;
      headers["Content-Type"] = "application/json";
      headers.Accept = "text/event-stream";
      body = JSON.stringify({
        model: String(s.settings.probeModel || DEFAULT_SETTINGS.probeModel).replace(/^oc\//, ""),
        stream: false,
        max_tokens: 8,
        messages: [{ role: "user", content: "ping" }],
      });
    } else {
      headers.Accept = "application/json";
    }
    try {
      const text = await httpsViaProxy(proxyUrl, { method, targetPath, headers, body, timeoutMs: limit });
      const ms = Date.now() - t0;
      const status = Number((text.match(/^HTTP\/1\.[01] (\d{3})/) || [])[1] || 0);
      if (status >= 200 && status < 300) return { ok: true, status, limited: false, ms, error: null };
      const limited = status === 429 || FREE_LIMIT_RE.test(text);
      const sep = text.indexOf("\r\n\r\n");
      const snippet = sep >= 0 ? text.slice(sep + 4, sep + 204).trim() : "";
      return {
        ok: false,
        status,
        limited,
        ms,
        error: limited ? "HTTP " + status + " (free limit)" : ("HTTP " + status + " " + snippet).slice(0, 200),
      };
    } catch (e) {
      return { ok: false, status: 0, limited: false, ms: Date.now() - t0, error: e.message || String(e) };
    }
  }

  function applyProbeResult(poolId, r, opts = {}) {
    const now = new Date().toISOString();
    return updatePool(poolId, (p) => {
      const d = p.data || {};
      const streak = r.ok ? 0 : (r.limited ? (d.ocFailStreak || 0) : (d.ocFailStreak || 0) + 1);
      const patch = {
        data: {
          ocFailStreak: streak,
          ocLastStatus: r.status,
          ocLastError: r.error || null,
          ocLastCheckAt: now,
          ocLastMs: r.ms,
        },
        testStatus: r.ok ? "oc-active" : (r.limited ? "oc-limited" : "oc-error"),
      };
      if (r.ok) patch.isActive = true;
      else if (!r.limited && streak >= FAIL_STREAK_LIMIT && !opts.global429) patch.isActive = false;
      return patch;
    });
  }

  function sweepCandidates() {
    return listPools().filter((p) => {
      const d = p.data || {};
      if (d.ocManaged) return false;
      if (d.ocExclude) return false;
      if (String(d.type || "http").toLowerCase() !== "http") return false;
      const url = String(d.realProxyUrl || d.proxyUrl || "");
      if (!/^https?:\/\//i.test(url)) return false;
      if (/^https?:\/\/(127\.0\.0\.1|localhost)/i.test(url)) return false;
      return true;
    });
  }
  function muxCandidates() {
    return sweepCandidates().filter((p) => p.isActive && p.testStatus === "oc-active");
  }

  const usage = [];
  const events = [];
  function pushUsage(e) { usage.push(e); if (usage.length > USAGE_LIMIT) usage.splice(0, usage.length - USAGE_LIMIT); }
  function pushEvent(level, msg) { events.push({ t: Date.now(), level, msg }); if (events.length > EVENT_LIMIT) events.splice(0, events.length - EVENT_LIMIT); }

  // ---- current pool (single active tunnel) --------------------------------
  let rrCursor = 0;

  function rotateCurrent(reason) {
    const s = state();
    const now = Date.now();
    const from = s.current && s.current.poolId ? s.current.poolId : null;
    const cooldown = pruneCooldown(s.cooldown, now);
    const cands = muxCandidates().filter((p) => !(cooldown[p.id] > now));
    let to = null;
    if (cands.length) {
      const p = cands[rrCursor % cands.length];
      rrCursor = (rrCursor + 1) % 1000000;
      to = p.id;
    }
    s.cooldown = cooldown;
    s.current = { poolId: to, since: now };
    if (to !== from) {
      s.rotations = [...(s.rotations || []), { t: now, from, to, reason: String(reason || "rotate") }].slice(-ROTATION_LIMIT);
      if (to) {
        pushEvent("info", "current pool " + (from || "-") + " -> " + to + " (" + reason + ")");
      } else {
        pushEvent("warn", "no oc-active pool left - fail-closed (" + reason + ")");
      }
      pushUsage({ t: now, event: "rotate", from, to, reason: String(reason || "rotate") });
    }
    saveState(s);
    return to;
  }

  function currentPool() {
    const s = state();
    const id = s.current && s.current.poolId;
    if (id) {
      const p = getPool(id);
      const cooled = (pruneCooldown(s.cooldown, Date.now())[id] || 0) > 0;
      if (p && p.isActive && p.testStatus === "oc-active" && !cooled) return p;
      return rotateCurrent(s.current ? "current invalid" : "no current") ? currentPoolById() : null;
    }
    return rotateCurrent("no current") ? currentPoolById() : null;
  }

  function currentPoolById() {
    const s = state();
    const p = s.current && s.current.poolId ? getPool(s.current.poolId) : null;
    return p || null;
  }

  function cooldownPool(poolId, now) {
    const s = state();
    const cd = pruneCooldown(s.cooldown, now);
    cd[poolId] = now + (Number(s.settings.cooldownMin) || DEFAULT_SETTINGS.cooldownMin) * 60 * 1000;
    s.cooldown = cd;
    saveState(s);
  }

  // Pool that was `current` at time t, derived from the rotation log. Retries
  // and late responses keep attribution stable: a second 429 for the same t0
  // resolves to an already-eliminated pool and no-ops.
  function poolAtTime(s, t) {
    const rots = (s.rotations || []).filter((r) => Number(r.t) <= t);
    if (rots.length) return rots[rots.length - 1].to || null;
    if (s.current && Number(s.current.since) <= t) return s.current.poolId || null;
    return null;
  }

  let muxServer = null;
  let lastFailClosedNote = 0;
  const tunnels = [];
  let tunnelSeq = 0;

  function startMux() {
    if (muxServer) return;
    const port = state().port || DEFAULT_PORT;
    muxServer = http.createServer((req, res) => {
      res.writeHead(501, { "content-type": "text/plain" });
      res.end("oc-rotation mux: CONNECT only");
    });
    muxServer.on("connect", (req, clientSock, head) => {
      const target = String(req.url || "");
      const i = target.lastIndexOf(":");
      const host = i > 0 ? target.slice(0, i) : target;
      const port2 = i > 0 ? Number(target.slice(i + 1)) : 443;
      clientSock.on("error", () => {});
      const pool = currentPool();
      if (!pool) {
        // Fail-closed: no direct fallback. Leaking the local IP is worse than
        // a visible 502 for opencode-free traffic.
        pushUsage({ t: Date.now(), event: "fail-closed", host });
        const now = Date.now();
        if (now - lastFailClosedNote > 60000) {
          lastFailClosedNote = now;
          pushEvent("warn", "no oc-active pool - CONNECT refused (fail-closed, no local egress)");
        }
        try { clientSock.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"); } catch {}
        return;
      }
      const t0 = Date.now();
      const proxyUrl = pool.data.realProxyUrl || pool.data.proxyUrl;
      const timeoutMs = Number(state().settings.tunnelTimeoutMs) || TUNNEL_TIMEOUT;
      connectViaProxy(proxyUrl, host, port2, timeoutMs).then((up) => {
        const rec = { id: ++tunnelSeq, poolId: pool.id, host, openedAt: t0, closedAt: null };
        tunnels.push(rec);
        if (tunnels.length > 200) tunnels.splice(0, tunnels.length - 200);
        pushUsage({ t: t0, event: "tunnel", poolId: pool.id, host, ms: Date.now() - t0 });
        try { clientSock.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: 9router-oc-mux\r\n\r\n"); } catch {}
        if (head && head.length) { try { up.write(head); } catch {} }
        up.pipe(clientSock);
        clientSock.pipe(up);
        const close = () => {
          if (rec.closedAt) return;
          rec.closedAt = Date.now();
          pushUsage({ t: rec.closedAt, event: "close", poolId: pool.id, host, ms: rec.closedAt - t0 });
        };
        up.on("close", close);
        clientSock.on("close", close);
        up.on("error", close);
        clientSock.on("error", close);
      }).catch((e) => {
        const now = Date.now();
        pushUsage({ t: now, event: "fail", poolId: pool.id, host, error: e.message });
        pushEvent("err", "mux tunnel fail " + pool.id + " -> " + host + ": " + e.message);
        try { clientSock.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"); } catch {}
        updatePool(pool.id, (p) => {
          const d = p.data || {};
          return {
            data: { ocFailStreak: (d.ocFailStreak || 0) + 1, ocLastError: "mux: " + e.message, ocLastCheckAt: new Date().toISOString() },
          };
        });
        cooldownPool(pool.id, now);
        rotateCurrent("tunnel fail");
      });
    });
    muxServer.on("error", (e) => {
      pushEvent("err", "mux listen error: " + e.message);
      console.error("[oc-rotation] mux error:", e.message);
    });
    muxServer.listen(port, "127.0.0.1", () => pushEvent("info", "mux listening on 127.0.0.1:" + port));
  }

  function eliminate(poolId, reason) {
    const p = getPool(poolId);
    if (!p) return false;
    if (p.testStatus === "oc-eliminated" && !p.isActive) return false;
    updatePool(poolId, () => ({
      isActive: false,
      testStatus: "oc-eliminated",
      data: { ocLastError: "429 upstream (" + reason + ")", ocLastCheckAt: new Date().toISOString() },
    }));
    const s = state();
    const now = Date.now();
    s.eliminations = [...(s.eliminations || []), { t: now, poolId }].slice(-50);
    saveState(s);
    pushEvent("err", "ELIMINATED " + poolId + " (429, " + reason + ")");
    pushUsage({ t: now, event: "elim", poolId });
    return true;
  }

  // Explicit 429 attribution. The executor reports {t0, proxyPoolId, status}
  // over loopback; the pool that was current at t0 owns the 429, regardless of
  // which tunnel socket is still open. Probe traffic is excluded twice: the
  // executor skips it by header, and a probe's proxyPoolId is never the mux.
  function note429(payload = {}) {
    try {
      if (Number(payload.status) !== 429) return { ok: false, skipped: "status" };
      const s = state();
      if (!s.elim.enabled) return { ok: false, skipped: "elim disabled" };
      const muxId = s.muxPoolId || MUX_POOL_ID;
      const proxyPoolId = payload.proxyPoolId ? String(payload.proxyPoolId) : null;
      if (proxyPoolId && proxyPoolId !== muxId) return { ok: false, skipped: "not mux lane" };
      const t0 = Number(payload.t0) || Date.now();
      const poolAt = poolAtTime(s, t0);
      if (!poolAt) return { ok: false, skipped: "no pool at t0" };
      const p = getPool(poolAt);
      if (!p || !p.isActive || p.testStatus === "oc-eliminated") return { ok: false, skipped: "stale" };

      const now = Date.now();
      const cascade = s.settings.cascade || DEFAULT_SETTINGS.cascade;
      const paused = Number(s.elimPausedUntil) > now;
      const recent = (s.eliminations || []).filter((e) => now - Number(e.t) < (Number(cascade.windowMin) || 10) * 60000);
      if (paused || recent.length >= (Number(cascade.maxElim) || 3)) {
        if (!paused) {
          s.elimPausedUntil = now + (Number(cascade.pauseMin) || 30) * 60000;
          saveState(s);
          pushEvent("warn", "cascading 429 detected - elimination paused " + (cascade.pauseMin || 30) + "m");
        }
        cooldownPool(poolAt, now);
        rotateCurrent("cascade-pause");
        pushEvent("warn", "429 from " + poolAt + " -> cooldown, no elimination (paused)");
        return { ok: true, action: "cooldown", poolId: poolAt };
      }

      eliminate(poolAt, "v1 429");
      rotateCurrent("429");
      return { ok: true, action: "eliminate", poolId: poolAt };
    } catch (e) {
      console.error("[oc-rotation] note429:", e.message);
      return { ok: false, error: e.message };
    }
  }

  let appPort = Number(CONFIG.appPort) || 0;
  function noteRequest(req) {
    if (!appPort && req.socket && req.socket.localPort) appPort = req.socket.localPort;
  }

  function appRequest(method, p, body, headers = {}, timeoutMs = 0) {
    return new Promise((resolve, reject) => {
      const port = appPort || 20127;
      const data = body ? JSON.stringify(body) : null;
      const r = http.request({
        host: "127.0.0.1",
        port,
        path: p,
        method,
        headers: {
          ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}),
          ...headers,
        },
      }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try { json = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, json, text });
        });
      });
      r.on("error", reject);
      if (timeoutMs > 0) r.setTimeout(timeoutMs, () => r.destroy(new Error("app request timeout")));
      if (data) r.write(data);
      r.end();
    });
  }

  function ensureMuxPool() {
    const s = state();
    const port = s.port || DEFAULT_PORT;
    const existing = getPool(s.muxPoolId);
    const data = {
      name: "OC Rotation (auto)",
      proxyUrl: "http://127.0.0.1:" + port,
      noProxy: "",
      type: "http",
      // Without strictProxy the mux connection failure silently falls back to
      // the local IP — the second leak path, after the mux's own direct branch.
      strictProxy: true,
      ocManaged: true,
      lastTestedAt: null,
      lastError: null,
    };
    const now = new Date().toISOString();
    if (!existing) {
      db().prepare("INSERT OR REPLACE INTO proxyPools(id,isActive,testStatus,data,createdAt,updatedAt) VALUES(?,?,?,?,?,?)")
        .run(s.muxPoolId, 1, "active", JSON.stringify(data), now, now);
    } else {
      const merged = { ...existing.data, ...data };
      db().prepare("UPDATE proxyPools SET isActive=1, testStatus=?, data=?, updatedAt=? WHERE id=?")
        .run("active", JSON.stringify(merged), now, s.muxPoolId);
    }
  }

  function seedExcludes() {
    const legacy = ["ClaudeFlare-2", "CloudFlare-1", "LocalProxyPool"];
    for (const p of listPools()) {
      const d = p.data || {};
      if (d.ocManaged) continue;
      const isLegacy = legacy.includes(d.name) || legacy.includes(p.id);
      const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)/i.test(String(d.proxyUrl || ""));
      if ((isLegacy || isLocal) && d.ocExclude === undefined) {
        updatePool(p.id, () => ({ data: { ocExclude: true } }));
      }
    }
  }

  async function setElim(enabled) {
    const s = state();
    if (enabled) {
      ensureMuxPool();
      if (!s.prevCaptured) {
        const r = await appRequest("GET", "/api/settings");
        const settings = (r.json && (r.json.settings || r.json)) || {};
        const ps = settings.providerStrategies || {};
        const oc = ps.opencode || {};
        s.prevProxyPoolIds = Array.isArray(oc.proxyPoolIds) ? oc.proxyPoolIds : null;
        s.prevCaptured = true;
        const nextPs = { ...ps, opencode: { ...oc, proxyPoolIds: [s.muxPoolId] } };
        await appRequest("PATCH", "/api/settings", { providerStrategies: nextPs });
        pushEvent("info", "opencode rotation wired to " + s.muxPoolId);
      }
      s.elim.enabled = true;
    } else {
      s.elim.enabled = false;
      if (s.prevCaptured) {
        const r = await appRequest("GET", "/api/settings");
        const settings = (r.json && (r.json.settings || r.json)) || {};
        const ps = settings.providerStrategies || {};
        const oc = ps.opencode || {};
        const nextPs = { ...ps, opencode: { ...oc, proxyPoolIds: s.prevProxyPoolIds || [] } };
        await appRequest("PATCH", "/api/settings", { providerStrategies: nextPs });
        s.prevCaptured = false;
        pushEvent("info", "opencode rotation restored");
      }
    }
    saveState(s);
    return s;
  }

  let job = null;
  async function runSweep(ids) {
    if (job && job.running) return job;
    const settings = state().settings;
    const all = sweepCandidates();
    const targets = ids && ids.length ? all.filter((p) => ids.includes(p.id)) : all;
    job = { id: crypto.randomBytes(6).toString("hex"), running: true, startedAt: Date.now(), total: targets.length, done: 0, current: null, active: [], results: [], global429: false, finishedAt: null };
    let consec429 = 0;
    let cursor = 0;
    const worker = async () => {
      while (cursor < targets.length) {
        const p = targets[cursor++];
        job.active.push(p.id);
        pushEvent("info", "op-check started " + p.id);
        let r;
        try { r = await probePool(p); } catch (e) { r = { ok: false, status: 0, limited: false, ms: 0, error: e.message || String(e) }; }
        job.active = job.active.filter((id) => id !== p.id);
        if (r.limited) consec429++; else consec429 = 0;
        if (consec429 >= 3) job.global429 = true;
        const updated = applyProbeResult(p.id, r, { global429: job.global429 });
        job.results.push({ id: p.id, ok: r.ok, status: r.status, limited: r.limited, ms: r.ms, error: r.error, testStatus: updated ? updated.testStatus : null });
        job.done++;
        pushEvent(r.ok ? "ok" : (r.limited ? "warn" : "err"), "op-check " + p.id + " -> " + (r.ok ? "200" : (r.status || r.error)) + " (" + r.ms + "ms)");
      }
    };
    const conc = Math.max(1, Math.min(32, Number(settings.sweepConcurrency) || DEFAULT_SWEEP_CONCURRENCY));
    await Promise.all(Array.from({ length: Math.min(conc, targets.length || 1) }, worker));
    job.running = false;
    job.finishedAt = Date.now();
    job.current = null;
    job.active = [];
    const s = state();
    s.lastSweepAt = new Date().toISOString();
    s.lastSweepSummary = {
      total: job.total,
      ok: job.results.filter((x) => x.ok).length,
      limited: job.results.filter((x) => x.limited).length,
      failed: job.results.filter((x) => !x.ok && !x.limited).length,
      global429: job.global429,
    };
    saveState(s);
    // A sweep may have revived or eliminated the current pool; validate it.
    currentPool();
    return job;
  }

  let autoTimer = null;
  function scheduleAuto() {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    const s = state();
    if (!s.auto.enabled) return;
    const ms = Math.max(1, Number(s.auto.intervalMin) || 30) * 60 * 1000;
    autoTimer = setInterval(() => { runSweep().catch((e) => pushEvent("err", "auto sweep: " + e.message)); }, ms);
    if (autoTimer.unref) autoTimer.unref();
  }

  function clampNum(v, min, max, dflt) {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, Math.round(n)));
  }
  function clampSettings(cur, patch) {
    const p = patch && typeof patch === "object" ? patch : {};
    const c = { ...cur, cascade: { ...(cur.cascade || {}) } };
    if (p.cooldownMin !== undefined) c.cooldownMin = clampNum(p.cooldownMin, 1, 120, c.cooldownMin);
    const cs = p.cascade && typeof p.cascade === "object" ? p.cascade : p;
    if (cs.maxElim !== undefined) c.cascade.maxElim = clampNum(cs.maxElim, 1, 20, c.cascade.maxElim);
    if (cs.windowMin !== undefined) c.cascade.windowMin = clampNum(cs.windowMin, 1, 1440, c.cascade.windowMin);
    if (cs.pauseMin !== undefined) c.cascade.pauseMin = clampNum(cs.pauseMin, 1, 1440, c.cascade.pauseMin);
    if (p.probeModel !== undefined) {
      const m = String(p.probeModel || "").trim();
      if (m) c.probeModel = m.slice(0, 120);
    }
    if (p.probeMode !== undefined) c.probeMode = p.probeMode === "chat" ? "chat" : "endpoint";
    if (p.probeTimeoutMs !== undefined) c.probeTimeoutMs = clampNum(p.probeTimeoutMs, 1000, 120000, c.probeTimeoutMs);
    if (p.sweepConcurrency !== undefined) c.sweepConcurrency = clampNum(p.sweepConcurrency, 1, 32, c.sweepConcurrency);
    if (p.tunnelTimeoutMs !== undefined) c.tunnelTimeoutMs = clampNum(p.tunnelTimeoutMs, 1000, 120000, c.tunnelTimeoutMs);
    return c;
  }

  let apiServer = null;
  function readJson(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { resolve({}); }
      });
      req.on("error", () => resolve({}));
    });
  }
  function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
    res.end(body);
  }
  function startApi() {
    if (apiServer) return;
    const port = Number(process.env.OC_ROTATION_API_PORT || DEFAULT_API_PORT);
    apiServer = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url || "/", "http://127.0.0.1");
        if (req.method === "GET" && url.pathname === "/state") return sendJson(res, 200, stateView());
        if (req.method !== "POST" || url.pathname !== "/action") return sendJson(res, 404, { error: "not found" });
        const body = await readJson(req);
        const action = body.action;

        if (action === "check") {
          if (job && job.running) return sendJson(res, 200, { job: { running: true, total: job.total, done: job.done } });
          runSweep(Array.isArray(body.ids) ? body.ids : null).catch((e) => pushEvent("err", "sweep: " + e.message));
          return sendJson(res, 200, { started: true });
        }
        if (action === "test-one") {
          const p = getPool(body.id);
          if (!p) return sendJson(res, 404, { error: "pool not found" });
          if ((p.data || {}).ocManaged) return sendJson(res, 400, { error: "managed pool (mux) cannot be tested" });
          if (job && job.running) return sendJson(res, 409, { error: "sweep running" });
          const r = await probePool(p);
          const updated = applyProbeResult(p.id, r);
          pushEvent(r.ok ? "ok" : r.limited ? "warn" : "err", "test-one " + p.id + " -> " + (r.ok ? "200" : r.status || r.error));
          currentPool();
          return sendJson(res, 200, { result: r, pool: updated ? { id: updated.id, testStatus: updated.testStatus, isActive: updated.isActive } : null });
        }
        if (action === "auto") {
          const s = state();
          if (typeof body.enabled === "boolean") s.auto.enabled = body.enabled;
          if (body.intervalMin) s.auto.intervalMin = Math.max(1, Math.min(1440, Number(body.intervalMin) || 30));
          applyState(s);
          return sendJson(res, 200, { auto: s.auto });
        }
        if (action === "elim") {
          const s = await setElim(!!body.enabled);
          if (s.elim.enabled) currentPool();
          return sendJson(res, 200, { elim: s.elim });
        }
        if (action === "candidate") {
          const p = getPool(body.id);
          if (!p) return sendJson(res, 404, { error: "pool not found" });
          updatePool(p.id, () => ({ data: { ocExclude: !!body.ocExclude } }));
          currentPool();
          return sendJson(res, 200, { ok: true });
        }
        if (action === "note429") {
          return sendJson(res, 200, note429(body));
        }
        if (action === "rotate") {
          const to = rotateCurrent("manual");
          return sendJson(res, 200, { current: to });
        }
        if (action === "settings") {
          const s = state();
          s.settings = clampSettings(s.settings, body.settings || body);
          saveState(s);
          pushEvent("info", "settings updated");
          return sendJson(res, 200, { settings: s.settings });
        }
        if (action === "cooldown-clear") {
          const s = state();
          if (body.id) {
            const cd = { ...(s.cooldown || {}) };
            delete cd[String(body.id)];
            s.cooldown = cd;
          } else {
            s.cooldown = {};
          }
          saveState(s);
          return sendJson(res, 200, { cooldown: s.cooldown });
        }
        return sendJson(res, 400, { error: "unknown action" });
      } catch (e) {
        sendJson(res, 500, { error: e.message });
      }
    });
    apiServer.on("error", (e) => {
      pushEvent("err", "api listen error: " + e.message);
      console.error("[oc-rotation] api error:", e.message);
    });
    apiServer.listen(port, "127.0.0.1", () => pushEvent("info", "api listening on 127.0.0.1:" + port));
  }

  let started = false;
  function start() {
    if (started) return;
    started = true;
    try { ensureMuxPool(); } catch (e) { console.error("[oc-rotation] ensure pool:", e.message); }
    try { seedExcludes(); } catch (e) { console.error("[oc-rotation] seed:", e.message); }
    startMux();
    startApi();
    scheduleAuto();
    if (state().auto.enabled) setTimeout(() => { if (!(job && job.running)) runSweep().catch(() => {}); }, 5000);
    pushEvent("info", "oc-rotation started");
    logLine("engine started");
  }

  function maskUrl(u) {
    try { return String(u).replace(/\/\/([^/@]+)@/, "//***@"); } catch { return String(u); }
  }
  function poolsView() {
    const s = state();
    const cooldown = pruneCooldown(s.cooldown, Date.now());
    return listPools().map((p) => ({
      id: p.id,
      name: (p.data && p.data.name) || p.id,
      type: (p.data && p.data.type) || "http",
      proxyUrl: maskUrl((p.data && (p.data.realProxyUrl || p.data.proxyUrl)) || ""),
      isActive: p.isActive,
      testStatus: p.testStatus,
      ocFailStreak: (p.data && p.data.ocFailStreak) || 0,
      ocLastStatus: (p.data && p.data.ocLastStatus) || null,
      ocLastError: (p.data && p.data.ocLastError) || null,
      ocLastCheckAt: (p.data && p.data.ocLastCheckAt) || null,
      ocExclude: !!(p.data && p.data.ocExclude),
      ocManaged: !!(p.data && p.data.ocManaged),
      cooldownUntil: cooldown[p.id] || 0,
    }));
  }
  function stateView() {
    const s = state();
    const now = Date.now();
    const cooldown = pruneCooldown(s.cooldown, now);
    return {
      now,
      auto: s.auto,
      elim: s.elim,
      port: s.port,
      muxPoolId: s.muxPoolId,
      muxListening: !!(muxServer && muxServer.listening),
      apiListening: !!(apiServer && apiServer.listening),
      current: (s.current && s.current.poolId) || null,
      currentSince: (s.current && s.current.since) || null,
      cooldown,
      settings: s.settings,
      rotations: (s.rotations || []).slice(-20),
      effective: {
        muxPort: s.port || DEFAULT_PORT,
        apiPort: Number(process.env.OC_ROTATION_API_PORT || DEFAULT_API_PORT),
        muxPoolId: s.muxPoolId,
        eventLimit: EVENT_LIMIT,
        usageLimit: USAGE_LIMIT,
        rotationLimit: ROTATION_LIMIT,
        failStreakLimit: FAIL_STREAK_LIMIT,
        defaultProbeTimeoutMs: PROBE_TIMEOUT,
        defaultTunnelTimeoutMs: TUNNEL_TIMEOUT,
        defaultSweepConcurrency: DEFAULT_SWEEP_CONCURRENCY,
        probeRoute: "direct-tls through pool",
        strictProxy: true,
        bind: "127.0.0.1",
        cooldownMin: s.settings.cooldownMin,
        cascade: s.settings.cascade,
        probeModel: s.settings.probeModel,
        probeTimeoutMs: s.settings.probeTimeoutMs,
        probeMode: s.settings.probeMode,
        probeHost: PROBE_HOST,
        probeModelsPath: PROBE_MODELS_PATH,
        probeChatPath: PROBE_CHAT_PATH,
        sweepConcurrency: s.settings.sweepConcurrency,
        tunnelTimeoutMs: s.settings.tunnelTimeoutMs,
        candidates: muxCandidates().length,
        tunnelsOpen: tunnels.filter((t) => t.closedAt === null).length,
      },
      lastSweepAt: s.lastSweepAt,
      lastSweepSummary: s.lastSweepSummary,
      elimPausedUntil: s.elimPausedUntil,
      eliminations: (s.eliminations || []).slice(-20),
      job: job ? { id: job.id, running: job.running, total: job.total, done: job.done, current: job.current, active: job.active || [], global429: job.global429, startedAt: job.startedAt, finishedAt: job.finishedAt } : null,
      usage: usage.slice(-120),
      events: events.slice(-80),
      pools: poolsView(),
      candidates: muxCandidates().map((p) => p.id),
    };
  }

  function applyState(next) {
    saveState(next);
    scheduleAuto();
    return next;
  }

  return {
    start, state, stateView, poolsView, runSweep, setElim, scheduleAuto, applyState, saveState,
    probePool, applyProbeResult, getPool, updatePool, noteRequest, note429, currentPool, rotateCurrent,
    pushEvent, job: () => job,
  };
}

function get() {
  if (!globalThis.__ocRotation) globalThis.__ocRotation = createEngine();
  return globalThis.__ocRotation;
}

module.exports = {
  start: () => get().start(),
  stateView: () => get().stateView(),
  poolsView: () => get().poolsView(),
  runSweep: (ids) => get().runSweep(ids),
  setElim: (enabled) => get().setElim(enabled),
  scheduleAuto: () => get().scheduleAuto(),
  applyState: (s) => get().applyState(s),
  saveState: (s) => get().saveState(s),
  pushEvent: (level, msg) => get().pushEvent(level, msg),
  probePool: (pool) => get().probePool(pool),
  applyProbeResult: (id, r, opts) => get().applyProbeResult(id, r, opts),
  getPool: (id) => get().getPool(id),
  updatePool: (id, fn) => get().updatePool(id, fn),
  noteRequest: (req) => get().noteRequest(req),
  note429: (payload) => get().note429(payload),
  currentPool: () => get().currentPool(),
  rotateCurrent: (reason) => get().rotateCurrent(reason),
  job: () => get().job(),
};
