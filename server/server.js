"use strict";
/* ============================================================================
 * server.js — zero-dependency backend for Called It (Node 18+, no packages:
 * nothing for `npm audit` to flag, no supply chain to trust).
 *
 * ROUTES
 *   Public reads (always served from cache — NEVER wait on Groq):
 *     GET  /predictions.json | /api/predictions   the feed + real crowd + outcomes
 *     GET  /api/leaderboard                        cached, recomputed on a TTL
 *     GET  /api/health                             pipeline liveness + last-updated
 *   Accounts (opaque session cookie: httpOnly, SameSite=Strict, Secure in prod):
 *     POST /api/auth/register   { username, password }
 *     POST /api/auth/login      { username, password }
 *     POST /api/auth/logout
 *     GET  /api/auth/me
 *   Authenticated game actions (validated server-side, scored server-side):
 *     GET  /api/me/state
 *     POST /api/picks           { id, option, confident }
 *     POST /api/daily/checkin
 *   Admin (x-admin-token, constant-time compare):
 *     POST /api/refresh         run the Groq refresh now (still budget-guarded)
 *     POST /api/admin/resolve   { id, outcome|null }
 *   Static front-end: ALLOWLISTED files only (see STATIC_FILES — this is what
 *   keeps /server/.env, db.json and .git/ unreachable even though they live
 *   under the repo root this server serves from).
 *
 * RELIABILITY
 *   • Every route runs inside one try/catch wrapper → a bad request logs and
 *     returns 500 JSON; it can never take the process down.
 *   • The Groq refresh runs on an in-process schedule (plus optional CI cron),
 *     is triple-guarded (min interval + hard daily cap + provider headers),
 *     retries transient failures with backoff, and on any failure the last
 *     good cache keeps serving. User requests never trigger model calls.
 *   • process-level handlers log unexpected errors and keep serving (state
 *     writes are atomic, so continuing is safe). For production also run under
 *     a supervisor (pm2 / systemd / your host's restarter) as a second net.
 *
 * SECURITY
 *   • Groq key + admin token live only in env; never in responses or logs.
 *   • Passwords: scrypt hashes (see lib/auth.js). Sessions: opaque tokens,
 *     hashed at rest, httpOnly cookies.
 *   • CSRF: SameSite=Strict cookie + Origin / Sec-Fetch-Site checks on every
 *     state-changing request + JSON-only bodies.
 *   • Rate limits: global per-IP on everything, stricter sliding windows on
 *     login/register (per IP AND per account).
 *   • All input validated server-side; client is never trusted.
 * ========================================================================== */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const log = require("./lib/log");
const db = require("./lib/db");
const auth = require("./lib/auth");
const game = require("./lib/game");
const RL = require("./lib/ratelimit");
const { runRefresh, runRefreshSafe, getPipelineStatus } = require("./lib/refresh");

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, "..");
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";      // optional extra front-end origin
const ADMIN_TOKEN = process.env.ADMIN_REFRESH_TOKEN || "";    // required for admin routes
const TRUST_PROXY = process.env.TRUST_PROXY === "1";          // behind a TLS-terminating proxy?
const SECURE_COOKIES = process.env.COOKIE_SECURE === "1" || process.env.NODE_ENV === "production";
const SCHEDULER_ENABLED = process.env.SCHEDULER_ENABLED !== "0";
const STARTED_AT = Date.now();

/* ── static allowlist ─────────────────────────────────────────────────────────
 * The repo root contains things that must NEVER be served (server/.env,
 * server/data/db.json, .git/…), so instead of "serve anything under root
 * except traversal" we serve ONLY these named files. Add new assets here. */
const STATIC_FILES = {
  "/": "index.html",
  "/index.html": "index.html",
  "/predictions.json": "predictions.json",
  // PWA shell
  "/manifest.webmanifest": "manifest.webmanifest",
  "/sw.js": "sw.js",
  "/icons/icon-192.png": "icons/icon-192.png",
  "/icons/icon-512.png": "icons/icon-512.png",
  "/icons/apple-touch-icon.png": "icons/apple-touch-icon.png",
};
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".webmanifest": "application/manifest+json",
};

/* ── tiny helpers ──────────────────────────────────────────────────────────── */
function securityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (SECURE_COOKIES) res.setHeader("Strict-Transport-Security", "max-age=15552000");
  // Single inline-HTML app → inline script/style allowed; everything else locked.
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
  res.setHeader("Cache-Control", "no-store");
  if (ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.setHeader("Vary", "Origin");
  }
  res.writeHead(status);
  res.end(body);
}
const fail = (res, status, msg) => sendJSON(res, status, { error: msg });

function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = req.headers["x-forwarded-for"];
    if (typeof xf === "string" && xf.length) return xf.split(",")[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

/* Global per-IP rate limit (fixed window): DoS hygiene on every route. */
const RL_WINDOW_MS = 60000, RL_MAX = 240;
const rlHits = new Map();
function rateLimited(req) {
  if (rlHits.size > 5000) rlHits.clear();               // cheap memory guard
  const ip = clientIp(req);
  const now = Date.now();
  let e = rlHits.get(ip);
  if (!e || now > e.reset) { e = { count: 0, reset: now + RL_WINDOW_MS }; rlHits.set(ip, e); }
  e.count++;
  return e.count > RL_MAX;
}

/* Constant-time admin token check; fails closed if unset. */
function adminAuthorized(req) {
  if (!ADMIN_TOKEN) return false;
  const got = req.headers["x-admin-token"];
  if (typeof got !== "string" || got.length === 0) return false;
  const a = Buffer.from(got), b = Buffer.from(ADMIN_TOKEN);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* Cookie parsing + session cookie helpers. */
const COOKIE = "ci_session";
function cookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (typeof raw !== "string") return out;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function setSessionCookie(res, token) {
  res.setHeader("Set-Cookie",
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${30 * 24 * 3600}${SECURE_COOKIES ? "; Secure" : ""}`);
}
function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${SECURE_COOKIES ? "; Secure" : ""}`);
}
function sessionUser(req) { return auth.getSessionUser(cookies(req)[COOKIE]); }

/* CSRF guard for state-changing requests (on top of SameSite=Strict):
 * a browser cross-site request always carries Origin and/or Sec-Fetch-Site —
 * if either says "not us", reject. Non-browser clients (curl, CI) send
 * neither, which is fine: they carry no ambient cookies to ride on. */
function crossSiteBlocked(req) {
  const sfs = req.headers["sec-fetch-site"];
  if (typeof sfs === "string" && !["same-origin", "same-site", "none"].includes(sfs)) return true;
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin !== "null") {
    if (ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN) return false;
    try {
      if (new URL(origin).host !== req.headers.host) return true;
    } catch (e) { return true; }
  }
  return false;
}

/* Read + parse a small JSON body. Rejects oversized/invalid payloads. */
const MAX_BODY_BYTES = 16 * 1024;
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let tooLarge = false;
    req.on("data", (c) => {
      if (tooLarge) return;                             // stop buffering, keep draining
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        reject(Object.assign(new Error("payload too large"), { status: 413 }));
        // let the 413 response (written in the rejection microtask) go out
        // before the socket is torn down
        setImmediate(() => req.destroy());
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (e) { reject(Object.assign(new Error("invalid JSON"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

/* The per-user state payload the client mirrors (no secrets, no other users). */
function meState(user) {
  const picks = db.get().picks[user.id] || {};
  const resolutions = game.resolutionsMap();
  const derived = game.computeDerived(user);
  const today = new Date().toISOString().slice(0, 10);
  return {
    user: auth.publicUser(user),
    picks,
    resolutions,
    derived,
    daily: Object.assign({}, user.daily, { checkedInToday: (user.daily && user.daily.lastDay) === today }),
    bonusPoints: user.bonusPoints || 0,
    confidencePerWeek: game.CONFIDENCE_PER_WEEK,
  };
}

/* ── routes ──────────────────────────────────────────────────────────────────
 * handler(req, res, { body, user, ip }) — `user` present when auth:true.     */
const routes = [
  // ---- public reads (cache only; never call Groq) ----
  { method: "GET", path: "/api/predictions", handler: (req, res) => sendJSON(res, 200, game.publicFeed()) },
  { method: "GET", path: "/predictions.json", handler: (req, res) => sendJSON(res, 200, game.publicFeed()) },
  {
    method: "GET", path: "/api/leaderboard",
    handler: (req, res) => {
      const user = sessionUser(req);
      sendJSON(res, 200, game.leaderboardView(user ? user.username : null));
    },
  },
  {
    method: "GET", path: "/api/health",
    handler: (req, res) => {
      const p = getPipelineStatus();
      sendJSON(res, 200, {
        ok: true,
        now: Date.now(),
        uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
        pipeline: {
          lastRun: p.lastRun, lastRunAgeMin: p.lastRun ? Math.round((Date.now() - p.lastRun) / 60000) : null,
          lastAttemptAt: p.lastAttemptAt || null,
          lastError: p.lastError,
          cachedPredictions: p.cachedPredictions,
          cachedResolutions: p.cachedResolutions,
          reviewQueue: p.reviewQueue,
          scheduler: SCHEDULER_ENABLED,
          budget: RL.status("groq"),          // callsToday / dailyCap / backoff — no secrets
        },
        players: Object.keys(db.get().users).length,
      });
    },
  },

  // ---- auth ----
  {
    method: "POST", path: "/api/auth/register",
    handler: async (req, res, ctx) => {
      const r = auth.register(ctx.body.username, ctx.body.password, ctx.ip);
      if (r.error) return fail(res, r.status, r.error);
      setSessionCookie(res, auth.createSession(r.user.id));
      log.info("auth: new account", { username: r.user.username });
      sendJSON(res, 201, meState(r.user));
    },
  },
  {
    method: "POST", path: "/api/auth/login",
    handler: async (req, res, ctx) => {
      const r = auth.login(ctx.body.username, ctx.body.password, ctx.ip);
      if (r.error) return fail(res, r.status, r.error);
      setSessionCookie(res, auth.createSession(r.user.id));
      sendJSON(res, 200, meState(r.user));
    },
  },
  {
    method: "POST", path: "/api/auth/logout",
    handler: (req, res) => {
      auth.destroySession(cookies(req)[COOKIE]);
      clearSessionCookie(res);
      sendJSON(res, 200, { ok: true });
    },
  },
  {
    method: "GET", path: "/api/auth/me",
    handler: (req, res) => {
      const user = sessionUser(req);
      sendJSON(res, 200, user ? meState(user) : { user: null });
    },
  },

  // ---- authenticated game actions ----
  { method: "GET", path: "/api/me/state", auth: true, handler: (req, res, ctx) => sendJSON(res, 200, meState(ctx.user)) },
  {
    method: "POST", path: "/api/picks", auth: true,
    handler: (req, res, ctx) => {
      const r = game.submitPick(ctx.user, ctx.body);
      if (r.error) return fail(res, r.status, r.error);
      sendJSON(res, 200, { ok: true, pick: r.pick, derived: game.computeDerived(ctx.user) });
    },
  },
  {
    method: "POST", path: "/api/daily/checkin", auth: true,
    handler: (req, res, ctx) => {
      const r = game.dailyCheckin(ctx.user);
      sendJSON(res, 200, Object.assign(r, { totalBonus: ctx.user.bonusPoints || 0 }));
    },
  },

  // ---- admin ----
  {
    method: "POST", path: "/api/refresh", admin: true,
    handler: async (req, res, ctx) => {
      const summary = await runRefresh({ force: ctx.url.includes("force=1") });
      game.invalidateLeaderboard();
      sendJSON(res, 200, summary);                     // summary contains no secrets
    },
  },
  {
    method: "POST", path: "/api/admin/resolve", admin: true,
    handler: (req, res, ctx) => {
      const outcome = ctx.body.outcome === null ? null : String(ctx.body.outcome || "");
      const r = game.adminResolve(ctx.body.id, outcome);
      if (r.error) return fail(res, r.status, r.error);
      sendJSON(res, 200, { ok: true });
    },
  },
];

/* ── static serving: allowlist only ─────────────────────────────────────────── */
function serveStatic(req, res, urlPath) {
  const clean = decodeURIComponent(urlPath.split("?")[0]);
  const rel = STATIC_FILES[clean];
  if (!rel) { securityHeaders(res); res.writeHead(404); res.end("Not found"); return; }
  const full = path.join(PUBLIC_DIR, rel);
  fs.readFile(full, (err, buf) => {
    if (err) { securityHeaders(res); res.writeHead(404); res.end("Not found"); return; }
    securityHeaders(res);
    res.setHeader("Content-Type", MIME[path.extname(full).toLowerCase()] || "application/octet-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.writeHead(200);
    res.end(buf);
  });
}

/* ── the one request handler: everything runs inside this try/catch ─────────── */
async function handle(req, res) {
  const url = req.url || "/";
  const pathOnly = url.split("?")[0];

  if (rateLimited(req)) { securityHeaders(res); res.writeHead(429, { "Retry-After": "60" }); res.end("Too Many Requests"); return; }

  // CORS preflight (only matters when a separate front-end origin is configured)
  if (req.method === "OPTIONS" && pathOnly.startsWith("/api/")) {
    securityHeaders(res);
    if (ALLOWED_ORIGIN) {
      res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type, x-admin-token");
    res.writeHead(204); res.end(); return;
  }

  const route = routes.find((r) => r.method === req.method && r.path === pathOnly);
  if (route) {
    // CSRF gate on every state-changing request
    if (req.method !== "GET" && crossSiteBlocked(req)) return fail(res, 403, "cross-site request blocked");
    if (route.admin && !adminAuthorized(req)) return fail(res, 401, "unauthorized");

    const ctx = { url, ip: clientIp(req), body: {}, user: null };
    if (route.auth) {
      ctx.user = sessionUser(req);
      if (!ctx.user) return fail(res, 401, "sign in first");
    }
    if (req.method === "POST") {
      try { ctx.body = await readJsonBody(req); }
      catch (e) { return fail(res, e.status || 400, e.message); }
      if (ctx.body === null || typeof ctx.body !== "object" || Array.isArray(ctx.body)) {
        return fail(res, 400, "expected a JSON object body");
      }
    }
    await route.handler(req, res, ctx);
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res, url);
  securityHeaders(res);
  res.writeHead(405, { Allow: "GET, POST, OPTIONS" });
  res.end("Method Not Allowed");
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    // The error wall: one bad request logs + 500s; the process keeps serving.
    log.error("request failed", e, { method: req.method, path: (req.url || "").split("?")[0] });
    if (!res.headersSent) fail(res, 500, "internal error");
    else try { res.end(); } catch (e2) {}
  });
});

/* ── scheduled Groq refresh (in-process; user requests can never trigger it) ──
 * Ticks every 30 min; runRefresh itself decides if it's actually time
 * (min interval), and the budget guards decide if it's safe. Failures are
 * swallowed into the health status — the cache keeps serving regardless. */
if (SCHEDULER_ENABLED) {
  const tick = async () => {
    const s = await runRefreshSafe({});
    if (!(s.skipped && s.reason === "rate-limited")) log.info("refresh tick", s);
    if (s && s.skipped === false) game.invalidateLeaderboard();
  };
  setTimeout(tick, 30 * 1000);                        // first check shortly after boot
  setInterval(tick, 30 * 60 * 1000).unref();
  setInterval(() => auth.pruneSessions(), 6 * 3600 * 1000).unref();
}

/* ── never-go-down process guards ─────────────────────────────────────────────
 * All persistent writes are atomic (tmp+rename) and every route is wrapped, so
 * an unexpected error here means a bug outside a request path; we log it and
 * keep serving rather than dropping the site. In production ALSO run under a
 * supervisor (pm2/systemd) so even a hard crash (OOM, kill) self-heals. */
process.on("unhandledRejection", (e) => log.error("unhandledRejection", e));
process.on("uncaughtException", (e) => { log.error("uncaughtException", e); db.flushSync(); });
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log.info("shutdown", { signal: sig });
    db.flushSync();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();  // don't hang on open sockets
  });
}

server.listen(PORT, () => {
  log.info(`Called It backend on http://localhost:${PORT}`);
  log.info(`  GET  /predictions.json /api/predictions /api/leaderboard /api/health  (public, cached)`);
  log.info(`  POST /api/auth/register|login|logout · /api/picks · /api/daily/checkin (accounts)`);
  log.info(`  POST /api/refresh /api/admin/resolve  (x-admin-token)${ADMIN_TOKEN ? "" : "  [DISABLED: set ADMIN_REFRESH_TOKEN]"}`);
  log.info(`  scheduler=${SCHEDULER_ENABLED ? "on" : "off"} secureCookies=${SECURE_COOKIES}`);
});
