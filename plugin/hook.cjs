"use strict";

// Runtime half of the plugin. One line in custom-server.js requires this file;
// everything else (mux, probe, rotation, 429 attribution) lives in engine.cjs.
// It adds two routes and observes responses — it never rewrites a response.

const fs = require("fs");
const path = require("path");
const http = require("http");

const DIR = __dirname;
const CONFIG = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, "config.json"), "utf8")); } catch { return {}; }
})();
const API_PORT = Number(process.env.OC_ROTATION_API_PORT) || Number(CONFIG.apiPort) || 20130;
const UI_PATH = path.join(DIR, "ui.html");
const LOG_DIR = path.join(DIR, "logs");
const LOG_PATH = path.join(LOG_DIR, "hook.log");
const PAGE_PATHS = new Set(["/dashboard/oc-rotation", "/dashboard/oc-rotation/"]);
const API_PATHS = new Set(["/api/op-rotation", "/api/op-rotation/"]);
// The free tier's own error markers. Only a 429 whose body carries one of these
// is attributed to the rotation lane; other providers' 429s are left alone.
const FREE_LIMIT_RE = /FreeUsageLimitError|Free usage limit|FreeTierError|free tier limit/i;

let engine = null;
let installed = false;

function log(msg) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    try {
      if (fs.statSync(LOG_PATH).size > 512 * 1024) fs.renameSync(LOG_PATH, LOG_PATH + ".1");
    } catch {}
    fs.appendFileSync(LOG_PATH, new Date().toISOString() + " " + msg + "\n");
  } catch {}
}

function getEngine() {
  if (engine) return engine;
  try {
    engine = require("./engine.cjs");
  } catch (e) {
    log("engine require failed: " + (e && e.message ? e.message : e));
    engine = false;
  }
  return engine;
}

function serveUi(res) {
  fs.readFile(UI_PATH, (err, buf) => {
    if (err) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("oc-rotation ui missing: " + err.message);
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": buf.length,
      "cache-control": "no-store",
    });
    res.end(buf);
  });
}

function proxyEngine(req, res) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("error", () => {});
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const isGet = req.method === "GET";
    const upstream = http.request({
      host: "127.0.0.1",
      port: API_PORT,
      path: isGet ? "/state" : "/action",
      method: isGet ? "GET" : "POST",
      headers: isGet
        ? {}
        : { "content-type": "application/json", "content-length": body.length },
      timeout: 120000,
    }, (up) => {
      const out = [];
      up.on("data", (c) => out.push(c));
      up.on("end", () => {
        const payload = Buffer.concat(out);
        res.writeHead(up.statusCode || 502, {
          "content-type": "application/json",
          "content-length": payload.length,
          "cache-control": "no-store",
        });
        res.end(payload);
      });
      up.on("error", () => fail());
    });
    const fail = () => {
      if (res.headersSent) return;
      const msg = JSON.stringify({ error: "oc-rotation engine unavailable on " + API_PORT });
      res.writeHead(503, { "content-type": "application/json", "content-length": Buffer.byteLength(msg) });
      res.end(msg);
    };
    upstream.on("error", fail);
    upstream.on("timeout", () => { upstream.destroy(); fail(); });
    if (!isGet && body.length) upstream.write(body);
    upstream.end();
  });
}

// Response sniffer for 429 attribution. Buffers at most 8 KB of the body, and
// only for /v1 traffic, so normal streaming responses are untouched apart from
// the extra write() wrapper.
function watch429(req, res) {
  const t0 = Date.now();
  const originalWrite = res.write;
  const originalEnd = res.end;
  let head = "";
  let reported = false;

  const capture = (chunk, encoding) => {
    if (reported || head.length >= 8192 || chunk === undefined || chunk === null) return;
    try {
      head += Buffer.isBuffer(chunk) ? chunk.toString("utf8", 0, Math.min(chunk.length, 8192)) : String(chunk);
    } catch {
      /* ignore */
    }
  };

  const maybeReport = () => {
    if (reported) return;
    reported = true;
    if (res.statusCode !== 429) return;
    const claimAll = CONFIG.claimAll429 === true;
    if (!claimAll && !FREE_LIMIT_RE.test(head)) return;
    const oc = getEngine();
    if (!oc) return;
    try {
      const r = oc.note429({ t0, status: 429, source: "v1" });
      log("note429 t0=" + t0 + " -> " + JSON.stringify(r));
    } catch (e) {
      log("note429 failed: " + (e && e.message ? e.message : e));
    }
  };

  res.write = function (chunk, encoding, cb) {
    capture(chunk, encoding);
    return originalWrite.call(this, chunk, encoding, cb);
  };
  res.end = function (chunk, encoding, cb) {
    capture(chunk, encoding);
    maybeReport();
    return originalEnd.call(this, chunk, encoding, cb);
  };
  res.on("close", maybeReport);
  res.on("finish", maybeReport);
}

function dispatch(req, res, next) {
  const pathname = String(req.url || "/").split("?")[0];
  if (PAGE_PATHS.has(pathname) && (req.method === "GET" || req.method === "HEAD")) {
    return serveUi(res);
  }
  if (API_PATHS.has(pathname)) {
    return proxyEngine(req, res);
  }
  if (pathname.startsWith("/v1/")) watch429(req, res);
  return next(req, res);
}

// Wrap http.createServer. custom-server.js patches the same function; whichever
// order they run in, both layers stay in the chain and the original handler is
// still the innermost call.
function install(httpModule) {
  if (installed) return;
  installed = true;
  const mod = httpModule || http;
  const original = mod.createServer.bind(mod);
  mod.createServer = (...args) => {
    const handler = args.find((a) => typeof a === "function");
    const rest = args.filter((a) => typeof a !== "function");
    if (!handler) return original(...args);
    const wrapped = (req, res) => dispatch(req, res, handler);
    const server = original(...rest, wrapped);
    server.once("listening", () => {
      const oc = getEngine();
      if (!oc) return;
      try {
        oc.start();
        log("engine started (pid " + process.pid + ")");
      } catch (e) {
        log("engine start failed: " + (e && e.message ? e.message : e));
      }
    });
    return server;
  };
}

module.exports = { install };
