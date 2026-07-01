"use strict";
/* ============================================================================
 * server.js — tiny zero-dependency backend (Node 18+ for global fetch).
 *
 * ROUTES:
 *   GET  /predictions.json → serves the CACHED daily predictions (public, read-only).
 *                            This is what the browser reads. NO Groq call, NO key,
 *                            NO user input accepted — every user gets the same cache.
 *   POST /api/refresh      → admin/scheduled trigger for the batched Groq run.
 *                            Requires the x-admin-token header. Rate-limited.
 *   GET  /*                → serves the static front-end from ../ (the HTML app).
 *
 * NOTE: for a pure GitHub Pages + scheduled-job deploy you don't need this server
 * at all — a cron (see .github/workflows/refresh.yml) writes predictions.json and
 * GH Pages serves it statically. This server is for local dev / a single-host deploy.
 *
 * SECURITY:
 *   • The Groq key never appears here or in any response — it lives only in
 *     groq.js via process.env and is used server-side.
 *   • /api/refresh is gated by a secret admin token compared in constant time.
 *     (For the most locked-down setup, skip HTTP entirely and run
 *      `node scripts/refresh-cli.js` from cron — see that file.)
 *   • Static serving is path-traversal-safe and sends hardening headers.
 *   • Deploy behind HTTPS (a host/proxy that terminates TLS).
 * ========================================================================== */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { runRefresh, loadCache, publicView } = require("./lib/refresh");

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, "..");           // serves index.html etc.
// Strict CORS: only the origin you configure may read cross-origin. Empty = no
// cross-origin allowed (same-origin fetches, e.g. GitHub Pages serving the file, still work).
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";
const ADMIN_TOKEN = process.env.ADMIN_REFRESH_TOKEN || ""; // required to refresh

// --- tiny in-memory per-IP rate limiter (fixed window) so nobody can spam the
//     endpoints. Quota-burning is already impossible (refresh is token-gated +
//     locked to ~1/day), but this adds DoS hygiene. On real serverless, also use
//     the platform's built-in rate limiting. ---
const RL_WINDOW_MS = 60000, RL_MAX = 120;
const rlHits = new Map();
function rateLimited(req) {
  if (rlHits.size > 5000) rlHits.clear();                // cheap memory guard
  const ip = (req.socket && req.socket.remoteAddress) || "unknown";
  const now = Date.now();
  let e = rlHits.get(ip);
  if (!e || now > e.reset) { e = { count: 0, reset: now + RL_WINDOW_MS }; rlHits.set(ip, e); }
  e.count++;
  return e.count > RL_MAX;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".webmanifest": "application/manifest+json",
};

function securityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  // The app is a single inline HTML file → inline script/style must be allowed.
  // connect-src 'self' lets it read /api on the same origin and nothing else.
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; " +
    "form-action 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self' 'unsafe-inline'; connect-src 'self'"
  );
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  securityHeaders(res);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (ALLOWED_ORIGIN) res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN); // strict: only if configured
  res.setHeader("Cache-Control", "no-store");
  res.writeHead(status);
  res.end(body);
}

/* Constant-time token check (avoids timing leaks); fails closed if unset. */
function adminAuthorized(req) {
  if (!ADMIN_TOKEN) return false;
  const got = req.headers["x-admin-token"];
  if (typeof got !== "string" || got.length === 0) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(ADMIN_TOKEN);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function serveStatic(req, res, urlPath) {
  // Map "/" → the app file; prevent path traversal.
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/" || rel === "") rel = "/index.html";
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR + path.sep) && full !== path.join(PUBLIC_DIR, "index.html")) {
    res.writeHead(403); res.end("Forbidden"); return;
  }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    securityHeaders(res);
    res.setHeader("Content-Type", MIME[path.extname(full).toLowerCase()] || "application/octet-stream");
    res.writeHead(200);
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url || "/";

  // per-IP rate limit (DoS hygiene)
  if (rateLimited(req)) { securityHeaders(res); res.writeHead(429); res.end("Too Many Requests"); return; }

  // CORS preflight for the read-only API (only if a front-end origin is configured).
  if (req.method === "OPTIONS" && url.startsWith("/api/")) {
    securityHeaders(res);
    if (ALLOWED_ORIGIN) res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type, x-admin-token");
    res.writeHead(204); res.end(); return;
  }

  // PUBLIC read endpoints — just serve the cached predictions. No model call, no
  // key, no user input accepted. `predictions.json` is the same path the static
  // GitHub Pages build exposes, so the front-end fetch works in both setups.
  if (req.method === "GET" && (url.startsWith("/predictions.json") || url.startsWith("/api/predictions"))) {
    try { return sendJSON(res, 200, publicView(loadCache())); }
    catch (e) { return sendJSON(res, 200, { lastRun: 0, predictions: [], resolutions: [] }); }
  }

  // ADMIN/SCHEDULED refresh — the ONLY route that can trigger Groq.
  if (req.method === "POST" && url.startsWith("/api/refresh")) {
    if (!adminAuthorized(req)) return sendJSON(res, 401, { error: "unauthorized" });
    const force = url.includes("force=1");
    try {
      const summary = await runRefresh({ force });
      return sendJSON(res, 200, summary);              // summary contains no secrets
    } catch (e) {
      // Never leak internals/key; keep last good cache.
      return sendJSON(res, 502, { error: "refresh_failed" });
    }
  }

  if (req.method === "GET") return serveStatic(req, res, url);

  res.writeHead(405); res.end("Method Not Allowed");
});

server.listen(PORT, () => {
  console.log(`Called It backend on http://localhost:${PORT}`);
  console.log(`  GET  /predictions.json  (public, cached)`);
  console.log(`  POST /api/refresh       (needs x-admin-token)${ADMIN_TOKEN ? "" : "  [DISABLED: set ADMIN_REFRESH_TOKEN]"}`);
});
