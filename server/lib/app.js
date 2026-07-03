"use strict";
// the actual request router - shared between local dev (server.js, a plain
// http.createServer) and the Vercel deployment (api/index.js, a serverless
// function). Both just call handleRequest(req, res).

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const log = require("./log");
const db = require("./db");
const auth = require("./auth");
const game = require("./game");
const RL = require("./ratelimit");
const { runRefresh, getPipelineStatus } = require("./refresh");

const PUBLIC_DIR = path.join(__dirname, "..", "..");
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";
const ADMIN_TOKEN = process.env.ADMIN_REFRESH_TOKEN || "";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const SECURE_COOKIES = process.env.COOKIE_SECURE === "1" || process.env.NODE_ENV === "production";
const STARTED_AT = Date.now();

// only these exact files are servable, so .env/db.json/.git never are. On the
// Vercel deploy these are also served natively as static files, so this path
// only really matters for local dev (node server.js).
const STATIC_FILES = {
  "/": "index.html",
  "/index.html": "index.html",
  "/predictions.json": "predictions.json",
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

function securityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (SECURE_COOKIES) res.setHeader("Strict-Transport-Security", "max-age=15552000");
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

// Per-instance in-memory limiter. On Vercel this resets per cold start and
// isn't shared across concurrent instances - a known, acceptable tradeoff for
// an app this size (a distributed limiter would mean a Redis round trip on
// every single request just for this). Login/register have their own
// per-account limits in auth.js on top of this.
const RL_WINDOW_MS = 60000, RL_MAX = 240;
const rlHits = new Map();
function rateLimited(req) {
  if (rlHits.size > 5000) rlHits.clear();
  const ip = clientIp(req);
  const now = Date.now();
  let e = rlHits.get(ip);
  if (!e || now > e.reset) { e = { count: 0, reset: now + RL_WINDOW_MS }; rlHits.set(ip, e); }
  e.count++;
  return e.count > RL_MAX;
}

function adminAuthorized(req) {
  if (!ADMIN_TOKEN) return false;
  const got = req.headers["x-admin-token"];
  if (typeof got !== "string" || got.length === 0) return false;
  const a = Buffer.from(got), b = Buffer.from(ADMIN_TOKEN);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

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

const MAX_BODY_BYTES = 16 * 1024;
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let tooLarge = false;
    req.on("data", (c) => {
      if (tooLarge) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        reject(Object.assign(new Error("payload too large"), { status: 413 }));
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

const routes = [
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
          budget: RL.status("groq"),
        },
        players: Object.keys(db.get().users).length,
      });
    },
  },

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

  {
    method: "POST", path: "/api/refresh", admin: true,
    handler: async (req, res, ctx) => {
      const summary = await runRefresh({ force: ctx.url.includes("force=1") });
      game.invalidateLeaderboard();
      sendJSON(res, 200, summary);
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

async function handleRequest(req, res) {
  const url = req.url || "/";
  const pathOnly = url.split("?")[0];

  if (rateLimited(req)) { securityHeaders(res); res.writeHead(429, { "Retry-After": "60" }); res.end("Too Many Requests"); return; }

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

module.exports = { handleRequest, ADMIN_TOKEN, SECURE_COOKIES };
